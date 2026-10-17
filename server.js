/**
 * sunlight · 私人网盘后端
 * ------------------------------------------------------------------
 * 启动：node server.js   （本地开发用 node dev.js，它会先准备 .env）
 *
 * 职责：
 *   账号      注册、登录（密码 + 可选的 TOTP 两步验证）、改密、资料
 *   文件树    列出 / 新建 / 改名 / 移动 / 删除 —— 每个用户只看自己那一份
 *   上传      浏览器 → 本服务 → OSS（流式，不落盘）
 *   下载      签发 5 分钟有效的 OSS 临时链接，文件流不走本服务
 *   分享      一次分享 = 一个链接 + 一个密码，限定在这一组东西内
 *
 * 为什么上传走本服务而不是浏览器直传 OSS：
 *   阿里云 ECS 的公网入方向流量免费，只有出方向计费。上传是入方向，
 *   所以经本服务中转不额外花钱，还省掉 OSS 的 CORS 配置，并且能在
 *   数据真正落到 OSS 之前就拦掉超限、非法文件名、没权限的请求。
 *   下载则相反——出方向要钱，所以必须直连 OSS，本服务只签发链接。
 *
 * 归属这件事只有一条路：所有文件操作都从 scope.open(state, uid) 拿视图，
 * 不从 store.get().nodes 直接取。见 lib/scope.js 开头那段。
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');

// lib/config 在加载时会先读 .env 再构造 CFG，所以直接 require 就行
const { CFG, describe } = require('./lib/config');

const store = require('./lib/store');
const tree = require('./lib/tree');
const auth = require('./lib/auth');
const totp = require('./lib/totp');
const users = require('./lib/users');
const ossconfig = require('./lib/ossconfig');
const { seal, unseal } = ossconfig;
const scope = require('./lib/scope');
const qrcode = require('./lib/qrcode');
const preview = require('./lib/preview');
const { trackRequest } = require('./lib/reqguard');

const app = express();
app.disable('x-powered-by');

/* 每个请求给一个短 id，**必须在最前面** —— 兜底错误处理要用它。
   目的是：客户端只拿到"服务器内部错误"，但同时拿到一个 id；
   拿着这个 id 去日志里搜，就能找到带完整堆栈的那一条。
   没有它的话，"出错了"这三个字在日志里根本定位不到是哪一次请求。 */
app.use((req, res, next) => {
  req.logId = crypto.randomBytes(4).toString('hex');
  res.set('X-Request-Id', req.logId);
  next();
});

/* 头像是一条 data URI，比普通 JSON 大得多，得单独放宽。
   其余接口仍旧卡在 64kb —— 不把全局抬上去是有意的：
   那等于给每个接口都开了一扇后门，而它们本来都不需要这么大。 */
const AVATAR_PATH = '/api/account/avatar';

const jsonSmall = express.json({ limit: '64kb' });
app.use((req, res, next) => {
  if (req.path === AVATAR_PATH) return next();
  jsonSmall(req, res, next);
});

/* ================================================================
   OSS 客户端（延迟创建，实现在 lib/ossconfig.js）
   ================================================================ */

function getOss() {
  return ossconfig.getClient();
}

/* ================================================================
   小工具
   ================================================================ */

const ok = (res, body) => res.json({ ok: true, ...body });

function fail(res, status, error, extra) {
  res.status(status).json({ ok: false, error, ...(extra || {}) });
}

/** 把 lib 里抛的、带 status 的业务错误转成响应，其余当 500 */
const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch(e => {
    if (e && e.status) return fail(res, e.status, e.message);
    console.error('[500]', req.method, req.originalUrl, e && e.stack || e);
    fail(res, 500, '服务内部错误');
  });
};

/** 客户端 IP。X-Forwarded-For 可以被任何人伪造，用来做限流键就是
    「换个假头绕一遍」—— 所以只有显式声明自己躲在反代后面
    （TRUST_PROXY=1，且 Nginx 会覆写该头）才采信，否则直连地址。 */
const getIp = (req) => {
  if (process.env.TRUST_PROXY === '1') {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
};

/* ---- 当前是谁 ---- */

/**
 * 取出会话并解析成「这个人」。
 * 会话里存的是 userId，用户对象每次现取 —— 账号被删、改完密码踢了会话，
 * 手里的 token 必须立刻作废。
 */
/**
 * 从 cookie 里取会话票。
 *
 * 为什么要有这条路径：
 *   主站把票存在 sessionStorage 里、用 Authorization 头发 —— 那套是给单页应用用的。
 *   但**分享页是另一个页面**（甚至可能是另一个标签、从别人给的链接打开的），
 *   它拿不到 sessionStorage 里那份，也就没法知道"你已经登录了"。
 *   结果就是分享了链接、登录之后回来，页面还是让你去登录。
 *
 * 所以登录时**额外**种一个 HttpOnly cookie：浏览器在任何同源请求上都会自动带上它，
 * 分享页不需要知道票是什么就能被认出身份。
 *   · HttpOnly —— 页面脚本读不到，XSS 偷不走
 *   · SameSite=Lax —— 挡掉跨站请求伪造，同时不影响从外部链接点进来
 *   · Secure —— 只在 HTTPS 上发（本地 http 调试不带，免得整条链路失效）
 * 显式传 header 仍然优先，两条路径并存，谁也没被替代。
 */
function cookieToken(req) {
  const raw = req.headers.cookie || '';
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === 'sl_sess') {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { return ''; }
    }
  }
  return '';
}

/** 种会话 cookie。maxAge 用秒；传 0 表示立刻失效（登出） */
function setSessionCookie(req, res, token, maxAge) {
  const bits = [
    'sl_sess=' + encodeURIComponent(token || ''),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + (maxAge || 0)
  ];
  /* 本地 http 调试时不能加 Secure，否则浏览器直接丢掉这个 cookie */
  const https = (req.headers['x-forwarded-proto'] || req.protocol || '') === 'https';
  if (https) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

function authOf(req) {
  /* 先看显式头（单页应用走这条），没有再退回 cookie（分享页走这条） */
  const t = auth.bearer(req) || cookieToken(req);
  const r = auth.checkSession(t);
  if (!r.ok) return null;
  const u = users.byId(store.get(), r.userId);
  if (!u) return null;
  return { token: t, expire: r.expire, userId: u.id, user: u };
}

const requireAuth = (req, res, next) => {
  const a = authOf(req);
  if (!a) return fail(res, 401, '登录状态已失效，请重新登录');
  req.auth = a;
  next();
};

/** 当前用户视角的文件树。所有文件路由都从这里拿 */
const scopeOf = (req) => scope.open(store.get(), req.auth.userId);

/** OSS 上的存放路径与文件树解耦：树是真相，key 只是个不重复的地址。
    用哪份配置传，就用哪份配置的前缀 —— 平台配置和用户自绑桶各走各的。
    平台桶按用户名再分一层（drive/username/202610/...）：删用户时按前缀
    一刀切，不会和别人的文件混在一起。用户名注册时就限制在 [a-z0-9._-]，
    直接当文件夹名是安全的。自绑桶整个都是他自己的，不再分。 */
function makeOssKeyFor(cfg, fileName, username, platform) {
  const prefix = cfg.prefix || CFG.uploadPrefix || 'drive';
  const userSeg = platform && username ? `${username}/` : '';
  const d = new Date();
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `${prefix}/${userSeg}${ym}/${crypto.randomBytes(3).toString('hex')}_${fileName}`;
}

/** 给一个文件节点签一个临时下载链接。
    用文件主人的配置签名：他绑了自己的桶，文件就在他的桶里，
    平台配置换多少次都影响不到他的文件。

    disposition='inline' 时改成内联，让浏览器直接渲染（预览用）。
    **只有白名单里的类型才允许 inline** —— 对 SVG / HTML 签 inline
    等于让上传者在我们域名下拿到同源执行权。具体判断在 lib/preview.js。

    ⚠️ 只覆盖 content-disposition，**绝不能**覆盖 content-type：
       OSS 会直接回 400 `Can not override response header on content-type`。
       实测（2026-10-16）：只覆盖 content-type 必然失败，两个一起覆盖也必然失败，
       只有 content-disposition 是允许的。
       对象的真实 MIME 必须在**上传时**就写对，不能指望签名时补救。 */
function signFor(node, disposition) {
  const key = node.ossKey;
  const mode = disposition === 'inline' ? 'inline' : 'attachment';
  return ossconfig.getClientFor(node.owner).signatureUrl(key, {
    expires: CFG.signTtl,
    response: {
      'content-disposition': `${mode}; filename*=UTF-8''${encodeURIComponent(node.name)}`
    }
  });
}

/** 预览用的签名。不能预览的类型一律拒绝 —— 不要在路由里散落判断 */
function signForPreview(node) {
  if (!preview.canPreview(node)) {
    const e = new Error('这个文件类型不支持预览');
    e.status = 415;
    throw e;
  }
  return signFor(node, 'inline');
}

/* OSS 简单复制（CopyObject）一次能搬的上限。超过这个大小要走分片复制
   （UploadPartCopy），所以这条路径上必须显式拦住 —— 否则要么报一个
   看不懂的 OSS 错误，要么留下一个"看起来成功但内容是空的"对象。 */
const COPY_MAX_BYTES = 1024 * 1024 * 1024;   // 1 GB

/**
 * 服务端把对象复制一份（字节不过 ECS、不过浏览器）。
 *
 * 只在**同一个桶**内使用。跨桶复制要求同一对凭证对源和目标都有权限，
 * 而"用户自带桶"的设计天然是两套独立凭证 —— 那种情况必须在上层拦掉，
 * 不要指望这里能兜住。ali-oss 的 copy() 是单个 client 内的操作。
 *
 * @returns {Promise<{ok:true, etag?:string, lastModified?:string} | {ok:false, status:number, error:string}>}
 */
async function copyObjectWithin(userId, srcKey, destKey, size) {
  if (size > COPY_MAX_BYTES) {
    return {
      ok: false, status: 413,
      error: `单个文件超过服务端复制的上限 ${(COPY_MAX_BYTES / 1073741824).toFixed(0)} GB，请改用下载后上传`
    };
  }
  const client = ossconfig.getClientFor(userId);
  /* 第三参留空 = 用 client 自己的桶当源；传 true 会走断点续传的分片复制，
     简单复制不需要。CopyObject 是原子的：要么成功，要么什么都没留下，
     所以失败时不需要清理半个对象。 */
  const r = await client.copy(destKey, srcKey);
  const d = (r && r.data) || {};
  return { ok: true, etag: d.etag, lastModified: d.lastModified };
}

/**
 * 存储配额检查：只约束"用平台存储"的普通用户。
 * 绑了自己桶的人空间自理（付的是他自己的 OSS 账单），不占平台配额；
 * owner 是站长本人，不受限。
 *
 * quotaBytes 未单独设置时跟随全站默认（QUOTA_GB）——
 * 注意"未设置"是**跟随默认**，不是"不限"：默认 1GB 的站上，
 * 清空某个用户的配额之后他仍然受 1GB 约束。
 * 只有 QUOTA_GB 本身为 0 时全站才是不限（下面 `if (!quota) return` 那条）。
 */
function checkQuota(user, sc, incoming) {
  if (user.role === 'owner') return;
  if (ossconfig.getEntry(user.id)) return;
  const quota = user.quotaBytes != null ? user.quotaBytes : CFG.quotaBytes;
  if (!quota) return;
  const used = sc.stats().bytes;
  if (used + incoming > quota) {
    const e = new Error(
      `空间不足：配额 ${(quota / 1073741824).toFixed(1)} GB，` +
      `已用 ${(used / 1073741824).toFixed(2)} GB，本文件 ${(incoming / 1048576).toFixed(1)} MB`);
    e.status = 413;
    throw e;
  }
}

const pendingTotp = (u) => users.totpPending(u);

/* ================================================================
   站点信息
   ================================================================ */

/**
 * 登录/注册页要问的第一件事。
 * 双因素不再是一个全局开关了 —— 开没开是每个账号自己的事，
 * 所以这里只在登录第二步才需要 digits/period，先一并给出，前端不用再问一趟。
 */
app.get('/api/site', (req, res) => {
  ok(res, {
    brand: CFG.brand,
    /* 没配对象存储时上传必然 503。让前端提前知道，就能在建目录之前收手 ——
       不然拖一个文件夹进来会先建出一整片空目录，文件一个都没传上去。
       动态取值：管理员在页面上配好 OSS 后不用重启就能上传。 */
    uploadReady: ossconfig.ready(),
    registrationOpen: CFG.registrationOpen,
    usernameMin: users.USERNAME_MIN,
    usernameMax: users.USERNAME_MAX,
    passwordMin: users.PASSWORD_MIN,
    digits: totp.DIGITS,
    period: totp.STEP,
    maxUploadMB: Math.round(CFG.maxUploadBytes / 1048576),
    shareTtlHours: CFG.shareTtl / 3600,
    sessionTtl: CFG.tokenTtl
  });
});

/* ================================================================
   注册
   ================================================================ */

app.post('/api/signup', wrap(async (req, res) => {
  if (!CFG.registrationOpen) {
    return fail(res, 403, '本站暂不开放注册');
  }

  const ip = getIp(req);
  const key = auth.bucketKey('signup', ip);
  const blocked = auth.rateBlocked(key, CFG.maxAttempts, CFG.attemptWindow);
  if (blocked) return fail(res, 429, `尝试次数过多，请 ${blocked} 分钟后再试`);

  const { username, password, nickname } = req.body || {};

  let user;
  try {
    user = await store.mutate(s => users.create(s, { username, password, nickname }));
  } catch (e) {
    /* 用户名被占单独限流：不然可以拿它当"这个用户名存不存在"的探测器，
       一个脚本几秒钟就能把一批用户名扫出来。 */
    if (e.status === 409) auth.rateFail(key, CFG.attemptWindow);
    throw e;
  }

  auth.rateClear(key);
  console.log(`[signup] 新账号 ${user.username} ip=${ip}`);

  /* 注册完直接登录，不再让人跑一趟登录页。
     新账号没有任何文件，所以这里不用做数据收编。 */
  const s = await store.mutate(st => {
    const u = st.users[user.id];
    users.touchLogin(st, u);
    return u;
  });

  res.set('Cache-Control', 'no-store');
  const sess = auth.issueSession(s);
  setSessionCookie(req, res, sess.token, CFG.tokenTtl);
  ok(res, { ...sess, created: true });
}));

/* ================================================================
   登录
   ================================================================ */

app.post('/api/auth', (req, res) => {
  const b = req.body || {};
  const r = auth.startLogin(b.username, b.password, getIp(req));
  if (r.status !== 200) {
    console.warn(`[auth] 密码阶段失败 ip=${getIp(req)} 用户名=${b.username || ''} ${r.body.error}`);
    return fail(res, r.status, r.body.error);
  }
  if (r.body.needTotp) {
    console.log(`[auth] 密码通过，等待动态码 ip=${getIp(req)}`);
    return ok(res, r.body);
  }
  console.log(`[auth] 登录成功（无 2FA）ip=${getIp(req)}`);
  res.set('Cache-Control', 'no-store');
  /* 除了返回给前端存 sessionStorage 的那份，再种一个 cookie ——
     分享页要靠它认出"你已经登录了"，见 cookieToken() 的注释 */
  setSessionCookie(req, res, r.body.token, CFG.tokenTtl);
  ok(res, r.body);
});

app.post('/api/auth/2fa', (req, res) => {
  const { challenge, code } = req.body || {};
  const r = auth.verifyTotp(challenge, code, getIp(req));
  if (r.status !== 200) {
    console.warn(`[auth] 动态码阶段失败 ip=${getIp(req)} ${r.body.error}`);
    // 把 reason 一起带回去：前端凭它区分"码错了"和"这个码刚用过"，
    // 只回一句 error 的话，第二种情况用户会以为密钥配错了。
    return fail(res, r.status, r.body.error, { reason: r.body.reason });
  }
  console.log(`[auth] 登录成功（2FA）ip=${getIp(req)}`);
  res.set('Cache-Control', 'no-store');
  setSessionCookie(req, res, r.body.token, CFG.tokenTtl);
  ok(res, r.body);
});

/* 退出登录不要求会话有效 —— 本来就是来作废凭证的，
   票已经过期了还不让人"退"，前端只能自己把本地那份删掉，反而更乱。 */
app.post('/api/logout', (req, res) => {
  /* 两条路径都要作废：显式头带来的那张，以及 cookie 里那张。
     它们是同一个会话的不同携带方式，但万一不一致也要都清掉。 */
  auth.logout(auth.bearer(req));
  const ck = cookieToken(req);
  if (ck && ck !== auth.bearer(req)) auth.logout(ck);
  setSessionCookie(req, res, '', 0);        // 让浏览器立刻丢掉 cookie
  ok(res, {});
});

/** 前端启动时问一句：我这张票还有效吗，我是谁 */
app.get('/api/session', (req, res) => {
  const a = authOf(req);
  if (!a) return fail(res, 401, '未登录');
  res.set('Cache-Control', 'no-store');
  /* 把票回传一份。
     场景：用户在分享页登录（那里种了 HttpOnly cookie），然后回到主站。
     主站的 sessionStorage 里没有票，但它现在能靠 cookie 通过这里的认证 ——
     拿到这张票之后，后续请求就还能走 Authorization 头那条路，不用为此
     把整站的请求方式都改一遍。票本来就是发给他本人的，不构成新的暴露面。 */
  ok(res, { expire: a.expire, token: a.token, brand: CFG.brand, user: users.pub(a.user) });
});

/* ================================================================
   账号中心
   ----------------------------------------------------------------
   一一对应头像菜单里的那几项：个人资料、修改密码、两步验证、退出登录。
   ================================================================ */

app.get('/api/account', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  ok(res, {
    account: {
      ...users.pub(req.auth.user),
      totpPending: pendingTotp(req.auth.user),
      /* 个人视角的上传可用性：绑了自己的桶，平台没配也能传 */
      uploadReady: !!ossconfig.activeFor(req.auth.userId)
    },
    /* 显示有几处登录着。改密码之后只会剩当前这一张票 */
    sessions: auth.countSessionsOf(req.auth.userId),
    twoFactor: { digits: totp.DIGITS, period: totp.STEP }
  });
});

