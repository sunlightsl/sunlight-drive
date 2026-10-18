/**
 * 头像菜单里的用量条
 * ------------------------------------------------------------------
 * 站长在后台给每个人设了配额，但普通用户自己看不到 —— 传不上去时只能猜。
 * 这里钉住三件事：
 *   1. 菜单里确实显示"已用 / 总额"和一个进度条
 *   2. 数字和 /api/account 下发的用量一致（不是写死的占位）
 *   3. 快满、已满时颜色会变，且不会因为长数字把菜单撑破
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sunlight-qu-'));
Object.assign(process.env, {
  DRIVE_DATA_DIR: TMP, SITE_PASSWORD: 'qu-pass-123', ADMIN_USERNAME: 'boss',
  TOTP_SECRET: '', TOTP_DISABLED: '1', MAX_ATTEMPTS: '100',
  BRAND: 'sunlight', OSS_REGION: 'oss-cn-hangzhou', OSS_KEY_ID: 'FAKEKEYID0001',
  OSS_KEY_SECRET: 'k'.repeat(24) + '1', OSS_BUCKET: 'fake-bucket', OSS_UPLOAD_PREFIX: 'drive',
  QUOTA_GB: '1'
});
require('../lib/ossconfig').getClientFor = () => ({
  async put() {}, async delete() {}, async copy() { return { data: {} }; },
  signatureUrl: k => 'https://fake/' + k, async listUploads() { return { uploads: [] }; },
  async abortMultipartUpload() {}
});

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
if (!EDGE || typeof WebSocket !== 'function') { console.log('  (需要 Edge/Chrome + Node 22，跳过)'); process.exit(0); }

const CPORT = 9416;
const GB = 1073741824;
let pass = 0, fail = 0;
const ck = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : ' FAIL '} ${label}${ok ? '' : `   got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const ckTrue = (label, got, extra) => {
  const ok = !!got; ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : ' FAIL '} ${label}${ok || extra === undefined ? '' : `   got=${JSON.stringify(got)}`}`);
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const getJson = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CPORT, path: p }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

let edge = null, ws = null;
const cleanup = async () => {
  try { if (ws) ws.close(); } catch (_) {}
  try { if (edge) edge.kill(); } catch (_) {}
  await wait(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

(async () => {
  const app = require('../server.js');
  await app.bootstrap();
  const store = require('../lib/store');
  const tree = require('../lib/tree');

  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const SPORT = srv.address().port;

  /* 普通用户 + 一批已存在的文件，让"已用"不为 0 有意义 */
  const me = Object.values(store.get().users).find(u => u.username === 'boss');
  const { uid } = await store.mutate(async s => {
    const u = require('../lib/users').create(s, { username: 'plain', password: 'pw-plain-123' });
    return { uid: u.id };
  });
  const SEED = 320 * 1024 * 1024;   // 320MB / 1GB = 32%
  await store.mutate(s => {
    tree.addFile(s, { name: 'a.bin', parentId: null, size: 200 * 1024 * 1024,
      ossKey: 'demo/a', owner: uid, mime: 'application/octet-stream' });
    tree.addFile(s, { name: 'b.bin', parentId: null, size: 120 * 1024 * 1024,
      ossKey: 'demo/b', owner: uid, mime: 'application/octet-stream' });
  });
  void me;

  edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${CPORT}`, `--user-data-dir=${path.join(TMP, 'p')}`,
    '--window-size=1200,900', `http://127.0.0.1:${SPORT}/`], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 40; i++) {
    try { const ts = await getJson('/json/list'); page = ts.find(t => t.type === 'page' && t.url.includes(String(SPORT))); if (page) break; } catch (_) {}
    await wait(500);
  }
  if (!page) { console.log('  !! 浏览器没打开'); await cleanup(); srv.close(); process.exit(1); }

  ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map(); let id = 0;
  ws.addEventListener('message', ev => {
    const x = JSON.parse(ev.data);
    if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
  });
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  const send = (m, p) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const js = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return 'ERR:' + r.result.exceptionDetails.text;
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await wait(1500);
  const okLogin = await js(`(async () => {
    const r = await fetch('/api/auth', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ username:'plain', password:'pw-plain-123' }) });
    const d = await r.json();
    if (!d.token) return 'FAIL:' + JSON.stringify(d);
    S.token = d.token;
    sessionStorage.setItem('sunlight.token', d.token);
    $('gate').style.display = 'none';
    $('app').style.display = 'block';
    await boot();
    return 'ok';
  })()`);
  ck('登录', okLogin, 'ok');
  await wait(1200);

  console.log('\n== 1. 菜单里有用量条 ==');
  await js(`(() => { openAccountMenu($('avaTop')); return 'ok'; })()`);
  await wait(1400);

  const q = await js(`(() => {
    const box = document.querySelector('.menu-quota');
    if (!box) return JSON.stringify({ missing: true });
    const bar = box.querySelector('.qbar i');
    return JSON.stringify({
      text: box.textContent.replace(/\\s+/g, ' ').trim(),
      hasBar: !!bar,
      barW: bar ? parseFloat(bar.style.width) : null,
      cls: box.className
    });
  })()`);
  const info = JSON.parse(q);
  console.log('    ' + JSON.stringify(info));
  ckTrue('出现了 .menu-quota', !info.missing, info);
  ckTrue('有进度条', info.hasBar, info);

  console.log('\n== 2. 数字与接口一致（不是占位）==');
  const api = await js(`(async () => {
    const d = await (await fetch('/api/account', { headers:{Authorization:'Bearer '+S.token} })).json();
    return JSON.stringify(d.storage);
  })()`);
  const st = JSON.parse(api);
  ck('接口算出已用 320MB', st.usedBytes, SEED);
  ck('接口下发配额 1GB', st.quotaBytes, GB);
  ckTrue('界面里显示了 320.0 MB', /320\.0 MB/.test(info.text), info.text);
  ckTrue('界面里显示了总额 1.00 GB', /1\.00 GB/.test(info.text), info.text);
  ckTrue('进度条约 31%', Math.abs((info.barW || 0) - 31.25) < 1.5, 'barW=' + info.barW);

  console.log('\n== 3. 接近满时换警示色 ==');
  /* 再加 560MB → 880MB / 1GB = 86% */
  await js(`(async () => {
    const d = await (await fetch('/api/account', { headers:{Authorization:'Bearer '+S.token} })).json();
    void d; return 'ok';
  })()`);
  const store2 = require('../lib/store');
  await store2.mutate(s => tree.addFile(s, { name: 'c.bin', parentId: null,
    size: 560 * 1024 * 1024, ossKey: 'demo/c', owner: uid, mime: 'application/octet-stream' }));
  /* 重开菜单触发刷新 */
  await js(`(() => { closeMenu && closeMenu(); openAccountMenu($('avaTop')); return 'ok'; })()`);
  await wait(1600);
  const q2 = await js(`(() => {
    const box = document.querySelector('.menu-quota');
    return JSON.stringify({ cls: box ? box.className : '', text: box ? box.textContent.replace(/\\s+/g,' ').trim() : '' });
  })()`);
  const info2 = JSON.parse(q2);
  console.log('    ' + JSON.stringify(info2));
  ckTrue('86% 时带 warn 类', /\bwarn\b/.test(info2.cls), info2.cls);
  ckTrue('界面显示已用 880.0 MB', /880\.0 MB/.test(info2.text), info2.text);

  console.log('\n== 4. 不撑破菜单 ==');
  const of = await js(`(() => {
    const box = document.querySelector('.menu-quota');
    const menu = document.querySelector('.menu.acct');
    if (!box || !menu) return JSON.stringify({ missing: true });
    return JSON.stringify({
      boxScroll: box.scrollWidth, boxClient: box.clientWidth,
      menuScroll: menu.scrollWidth, menuClient: menu.clientWidth
    });
  })()`);
  const ov = JSON.parse(of);
  console.log('    ' + JSON.stringify(ov));
  ckTrue('用量条内容不溢出', ov.boxScroll <= ov.boxClient + 1, ov);
  ckTrue('菜单本身不溢出', ov.menuScroll <= ov.menuClient + 1, ov);

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
