#!/usr/bin/env node
/**
 * 界面验证（CDP 驱动系统 Edge，可选依赖，不影响交付物）
 * ------------------------------------------------------------------
 * 用法：
 *   node test/qa-shot.js                    跑全部步骤，截图到临时目录
 *   node test/qa-shot.js --out <目录>        指定截图输出目录
 *   node test/qa-shot.js --keep             保留截图（默认跑完删掉）
 *   node test/qa-shot.js --port 3000        被测服务端口
 *
 * 为什么不用 puppeteer：这个项目刻意保持"零额外依赖"，而
 * test/run.js 和 test/e2e.js 都不需要装东西就能跑。界面验证也一样，
 * 直接用系统自带的 Edge + DevTools 协议就够了。
 *
 * 它做的是"真的把浏览器跑起来"这件事：
 *   · 输入密码 → 输入动态码（自己按 TOTP 算，不依赖手机）
 *   · 点进目录、切网格、搜索、开分享弹窗、生成分享
 *   · 拿生成的链接和密码，在真实分享页上再走一遍
 * 每一步都断言 DOM 状态，并打印量到的数字，而不是截个图说"看着没问题"。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const totp = require(path.join(ROOT, 'lib/totp'));

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const argVal = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = parseInt(argVal('--port', '3000'), 10);
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP = argv.includes('--keep');
const OUT = argVal('--out', path.join(os.tmpdir(), 'sunlight-qa-' + Date.now()));
const CDP_PORT = parseInt(argVal('--cdp-port', '9333'), 10);

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].find(p => fs.existsSync(p));
if (!EDGE) { console.error('找不到 Edge，无法做界面验证。'); process.exit(2); }

/* ---------------- 读 .env（密码和 2FA 密钥） ---------------- */
function readEnv() {
  const f = path.join(ROOT, '.env');
  const out = {};
  if (!fs.existsSync(f)) return out;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}
const ENV = readEnv();
if (!ENV.SITE_PASSWORD) { console.error('.env 里没有 SITE_PASSWORD，先跑 node dev.js。'); process.exit(2); }

/* ---------------- 小工具 ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const failures = [];
function ck(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, failures.push(label));
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `\n         got  = ${JSON.stringify(got)}\n         want = ${JSON.stringify(want)}`}`);
}
function ckTrue(label, cond, extra) {
  ck(label, !!cond, true);
  if (!cond) console.log('         ' + JSON.stringify(extra));
}
function section(t) { console.log(`\n\x1b[1m== ${t} ==\x1b[0m`); }

/* ---------------- CDP 客户端 ---------------- */
function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const waiters = [];

    ws.addEventListener('error', e => reject(new Error('WebSocket 出错：' + (e.message || ''))));
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const i = ++id;
          pending.set(i, { res, rej });
          ws.send(JSON.stringify({ id: i, method, params: params || {} }));
        });
      },
      waitEvent(method, timeout = 15000) {
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('等 ' + method + ' 超时')), timeout);
          waiters.push({ method, res: (m) => { clearTimeout(t); res(m); } });
        });
      },
      close() { try { ws.close(); } catch (_) {} }
    }));

    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(m.method + ': ' + m.error.message)) : res(m.result);
      } else if (m.method) {
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].method === m.method) { const w = waiters.splice(i, 1)[0]; w.res(m.params); }
        }
      }
    });
  });
}