/* ---- 资料：昵称 ---- */
app.post('/api/account/profile', requireAuth, wrap(async (req, res) => {
  const u = await store.mutate(s => users.setProfile(s, s.users[req.auth.userId], {
    nickname: req.body && req.body.nickname
  }));
  ok(res, { account: { ...users.pub(u), totpPending: pendingTotp(u) } });
}));

/* ---- 资料：头像 ----
   单独一条路由、单独一个更大的 body 上限，因为它是一条 data URI。
   真正的把关在 users.checkAvatar：解 base64、对文件头魔数、核大小，
   前端缩过图这件事只是省流量，不作为依据。 */
app.post(AVATAR_PATH, requireAuth, express.json({ limit: '1mb' }), wrap(async (req, res) => {
  const u = await store.mutate(s => users.setProfile(s, s.users[req.auth.userId], {
    avatar: (req.body && req.body.avatar) || ''
  }));
  ok(res, { account: { ...users.pub(u), totpPending: pendingTotp(u) } });
}));

app.post('/api/account/avatar/clear', requireAuth, wrap(async (req, res) => {
  const u = await store.mutate(s => users.setProfile(s, s.users[req.auth.userId], { avatar: '' }));
  ok(res, { account: { ...users.pub(u), totpPending: pendingTotp(u) } });
}));

/* ---- 修改密码 ----
   必须验旧密码：拿到了会话不代表知道密码（可能是别人没锁屏的电脑）。
   改完踢掉其它所有会话 —— 否则"改密码"这个动作就失去意义了，
   别人手里那张旧票还能继续用。当前这张留着，不然等于把自己也踹出去。 */
app.post('/api/account/password', requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const me = req.auth.user;

  if (!users.checkPasswordOf(me, b.current)) {
    auth.rateFail(auth.bucketKey('chpwd', getIp(req)), CFG.attemptWindow);
    return fail(res, 400, '当前密码不正确');
  }

  const next = users.checkPassword(b.next);
  if (next === String(b.current)) return fail(res, 400, '新密码和当前密码一样，换一个');

  await store.mutate(s => users.setPassword(s, s.users[me.id], next));

  const dropped = auth.dropSessionsOf(me.id, req.auth.token);
  console.log(`[account] ${me.username} 改了密码，踢掉 ${dropped} 个其它会话 ip=${getIp(req)}`);
  ok(res, { dropped });
}));

/* ---- 两步验证 ---- */

app.get('/api/account/2fa', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  ok(res, {
    enabled: users.totpOn(req.auth.user),
    pending: pendingTotp(req.auth.user),
    digits: totp.DIGITS,
    period: totp.STEP
  });
});

/**
 * 生成一个新密钥，画成二维码。
 * 这时还没启用 —— 要等用户拿验证器 App 扫完、回填一个能对上的码才生效。
 * 顺序不能反过来：先启用再让用户扫，一次扫不上就把自己锁在外面了。
 */
app.post('/api/account/2fa/start', requireAuth, wrap(async (req, res) => {
  if (users.totpOn(req.auth.user)) {
    return fail(res, 400, '两步验证已经开着，要换密钥请先关掉');
  }

  const secret = totp.generateSecret();
  await store.mutate(s => users.setTotpSecret(s, s.users[req.auth.userId], secret));

  const uri = totp.otpauthUri(secret, req.auth.user.username, CFG.brand);
  const qr = qrcode.svgPath(uri);

  res.set('Cache-Control', 'no-store');
  ok(res, { secret, uri, qr, digits: totp.DIGITS, period: totp.STEP });
}));

/** 拿一个能对上的动态码来证明"App 那边确实扫上了"，然后才真正启用 */
app.post('/api/account/2fa/enable', requireAuth, wrap(async (req, res) => {
  const me = req.auth.user;
  if (!pendingTotp(me)) return fail(res, 400, '请先生成绑定二维码');

  const code = (req.body && req.body.code) || '';
  const v = totp.verifyCode(me.totp.secret, code, { preventReplay: false });
  if (!v.ok) {
    return fail(res, 400, v.reason === 'format' ? '请输入验证器上的 6 位数字' : '动态码不正确，请等待验证器刷新后重试',
      { reason: v.reason });
  }

  const u = await store.mutate(s => {
    const target = s.users[me.id];
    users.enableTotp(s, target);
    return target;
  });
  console.log(`[2fa] ${me.username} 启用了两步验证 ip=${getIp(req)}`);
  ok(res, { account: { ...users.pub(u), totpPending: false } });
}));

/** 放弃这次绑定，把还没启用的密钥丢掉 */
app.post('/api/account/2fa/cancel', requireAuth, wrap(async (req, res) => {
  if (users.totpOn(req.auth.user)) return fail(res, 400, '两步验证已经开着，不能这样取消');
  const u = await store.mutate(s => {
    const t = s.users[req.auth.userId];
    users.disableTotp(s, t);
    return t;
  });
  ok(res, { account: { ...users.pub(u), totpPending: false } });
}));

/**
 * 关掉两步验证。
 * 要验密码 —— 只凭一张会话就把第二道锁摘掉，等于第二道锁形同虚设：
 * 偷到一张票的人可以直接关掉它，然后想怎么登就怎么登。
 */
app.post('/api/account/2fa/disable', requireAuth, wrap(async (req, res) => {
  const me = req.auth.user;
  if (!users.totpOn(me)) return fail(res, 400, '两步验证未开启');

  if (!users.checkPasswordOf(me, (req.body && req.body.password) || '')) {
    auth.rateFail(auth.bucketKey('chpwd', getIp(req)), CFG.attemptWindow);
    return fail(res, 400, '密码不正确');
  }

  const u = await store.mutate(s => {
    const t = s.users[me.id];
    users.disableTotp(s, t);
    return t;
  });
  console.log(`[2fa] ${me.username} 关掉了两步验证 ip=${getIp(req)}`);
  ok(res, { account: { ...users.pub(u), totpPending: false } });
}));

/* ================================================================
   敏感操作的二次确认（step-up）
   ----------------------------------------------------------------
   管理员改 OSS 配置 = 换掉全站数据落在哪里，这张会话票被偷的话
   损失的就是所有人的文件。所以这类操作要求"刚才真的验证过身份"：
   验一次 TOTP（或没开 2FA 时重输密码），换一张 5 分钟有效的令牌。
   令牌只放内存里，重启即失效 —— 不给它任何落盘的机会。
   ================================================================ */

const STEPUP_TTL = 5 * 60 * 1000;
const stepupTokens = new Map(); // userId -> 过期时间戳

function stepupGrant(userId) {
  stepupTokens.set(userId, Date.now() + STEPUP_TTL);
}

function stepupOk(userId) {
  const until = stepupTokens.get(userId);
  if (!until || until < Date.now()) {
    stepupTokens.delete(userId);
    return false;
  }
  return true;
}

app.post('/api/account/stepup', requireAuth, wrap(async (req, res) => {
  const me = req.auth.user;
  const body = req.body || {};

  /* 开了两步验证的账号只认动态码 —— 密码在会话被劫持的场景下
     大概率也一起泄了，多一道不共享存储的因子才有意义。 */
  if (users.totpOn(me)) {
    const v = totp.verifyCode(me.totp.secret, body.code || '', { preventReplay: false });
    if (!v.ok) {
      console.warn(`[stepup] 动态码验证失败 用户=${me.username} ip=${getIp(req)}`);
      return fail(res, 400, v.reason === 'format' ? '请输入验证器上的 6 位数字' : '动态码不正确');
    }
  } else {
    if (!users.checkPasswordOf(me, body.password || '')) {
      auth.rateFail(auth.bucketKey('chpwd', getIp(req)), CFG.attemptWindow);
      console.warn(`[stepup] 密码验证失败 用户=${me.username} ip=${getIp(req)}`);
      return fail(res, 400, '密码不正确');
    }
  }

  stepupGrant(me.id);
  console.log(`[stepup] 敏感操作授权 用户=${me.username} ip=${getIp(req)} 方式=${users.totpOn(me) ? '2fa' : 'password'}`);
  ok(res, { ok: true, ttl: STEPUP_TTL / 1000 });
}));

