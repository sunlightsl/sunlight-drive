#!/usr/bin/env node
/**
 * 直传/分片/分享接口端到端检查（66 项）。
 * 运行方式：先起一个隔离实例（DRIVE_DATA_DIR=tmp/e2e-data PORT=3111 TOTP_DISABLED=1
 * ADMIN_USERNAME=sunlight SITE_PASSWORD=<pw> OSS_*=假凭证），凭证运行时生成
 * 写入 tmp/e2e-pw.txt 与 tmp/e2e-oss.json，然后 node test/direct-upload.js。
 * OSS 凭证为随机假值：policy/签名不需要网络；真实 OSS 调用预期 >=400。
 * OSS 凭证为运行时随机生成值（tmp/e2e-oss.json），不指向真实 bucket ——
 * policy 签发不需要网络；complete 依赖 head，预期 409。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'http://127.0.0.1:3111';
const PW = fs.readFileSync(path.join(__dirname, '..', 'tmp', 'e2e-pw.txt'), 'utf8').trim();
const OSS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tmp', 'e2e-oss.json'), 'utf8'));

let pass = 0, failN = 0;
const ck = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : failN++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

async function api(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, data: d };
}

(async () => {
  const login = await api('/api/auth', { method: 'POST', body: { username: 'sunlight', password: PW } });
  const owner = login.data.token;
  ck('owner 登录', login.data.ok, true);

  /* 未登录 → 401 */
  ck('policy 未登录 401', (await api('/api/upload/policy', { method: 'POST', body: {} })).status, 401);
  ck('complete 未登录 401', (await api('/api/upload/complete', { method: 'POST', body: {} })).status, 401);

  /* env 里有 OSS 值 → 可签发 */
  const pol = await api('/api/upload/policy', {
    method: 'POST', token: owner,
    body: { name: '测试文件.txt', size: 12345 }
  });
  ck('policy 签发', pol.data.ok, true);
  ck('host 正确', pol.data.host, `${OSS.bucket}.${OSS.region}.aliyuncs.com`);
  const f = pol.data.fields || {};
  ck('fields 齐全', ['key', 'policy', 'OSSAccessKeyId', 'signature', 'success_action_status'].every(k => f[k]), true);
  ck('key 锁定在前缀下', (f.key || '').startsWith(OSS.prefix + '/'), true);

  /* 签名可复算：拿到 AK Secret 的一方都能验证，防手滑写错算法 */
  const sig = crypto.createHmac('sha1', OSS.keySecret).update(f.policy).digest('base64');
  ck('签名可复算', sig, f.signature);

  /* policy 内容真的锁了 key 和大小 */
  const decoded = JSON.parse(Buffer.from(f.policy, 'base64').toString('utf8'));
  ck('policy 锁 key', decoded.conditions.some(c => c.key === f.key), true);
  ck('policy 卡大小上限', decoded.conditions.some(c => Array.isArray(c) && c[0] === 'content-length-range'), true);
  ck('policy 15 分钟时效', new Date(decoded.expiration) > new Date(Date.now() + 10 * 60 * 1000), true);
  ck('Content-Disposition 强制 attachment', /attachment/.test(f['Content-Disposition'] || ''), true);

  /* 非法名字 / 超限 */
  /* 空名字被拦（'../etc' 这类会被 sanitize 成合法名，是既有行为不是漏洞） */
  ck('空名字被拦', (await api('/api/upload/policy', { method: 'POST', token: owner, body: { name: '', size: 1 } })).status, 400);
  ck('超限被拦 413', (await api('/api/upload/policy', { method: 'POST', token: owner, body: { name: 'big.bin', size: 99 * 1024 * 1024 * 1024 } })).status, 413);
  ck('缺大小被拦', (await api('/api/upload/policy', { method: 'POST', token: owner, body: { name: 'x.txt' } })).status, 400);

  /* complete：假 uploadId → 404 */
  ck('complete 假会话 404', (await api('/api/upload/complete', { method: 'POST', token: owner, body: { uploadId: 'nope' } })).status, 404);

  /* 真会话但对象不存在（无真实 bucket）→ 409，且会话被消费 */
  const pol2 = await api('/api/upload/policy', { method: 'POST', token: owner, body: { name: 'never.bin', size: 10 } });
  const c409 = await api('/api/upload/complete', { method: 'POST', token: owner, body: { uploadId: pol2.data.uploadId } });
  ck('complete 对象不存在 409', c409.status, 409);
  ck('会话一次性（重放 404）', (await api('/api/upload/complete', { method: 'POST', token: owner, body: { uploadId: pol2.data.uploadId } })).status, 404);

  /* member 也能走 policy（上传是普通功能） */
  await api('/api/signup', { method: 'POST', body: { username: 'upuser', password: PW + 'Xy9' } });
  const m = await api('/api/auth', { method: 'POST', body: { username: 'upuser', password: PW + 'Xy9' } });
  ck('member 可签发', (await api('/api/upload/policy', { method: 'POST', token: m.data.token, body: { name: 'a.txt', size: 5 } })).data.ok, true);

  /* ---- mpart 分片：鉴权与会话边界 ---- */
  for (const p of ['/api/upload/mpart/init', '/api/upload/mpart/sign', '/api/upload/mpart/complete', '/api/upload/mpart/abort']) {
    ck(`mpart${p.slice(-5)} 未登录 401`, (await api(p, { method: 'POST', body: {} })).status, 401);
  }
  ck('mpart/status 未登录 401', (await api('/api/upload/mpart/status?uploadId=x')).status, 401);

  /* 假会话边界（不依赖真实 OSS） */
  ck('status 假会话 alive=false', (await api('/api/upload/mpart/status?uploadId=ghost', { token: owner })).data.alive, false);
  ck('sign 假会话 404', (await api('/api/upload/mpart/sign', { method: 'POST', token: owner, body: { uploadId: 'ghost', partNumbers: [1] } })).status, 404);
  ck('complete 假会话 404', (await api('/api/upload/mpart/complete', { method: 'POST', token: owner, body: { uploadId: 'ghost', parts: [] } })).status, 404);
  ck('abort 假会话 404', (await api('/api/upload/mpart/abort', { method: 'POST', token: owner, body: { uploadId: 'ghost' } })).status, 404);

  /* init 需要真调 OSS：随机凭证必被拒 → 502（若外网不可达也一定 >=400，不会 200） */
  const initR = await api('/api/upload/mpart/init', { method: 'POST', token: owner, body: { name: 'big.bin', size: 20 * 1024 * 1024 } });
  ck('init 假凭证被 OSS 拒绝', initR.status >= 400, true);

  /* ---- 我的存储（用户绑定自己的桶） ---- */
  const st0 = await api('/api/account/storage', { token: m.data.token });
  ck('我的存储初始未绑定', [st0.data.bound, st0.data.config], [false, null]);
  ck('绑定未验证身份 403', (await api('/api/account/storage', { method: 'PUT', token: m.data.token, body: {} })).status, 403);
  /* member 验证身份后再试假凭证：连接测试必失败 → 400，且不落盘 */
  ck('member step-up', (await api('/api/account/stepup', { method: 'POST', token: m.data.token, body: { password: PW + 'Xy9' } })).data.ok, true);
  const stFake = await api('/api/account/storage', {
    method: 'PUT', token: m.data.token,
    body: { region: OSS.region, bucket: OSS.bucket, keyId: OSS.keyId, keySecret: OSS.keySecret, prefix: 'drive' }
  });
  ck('假凭证绑定被拦', [stFake.status, (stFake.data.error || '').includes('连接测试失败')], [400, true]);
  const secPath = path.join(__dirname, '..', 'tmp', 'e2e-data', 'secrets.json');
  ck('绑定失败不落盘', !fs.existsSync(secPath), true);
  /* 平台配置不属于用户条目 —— getEntry(userId) 应为空 */
  ck('平台配置未串进用户条目', (await api('/api/account/storage', { token: owner })).data.bound, false);

  /* ---- 用户管理（owner）：列表 / 越权 / 配额 ---- */
  ck('member 拉用户列表 403', (await api('/api/admin/users', { token: m.data.token })).status, 403);
  const ul = await api('/api/admin/users', { token: owner });
  ck('owner 拉用户列表', ul.data.ok, true);
  const up2 = ul.data.users.find(u => u.username === 'upuser');
  ck('列表含用量与配额字段', !!(up2 && up2.usage && 'quotaBytes' in up2 && 'storageBound' in up2), true);
  ck('owner 设配额', (await api('/api/admin/users/quota', { method: 'POST', token: owner, body: { userId: up2.id, quotaGB: 0.000001 } })).data.ok, true);
  /* 配额生效：member 的 policy 应被 413 拦下（1MB 配额 < 5MB 文件） */
  const q413 = await api('/api/upload/policy', { method: 'POST', token: m.data.token, body: { name: 'q.bin', size: 5 * 1024 * 1024 } });
  ck('超配额 413', [q413.status, (q413.data.error || '').includes('空间不足')], [413, true]);
  /* 解除配额（设 0）后恢复 */
  ck('重置配额为不限', (await api('/api/admin/users/quota', { method: 'POST', token: owner, body: { userId: up2.id, quotaGB: 0 } })).data.ok, true);
  ck('解除后恢复可传', (await api('/api/upload/policy', { method: 'POST', token: m.data.token, body: { name: 'q.bin', size: 1024 } })).data.ok, true);

  /* ---- 分享时效：自定义时长 / 永久 / 续期 ---- */
  const mkFolder = await api('/api/folder', { method: 'POST', token: owner, body: { name: 'share-ttl-test', parent: null } });
  ck('建测试文件夹', mkFolder.data.ok, true);
  const fid = mkFolder.data.node.id;
  const t0 = Date.now();
  const shCustom = await api('/api/share', { method: 'POST', token: owner, body: { ids: [fid], ttlMs: 5 * 60000 } });
  ck('自定义时长签发', shCustom.data.ok, true);
  ck('expireAt ≈ 5 分钟后', Math.abs(shCustom.data.share.expireAt - (t0 + 5 * 60000)) < 5000, true);
  const shPerm = await api('/api/share', { method: 'POST', token: owner, body: { ids: [fid], permanent: true } });
  ck('永久分享签发', shPerm.data.ok, true);
  ck('永久分享无过期时间', shPerm.data.share.expireAt, null);
  ck('永久分享公开页可访问', (await api('/api/share/' + shPerm.data.share.token)).status, 200);
  const ext = await api('/api/share/extend', { method: 'POST', token: owner, body: { token: shCustom.data.share.token, ttlMs: 60 * 60000 } });
  ck('续期成功', ext.data.ok, true);
  ck('续期后 ≈ 原 5 分钟 + 60 分钟', Math.abs(ext.data.expireAt - (t0 + 65 * 60000)) < 5000, true);
  ck('续成永久', (await api('/api/share/extend', { method: 'POST', token: owner, body: { token: shCustom.data.share.token, permanent: true } })).data.expireAt, null);
  ck('他人续期被拒', (await api('/api/share/extend', { method: 'POST', token: m.data.token, body: { token: shCustom.data.share.token, permanent: true } })).status, 404);
  ck('列表含永久分享', (await api('/api/shares', { token: owner })).data.shares.some(s => s.expireAt === null), true);
  ck('清理测试分享', (await api('/api/share/revoke', { method: 'POST', token: owner, body: { tokens: [shCustom.data.share.token, shPerm.data.share.token] } })).data.revoked, 2);

  /* ---- 分享密码：自定义 / 校验 / 自动生成 ---- */
  const shPw = await api('/api/share', { method: 'POST', token: owner, body: { ids: [fid], ttlMs: 5 * 60000, password: 'my-secret-1' } });
  ck('自定义密码生效', shPw.data.share.password, 'my-secret-1');
  ck('自定义密码可登录', (await api('/api/share/' + shPw.data.share.token + '/auth', { method: 'POST', body: { password: 'my-secret-1' } })).data.ok, true);
  ck('密码太短被拦', (await api('/api/share', { method: 'POST', token: owner, body: { ids: [fid], password: 'abc' } })).status, 400);
  ck('密码含空格被拦', (await api('/api/share', { method: 'POST', token: owner, body: { ids: [fid], password: 'ab cd' } })).status, 400);
  const shAuto = await api('/api/share', { method: 'POST', token: owner, body: { ids: [fid] } });
  ck('留空自动生成 6 位', shAuto.data.share.password.length, 6);
  /* 分享管理侧：密码原文可取回、可改密 */
  const shList2 = await api('/api/shares', { token: owner });
  ck('列表带回密码原文', shList2.data.shares.find(x => x.token === shPw.data.share.token).password, 'my-secret-1');
  const newPw = 'changed-pw-9';
  ck('改密成功', (await api('/api/share/password', { method: 'POST', token: owner, body: { token: shPw.data.share.token, password: newPw } })).data.ok, true);
  ck('旧密码失效', (await api('/api/share/' + shPw.data.share.token + '/auth', { method: 'POST', body: { password: 'my-secret-1' } })).status, 401);
  ck('新密码可登录', (await api('/api/share/' + shPw.data.share.token + '/auth', { method: 'POST', body: { password: newPw } })).data.ok, true);
  ck('改密后原文同步', (await api('/api/shares', { token: owner })).data.shares.find(x => x.token === shPw.data.share.token).password, newPw);
  ck('他人改密被拒', (await api('/api/share/password', { method: 'POST', token: m.data.token, body: { token: shPw.data.share.token, password: 'hacked-pw' } })).status, 404);
  ck('清理密码测试分享', (await api('/api/share/revoke', { method: 'POST', token: owner, body: { tokens: [shPw.data.share.token, shAuto.data.share.token] } })).data.revoked, 2);

  console.log(`\n${pass} 通过, ${failN} 失败`);
  process.exit(failN ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
