/**
 * 配置集中处
 * ------------------------------------------------------------------
 * 所有环境变量只在这里读一次，别的地方 require 这个模块。
 * 好处：想知道"这套东西有哪些可调项"，看一个文件就够；启动时也能一次把
 * 配错的地方全报出来，而不是等用户点到某个功能才发现。
 */

const fs = require('fs');
const path = require('path');

const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const ENV_FILE = path.join(__dirname, '..', '.env');

/**
 * 把 .env 读进 process.env。
 * 必须在构造 CFG 之前跑，否则读到的还是空环境。
 * 只填还没设过的键——真实环境变量优先级高于文件，方便运行时临时覆盖。
 *
 * @returns {boolean} 是否存在 .env 文件
 */
function loadDotEnv() {
  if (!fs.existsSync(ENV_FILE)) return false;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 1) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return true;
}

/* 先加载 .env，再读配置。顺序不能反。 */
const dotEnvLoaded = loadDotEnv();

const CFG = {
  /* ---------- 站点 ---------- */
  brand: process.env.BRAND || 'Sunlight云盘',
  port: num(process.env.PORT, 3000),

  /* ---------- 认证 ---------- */
  /* 多用户之后，SITE_PASSWORD 不再是"进门口令"，而是**首个账号的初始密码**。
     库里有用户之后它就退休了：登录比的是用户记录里的哈希，这个值不再参与。
     保留这个名字是为了老部署能原地升级，不用改 .env。 */
  password: process.env.SITE_PASSWORD || '',
  /* 首次初始化时，这个密钥会直接挂到第一个账号上 —— 已经绑过验证器的
     手机不用重新绑。之后每个用户各管各的，不再读这里。 */
  totpSecret: (process.env.TOTP_SECRET || '').trim().toUpperCase(),
  // 手机丢了 / 本地调试时用：初始化时不把老密钥搬过去
  totpHardOff: process.env.TOTP_DISABLED === '1',

  /* 是否开放注册。面向客户时开着，内部自用可以关掉，只留已有账号登录。 */
  registrationOpen: (process.env.REGISTRATION || 'open').toLowerCase() !== 'closed',

  tokenTtl: num(process.env.TOKEN_TTL, 3600),            // 会话 1 小时，滑动续期
  challengeTtl: num(process.env.AUTH_CHALLENGE_TTL, 120), // 输完密码到输动态码之间的窗口
  maxAttempts: num(process.env.MAX_ATTEMPTS, 10),
  attemptWindow: num(process.env.ATTEMPT_WINDOW, 900) * 1000,

  /* ---------- 分享 ---------- */
  shareTtl: num(process.env.SHARE_TTL, 2 * 3600),        // 分享有效期，默认 2 小时
  shareMaxAttempts: num(process.env.SHARE_MAX_ATTEMPTS, 10),
  shareWindow: num(process.env.SHARE_ATTEMPT_WINDOW, 900) * 1000,
  shareBaseUrl: (process.env.SHARE_BASE_URL || '').replace(/\/+$/, ''), // 生成分享链接用

  /* ---------- OSS ---------- */
  region: process.env.OSS_REGION || 'oss-cn-hangzhou',
  keyId: process.env.OSS_KEY_ID || '',
  keySecret: process.env.OSS_KEY_SECRET || '',
  bucket: process.env.OSS_BUCKET || '',
  signTtl: num(process.env.SIGN_TTL, 300),
  // 上传路径前缀。写权限只给这个前缀，泄露了也动不了 release/ 下的老资源
  uploadPrefix: (process.env.OSS_UPLOAD_PREFIX || 'drive').replace(/^\/+|\/+$/g, ''),

  /* ---------- 上传 ---------- */
  maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 2048) * 1024 * 1024,

  /* ---------- 配额 ----------
     每个用户的默认存储上限（GB），0 = 不限。只约束"用平台存储"的用户 ——
     绑了自己桶的人，空间是他自己买单的，不占这里。owner 永远不受限。
     单个用户可在用户管理面板里覆盖这个默认值。 */
  /* 默认 1GB/人：注册开放时（默认 open），不限额等于把 OSS 送给陌生人刷。
     显式设 QUOTA_GB=0 仍可回到不限；绑了自己桶的人，空间是他自己买单的，
     不占这里。owner 永远不受限。单个用户可在用户管理面板里覆盖这个默认值。 */
  quotaBytes: num(process.env.QUOTA_GB, 1) * 1024 * 1024 * 1024
};

/* 少了这些就没法干活，启动时就要拦住。
   SITE_PASSWORD 不在这里 —— 它只在"库里一个账号都没有"时才是必需的，
   判断这件事要看 drive.json，归 server.js 启动时做。 */
CFG.missing = [];
if (!CFG.keyId) CFG.missing.push('OSS_KEY_ID');
if (!CFG.keySecret) CFG.missing.push('OSS_KEY_SECRET');
if (!CFG.bucket) CFG.missing.push('OSS_BUCKET');

CFG.hasOss = !!(CFG.keyId && CFG.keySecret && CFG.bucket);

CFG.DATA_DIR = path.join(__dirname, '..', 'data');
CFG.DATA_FILE = path.join(CFG.DATA_DIR, 'drive.json');
CFG.ENV_FILE = ENV_FILE;
CFG.dotEnvLoaded = dotEnvLoaded;

/**
 * 启动横幅里那段配置摘要。
 * @param {{users?:number, usersWithTotp?:number}} [ctx] 账号情况，由 server.js 传进来
 */
function describe(ctx) {
  const c = ctx || {};
  const lines = [];
  lines.push(['站点品牌', CFG.brand]);
  lines.push(['页面端口', CFG.port]);
  lines.push(['账号数', c.users === undefined ? '—'
    : `${c.users} 个${c.usersWithTotp ? `（其中 ${c.usersWithTotp} 个开了两步验证）` : ''}`]);
  lines.push(['开放注册', CFG.registrationOpen ? '是' : '否（只允许已有账号登录）']);
  lines.push(['初始口令', CFG.password ? '已设置（仅用于建第一个账号）' : '未设置']);
  lines.push(['会话时长', CFG.tokenTtl + ' 秒（滑动续期）']);
  lines.push(['分享有效期', (CFG.shareTtl / 3600).toFixed(1) + ' 小时']);
  lines.push(['上传上限', (CFG.maxUploadBytes / 1048576).toFixed(0) + ' MB']);
  if (CFG.hasOss) {
    lines.push(['对象存储', `${CFG.bucket} @ ${CFG.region}`]);
    lines.push(['上传前缀', CFG.uploadPrefix + '/']);
  } else {
    lines.push(['对象存储', '未配置（页面能开，下载和上传会失败）']);
  }
  return lines;
}

module.exports = { CFG, loadDotEnv, describe };
