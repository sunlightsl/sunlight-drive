/**
 * 兜底错误处理的回归测试
 * ------------------------------------------------------------------
 * 钉住一个高危问题（P1）：
 * 畸形 JSON 会让 Express 默认错误页把**完整调用栈**渲染成 HTML 返回，
 * 泄露部署绝对路径、技术栈、依赖版本线索。
 *
 * 这里不只验"不回显堆栈"，还验三件容易改坏的事：
 *   1. 正常错误（404/401/业务 400）保持既有 JSON 结构，没被兜底中间件吞掉
 *   2. 413（请求体过大）仍是 413，不是 500
 *   3. X-Request-Id 下发且和日志里的对得上
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sunlight-err-'));
Object.assign(process.env, {
  DRIVE_DATA_DIR: TMP, SITE_PASSWORD: 'err-pass-123', ADMIN_USERNAME: 'boss',
  TOTP_SECRET: '', TOTP_DISABLED: '1',
  BRAND: 'sunlight', OSS_REGION: 'oss-cn-hangzhou',
  OSS_KEY_ID: 'FAKEKEYID0001', OSS_KEY_SECRET: 'k'.repeat(24) + '1',
  OSS_BUCKET: 'fake-bucket', OSS_UPLOAD_PREFIX: 'drive'
});
require('../lib/ossconfig').getClientFor = () => ({
  async put() {}, async delete() {}, async copy() { return { data: {} }; },
  signatureUrl: k => 'https://fake/' + k, async listUploads() { return { uploads: [] }; },
  async abortMultipartUpload() {}
});

const raw = (port, p, { method = 'GET', body, headers = {} } = {}) => new Promise((res, rej) => {
  const data = body === undefined ? null : (Buffer.isBuffer(body) ? body : Buffer.from(body));
  const h = Object.assign({ Accept: '*/*' }, headers);
  if (data && !h['Content-Type']) h['Content-Type'] = 'application/json';
  if (data) h['Content-Length'] = data.length;
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, rs => {
    let d = ''; rs.on('data', c => d += c);
    rs.on('end', () => res({ status: rs.statusCode, body: d, headers: rs.headers }));
  });
  r.on('error', rej); if (data) r.write(data); r.end();
});

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

(async () => {
  /* 把 console.error 收集起来，验日志里确实留了完整信息 */
  const errLines = [];
  const realErr = console.error;
  console.error = (...a) => { errLines.push(a.join(' ')); realErr(...a); };

  const app = require('../server.js');
  await app.bootstrap();
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const P = srv.address().port;

  console.log('\n== 1. 畸形 JSON 不再回显堆栈（P1 修复）==');
  const bad = await raw(P, '/api/auth', { method: 'POST', body: '{bad' });
  ck('状态码 400', bad.status, 400);
  ckTrue('回的是 JSON 不是 HTML', /application\/json/.test(bad.headers['content-type'] || ''), bad.headers['content-type']);
  const leaked = /at\s+\S+\s*\(|node_modules|body-parser|SyntaxError|\.js:\d+:\d+/.test(bad.body);
  ckTrue('正文里没有堆栈/路径/依赖名', !leaked, bad.body.slice(0, 200));
  let j = null; try { j = JSON.parse(bad.body); } catch (_) {}
  ck('是统一的 {ok:false,error}', j && j.ok, false);
  ckTrue('错误文案是通用的一句', j && /请求格式错误/.test(j.error), j && j.error);

  console.log('\n== 2. 各种畸形体都被挡住（不能只挡一种）==');
  const cases = [
    ['截断的对象', '{bad'],
    ['单引号 JSON', "{'a':1}"],
    ['裸字符串', '"just a string"'],
    ['非法 UTF-8 序列', Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0xfe, 0x7d])]
  ];
  for (const [label, body] of cases) {
    const r = await raw(P, '/api/auth', { method: 'POST', body });
    const bad2 = /at\s+\S+\s*\(|node_modules|body-parser|SyntaxError/.test(r.body);
    ckTrue(label + ' → ' + r.status + '，无堆栈', r.status >= 400 && r.status < 500 && !bad2, r.body.slice(0, 120));
  }

  console.log('\n== 3. 请求体过大仍是 413，不是 500 ==');
  const big = JSON.stringify({ username: 'x'.repeat(200000), password: 'y'.repeat(200000) });
  const r413 = await raw(P, '/api/auth', { method: 'POST', body: big });
  ck('413 而不是 500', r413.status, 413);
  ckTrue('413 也是 JSON', /application\/json/.test(r413.headers['content-type'] || ''));
  ckTrue('413 无堆栈', !/at\s+\S+\s*\(|node_modules/.test(r413.body), r413.body.slice(0, 120));

  console.log('\n== 4. 正常路由的错误没被兜底中间件吞掉 ==');
  const notFound = await raw(P, '/api/definitely-not-a-route', { method: 'POST', body: '{}' });
  ckTrue('未知 POST 路由仍走原逻辑（不是 500）', notFound.status !== 500, notFound.status);
  const noAuth = await raw(P, '/api/shares');
  ck('未认证仍是 401', noAuth.status, 401);
  ck('401 仍是统一 JSON', JSON.parse(noAuth.body).ok, false);
  const badLogin = await raw(P, '/api/auth', { method: 'POST', body: JSON.stringify({ username: 'nobody', password: 'wrong' }) });
  ck('登录失败仍是 401', badLogin.status, 401);
  ckTrue('登录失败文案没变（不提"服务器内部错误"）',
    /用户名或密码不正确/.test(badLogin.body), badLogin.body.slice(0, 120));

  console.log('\n== 5. 业务 404 的文案没被覆盖 ==');
  const signup = await raw(P, '/api/signup', { method: 'POST', body: JSON.stringify({ username: 'errtest' + Date.now().toString().slice(-5), password: 'pw-err-123' }) });
  const tok = JSON.parse(signup.body).token;
  const delMissing = await raw(P, '/api/delete', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: JSON.stringify({ ids: ['n_nope'] }) });
  ckTrue('删除不存在的节点仍是业务错误（不是"服务器内部错误"）',
    !/服务器内部错误/.test(delMissing.body), delMissing.body.slice(0, 160));

  console.log('\n== 6. X-Request-Id 下发，且和日志里的对得上 ==');
  const rid = await raw(P, '/api/shares');
  ckTrue('响应头带 X-Request-Id', !!rid.headers['x-request-id'], rid.headers['x-request-id']);
  ckTrue('是 8 位十六进制', /^[0-9a-f]{8}$/.test(rid.headers['x-request-id'] || ''), rid.headers['x-request-id']);

  const bad2 = await raw(P, '/api/auth', { method: 'POST', body: '{bad' });
  const rid2 = bad2.headers['x-request-id'];
  ckTrue('畸形请求也带 id', !!rid2, rid2);
  ckTrue('客户端拿到的 id 出现在服务端日志里（能对上）',
    errLines.some(l => l.includes(rid2)), errLines.filter(l => l.includes('[err]')).slice(-2).join(' | '));

  console.log('\n== 7. 服务端日志仍保留完整信息（排查不能瞎）==');
  ckTrue('日志里有 [err] 行', errLines.some(l => l.includes('[err]')), errLines.filter(l => l.includes('[err]')).slice(0, 1).join(''));

  console.log('\n====================================================');
  console.log(`\x1b[${fail ? '31' : '32'}m通过 ${pass} 项，失败 ${fail} 项\x1b[0m`);
  console.error = realErr;
  srv.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  await new Promise(r => setTimeout(r, 200));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试本身崩了: ' + (e && e.stack ? e.stack : e.message)); process.exit(1); });
