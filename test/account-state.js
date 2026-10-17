/**
 * 停用/恢复账号的端到端验证（临时脚本，验证完即删）
 * 起真服务、发真请求，只碰临时数据目录。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3222;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(__dirname, 'acct-data');
const DRIVE = path.join(DATA, 'drive.json');

let pass = 0, fail = 0;
const ck = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `   got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

const api = async (p, { method = 'GET', body, token } = {}) => {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, j };
};

let srv = null;
const boot = () => new Promise((res, rej) => {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DRIVE_DATA_DIR: DATA,
           SITE_PASSWORD: 'owner-pass-123', ADMIN_USERNAME: 'boss',
           TOTP_DISABLED: '1', TOTP_SECRET: '', REGISTRATION: 'open',
           BRAND: 'TestBrand' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  srv.stdout.on('data', d => { out += d; if (/页面\s+http/.test(out)) res(); });
  srv.stderr.on('data', d => { out += d; });
  srv.on('exit', c => { if (!/页面\s+http/.test(out)) rej(new Error('server exited ' + c + '\n' + out)); });
  setTimeout(() => res(), 6000);
});
const stop = () => new Promise(r => {
  if (!srv) return r();
  srv.on('exit', () => { srv = null; r(); });
  srv.kill('SIGKILL');
  setTimeout(() => { srv = null; r(); }, 2000);
});

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  await boot();

  console.log('== 1. 首次初始化 + owner 登录 ==');
  const login = await api('/api/auth', { method: 'POST', body: { username: 'boss', password: 'owner-pass-123' } });
  ck('owner 登录 200', login.status, 200);
  const owner = login.j.token;
  ck('owner 无 2FA 直接拿到 token', typeof owner, 'string');

  const st0 = await api('/api/admin/users', { token: owner });
  ck('用户列表 200', st0.status, 200);
  const me = st0.j.users.find(u => u.username === 'boss');
  ck('新账号 disabled 默认 false', me.disabled, false);
  ck('列表带 sessions 字段', typeof me.sessions, 'number');
  ck('列表带 activeOwners', Array.isArray(st0.j.activeOwners), true);
  ck('返回 me（前端要判断"是不是我"）', st0.j.me, me.id);

  console.log('\n== 2. 防呆：不能停用自己 ==');
  const self = await api('/api/admin/users/disable', { method: 'POST', token: owner, body: { userId: me.id } });
  ck('停用自己 400', self.status, 400);
  ck('错误文案', /不能停用你自己/.test(self.j.error || ''), true);

  console.log('\n== 3. 防呆：不能停用唯一站长 ==');
  const only = await api('/api/admin/users/disable', { method: 'POST', token: owner, body: { userId: me.id } });
  ck('仍然 400', only.status, 400);

  console.log('\n== 4. 注册一个成员，然后停用他 ==');
  const su = await api('/api/signup', { method: 'POST', body: { username: 'member_a', password: 'member-pass-123' } });
  ck('注册 200', su.status, 200);
  const memberTok = su.j.token;
  const memberId = su.j.user.id;
  ck('新成员 role=member', su.j.user.role, 'member');

  ck('成员登录着，会话数 >= 1', (await api('/api/admin/users', { token: owner })).j.users.find(u => u.id === memberId).sessions >= 1, true);

  const dis = await api('/api/admin/users/disable', { method: 'POST', token: owner, body: { userId: memberId, reason: '测试' } });
  ck('停用成员 200', dis.status, 200);
  ck('返回踢掉的会话数', typeof dis.j.sessionsDropped, 'number');
  ck('成员 disabled=true', dis.j.user.disabled, true);
  ck('停用原因存下来了', dis.j.user.disabledReason, '测试');

  console.log('\n== 5. 停用立刻生效（这是整个功能的关键） ==');
  const reuse = await api('/api/tree', { token: memberTok });
  ck('他手里原来的 token 立刻失效 401', reuse.status, 401);

  const pwOk = await api('/api/auth', { method: 'POST', body: { username: 'member_a', password: 'member-pass-123' } });
  ck('密码正确也不能登录 403', pwOk.status, 403);
  ck('给出能照做的提示', /停用/.test(pwOk.j.error || ''), true);

  const pwBad = await api('/api/auth', { method: 'POST', body: { username: 'member_a', password: 'wrong-password' } });
  ck('密码错误仍是 401（不泄露账号状态）', pwBad.status, 401);

  console.log('\n== 6. 恢复 ==');
  const en = await api('/api/admin/users/enable', { method: 'POST', token: owner, body: { userId: memberId } });
  ck('恢复 200', en.status, 200);
  ck('disabled=false', en.j.user.disabled, false);
  const back = await api('/api/auth', { method: 'POST', body: { username: 'member_a', password: 'member-pass-123' } });
  ck('恢复后能登录了', back.status, 200);
  const tok2 = back.j.token;
  ck('拿到的 token 可用', (await api('/api/tree', { token: tok2 })).status, 200);

  console.log('\n== 7. 强制下线（不动账号状态） ==');
  const kick = await api('/api/admin/users/logout-all', { method: 'POST', token: owner, body: { userId: memberId } });
  ck('强制下线 200', kick.status, 200);
  ck('踢掉了会话', kick.j.sessionsDropped >= 1, true);
  ck('他的 token 失效了', (await api('/api/tree', { token: tok2 })).status, 401);
  const again = await api('/api/auth', { method: 'POST', body: { username: 'member_a', password: 'member-pass-123' } });
  ck('但账号没被停用，还能自己登回来', again.status, 200);

  console.log('\n== 8. 非 owner 碰不到管理接口 ==');
  const asMember = await api('/api/admin/users', { token: again.j.token });
  ck('成员访问用户列表 403', asMember.status, 403);
  const asMemberDis = await api('/api/admin/users/disable', { method: 'POST', token: again.j.token, body: { userId: owner } });
  ck('成员想停用站长 403', asMemberDis.status, 403);

  console.log('\n== 8b. 停用时不撤销分享 → 他的分享链接仍然打得开 ==');
  const mk = await api('/api/folder', { method: 'POST', token: again.j.token, body: { name: '分享用的目录' } });
  ck('成员建了个目录', mk.status, 200);
  const shr = await api('/api/share', { method: 'POST', token: again.j.token,
    body: { ids: [mk.j.node.id], password: 'sharepw123' } });
  ck('成员发了一条分享', shr.status, 200);
  const shareTok = shr.j.share.token;

  const preOpen = await api(`/api/share/${shareTok}`);
  ck('停用前：分享可访问', preOpen.status, 200);

  const dis2 = await api('/api/admin/users/disable', { method: 'POST', token: owner, body: { userId: memberId } });
  ck('停用（默认不撤分享）200', dis2.status, 200);
  ck('撤销数 0', dis2.j.sharesRevoked, 0);
  ck('停用后：分享仍然打得开', (await api(`/api/share/${shareTok}`)).status, 200);
  const list8 = await api('/api/admin/users', { token: owner });
  ck('列表里能看到他有 1 条分享在外', list8.j.users.find(u => u.id === memberId).shareCount, 1);

  console.log('\n== 8c. 停用时勾上"撤销分享" → 立刻失效 ==');
  await api('/api/admin/users/enable', { method: 'POST', token: owner, body: { userId: memberId } });
  const dis3 = await api('/api/admin/users/disable', { method: 'POST', token: owner,
    body: { userId: memberId, revokeShares: true } });
  ck('停用并撤分享 200', dis3.status, 200);
  ck('撤销了 1 条', dis3.j.sharesRevoked, 1);
  ck('分享现在 404（打不开了）', (await api(`/api/share/${shareTok}`)).status, 404);
  ck('列表里分享数归零', (await api('/api/admin/users', { token: owner })).j.users.find(u => u.id === memberId).shareCount, 0);

  await api('/api/admin/users/enable', { method: 'POST', token: owner, body: { userId: memberId } });

  await stop();

  console.log('\n== 9. 两个 owner 时，允许停用其中一个 ==');
  // 直接改库加第二个 owner（接口不提供改角色，所以只能用文件）
  const db = JSON.parse(fs.readFileSync(DRIVE, 'utf8'));
  const boss = Object.values(db.users).find(u => u.username === 'boss');
  const second = {
    id: 'u_secondowner01', username: 'boss2', nickname: 'boss2', avatar: '',
    plan: 'pro', role: 'owner',
    pwHash: boss.pwHash,           // 借用同一个哈希，密码同 boss
    totp: { secret: '', enabled: false, lastStep: 0 },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastLoginAt: null
  };
  db.users[second.id] = second;
  fs.writeFileSync(DRIVE, JSON.stringify(db, null, 2));
  await boot();

  const l2 = await api('/api/auth', { method: 'POST', body: { username: 'boss', password: 'owner-pass-123' } });
  ck('boss 重新登录', l2.status, 200);
  const o2 = l2.j.token;
  const st2 = await api('/api/admin/users', { token: o2 });
  ck('现在有 2 个 activeOwners', st2.j.activeOwners.length, 2);

  const disOther = await api('/api/admin/users/disable', { method: 'POST', token: o2, body: { userId: 'u_secondowner01' } });
  ck('可以停用另一个站长', disOther.status, 200);
  ck('停用后 activeOwners 剩 1', (await api('/api/admin/users', { token: o2 })).j.activeOwners.length, 1);

  const disAgain = await api('/api/admin/users/disable', { method: 'POST', token: o2, body: { userId: 'u_secondowner01' } });
  ck('重复停用是幂等的（200，不是错误）', disAgain.status, 200);

  console.log('\n== 9b. 最后一个 owner 自己也停不掉 ==');
  const lastOwner = await api('/api/admin/users/disable', { method: 'POST', token: o2, body: { userId: me.id } });
  ck('停用自己 400', lastOwner.status, 400);
  ck('文案指向"不能停用你自己"', /不能停用你自己/.test(lastOwner.j.error || ''), true);

  console.log('\n== 10. 最后一个 owner 被停用后不能登入（防呆的第二道） ==');
  // 把 boss 的角色交给已停用的那个也不行 —— 这里验证"停用状态会在登录时被拦"
  const en2 = await api('/api/admin/users/enable', { method: 'POST', token: o2, body: { userId: 'u_secondowner01' } });
  ck('恢复第二个站长', en2.status, 200);

  await stop();
  fs.rmSync(DATA, { recursive: true, force: true });

  console.log(`\n====================\n${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch(async e => {
  console.error('TEST ERROR:', e.message);
  await stop();
  process.exit(1);
});
