/**
 * 认证：登录、会话、限流、分享票据
 * ------------------------------------------------------------------
 * 登录两段式：
 *   ① POST /api/auth    {username,password} → 校验密码，发一张 2 分钟的一次性票据
 *   ② POST /api/auth/2fa {challenge,code}   → 校验动态码，才发正式会话 token
 *
 * 为什么要分两段而不是一个请求传两个值：分两段才能在第二段单独限流。
 * 合成一个请求的话，知道密码的人可以在同一请求里狂试 6 位动态码。
 * 分开之后，"密码对了但码不对"也走失败计数，20 分钟内试不了几次。
 *
 * 票据是一次性的，用过即焚；只认 2 分钟。这样即使票据被截，也很快就废。
 *
 * 多用户之后，会话和票据都带 userId —— 之前"这个人"是唯一的，
 * 现在必须回答"是谁"。双因素开关也跟着用户走，不再是全局的 CFG.totpEnabled。
 */

const crypto = require('crypto');
const { CFG } = require('./config');
const totp = require('./totp');
const secret = require('./secret');
const store = require('./store');
const users = require('./users');

/* ================================================================
   基础
   ================================================================ */

/* 哈希和常量时间比较都搬到 lib/secret.js 了 —— 用户密码和分享密码必须
   用同一套参数，两处各写一份迟早会在某次调参后不一致。这里只是转出去。 */
const safeEqual = secret.safeEqual;
const randomHex = secret.randomHex;

/* ================================================================
   限流
   ================================================================ */

/**
 * 通用的「窗口内失败次数」限流。
 * 失败计数而不是请求计数——正常用户偶尔打错密码不该被锁，
 * 只有密集失败才说明是脚本。
 */
const buckets = new Map();   // key -> { count, firstAt }

function rateBlocked(key, max, windowMs) {
  const rec = buckets.get(key);
  if (!rec) return 0;
  if (Date.now() - rec.firstAt > windowMs) { buckets.delete(key); return 0; }
  if (rec.count < max) return 0;
  return Math.ceil((windowMs - (Date.now() - rec.firstAt)) / 60000) || 1;
}

function rateFail(key, windowMs) {
  const rec = buckets.get(key);
  const now = Date.now();
  if (!rec || now - rec.firstAt > windowMs) buckets.set(key, { count: 1, firstAt: now });
  else rec.count++;
}

function rateClear(key) { buckets.delete(key); }

/* 定时清理，别让 Map 无限涨 */
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of buckets) {
    if (now - r.firstAt > 24 * 3600 * 1000) buckets.delete(k);
  }
  for (const [k, v] of challenges) if (now > v.expire) challenges.delete(k);
  for (const [k, v] of sessions) if (now > v.expire) sessions.delete(k);
  for (const [k, v] of shareSessions) if (now > v.expire) shareSessions.delete(k);
}, 60 * 1000).unref();

/* ================================================================
   登录
   ================================================================ */

const challenges = new Map();   // challenge -> { expire, userId }
const sessions = new Map();     // token -> { expire, createdAt, userId }

const bucketKey = (kind, ip) => `${kind}:${ip}`;

/**
 * 第一步：校验用户名 + 密码。
 * @returns {{status:number, body:object}}
 */
