/**
 * 数据目录的路径解析
 * ------------------------------------------------------------------
 * `DRIVE_DATA_DIR` / `DRIVE_DATA_FILE` 是可选配置项。它们一旦被设成
 * "看起来非空但其实是垃圾"的值，数据会被写到一个谁也想不到的目录里 ——
 * 出问题时极难定位。所以单独钉住这几种边角：
 *
 *   未设置 / 空串 / 只有空格  → 回落到项目 ./data
 *   正常绝对路径              → 用它
 *   带尾随空格的路径          → trim 之后照样用
 *
 * 每个场景起一个子进程：store 是模块级单例，configure 只在 require 时读一次环境变量。
 * 只读它导出的 DATA_DIR / FILE，**不调 load()** —— 那样会在真实项目里建 data/。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STORE = path.join(ROOT, 'lib', 'store.js');

let pass = 0, fail = 0;
const ck = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : ' FAIL '} ${label}${ok ? '' : `   got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

/** 在子进程里 require store.js，读出它解析出的路径（不 load） */
function resolved(envDir, envFile) {
  const code = `
    const s = require(${JSON.stringify(STORE)});
    process.stdout.write(JSON.stringify({ dir: s.DATA_DIR, file: s.FILE }));
  `;
  const env = Object.assign({}, process.env);
  delete env.DRIVE_DATA_DIR; delete env.DRIVE_DATA_FILE;
  if (envDir !== undefined) env.DRIVE_DATA_DIR = envDir;
  if (envFile !== undefined) env.DRIVE_DATA_FILE = envFile;
  const out = execFileSync(process.execPath, ['-e', code], { env, encoding: 'utf8', stdio: 'pipe' });
  return JSON.parse(out);
}

const norm = p => p.replace(/\\/g, '/');
const defaultDir = path.join(ROOT, 'data');

console.log('\n== 1. 没配 → 项目 ./data ==');
{
  const r = resolved(undefined, undefined);
  ck('DATA_DIR 是项目 data/', norm(r.dir), norm(defaultDir));
  ck('FILE 是 data/drive.json', norm(r.file), norm(path.join(defaultDir, 'drive.json')));
}

console.log('\n== 2. 空串 → 仍是项目 ./data ==');
{
  const r = resolved('', '');
  ck('DATA_DIR', norm(r.dir), norm(defaultDir));
}

console.log('\n== 3. 只有空格 → 仍是项目 ./data（这是 trim 存在的理由）==');
{
  const r = resolved('   ', '   ');
  ck('DATA_DIR 没被写成"两个空格"', norm(r.dir), norm(defaultDir));
}

console.log('\n== 4. 正常绝对路径 → 用它 ==');
{
  const custom = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-'));
  const r = resolved(custom, undefined);
  ck('DATA_DIR 指向自定义目录', norm(r.dir), norm(custom));
  ck('FILE 跟着走', norm(r.file), norm(path.join(custom, 'drive.json')));
  fs.rmSync(custom, { recursive: true, force: true });
}

console.log('\n== 5. 带尾随空格的路径 → trim 后仍指向该目录 ==');
{
  const custom = fs.mkdtempSync(path.join(os.tmpdir(), 'dd2-'));
  const r = resolved(custom + '  ', undefined);
  ck('DATA_DIR 已 trim', norm(r.dir), norm(custom));
  fs.rmSync(custom, { recursive: true, force: true });
}

console.log('\n== 6. DRIVE_DATA_FILE 单独指定 ==');
{
  const custom = fs.mkdtempSync(path.join(os.tmpdir(), 'df-'));
  const f = path.join(custom, 'my.json');
  const r = resolved(undefined, f);
  ck('FILE 用指定的文件', norm(r.file), norm(f));
  ck('DATA_DIR 仍是默认（因为没配 DIR）', norm(r.dir), norm(defaultDir));
  fs.rmSync(custom, { recursive: true, force: true });
}

console.log('\n====================================================');
console.log(`\x1b[${fail ? '31' : '32'}m通过 ${pass} 项，失败 ${fail} 项\x1b[0m`);
process.exit(fail ? 1 : 0);
