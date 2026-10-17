/**
 * 用户管理面板的配额控件布局
 * ------------------------------------------------------------------
 * 钉住一个已经出过的 bug：配额那一格的内容（输入框 + GB + 保存 + 来源标记）
 * 比固定的列宽还宽，于是 flex 把输入框压到 0 —— 界面上就是个空框，
 * 看着像"配额显示不出来"。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sunlight-uq-'));
Object.assign(process.env, {
  DRIVE_DATA_DIR: TMP, SITE_PASSWORD: 'uq-pass-123', ADMIN_USERNAME: 'boss',
  TOTP_SECRET: '', TOTP_DISABLED: '1', MAX_ATTEMPTS: '100', SHARE_MAX_ATTEMPTS: '100',
  BRAND: 'sunlight', OSS_REGION: 'oss-cn-hangzhou', OSS_KEY_ID: 'FAKEKEYID0001',
  OSS_KEY_SECRET: 'k'.repeat(24) + '1', OSS_BUCKET: 'fake-bucket', OSS_UPLOAD_PREFIX: 'drive',
  QUOTA_GB: '1'
});
require('../lib/ossconfig').getClientFor = () => ({
  async put() {}, async delete() {}, async copy() { return { data: {} }; },
  signatureUrl: k => 'https://fake/' + k, async listUploads() { return { uploads: [] }; },
  async abortMultipartUpload() {}
});
const store = require('../lib/store');
const users = require('../lib/users');

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
if (!EDGE || typeof WebSocket !== 'function') { console.log('  (需要 Edge/Chrome + Node 22，跳过)'); process.exit(0); }

const CPORT = 9408;
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
  /* 三种状态各一个：跟随默认 / 单独设置 / 明确不限 */
  const made = await store.mutate(async s => {
    const a = await users.create(s, { username: 'plain0', password: 'pw-plain-123' });
    const b = await users.create(s, { username: 'setto0', password: 'pw-setto-123' });
    const c = await users.create(s, { username: 'nolimt', password: 'pw-nolim-123' });
    users.setQuota(s, b, 5 * 1073741824);      // 单独设置 5GB
    users.setQuota(s, c, null);                // 明确不限
    return { a: a.id, b: b.id, c: c.id, boss: boss.id };
  });

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
  /* 登录（两步验证已关） */
  const okLogin = await js(`(async () => {
    const r = await fetch('/api/auth', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ username:'boss', password:'uq-pass-123' }) });
    const d = await r.json();
    if (!d.token) return 'FAIL:' + JSON.stringify(d);
    S.token = d.token;
    const me = await (await fetch('/api/account', { headers:{Authorization:'Bearer '+d.token} })).json();
    S.account = me.account;
    $('gate').style.display = 'none';
    return 'ok';
  })()`);
  ck('登录', okLogin, 'ok');

  await js(`(() => { openUsers(); return 'ok'; })()`);
  await wait(1800);

  console.log('\n== 1. 三种状态的配额控件都能完整显示 ==');
  const rows = await js(`(() => {
    return JSON.stringify([...document.querySelectorAll('.urow')].map(r => {
      const nick = (r.querySelector('.nick')||{}).textContent || '';
      const inp = r.querySelector('.uquota .input');
      const box = r.querySelector('.uquota');
      const why = (r.querySelector('.uq-why')||{}).textContent || '';
      if (!inp) return { nick, owner: true, why };
      const ir = inp.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      return {
        nick,
        value: inp.value,
        placeholder: inp.placeholder,
        why,
        inputW: Math.round(ir.width),
        boxW: Math.round(br.width),
        scrollW: box.scrollWidth,
        clientW: box.clientWidth
      };
    }));
  })()`);
  const list = JSON.parse(rows);
  for (const r of list) console.log('    ' + JSON.stringify(r));

  const withInput = list.filter(r => !r.owner);
  ckTrue('有输入框的行都存在', withInput.length >= 3, withInput.length);
  for (const r of withInput) {
    ckTrue(r.nick + ' 输入框宽度 ≥ 40px（没被压扁）', r.inputW >= 40, 'w=' + r.inputW);
    ckTrue(r.nick + ' 配额格没有内容溢出', r.scrollW <= r.clientW + 1,
      'scrollW=' + r.scrollW + ' clientW=' + r.clientW);
  }

  console.log('\n== 2. 两种来源标记正确（没有独立的"不限"状态）==');
  const byNick = {};
  for (const r of withInput) byNick[r.nick] = r;
  const find = kw => withInput.find(r => (r.nick || '').includes(kw));
  const rPlain = find('plain0'), rSet = find('setto0'), rNo = find('nolimt');
  ckTrue('跟随默认：placeholder 是默认值 1、标记「默认」',
    rPlain && rPlain.placeholder === '1' && rPlain.why === '默认',
    rPlain && JSON.stringify(rPlain));
  ckTrue('单独设置：值 5、标记「单独」', rSet && rSet.value === '5' && rSet.why === '单独',
    rSet && JSON.stringify(rSet));
  /* 清空输入框 = 取消单独设置、回到全站默认，**不是**"不限"。
     setQuota(null/0) 是 delete quotaBytes，之后仍按 QUOTA_GB 执行。
     所以这里必须显示「默认」，显示「不限」就是骗人。 */
  ckTrue('清空配额 → 回到「默认」（不是「不限」）',
    rNo && rNo.value === '' && rNo.why === '默认' && rNo.placeholder === '1',
    rNo && JSON.stringify(rNo));

  console.log('\n== 3. 窄屏也不撑破 ==');
  for (const w of [900, 700, 560]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 1, mobile: false });
    await wait(500);
    const of = await js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    ckTrue(w + 'px 无横向溢出', of <= 0, 'overflow=' + of);
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
