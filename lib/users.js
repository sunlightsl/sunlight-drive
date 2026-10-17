/**
 * 用户：注册、登录凭据、个人资料、双因素密钥
 * ------------------------------------------------------------------
 * 这个文件只回答「用户是什么」，不回答「怎么登录」—— 会话、限流、票据
 * 那些在 lib/auth.js。
 *
 * 每个用户是一条完整记录：各带密码哈希、双因素密钥和资料，各看各的文件。
 * 站点口令（SITE_PASSWORD）只用于初始化第一个站长账号。
 *
 * 三条约定：
 *   · 用户名大小写不敏感（统一存小写）。Sunlight 和 sunlight 是两个看起来
 *     完全一样的账号，谁先注册谁占坑 —— 这种事不该留给用户去踩。
 *   · 密码存 scrypt 哈希。口令放环境变量在"就一个人"时最省事，
 *     一旦能注册就必须一人一份哈希。
 *   · 对外一律走 pub() 出参。pwHash 和 totp.secret 一次都不许离开服务端。
 */

const secret = require('./secret');
const store = require('./store');

const USERNAME_MIN = 3;
const USERNAME_MAX = 32;
const PASSWORD_MIN = 8;
const NICK_MAX = 24;

/* 只允许字母数字和 . _ -，且必须以字母或数字开头。
   不放中文和空格是有意的：用户名要出现在 otpauth URI 和日志里，
   带空格和特殊字符会一路引发转义问题。真想要中文名，用昵称。 */
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/* 留几个名字，免得和路由/系统账号撞上，也防有人注册成 admin 去骗别人 */
const RESERVED = new Set([
  'admin', 'root', 'system', 'api', 'share', 'me', 'account',
  'static', 'public', 'null', 'undefined', 'signup', 'login', 'settings'
]);

/* ---- 头像 ---- */
const AVATAR_MAX = 400 * 1024;
const AVATAR_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const DATA_URI = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/]+={0,2})$/i;

const bad = (msg, status) => Object.assign(new Error(msg), { status: status || 400 });

/* ================================================================
   读
   ================================================================ */

/** 补齐缺字段。旧库没有 users，读出来不能是 undefined */
function ensure(state) {
  if (!state.users || typeof state.users !== 'object') state.users = {};
  return state;
}

function list(state) {
  return Object.values(ensure(state).users);
}

function byId(state, id) {
  return ensure(state).users[id] || null;
}

function byUsername(state, username) {
  const n = normUsername(username);
  if (!n) return null;
  return list(state).find(u => u.username === n) || null;
}

/** 还有没有人。启动时用它判断要不要做首次初始化 */
function count(state) {
  return list(state).length;
}

/** 有效的 owner 有几个（没被停用的）。用来拦住"停掉最后一个站长" */
function activeOwners(state) {
  return list(state).filter(u => (u.role || 'member') === 'owner' && !isDisabled(u));
}

/* ================================================================
   校验
   ================================================================ */

const normUsername = (u) => String(u == null ? '' : u).trim().toLowerCase();

function checkUsername(u) {
  const n = normUsername(u);
  if (n.length < USERNAME_MIN || n.length > USERNAME_MAX) {
    throw bad(`用户名要 ${USERNAME_MIN}–${USERNAME_MAX} 位`);
  }
  if (!USERNAME_RE.test(n)) {
    throw bad('用户名只能用字母、数字和 . _ -，并且要以字母或数字开头');
  }
  if (RESERVED.has(n)) throw bad('这个用户名被系统占用了，换一个');
  return n;
}

function checkPassword(pw) {
  const s = String(pw == null ? '' : pw);
  if (s.length < PASSWORD_MIN) throw bad(`密码至少 ${PASSWORD_MIN} 位`);
  if (s.length > 128) throw bad('密码太长了');
  if (/^\s|\s$/.test(s)) throw bad('密码首尾不要留空格');
  return s;
}

function checkNickname(v) {
  const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  if (!s) throw bad('昵称不能为空');
  if ([...s].length > NICK_MAX) throw bad(`昵称最多 ${NICK_MAX} 个字`);
  if (/[\u0000-\u001f\u007f]/.test(s)) throw bad('昵称里不能有控制字符');
  return s;
}

/**
 * 认图片的真实类型。
 *
 * base64 前面那截 MIME 是调用方自己写的，不能当证据 —— 改个后缀就能混进来。
 * 所以再对一遍开头几个字节（魔数）。
 */
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' &&
      buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function checkAvatar(dataUri) {
  const raw = String(dataUri == null ? '' : dataUri).trim();
  if (!raw) throw bad('没有收到图片');

  const m = DATA_URI.exec(raw);
  if (!m) throw bad('图片格式不对，应该是 data:image/…;base64,…');

  const mime = m[1].toLowerCase();
  if (!AVATAR_MIME.has(mime)) throw bad('只支持 PNG / JPEG / WebP');

  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 24) throw bad('图片数据不完整');
  if (buf.length > AVATAR_MAX) {
    throw bad(`头像太大了（${Math.round(buf.length / 1024)} KB），最多 ${Math.round(AVATAR_MAX / 1024)} KB`);
  }

  const real = sniff(buf);
  if (!real) throw bad('这不是一张能识别的图片');
  if (real !== mime) throw bad(`图片内容是 ${real}，和声明的 ${mime} 对不上`);

  return raw;
}

