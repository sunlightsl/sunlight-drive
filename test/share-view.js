/**
 * 分享页面的界面验证（真服务 + 真浏览器 + CDP）
 * ------------------------------------------------------------------
 * 覆盖三件"静态分析查不出来"的事：
 *   1. 列表里的类型图标有没有真的渲染出来（文件夹 / 文件）
 *   2. 点文件夹行能不能进到下一层、能不能返回
 *   3. 视图切换与搜索
 *
 * 为什么必须开真浏览器：图标是 SVG + CSS 尺寸一起决定的（少一边就成了空白），
 * 点击走的是 document 上的事件委托 —— 这两类问题 grep 和量数值都发现不了。
 * 之前正是这两处出过问题：图标整列丢了，文件夹点不开。
 *
 * 装置和 test/preview.js 一样：**服务跑在同一个进程里**（require server.js），
 * 这样测试可以直接用它的 store 造数据，不用管跨进程缓存。
 * 零依赖：WebSocket 用 Node 22 内置的。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sunlight-sv-'));
process.env.DRIVE_DATA_DIR = TMP;
process.env.SITE_PASSWORD = 'pwd-for-sv-' + Date.now();
process.env.ADMIN_USERNAME = 'boss';
process.env.TOTP_SECRET = '';
process.env.TOTP_DISABLED = '1';
process.env.MAX_ATTEMPTS = '100';
process.env.SHARE_MAX_ATTEMPTS = '100';
process.env.BRAND = 'sunlight';
process.env.OSS_REGION = 'oss-cn-hangzhou';
process.env.OSS_KEY_ID = 'FAKEKEYID0001';
process.env.OSS_KEY_SECRET = 'k'.repeat(24) + '1';
process.env.OSS_BUCKET = 'fake-platform-bucket';
process.env.OSS_UPLOAD_PREFIX = 'drive';

const SITE_PW = process.env.SITE_PASSWORD;

/* 不落地的假对象存储 */
const objects = new Map();
const fake = {
  async put(k, b) { objects.set(k, { size: (b && b.length) || 0 }); },
  async delete(k) { objects.delete(k); },
  async copy(d, s) {
    if (!objects.has(s)) throw Object.assign(new Error('NoSuchKey'), { status: 404 });
    objects.set(d, { size: objects.get(s).size });
    return { data: {} };
  },
  signatureUrl(key) { return 'https://fake.example/' + encodeURIComponent(key) + '?sig=1'; },
  async listUploads() { return { uploads: [] }; },
  async abortMultipartUpload() {}
};

const ossconfig = require('../lib/ossconfig');
ossconfig.getClientFor = () => fake;

const store = require('../lib/store');
const tree = require('../lib/tree');

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
const ck = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : ' FAIL '} ${label}${ok ? '' : `   got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const ckTrue = (label, got, extra) => {
  const ok = !!got;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : ' FAIL '} ${label}${ok || extra === undefined ? '' : `   got=${JSON.stringify(got)}`}`);
};
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 浏览器 ---------- */
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].find(p => fs.existsSync(p));

let edge = null, ws = null, SPORT = 0;

const getJson = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CPORT, path: p }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const CPORT = 9402;