/* ================================================================
   OSS 配置管理（头像菜单 → 配置）
   ----------------------------------------------------------------
   owner：能看（脱敏）、能改、能删 —— 全站的存储是他配的。
   admin：只能看脱敏视图 —— 知道系统状态即可，改钥匙的权力不给。
   member：看不到这个入口，接口也进不来。
   ================================================================ */

function requireOssAdmin(edit) {
  return (req, res, next) => {
    const role = req.auth.user.role || 'member';
    if (role !== 'owner' && role !== 'admin') return fail(res, 403, '没有权限，这项操作只有站长和管理员能做');
    if (edit && role !== 'owner') return fail(res, 403, '只有站长（owner）能修改存储配置');
    next();
  };
}

/** 查看当前配置（脱敏）+ 来源。不改任何状态，只要求角色 */
app.get('/api/admin/oss', requireAuth, requireOssAdmin(false), (req, res) => {
  const a = ossconfig.active();
  ok(res, {
    configured: !!a,
    source: a ? a.source : null,
    config: a ? ossconfig.masked(a.cfg) : null
  });
});

/** 保存并测试连接。测试不过就不落盘 —— 存一份连不上的配置没有意义 */
app.post('/api/admin/oss', requireAuth, requireOssAdmin(true), wrap(async (req, res) => {
  const me = req.auth.user;
  if (!stepupOk(me.id)) return fail(res, 403, '请先完成身份验证', { needStepup: true });

  const prev = ossconfig.getEntry(ossconfig.PLATFORM);
  const cfg = ossconfig.validate(req.body || {}, prev);

  try {
    await ossconfig.testConnection(cfg);
  } catch (e) {
    console.warn(`[oss] 连接测试失败 用户=${me.username} ip=${getIp(req)}: ${e.message}`);
    return fail(res, 400, '连接测试失败：' + e.message);
  }

  ossconfig.setEntry(ossconfig.PLATFORM, cfg);
  console.log(`[oss] ${me.username} 更新了平台存储配置（bucket=${cfg.bucket}） ip=${getIp(req)}`);
  ok(res, { config: ossconfig.masked(cfg), source: 'ui' });
}));

/** 清掉页面配置，回落到 .env（如果 .env 里有） */
app.delete('/api/admin/oss', requireAuth, requireOssAdmin(true), wrap(async (req, res) => {
  const me = req.auth.user;
  if (!stepupOk(me.id)) return fail(res, 403, '请先完成身份验证', { needStepup: true });

  const removed = ossconfig.deleteEntry(ossconfig.PLATFORM);
  console.log(`[oss] ${me.username} 清除了页面配置（${removed ? '原本存在' : '本来就没有'}） ip=${getIp(req)}`);
  const a = ossconfig.active();
  ok(res, {
    config: a ? ossconfig.masked(a.cfg) : null,
    source: a ? a.source : null
  });
}));

/* ================================================================
   我的存储（用户绑定自己的桶，Mode B）
   ----------------------------------------------------------------
   绑定后该用户的上传/下载全部走他自己的桶，空间与流量自理，
   平台配额不再约束他。凭证同样加密落盘，接口只回脱敏值。
   注意解绑的影响：已存在他自己桶里的文件靠"他的当前绑定"签名下载，
   解绑后那些文件将无法下载 —— 前端在清除前会明确警告这一点。
   ================================================================ */

app.get('/api/account/storage', requireAuth, (req, res) => {
  const e = ossconfig.getEntry(req.auth.userId);
  ok(res, { bound: !!e, config: e ? ossconfig.masked(e) : null });
});

app.put('/api/account/storage', requireAuth, wrap(async (req, res) => {
  const me = req.auth.user;
  if (!stepupOk(me.id)) return fail(res, 403, '请先完成身份验证', { needStepup: true });

  const prev = ossconfig.getEntry(me.id);
  const cfg = ossconfig.validate(req.body || {}, prev);
  try {
    await ossconfig.testConnection(cfg);
  } catch (e) {
    console.warn(`[storage] ${me.username} 绑定桶测试失败 ip=${getIp(req)}: ${e.message}`);
    return fail(res, 400, '连接测试失败：' + e.message);
  }
  ossconfig.setEntry(me.id, cfg);
  console.log(`[storage] ${me.username} 绑定了自己的存储（bucket=${cfg.bucket}） ip=${getIp(req)}`);
  ok(res, { config: ossconfig.masked(cfg) });
}));

app.delete('/api/account/storage', requireAuth, wrap(async (req, res) => {
  const me = req.auth.user;
  if (!stepupOk(me.id)) return fail(res, 403, '请先完成身份验证', { needStepup: true });
  const removed = ossconfig.deleteEntry(me.id);
  console.log(`[storage] ${me.username} 解除自己的存储绑定（${removed ? '原本存在' : '本来就没有'}） ip=${getIp(req)}`);
  ok(res, {});
}));

/* ================================================================
   用户管理（仅 owner）：列表 + 每人用量 + 配额设置
   配额是"按存储计费"的基础数据 —— 用量来自文件树实时聚合，
   不需要单独的计费表；等真要出账单时再落历史快照。
   ================================================================ */

const requireOwner = (req, res, next) => {
  if ((req.auth.user.role || 'member') !== 'owner') return fail(res, 403, '只有站长能管理用户');
  next();
};

app.get('/api/admin/users', requireAuth, requireOwner, (req, res) => {
  const state = store.get();
  const usage = {}; // userId -> { files, bytes, folders }
  for (const n of Object.values(state.nodes)) {
    if (!n.owner) continue;
    const o = usage[n.owner] || (usage[n.owner] = { files: 0, folders: 0, bytes: 0 });
    if (n.type === 'file') { o.files++; o.bytes += n.size || 0; }
    else o.folders++;
  }
  /* 每个人名下还有几条分享在外 —— 停用一个人之前，站长该知道
     他手上有多少条链接正在被别人用着 */
  const shares = {};
  const now = Date.now();
  for (const sh of Object.values(state.shares || {})) {
    if (!sh.owner) continue;
    if (sh.expireAt && sh.expireAt <= now) continue;   // 已过期的不用管
    shares[sh.owner] = (shares[sh.owner] || 0) + 1;
  }
  const list = users.list(state).map(u => ({
    ...users.pub(u),
    storageBound: !!ossconfig.getEntry(u.id),
    usage: usage[u.id] || { files: 0, folders: 0, bytes: 0 },
    /* 当前有几个登录着的会话 —— 站长要"强制下线"时先知道踢得动几个 */
    sessions: auth.countSessionsOf(u.id),
    shareCount: shares[u.id] || 0
  }));
  /* activeOwners 让前端能提前把"唯一站长"的停用按钮禁掉，
     而不是等点下去才被后端拒绝 */
  ok(res, {
    users: list,
    defaultQuotaBytes: CFG.quotaBytes,
    activeOwners: users.activeOwners(state).map(u => u.id),
    me: req.auth.userId
  });
});

app.post('/api/admin/users/quota', requireAuth, requireOwner, wrap(async (req, res) => {
  const { userId, quotaGB } = req.body || {};
  const target = users.byId(store.get(), String(userId || ''));
  if (!target) return fail(res, 404, '用户不存在');
  const bytes = (quotaGB === null || quotaGB === undefined || quotaGB === '' || Number(quotaGB) === 0)
    ? null
    : Number(quotaGB) * 1073741824;
  const u = await store.mutate(s => users.setQuota(s, s.users[target.id], bytes));
  console.log(`[users] ${req.auth.user.username} 把 ${target.username} 的配额设为 ${bytes === null ? '不限' : (bytes / 1073741824).toFixed(1) + ' GB'} ip=${getIp(req)}`);
  ok(res, { user: users.pub(u) });
}));

/* ---- 停用 / 恢复 ----
   为什么是"停用"而不是"删除"：停用可逆，一分钟就能恢复，误操作代价几乎为零；
   删除不可逆，还要牵连 OSS 上的对象和已有的分享记录。
   停用之后 checkSession 下一次请求就会拒掉他，所以立刻生效。

   dropSessionsOf(id) 不传 keepToken = 把所有会话都踢掉（包括当前这张）。
   下面两个接口都用这个语义：站长既然要收回权限，就不该给自己留一张。 */

app.post('/api/admin/users/disable', requireAuth, requireOwner, wrap(async (req, res) => {
  const me = req.auth.user;
  const { userId, reason, revokeShares } = req.body || {};
  const target = users.byId(store.get(), String(userId || ''));
  if (!target) return fail(res, 404, '用户不存在');

  /* 两条防呆，都是为了"别把自己锁在门外"：
     1. 不能停用自己 —— 停用是立刻生效的，手一抖自己就进不来了
     2. 不能停用最后一个还能用的 owner —— 哪怕是从另一个站长账号操作 */
  if (target.id === me.id) return fail(res, 400, '不能停用你自己的账号');

  const isTargetOwner = (target.role || 'member') === 'owner';
  if (isTargetOwner) {
    const others = users.activeOwners(store.get()).filter(u => u.id !== target.id);
    if (!others.length) return fail(res, 400, '这是唯一还能用的站长账号，停用后没人能进后台了');
  }

  /* 停用**不自动**撤销分享 —— 停用是"不让他登录"，不是"把他发出去的东西收回"。
     但这两件事经常要一起做（因滥用而停用时，他的分享链接还开着），
     所以给一个显式开关，由调用方决定，默认不撤销。 */
  let revoked = 0;
  const u = await store.mutate(s => {
    const out = users.setDisabled(s, s.users[target.id], true, reason);
    if (revokeShares) {
      for (const [tok, sh] of Object.entries(s.shares || {})) {
        if (sh.owner === target.id) { delete s.shares[tok]; revoked++; }
      }
    }
    return out;
  });
  const killed = auth.dropSessionsOf(target.id);
  console.log(`[users] ${me.username} 停用了 ${target.username}`
    + `（踢掉 ${killed} 个会话${revoked ? `，撤销 ${revoked} 条分享` : ''}）ip=${getIp(req)}`);
  ok(res, { user: users.pub(u), sessionsDropped: killed, sharesRevoked: revoked });
}));

app.post('/api/admin/users/enable', requireAuth, requireOwner, wrap(async (req, res) => {
  const me = req.auth.user;
  const { userId } = req.body || {};
  const target = users.byId(store.get(), String(userId || ''));
  if (!target) return fail(res, 404, '用户不存在');
  const u = await store.mutate(s => users.setDisabled(s, s.users[target.id], false));
  console.log(`[users] ${me.username} 恢复了 ${target.username} ip=${getIp(req)}`);
  ok(res, { user: users.pub(u) });
}));

/** 强制下线：只踢会话，不动账号状态。用户下次还能自己登回来 */
app.post('/api/admin/users/logout-all', requireAuth, requireOwner, wrap(async (req, res) => {
  const me = req.auth.user;
  const { userId } = req.body || {};
  const target = users.byId(store.get(), String(userId || ''));
  if (!target) return fail(res, 404, '用户不存在');
  const killed = auth.dropSessionsOf(target.id);
  console.log(`[users] ${me.username} 强制下线 ${target.username}（${killed} 个会话）ip=${getIp(req)}`);
  ok(res, { sessionsDropped: killed, self: target.id === me.id });
}));

/* ================================================================
   文件树
   ================================================================ */

/** 把节点转成前端要的形状（不下发 ossKey 和 owner，那属于服务端内部信息） */
function pub(n) {
  const o = {
    id: n.id, type: n.type, name: n.name, parent: n.parent || null,
    createdAt: n.createdAt || null
  };
  if (n.type === 'file') {
    o.size = n.size || 0;
    o.updatedAt = n.updatedAt || null;
    o.mime = n.mime || '';
    // 下发哈希，前端才能真的做完整性比对。哈希不是秘密，泄露也改不了文件。
    o.sha256 = n.sha256 || '';
    /* 能不能预览由服务端说了算 —— 白名单只在 lib/preview.js 一处维护，
       前端照着这个字段决定"点它是预览还是下载"。
       两边各写一套判断的话，迟早出现"前端开了预览、后端却只给 attachment"
       这种自相矛盾的状态。 */
    o.pv = preview.kindOf(n);
  }
  return o;
}

app.get('/api/tree', requireAuth, wrap((req, res) => {
  const sc = scopeOf(req);
  const parent = req.query.parent || null;

  let parentNode = null;
  if (parent) {
    parentNode = sc.get(parent);
    if (!parentNode) return fail(res, 404, '文件夹不存在');
    if (parentNode.type !== 'folder') return fail(res, 400, '该节点不是文件夹');
  }

  ok(res, {
    parent: parent || null,
    breadcrumb: parent ? sc.ancestorsOf(parent).map(pub) : [],
    current: parentNode ? pub(parentNode) : null,
    children: sc.childrenOf(parent).map(pub),
    stats: sc.stats()
  });
}));

app.get('/api/stats', requireAuth, (req, res) => ok(res, { stats: scopeOf(req).stats() }));

/**
 * 全站扁平节点列表 —— 只给自己名下的。
 * 前端拿它做两件按目录接口做不了的事：全站搜索、以及「移动到」的目录树。
 * 个人网盘量级（几千个节点）一次下发没压力；真涨到几万再改分页。
 */