/* ================================================================
   对外形状
   ================================================================ */

/** 唯一允许离开服务端的用户形状。别的地方不要自己拼字段 */
function pub(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname || u.username,
    avatar: u.avatar || '',
    plan: u.plan || 'free',
    role: u.role || 'member',
    /* null = 未单独设置（走全站默认/不限）。下发它，用户管理面板才显示 */
    quotaBytes: u.quotaBytes === undefined ? null : u.quotaBytes,
    totpEnabled: totpOn(u),
    /* 停用状态。被停用的账号能登出、能被站长恢复，但登不进来 */
    disabled: isDisabled(u),
    disabledAt: u.disabledAt || null,
    disabledReason: u.disabledReason || '',
    createdAt: u.createdAt || null,
    lastLoginAt: u.lastLoginAt || null
  };
}

/* ================================================================
   账号状态：停用 / 恢复
   ----------------------------------------------------------------
   为什么用"停用"而不是直接删：
     · 删号是不可逆的，还会牵连 OSS 上的对象和已有的分享记录；
       停用是可逆的，一分钟就能恢复，误操作代价几乎为零。
     · lib/auth.js 的 checkSession 每次都重新查用户记录，所以
       停用会**立刻**生效 —— 手里已经拿到的会话下一次请求就失效，
       不需要另外维护一张"踢人名单"。
   ================================================================ */

const isDisabled = (u) => !!(u && u.disabled);

/**
 * 停用一个账号。已登录的会话不用在这里清 ——
 * checkSession 每次请求都会拒掉停用账号，下一次请求它就失效了。
 * （server.js 那边另外调 dropSessionsOf 立即回收内存，属于锦上添花）
 */
function setDisabled(state, user, disabled, reason) {
  if (!user) { const e = new Error('用户不存在'); e.status = 404; throw e; }
  if (disabled) {
    user.disabled = true;
    user.disabledAt = new Date().toISOString();
    user.disabledReason = String(reason || '').trim().slice(0, 200);
  } else {
    delete user.disabled;
    delete user.disabledAt;
    delete user.disabledReason;
  }
  user.updatedAt = new Date().toISOString();
  return user;
}

/**
 * 设置单个用户的存储配额。
 *
 * bytes 为 null/undefined/0 表示**取消单独设置**，回到全站默认
 * （QUOTA_GB）。注意这**不等于"不限"** —— 只有 QUOTA_GB 本身为 0 时
 * 全站才是不限。把这种情况表述为"不限"会造成误导：
 * 在默认 1GB 的站上，界面显示"不限"而实际仍按 1GB 执行。
 *
 * owner 不受配额约束，给 owner 设的值只做记录 —— 托管场景 owner 是站长本人。
 */
function setQuota(state, user, bytes) {
  if (!user) { const e = new Error('用户不存在'); e.status = 404; throw e; }
  if (bytes === null || bytes === undefined || bytes === 0) {
    delete user.quotaBytes;
    return user;
  }
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0 || n > 1e15) {
    const e = new Error('配额数值不合法');
    e.status = 400;
    throw e;
  }
  user.quotaBytes = Math.round(n);
  return user;
}

const totpOn = (u) => !!(u && u.totp && u.totp.enabled && u.totp.secret);

/** 生成了密钥但还没验过码 —— 也就是"绑定绑到一半"。账号页要把它和已启用区分开 */
const totpPending = (u) => !!(u && u.totp && u.totp.secret && !u.totp.enabled);

/* ================================================================
   写（都在 store.mutate 里调，state 是库里那份）
   ================================================================ */

const newId = () => 'u_' + secret.randomHex(8);

/**
 * 建一个用户。state 是 drive.json 里那份数据，调用方负责放进 store.mutate。
 *
 * **空库里建的第一个账号自动是站长（owner）。**
 * 这样全新部署时只要注册一次就拿到管理权限，不必先去 .env 里配口令。
 * 判定放在这里而不是路由里，是因为建账号只有这一个入口 ——
 * 放在入口上，任何调用方（注册、bootstrap 迁移）都自动遵守同一套规则。
 *
 * 并发安全性：本函数总在 store.mutate 里被调用，而 mutate 是串行的，
 * 所以"空库"这个判断不会出现两个人同时通过、双双成为站长的竞态。
 *
 * @throws 用户名重复时抛 409
 */
