/**
 * 密码哈希与常量时间比较
 * ------------------------------------------------------------------
 * 抽成单独一个文件，是因为现在有两个地方要存密码：
 *   · 用户的登录密码（lib/users.js）
 *   · 分享的 6 位临时密码（lib/auth.js）
 * 两处必须用同一套参数。各写一份实现，迟早会在某次调参后不一致 ——
 * 那种 bug 不报错，只会让一部分密码永远验证不过，排查起来很费时间。
 *
 * 为什么是 scrypt 而不是 bcrypt / argon2：Node 内置，不用引第三方依赖，
 * 而这个项目从头到尾保持零依赖。
 * N=16384 / r=8 / p=1 是 Node 的默认档，一次约 60–100ms —— 正常登录无感，
 * 对爆破脚本是每秒十几次的硬上限。
 *
 * 存储格式：scrypt$<salt-base64>$<dk-base64>
 * 盐是每条记录随机生成的，所以同一个密码存两次长得完全不一样。
 */

const crypto = require('crypto');

const PARAMS = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;

/**
 * 常量时间比较。
 *
 * 普通的 === 比到第一个不同的字符就返回，用时随"相同前缀有多长"变化，
 * 理论上能被逐位试探出来。timingSafeEqual 的时间只跟长度有关。
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);   // 长度不同也走一次，别靠长度提前返回
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

const randomHex = (n) => crypto.randomBytes(n).toString('hex');

/** 生成一条可直接入库的哈希 */
function hash(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password), salt, KEYLEN, PARAMS);
  return `scrypt$${salt.toString('base64')}$${dk.toString('base64')}`;
}

/**
 * 校验。
 * 任何异常都当成"不通过" —— 存坏了的哈希不该把接口打成 500，
 * 那等于给了一个「这个账号的哈希格式特殊」的信号。
 */
function verify(stored, password) {
  try {
    const [alg, saltB64, dkB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const want = Buffer.from(dkB64, 'base64');
    if (!salt.length || !want.length) return false;
    const got = crypto.scryptSync(String(password), salt, want.length, PARAMS);
    return crypto.timingSafeEqual(want, got);
  } catch (_) {
    return false;
  }
}

module.exports = { safeEqual, hash, verify, randomHex, PARAMS, KEYLEN };