const cleanup = async () => {
  try { if (ws) ws.close(); } catch (_) {}
  try { if (edge) edge.kill(); } catch (_) {}
  await wait(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

(async () => {
  if (!EDGE) { console.log('  (没找到 Edge/Chrome，跳过界面测试)'); return; }
  if (typeof WebSocket !== 'function') { console.log('  (需要 Node 22 的内置 WebSocket，跳过)'); return; }

  /* ---------- 起服务（同进程） ----------
     必须先 bootstrap()：它才会用 SITE_PASSWORD 建出首个账号。
     少了这一步，store 里一个 user 都没有，后面找 boss 就是 undefined。 */
  const app = require('../server.js');
  await app.bootstrap();
  const srv = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  SPORT = srv.address().port;
  console.log('  测试服务 http://127.0.0.1:' + SPORT);

  /* ---------- 造数据：文件夹（含一个文件）+ 一个顶层文件 ---------- */
  const boss = Object.values(store.get().users).find(u => u.username === 'boss');
  const built = await store.mutate(s => {
    /* createFolder 是位置参数 (s, name, parentId, owner)；addFile 收对象。
       刻意做成两层嵌套：双击防护只有"里层还有文件夹"时才测得出来 ——
       第二下落在新列表的那一行上，没有防护就会再进一层。 */
    const outer = tree.createFolder(s, '素材目录', null, boss.id);
    tree.createFolder(s, '里层目录', outer.id, boss.id);
    const inner = tree.addFile(s, {
      name: '里层文件.txt', parentId: outer.id, size: 1024,
      ossKey: 'drive/seed/inner.txt', owner: boss.id
    });
    const top = tree.addFile(s, {
      name: '顶层文件.txt', parentId: null, size: 2048,
      ossKey: 'drive/seed/top.txt', owner: boss.id
    });
    return { folderId: outer.id, innerId: inner.id, topId: top.id };
  });
  objects.set('drive/seed/inner.txt', { size: 1024 });
  objects.set('drive/seed/top.txt', { size: 2048 });

  const share = await store.mutate(s => {
    const token = 's_' + require('crypto').randomBytes(12).toString('hex');
    const auth = require('../lib/auth');
    s.shares[token] = {
      token, owner: boss.id, createdAt: Date.now(), hits: 0,
      items: [
        { id: built.folderId, name: '素材目录', type: 'folder' },
        { id: built.topId, name: '顶层文件.txt', type: 'file' }
      ],
      pwHash: auth.hashSharePassword('svpw123')
    };
    return { token };
  });
  share.token && console.log('  分享 token ' + share.token.slice(0, 14) + '…');

  /* ---------- 开浏览器 ---------- */
  const profile = path.join(TMP, 'profile');
  const url = `http://127.0.0.1:${SPORT}/s/${share.token}`;
  edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${CPORT}`, `--user-data-dir=${profile}`,
    '--window-size=1200,900', url], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await getJson('/json/list');
      page = targets.find(t => t.type === 'page' && t.url.includes(share.token));
      if (page) break;
    } catch (_) {}
    await wait(500);
  }
  if (!page) { console.log('  !! 浏览器没打开分享页'); fail++; await cleanup(); srv.close(); process.exit(1); }

  ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  ws.addEventListener('message', ev => {
    const x = JSON.parse(ev.data);
    if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    setTimeout(() => rej(new Error('CDP 超时')), 15000);
  });
  const send = (m, p) => new Promise(r => {
    const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
  /* 轮询到条件成立再往下走。
     固定 wait(ms) 的问题是：机器一忙就不够，然后测试随机变红 ——
     实测搜索那段就因为这个偶发失败（有 120ms 防抖）。 */
  const waitFor = async (expr, timeoutMs = 6000, stepMs = 100) => {
    const t0 = Date.now();
    for (;;) {
      if (await js(expr)) return true;
      if (Date.now() - t0 > timeoutMs) return false;
      await wait(stepMs);
    }
  };

  const js = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return 'ERR:' + r.result.exceptionDetails.text;
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await wait(1200);

  /* ---------- 1. 过密码 ---------- */
  console.log('\n== 1. 过密码进入分享 ==');
  ck('密码框在', await js(`!!$('pw')`), true);
  await js(`(() => { $('pw').value = 'svpw123'; submitPassword(); return 'ok'; })()`);
  await wait(2200);
  ck('已进入浏览态', await js(`$('browse').classList.contains('on')`), true);
  ck('标题是分享内容', await js(`$('title').textContent`), '分享内容');

  /* ---------- 2. 图标 ---------- */
  console.log('\n== 2. 类型图标 ==');
  ck('行数', await js(`document.querySelectorAll('.list .row').length`), 2);
  ck('文件夹行有图标', await js(`document.querySelectorAll('.list .row.folder .fico svg').length`), 1);
  ck('文件行有图标', await js(`document.querySelectorAll('.list .row:not(.folder) .fico svg').length`), 1);
  ckTrue('图标尺寸可见（≥10px）', await js(`(() => {
    const s = document.querySelector('.list .row.folder .fico svg');
    if (!s) return false;
    const r = s.getBoundingClientRect();
    return r.width >= 10 && r.height >= 10;
  })()`), await js(`(() => { const s=document.querySelector('.list .row.folder .fico svg'); if(!s) return 'no svg'; const r=s.getBoundingClientRect(); return r.width+'x'+r.height; })()`));
  ckTrue('图标颜色不是透明', await js(`(() => {
    const s = document.querySelector('.list .row.folder .fico svg');
    if (!s) return false;
    const c = getComputedStyle(s).color;
    return !!c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent';
  })()`), await js(`(() => { const s=document.querySelector('.list .row.folder .fico svg'); return s?getComputedStyle(s).color:'no svg'; })()`));
  ckTrue('文件夹图标是强调色（和文件区分开）', await js(`(() => {
    const f = document.querySelector('.list .row.folder .fico');
    const g = document.querySelector('.list .row:not(.folder) .fico');
    if (!f || !g) return false;
    return getComputedStyle(f).color !== getComputedStyle(g).color;
  })()`));

  /* ---------- 3. 表头列数对齐 ---------- */
  console.log('\n== 3. 表头与行的列数 ==');
  ck('表头 4 列', await js(`document.querySelectorAll('.lhead > span').length`), 4);
  ck('文件行 4 列', await js(`document.querySelectorAll('.list .row:not(.folder) > span').length`), 4);

  /* ---------- 4. 点文件夹进去 ---------- */
  console.log('\n== 4. 点文件夹行进入下一层 ==');
  ck('根屏返回按钮禁用', await js(`$('btnBack').disabled`), true);
  await js(`(() => { document.querySelector('.list .row.folder .fname').click(); return 'ok'; })()`);
  ckTrue('进目录后列表换成了里面那一层', await waitFor(`/里层文件/.test($('content').textContent)`));
  ckTrue('面包屑出现层级', /素材目录/.test(await js(`$('crumbs').textContent`) || ''), await js(`$('crumbs').textContent`));
  ck('返回按钮已启用', await js(`$('btnBack').disabled`), false);

  /* ---------- 5. 返回 ---------- */
  console.log('\n== 5. 返回上一级 ==');
  await js(`(() => { $('btnBack').click(); return 'ok'; })()`);
  ckTrue('回到根（看到顶层文件）', await waitFor(`/顶层文件/.test($('content').textContent)`));
  ck('返回按钮又禁用了', await js(`$('btnBack').disabled`), true);

  /* ---------- 6. 面包屑返回 ---------- */
  console.log('\n== 6. 面包屑可点返回 ==');
  await js(`(() => { document.querySelector('.list .row.folder .fname').click(); return 'ok'; })()`);
  await wait(1600);
  ckTrue('面包屑根项是可点链接', await js(`!!document.querySelector('#crumbs a[data-crumb]')`));
  await js(`(() => { document.querySelector('#crumbs a[data-crumb]').click(); return 'ok'; })()`);
  await wait(1600);
  ckTrue('点面包屑回到根', /顶层文件/.test(await js(`$('content').textContent`) || ''));

  /* ---------- 7. 视图切换 ---------- */
  console.log('\n== 7. 视图切换 ==');
  await js(`(() => { $('btnView').click(); return 'ok'; })()`);
  await waitFor(`document.querySelectorAll('.grid .card-t').length === 2`);
  ck('切到网格：2 张卡片', await js(`document.querySelectorAll('.grid .card-t').length`), 2);
  ck('网格里文件夹图标在', await js(`document.querySelectorAll('.grid .card-t.dir .cico svg').length`), 1);
  await js(`(() => { document.querySelector('.grid .card-t.dir .cname').click(); return 'ok'; })()`);
  ckTrue('网格里点文件夹能进', await waitFor(`/里层文件/.test($('content').textContent)`));
  await js(`(() => { $('btnBack').click(); return 'ok'; })()`);
  await wait(1500);
  await js(`(() => { $('btnView').click(); return 'ok'; })()`);
  await waitFor(`document.querySelectorAll('.list .row').length === 2`);
  ck('切回列表', await js(`document.querySelectorAll('.list .row').length`), 2);

  /* ---------- 8. 搜索 ---------- */
  console.log('\n== 8. 搜索（当前目录内） ==');
  await js(`(() => { const i=$('q'); i.value='顶层'; i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`);
  /* 等到列表真的只剩匹配项 —— 别赌固定延时 */
  await waitFor(`/顶层文件/.test($('content').textContent) && !/素材目录/.test($('content').textContent)`);
  const searched = await js(`$('content').textContent`);
  ckTrue('只剩匹配项', /顶层文件/.test(searched || '') && !/素材目录/.test(searched || ''), searched);
  await js(`(() => { const i=$('q'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`);
  await waitFor(`/素材目录/.test($('content').textContent)`);
  ckTrue('清空后恢复', /素材目录/.test(await js(`$('content').textContent`) || ''));

  /* ---------- 9. 换目录清搜索 ---------- */
  console.log('\n== 9. 换目录时清空搜索 ==');
  await js(`(() => { const i=$('q'); i.value='顶层'; i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`);
  await wait(500);
  await js(`(() => { const i=$('q'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`);
  await wait(400);
  await js(`(() => { document.querySelector('.list .row.folder .fname').click(); return 'ok'; })()`);
  await wait(1600);
  ck('搜索框已清空', await js(`$('q').value`), '');

  /* ---------- 10. 双击语义（和主站一致） ---------- */
  console.log('\n== 10. 双击行为 ==');
  /* 上一节结束时位于子目录，先回根 —— 双击要从根开始测 */
  await js(`(() => { if (!$('btnBack').disabled) $('btnBack').click(); return 'ok'; })()`);
  await wait(1800);
  ck('已在根', await js(`/素材目录/.test($('content').textContent)`), true);

  /* 用 spy 数 openFolder 被调用几次 —— 这是唯一能可靠钉住"双击防护"的办法。
     断言"只进了一层"是不够的：真实的第二下落在**新列表**那一行上，
     合成事件做不到这点，于是注入 bug 也不会变红（试过，确实不变红）。
     而数调用次数是确定的：去掉时间窗后 click 和 dblclick 各进一次，
     openFolder 会被调两遍（实测 2 次 vs 1 次）。 */
  await js(`(() => {
    window.__navCalls = [];
    const orig = openFolder;
    openFolder = function (fid) { window.__navCalls.push(fid); return orig(fid); };
    return 'ok';
  })()`);
  await js(`(() => {
    const el = document.querySelector('.list .row.folder .fname');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return 'ok';
  })()`);
  await wait(2400);
  ck('双击文件夹只触发一次导航', await js(`window.__navCalls.length`), 1);
  ck('进的是被点的那一层', await js(`/里层文件/.test($('content').textContent)`), true);
  ckTrue('面包屑只有一层', (await js(`$('crumbs').textContent`) || '').split('/').length === 2,
    await js(`$('crumbs').textContent`));
  await js(`(() => { $('btnBack').click(); return 'ok'; })()`);
  await wait(1800);

  /* 单文件分享：工具栏收起 */
  console.log('\n== 11. 单文件分享时工具栏收起 ==');
  const one = await store.mutate(s => {
    const token = 's_' + require('crypto').randomBytes(12).toString('hex');
    s.shares[token] = {
      token, owner: boss.id, createdAt: Date.now(), hits: 0,
      items: [{ id: built.topId, name: '顶层文件.txt', type: 'file' }],
      pwHash: require('../lib/auth').hashSharePassword('svpw123')
    };
    return token;
  });
  await send('Page.navigate', { url: `http://127.0.0.1:${SPORT}/s/${one}` });
  await wait(2500);
  await js(`(() => { const i=$('pw'); if (i) { i.value='svpw123'; submitPassword(); } return 'ok'; })()`);
  await wait(2200);
  ck('单文件分享：工具栏隐藏', await js(`getComputedStyle($('toolbar')).display`), 'none');
  ckTrue('单文件分享：给出下载卡', /顶层文件/.test(await js(`$('content').textContent`) || ''), await js(`$('content').textContent`));

  console.log('\n====================================================');
  console.log(`\x1b[${fail ? '31' : '32'}m通过 ${pass} 项，失败 ${fail} 项\x1b[0m`);
  await cleanup();
  srv.close();
  await wait(200);
  process.exit(fail ? 1 : 0);
})().catch(async e => {
  console.error('测试本身崩了: ' + (e && e.stack ? e.stack : e.message));
  await cleanup();
  process.exit(1);
});