function startLogin(username, password, ip) {
  const blocked = rateBlocked(bucketKey('pwd', ip), CFG.maxAttempts, CFG.attemptWindow);
  if (blocked) {
    return { status: 429, body: { error: `尝试次数过多，请 ${blocked} 分钟后再试` } };
  }

  const s = store.get();
  const user = users.byUsername(s, username);

  /* 用户名不存在也照样走一次哈希 —— checkPasswordOf 会拿一个假哈希来算。
     否则"用户不存在"立刻返回、"密码错"要等 80ms，响应快慢就把
     哪些用户名存在泄露出去了。错误文案也不区分这两种情况。 */
  if (!users.checkPasswordOf(user, password)) {
    rateFail(bucketKey('pwd', ip), CFG.attemptWindow);
    return { status: 401, body: { error: '用户名或密码不正确' } };
  }

  /* 密码对了，但账号被停用。
     这一句刻意放在密码校验**之后**：先验密码，才不会把"这个账号被停用了"
     变成一个人人都问得出来的账号探测器。而密码正确的人本来就该知道原因，
     否则他会一直以为是自己密码打错了。 */
  if (users.isDisabled(user)) {
    rateClear(bucketKey('pwd', ip));
    console.warn(`[auth] 已停用账号尝试登录 ip=${ip} 用户名=${user.username}`);
    return { status: 403, body: { error: '这个账号已被停用，请联系站长' } };
  }

  /* 密码对了 */
  if (!users.totpOn(user)) {
    rateClear(bucketKey('pwd', ip));
    // 记一下最后登录时间。不 await：这是审计信息，丢了不影响登录本身，
    // 而 store.mutate 自己有队列，不会和别的写操作打架。
    store.mutate(st => users.touchLogin(st, st.users[user.id])).catch(() => {});
    return { status: 200, body: issueSession(user) };
  }

  // 开了双因素：发一次性票据，等动态码
  const challenge = randomHex(32);
  challenges.set(challenge, { expire: Date.now() + CFG.challengeTtl * 1000, userId: user.id });
  return {
    status: 200,
    body: {
      needTotp: true,
      challenge,
      ttl: CFG.challengeTtl,
      digits: totp.DIGITS,
      period: totp.STEP
    }
  };
}

/** 第二步：校验动态码，换正式会话 */
function verifyTotp(challenge, code, ip) {
  const blocked = rateBlocked(bucketKey('totp', ip), CFG.maxAttempts, CFG.attemptWindow);
  if (blocked) {
    return { status: 429, body: { error: `尝试次数过多，请 ${blocked} 分钟后再试` } };
  }

  const rec = challenges.get(challenge);
  if (!rec) {
    return { status: 401, body: { error: '验证已失效，请重新输入密码' } };
  }
  if (Date.now() > rec.expire) {
    challenges.delete(challenge);
    return { status: 401, body: { error: '验证超时，请重新输入密码' } };
  }

  const s = store.get();
  const user = users.byId(s, rec.userId);
  /* 拿到票据之后这个账号的验证方式变了（被关了双因素，或者账号没了），
     或者这中间被停用了。不能只看票据有效就放行。 */
  if (!user || users.isDisabled(user) || !users.totpOn(user)) {
    challenges.delete(challenge);
    return {
      status: 401,
      body: {
        error: user && users.isDisabled(user)
          ? '这个账号已被停用，请联系站长'
          : '这个账号的验证方式已经变了，请重新登录'
      }
    };
  }

  /* 防重放的状态挂在 lib/totp.js 里，键是 密钥 + 时间片 ——
     每个人的密钥不同，天然按用户隔离，这里不用额外做什么。 */
  const v = totp.verifyCode(user.totp.secret, code);
  if (!v.ok) {
    rateFail(bucketKey('totp', ip), CFG.attemptWindow);
    // 票据不销毁：用户手滑输错一次，不该被赶回第一步重输密码。
    // 真正防爆破的是上面的失败计数，不是销毁票据。
    //
    // replayed 要单独说：手机上显示的码是对的，只是这个 30 秒窗口内
    // 已经成功登录过一次。统一回"动态码不对"会让人以为密钥配错了。
    const error = v.reason === 'replayed'
      ? '该动态码已被使用，请等待验证器刷新后重试（最长 30 秒）'
      : '动态码不正确';
    return { status: 401, body: { error, reason: v.reason } };
  }

  // 用过了就作废，防同一张票据被重复使用
  challenges.delete(challenge);
  rateClear(bucketKey('totp', ip));
  rateClear(bucketKey('pwd', ip));
  store.mutate(st => users.touchLogin(st, st.users[user.id])).catch(() => {});
  return { status: 200, body: issueSession(user) };
}

function issueSession(user) {
  const token = randomHex(32);
  const expire = Date.now() + CFG.tokenTtl * 1000;
  sessions.set(token, { expire, createdAt: Date.now(), userId: user.id });
  return {
    token,
    expire: Math.floor(expire / 1000),
    ttl: CFG.tokenTtl,
    user: users.pub(user)
  };
}

/**
 * 校验会话 token，顺便滑动续期（长时间浏览不会中途掉线）。
 * @returns {{ok:boolean, error?:string, expire?:number, user?:object}}
 */
