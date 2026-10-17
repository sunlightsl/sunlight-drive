/**
 * 首次部署：谁会成为站长
 * ------------------------------------------------------------------
 * 自托管场景里这是最要紧的一条 —— 装完之后得有人能管起来。
 * 钉住四种组合，因为**其中两种会把站点锁死**：
 *
 *   A. 没配 SITE_PASSWORD + 注册开放  → 第一个注册的人成为站长
 *   B. 配了 SITE_PASSWORD            → bootstrap 建出站长，之后注册的都是普通成员
 *   C. 配了 SITE_PASSWORD + 注册关闭  → 只有站长，注册被拒（正常）
 *   D. 没配 SITE_PASSWORD + 注册关闭  → 一个账号都没有，没人能登录（**自锁**）
 *
 * 每种组合各起一个子进程：store 是模块级单例，同进程内跑多轮会把上一轮的
 * 数据带进来（我第一版就栽在这上面，读到了真实数据）。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/* 子进程里跑的那段：起服务 → 注册两次 → 报告结果 */
const CLIENT = `
const http = require('http');
const raw = (P, p, opt) => new Promise((res, rej) => {
  const { method = 'GET', body, headers = {} } = opt || {};
  const d = body === undefined ? null : Buffer.from(body);
  const h = Object.assign({ Accept: '*/*' }, headers);
  if (d && !h['Content-Type']) h['Content-Type'] = 'application/json';
  if (d) h['Content-Length'] = d.length;
  const r = http.request({ host: '127.0.0.1', port: P, path: p, method, headers: h }, rs => {
    let o = ''; rs.on('data', c => o += c); rs.on('end', () => res({ status: rs.statusCode, body: o }));
  });
  r.on('error', rej); if (d) r.write(d); r.end();
});

(async () => {
  const app = require(process.env.APP);
  const boot = await app.bootstrap();
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const P = srv.address().port;
  const store = require(process.env.STORE);
  const users = require(process.env.USERS);

  const out = { before: users.list(store.get()).length, reg1: null, adm1: null, reg2: null, adm2: null, accounts: [] };

  const r1 = await raw(P, '/api/signup', { method: 'POST', body: JSON.stringify({ username: 'alice', password: 'pw-alice-123' }) });
  out.reg1 = r1.status;
  if (r1.status === 200) {
    const t = JSON.parse(r1.body).token;
    out.adm1 = (await raw(P, '/api/admin/users', { headers: { Authorization: 'Bearer ' + t } })).status;
  }
  const r2 = await raw(P, '/api/signup', { method: 'POST', body: JSON.stringify({ username: 'bob', password: 'pw-bob-123' }) });
  out.reg2 = r2.status;
  if (r2.status === 200) {
    const t = JSON.parse(r2.body).token;
    out.adm2 = (await raw(P, '/api/admin/users', { headers: { Authorization: 'Bearer ' + t } })).status;
  }
  out.accounts = users.list(store.get()).map(u => ({ name: u.username, role: u.role, plan: u.plan }));
  srv.close();
  process.stdout.write('@@' + JSON.stringify(out) + '@@');
  process.exit(0);
})().catch(e => { process.stderr.write('ERR ' + e.message); process.exit(1); });
`;

let pass = 0, fail = 0;
const ck = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : ' FAIL '} ${label}${ok ? '' : `   got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

function scenario(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunlight-own-'));
  const client = path.join(dir, '_c.js');
  fs.writeFileSync(client, CLIENT);
  const full = Object.assign({}, process.env, {
    DRIVE_DATA_DIR: dir,
    APP: path.join(ROOT, 'server.js'),
    STORE: path.join(ROOT, 'lib', 'store.js'),
    USERS: path.join(ROOT, 'lib', 'users.js'),
    SITE_PASSWORD: '', REGISTRATION: 'open', ADMIN_USERNAME: 'boss',
    TOTP_SECRET: '', TOTP_DISABLED: '1', BRAND: 'testbrand',
    OSS_REGION: 'oss-cn-hangzhou', OSS_KEY_ID: 'FAKEKEYID0001',
    OSS_KEY_SECRET: 'k'.repeat(24) + '1', OSS_BUCKET: 'fake-bucket', OSS_UPLOAD_PREFIX: 'drive'
  }, env);
  try {
    const out = execFileSync(process.execPath, [client], { env: full, encoding: 'utf8', stdio: 'pipe' });
    const m = out.match(/@@(.*)@@/s);
    if (!m) throw new Error('子进程没有输出结果: ' + out.slice(-300));
    return JSON.parse(m[1]);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

(async () => {
  console.log('\n== A. 没配 SITE_PASSWORD + 注册开放 ==');
  {
    const r = scenario({});
    const by = n => r.accounts.find(a => a.name === n) || {};
    ck('启动时 0 个账号', r.before, 0);
    ck('第一个注册成功', r.reg1, 200);
    ck('第一个注册的人 role = owner', by('alice').role, 'owner');
    ck('owner 的 plan = pro', by('alice').plan, 'pro');
    ck('owner 能进用户管理', r.adm1, 200);
    ck('第二个人注册成功', r.reg2, 200);
    ck('第二个人 role = member', by('bob').role, 'member');
    ck('第二个人 plan = free', by('bob').plan, 'free');
    ck('第二个人进不了用户管理', r.adm2, 403);
  }

  console.log('\n== B. 配了 SITE_PASSWORD ==');
  {
    const r = scenario({ SITE_PASSWORD: 'boot-pass-123' });
    const by = n => r.accounts.find(a => a.name === n) || {};
    ck('启动时已有 1 个账号', r.before, 1);
    ck('bootstrap 的是 owner', by('boss').role, 'owner');
    ck('bootstrap 的 plan = pro', by('boss').plan, 'pro');
    ck('之后注册的仍是 member', by('alice').role, 'member');
    ck('之后注册的人进不了用户管理', r.adm1, 403);
  }

  console.log('\n== C. 配了 SITE_PASSWORD + 注册关闭 ==');
  {
    const r = scenario({ SITE_PASSWORD: 'boot-pass-123', REGISTRATION: 'closed' });
    ck('注册被拒 403', r.reg1, 403);
    ck('只有 bootstrap 那一个账号', r.before, 1);
  }

  console.log('\n== D. 没配 SITE_PASSWORD + 注册关闭（会自锁）==');
  {
    const r = scenario({ REGISTRATION: 'closed' });
    ck('一个账号都没有', r.before, 0);
    ck('注册被拒 403', r.reg1, 403);
    console.log('     → 这种组合装完没人能进，README 已明确警告');
  }

  console.log('\n====================================================');
  console.log(`\x1b[${fail ? '31' : '32'}m通过 ${pass} 项，失败 ${fail} 项\x1b[0m`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试本身崩了: ' + (e && e.stack ? e.stack : e.message)); process.exit(1); });