function create(state, { username, password, nickname, role, plan, id, legacyPassword }) {
  const uname = checkUsername(username);
  if (byUsername(state, uname)) {
    throw bad('这个用户名已经有人用了', 409);
  }
  /* 注意判据是"库里有几个账号"，不是"有几个站内还能用的账号" ——
     全部停用时也不该再冒出一个新站长。 */
  const firstOne = count(state) === 0;
  const now = new Date().toISOString();
  const u = {
    id: id || newId(),
    username: uname,
    nickname: nickname ? checkNickname(nickname) : uname,
    avatar: '',
    plan: plan || (firstOne ? 'pro' : 'free'),
    role: role || (firstOne ? 'owner' : 'member'),
    /* legacyPassword 只给迁移用：老口令可能短于当前下限，但它已经在用了，
       不能因为新规则把人锁在门外。改密码时才受新规则约束。 */
    pwHash: secret.hash(legacyPassword !== undefined ? String(legacyPassword) : checkPassword(password)),
    totp: { secret: '', enabled: false, lastStep: 0 },
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null
  };
  ensure(state).users[u.id] = u;
  return u;
}

/** 校验密码。用户名不存在时也要走一次哈希，别让响应时间区分出"人不存在" */
function checkPasswordOf(user, password) {
  const stored = user && user.pwHash
    ? user.pwHash
    : 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const ok = secret.verify(stored, password || '');
  return !!user && ok;
}

function setPassword(state, user, newPassword) {
  user.pwHash = secret.hash(checkPassword(newPassword));
  user.updatedAt = new Date().toISOString();
}

function setProfile(state, user, { nickname, avatar }) {
  if (nickname !== undefined) user.nickname = checkNickname(nickname);
  if (avatar !== undefined) {
    user.avatar = avatar === null || avatar === '' ? '' : checkAvatar(avatar);
  }
  user.updatedAt = new Date().toISOString();
  return user;
}

function touchLogin(state, user) {
  user.lastLoginAt = new Date().toISOString();
  user.updatedAt = user.lastLoginAt;
}

/* ---- 双因素 ---- */

/** 写一个新密钥，但先不启用 —— 要等用户拿动态码验证过一次才算数 */
function setTotpSecret(state, user, secretB32) {
  user.totp = { secret: String(secretB32 || '').toUpperCase(), enabled: false, lastStep: 0 };
  user.updatedAt = new Date().toISOString();
}

function enableTotp(state, user) {
  if (!user.totp || !user.totp.secret) throw bad('还没有生成密钥');
  user.totp.enabled = true;
  user.updatedAt = new Date().toISOString();
}

function disableTotp(state, user) {
  user.totp = { secret: '', enabled: false, lastStep: 0 };
  user.updatedAt = new Date().toISOString();
}

/* ================================================================
   首次初始化 / 单用户数据收编
   ================================================================ */

/**
 * 把单用户时代的数据收编到第一个账号名下。
 *
 * 触发条件很明确：**库里一个用户都没有**。这时拿 .env 里的 SITE_PASSWORD
 * 建一个账号（默认用户名 sunlight），然后把所有还没归属的节点、分享，
 * 以及那份 profile 全部划过去。
 *
 * 已经验证器的手机不用重新绑定：.env 里的 TOTP_SECRET 会一并搬过去。
 *
 * 已经有用户了就原样返回 —— 这段逻辑一辈子只跑一次，重复跑不会有事。
 *
 * @returns {null|object} null 表示不需要迁移；否则返回新账号的对外形状
 */
async function adoptLegacyData({ username = 'sunlight', password, totpSecret, totpDisabled, brand } = {}) {
  if (count(store.get())) return null;

  const pw = String(password || '');
  if (!pw) return null;   // 没配口令就什么都做不了，让上层去报错

  const result = await store.mutate(state => {
    const u = create(state, {
      username,
      legacyPassword: pw,
      nickname: (brand || username),
      role: 'owner',
      plan: 'pro'
    });

    if (totpSecret && !totpDisabled) {
      u.totp = { secret: String(totpSecret).toUpperCase(), enabled: true, lastStep: 0 };
    }

    /* 没归属的东西全部划给这个账号 */
    let adopted = 0;
    for (const n of Object.values(state.nodes || {})) {
      if (!n.owner) { n.owner = u.id; adopted++; }
    }
    for (const sh of Object.values(state.shares || {})) {
      if (!sh.owner) sh.owner = u.id;
    }

    /* 单用户时代的 profile（昵称/头像）也搬进这条用户记录 */
    const p = state.profile;
    if (p && typeof p === 'object') {
      if (typeof p.nickname === 'string' && p.nickname.trim()) u.nickname = p.nickname.trim();
      if (typeof p.avatar === 'string' && p.avatar) u.avatar = p.avatar;
      delete state.profile;
    }

    u.__adopted = adopted;
    return u;
  });

  const adopted = result.__adopted;
  delete result.__adopted;
  return { user: pub(result), adopted };
}

module.exports = {
  USERNAME_MIN, USERNAME_MAX, PASSWORD_MIN, NICK_MAX, RESERVED,
  ensure, list, count, byId, byUsername, pub, totpOn, totpPending,
  normUsername, checkUsername, checkPassword, checkNickname, checkAvatar,
  create, checkPasswordOf, setPassword, setProfile, touchLogin,
  setTotpSecret, enableTotp, disableTotp, setQuota,
  isDisabled, setDisabled, activeOwners,
  adoptLegacyData
};
