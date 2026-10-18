/**
 * 配额与用量的行为
 * ------------------------------------------------------------------
 * 三件容易改坏的事：
 *
 *   1. 用户自己能看见额度。站长在后台设的 1GB，普通用户也要看得到 ——
 *      否则"传不上去"变成猜谜。这条钉住 /api/account 的 storage 字段。
 *
 *   2. 一次上传超过剩余额度，在**签发凭证之前**就被拒（413），
 *      不能等字节传完了再说。
 *
 *   3. 两条能绕过的路必须堵死：
 *      · 并发：三个 600MB 同时申请、各自通过、合并后超 1GB
 *      · 伪造：声明 10MB、实传 1.8GB，落树时不复核
 *
 * 全部在隔离实例上跑，假 OSS，不碰真实数据。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quotatest-'));
Object.assign(process.env, {
  DRIVE_DATA_DIR: TMP, SITE_PASSWORD: 'qt-pass-123', ADMIN_USERNAME: 'boss',
  TOTP_SECRET: '', TOTP_DISABLED: '1', REGISTRATION: 'open', BRAND: 'qt',
  OSS_REGION: 'oss-cn-hangzhou', OSS_KEY_ID: 'FAKEKEYID0001',
  OSS_KEY_SECRET: 'k'.repeat(24) + '1', OSS_BUCKET: 'fake-bucket',
  OSS_UPLOAD_PREFIX: 'drive', QUOTA_GB: '1'
});

const GB = 1073741824;
const MB = 1048576;

/* 假 OSS：objects 记录"浏览器直传上去的对象"，head 返回它的真实大小 */
const objects = new Map();
require('../lib/ossconfig').getClientFor = () => ({
  async putStream() {}, async put() {}, async delete(k) { objects.delete(k); return {}; },
  async copy() { return { data: {} }; },
  signatureUrl: k => 'https://example.invalid/' + k,
  async listUploads() { return { uploads: [] }; },
  async abortMultipartUpload() {},
  async initMultipartUpload() { return { res: { headers: {} }, uploadId: 'up-1' }; },
  async completeMultipartUpload() { return { data: {} }; },
  async listParts() { return { parts: [] }; },
  async head(key) {
    const n = objects.get(key);
    if (n === undefined) { const e = new Error('not found'); e.code = 'NoSuchKey'; throw e; }
    return { res: { headers: { 'content-length': String(n) } } };
  }
});

const req = (port, method, p, { token, body } = {}) => new Promise(resolve => {
  const data = body === undefined ? null : JSON.stringify(body);
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, body: j, raw: d }); });
  });
  r.on('error', e => resolve({ status: 0, err: e.message }));
  if (data) r.write(data);
  r.end();
});

