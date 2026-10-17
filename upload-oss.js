#!/usr/bin/env node
/**
 * 把资源目录里的安装包批量传到 OSS
 * ------------------------------------------------------------------
 * 用法：
 *   node upload-oss.js --src "<源目录>"                # 预演，只打印要传什么
 *   node upload-oss.js --src "<源目录>" --go           # 真传
 *   node upload-oss.js --src "<源目录>" --go --only 升级包
 *   node upload-oss.js --src "<源目录>" --go --id <批次标识>
 *   node upload-oss.js --src "<源目录>" --go --force   # 忽略已存在，全部重传
 *
 * 参数：
 *   --src    <目录>   资源源目录（必填）
 *   --manifest <文件> 清单文件，默认同目录 assets.json
 *   --go              真的上传；不加就是 dry-run
 *   --force           不跳过已存在的对象，全部重传
 *   --only <分类>     只传某个分类（主程序/升级包/工具软件/故障处理）
 *   --id   <资源id>   只传某一条
 *   --concurrency <n> 并发数，默认 3（家用宽带别开太大，会被限速）
 *
 * 环境变量（和 server.js 用同一套）：
 *   OSS_KEY_ID / OSS_KEY_SECRET / OSS_BUCKET / OSS_REGION
 *
 * 重要：这个脚本只做上传，不做删除。OSS 上多出来的旧对象不会被清理，
 *      需要自己到控制台删。这样设计是为了避免误删。
 */

const fs = require('fs');
const path = require('path');
const OSS = require('ali-oss');

/* ---------------- 参数解析 ---------------- */
function parseArgs(argv) {
  const a = { concurrency: 3, go: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--go') a.go = true;
    else if (k === '--force') a.force = true;
    else if (k === '--dry-run') a.go = false;
    else if (k === '--src') a.src = argv[++i];
    else if (k === '--manifest') a.manifest = argv[++i];
    else if (k === '--only') a.only = argv[++i];
    else if (k === '--id') a.id = argv[++i];
    else if (k === '--concurrency') a.concurrency = Math.max(1, parseInt(argv[++i], 10) || 3);
    else if (k === '-h' || k === '--help') a.help = true;
    else { console.error('未知参数: ' + k); a.help = true; }
  }
  return a;
}

const A = parseArgs(process.argv);
if (A.help || !A.src) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ ?\* ?/gm, ''));
  process.exit(A.help ? 0 : 1);
}

const MANIFEST = A.manifest || path.join(__dirname, 'assets.json');

/* ---------------- 配置 ---------------- */
const CFG = {
  region: process.env.OSS_REGION || 'oss-cn-hangzhou',
  keyId: process.env.OSS_KEY_ID,
  keySecret: process.env.OSS_KEY_SECRET,
  bucket: process.env.OSS_BUCKET
};

/* 凭据只在真上传时才要：预演模式（默认）不碰 OSS，
   没配好环境变量也能先看清要传哪些东西 */
const ENV_NAME = { keyId: 'OSS_KEY_ID', keySecret: 'OSS_KEY_SECRET', bucket: 'OSS_BUCKET' };
const missing = ['keyId', 'keySecret', 'bucket'].filter(k => !CFG[k]);

if (A.go && missing.length) {
  console.error('缺少环境变量：' + missing.map(k => ENV_NAME[k]).join(', '));
  console.error('（照着 server.js 注释里的那几行 export 一下就行）');
  process.exit(1);
}

let client = null;
if (A.go) {
  client = new OSS({
    region: CFG.region,
    accessKeyId: CFG.keyId,
    accessKeySecret: CFG.keySecret,
    bucket: CFG.bucket,
    secure: true,
    timeout: 10 * 60 * 1000
  });
}

/* ---------------- 工具 ---------------- */
function humanSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

function humanSpeed(bps) {
  if (bps < 1048576) return (bps / 1024).toFixed(0) + ' KB/s';
  return (bps / 1048576).toFixed(1) + ' MB/s';
}

const pad = (s, n) => String(s).padEnd(n);

/* 包名里带中文，直接放 URL 里不友好，但 OSS 支持，且服务端签名的
   content-disposition 会用 fileName 覆盖，所以这里保持原名，便于对照。 */

