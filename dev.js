#!/usr/bin/env node
/**
 * 本地测试启动器
 * ------------------------------------------------------------------
 * 用法（双击 run-local.cmd 也行）：
 *   node dev.js
 *   node dev.js --port 3000
 *   node dev.js --with-password      # 生成站长口令（走"先定口令"那条路）
 *   node dev.js --reset-password     # 重新生成站长口令
 *   node dev.js --password            # 只打印当前口令，不启动
 *
 * 它做四件事：
 *   1. 把 .env 里的变量加载成环境变量
 *   2. 缺依赖时给出准确的安装命令
 *   3. 启动 server.js
 *   4. 打印该走哪条路（注册第一个账号 / 用口令登录）
 *
 * **默认不生成口令** —— 本项目的行为是「空库里第一个注册的账号成为站长」，
 * 一旦 .env 里有 SITE_PASSWORD，启动时就会先建出站长，注册的人只能当成员。
 * 想用那种做法加 --with-password。
 *
 * 为什么要绕一层 .env：密码如果写在启动命令里（`SITE_PASSWORD=xxx node server.js`），
 * 会进 shell history、会进进程列表，机器上其他账号 `ps` 就能看见。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_FILE = path.join(__dirname, '.env');
const GITIGNORE = path.join(__dirname, '.gitignore');

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const getFlag = n => argv.includes(n);
const getVal = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

/* ---------------- .env 读写 ---------------- */
function readEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    let v = s.slice(i + 1).trim();
    // 去掉两边可能有的引号
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      v = v.slice(1, -1);
    }
    out[s.slice(0, i).trim()] = v;
  }
  return out;
}

function writeEnv(obj) {
  const body = [
    '# Sunlight 云盘配置。这个文件不要提交到 git。',
    '# 改完重启 dev.js 生效。',
    '',
    '# 站点品牌名（显示在页面左上角）',
    `BRAND=${obj.BRAND || 'Sunlight云盘'}`,
    '',
    '# 访问密码 —— 登录第一步要输的就是它',
    `SITE_PASSWORD=${obj.SITE_PASSWORD || ''}`,
    '',
    '# 双因素（TOTP）。留空 = 只校验密码。',
    '# 跑 node setup-2fa.js 会自动生成密钥、写进这里，并当场验证一遍。',
    `TOTP_SECRET=${obj.TOTP_SECRET || ''}`,
    '# 临时关掉动态码（手机丢了 / 本地调试用）。设 1 = 只留密码。',
    `TOTP_DISABLED=${obj.TOTP_DISABLED || '0'}`,
    '',
    '# OSS 配置。不填也能测页面、登录、新建文件夹、分享；',
    '# 上传和下载会返回 503（预期行为）。',
    `OSS_REGION=${obj.OSS_REGION || 'oss-cn-hangzhou'}`,
    `OSS_KEY_ID=${obj.OSS_KEY_ID || ''}`,
    `OSS_KEY_SECRET=${obj.OSS_KEY_SECRET || ''}`,
    `OSS_BUCKET=${obj.OSS_BUCKET || ''}`,
    '# 上传的存放前缀。写权限建议只给这个前缀，泄露了也动不了 release/ 下的老资源。',
    `OSS_UPLOAD_PREFIX=${obj.OSS_UPLOAD_PREFIX || 'drive'}`,
    '',
    '# 会话 / 签名链接有效期（秒）',
    `TOKEN_TTL=${obj.TOKEN_TTL || '3600'}`,
    `SIGN_TTL=${obj.SIGN_TTL || '300'}`,
    '# 输完密码到输动态码之间的窗口（秒）',
    `AUTH_CHALLENGE_TTL=${obj.AUTH_CHALLENGE_TTL || '120'}`,
    '',
    '# 登录失败限流：单个 IP 在窗口内最多失败几次（0 关掉限流，只建议本地调试）',
    `MAX_ATTEMPTS=${obj.MAX_ATTEMPTS || '10'}`,
    `ATTEMPT_WINDOW=${obj.ATTEMPT_WINDOW || '900'}`,
    '',
    '# 分享：默认有效期（秒），以及分享密码的尝试上限',
    `SHARE_TTL=${obj.SHARE_TTL || '7200'}`,
    `SHARE_MAX_ATTEMPTS=${obj.SHARE_MAX_ATTEMPTS || '10'}`,
    `SHARE_ATTEMPT_WINDOW=${obj.SHARE_ATTEMPT_WINDOW || '900'}`,
    '# 生成分享链接用的站点地址。部署到云端后填真实域名，否则会生成 127.0.0.1 的链接。',
    '# 例：SHARE_BASE_URL=https://pan.example.com',
    `SHARE_BASE_URL=${obj.SHARE_BASE_URL || ''}`,
    '',
    '# 单文件上传上限（MB）',
    `MAX_UPLOAD_MB=${obj.MAX_UPLOAD_MB || '2048'}`,
    ''
  ].join('\n');
  fs.writeFileSync(ENV_FILE, body, 'utf8');
}

/* 去掉容易看错的字符（I l O 0 1），方便手输和口头转达 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function makePassword(len = 16) {
  const buf = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return s;
}

/* ---------------- 依赖检查 ---------------- */
function ensureDeps() {
  const need = ['express', 'ali-oss'];
  const missing = [];
  for (const m of need) {
    try { require.resolve(m); } catch (_) {
      /* 允许从环境变量指定的目录借用依赖（比如把 node_modules 装在项目外面，
         或者用某个托管运行时提供的依赖）。这是可选的，不设就走正常 npm install。 */
      const fallback = process.env.NODE_MODULES_DIR
        || path.join(process.env.USERPROFILE || process.env.HOME || '', '.node_modules_shared');
      try {
        require.resolve(m, { paths: [fallback] });
        if (!module.paths.includes(fallback)) module.paths.push(fallback);
      } catch (_2) {
        missing.push(m);
      }
    }
  }
  if (missing.length) {
    console.error('\n缺少依赖：' + missing.join(', '));
    console.error('在本目录执行一次即可：\n');
    console.error('    npm init -y && npm i express ali-oss\n');
    process.exit(1);
  }
}