let pass = 0, fail = 0;
const ck = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : ' FAIL '} ${label}${ok ? '' : `   got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const ckTrue = (label, cond, detail) => ck(label + (cond || !detail ? '' : '   ' + JSON.stringify(detail).slice(0, 160)), !!cond, true);

(async () => {
  const app = require('../server.js');
  await app.bootstrap();
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const P = srv.address().port;

  await req(P, 'POST', '/api/auth', { body: { username: 'boss', password: 'qt-pass-123' } });
  const reg = await req(P, 'POST', '/api/signup', { body: { username: 'kim', password: 'kim-pass-123' } });
  const tok = reg.body && reg.body.token;
  if (!tok) { console.log('  建号失败：' + reg.raw); process.exit(1); }

  /* ---------- 1. 用户能看到自己的额度 ---------- */
  console.log('\n== 1. 普通用户能看到额度与用量 ==');
  const acct = await req(P, 'GET', '/api/account', { token: tok });
  const st = acct.body && acct.body.storage;
  ckTrue('account 里带 storage', !!st, acct.body);
  ck('下发的是**实际生效**的配额，不是 null', st && st.quotaBytes, GB);
  ck('已用为 0', st && st.usedBytes, 0);
  ck('未绑自有存储', st && st.storageBound, false);
  ck('在途为 0', st && st.pendingBytes, 0);

  /* ---------- 2. 一次超过剩余额度：立刻拒 ---------- */
  console.log('\n== 2. 一次上传超过额度（声明 2GB / 配额 1GB）==');
  const big = await req(P, 'POST', '/api/upload/policy', {
    token: tok, body: { parent: null, name: 'big.bin', size: 2 * GB }
  });
  ck('被拒', big.status, 413);
  ckTrue('错误里带上额度与用量', /空间不足/.test((big.body && big.body.error) || ''), big.body);

  /* ---------- 3. 并发不能超卖 ---------- */
  console.log('\n== 3. 并发：额度 1GB，同时申请 3 个 600MB ==');
  const one = await req(P, 'POST', '/api/upload/policy', {
    token: tok, body: { parent: null, name: 'a.bin', size: 600 * MB }
  });
  ck('第一个通过', one.status, 200);
  const two = await req(P, 'POST', '/api/upload/policy', {
    token: tok, body: { parent: null, name: 'b.bin', size: 600 * MB }
  });
  ck('第二个被在途额度挡住', two.status, 413);
  const three = await req(P, 'POST', '/api/upload/policy', {
    token: tok, body: { parent: null, name: 'c.bin', size: 600 * MB }
  });
  ck('第三个同样被挡', three.status, 413);

  /* 放弃之后额度要还回来 */
  console.log('\n== 4. 放弃上传后额度回到可用 ==');
  const acct2 = await req(P, 'GET', '/api/account', { token: tok });
  ck('在途占着 600MB', acct2.body.storage.pendingBytes, 600 * MB);

  const srvMod = require('../server.js');
  ckTrue('模块暴露了清理函数与内部状态',
    typeof srvMod.sweepQuotaReservations === 'function' && !!srvMod._quotaInternals);

  /* 直传会话没有单独的 abort 接口，靠 TTL 超时回收。
     这里把预留时间往前拨两小时，等价于"一小时后"再扫。 */
  for (const info of srvMod._quotaInternals.directUploads.values()) {
    info.reservedAt = Date.now() - 2 * 3600 * 1000;
  }
  srvMod.sweepQuotaReservations();
  const acct2b = await req(P, 'GET', '/api/account', { token: tok });
  ck('超时后额度已释放', acct2b.body.storage.pendingBytes, 0);

  const retry = await req(P, 'POST', '/api/upload/policy', {
    token: tok, body: { parent: null, name: 'again.bin', size: 600 * MB }
  });
  ck('释放之后可以重新申请', retry.status, 200);

  /* ---------- 5. 伪造大小：complete 按实际大小复核 ---------- */
  console.log('\n== 5. 声明 10MB、实传 1.8GB ==');
  /* 换一个干净的账号，避开上面占着的额度 */
  const reg2 = await req(P, 'POST', '/api/signup', { body: { username: 'lee', password: 'lee-pass-123' } });
  const tok2 = reg2.body && reg2.body.token;
  const pol = await req(P, 'POST', '/api/upload/policy', {
    token: tok2, body: { parent: null, name: 'lie.bin', size: 10 * MB }
  });
  ck('声明 10MB 时签发通过', pol.status, 200);
  objects.set(pol.body.fields.key, Math.round(1.8 * GB));   // 实际传了 1.8GB
  const done = await req(P, 'POST', '/api/upload/complete', {
    token: tok2, body: { uploadId: pol.body.uploadId, mime: 'application/octet-stream' }
  });
  ck('落树时被拒', done.status, 413);
  ckTrue('报的是空间不足', /空间不足/.test((done.body && done.body.error) || ''), done.body);
  ck('对象已被删掉（不留桶里有、树里没有的垃圾）', objects.has(pol.body.fields.key), false);
  const acct3 = await req(P, 'GET', '/api/account', { token: tok2 });
  ck('用量没有被记上', acct3.body.storage.usedBytes, 0);

  /* ---------- 6. 正常大小仍然能传 ---------- */
  console.log('\n== 6. 额度内正常上传仍然成功 ==');
  const okPol = await req(P, 'POST', '/api/upload/policy', {
    token: tok2, body: { parent: null, name: 'good.bin', size: 100 * MB }
  });
  ck('签发通过', okPol.status, 200);
  objects.set(okPol.body.fields.key, 100 * MB);
  const okDone = await req(P, 'POST', '/api/upload/complete', {
    token: tok2, body: { uploadId: okPol.body.uploadId, mime: 'application/octet-stream' }
  });
  ck('落树成功', okDone.status, 200);
  const acct4 = await req(P, 'GET', '/api/account', { token: tok2 });
  ck('用量更新为 100MB', acct4.body.storage.usedBytes, 100 * MB);
  ck('在途额度已释放', acct4.body.storage.pendingBytes, 0);

  /* ---------- 7. 绑自有存储的人不受平台配额约束 ---------- */
  console.log('\n== 7. 绑了自己的桶 → 不限额 ==');
  const store = require('../lib/store');
  const owner = Object.values(store.get().users).find(u => u.username === 'kim');
  require('../lib/ossconfig').setEntry(owner.id, {
    region: 'oss-cn-hangzhou', bucket: 'own-bucket', keyId: 'FAKEKEYID0002',
    keySecret: 'k'.repeat(24) + '2', prefix: 'drive'
  });
  const acct5 = await req(P, 'GET', '/api/account', { token: tok });
  ck('storageBound = true', acct5.body.storage.storageBound, true);
  ck('quotaBytes = null（不限额）', acct5.body.storage.quotaBytes, null);

  srv.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log('\n====================================================');
  console.log(`\x1b[${fail ? '31' : '32'}m通过 ${pass} 项，失败 ${fail} 项\x1b[0m`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