app.get('/api/flat', requireAuth, (req, res) => {
  const sc = scopeOf(req);
  ok(res, { nodes: sc.all().map(pub), stats: sc.stats() });
});

/* ---- 新建文件夹 ---- */
app.post('/api/folder', requireAuth, wrap(async (req, res) => {
  const { name, parent } = req.body || {};
  const node = await store.mutate(s => scope.open(s, req.auth.userId).createFolder(name, parent || null));
  console.log(`[tree] ${req.auth.user.username} 新建文件夹 "${node.name}" ip=${getIp(req)}`);
  ok(res, { node: pub(node) });
}));

/* ---- 改名 ---- */
app.post('/api/rename', requireAuth, wrap(async (req, res) => {
  const { id, name } = req.body || {};
  const node = await store.mutate(s => scope.open(s, req.auth.userId).rename(id, name));
  ok(res, { node: pub(node) });
}));

/* ---- 移动 ---- */
app.post('/api/move', requireAuth, wrap(async (req, res) => {
  const { ids, parent } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return fail(res, 400, '没有选中任何东西');
  const moved = await store.mutate(s => {
    const sc = scope.open(s, req.auth.userId);
    return ids.map(id => pub(sc.move(id, parent || null)));
  });
  console.log(`[tree] 移动 ${ids.length} 项 ip=${getIp(req)}`);
  ok(res, { nodes: moved });
}));

/* ---- 删除 ---- */
app.post('/api/delete', requireAuth, wrap(async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return fail(res, 400, '没有选中任何东西');

  let ossKeys = [];
  let removedCount = 0;
  await store.mutate(s => {
    const sc = scope.open(s, req.auth.userId);
    for (const id of ids) {
      const r = sc.remove(id);
      ossKeys = ossKeys.concat(r.ossKeys);
      removedCount += r.removed.length;
    }
  });

  // 树已经改完了，再去删 OSS 对象。删失败不回滚——树是真相，
  // 日志里留下 key 就够了，人工清理比把树改回去安全。
  // 这里的节点全部属于当前用户（scope 已隔离），用他自己的配置删。
  const failed = [];
  if (ossKeys.length && ossconfig.activeFor(req.auth.userId)) {
    const client = ossconfig.getClientFor(req.auth.userId);
    for (const key of ossKeys) {
      try { await client.delete(key); }
      catch (e) { failed.push({ key, error: e.message }); }
    }
  }

  console.log(`[tree] 删除 ${removedCount} 个节点、${ossKeys.length} 个对象 ip=${getIp(req)}`);
  if (failed.length) {
    console.warn('[tree] 有 OSS 对象没删掉（树已更新，需手工清理）：');
    failed.forEach(f => console.warn(`  ${f.key}  ${f.error}`));
  }
  ok(res, { removed: removedCount, objects: ossKeys.length, failed });
}));

/* ================================================================
   上传：浏览器 → 本服务 → OSS（流式）
   ================================================================ */

app.post('/api/upload', requireAuth, wrap(async (req, res) => {
  const parent = req.query.parent || null;
  const rawName = req.query.name || '';

  if (!ossconfig.activeFor(req.auth.userId)) return fail(res, 503, '服务器未配置对象存储，无法上传');

  let name;
  try { name = tree.sanitizeName(rawName); }
  catch (e) { return fail(res, 400, e.message); }

  const sc = scopeOf(req);
  if (parent && !sc.get(parent)) return fail(res, 404, '目标文件夹不存在');
  const p = parent ? sc.get(parent) : null;
  if (p && p.type !== 'folder') return fail(res, 400, '目标不是文件夹');

  const declared = parseInt(req.headers['content-length'], 10);
  if (!Number.isFinite(declared) || declared < 0) {
    return fail(res, 411, '上传请求缺少 Content-Length');
  }
  if (declared > CFG.maxUploadBytes) {
    return fail(res, 413, `文件超过上限 ${(CFG.maxUploadBytes / 1048576).toFixed(0)} MB`);
  }
  checkQuota(req.auth.user, sc, declared);

  const client = ossconfig.getClientFor(req.auth.userId);
  const activeCfg = ossconfig.activeFor(req.auth.userId);
  const ossKey = makeOssKeyFor(activeCfg.cfg, name, req.auth.user.username, activeCfg.source !== 'ui-user');

  // 客户端中途断开时，别把半个文件登记进树。
  // 判定逻辑（包括为什么不能用 'close'）见 lib/reqguard.js
  const guard = trackRequest(req);

  const t0 = Date.now();
  try {
    await client.putStream(ossKey, req, {
      contentLength: declared,
      /* 类型按扩展名推断（preview.mimeForUpload），不采信客户端的 Content-Type。
         必须在这里就给对：OSS 不允许在签名阶段覆盖 content-type（实测 400），
         对象落盘那一刻类型就定死了。 */
      mime: preview.mimeForUpload(name),
      headers: {
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
      }
    });
  } catch (e) {
    // 传失败就把半截对象清掉，别留垃圾
    try { await client.delete(ossKey); } catch (_) {}
    if (guard.isAborted()) {
      console.warn(`[upload] 客户端中断，已清理 ${ossKey}`);
      return fail(res, 400, '上传中断');
    }
    console.error('[upload] 失败', e.message);
    return fail(res, 502, '上传到对象存储失败：' + e.message);
  }

  if (guard.isAborted()) {
    try { await client.delete(ossKey); } catch (_) {}
    return fail(res, 400, '上传中断');
  }

  // 落库之前先核对 OSS 上真实大小。传输层出错时长度可能对不上，
  // 登记一个坏的节点比直接报错更糟——用户会以为传成功了。
  let stored = null;
  try {
    const h = await client.head(ossKey);
    stored = parseInt(h.res.headers['content-length'], 10);
  } catch (e) {
    try { await client.delete(ossKey); } catch (_) {}
    return fail(res, 502, '上传后核对失败：' + e.message);
  }
  if (stored !== declared) {
    try { await client.delete(ossKey); } catch (_) {}
    return fail(res, 502, `上传大小不一致（发送 ${declared}，实际 ${stored}），已回滚`);
  }

  const node = await store.mutate(s => scope.open(s, req.auth.userId).addFile({
    name, parentId: parent || null, size: declared, ossKey,
    mime: 'application/octet-stream'
  }));

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[upload] ${node.name} ${(declared / 1048576).toFixed(1)}MB ${sec}s ip=${getIp(req)}`);
  ok(res, { node: pub(node), renamed: node.name !== name ? name : null });
}));

/* ================================================================
   直传（P1）：浏览器 → OSS，本服务只签名和落树
   ----------------------------------------------------------------
   中转模式里全站字节都挤过服务器。直传后服务器只做三件轻的事：
   签发凭证、核对、落树。凭证 15 分钟有效、锁死单个 key、
   限制大小范围 —— 就算被转手，也只能往那一个 key 传东西。
   失败成本核算：complete 之前对象是"孤儿"（树里没有），用户关掉
   标签页就会留下孤儿对象。量小可接受；分片续传那一步再统一回收。
   ================================================================ */

const directUploads = new Map(); // uploadId -> { ossKey, name, parent, userId, mime, expires }

function directSweep() {
  const now = Date.now();
  for (const [id, info] of directUploads) {
    if (now > info.expires) directUploads.delete(id);
  }
}

/** 签发直传凭证 */
app.post('/api/upload/policy', requireAuth, wrap(async (req, res) => {
  const parent = (req.body && req.body.parent) || null;
  const rawName = (req.body && req.body.name) || '';

  const me = req.auth.user;
  if (!ossconfig.activeFor(me.id)) return fail(res, 503, '服务器未配置对象存储，无法上传');

  let name;
  try { name = tree.sanitizeName(rawName); }
  catch (e) { return fail(res, 400, e.message); }

  const sc = scopeOf(req);
  if (parent && !sc.get(parent)) return fail(res, 404, '目标文件夹不存在');
  const p = parent ? sc.get(parent) : null;
  if (p && p.type !== 'folder') return fail(res, 400, '目标不是文件夹');

  const size = parseInt(req.body && req.body.size, 10);
  if (!Number.isFinite(size) || size < 0) return fail(res, 400, '缺少文件大小');
  if (size > CFG.maxUploadBytes) {
    return fail(res, 413, `文件超过上限 ${(CFG.maxUploadBytes / 1048576).toFixed(0)} MB`);
  }
  checkQuota(me, sc, size);

  if (directUploads.size > 5000) directSweep();

  const activeCfg = ossconfig.activeFor(me.id);
  const ossKey = makeOssKeyFor(activeCfg.cfg, name, me.username, activeCfg.source !== 'ui-user');
  const uploadId = crypto.randomBytes(16).toString('hex');

  /* policy 的 conditions：
     - 锁 bucket 和 key：这张凭证只能往这一个地址传
     - content-length-range 卡全站上限；真实大小在 complete 时用 head 核对
     - 强制 attachment，直传上去的对象下载时也不会内联执行 */
  const expiration = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const policy = {
    expiration,
    conditions: [
      { bucket: activeCfg.cfg.bucket },
      { key: ossKey },
      ['content-length-range', 0, CFG.maxUploadBytes],
      { success_action_status: '200' }
    ]
  };
  const policyB64 = Buffer.from(JSON.stringify(policy)).toString('base64');
  const signature = crypto.createHmac('sha1', activeCfg.cfg.keySecret)
    .update(policyB64).digest('base64');

  directUploads.set(uploadId, {
    ossKey, name, parent: parent || null,
    userId: req.auth.userId, mime: '',
    expires: Date.now() + 15 * 60 * 1000
  });

  ok(res, {
    uploadId,
    host: ossconfig.postHost(activeCfg.cfg),
    fields: {
      key: ossKey,
      policy: policyB64,
      OSSAccessKeyId: activeCfg.cfg.keyId,
      signature,
      success_action_status: '200',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
    }
  });
}));

/** 直传完成后核对并落树 */
app.post('/api/upload/complete', requireAuth, wrap(async (req, res) => {
  const uploadId = String((req.body && req.body.uploadId) || '');
  const info = directUploads.get(uploadId);
  if (!info || info.userId !== req.auth.userId) {
    return fail(res, 404, '直传会话不存在或已过期');
  }
  directUploads.delete(uploadId);

  const client = ossconfig.getClientFor(req.auth.userId);
  let stored = 0;
  try {
    const h = await client.head(info.ossKey);
    stored = parseInt(h.res.headers['content-length'], 10);
  } catch (e) {
    return fail(res, 409, '对象存储中未找到该文件，直传可能未完成');
  }
  if (!Number.isFinite(stored)) return fail(res, 502, '核对对象大小失败');
  if (stored > CFG.maxUploadBytes) {
    try { await client.delete(info.ossKey); } catch (_) {}
    return fail(res, 413, '文件超过上限，已删除');
  }

  const mime = String((req.body && req.body.mime) || '').slice(0, 100);
  const node = await store.mutate(s => scope.open(s, req.auth.userId).addFile({
    name: info.name, parentId: info.parent, size: stored, ossKey: info.ossKey,
    mime: mime || 'application/octet-stream'
  }));
  console.log(`[upload] 直传 ${node.name} ${(stored / 1048576).toFixed(1)}MB ip=${getIp(req)}`);
  ok(res, { node: pub(node), renamed: node.name !== info.name ? info.name : null });
}));

/* ================================================================
   分片直传（P1）：大文件 / 弱网
   ----------------------------------------------------------------
   单件 PostObject 一次成型，网络一抖就全重来；分片把文件切成
   8MB 一片，每片独立 PUT、独立重试，断了从断点续。
   断点的"点"存在两处：分片的 ETag 在浏览器 localStorage，
   OSS 侧的已传清单随时可用 listParts 查 —— 刷新页面后重传同一个
   文件，先查 status，已传的片直接跳过。
   孤儿回收在下面 sweepMultipartOrphans：init 了却永远没 complete
   的分片会话，48 小时后 abort 掉，不占用户的存储计费。
   ================================================================ */

const MPART_TTL = 24 * 3600 * 1000;      // 会话本身一天内有效
const MPART_ORPHAN_AGE = 48 * 3600 * 1000; // OSS 侧孤儿分片的回收线
const directMparts = new Map(); // uploadId -> { ossKey, ossUploadId, name, parent, userId, mime, expires }

app.post('/api/upload/mpart/init', requireAuth, wrap(async (req, res) => {
  const parent = (req.body && req.body.parent) || null;
  const rawName = (req.body && req.body.name) || '';
  const size = parseInt(req.body && req.body.size, 10);

  const me = req.auth.user;
  if (!ossconfig.activeFor(me.id)) return fail(res, 503, '服务器未配置对象存储，无法上传');
  let name;
  try { name = tree.sanitizeName(rawName); }
  catch (e) { return fail(res, 400, e.message); }
  if (!Number.isFinite(size) || size <= 0) return fail(res, 400, '缺少文件大小');
  if (size > CFG.maxUploadBytes) {
    return fail(res, 413, `文件超过上限 ${(CFG.maxUploadBytes / 1048576).toFixed(0)} MB`);
  }
  const sc = scopeOf(req);
  if (parent && !sc.get(parent)) return fail(res, 404, '目标文件夹不存在');
  const p = parent ? sc.get(parent) : null;
  if (p && p.type !== 'folder') return fail(res, 400, '目标不是文件夹');
  checkQuota(me, sc, size);

  const activeCfg = ossconfig.activeFor(me.id);
  const ossKey = makeOssKeyFor(activeCfg.cfg, name, me.username, activeCfg.source !== 'ui-user');

  /* 分片大小：8MB 起，保证 1 万片能覆盖到 80GB —— 超过上传上限绰绰有余 */
  const partSize = Math.max(8 * 1024 * 1024, Math.ceil(size / 10000));

  const client = ossconfig.getClientFor(me.id);
  /* 分片直传也必须在这一刻把类型写对：InitiateMultipartUpload 时给的
     Content-Type 会成为最终对象的类型，而 OSS 不允许事后在签名阶段覆盖它。
     同样按扩展名推断，不采信客户端传来的值。 */
  const mime = preview.mimeForUpload(name);
  const r = await client.initMultipartUpload(ossKey, {
    mime,
    headers: { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` }
  }).catch(e => { throw httpErr(502, '初始化分片上传失败：' + e.message); });

  if (directMparts.size > 5000) {
    for (const [id, info] of directMparts) if (Date.now() > info.expires) directMparts.delete(id);
  }
  const uploadId = crypto.randomBytes(16).toString('hex');
  directMparts.set(uploadId, {
    ossKey, ossUploadId: r.uploadId, name, parent: parent || null,
    userId: req.auth.userId,
    mime,
    size, partSize,
    expires: Date.now() + MPART_TTL
  });

  ok(res, {
    uploadId,
    host: ossconfig.postHost(activeCfg.cfg),
    key: ossKey,
    partSize,
    uploaded: [] // init 没有历史；断点续传走 status 接口
  });
}));

