/**
 * dev.js 本地启动器的行为
 * ------------------------------------------------------------------
 * 这个脚本是新用户**第一次接触**这个项目时跑的东西，所以它的行为
 * 直接决定"装完能不能用起来"。钉住四件事：
 *
 *   1. 全新目录默认**不生成口令** —— 否则会先把站长建出来，
 *      就永远走不到"第一个注册的账号成为站长"那条路
 *   2. --with-password 才生成口令
 *   3. --password 只读不写（不能悄悄改掉已有口令）
 *   4. 已有的 .gitignore 绝不被覆盖
 *      （写死一份极简内容会在他人仓库里冲掉整份忽略规则）
 *
 * 所有场景都在临时目录里跑，不碰仓库自身。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..');
const NODE = process.execPath;

let pass = 0, fail = 0;
const ck = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : ' FAIL '} ${label}${ok ? '' : `   got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const ckTrue = (label, got, extra) => {
  const ok = !!got; ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : ' FAIL '} ${label}${ok || extra === undefined ? '' : `   got=${JSON.stringify(extra)}`}`);
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-'));
  for (const f of ['dev.js', 'package.json', 'server.js', 'index.html', 'share.html']) {
    fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  }
  fs.cpSync(path.join(SRC, 'lib'), path.join(dir, 'lib'), { recursive: true });
  /* 借用仓库已装好的依赖，免得在临时目录里再装一遍 */
  try { fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch (_) {}
  return dir;
}

function run(dir, args) {
  try {
    return { ok: true, out: execFileSync(NODE, ['dev.js', ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 20000 }) };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
}
const clean = dir => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} };

/* ---------- 1. 全新目录，默认参数 ---------- */
console.log('\n== 1. 全新目录 + 默认参数（应走注册路径）==');
{
  const dir = setup();
  const r = run(dir, ['--password']);
  console.log('    输出: ' + r.out.trim().split('\n').filter(Boolean).map(l => l.trim()).join(' / ').slice(0, 150));

  ck('没有生成 .env（不会先建站长）', fs.existsSync(path.join(dir, '.env')), false);
  /* .gitignore 会被创建，这是**故意的** —— 新目录里得先挡住 .env。
     只在文件不存在时创建，见场景 4。 */
  ck('.gitignore 被创建（保护 .env）', fs.existsSync(path.join(dir, '.gitignore')), true);
  ckTrue('.gitignore 里挡住了 .env', /^\.env$/m.test(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')));
  ck('提示里没有"生成了口令"', /已生成访问密码/.test(r.out), false);
  ck('不打印 undefined', /undefined/.test(r.out), false);
  ckTrue('说清了当前没有口令', /没有设置访问密码/.test(r.out), r.out.slice(0, 160));
  clean(dir);
}

/* ---------- 2. --with-password ---------- */
console.log('\n== 2. --with-password（应生成口令）==');
{
  const dir = setup();
  const r = run(dir, ['--with-password']);
  const envPath = path.join(dir, '.env');
  ck('生成了 .env', fs.existsSync(envPath), true);
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(/^SITE_PASSWORD=(.+)$/m);
    ckTrue('SITE_PASSWORD 有值且够长', m && m[1].trim().length >= 12, m && m[1].length);
  }
  ckTrue('提示说了"作为站长口令"', /站长口令/.test(r.out), r.out.slice(0, 140));
  clean(dir);
}

/* ---------- 3. --password 只读 ---------- */
console.log('\n== 3. --password 只读（不能改已有 .env）==');
{
  const dir = setup();
  const envPath = path.join(dir, '.env');
  const original = 'SITE_PASSWORD=EXISTING-PASSWORD-123\n';
  fs.writeFileSync(envPath, original, 'utf8');
  const before = fs.statSync(envPath).mtimeMs;
  const r = run(dir, ['--password']);
  ck('内容没被改写', fs.readFileSync(envPath, 'utf8'), original);
  ckTrue('打印的是已有口令', /EXISTING-PASSWORD-123/.test(r.out), r.out.slice(0, 120));
  ck('mtime 没变（确实没写入）', fs.statSync(envPath).mtimeMs, before);
  clean(dir);
}

/* ---------- 4. 已有 .gitignore 不被覆盖 ---------- */
console.log('\n== 4. 已有 .gitignore 绝不被覆盖 ==');
{
  const dir = setup();
  const giPath = path.join(dir, '.gitignore');
  const custom = '# 我的规则\n.env\nsecret/\n*.bak\n';
  fs.writeFileSync(giPath, custom, 'utf8');
  run(dir, ['--password']);
  ck('内容一字未动', fs.readFileSync(giPath, 'utf8'), custom);
  clean(dir);
}

console.log('\n====================================================');
console.log(`\x1b[${fail ? '31' : '32'}m通过 ${pass} 项，失败 ${fail} 项\x1b[0m`);
process.exit(fail ? 1 : 0);
