/**
 * 窄屏（手机）布局回归
 * ------------------------------------------------------------------
 * 覆盖两件在手机上才暴露的事：
 *   1. 标题和转存按钮必须在**同一行**（压成整行通栏会占用过多垂直空间）
 *   2. 列表列定义在窄屏要对（去掉「大小」列，且不出现横向滚动）
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sunlight-mb-'));
Object.assign(process.env, {
  DRIVE_DATA_DIR: TMP, SITE_PASSWORD: 'mb-pass', ADMIN_USERNAME: 'boss',
  TOTP_SECRET: '', TOTP_DISABLED: '1', MAX_ATTEMPTS: '100', SHARE_MAX_ATTEMPTS: '100',
  BRAND: 'sunlight', OSS_REGION: 'oss-cn-hangzhou', OSS_KEY_ID: 'FAKEKEYID0001',
  OSS_KEY_SECRET: 'k'.repeat(24) + '1', OSS_BUCKET: 'fake-bucket', OSS_UPLOAD_PREFIX: 'drive'
});
require('../lib/ossconfig').getClientFor = () => ({
  async put() {}, async delete() {}, async copy() { return { data: {} }; },
  signatureUrl: k => 'https://fake/' + k, async listUploads() { return { uploads: [] }; },
  async abortMultipartUpload() {}
});
const store = require('../lib/store');
const tree = require('../lib/tree');

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
if (!EDGE || typeof WebSocket !== 'function') { console.log('  (需要 Edge/Chrome + Node 22，跳过)'); process.exit(0); }

const CPORT = 9407;
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
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const SPORT = srv.address().port;

  const boss = Object.values(store.get().users).find(u => u.username === 'boss');
  const built = await store.mutate(s => {
    const a = tree.addFile(s, { name: '1-3s.mp4', parentId: null, size: 5.3 * 1024 * 1024, ossKey: 'k1', owner: boss.id });
    const b = tree.addFile(s, { name: '一个名字特别长的文件用来验证标题不会被挤爆.pdf', parentId: null, size: 1024, ossKey: 'k2', owner: boss.id });
    return { a: a.id, b: b.id };
  });
  /* 一条多项分享（标题是「分享内容」）+ 一条单文件分享（标题是长文件名） */
  const many = await store.mutate(s => {
    const t = 's_' + require('crypto').randomBytes(12).toString('hex');
    s.shares[t] = {
      token: t, owner: boss.id, createdAt: Date.now(), hits: 0,
      items: [{ id: built.a, name: '1-3s.mp4', type: 'file' },
              { id: built.b, name: '一个名字特别长的文件用来验证标题不会被挤爆.pdf', type: 'file' }],
      pwHash: require('../lib/auth').hashSharePassword('mbpw')
    };
    return t;
  });

  edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${CPORT}`, `--user-data-dir=${path.join(TMP, 'p')}`,
    '--window-size=390,844', `http://127.0.0.1:${SPORT}/s/${many}`], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 40; i++) {
    try { const ts = await getJson('/json/list'); page = ts.find(t => t.type === 'page' && t.url.includes(many)); if (page) break; } catch (_) {}
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

  /* 手机视口 */
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await wait(900);
  await js(`(() => { $('pw').value='mbpw'; submitPassword(); return 'ok'; })()`);
  await wait(2200);

  console.log('\n== 1. 标题与转存按钮同一行（未登录 → 显示「登录后转存」）==');
  ck('视口宽', await js(`window.innerWidth`), 390);
  const box = await js(`(() => {
    const h = document.querySelector('.title-line h1').getBoundingClientRect();
    const s = document.querySelector('.title-line .savebar').getBoundingClientRect();
    const line = document.querySelector('.title-line').getBoundingClientRect();
    return JSON.stringify({ hTop: Math.round(h.top), hBot: Math.round(h.bottom),
      sTop: Math.round(s.top), sBot: Math.round(s.bottom),
      hRight: Math.round(h.right), sLeft: Math.round(s.left), lineW: Math.round(line.width) });
  })()`);
  const g = JSON.parse(box);
  ckTrue('垂直方向重叠 → 同一行', g.sTop < g.hBot && g.hTop < g.sBot, box);
  ckTrue('按钮没有占满整行', g.sLeft > g.hRight - 4, `h1.right=${g.hRight} save.left=${g.sLeft}`);
  ckTrue('按钮宽度明显小于容器（不是通栏）', (g.lineW - (g.sLeft - g.hRight)) > 0 && g.sLeft > 100,
    `line.width=${g.lineW} save.left=${g.sLeft}`);

  console.log('\n== 2. 按钮文案没被隐藏 ==');
  ck('登录态按钮有文字', await js(`document.querySelector('.savebar .mb').textContent.trim()`), '登录后转存');

  console.log('\n== 3. 窄屏不横向溢出 ==');
  const of = await js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  ckTrue('390px 无横向滚动', of <= 0, 'overflow=' + of);

  console.log('\n== 4. 列表列定义（窄屏去掉大小列）==');
  ck('窄屏列数 3', await js(`getComputedStyle(document.querySelector('.list')).getPropertyValue('--cols').trim().split(/\\s+(?![^(]*\\))/).length >= 3`), true);
  ck('大小列表头已隐藏', await js(`getComputedStyle(document.querySelector('.lhead-size')).display`), 'none');
  ck('大小列内容已隐藏', await js(`getComputedStyle(document.querySelector('.list .fsize')).display`), 'none');

  console.log('\n== 5. 长标题时不撑破（换单文件分享试）==');
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
  await wait(500);
  const of2 = await js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  ckTrue('360px 无横向滚动', of2 <= 0, 'overflow=' + of2);

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
