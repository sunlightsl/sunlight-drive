/**
 * TOTP（RFC 6238）+ base32（RFC 4648）
 * ------------------------------------------------------------------
 * 就是「密码 + 验证器 App 每 30 秒蹦出来的 6 位数字」里的后半截。
 * 全部用 Node 自带 crypto 实现，不引第三方包——这种东西依赖越少越好，
 * 而且总共不到 80 行，看得懂比省事重要。
 *
 * 算法：HMAC-SHA1(密钥, 时间片序号)，取摘要做动态截断，再对 10^6 取模。
 * 时间片 = floor(unix秒 / 30)。
 *
 * 容差：验证时同时接受前一片和后一片（±30 秒）。
 * 因为手机和服务器的时钟很难精确对齐，卡死在当前片会让用户莫名其妙失败。
 * 提高容差等于扩大爆破窗口，±1 步（3 个可能值，10^6 里猜中概率 3e-6）是通行做法。
 */

const crypto = require('crypto');

const STEP = 30;          // 秒
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/* ---------------- base32 ---------------- */

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('密钥里有非 base32 字符：' + ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* ---------------- TOTP ---------------- */

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  // JS 的位运算只有 32 位，高 4 字节用除法算，别用 <<
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

const counterAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);

/** 生成一个标准长度的随机密钥（160 位，Google Authenticator 默认长度） */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** 当前应该显示的那 6 位，主要给测试和自己对时用 */
function code(secretB32, ms = Date.now()) {
  return hotp(base32Decode(secretB32), counterAt(ms));
}

/** 还剩几秒换下一个码，用于界面上倒计时提醒 */
function secondsLeft(ms = Date.now()) {
  return STEP - (Math.floor(ms / 1000) % STEP);
}

/* 已用过的 (密钥指纹, 时间片)，防同一个码在有效期内被重放 */
const usedCounters = new Map();

/**
 * 校验用户输入的 6 位码，并说明失败原因。
 *
 * 为什么要区分原因：防重放会让「同一个 30 秒窗口内不能成功登录两次」。
 * 用户登出后马上再登，手机上显示的码明明是对的，却得到一句"动态码不对"，
 * 会以为是密钥配错了。区分出 replayed 之后，就能给他一句能照做的提示。
 *
 * @param {string} secretB32 服务端保存的密钥
 * @param {string} input     用户输入的（允许带空格）
 * @param {object} opts      { window: 1, preventReplay: true }
 * @returns {{ok:boolean, reason:'ok'|'format'|'mismatch'|'replayed'}}
 */
function verifyCode(secretB32, input, opts = {}) {
  const window = opts.window == null ? 1 : opts.window;
  const preventReplay = opts.preventReplay !== false;

  const codeIn = String(input || '').replace(/\D/g, '');
  if (codeIn.length !== DIGITS) return { ok: false, reason: 'format' };

  const secret = base32Decode(secretB32);
  const now = counterAt();
  let replayed = false;

  for (let d = -window; d <= window; d++) {
    const c = now + d;
    const expect = hotp(secret, c);

    // 常量时间比较，别让响应时间差漏出"前几位对了"
    const a = Buffer.from(expect);
    const b = Buffer.from(codeIn);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) continue;

    // 码是对的，但这一片已经被用掉了 —— 记下来，最后好给准确提示
    if (preventReplay && usedCounters.has(secretB32 + ':' + c)) {
      replayed = true;
      continue;
    }

    if (preventReplay) {
      usedCounters.set(secretB32 + ':' + c, Date.now());
      // 清掉过期的记录，别让 Map 无限涨
      for (const [k, t] of usedCounters) {
        if (Date.now() - t > STEP * 1000 * 4) usedCounters.delete(k);
      }
    }
    return { ok: true, reason: 'ok' };
  }

  return { ok: false, reason: replayed ? 'replayed' : 'mismatch' };
}

/** 只要布尔结果的旧接口，保持向后兼容 */
function verify(secretB32, input, opts) {
  return verifyCode(secretB32, input, opts).ok;
}

/** 清空防重放记录。只有测试需要用，正常运行不该调 */
function resetReplay() { usedCounters.clear(); }

/** 丢给验证器 App 的标准 URI；手输密钥时也用它 */
function otpauthUri(secretB32, account, issuer = 'sunlight') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP)
  });
  return `otpauth://totp/${label}?${q}`;
}

module.exports = {
  STEP, DIGITS,
  base32Encode, base32Decode,
  generateSecret, code, verify, verifyCode, resetReplay, secondsLeft, otpauthUri,
  counterAt, _hotp: hotp
};
