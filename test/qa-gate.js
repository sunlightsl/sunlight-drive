#!/usr/bin/env node
/**
 * 登录页视觉验证（CDP 驱动系统 Edge，可选依赖，不影响交付物）
 * ------------------------------------------------------------------
 * 用法：
 *   node test/qa-gate.js                跑一遍，截图到 test/screenshots/
 *   node test/qa-gate.js --out <目录>    换输出目录
 *   node test/qa-gate.js --port 3000    被测服务端口
 *
 * 为什么单独一个文件：登录页是这一版改动最集中的地方（左右分栏、毛玻璃、
 * 两步切换、窄屏折叠），而 qa-shot.js 要跑完整个业务流才轮到它一眼，改一次
 * 看一次太慢。这里只做登录门，亮/暗/错密码/动态码/窄屏五张图，二十来秒出结果。
 *
 * 和 qa-shot.js 一样，它不只截图，也断言结构：分栏还在不在、卡片有没有被压扁、
 * 那句被删掉的提示有没有偷偷长回来。
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
const OUT = argVal('--out', path.join(ROOT, 'test/screenshots'));
const CDP_PORT = parseInt(argVal('--cdp-port', '9341'), 10);

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].find(p => fs.existsSync(p));
if (!EDGE) { console.error('找不到 Edge，无法做界面验证。'); process.exit(2); }

/* ---------------- 读 .env ---------------- */
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

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-gate-profile-'));
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

  let target = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await getJson('/json/list');
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch (_) {}
    await sleep(250);
  }
  if (!target) throw new Error('连不上 Edge 的调试端口。');

  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  async function goto(url) {
    const loaded = cdp.waitEvent('Page.loadEventFired', 20000);
    await cdp.send('Page.navigate', { url });
    await loaded;
    await sleep(280);
  }
  async function ev(expression) {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
    console.log(`  shot  ${path.basename(f)}${note ? '   ' + note : ''}`);
    return f;
  }

  /* 截图前把过渡关掉，免得拍到动画中间那一帧 */
  const freezeAnim = `(() => {
    const s = document.createElement('style');
    s.textContent = '*{transition:none !important;animation:none !important}';
    document.head.appendChild(s);
    return true;
  })()`;
  const unfreezeAnim = `(() => {
    document.querySelectorAll('head style').forEach(s => {
      if (s.textContent.includes('animation:none !important')) s.remove();
    });
    return true;
  })()`;

  /* ================================================================
     1. 结构：左右分栏还在不在
     ================================================================ */
  section('登录门结构');
  await goto(BASE + '/');
  await waitFor(`document.getElementById('step1').style.display !== 'none'`, '登录框');

  ck('左侧品牌栏存在', await ev(`!!document.querySelector('.gate-side')`), true);
  ck('右侧表单栏存在', await ev(`!!document.querySelector('.gate-card > .gate-form')`), true);
  ck('两张表单都挂在右侧表单栏里',
    await ev(`document.querySelectorAll('.gate-form > #step1, .gate-form > #step2').length`), 2);
  ck('背景有两团光斑（毛玻璃得有东西可透）',
    await ev(`document.querySelectorAll('.gate-glow').length`), 2);

  /* 卡片是两列网格。取计算值而不是 CSS 声明 —— 声明对了但被别的规则盖掉
     一样是白搭，这里要的是浏览器真的排成了两列。 */
  const cols = await ev(`getComputedStyle(document.querySelector('.gate-card')).gridTemplateColumns`);
  ck('卡片排成了左右两列', String(cols).trim().split(/\s+/).length, 2);

  const card = await ev(`(() => {
    const r = document.querySelector('.gate-card').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  console.log(`        卡片 ${card.w}x${card.h}`);
  ckTrue('卡片有分量（高度撑得起来，不是一条）', card.h >= 300, card);
  ckTrue('卡片有分量（宽度够）', card.w >= 700, card);

  /* 毛玻璃三件套：半透明底 + backdrop blur
     注意 color-mix() 算出来的是现代写法 color(srgb 1 1 1 / 0.62)，不是 rgba()，
     所以这里只认「斜杠后面跟一个小于 1 的透明度」这个特征。 */
  const glass = await ev(`(() => {
    const s = getComputedStyle(document.querySelector('.gate-card'));
    return { bg: s.backgroundColor, blur: s.backdropFilter || s.webkitBackdropFilter };
  })()`);
  ckTrue('卡片底色是半透明的（不透就成白板了）',
    /\/\s*0?\.\d+\s*\)/.test(glass.bg), glass.bg);
  ckTrue('卡片开了背景模糊', /blur\(/.test(glass.blur || ''), glass.blur);

  /* 品牌名走的是接口给的品牌，不是写死的 */
  const brand = await ev(`document.getElementById('brandName').textContent`);
  ck('左侧品牌名 = 接口给的品牌名',
    await ev(`document.getElementById('gateTitle').textContent`), brand);

  /* 老板点名要删的那句。删掉的东西要钉住，不然下次重构很容易顺手加回来。 */
  ck('第二步没有"打开手机上的验证器…"这句',
    await ev(`/打开手机/.test(document.getElementById('step2').textContent)`), false);
  ck('登录门上也没有多余的自我说明',
    await ev(`!!document.querySelector('.gate-tip') || !!document.querySelector('.brand-sub')`), false);

  await ev(freezeAnim);
  await shot('login-1-light', '亮色 · 登录第一步');

  /* ================================================================
     2. 暗色
     ================================================================ */
  section('暗色主题');
  await ev(`document.documentElement.setAttribute('data-theme','dark'); 1`);
  await sleep(160);
  const dk = await ev(`(() => {
    const s = getComputedStyle(document.body);
    return { bg: s.backgroundColor, theme: document.documentElement.getAttribute('data-theme') };
  })()`);
  ck('切到暗色了', dk.theme, 'dark');
  ckTrue('暗色下底色是深的', /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.test(dk.bg) &&
    dk.bg.match(/\d+/g).slice(0, 3).reduce((a, b) => +a + +b, 0) < 200, dk.bg);
  await shot('login-2-dark', '暗色 · 登录第一步');

  /* 暗色下卡片里的字得是亮的，不然等于没有 */
  const dkText = await ev(`getComputedStyle(document.querySelector('.gs-name')).color`);
  ckTrue('暗色下品牌名仍然是亮色', dkText === 'rgb(255, 255, 255)', dkText);
  const dkInput = await ev(`getComputedStyle(document.getElementById('pwd')).color`);
  ckTrue('暗色下输入框文字是亮的',
    dkInput.match(/\d+/g).slice(0, 3).reduce((a, b) => +a + +b, 0) > 400, dkInput);

  await ev(`document.documentElement.setAttribute('data-theme','light'); 1`);
  await sleep(120);

  /* ================================================================
     3. 错密码
     ================================================================ */
  section('错密码');
  await ev(`document.getElementById('pwd').value='definitely-wrong'; submitPwd()`);
  await waitFor(`document.getElementById('gateErr').classList.contains('on')`, '错误提示');
  ck('提示文案没变', await ev(`document.getElementById('gateErr').textContent`), '密码不对');
  /* 报错不能让卡片塌掉或把按钮挤走 */
  const errCard = await ev(`(() => {
    const b = document.getElementById('pwdBtn').getBoundingClientRect();
    const card = document.querySelector('.gate-card').getBoundingClientRect();
    return { btnVisible: b.width > 0 && b.height > 0, cardH: Math.round(card.height) };
  })()`);
  ck('报错时按钮还在', errCard.btnVisible, true);
  await shot('login-3-error', '错密码提示');

  /* ================================================================
     4. 动态码这一步
     ================================================================ */
  section('动态码这一步');
  await ev(`document.getElementById('pwd').value=${JSON.stringify(ENV.SITE_PASSWORD)}; submitPwd()`);
  await waitFor(`document.getElementById('step2').style.display === 'block'`, '动态码输入框');
  ck('切到第二步时左侧品牌栏还在（没有整页重绘）',
    await ev(`!!document.querySelector('.gate-side')`), true);
  await shot('login-4-totp', '亮色 · 第二步（动态码）');

  /* 第二步的输入框是等宽的等宽字体，字号明显比第一步大 */
  const codeFs = await ev(`parseFloat(getComputedStyle(document.getElementById('code')).fontSize)`);
  const pwdFs = await ev(`parseFloat(getComputedStyle(document.getElementById('pwd')).fontSize)`);
  ckTrue('动态码输入框字号更大', codeFs > pwdFs, { codeFs, pwdFs });

  /* 走完整登录，确认这两步没被样式改坏 */
  const secret = ENV.TOTP_SECRET;
  if (!secret) { console.log('  --    .env 里没有 TOTP_SECRET，跳过登录'); }
  else {
    if (totp.secondsLeft() < 4) await sleep(4200);
    await ev(`document.getElementById('code').value=${JSON.stringify(totp.code(secret))}; submitCode()`);
    await waitFor(`document.getElementById('app').classList.contains('on')`, '主界面');
    ck('两步都走完能进主界面', await ev(`document.getElementById('app').classList.contains('on')`), true);
    ck('登录门收起来了', await ev(`document.getElementById('gate').classList.contains('off')`), true);
  }

  /* ================================================================
     5. 个人资料（昵称 + 头像）
     ================================================================ */
  section('个人资料');
  ck('顶栏有头像入口', await ev(`!!document.getElementById('btnProfile')`), true);
  /* 没设头像时，兜底显示品牌名的首字 —— 空的灰圆圈不好认 */
  ck('没头像时顶栏是首字兜底',
    await ev(`document.getElementById('avaTop').textContent.trim()`), 'S');

  /* 造一张 600x400 的图，走一遍前端的缩图逻辑。
     缩的是浏览器里的 canvas —— 这个函数没法在服务端测。 */
  await ev(`window.__png = null`);
  const shrunk = await ev(`(async () => {
    const cv = document.createElement('canvas');
    cv.width = 600; cv.height = 400;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#5866d4'; ctx.fillRect(0, 0, 600, 400);
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    const uri = await shrinkImage(new File([blob], 't.png', { type: 'image/png' }));
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = uri; });
    window.__png = uri;
    return { head: uri.slice(0, 22), w: img.width, h: img.height, kb: Math.round(uri.length / 1024) };
  })()`);
  ck('缩图输出的是 PNG data URI', shrunk.head, 'data:image/png;base64,');
  ck('长边缩到 200', Math.max(shrunk.w, shrunk.h), 200);
  ck('短边等比跟着缩', shrunk.h, 133);
  console.log(`        缩完 ${shrunk.kb} KB（原图 600x400）`);
  ckTrue('缩完足够小，不会把 drive.json 撑起来', shrunk.kb < 120, shrunk.kb);

  /* 真的传上去，看服务端认不认。 */
  ck('上传缩好的头像', await ev(`api('/api/profile/avatar', {
    method: 'POST', body: JSON.stringify({ avatar: window.__png })
  }).then(d => d.profile.avatar.length === window.__png.length)`), true);

  await ev(`applyProfile({ nickname: '', avatar: window.__png })`);
  ck('有头像时顶栏渲染成 <img>',
    await ev(`!!document.getElementById('avaTop').querySelector('img')`), true);

  await ev(`document.getElementById('btnProfile').click()`);
  await waitFor(`document.getElementById('modal').classList.contains('on')`, '资料弹窗');
  ck('弹窗里有昵称输入框', await ev(`!!document.getElementById('profNick')`), true);
  ck('弹窗里的头像预览也是图',
    await ev(`!!document.getElementById('profAva').querySelector('img')`), true);
  ck('弹窗里有"恢复默认"', await ev(`!!document.getElementById('profClear')`), true);
  await shot('profile-dialog', '个人资料弹窗');

  /* 改昵称。这一下是走接口的，会真的落到 data/drive.json 里。
     测完下面会还原，不留痕迹。 */
  await ev(`document.getElementById('profNick').value='示例昵称';
            document.getElementById('profSave').click()`);
  await waitFor(`!document.getElementById('modal').classList.contains('on')`, '弹窗关闭');
  const afterRename = await ev(`({
    title: document.title,
    ava: document.getElementById('avaTop').querySelector('img') ? 'img' : 'text'
  })`);
  ckTrue('标签页标题带上了昵称', afterRename.title.indexOf('示例昵称') === 0, afterRename.title);
  ck('有头像时顶栏还是图，没有被昵称首字顶掉', afterRename.ava, 'img');

  /* 刷新一次：昵称是存在服务端的，不是只在内存里 */
  await goto(BASE + '/');
  await waitFor(`document.getElementById('app').classList.contains('on')`, '刷新后仍是登录态');
  ckTrue('刷新后昵称还在', (await ev(`document.title`)).indexOf('示例昵称') === 0, await ev(`document.title`));

  await shot('profile-topbar', '顶栏头像');

  /* 还原：把头像清掉、昵称改回品牌名。
     验证脚本跑在真实数据目录上，不能给用户留下测试痕迹。 */
  await ev(`api('/api/profile/avatar/clear', { method: 'POST', body: '{}' }).catch(() => {})`);
  await ev(`api('/api/profile', { method: 'POST', body: JSON.stringify({ nickname: 'sunlight' }) }).catch(() => {})`);
  await ev(`applyProfile({ nickname: '', avatar: '' })`);
  ck('收尾把头像清干净了',
    await ev(`!!document.getElementById('avaTop').querySelector('img')`), false);

  /* ================================================================
     6. 窄屏：左右分栏要折叠
     ================================================================ */
  section('窄屏');
  await ev(`document.getElementById('gate').classList.remove('off'); document.getElementById('app').classList.remove('on'); 1`);
  await ev(`gotoStep(1)`);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });
  await sleep(320);
  const mobCols = await ev(`getComputedStyle(document.querySelector('.gate-card')).gridTemplateColumns`);
  ck('窄屏下卡片只剩一列', String(mobCols).trim().split(/\s+/).length, 1);
  const mobSide = await ev(`(() => {
    const s = getComputedStyle(document.querySelector('.gate-side'));
    return { dir: s.flexDirection, h: Math.round(document.querySelector('.gate-side').getBoundingClientRect().height) };
  })()`);
  ck('窄屏下品牌栏横过来（不再占一整列）', mobSide.dir, 'row');
  ckTrue('窄屏下品牌栏只占一条', mobSide.h < 150, mobSide);
  /* 窄屏最容易出的问题是横向溢出 */
  const overflow = await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  ckTrue('窄屏下没有横向滚动条', overflow <= 1, { overflow });
  await shot('login-5-mobile', '窄屏 · 登录第一步');

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);

  cdp.close();
  edge.kill();

  /* ---------------- 汇总 ---------------- */
  console.log('\n' + '='.repeat(52));
  console.log(`截图目录 ${OUT}`);
  if (fail) {
    console.log(`\x1b[31m${fail} 项没通过\x1b[0m：\n  - ` + failures.join('\n  - '));
    process.exitCode = 1;
  } else {
    console.log(`\x1b[32m全部通过（${pass} 项）\x1b[0m`);
  }
})();