/* ---------------- 主流程 ---------------- */
(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let shotNo = 0;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-qa-profile-'));
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--hide-scrollbars',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    'about:blank'
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { edge.kill(); } catch (_) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  };
  process.on('exit', cleanup);

  /* 等 CDP 起来 */
  let target = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await getJson('/json/list');
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch (_) {}
    await sleep(250);
  }
  if (!target) throw new Error('连不上 Edge 的调试端口，界面验证跑不了。');

  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  /* 先把页面开起来，后面所有导航都走 evaluate 里的 location.href，
     这样不用反复等 load 事件，也能保留同一个执行上下文。 */
  async function goto(url) {
    const loaded = cdp.waitEvent('Page.loadEventFired', 20000);
    await cdp.send('Page.navigate', { url });
    await loaded;
    await sleep(280);
  }
  async function ev(expression, awaitPromise = true) {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('页面里报错：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  async function waitFor(expr, label, timeout = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      let v = null;
      try { v = await ev(expr); } catch (_) {}
      if (v) return v;
      await sleep(120);
    }
    throw new Error('等「' + label + '」超时');
  }
  async function shot(name, note) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, `${String(++shotNo).padStart(2, '0')}-${name}.png`);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    const size = fs.statSync(f).size;
    console.log(`  shot  ${path.basename(f)}${note ? '   ' + note : ''}`);
    return f;
  }
  /* 截图前把入场动画和过渡关掉，免得拍到"动画中间那一帧" */
  const freezeAnim = `(() => {
    const s = document.createElement('style');
    s.textContent = '*{transition:none !important;animation:none !important}';
    document.head.appendChild(s);
    return true;
  })()`;

  /* ================================================================
     1. 登录第一步
     ================================================================ */
  section('登录：密码这一步');
  await goto(BASE + '/');
  await waitFor(`document.getElementById('step1').style.display !== 'none'`, '登录框');

  const site = await ev(`fetch('/api/site').then(r=>r.json())`);
  ck('/api/site 说已开 2FA', site.totpEnabled, true);

  const brand = await ev(`document.getElementById('brandName').textContent`);
  // 跟服务端下发的品牌比对，别把名字写死在测试里 —— 改名不该弄红一条测试
  ck('页面上显示的品牌名', brand, site.brand);
  // 老板明确要求删掉登录卡底部那句「需密码 + 动态码两步验证」和顶栏的「2FA」小标 ——
  // 都是说明自己怎么实现的，不是给用户的信息。这里钉住它们别再长回来。
  ck('登录卡和顶栏没有多余的自我说明',
    await ev(`!!document.querySelector('.gate-tip') || !!document.querySelector('.brand-sub')`), false);

  const gateBox = await ev(`(() => { const r = document.querySelector('.gate-card').getBoundingClientRect(); return {w:Math.round(r.width),h:Math.round(r.height)}; })()`);
  console.log(`        登录卡尺寸 ${gateBox.w}x${gateBox.h}`);
  await shot('gate-password', '登录第一步');

  /* 先试一次错密码，确认提示是对的 */
  await ev(`document.getElementById('pwd').value='definitely-wrong'; submitPwd()`);
  await waitFor(`document.getElementById('gateErr').classList.contains('on')`, '密码错误提示');
  ck('错密码的提示文案', await ev(`document.getElementById('gateErr').textContent`), '密码不对');
  await shot('gate-wrong-password', '错密码提示');

  /* ================================================================
     2. 登录第二步（动态码）
     ================================================================ */
  section('登录：动态码这一步');
  await ev(`document.getElementById('pwd').value=${JSON.stringify(ENV.SITE_PASSWORD)}; submitPwd()`);
  await waitFor(`document.getElementById('step2').style.display === 'block'`, '动态码输入框');
  ck('密码对了之后停在第二步，没有直接进去', await ev(`document.getElementById('app').classList.contains('on')`), false);
  ck('第二步的输入框位数', await ev(`document.getElementById('code').maxLength`), 6);
  await shot('gate-totp', '登录第二步');

  /* 错码 */
  await ev(`document.getElementById('code').value='000000'; submitCode()`);
  await waitFor(`document.getElementById('gateErr').classList.contains('on')`, '动态码错误提示');
  const wrongCodeMsg = await ev(`document.getElementById('gateErr').textContent`);
  ckTrue('错动态码给的提示是"动态码不对"', /动态码不对/.test(wrongCodeMsg), wrongCodeMsg);

  /* 对码：自己按密钥算，不依赖手机 */
  const secret = ENV.TOTP_SECRET;
  if (!secret) { console.log('  --    .env 里没有 TOTP_SECRET，跳过动态码校验'); }
  else {
    // 剩余时间太短就先等下一片，免得算出来的码在提交时已经过期
    if (totp.secondsLeft() < 4) await sleep(4200);
    const code = totp.code(secret);
    console.log(`        用密钥算出的动态码 ${code}`);
    await ev(`document.getElementById('code').value=${JSON.stringify(code)}; submitCode()`);
    await waitFor(`document.getElementById('app').classList.contains('on')`, '主界面出现');
    ck('两段验证都通过后进入主界面', await ev(`document.getElementById('app').classList.contains('on')`), true);
    ck('登录门已隐藏', await ev(`document.getElementById('gate').classList.contains('off')`), true);
  }

  /* ================================================================
     3. 顶层目录
     ================================================================ */
  section('文件管理器：顶层');
  await waitFor(`document.querySelectorAll('.rows .row').length > 0`, '文件列表');
  await ev(freezeAnim);

  const topNames = await ev(`[...document.querySelectorAll('#crumbs, .rows .row')].length && [...document.querySelectorAll('.rows .row')].map(r=>r.querySelector('.t').textContent)`);
  ck('顶层只有示例目录一个文件夹', topNames, ['示例目录']);

  const crumbs0 = await ev(`document.getElementById('crumbs').textContent.trim()`);
  ckTrue('顶层面包屑显示"全部文件"', crumbs0.startsWith('全部文件'), crumbs0);

  const foot = await ev(`document.getElementById('footNote').textContent`);
  console.log(`        底部统计 ${foot}`);
  ckTrue('底部统计带上了全站文件数', /148 个文件/.test(foot), foot);

  /* 表格布局有没有溢出 */
  const overflow = await ev(`(() => {
    const vw = window.innerWidth;
    const bad = [];
    document.querySelectorAll('.app *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > vw + 1) bad.push(el.className || el.tagName);
    });
    return { vw, count: bad.length, sample: bad.slice(0,5) };
  })()`);
  console.log(`        视口宽 ${overflow.vw}，横向溢出元素 ${overflow.count} 个`);
  ck('顶层没有元素超出视口', overflow.count, 0);

  await shot('drive-root', '顶层（示例目录）');

  /* ================================================================
     4. 进目录：面包屑层级
     ================================================================ */
  section('文件管理器：进目录与面包屑');
  const enterByName = (name) => ev(`(() => {
    const row = [...document.querySelectorAll('.row.dir')].find(r => r.querySelector('.t').textContent === ${JSON.stringify(name)});
    if (!row) return 'NOT_FOUND';
    gotoDir(row.dataset.id);
    return row.dataset.id;
  })()`);

  ck('能找到"示例目录"', await enterByName('示例目录') !== 'NOT_FOUND', true);
  await waitFor(`document.getElementById('crumbs').textContent.includes('示例目录')`, '示例目录的面包屑');
  const lvl1 = await ev(`[...document.querySelectorAll('.rows .row')].map(r=>r.querySelector('.t').textContent)`);
  console.log(`        示例目录下： ${lvl1.join(' / ')}`);
  ck('四个分类文件夹', lvl1.sort(), ['主程序', '升级包', '工具软件', '故障处理'].sort());

  /* 面包屑不能把父目录当成"当前" */
  const crumbNow = await ev(`(() => ({
    crumbs: [...document.querySelectorAll('#crumbs > *')].map(e=>e.textContent).join(''),
    cur: document.querySelector('#crumbs .cur') ? document.querySelector('#crumbs .cur').textContent : null
  }))()`);
  ck('当前目录就是"示例目录"（不是父级"全部文件"）', crumbNow.cur, '示例目录');
  ckTrue('面包屑里有全部文件 > 示例目录', /全部文件.*示例目录/.test(crumbNow.crumbs), crumbNow.crumbs);
  await shot('drive-level1', '示例目录内部');

  ck('能找到"升级包"', await enterByName('升级包') !== 'NOT_FOUND', true);
  await waitFor(`document.getElementById('crumbs').textContent.includes('升级包')`, '升级包的面包屑');
  const crumbDeep = await ev(`(() => ({
    parts: [...document.querySelectorAll('#crumbs > *')].map(e=>e.textContent.trim()).filter(t=>t && t!=='/'),
    cur: document.querySelector('#crumbs .cur').textContent
  }))()`);
  console.log(`        面包屑： ${crumbDeep.parts.join(' / ')}`);
  ck('三层时面包屑是 全部文件 / 示例目录 / 升级包', crumbDeep.parts, ['全部文件', '示例目录', '升级包']);
  ck('当前目录是升级包', crumbDeep.cur, '升级包');

  const fileCount = await ev(`document.querySelectorAll('.rows .row').length`);
  console.log(`        升级包里有 ${fileCount} 个文件`);
  ckTrue('升级包里有文件', fileCount > 10, fileCount);

  const rowsOk = await ev(`(() => {
    const r = document.querySelector('.rows .row');
    return { h: Math.round(r.getBoundingClientRect().height), name: r.querySelector('.t').textContent, size: r.querySelector('.fsize').textContent };
  })()`);
  console.log(`        首行： ${rowsOk.name}  ${rowsOk.size}  行高 ${rowsOk.h}px`);
  ckTrue('行高在合理范围', rowsOk.h >= 30 && rowsOk.h <= 80, rowsOk.h);
  await shot('drive-files', `升级包（${fileCount} 个文件）`);

  /* ================================================================
     5. 视图 / 搜索 / 主题
     ================================================================ */
  section('视图切换、搜索、主题');
  await ev(`document.getElementById('btnView').click()`);
  await sleep(200);
  const grid = await ev(`({ cards: document.querySelectorAll('.grid .card-t').length, cls: document.getElementById('btnView').innerHTML.includes('rect') })`);
  ck('网格视图渲染出卡片', grid.cards, fileCount);
  await shot('drive-grid', '网格视图');

  await ev(`document.getElementById('btnView').click()`);   // 切回列表
  await sleep(150);

  await ev(`document.getElementById('q').value='JMPUpdater'; document.getElementById('q').dispatchEvent(new Event('input'))`);
  await waitFor(`document.querySelector('.row .path') !== null`, '搜索结果带路径');
  const hits = await ev(`document.querySelectorAll('.rows .row').length`);
  const firstPath = await ev(`document.querySelector('.row .path').textContent`);
  console.log(`        搜到 ${hits} 项，第一条路径显示为「${firstPath}」`);
  ckTrue('搜索能跨目录命中', hits > 3, hits);
  ckTrue('搜索结果给出了所在路径', /示例目录/.test(firstPath), firstPath);
  await shot('search', `搜索 JMPUpdater（${hits} 项）`);

  await ev(`document.getElementById('q').value=''; document.getElementById('q').dispatchEvent(new Event('input'))`);
  await sleep(200);

  /* 主题 */
  await ev(`document.getElementById('btnTheme').click()`);
  await sleep(200);
  const theme = await ev(`document.documentElement.getAttribute('data-theme')`);
  console.log(`        主题切换后 data-theme=${theme}`);
  const bg = await ev(`getComputedStyle(document.body).backgroundColor`);
  console.log(`        body 背景色 ${bg}`);
  ckTrue('暗色主题下背景是深的', theme === 'light' ? true : /rgb\((?:[0-9]|[1-7][0-9]),/.test(bg), { theme, bg });
  await shot('theme-' + theme, `${theme} 主题`);
  await ev(`document.getElementById('btnTheme').click()`);   // 切回来
  await sleep(150);

  /* ================================================================
     6. 新建文件夹弹窗
     ================================================================ */
  section('新建文件夹弹窗');
  await ev(`document.getElementById('btnNewFolder').click()`);
  await waitFor(`document.getElementById('modal').classList.contains('on')`, '新建文件夹弹窗');
  const nfHint = await ev(`document.querySelector('#sheet .hint').textContent`);
  console.log(`        弹窗说明： ${nfHint}`);
  ckTrue('弹窗说明了会建在哪个目录下', /升级包/.test(nfHint), nfHint);
  await shot('new-folder', '新建文件夹弹窗');
  await ev(`document.querySelector('#sheet [data-x="cancel"]').click()`);

  /* ================================================================
     7. 分享：从行菜单到生成链接
     ================================================================ */
  section('分享弹窗与生成');
  await ev(`document.querySelector('.rows .row .ract').click()`);
  await waitFor(`document.getElementById('menu').classList.contains('on')`, '行内菜单');
  const menuItems = await ev(`[...document.querySelectorAll('#menu button')].map(b=>b.textContent.trim())`);
  console.log(`        菜单项： ${menuItems.join(' / ')}`);
  ckTrue('菜单里有分享', menuItems.includes('分享'), menuItems);
  await shot('row-menu', '行内菜单');

  await ev(`[...document.querySelectorAll('#menu button')].find(b=>b.textContent.trim()==='分享').click()`);
  await waitFor(`document.getElementById('modal').classList.contains('on')`, '分享弹窗');
  const ttlOpts = await ev(`[...document.querySelectorAll('#ttl option')].map(o=>o.textContent.trim())`);
  console.log(`        有效期选项： ${ttlOpts.join(' / ')}`);
  ckTrue('默认选中 2 小时', /2 小时.*默认/.test(ttlOpts.find(o=>o.includes('默认')) || ''), ttlOpts);
  await shot('share-create', '创建分享弹窗');

  await ev(`document.querySelector('#sheet [data-x="ok"]').click()`);
  await waitFor(`document.querySelector('.share-card') !== null`, '分享结果');
  const share = await ev(`(() => {
    const c = document.querySelector('.share-card');
    const vals = [...c.querySelectorAll('.kv .val')];
    const first = vals[0];
    const cs = getComputedStyle(first);
    return {
      name: c.querySelector('.sc-name').textContent,
      url: first.textContent, pw: vals[1].textContent,
      ttl: c.querySelector('.sc-ttl').textContent,
      copies: c.querySelectorAll('.copy').length,
      rows: c.querySelectorAll('.kv').length,
      whiteSpace: cs.whiteSpace, wordBreak: cs.wordBreak,
      scrollW: first.scrollWidth, clientW: first.clientWidth
    };
  })()`);
  console.log(`        分享： ${share.name}  ${share.url}`);
  console.log(`        密码 ${share.pw}（${share.ttl}）`);
  ckTrue('URL 指向分享页', /\/s\/s_[0-9a-f]{24}$/.test(share.url), share.url);
  ckTrue('密码 6 位且不含易混字符', /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(share.pw), share.pw);
  /* 只有链接和密码两行。「一起发」以底部按钮呈现，不再重复展示。 */
  ck('只有链接和密码两行', share.rows, 2);
  ck('链接和密码各配一个复制按钮', share.copies, 2);
  ck('"一起发"是个按钮', await ev(`!!document.querySelector('#sheet .sheet-act [data-copy]')`), true);
  /* 老板说链接框后面有滚动条"看着很丑" —— 钉住换行显示 */
  ck('链接框换行显示，不出现横向滚动条', share.whiteSpace, 'normal');
  ck('链接框按任意字符断行（URL 里没有空格）', share.wordBreak, 'break-all');
  ckTrue('链接框里确实没有可横向滚动的内容', share.scrollW <= share.clientW + 1, share);
  await shot('share-result', '分享结果（链接 + 密码）');

  /* ================================================================
     8. 分享管理
     ================================================================ */
  section('分享管理');
  /* 结果弹窗里不再放「分享管理」入口（顶栏那个按钮一直在），
     这里直接走顶栏进来 —— 顺带把"入口没丢"也验了。 */
  await ev(`closeSheet(); document.getElementById('btnShares').click()`);
  await waitFor(`document.querySelector('.mg-item') !== null`, '分享管理列表');
  const mg = await ev(`(() => {
    const i = document.querySelector('.mg-item');
    return { name: i.querySelector('.mg-name').textContent, sub: i.querySelector('.mg-sub').textContent.trim(), acts: [...i.querySelectorAll('.mini')].map(b=>b.textContent.trim()) };
  })()`);
  console.log(`        列表项： ${mg.name} — ${mg.sub}`);
  ckTrue('给出了剩余时间', /小时|分钟/.test(mg.sub), mg.sub);
  ckTrue('有复制链接和撤销', mg.acts.includes('撤销'), mg.acts);
  await shot('share-manager', '分享管理');
  await ev(`document.querySelector('#sheet [data-x="close"]').click()`);

  /* ================================================================
     9. 真实的分享页走一遍 —— 先看"分享单个文件"这条最容易坏的路径
     ================================================================ */
  section('公开分享页：分享的是一个文件（/s/<token>）');
  const shareToken = share.url.split('/s/')[1];
  await goto(BASE + '/s/' + shareToken);
  await waitFor(`document.getElementById('gateForm').style.display === 'block'`, '分享页密码框');

  const sInfo = await ev(`({ title: document.getElementById('gateTitle').textContent, brand: document.getElementById('brandPill').textContent, ttl: document.getElementById('ttlPill').textContent })`);
  ck('分享页要求输密码', sInfo.title, '需要访问密码');
  console.log(`        品牌标记 ${sInfo.brand}，${sInfo.ttl}`);
  ckTrue('显示了过期倒计时', /过期/.test(sInfo.ttl), sInfo.ttl);
  await shot('share-gate', '分享页密码框');

  /* 错密码 */
  await ev(`document.getElementById('pw').value='ZZZZZZ'; document.getElementById('go').click()`);
  await waitFor(`document.getElementById('err').classList.contains('on')`, '分享页错误提示');
  ck('分享页错密码的提示', await ev(`document.getElementById('err').textContent`), '密码不对');
  await sleep(250);   // 等按钮从 disabled 恢复

  /* 对密码 */
  await ev(`document.getElementById('pw').value=${JSON.stringify(share.pw)}; document.getElementById('go').click()`);
  await waitFor(`document.getElementById('browse').classList.contains('on')`, '分享浏览界面', 10000);
  const sFile = await ev(`(() => {
    const card = document.querySelector('#content .single');
    return {
      title: document.getElementById('title').textContent,
      hasCard: !!card,
      size: card ? card.querySelector('.ssize').textContent : null,
      hasDlBtn: !!(card && card.querySelector('[data-dl]')),
      rows: document.querySelectorAll('#content .row').length
    };
  })()`);
  console.log(`        打开的是「${sFile.title}」，${sFile.size}`);
  ck('分享的文件名就是页面标题', sFile.title, share.name);
  ckTrue('渲染成一张下载卡（而不是空列表）', sFile.hasCard, sFile);
  ck('没有多余的列表行', sFile.rows, 0);
  ckTrue('有下载按钮', sFile.hasDlBtn, sFile);
  await shot('share-single-file', '分享单个文件');

  /* 下载按钮：没配 OSS 应该是明确报错，而不是静默失败 */
  await ev(`document.querySelector('#content [data-dl]').click()`);
  await waitFor(`document.getElementById('toast').classList.contains('on')`, '下载提示');
  const dlToast = await ev(`document.getElementById('toast').textContent`);
  console.log(`        点下载后提示： ${dlToast}`);
  ckTrue('未配 OSS 时给出明确提示', /失败|503|对象存储/.test(dlToast), dlToast);
  await shot('share-download-error', '下载未配 OSS 的提示');

  /* ================================================================
     10. 分享页：分享的是一个文件夹
     ================================================================ */
  section('公开分享页：分享的是一个文件夹');
  await goto(BASE + '/');
  await waitFor(`document.getElementById('app').classList.contains('on')`, '回到网盘');

  // 直接用页面里的会话发一个文件夹分享，省得再点回顶层走一遍 UI
  const folderShare = await ev(`(async () => {
    const f = await fetch('/api/flat', { headers: { Authorization: 'Bearer ' + S.token } }).then(r=>r.json());
    const root = f.nodes.find(n => n.name === '示例目录' && n.type === 'folder');
    const r = await fetch('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token },
      body: JSON.stringify({ ids: [root.id], ttlHours: 1 })
    }).then(r => r.json());
    return r.share;
  })()`);
  console.log(`        文件夹分享 ${folderShare.items[0].name} / ${folderShare.password}`);

  await goto(BASE + '/s/' + folderShare.token);
  await waitFor(`document.getElementById('gateForm').style.display === 'block'`, '分享页密码框');
  await ev(`document.getElementById('pw').value=${JSON.stringify(folderShare.password)}; document.getElementById('go').click()`);
  await waitFor(`document.getElementById('browse').classList.contains('on')`, '分享浏览界面', 10000);

  const sFolder = await ev(`(() => ({
    title: document.getElementById('title').textContent,
    rows: [...document.querySelectorAll('#content .row')].map(r => r.querySelector('.fname').textContent),
    crumbHidden: document.getElementById('crumbs').style.display === 'none'
  }))()`);
  console.log(`        打开的是「${sFolder.title}」，列出 ${sFolder.rows.length} 项`);
  ck('分享页标题是被分享的文件夹名', sFolder.title, '示例目录');
  ck('列出了四个分类文件夹', sFolder.rows.sort(), ['主程序', '升级包', '工具软件', '故障处理'].sort());
  ck('在分享根上不显示面包屑（不泄露外层路径）', sFolder.crumbHidden, true);
  await shot('share-browse', `分享文件夹（${sFolder.rows.length} 项）`);

  /* 进子目录：面包屑不该把分享根重复一遍 */
  await ev(`document.querySelector('#content .row.folder').click()`);
  await waitFor(`document.getElementById('crumbs').style.display === 'flex'`, '分享页子目录面包屑');
  const sDeep = await ev(`(() => ({
    parts: [...document.querySelectorAll('#crumbs > *')].map(e=>e.textContent.trim()).filter(t => t && t !== '/'),
    files: document.querySelectorAll('#content .row').length
  }))()`);
  console.log(`        子目录面包屑： ${sDeep.parts.join(' / ')}，${sDeep.files} 个文件`);
  ck('分享根只出现一次（不重复）', sDeep.parts.filter(p => p === '示例目录').length, 1);
  ck('面包屑是"示例目录 / 子目录"两段', sDeep.parts.length, 2);
  await shot('share-subdir', '分享页进入子目录');

  /* 收拾干净：把这次验证发的分享都撤销，别在真实数据里留垃圾 */
  await goto(BASE + '/');
  await waitFor(`document.getElementById('app').classList.contains('on')`, '回到网盘');
  const revoked = await ev(`(async () => {
    const r = await fetch('/api/share/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token },
      body: JSON.stringify({ tokens: [${JSON.stringify(shareToken)}, ${JSON.stringify(folderShare.token)}] })
    }).then(r => r.json());
    return r.revoked;
  })()`);
  ck('验证用的两个分享已撤销', revoked, 2);

  /* ================================================================
     10.5 多选分享：一次分享 = 一个链接 + 一个密码
     ================================================================
     老板的原话是「相当于分享就是一个任务，而不是一个文件」。
     以前多选 N 项会生成 N 条链接 N 个密码，发的人还得自己对号入座。
     ================================================================ */
  section('多选分享');
  await ev(`(async () => {
    const f = await fetch('/api/flat', { headers: { Authorization: 'Bearer ' + S.token } }).then(r=>r.json());
    /* 挑同一层里的两个，免得挑成父子 —— 一个套一个，第一屏看着像重复 */
    const byParent = {};
    for (const n of f.nodes.filter(x => x.type === 'folder')) {
      const k = n.parent || 'root';
      (byParent[k] = byParent[k] || []).push(n);
    }
    const group = Object.values(byParent).find(g => g.length >= 2);
    window.__pick = (group || []).slice(0, 2).map(n => n.id);
    return window.__pick.length;
  })()`);
  const pickIds = await ev(`window.__pick`);
  ck('挑到两个同层的文件夹用来测', pickIds.length, 2);

  await ev(`shareNodes(window.__pick)`);
  await waitFor(`document.getElementById('modal').classList.contains('on')`, '创建分享弹窗');
  ck('多项时才解释一句"会装进同一条链接"',
    await ev(`/同一条链接/.test(document.getElementById('sheet').textContent)`), true);
  await shot('share-multi-create', '多选 · 创建分享');

  await ev(`document.querySelector('#sheet [data-x="ok"]').click()`);
  await waitFor(`document.querySelector('.share-card') !== null`, '分享结果');
  const multi = await ev(`(() => {
    const c = document.querySelector('.share-card');
    const vals = c.querySelectorAll('.kv .val');
    return {
      cards: document.querySelectorAll('.share-card').length,
      name: c.querySelector('.sc-name').textContent,
      url: vals[0].textContent, pw: vals[1].textContent
    };
  })()`);
  ck('两项合成一张卡（一条链接一个密码）', multi.cards, 1);
  ckTrue('标题写明这是两项', /等 2 项$/.test(multi.name), multi.name);
  await shot('share-multi-result', '多选分享结果');

  /* 对方那边：一个密码进去，看到的就是这两项 */
  const multiToken = multi.url.split('/s/')[1];
  await goto(BASE + '/s/' + multiToken);
  await waitFor(`document.getElementById('gateForm').style.display === 'block'`, '分享页密码框');
  await ev(`document.getElementById('pw').value=${JSON.stringify(multi.pw)}; document.getElementById('go').click()`);
  await waitFor(`document.getElementById('browse').classList.contains('on')`, '分享浏览界面', 10000);
  const mView = await ev(`(() => ({
    rows: [...document.querySelectorAll('#content .row')].map(r => r.querySelector('.fname').textContent),
    crumbHidden: document.getElementById('crumbs').style.display === 'none'
  }))()`);
  console.log(`        对方打开后看到： ${mView.rows.join(' / ')}`);
  ck('对方一屏就看到这两项', mView.rows.length, 2);
  ck('这一屏不显示面包屑', mView.crumbHidden, true);
  await shot('share-multi-browse', '多选分享 · 对方打开后');

  /* 收拾干净 */
  await goto(BASE + '/');
  await waitFor(`document.getElementById('app').classList.contains('on')`, '回到网盘');
  const revoked2 = await ev(`fetch('/api/share/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token },
    body: JSON.stringify({ tokens: [${JSON.stringify(multiToken)}] })
  }).then(r => r.json()).then(r => r.revoked)`);
  ck('多选分享也撤销了', revoked2, 1);

  /* ================================================================
     11. 登出
     ================================================================ */
  section('登出');
  await goto(BASE + '/');
  await waitFor(`document.getElementById('app').classList.contains('on')`, '会话恢复（同一标签页）');
  ck('同一标签页内刷新不用重新登录（sessionStorage 里的票还在）',
    await ev(`document.getElementById('app').classList.contains('on')`), true);
  await ev(`document.getElementById('btnLogout').click()`);
  await waitFor(`!document.getElementById('app').classList.contains('on')`, '回到登录门');
  ck('登出后回到登录门', await ev(`document.getElementById('step1').style.display !== 'none'`), true);
  await shot('after-logout', '登出后');

  /* ================================================================ */
  console.log('\n' + '='.repeat(52));
  console.log(`截图目录 ${OUT}`);
  console.log(fail
    ? `\x1b[31m失败 ${fail} 项\x1b[0m，通过 ${pass} 项`
    : `\x1b[32m全部通过\x1b[0m（${pass} 项）`);
  if (fail) { console.log('失败清单：'); failures.forEach(f => console.log('  - ' + f)); }
  if (!KEEP) { try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (_) {} }
  else console.log('（--keep 保留截图）');

  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\n界面验证崩了：', e && e.stack || e);
  process.exit(1);
});