/** 查断点：这个会话还活着吗，OSS 上已经躺了哪些片 */
app.get('/api/upload/mpart/status', requireAuth, wrap(async (req, res) => {
  const uploadId = String(req.query.uploadId || '');
  const info = directMparts.get(uploadId);
  if (!info || info.userId !== req.auth.userId) return ok(res, { alive: false });

  const client = ossconfig.getClientFor(req.auth.userId);
  try {
    const r = await client.listParts(info.ossKey, info.ossUploadId, { 'max-parts': 1000 });
    const parts = (r.parts || []).map(x => ({ number: x.number, etag: x.etag }));
    return ok(res, { alive: true, key: info.ossKey, partSize: info.partSize, uploaded: parts });
  } catch (e) {
    /* NoSuchUpload = 会话在 OSS 侧已被 abort/complete，视为不存在 */
    return ok(res, { alive: false });
  }
}));

/** 批量签分片的 PUT URL */
app.post('/api/upload/mpart/sign', requireAuth, wrap(async (req, res) => {
  const uploadId = String((req.body && req.body.uploadId) || '');
  const numbers = req.body && req.body.partNumbers;
  const info = directMparts.get(uploadId);
  if (!info || info.userId !== req.auth.userId) return fail(res, 404, '分片会话不存在或已过期');
  if (!Array.isArray(numbers) || !numbers.length || numbers.length > 100) {
    return fail(res, 400, 'partNumbers 必须是 1-100 个的分片号');
  }
  if (!numbers.every(n => Number.isInteger(n) && n >= 1 && n <= 10000)) {
    return fail(res, 400, '分片号超出范围');
  }
  /* 用哪份配置 init 的，就用哪份配置签：绑了自己桶的用户在这里
     必须用他自己的 AK，拿平台 AK 签他桶里的 key 会被 OSS 拒 403 */
  const cfg = ossconfig.activeFor(req.auth.userId).cfg;
  ok(res, {
    urls: numbers.map(n => ({
      number: n,
      url: ossconfig.signPartUrl(cfg, info.ossKey, info.ossUploadId, n, 15 * 60)
    }))
  });
}));

/** 完成：分片清单核对后合并落树 */
app.post('/api/upload/mpart/complete', requireAuth, wrap(async (req, res) => {
  const uploadId = String((req.body && req.body.uploadId) || '');
  const parts = req.body && req.body.parts;
  const info = directMparts.get(uploadId);
  if (!info || info.userId !== req.auth.userId) return fail(res, 404, '分片会话不存在或已过期');
  if (!Array.isArray(parts) || !parts.length) return fail(res, 400, '缺少分片清单');
  for (const x of parts) {
    if (!Number.isInteger(x.number) || x.number < 1 || x.number > 10000 || typeof x.etag !== 'string') {
      return fail(res, 400, '分片清单格式不对');
    }
  }

  const client = ossconfig.getClientFor(req.auth.userId);
  try {
    await client.completeMultipartUpload(info.ossKey, info.ossUploadId,
      parts.sort((a, b) => a.number - b.number)
        .map(x => ({ number: x.number, etag: x.etag })));
  } catch (e) {
    return fail(res, 502, '合并分片失败：' + e.message);
  }

  directMparts.delete(uploadId);

  let stored = 0;
  try {
    const h = await client.head(info.ossKey);
    stored = parseInt(h.res.headers['content-length'], 10);
  } catch (e) {
    return fail(res, 502, '合并后核对失败：' + e.message);
  }
  if (stored > CFG.maxUploadBytes) {
    try { await client.delete(info.ossKey); } catch (_) {}
    return fail(res, 413, '文件超过上限，已删除');
  }

  const mime = String(info.mime || '').slice(0, 100) || 'application/octet-stream';
  const node = await store.mutate(s => scope.open(s, req.auth.userId).addFile({
    name: info.name, parentId: info.parent, size: stored, ossKey: info.ossKey, mime
  }));
  console.log(`[upload] 分片 ${node.name} ${(stored / 1048576).toFixed(1)}MB ip=${getIp(req)}`);
  ok(res, { node: pub(node), renamed: node.name !== info.name ? info.name : null });
}));

/** 放弃：明确 abort，OSS 侧的分片立刻清掉 */
app.post('/api/upload/mpart/abort', requireAuth, wrap(async (req, res) => {
  const uploadId = String((req.body && req.body.uploadId) || '');
  const info = directMparts.get(uploadId);
  if (!info || info.userId !== req.auth.userId) return fail(res, 404, '分片会话不存在或已过期');
  directMparts.delete(uploadId);
  const client = ossconfig.getClientFor(req.auth.userId);
  try { await client.abortMultipartUpload(info.ossKey, info.ossUploadId); } catch (_) {}
  ok(res, {});
}));

/**
 * 孤儿回收：init 之后从未 complete 的分片会话。
 * 会话表在内存里，重启就丢 —— 所以不能只扫自己的表，得问 OSS：
 * listUploads 列出桶里所有进行中的分片，initiated 超过 48 小时的 abort。
 * 启动后 30 秒跑一次，之后每 6 小时一次。
 */
async function sweepMultipartOrphans() {
  if (!ossconfig.ready()) return;
  try {
    const client = getOss();
    const a = ossconfig.active();
    const r = await client.listUploads({ 'max-uploads': 1000, prefix: a.cfg.prefix + '/' });
    const cutoff = Date.now() - MPART_ORPHAN_AGE;
    let n = 0;
    for (const up of (r.uploads || [])) {
      if (up.initiated && new Date(up.initiated).getTime() < cutoff) {
        try { await client.abortMultipartUpload(up.name, up.uploadId); n++; } catch (_) {}
      }
    }
    if (n) console.log(`[upload] 回收了 ${n} 个超时的分片上传会话`);
  } catch (e) {
    console.warn('[upload] 孤儿分片扫描失败（不影响上传）:', e.message);
  }
}

function httpErr(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

/* ================================================================
   下载（已登录）
   ================================================================ */

app.get('/api/download', requireAuth, wrap((req, res) => {
  const sc = scopeOf(req);
  const node = sc.get(String(req.query.id || ''));
  if (!node) return fail(res, 404, '资源不存在');
  if (node.type !== 'file') return fail(res, 400, '文件夹不能直接下载，请挑一个文件');
  if (!ossconfig.activeFor(node.owner)) return fail(res, 503, '服务器未配置对象存储');

  try {
    const url = signFor(node);
    res.set('Cache-Control', 'no-store');
    ok(res, { url, fileName: node.name, expiresIn: CFG.signTtl });
  } catch (e) {
    console.error('[download] 签名失败', e.message);
    fail(res, 500, '生成下载链接失败');
  }
}));

/* 预览：和下载是**两个独立动作**。
   点文件 = 预览，行尾「⋯ → 下载」= 下载原文件。
   后端不一样的地方只有一处：签链接时 disposition 用 inline，
   并且把 content-type 覆盖成正确的类型。 */
app.get('/api/preview', requireAuth, wrap((req, res) => {
  const sc = scopeOf(req);
  const node = sc.get(String(req.query.id || ''));
  if (!node) return fail(res, 404, '资源不存在');
  if (node.type !== 'file') return fail(res, 400, '文件夹不能预览');
  if (!ossconfig.activeFor(node.owner)) return fail(res, 503, '服务器未配置对象存储');

  const kind = preview.kindOf(node);
  if (!kind) {
    return fail(res, 415, `「${preview.extOf(node.name) || '未知类型'}」不支持在线预览，请下载后查看`);
  }

  try {
    const url = signForPreview(node);
    res.set('Cache-Control', 'no-store');
    ok(res, {
      url, kind, fileName: node.name, size: node.size,
      expiresIn: CFG.signTtl
    });
  } catch (e) {
    console.error('[preview] 签名失败', e.message);
    fail(res, e.status || 500, '生成预览链接失败');
  }
}));

/* ================================================================
   分享
   ================================================================ */

/* ---------------- 分享：一次分享 = 一个链接 + 一个密码 ----------------
 *
 * 「分享」这件事的粒度不是文件，而是「这次发出去的那一组东西」。
 * 多选五个文件，对方该收到一个链接、一个密码，打开后看到这五项；
 * 而不是五条链接五个密码，发的人还得自己一条条对齐。
 *
 * 所以一条分享记录里存的是 items 数组，不是一个 nodeId。
 * 老记录（只有 nodeId）在 shareItems() 里兼容 —— 已经发出去的链接不能失效。
 *
 * 多用户之后还多一条：分享记录带 owner，管理列表只列自己的，
 * 撤销也只能撤自己的。
 */

/** 取出一条分享记录里的条目，统一成数组 */
function shareItems(sh) {
  if (Array.isArray(sh.items) && sh.items.length) return sh.items;
  if (sh.nodeId) return [{ id: sh.nodeId, name: sh.nodeName || '', type: sh.nodeType || 'file' }];
  return [];
}

/** 还活着的那几项。分享出去的文件可能已经被删了 */
function aliveItems(s, sh) {
  return shareItems(sh).filter(it => tree.get(s, it.id));
}

/* 分享人信息，给分享页显示「由 XXX 分享」用。
   两个刻意的取舍：
     · 只给昵称和头像，**不给登录用户名**。username 是登录凭据的一半，
       而分享链接会被转发出去 —— 把用户名印在页面上，等于给爆破的人省一步。
     · 头像超过 20KB 就不带了。头像最大可以到 400KB（data URI 存在
       drive.json 里），把它塞进每次分享请求不划算；前端会退回只显示昵称。
   只在**密码验证通过之后**下发：没通过验证的人连里面是文件还是文件夹
   都不该知道，更不该知道是谁分享的。 */
function sharerOf(s, sh) {
  const u = users.byId(s, sh.owner);
  if (!u) return null;
  const av = String(u.avatar || '');
  return {
    nickname: u.nickname || u.username || '',
    avatar: av.length <= 20000 ? av : ''
  };
}

/** 某个节点在不在这次分享的范围内。有多个根就逐个比一遍 */
function inShareScope(s, sh, id) {
  if (!id) return false;
  return shareItems(sh).some(it => tree.isDescendant(s, it.id, String(id)));
}

/**
 * 面包屑：只给分享范围内的祖先。
 * 外层路径不能给陌生人看 —— 分享「示例目录/升级包」时，对方不该知道
 * 上面还有「示例目录」，更不该知道更上面还有什么。
 */
function shareBreadcrumb(s, sh, node) {
  return tree.ancestorsOf(s, node.id)
    .filter(n => inShareScope(s, sh, n.id))
    .map(pub);
}

/**
 * 这条分享允许对方做什么。
 *
 * 三个开关**相互独立**，因为组合都有实际意义：
 *   只能看不能拿走（培训资料）→ pv 开、dl 关、sv 关
 *   能看能下但别复制到他网盘  → pv 开、dl 开、sv 关
 *   只让对方确认东西在不在    → 三个全关
 *
 * 缺省全开：老分享没有 perm 字段，读出来就是三个 true，
 * **所以不需要数据迁移**。只有真的关掉至少一项时才写这个字段。
 *
 * 名字用短键（pv/dl/sv）是因为它会随每次分享接口下发；
 * 读的地方统一走这个函数，别去直接摸 sh.perm。
 */
function sharePerm(sh) {
  const p = (sh && sh.perm) || {};
  return {
    pv: p.pv !== false,     // 允许在线预览
    dl: p.dl !== false,     // 允许下载原文件
    sv: p.sv !== false,     // 允许保存到自己的网盘
    wm: p.wm !== false      // 页面显示水印
  };
}
function parseShareTtl(body) {
  if (body && body.permanent) return { expireAt: null, ttlHours: null };
  let ms = Number(body && body.ttlMs);
  if (!Number.isFinite(ms) || ms <= 0) {
    const h = parseInt(body && body.ttlHours, 10);
    ms = Number.isFinite(h) && h > 0 ? h * 3600 * 1000 : CFG.shareTtl * 1000;
  }
  ms = Math.min(Math.max(ms, 60 * 1000), 10 * 365 * 24 * 3600 * 1000);
  return { expireAt: Date.now() + ms, ttlHours: Math.round(ms / 3600e3 * 10) / 10 };
}

app.post('/api/share', requireAuth, wrap(async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return fail(res, 400, '没有选中任何东西');

  /* 密码可自定义：4–32 位、不含空白。留空则自动生成 6 位 */
  const customPw = String((req.body && req.body.password) || '').trim();
  if (customPw && (customPw.length < 4 || customPw.length > 32 || /\s/.test(customPw))) {
    return fail(res, 400, '密码要 4–32 位，且不能含空格');
  }
  const password = customPw || auth.makeSharePassword();

  const { expireAt, ttlHours } = parseShareTtl(req.body);
  const uid = req.auth.userId;

  const share = await store.mutate(s => {
    const sc = scope.open(s, uid);
    const items = [];
    const seen = new Set();
    for (const id of ids) {
      /* sc.get 顺带把"分享别人的文件"这条路堵死了 */
      const node = sc.get(id);
      /* 名字存一份快照：节点被删除后，分享管理里仍能显示分享时的名称 */
      if (!node || seen.has(node.id)) continue;
      seen.add(node.id);
      items.push({ id: node.id, name: node.name, type: node.type });
    }
    if (!items.length) {
      const e = new Error('选中的东西都不在了');
      e.status = 404;
      throw e;
    }

    const token = 's_' + crypto.randomBytes(12).toString('hex');

    const rec = {
      token,
      owner: uid,
      items,
      pwHash: auth.hashSharePassword(password),
      createdAt: Date.now(),
      expireAt,
      ttlHours,
      hits: 0
    };
    /* 分享者对接收方的限制（预览 / 下载 / 转存）。
       只有真的关掉至少一项时才写这个字段 —— 全开时什么都不写，
       于是老分享和新分享读出来完全一样，**不需要迁移**。
       非法值一律当"开"处理：宁可多给权限也不要因为一个笔误把人锁在外面。 */
    const pv = !(req.body && req.body.allowPreview === false);
    const dl = !(req.body && req.body.allowDownload === false);
    const sv = !(req.body && req.body.allowSave === false);
    const wm = !(req.body && req.body.allowWatermark === false);
    if (!pv || !dl || !sv || !wm) rec.perm = { pv, dl, sv, wm };
    /* 密码原文加密存一份：分享管理里要能随时复制、改密。
       只存哈希的话，创建完这一刻起密码就再也找不回来了。
       解不开（主密钥更换等）就当没存过，UI 走「未保存原文」。 */
    try { rec.pwEnc = seal(password); } catch (_) {}
    s.shares[token] = rec;

    return { token, password, items, expireAt, ttlHours };
  });

  console.log(`[share] 创建分享，${share.items.length} 项，有效期 ${share.expireAt ? ttlHours + ' 小时' : '永久'}，密码${customPw ? '自定义' : '自动生成'} ip=${getIp(req)}`);
  ok(res, { share: { ...share, url: shareUrl(share.token) } });
}));