/* ---------------- 主流程 ---------------- */
(async function main() {
  if (!fs.existsSync(MANIFEST)) {
    console.error('找不到清单文件：' + MANIFEST);
    console.error('先在资源目录里跑一次：node build-catalog.js "<源目录>"');
    process.exit(1);
  }

  if (!fs.existsSync(A.src) || !fs.statSync(A.src).isDirectory()) {
    console.error('源目录不存在或不是目录：' + A.src);
    process.exit(1);
  }

  const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  let list = man.resources || [];
  if (Array.isArray(man)) list = man;

  if (A.only) list = list.filter(r => r.category === A.only);
  if (A.id) list = list.filter(r => r.id === A.id);

  if (!list.length) {
    console.error('按当前条件没筛出任何资源。');
    process.exit(1);
  }

  // 对齐源文件：不存在或大小对不上的直接标出来，别上传到一半才发现
  const jobs = [];
  const bad = [];
  for (const r of list) {
    const fp = path.join(A.src, r.sourcePath);
    if (!fs.existsSync(fp)) { bad.push({ r, why: '源文件不存在' }); continue; }
    const st = fs.statSync(fp);
    if (st.size !== r.size) {
      bad.push({ r, why: `大小对不上（清单 ${humanSize(r.size)}，实际 ${humanSize(st.size)}）` });
      continue;
    }
    jobs.push({ r, fp, size: st.size });
  }

  const totalBytes = jobs.reduce((s, j) => s + j.size, 0);
  console.log('='.repeat(64));
  console.log(`Bucket      ${CFG.bucket || '(未设置)'}  (${CFG.region})`);
  console.log(`清单        ${MANIFEST}`);
  console.log(`源目录      ${A.src}`);
  console.log(`待上传      ${jobs.length} 个，合计 ${humanSize(totalBytes)}`);
  console.log(`模式        ${A.go ? (A.force ? '真实上传（强制重传）' : '真实上传（跳过已存在）') : '预演（不会动 OSS）'}`);
  console.log('='.repeat(64));

  if (bad.length) {
    console.log(`\n以下 ${bad.length} 条有问题，已跳过：`);
    bad.slice(0, 10).forEach(b => console.log(`  ${b.r.id.padEnd(24)} ${b.why}`));
    if (bad.length > 10) console.log(`  ... 还有 ${bad.length - 10} 条`);
  }

  if (!jobs.length) {
    console.error('\n没有任何文件可以上传。多半是清单和源目录对不上——');
    console.error('清单是旧的，或者 --src 指向了另一个目录。');
    console.error('先在源目录重跑一次：node build-catalog.js "' + A.src + '"');
    process.exit(1);
  }

  if (!A.go) {
    console.log('\n预演结果（前 20 条）：');
    jobs.slice(0, 20).forEach((j, i) => {
      console.log(`  ${String(i + 1).padStart(3)}. ${humanSize(j.size).padStart(10)}  ${j.r.ossKey}`);
    });
    if (jobs.length > 20) console.log(`  ... 还有 ${jobs.length - 20} 条`);
    console.log('\n确认无误后加 --go 真传。');
    return;
  }

  /* ---------------- 上传 ---------------- */
  let okCount = 0, skipCount = 0, failCount = 0;
  let sentBytes = 0;
  const startedAt = Date.now();
  const failures = [];
  const cursor = { i: 0 };

  // 已存在且大小一致就跳过，方便中断后续传
  async function shouldSkip(j) {
    if (A.force) return false;
    try {
      const h = await client.head(j.r.ossKey);
      const remote = parseInt(h.res.headers['content-length'], 10);
      if (remote === j.size) return true;
      // 大小不一致说明上次没传完，要重传
      return false;
    } catch (e) {
      // 404 之类的都当"不存在"，继续传
      return false;
    }
  }

  async function worker(n) {
    while (true) {
      const my = cursor.i++;
      if (my >= jobs.length) return;
      const j = jobs[my];

      try {
        if (await shouldSkip(j)) {
          skipCount++;
          console.log(`[${my + 1}/${jobs.length}] ${pad('跳过', 6)} ${pad(humanSize(j.size), 10)}  ${j.r.ossKey}`);
          continue;
        }

        const t0 = Date.now();
        await client.put(j.r.ossKey, fs.createReadStream(j.fp), {
          // 让浏览器默认当二进制流，别自作主张打开
          mime: 'application/octet-stream',
          contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(j.r.fileName)}`
        });
        const ms = Date.now() - t0;
        sentBytes += j.size;
        okCount++;
        const speed = ms > 0 ? (j.size / ms) * 1000 : 0;
        console.log(`[${my + 1}/${jobs.length}] ${pad('完成', 6)} ${pad(humanSize(j.size), 10)}  ${pad(humanSpeed(speed), 10)}  ${j.r.ossKey}`);
      } catch (e) {
        failCount++;
        failures.push({ key: j.r.ossKey, msg: e.message });
        console.log(`[${my + 1}/${jobs.length}] ${pad('失败', 6)} ${pad(humanSize(j.size), 10)}  ${j.r.ossKey}`);
        console.log(`        原因：${e.message}`);
      }
    }
  }

  const n = Math.min(A.concurrency, jobs.length);
  console.log(`\n开始上传，并发 ${n}\n`);
  await Promise.all(Array.from({ length: n }, (_, i) => worker(i)));

  const sec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(64));
  console.log(`完成 ${okCount}　跳过 ${skipCount}　失败 ${failCount}`);
  console.log(`实际传输 ${humanSize(sentBytes)}，用时 ${sec}s` + (sentBytes ? `，均速 ${humanSpeed(sentBytes / (Date.now() - startedAt) * 1000)}` : ''));

  if (failures.length) {
    console.log('\n失败的条目（重跑本命令即可续传，已成功的会跳过）：');
    failures.forEach(f => console.log(`  ${f.key}  —— ${f.msg}`));
    process.exit(1);
  }

  console.log('\n下一步：确认 OSS 上文件数量对得上，然后跑一遍服务端冒烟测试。');
})().catch(e => {
  console.error('脚本异常：' + e.message);
  process.exit(1);
});
