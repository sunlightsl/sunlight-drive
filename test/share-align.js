/**
 * 列表列对齐回归：表头与每行内容的右边缘必须一致。
 *
 * 这一条是被真实问题逼出来的：操作列原来用 auto，宽度随内容变
 * （有「预览」按钮的行 124px，没有的 59px），整张表左右抖，
 * 表头的「大小 / 操作」和下面的数值、按钮对不齐。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sunlight-al-'));
Object.assign(process.env, {
  DRIVE_DATA_DIR: TMP, SITE_PASSWORD: 'al-pass', ADMIN_USERNAME: 'boss',
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

const CPORT = 9406;
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
  /* 故意做两行**操作列内容长度不同**的：一行有预览+下载，一行只有下载。
     操作列用 auto 时，正是这两行把列宽撑成 124 / 59。 */
  const built = await store.mutate(s => {
    const a = tree.addFile(s, { name: '1-3s.mp4', parentId: null, size: 5.3 * 1024 * 1024, ossKey: 'k1', owner: boss.id });
    const b = tree.addFile(s, { name: 'AccessDatabaseEngine.exe', parentId: null, size: 25.4 * 1024 * 1024, ossKey: 'k2', owner: boss.id });
    const c = tree.addFile(s, { name: 'OneDrive 入门.pdf', parentId: null, size: 1.2 * 1024 * 1024, ossKey: 'k3', owner: boss.id });
    return { a: a.id, b: b.id, c: c.id };
  });
  const tok = await store.mutate(s => {
    const t = 's_' + require('crypto').randomBytes(12).toString('hex');
    s.shares[t] = {
      token: t, owner: boss.id, createdAt: Date.now(), hits: 0,
      items: [{ id: built.a, name: '1-3s.mp4', type: 'file' },
              { id: built.b, name: 'AccessDatabaseEngine.exe', type: 'file' },
              { id: built.c, name: 'OneDrive 入门.pdf', type: 'file' }],
      pwHash: require('../lib/auth').hashSharePassword('alpw')
    };
    return t;
  });

  edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${CPORT}`, `--user-data-dir=${path.join(TMP, 'p')}`,
    '--window-size=1200,900', `http://127.0.0.1:${SPORT}/s/${tok}`], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 40; i++) {
    try { const ts = await getJson('/json/list'); page = ts.find(t => t.type === 'page' && t.url.includes(tok)); if (page) break; } catch (_) {}
    await wait(500);
  }
  if (!page) { console.log('  !! 浏览器没打开页面'); await cleanup(); srv.close(); process.exit(1); }

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

  await wait(1200);
  await js(`(() => { $('pw').value='alpw'; submitPassword(); return 'ok'; })()`);
  await wait(2200);

  const geom = () => js(`(() => {
    const head = [...document.querySelectorAll('.lhead > span')].map(c => c.getBoundingClientRect().right);
    const rows = [...document.querySelectorAll('.list .row')].map(r =>
      [...r.children].map(c => c.getBoundingClientRect().right));
    return JSON.stringify({ head, rows });
  })()`);

  console.log('\n== 1. 操作列宽度不随内容变（auto → minmax 的回归）==');
  const trackW = await js(`JSON.stringify([...document.querySelectorAll('.list .row')].map(r => Math.round(r.lastElementChild.getBoundingClientRect().width)))`);
  const widths = JSON.parse(trackW);
  ckTrue('每行的操作列占位一致', new Set(widths).size === 1, trackW);

  console.log('\n== 2. 「大小」列：表头与各行的右边缘对齐 ==');
  const g = JSON.parse(await geom());
  const sizeHeadRight = Math.round(g.head[2]);
  const sizeRowRights = g.rows.map(r => Math.round(r[2]));
  ckTrue('三行的数值右边缘完全相同', new Set(sizeRowRights).size === 1, JSON.stringify(sizeRowRights));
  ckTrue('表头「大小」与数值右对齐（12px 列间距）',
    Math.abs(sizeHeadRight - sizeRowRights[0]) <= 12,
    `head=${sizeHeadRight} rows=${JSON.stringify(sizeRowRights)}`);

  console.log('\n== 3. 「操作」列：表头与各行的右边缘对齐 ==');
  const actHeadRight = Math.round(g.head[3]);
  const actRowRights = g.rows.map(r => Math.round(r[3]));
  ckTrue('三行的操作列右边缘完全相同', new Set(actRowRights).size === 1, JSON.stringify(actRowRights));
  ckTrue('表头「操作」与按钮右边缘对齐',
    Math.abs(actHeadRight - actRowRights[0]) <= 2,
    `head=${actHeadRight} rows=${JSON.stringify(actRowRights)}`);

  console.log('\n== 4. 窄屏不溢出（不出现横向滚动）==');
  for (const w of [1024, 768, 600, 480, 390, 360]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 1, mobile: false });
    await wait(450);
    const overflow = await js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    const hidden = await js(`getComputedStyle(document.querySelector('.list .fsize') || document.createElement('span')).display`);
    ckTrue(w + 'px 无横向溢出（大小列 ' + (hidden === 'none' ? '已隐藏' : '保留') + '）', overflow <= 0, 'overflow=' + overflow);
  }
  await send('Emulation.clearDeviceMetricsOverride', {});
  await wait(400);

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