/** 改权限：预览 / 下载 / 转存 / 水印，四项独立，可以随时改。
    分享发出去之后需求会变（一开始全开，后来发现被转得到处都是），
    所以必须支持改已有分享 —— 只能删了重建的话，链接和密码都会换掉，
    已经拿到链接的人就用不了了。 */
app.post('/api/share/perm', requireAuth, wrap(async (req, res) => {
  const { token, perm } = req.body || {};
  if (!perm || typeof perm !== 'object') return fail(res, 400, '没有要改的权限');

  const KEYS = ['pv', 'dl', 'sv', 'wm'];
  const patch = {};
  for (const k of KEYS) {
    /* 只认显式传进来的项 —— 没传的保持原样，
       别把调用方没提到的权限给重置了 */
    if (typeof perm[k] === 'boolean') patch[k] = perm[k];
  }
  if (!Object.keys(patch).length) return fail(res, 400, '没有要改的权限');

  const out = await store.mutate(s => {
    const sh = s.shares[String(token || '')];
    if (!sh || sh.owner !== req.auth.userId) return null;
    const cur = sharePerm(sh);
    Object.assign(cur, patch);
    /* 四项全开就把 perm 字段删掉 —— 保持"全开 = 不写字段"这个约定，
       免得库里堆一堆 {pv:true,dl:true,...} 的冗余记录 */
    if (cur.pv && cur.dl && cur.sv && cur.wm) delete sh.perm;
    else sh.perm = cur;
    return sharePerm(sh);
  });
  if (!out) return fail(res, 404, '分享不存在或不属于你');
  console.log(`[share] 改权限 ${String(token).slice(0, 12)}… → ${JSON.stringify(out)} ip=${getIp(req)}`);
  ok(res, { perm: out });
}));

/** 改密：换个密码，原文照旧加密存一份 */
app.post('/api/share/password', requireAuth, wrap(async (req, res) => {
  const { token, password: newPw } = req.body || {};
  const pw = String(newPw || '').trim();
  if (!pw || pw.length < 4 || pw.length > 32 || /\s/.test(pw)) {
    return fail(res, 400, '密码要 4–32 位，且不能含空格');
  }
  const out = await store.mutate(s => {
    const sh = s.shares[String(token || '')];
    if (!sh || sh.owner !== req.auth.userId) return false;
    sh.pwHash = auth.hashSharePassword(pw);
    try { sh.pwEnc = seal(pw); } catch (_) { delete sh.pwEnc; }
    return true;
  });
  if (!out) return fail(res, 404, '分享不存在或不属于你');
  console.log(`[share] 改密 ${String(token).slice(0, 12)}… ip=${getIp(req)}`);
  ok(res, { password: pw });
}));

/** 续期：从「当前剩余有效期的终点」（已过期则从现在）往后加时长。
    permanent=true 直接改成永久。 */
app.post('/api/share/extend', requireAuth, wrap(async (req, res) => {
  const { token, ttlMs, permanent } = req.body || {};
  const uid = req.auth.userId;
  const out = await store.mutate(s => {
    const sh = s.shares[String(token || '')];
    if (!sh || sh.owner !== uid) return null;
    if (permanent) { sh.expireAt = null; sh.ttlHours = null; }
    else {
      const { expireAt, ttlHours } = parseShareTtl({ ttlMs });
      const base = Math.max(Date.now(), sh.expireAt || 0);
      sh.expireAt = base + (expireAt - Date.now());
      sh.ttlHours = ttlHours;
    }
    return { expireAt: sh.expireAt };
  });
  if (!out) return fail(res, 404, '分享不存在或不属于你');
  console.log(`[share] 续期 ${String(token).slice(0, 12)}… ip=${getIp(req)}`);
  ok(res, { expireAt: out.expireAt });
}));

function shareUrl(token) {
  const base = CFG.shareBaseUrl || `http://127.0.0.1:${CFG.port}`;
  return `${base}/s/${token}`;
}