function checkSession(token) {
  if (!token) return { ok: false, error: '未提供通行证' };
  const rec = sessions.get(token);
  if (!rec) return { ok: false, error: '通行证无效' };
  if (Date.now() > rec.expire) {
    sessions.delete(token);
    return { ok: false, error: '通行证已过期' };
  }
  /* 每次请求都重新取一遍用户，不是图省事 —— 账号被删、被停用、或者改完
     密码踢掉旧会话之后，手里的 token 必须立刻失效。
     停用能"立刻"生效就是靠这一句：不需要另外维护踢人名单。 */
  const user = users.byId(store.get(), rec.userId);
  if (!user) {
    sessions.delete(token);
    return { ok: false, error: '账号已不存在' };
  }
  if (users.isDisabled(user)) {
    sessions.delete(token);
    return { ok: false, error: '账号已被停用' };
  }
  rec.expire = Date.now() + CFG.tokenTtl * 1000;
  return { ok: true, expire: rec.expire, userId: user.id, user: users.pub(user) };
}

function logout(token) { return sessions.delete(token); }

/**
 * 踢掉某个用户的所有会话（可以留一个）。
 * 改密码之后必须调 —— 不然改密码这个动作就失去意义了：
 * 别人拿着的旧 token 还能继续用。
 */
function dropSessionsOf(userId, keepToken) {
  let n = 0;
  for (const [t, rec] of sessions) {
    if (rec.userId === userId && t !== keepToken) { sessions.delete(t); n++; }
  }
  return n;
}

/** 这个用户当前有几张有效的票，账号页面上会显示 */
function countSessionsOf(userId) {
  let n = 0;
  for (const rec of sessions.values()) if (rec.userId === userId) n++;
  return n;
}

/* 兼容旧前端：从 Authorization 头里取 Bearer */
function bearer(req) {
  const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : '';
}

/* ================================================================
   分享密码
   ================================================================
   分享密码是发给别人的、要能口头念出来的，所以很短（6 位）。
   短密码意味着暴力空间小，必须靠两件事兜住：
     1. 存哈希用 scrypt（慢哈希），泄库也难反推
     2. 校验接口按 分享token + IP 限流
   再加上 2 小时过期，窗口本来就窄。
   ================================================================ */

// 去掉了 0/O/1/I/l 这些看错的字符，方便电话或微信口述
const SHARE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeSharePassword(len = 6) {
  const buf = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += SHARE_ALPHABET[buf[i] % SHARE_ALPHABET.length];
  return s;
}

/* 和用户密码共用同一套 scrypt 参数，实现在 lib/secret.js。
   以前这里自己实现了一份，和用户密码那份是重复的。 */
const hashSharePassword = secret.hash;
const verifySharePassword = secret.verify;

/* 分享作用域内的会话：换了密码之内 2 小时内不必反复输 */
const shareSessions = new Map();   // stoken -> { token, expire }

function issueShareSession(shareToken) {
  const stoken = randomHex(24);
  const expire = Date.now() + 2 * 3600 * 1000;
  shareSessions.set(stoken, { token: shareToken, expire });
  return { stoken, expire: Math.floor(expire / 1000) };
}

function checkShareSession(shareToken, stoken) {
  const rec = shareSessions.get(stoken);
  if (!rec) return false;
  if (rec.token !== shareToken) return false;      // 不能拿 A 分享的票据访问 B
  if (Date.now() > rec.expire) { shareSessions.delete(stoken); return false; }
  return true;
}

/* ================================================================
   诊断
   ================================================================ */

function snapshot() {
  const all = users.list(store.get());
  return {
    sessions: sessions.size,
    challenges: challenges.size,
    shareSessions: shareSessions.size,
    rateBuckets: buckets.size,
    /* 双因素从「全局开关」变成了「每人一个」，所以这里报的是人数，
       不是一个 true/false —— 以前那行 totpEnabled 现在没有意义了 */
    users: all.length,
    usersWithTotp: all.filter(users.totpOn).length
  };
}

module.exports = {
  safeEqual, bearer,
  startLogin, verifyTotp, issueSession, checkSession, logout,
  dropSessionsOf, countSessionsOf,
  rateBlocked, rateFail, rateClear, bucketKey,
  makeSharePassword, hashSharePassword, verifySharePassword,
  issueShareSession, checkShareSession,
  snapshot
};
