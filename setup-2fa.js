#!/usr/bin/env node
/**
 * 双因素（TOTP）配置向导
 * ------------------------------------------------------------------
 * 用法：
 *   node setup-2fa.js            生成密钥、写进 .env、让你当场验一遍
 *   node setup-2fa.js --yes      同上，但不做交互验证（脚本化部署、自动化测试用）
 *   node setup-2fa.js --show     只显示当前密钥，不改动
 *   node setup-2fa.js --off      关掉双因素（把 .env 里的 TOTP_SECRET 清空）
 *
 * 为什么要「当场验一遍」：密钥必须和手机里存的一模一样，动态码才算得对。
 * 如果只是生成完就完事，等你哪天真的需要登录时才发现对不上，那时候
 * 网站就进不去了。这里强制校验一次，确保配置是好的。
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const totp = require('./lib/totp');

const ENV_FILE = path.join(__dirname, '.env');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

/* ---------------- .env 读写 ---------------- */

function readEnvText() {
  return fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
}

function currentSecret() {
  for (const line of readEnvText().split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith('#') || !s) continue;
    const i = s.indexOf('=');
    if (i > 0 && s.slice(0, i).trim() === 'TOTP_SECRET') {
      return s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

/** 在 .env 里设置一个键：有就替换，没有就追加。其余内容原样保留 */
function setEnvKey(key, value) {
  const text = readEnvText();
  const lines = text.split(/\r?\n/);
  let found = false;
  const out = lines.map(line => {
    const i = line.indexOf('=');
    if (i > 0 && line.trim().startsWith('#') === false && line.slice(0, i).trim() === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    if (out.length && out[out.length - 1] !== '') out.push('');
    out.push(`${key}=${value}`);
  }
  fs.writeFileSync(ENV_FILE, out.join('\n'), 'utf8');
}

/* ---------------- 主体 ---------------- */

const ask = (q) => new Promise(resolve => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, ans => { rl.close(); resolve(ans.trim()); });
});

(async function main() {
  if (!fs.existsSync(ENV_FILE)) {
    console.error('没找到 .env。先跑一次 node dev.js，它会生成一个。');
    process.exit(1);
  }

  /* ---- --off ---- */
  if (has('--off')) {
    setEnvKey('TOTP_SECRET', '');
    console.log('已关闭双因素：.env 里的 TOTP_SECRET 已清空。');
    console.log('重启服务后，登录只需要密码。');
    process.exit(0);
  }

  /* ---- --show ---- */
  if (has('--show')) {
    const s = currentSecret();
    if (!s) {
      console.log('当前未开启双因素（TOTP_SECRET 为空）。');
      console.log('要开启就跑： node setup-2fa.js');
    } else {
      console.log('');
      console.log('  当前密钥   ' + s);
      console.log('  验证器 URI ' + totp.otpauthUri(s, 'sunlight'));
      console.log('');
      console.log('  此刻的动态码应是： ' + totp.code(s) + `（还有 ${totp.secondsLeft()} 秒）`);
    }
    process.exit(0);
  }

  /* ---- 生成 ---- */
  const old = currentSecret();
  const skipAsk = has('--yes') || !process.stdin.isTTY;

  if (old && !skipAsk) {
    console.log('');
    console.log('注意：已经有一个密钥了。');
    console.log('  继续会覆盖它，手机里原有的条目将失效，需要重新添加。');
    const a = await ask('  确认覆盖？输入 yes 继续： ');
    if (a.toLowerCase() !== 'yes') {
      console.log('  已取消，什么都没改。');
      process.exit(0);
    }
  }
  if (old && skipAsk) console.log('  已存在密钥，直接覆盖（--yes / 非交互模式）。');

  const secret = totp.generateSecret();
  const uri = totp.otpauthUri(secret, 'sunlight');

  setEnvKey('TOTP_SECRET', secret);

  console.log('');
  console.log('='.repeat(64));
  console.log('  双因素密钥已生成并写入 .env');
  console.log('='.repeat(64));
  console.log('');
  console.log('  密钥（手输用这个）：');
  console.log('');
  console.log('      ' + secret);
  console.log('');
  console.log('  验证器 URI（支持扫码/导入的工具可以用这个）：');
  console.log('      ' + uri);
  console.log('');
  console.log('-' .repeat(64));
  console.log('  怎么加到手机里（任选一个 App）：');
  console.log('');
  console.log('   Google Authenticator / Microsoft Authenticator /');
  console.log('   Authy / 1Password / 微信小程序「TOTP 验证器」都可以');
  console.log('');
  console.log('   1. 打开 App，选「添加账户」→「手动输入密钥」');
  console.log('   2. 账户名随便写（比如 sunlight）');
  console.log('   3. 密钥粘贴上面那串（大小写不敏感，空格可忽略）');
  console.log('   4. 类型选「基于时间 / TOTP」，位数 6，周期 30 秒');
  console.log('-' .repeat(64));
  console.log('');
  console.log('  现在打开 App，把当前显示的 6 位数字输进来，验证一下配对了没。');
  console.log('');

  if (skipAsk) {
    console.log('  已跳过交互验证（--yes / 非交互模式）。');
    console.log('  想核对的话跑： node setup-2fa.js --show   它会显示此刻应该出现的码。');
    console.log('');
    return;
  }

  const input = await ask('  动态码： ');
  if (!input) {
    console.log('');
    console.log('  跳过了验证。密钥已经写进 .env，但没确认过。');
    console.log('  强烈建议现在跑一次  node setup-2fa.js --show  看看当前的码对不对得上。');
    process.exit(0);
  }

  if (totp.verify(secret, input, { preventReplay: false })) {
    console.log('');
    console.log('  对上了，双因素配置成功。');
    console.log('  重启服务（Ctrl+C 后重跑 node dev.js）即可生效。');
    console.log('');
    console.log('  万一以后手机丢了进不去：在服务器上跑 node setup-2fa.js --off 就能临时关掉，');
    console.log('  或者手工把 .env 里的 TOTP_SECRET 清空再重启。');
  } else {
    console.log('');
    console.log('  对不上。可能的原因：');
    console.log('    · 手机和这台电脑的时间不一致（TOTP 对时间很敏感，差 30 秒就废）');
    console.log('    · 密钥粘贴时漏字符或多字符');
    console.log('    · App 里周期设成了 60 秒而不是 30 秒');
    console.log('');
    console.log('  密钥仍然写进 .env 了。修好之后跑  node setup-2fa.js --show');
    console.log('  它会显示此刻应该出现的码，拿来跟手机对。');
    console.log('  想换一个密钥就重新跑本脚本，或者用 --off 关掉。');
  }
  console.log('');
})().catch(e => { console.error(e.message); process.exit(1); });