app.get('/api/shares', requireAuth, (req, res) => {
  const s = store.get();
  const now = Date.now();
  const uid = req.auth.userId;

  const list = Object.values(s.shares)
    .filter(x => !x.expireAt || x.expireAt > now)
    /* 只看自己的。老库里没归属的记录在初始化时已经划到第一个账号名下，
       所以这里不会把别人的晒出来，也不会把自己的漏掉。 */
    .filter(x => x.owner === uid)
    .map(x => {
      const items = shareItems(x).map(it => ({ ...it, exists: !!tree.get(s, it.id) }));
      const first = items[0] || { id: null, name: '（内容已空）', type: 'file' };
      let savedPw = null;
      if (x.pwEnc) { try { savedPw = unseal(x.pwEnc); } catch (_) {} }
      return {
        token: x.token,
        items,
        count: items.length,
        /* 单项的字段照样给：分享管理里原有的展示逻辑不用整段重写 */
        nodeId: first.id,
        nodeName: items.length > 1 ? `${first.name} 等 ${items.length} 项` : first.name,
        nodeType: items.length > 1 ? 'mix' : first.type,
        createdAt: x.createdAt, expireAt: x.expireAt, ttlHours: x.ttlHours, hits: x.hits,
        /* 权限要下发，分享管理里要显示"这条限制了哪些" ——
           用户过一阵会忘了自己当初关过什么 */
        perm: sharePerm(x),
        saves: x.saves || 0,
        password: savedPw,
        url: shareUrl(x.token),
        // 只要还剩一项活着，这条分享就还能打开
        nodeExists: items.some(it => it.exists)
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  ok(res, { shares: list });
});

app.post('/api/share/revoke', requireAuth, wrap(async (req, res) => {
  const { tokens } = req.body || {};
  const list = Array.isArray(tokens) ? tokens : [tokens];
  const uid = req.auth.userId;
  const done = await store.mutate(s => list.filter(t => {
    const sh = s.shares[t];
    if (!sh || sh.owner !== uid) return false;   // 撤不到别人的
    delete s.shares[t];
    return true;
  }).length);
  console.log(`[share] 撤销 ${done} 个分享 ip=${getIp(req)}`);
  ok(res, { revoked: done });
}));

/* ---------------- 分享的公开侧（不需要登录） ---------------- */

/** 取分享记录，顺带做过期和"内容还在不在"检查 */
function loadShare(req, res) {
  const token = req.params.token;
  const s = store.get();
  const sh = s.shares[token];
  if (!sh) { fail(res, 404, '分享不存在或已被撤销'); return null; }
  if (sh.expireAt !== null && Date.now() > sh.expireAt) { fail(res, 410, '分享已过期'); return null; }
  /* 发出去的几项可能被删了。还剩一项活的，这次分享就还打得开；
     全没了才算"内容已被删除" —— 早先按单个节点判，删掉那一项就整条失效。 */
  if (!aliveItems(s, sh).length) { fail(res, 404, '分享的内容已被删除'); return null; }
  return sh;
}

/** 分享信息：密码对不对不说，先说要不要密码、还剩多久 */
app.get('/api/share/:token', wrap((req, res) => {
  const sh = loadShare(req, res);
  if (!sh) return;
  res.set('Cache-Control', 'no-store');
  ok(res, {
    // 故意不返回文件名：拿到链接但没密码的人，不该知道里面是什么
    needPassword: true,
    expireAt: sh.expireAt,
    ttlHours: sh.ttlHours,
    brand: CFG.brand
  });
}));

app.post('/api/share/:token/auth', wrap((req, res) => {
  const sh = loadShare(req, res);
  if (!sh) return;

  const key = auth.bucketKey('share:' + sh.token, getIp(req));
  const blocked = auth.rateBlocked(key, CFG.shareMaxAttempts, CFG.shareWindow);
  if (blocked) return fail(res, 429, `尝试次数过多，请 ${blocked} 分钟后再试`);

  const pw = (req.body && req.body.password) || '';
  if (!auth.verifySharePassword(sh.pwHash, pw)) {
    auth.rateFail(key, CFG.shareWindow);
    console.warn(`[share] 密码错误 token=${sh.token.slice(0, 10)}… ip=${getIp(req)}`);
    return fail(res, 401, '密码不对');
  }

  auth.rateClear(key);
  // scrypt 是慢哈希，顺便挡一下脚本
  const { stoken, expire } = auth.issueShareSession(sh.token);
  sh.hits = (sh.hits || 0) + 1;
  store.persist();

  /* root 是分享页的"第一层"：
       单项分享 → 就是那一项（对方直接看到它，或者看到它里面的东西）
       多项分享 → 一个虚拟根，名字叫「分享内容」，孩子就是这几项
     分享页只认 root.id 拼面包屑，虚拟根的 id 取空串 —— 和"顶层"一个意思。 */
  const items = aliveItems(store.get(), sh).map(it => ({ id: it.id, name: it.name, type: it.type }));
  const root = items.length === 1 ? items[0] : { id: '', name: '分享内容', type: 'folder' };

  console.log(`[share] 验证通过 token=${sh.token.slice(0, 10)}… ip=${getIp(req)}`);
  res.set('Cache-Control', 'no-store');
  ok(res, {
    stoken, expire, root, items,
    expireAt: sh.expireAt,
    brand: CFG.brand,
    /* 验证通过之后才告诉对方"这是谁分享的" */
    sharer: sharerOf(store.get(), sh),
    watermark: shareWatermarkText(CFG.brand, sharerOf(store.get(), sh)),
    perm: sharePerm(sh)
  });
}));

/* 已经过了密码的人，回来时凭手里的 stoken 换回分享上下文。
   用途：分享页把 stoken 记在本地，从"登录后转存"跳去主站再跳回来时，
   页面重新加载、内存清了 —— 有这个接口就不必让人再输一遍分享密码。
   注意它**不返回新的 stoken**，只回已经拿到的那些上下文；
   所以这不是"绕过密码"，而是"复用一张已经付出的票"。 */
app.post('/api/share/:token/session', wrap((req, res) => {
  const sh = requireShareScope(req, res);   // 里面已经校验了 stoken 与有效期
  if (!sh) return;

  const items = aliveItems(store.get(), sh).map(it => ({ id: it.id, name: it.name, type: it.type }));
  const root = items.length === 1 ? items[0] : { id: '', name: '分享内容', type: 'folder' };

  res.set('Cache-Control', 'no-store');
  ok(res, {
    stoken: req.query.stoken || req.headers['x-share-token'] || '',
    root, items,
    expireAt: sh.expireAt,
    brand: CFG.brand,
    sharer: sharerOf(store.get(), sh),
    /* 水印文案由服务端拼 —— 品牌名在服务端，前端那份是渲染后的 DOM 文本，
       拿它去拼容易因为间距字符之类的差异对不上。 */
    watermark: shareWatermarkText(CFG.brand, sharerOf(store.get(), sh)),
    /* 分享者设的限制，前端据此决定哪些按钮可用 */
    perm: sharePerm(sh)
  });
}));

/**
 * 水印上要显示的内容：品牌 · 分享人 · 日期。
 *
 * 不加访问者 IP。水印的作用是标明出处、提醒"这份东西是有主的"，
 * 不是追溯 —— 而 IP 会变（切网、重启光猫）、同一出口后面可能是很多人
 * （公司/学校/运营商 NAT），拿它当身份用反而会误导。
 * 真要查一次访问是谁，服务端的访问日志里有完整记录。
 *
 * 已知边界：它挡不住截图和录屏，也不是安全机制 ——
 * 打开开发者工具删掉那个元素就没了。
 */
function shareWatermarkText(brand, sharer) {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const who = (sharer && sharer.nickname) || '';
  /* 空的部分自动省掉，不留多余的间隔符 */
  return [brand, who, day].filter(Boolean).join('  ·  ');
}

/** 分享作用域校验：stoken 有效，且目标节点确实在这棵子树里 */
function requireShareScope(req, res) {
  const sh = loadShare(req, res);
  if (!sh) return null;
  const stoken = req.query.stoken || req.headers['x-share-token'] || '';
  if (!auth.checkShareSession(sh.token, stoken)) {
    fail(res, 401, '请先输入分享密码');
    return null;
  }
  return sh;
}

app.get('/api/share/:token/list', wrap((req, res) => {
  const sh = requireShareScope(req, res);
  if (!sh) return;
  const s = store.get();
  const items = aliveItems(s, sh);
  const parent = String(req.query.parent || '');

  /* 多项目分享的第一屏：不指向任何真实节点，直接把这几项摊开。
     单项分享没有这一层 —— 那种情况直接进去更顺，少点一下。 */
  if (items.length > 1 && !parent) {
    return ok(res, {
      parent: '',
      breadcrumb: [],
      current: { id: '', type: 'folder', name: '分享内容', parent: null, createdAt: null },
      children: items.map(it => pub(tree.get(s, it.id))).filter(Boolean)
    });
  }

  const targetId = parent || (items[0] && items[0].id);
  if (!targetId) return fail(res, 404, '分享的内容已被删除');

  // 关键：不能拿别人的 nodeId 来列目录，必须落在这次分享的范围内
  if (!inShareScope(s, sh, targetId)) {
    return fail(res, 403, '不在本次分享的范围内');
  }
  const p = tree.get(s, targetId);
  if (!p) return fail(res, 404, '文件夹不存在');

  /* 点到的是个文件：没有「列目录」这回事。
     回它自己 + 空子列表，前端就能统一按 current 渲染成一张下载卡。
     早先这里直接回 400「不是文件夹」，后果是"分享单个文件"生成的链接
     打开后一直卡在密码页 —— 表单提交成功，紧接着列目录失败，
     那个错误又被当成密码错误显示出来。 */
  if (p.type !== 'folder') {
    return ok(res, {
      parent: targetId,
      breadcrumb: shareBreadcrumb(s, sh, p),
      current: pub(p),
      children: []
    });
  }

  ok(res, {
    parent: targetId,
    breadcrumb: shareBreadcrumb(s, sh, p),
    current: pub(p),
    children: tree.childrenOf(s, targetId).map(pub)
  });
}));

app.get('/api/share/:token/download', wrap((req, res) => {
  const sh = requireShareScope(req, res);
  if (!sh) return;
  const s = store.get();
  const id = String(req.query.id || '');

  // 越权就在这一行被挡住：只有这次分享范围里的文件才签得出链接
  if (!inShareScope(s, sh, id)) {
    console.warn(`[share] 越权尝试 token=${sh.token.slice(0, 10)}… 目标=${id} ip=${getIp(req)}`);
    return fail(res, 403, '不在本次分享的范围内');
  }

  const node = tree.get(s, id);
  if (!node) return fail(res, 404, '资源不存在');
  if (node.type !== 'file') return fail(res, 400, '文件夹不能直接下载');
  if (!ossconfig.activeFor(node.owner)) return fail(res, 503, '服务器未配置对象存储');

  /* 分享者可以只让看、不让拿走。
     ⚠️ 文案里不要写"请在线查看" —— 预览也可能同时被关掉，
     那样就是一句自相矛盾的提示。只说清哪一项不被允许。 */
  if (!sharePerm(sh).dl) {
    console.warn(`[share] 下载被分享者禁止 token=${sh.token.slice(0, 10)}… ip=${getIp(req)}`);
    return fail(res, 403, '分享者不允许下载');
  }

  const url = signFor(node);
  res.set('Cache-Control', 'no-store');
  ok(res, { url, fileName: node.name, expiresIn: CFG.signTtl });
}));

/* 分享页的预览。和下载一样要过两次范围校验 ——
   不能因为"预览看起来无害"就少校验一次：它能拿到同一条对象的签名。 */
app.get('/api/share/:token/preview', wrap((req, res) => {
  const sh = requireShareScope(req, res);
  if (!sh) return;
  const s = store.get();
  const id = String(req.query.id || '');

  if (!inShareScope(s, sh, id)) {
    console.warn(`[share] 越权预览尝试 token=${sh.token.slice(0, 10)}… 目标=${id} ip=${getIp(req)}`);
    return fail(res, 403, '不在本次分享的范围内');
  }

  const node = tree.get(s, id);
  if (!node) return fail(res, 404, '资源不存在');
  if (node.type !== 'file') return fail(res, 400, '文件夹不能预览');
  if (!ossconfig.activeFor(node.owner)) return fail(res, 503, '服务器未配置对象存储');

  if (!sharePerm(sh).pv) {
    console.warn(`[share] 预览被分享者禁止 token=${sh.token.slice(0, 10)}… ip=${getIp(req)}`);
    return fail(res, 403, '分享者不允许在线预览');
  }

  const kind = preview.kindOf(node);
  if (!kind) {
    return fail(res, 415, `「${preview.extOf(node.name) || '未知类型'}」不支持在线预览，请下载后查看`);
  }

  try {
    const url = signForPreview(node);
    res.set('Cache-Control', 'no-store');
    ok(res, { url, kind, fileName: node.name, size: node.size, expiresIn: CFG.signTtl });
  } catch (e) {
    console.error('[preview] 签名失败', e.message);
    fail(res, e.status || 500, '生成预览链接失败');
  }
}));

/* ================================================================
   保存到我的网盘（转存）
   ----------------------------------------------------------------
   服务端在 OSS 内把对象复制一份到接收者名下 —— 字节不过浏览器、
   不过 ECS，秒级完成。这是它与「下载再上传」的本质区别。

   两条边界，都在下面显式拦住，而不是等 OSS 报错：
     · 接收者绑了自己的桶 → 源在平台桶、目标在他的桶，两套凭证无解
     · 源文件主人绑了自己的桶 → 源根本不在平台桶里
   ================================================================ */

/** 这个分享里的东西能不能被复制。
    能的话顺带把源配置、桶、以及每个文件的归属一起带出来，省得后面重复查。 */
function saveability(s, sh) {
  const items = aliveItems(s, sh);
  if (!items.length) return { ok: false, status: 404, error: '分享的内容已被删除' };

  const ownerCfg = ossconfig.activeFor(sh.owner);
  if (!ownerCfg) return { ok: false, status: 503, error: '服务器未配置对象存储' };

  const files = [];
  let bytes = 0;
  let tooBig = null;
  for (const it of items) {
    for (const n of tree.subtreeIds(s, it.id).map(id => tree.get(s, id))) {
      if (!n || n.type !== 'file') continue;
      const a = ossconfig.activeFor(n.owner);
      /* 同一个分享里的文件理论上都属于分享者，但元数据是可以被改坏的
         （迁移、人工编辑 drive.json）。宁可拒绝，也不要把 A 桶的 key
         当成 B 桶的对象去复制 —— 那会复制出一个内容不相干的文件。 */
      if (!a || a.cfg.bucket !== ownerCfg.cfg.bucket) {
        return { ok: false, status: 409, error: '分享里有文件指向了另一个存储桶，无法转存' };
      }
      if (n.size > COPY_MAX_BYTES && !tooBig) tooBig = n;
      bytes += n.size || 0;
      files.push(n);
    }
  }
  if (!files.length) return { ok: false, status: 404, error: '分享里没有可转存的文件' };
  return { ok: true, items, files, bytes, srcCfg: ownerCfg.cfg, tooBig };
}

/** 接收者这边的可用性 + 配额。返回 null 表示已经回过响应了 */
function receiverReady(req, res, needed) {
  const me = req.auth.user;
  const mine = ossconfig.activeFor(me.id);
  if (!mine) return fail(res, 503, '你没有可用的存储，无法转存');

  /* 跨桶复制做不到（见文件头注释），所以这个限制是硬的，不是暂时的 */
  if (mine.source === 'ui-user') {
    return fail(res, 409, '你绑定了自己的存储，源文件在平台存储上，无法直接转存；请下载后上传');
  }

  const sc = scopeOf(req);
  const quota = me.quotaBytes != null ? me.quotaBytes : CFG.quotaBytes;
  if (me.role !== 'owner' && quota) {
    const used = sc.stats().bytes;
    if (used + needed > quota) {
      return fail(res, 413,
        `空间不足：配额 ${(quota / 1073741824).toFixed(1)} GB，已用 ${(used / 1073741824).toFixed(2)} GB，`
        + `本次需要 ${(needed / 1048576).toFixed(1)} MB`);
    }
  }
  return { me, mine, sc };
}

/** 转存的默认落点。用户可以在页面上换到别的目录 */
const SAVE_FOLDER = '来自分享';

/** 转存前先看看：能不能转、要占多少空间。分享页据此决定按钮状态 */
app.get('/api/share/:token/save-info', requireAuth, wrap(async (req, res) => {
  const sh = requireShareScope(req, res);
  if (!sh) return;
  const s = store.get();
  const ab = saveability(s, sh);
  if (!ab.ok) return fail(res, ab.status, ab.error);

  const me = req.auth.user;
  const mine = ossconfig.activeFor(me.id);
  /* 分享者可以禁止转存。放在最前面判 —— 这是分享者的意愿，
     优先于接收者自己的存储情况（那些是"你存不了"，这是"人家不让存"）。 */
  if (!sharePerm(sh).sv) {
    res.set('Cache-Control', 'no-store');
    return ok(res, {
      canSave: false,
      reason: '分享者不允许转存',
      files: ab.files.length, bytes: ab.bytes,
      defaultFolder: SAVE_FOLDER
    });
  }
  const blocked = !mine
    ? '你没有可用的存储'
    : (mine.source === 'ui-user' ? '你绑定了自己的存储，无法直接转存' : '');

  res.set('Cache-Control', 'no-store');
  ok(res, {
    canSave: !blocked && !ab.tooBig,
    reason: blocked || (ab.tooBig ? `「${ab.tooBig.name}」超过服务端复制上限，请下载后上传` : ''),
    files: ab.files.length,
    bytes: ab.bytes,
    /* 已存在的话前端可以直接把它当默认目录，不用再问一次 */
    defaultFolder: SAVE_FOLDER
  });
}));

app.post('/api/share/:token/save', requireAuth, wrap(async (req, res) => {
  const sh = requireShareScope(req, res);
  if (!sh) return;

  const me = req.auth.user;
  /* 每用户每小时最多 10 次转存，防刷复制请求。
     桶键带小时戳 = 整点自动翻篇，不需要额外清理过期的桶。
     （rateFail 在这个模块里就是"记一次"，不是"记一次失败"。） */
  const rlKey = `${auth.bucketKey('save', me.id)}:${Math.floor(Date.now() / 3600000)}`;
  const blocked = auth.rateBlocked(rlKey, 10, 3600 * 1000);
  if (blocked) return fail(res, 429, `转存太频繁了，请 ${blocked} 分钟后再试`);

  const before = store.get();
  const ab = saveability(before, sh);
  if (!ab.ok) return fail(res, ab.status, ab.error);

  /* 禁止转存的分享，在真正动手之前就拒绝。
     不能只靠前端把按钮置灰 —— 绕过前端直接打这个接口是几行脚本的事，
     而"不允许转存"是分享者明确表达过的意愿，必须在这里挡住。 */
  if (!sharePerm(sh).sv) return fail(res, 403, '分享者不允许转存');

  const ready = receiverReady(req, res, ab.bytes);
  if (!ready) return;

  /* 目标目录：不填就落到「来自分享」下 */
  const wantParent = req.body && req.body.parent ? String(req.body.parent) : null;
  if (wantParent && !ready.sc.get(wantParent)) return fail(res, 404, '目标文件夹不存在');
  if (wantParent && ready.sc.get(wantParent).type !== 'folder') return fail(res, 400, '目标不是文件夹');

  /* 逐文件挑一个目标 key。src == dest 的情况不该出现（两边前缀不同），
     但一旦出现就是"自己复制到自己"，OSS 会报错，不如提前拦掉。 */
  const plan = [];
  for (const n of ab.files) {
    const destKey = makeOssKeyFor(ready.mine.cfg, n.name, me.username, true);
    if (destKey === n.ossKey) return fail(res, 409, '源与目标指向同一个对象，无法转存');
    plan.push({ node: n, destKey });
  }

  /* 先复制字节，全部成功之后才一次性落树 ——
     中途失败的话库里不会多出半截的目录结构。 */
  const done = [];
  for (const p of plan) {
    let r;
    try {
      r = await copyObjectWithin(me.id, p.node.ossKey, p.destKey, p.node.size);
    } catch (e) {
      r = { ok: false, status: 502, error: '复制失败：' + e.message };
    }
    if (!r.ok) {
      /* CopyObject 是原子的，失败不留半个对象；已复制的尽力删掉，
         删不掉也只记日志 —— 留孤儿对象比留半个文件树安全。 */
      for (const d of done) {
        try { await ossconfig.getClientFor(me.id).delete(d.destKey); }
        catch (e) { console.warn('[save] 回滚对象失败', d.destKey, e.message); }
      }
      console.warn(`[save] 转存失败 用户=${me.username} 已回滚 ${done.length} 个对象 ip=${getIp(req)}`);
      return fail(res, r.status || 502, r.error);
    }
    done.push(p);
  }

  /* 复制期间用户可能又传了东西，所以落树前再判一次配额 ——
     前面那次是为了给用户快速反馈，这一次才是准的。 */
  const ready2 = receiverReady(req, res, ab.bytes);
  if (!ready2) {
    for (const d of done) {
      try { await ossconfig.getClientFor(me.id).delete(d.destKey); } catch (_) {}
    }
    return;
  }

  let savedCount = 0;
  let savedBytes = 0;
  const rootId = await store.mutate(s => {
    const sc = scope.open(s, me.id);

    /* 目标根目录：用户选的就用他的，否则找（或建）「来自分享」 */
    let root;
    if (wantParent) {
      root = sc.must(wantParent);
    } else {
      const existing = tree.childrenOf(s, null)
        .find(n => n.owner === me.id && n.type === 'folder' && n.name === SAVE_FOLDER);
      root = existing || tree.createFolder(s, SAVE_FOLDER, null, me.id);
    }

    /* 每个顶层条目还原成它自己的子树。文件夹需要按原结构重建，
       文件直接挂上去 —— 原 key 只用于复制，树里记的是新 key。 */
    const byDest = new Map(done.map(d => [d.node.id, d.destKey]));

    const clone = (srcNode, parentId) => {
      const isFile = srcNode.type === 'file';
      const dest = byDest.get(srcNode.id);
      const nn = isFile
        ? tree.addFile(s, {
            name: srcNode.name, parentId, size: srcNode.size,
            ossKey: dest, mime: srcNode.mime || '', owner: me.id, sha256: srcNode.sha256 || ''
          })
        : tree.createFolder(s, srcNode.name, parentId, me.id);
      if (isFile) { savedCount++; savedBytes += srcNode.size || 0; }
      for (const kid of tree.childrenOf(s, srcNode.id)) clone(kid, nn.id);
      return nn;
    };
    for (const it of ab.items) {
      const n = tree.get(s, it.id);
      if (n) clone(n, root.id);
    }
  });

  auth.rateFail(rlKey, 3600 * 1000);
  sh.saves = (sh.saves || 0) + 1;
  store.persist();
  console.log(`[save] ${me.username} 转存 ${savedCount} 个文件 / ${(savedBytes / 1048576).toFixed(1)}MB`
    + ` 来自 token=${sh.token.slice(0, 10)}… ip=${getIp(req)}`);
  ok(res, { saved: savedCount, bytes: savedBytes });
}));

/* ================================================================
   静态文件：白名单
   ================================================================ */

const PUBLIC_FILES = new Set([
  '/', '/index.html', '/share.html',
  /* 浏览器一定会来要 favicon，不给就一直在 nginx 日志里刷 404。
     用一个内联 SVG 顶上：同一个"多云"标志，不额外引入文件。 */
  '/favicon.svg'
]);

/** 站点图标：内联生成，免得为一个 100 字节的图标再维护一个静态文件。
    颜色写死品牌蓝 —— 图标在浏览器标签上，不跟随页面主题。 */
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#5b8def" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/></svg>`;

app.get('/favicon.svg', (req, res) => {
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(FAVICON);
});

/* 老浏览器/老书签直接要 /favicon.ico：给一个 204，别让它变成 404 噪音 */
app.get('/favicon.ico', (req, res) => res.status(204).end());

// 分享页：/s/<token> 由前端读地址栏里的 token
app.get('/s/:token', (req, res) => res.sendFile(path.join(__dirname, 'share.html')));

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const p = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
  if (PUBLIC_FILES.has(p)) return next();
  res.status(404).type('txt').send('Not Found');
});

/* ================================================================
   兜底错误处理：**必须是最后一个中间件**
   ================================================================

   不挂这个的话，Express 的默认错误页会把完整调用栈渲染成 HTML 返回给客户端。
   实测（畸形 JSON）会回出这种正文：

     SyntaxError: Expected property name or '}' in JSON at position 1
         at parse (/opt/sunlight-drive/node_modules/body-parser/...)
         at /opt/sunlight-drive/node_modules/body-parser/lib/read.js:128:18

   一口气泄露了三样东西：部署绝对路径、技术栈、依赖版本线索。
   攻击者据此可以少做一轮指纹识别，直接挑对应的已知漏洞。

   注意：这类错误不是路由抛的，是 express.json() 解析请求体时产生的 ——
   所以只能靠全局中间件兜，路由里写多少 try/catch 都没用。

   已知边界：走反向代理时 **要确认代理的 400 错误页不会顶掉这里的 JSON**
   （如 nginx 的 error_page 400），否则后端返回什么就看不见了。 */
app.use((err, req, res, _next) => {
  /* 请求体解析失败：body-parser 会带 err.type / err.status，
     但**故意不回显 err.message** —— 那句话里带着出错位置和原文片段。 */
  const type = typeof err.type === 'string' ? err.type : '';
  const isBody = !!(err.expose && type && /^(entity\.|request\.|encoding\.|charset\.)/.test(type));

  const status = isBody ? (err.status || 400)
    : (Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500);

  /* 服务端留完整信息，客户端只拿一句话 —— 排查靠日志，不靠回显 */
  console.error(`[err] ${req.logId || '-'} ${status} ${req.method} ${req.path} — ${err.message}`);
  if (status >= 500) console.error(err.stack);

  if (res.headersSent) return res.end();

  if (isBody) {
    const msg = status === 413 ? '请求体太大' : '请求格式错误';
    /* 带 logId，便于用户报告的故障与服务端日志对应 */
    return res.status(status)
      .json(req.logId ? { ok: false, error: msg, logId: req.logId } : { ok: false, error: msg });
  }
  res.status(status)
    .json(req.logId ? { ok: false, error: '服务器内部错误', logId: req.logId } : { ok: false, error: '服务器内部错误' });
});

app.use(express.static(__dirname, {
  etag: true,
  index: 'index.html',
  setHeaders(res, p) {
    if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

/* ================================================================
   启动
   ================================================================ */

store.load();

/**
 * 首次初始化。
 *
 * 库里一个账号都没有时，把单用户时代的东西收编到第一个账号名下：
 *   · 用 .env 的 SITE_PASSWORD 当密码（老口令可能短于现在的下限，放行）
 *   · .env 的 TOTP_SECRET 一并搬过去，已经绑过验证器的手机不用重绑
 *   · 所有还没归属的节点、分享，以及那份 profile 全部划过去
 * 账号名默认 sunlight，可用 ADMIN_USERNAME 覆盖。
 *
 * 已经有账号了就什么都不做 —— 这段逻辑一辈子只跑一次。
 *
 * @returns {Promise<{adopted:null|object, users:number}>}
 */
async function bootstrap() {
  let adopted = null;
  try {
    adopted = await users.adoptLegacyData({
      username: process.env.ADMIN_USERNAME || 'sunlight',
      password: CFG.password,
      totpSecret: CFG.totpSecret,
      totpDisabled: CFG.totpHardOff,
      brand: CFG.brand
    });
  } catch (e) {
    console.error('[启动] 初始化账号失败：' + e.message);
  }

  const s = store.get();
  const all = users.list(s);
  return { adopted, users: all.length, usersWithTotp: all.filter(users.totpOn).length };
}

/**
 * 起服务前先探一下端口有没有人在听。
 *
 * 为什么需要这道检查：Windows 上 SO_REUSEADDR 允许两个进程绑同一个端口，
 * listen() 不会报 EADDRINUSE。结果就是「新代码起来了，但浏览器和 curl
 * 连到的还是上一个没关干净的旧进程」，表现为新接口一律 404 —— 看起来
 * 像代码写错了，其实是流量压根没进来。这种问题排查起来非常费时间。
 */
function portInUse(port) {
  return new Promise(resolve => {
    const net = require('net');
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 800).unref();
  });
}

/**
 * 真正把服务拉起来。
 *
 * 抽成导出的函数，而不是直接写在 `if (require.main === module)` 里，
 * 是因为 dev.js 要复用它 —— dev.js 是 `require('./server.js')`，
 * 那时 `require.main` 指向 dev.js，条件不成立，服务就永远不会 listen。
 *
 * dev.js 打印完横幅即退出（退出码 0），观感像是「启动成功」，
 * 实际端口并未监听。因此启动逻辑必须能被显式调用。
 */
async function start() {
  if (await portInUse(CFG.port)) {
    console.error('');
    console.error(`  [错误] 端口 ${CFG.port} 已经有服务在监听了。`);
    console.error('         多半是上一次没关掉的服务还在跑，新起的这个收不到请求。');
    console.error('');
    console.error('         先找出并结束它：');
    console.error(`           Windows:  netstat -ano | findstr :${CFG.port}`);
    console.error('                     taskkill /PID <上面那个 PID> /F');
    console.error(`           macOS/Linux:  lsof -ti :${CFG.port} | xargs kill`);
    console.error('');
    console.error(`         或者换个端口： PORT=${CFG.port + 1} node server.js`);
    console.error('');
    process.exit(1);
  }

  const boot = await bootstrap();

  return new Promise(resolve => {
    const server = app.listen(CFG.port, () => {
      console.log('');
      console.log('='.repeat(62));
      for (const [k, v] of describe(boot)) console.log('  ' + String(k).padEnd(10) + ' ' + v);

      const all = users.list(store.get());
      let folders = 0, files = 0, bytes = 0;
      for (const n of Object.values(store.get().nodes)) {
        if (n.type === 'folder') folders++;
        else { files++; bytes += n.size || 0; }
      }
      console.log('  ' + '数据'.padEnd(10) + ` ${folders} 个文件夹 · ${files} 个文件 · ${(bytes / 1073741824).toFixed(2)} GB`);
      console.log('='.repeat(62));
      console.log(`\n  页面  http://127.0.0.1:${CFG.port}\n`);

      if (boot.adopted) {
        console.log(`  [初始化] 把原有数据收编到账号 ${boot.adopted.user.username} 名下`);
        console.log(`           （${boot.adopted.adopted} 个文件/文件夹，口令取自 .env 的 SITE_PASSWORD）`);
        console.log('           已经绑定过验证器的手机不用重新绑。');
        console.log('');
      }

      if (!all.length) {
        console.warn('  [警告] 库里一个账号都没有，而且没有可用的初始口令，谁也登不进去。');
        console.warn('         跑 node dev.js 会自动生成一个 SITE_PASSWORD 并建好第一个账号。');
        console.warn('');
      }

      if (!ossconfig.ready()) {
        console.warn('  [警告] 未配置对象存储：');
        console.warn('         页面、注册登录、新建文件夹、分享都能测，上传/下载会返回 503。');
        console.warn('         可以在页面上用管理员账号 → 头像菜单 → 配置 来填写 OSS 信息。');
        console.warn('');
      }

      /* 孤儿分片回收：启动后 30 秒首扫，之后每 6 小时一次 */
      setTimeout(() => sweepMultipartOrphans().catch(() => {}), 30 * 1000);
      setInterval(() => sweepMultipartOrphans().catch(() => {}), 6 * 3600 * 1000);

      resolve(server);
    });
  });
}

/* 直接 `node server.js` 时自动启动；被 require 时只导出，由调用方决定 */
if (require.main === module) start();

module.exports = app;
module.exports.start = start;
module.exports.bootstrap = bootstrap;