/* ---------------- 主流程 ---------------- */
const env = readEnv();

if (getFlag('--reset-password')) {
  env.SITE_PASSWORD = makePassword();
  writeEnv(env);
  console.log('已重新生成访问密码并写入 .env');
}

/* 默认**不自动生成 SITE_PASSWORD**。
   这是有意的：本项目的行为是「空库里第一个注册的账号成为站长」，
   而只要 .env 里有 SITE_PASSWORD，启动时就会先把站长建出来 ——
   第一个注册的人就只能当普通成员。
   本地跑的时候要和线上行为一致，所以默认走注册。

   想用"先定口令、启动即有站长"那条路，加 --with-password 显式要一个。 */
if (getFlag('--with-password') && !env.SITE_PASSWORD) {
  env.SITE_PASSWORD = makePassword();
  writeEnv(env);
  console.log('已生成访问密码并写入 .env（将以它作为站长口令）');
}

/* 顺手把 .env 挡在 git 外面。
   只在文件**不存在**时创建 —— 已有 .gitignore（比如仓库自带的那个）绝不动。
   早先这里写死了一份极简内容，在别人的仓库里跑会把原有的忽略规则整个覆盖掉。 */
if (!fs.existsSync(GITIGNORE)) {
  fs.writeFileSync(GITIGNORE, ['node_modules/', '.env', '*.log', ''].join('\n'), 'utf8');
  console.log('已创建 .gitignore（挡住 .env 和 node_modules）');
}

if (getFlag('--password')) {
  /* 没设口令是**正常状态**（默认走"注册第一个账号"那条路），
     所以这里不能把 undefined 打到屏幕上，得说清当前是什么情况。 */
  console.log('');
  if (env.SITE_PASSWORD) {
    console.log('  当前访问密码： ' + env.SITE_PASSWORD);
  } else {
    console.log('  没有设置访问密码 —— 这是默认状态。');
    console.log('  打开页面注册第一个账号，它会成为站长。');
    console.log('  想改用"先定口令"那条路：node dev.js --with-password');
  }
  console.log('');
  process.exit(0);
}

/* 变量灌进环境，server.js 会在 require 时读走 */
for (const [k, v] of Object.entries(env)) {
  if (v !== '') process.env[k] = v;
}
process.env.PORT = getVal('--port', process.env.PORT || '3000');

ensureDeps();

const hasOss = !!(env.OSS_KEY_ID && env.OSS_KEY_SECRET && env.OSS_BUCKET);

console.log('');
console.log('='.repeat(60));
console.log('  Sunlight 云盘 · 本地测试');
console.log('='.repeat(60));
console.log('  页面地址    http://127.0.0.1:' + process.env.PORT);
/* 没有 SITE_PASSWORD 时打印的不是"缺配置"，而是当前该走的流程 ——
   否则第一次跑的人会以为自己少配了一样东西。 */
console.log('  站长账号    ' + (env.SITE_PASSWORD
  ? (env.ADMIN_USERNAME || 'sunlight') + '（口令见下）'
  : '还没有 —— 打开页面注册第一个账号，它自动成为站长'));
console.log('  访问密码    ' + (env.SITE_PASSWORD || '（未设置：走首次注册）'));
console.log('  双因素      ' + (env.TOTP_SECRET && env.TOTP_DISABLED !== '1'
  ? '已开启（密码 + 动态码）'
  : (env.TOTP_DISABLED === '1' ? '已配置但被 TOTP_DISABLED 关掉了' : '未开启（只有密码）')));
console.log('  配置文件    ' + ENV_FILE);
console.log('');
if (hasOss) {
  console.log('  OSS         已配置（' + env.OSS_BUCKET + ' @ ' + env.OSS_REGION + '）');
  console.log('              上传会真的写进 ' + (env.OSS_UPLOAD_PREFIX || 'drive') + '/ 前缀下');
} else {
  console.log('  OSS         未配置');
  console.log('              页面、登录、新建文件夹、改名、移动、分享都能测');
  console.log('              上传和下载会返回 503（预期行为）');
}
console.log('');
console.log('  常用测试');
console.log('    输错密码 10 次 → 看是否被锁 15 分钟（想快点测可把 .env 里');
console.log('    MAX_ATTEMPTS 改 3、ATTEMPT_WINDOW 改 60、SHARE_MAX_ATTEMPTS 改 3）');
console.log('    开双因素： node setup-2fa.js   （--show 看当前密钥和此刻的码）');
console.log('    手机丢了： .env 里 TOTP_DISABLED=1 先把自己放进来，再重配');
console.log('    分享一个文件夹 → 用无痕窗口打开链接 → 输错密码 → 直接改地址栏');
console.log('      里的 ?parent= 参数成别的 id → 应该被 403 挡住（越权防护）');
console.log('    Ctrl+C 停止');
console.log('='.repeat(60));
console.log('');

/* 必须显式调 start()。写成 require('./server.js') 是不行的：
   server.js 里的启动逻辑包在 `if (require.main === module)` 里，
   而在 dev.js 上下文里 require.main 指向 dev.js，条件不成立，
   结果是打印完横幅进程就退出，端口上什么都没起。 */
require('./server.js').start();
