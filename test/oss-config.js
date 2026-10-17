#!/usr/bin/env node
/**
 * lib/ossconfig.js 单元测试（零依赖，直接 node test/oss-config.js）
 * ------------------------------------------------------------------
 * 密钥库这种东西出错不报错，只会安静地出错事：
 *   · 加密没生效 → Secret 明文躺在磁盘上
 *   · 篡改检测失效 → 别人改了配置没人知道
 *   · 优先级搞反 → 页面配了半天还在用 .env 的旧钥匙
 * 所以每一项都要有测试钉死。
 *
 * 注意 require 顺序：DRIVE_DATA_DIR / OSS_* / MASTER_KEY 必须在
 * 加载 lib/config 之前放进环境，那边是启动时读一次就定格的。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* ---- 测试专用的隔离环境 ---- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ossconfig-test-'));
process.env.DRIVE_DATA_DIR = TMP;
process.env.MASTER_KEY = 'test-master-key-0123456789abcdef';   // ≥16 字符
process.env.OSS_KEY_ID = 'FAKEENVKEY000001';                  // 给"回落 .env"用
process.env.OSS_KEY_SECRET = 'envSecretValue0123456789';
process.env.OSS_BUCKET = 'env-bucket';
process.env.OSS_REGION = 'oss-cn-test';

const oc = require('../lib/ossconfig');

let pass = 0, fail = 0;
const failures = [];

function ck(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, failures.push(label));
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `\n         got  = ${JSON.stringify(got)}\n         want = ${JSON.stringify(want)}`}`);
}

function throws(label, fn, msgPart) {
  try {
    fn();
    fail++; failures.push(label);
    console.log(` FAIL  ${label}  （没抛异常，但应该抛）`);
  } catch (e) {
    const ok = !msgPart || e.message.includes(msgPart);
    ok ? pass++ : (fail++, failures.push(label));
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}  -> ${e.message}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m== ${title} ==\x1b[0m`);
}

/* ================================================================
   1. 校验
   ================================================================ */
section('validate 校验');

const base = {
  region: 'oss-cn-hangzhou', keyId: 'FAKEKEYID0001',
  keySecret: 'fakeSecretValue0123456789', bucket: 'my-drive',
  prefix: 'drive/ subdir'
};
throws('缺 region', () => oc.validate({ ...base, region: '' }), 'Region 不能为空');
throws('缺 keySecret 且无旧值', () => oc.validate({ ...base, keySecret: '' }), 'Secret 不能为空');
throws('region 格式不正确', () => oc.validate({ ...base, region: 'hangzhou' }), 'Region 格式不正确');
ck('bucket 大写自动转小写', oc.validate({ ...base, bucket: 'My-Drive' }).bucket, 'my-drive');
throws('bucket 太短', () => oc.validate({ ...base, bucket: 'ab' }), 'Bucket 格式不正确');
throws('前缀带 ..', () => oc.validate({ ...base, prefix: 'drive/../etc' }), '..');
throws('keyId 太短', () => oc.validate({ ...base, keyId: 'ab12' }), 'AccessKey ID 格式不正确');

ck('bucket 统一小写', oc.validate({ ...base, bucket: 'MY-Drive' }).bucket, 'my-drive');
ck('前缀去首尾斜杠', oc.validate({ ...base, prefix: '/drive/' }).prefix, 'drive');
{
  const v = oc.validate({ ...base, versioning: 'yes', sseKms: 1, endpoint: '', domain: 'cdn.x.com' });
  ck('布尔值为真', [v.versioning, v.sseKms, v.domain], [true, true, 'cdn.x.com']);
}

/* 脱敏 ID 回传：改个前缀不用重输整串 ID */
{
  const saved = oc.validate(base);
  const m = oc.masked(saved);
  const again = oc.validate({ ...base, keyId: m.keyId, keySecret: '', prefix: 'new-prefix' }, saved);
  ck('脱敏 keyId 还原', again.keyId, base.keyId);
  ck('留空的 Secret 沿用旧值', again.keySecret, base.keySecret);
  ck('顺手改了前缀', again.prefix, 'new-prefix');
}
throws('脱敏 keyId 没有旧值可还原', () => oc.validate({ ...base, keyId: 'FAKE****0001' }), '脱敏');

/* ================================================================
   2. 脱敏视图
   ================================================================ */
section('masked 脱敏');
{
  const m = oc.masked(oc.validate(base));
  ck('keyId 中段打码', m.keyId, 'FAKE****0001');
  ck('不外泄 Secret', m.hasSecret, true);
  ck('masked 里没有 keySecret 字段', 'keySecret' in m, false);
  ck('空配置 → null', oc.masked(null), null);
}

/* ================================================================
   3. 加密存储
   ================================================================ */
section('密钥库（AES-256-GCM）');
{
  const cfg = oc.validate(base);
  oc.setEntry(oc.PLATFORM, cfg);

  /* 磁盘上不能有明文 */
  const raw = fs.readFileSync(oc.SECRETS_FILE, 'utf8');
  ck('落盘内容不含 Secret 明文', raw.includes('fakeSecretValue'), false);
  ck('落盘内容不含 keyId 明文', raw.includes('FAKEKEYID'), false);

  ck('读回一致', oc.getEntry(oc.PLATFORM).keySecret, cfg.keySecret);

  /* 模拟重启：清缓存后从盘上读 */
  oc._resetForTest();
  ck('重启后读回一致', oc.getEntry(oc.PLATFORM).keySecret, cfg.keySecret);

  /* 篡改检测：动一个字节就该炸 */
  oc._resetForTest();
  const tampered = JSON.parse(fs.readFileSync(oc.SECRETS_FILE, 'utf8'));
  tampered.data = tampered.data.slice(0, -4) + 'AAAA';
  fs.writeFileSync(oc.SECRETS_FILE, JSON.stringify(tampered));
  throws('篡改被检测', () => oc.getEntry(oc.PLATFORM), '无法解密');

  /* MASTER_KEY 换了 = 全部读不出 */
  process.env.MASTER_KEY = 'another-master-key-0123456789';
  oc._resetForTest();
  throws('换主密钥后读不出', () => oc.getEntry(oc.PLATFORM), 'MASTER_KEY');
  process.env.MASTER_KEY = 'test-master-key-0123456789abcdef';
  oc._resetForTest();
}

/* ================================================================
   4. 解析优先级：页面配置 > .env
   ================================================================ */
section('active() 优先级');
{
  /* 上一节篡改测试把文件弄坏了，先重建一份干净的 */
  oc._resetForTest();
  fs.rmSync(oc.SECRETS_FILE, { force: true });

  oc.setEntry(oc.PLATFORM, oc.validate(base));
  ck('页面配置优先', oc.active().source, 'ui');

  oc.deleteEntry(oc.PLATFORM);
  ck('删掉后回落 .env', oc.active().source, 'env');
  ck('回落值来自 env', oc.active().cfg.bucket, 'env-bucket');
  ck('deleteEntry 幂等', oc.deleteEntry(oc.PLATFORM), false);

  /* 删掉页面配置后，getClient 走 .env 兜底建出真实客户端（不联网）。
     依赖在 managed workspace，靠 NODE_PATH 解析；裸环境没有就跳过。 */
  try {
    const c = oc.getClient();
    ck('getClient 建出客户端', typeof c.signatureUrl, 'function');
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') console.log('  SKIP  getClient（裸环境无 ali-oss）');
    else { fail++; failures.push('getClient 建出客户端'); console.log(' FAIL  getClient 建出客户端 -> ' + e.message); }
  }
}

/* ================================================================
   5. 主密钥来源
   ================================================================ */
section('主密钥');
{
  /* MASTER_KEY 太短要拦 —— 免得有人拿 "123" 当钥匙 */
  process.env.MASTER_KEY = 'short';
  oc._resetForTest();
  throws('主密钥太短', () => oc.masterKeyOf ? oc.masterKeyOf() : (() => {
    // masterKey 不导出，通过 seal 间接触发
    oc.setEntry('tmp-probe', { a: 1 });
  })(), 'MASTER_KEY 太短');
  process.env.MASTER_KEY = 'test-master-key-0123456789abcdef';
  oc._resetForTest();
}

console.log(`\n${pass} 通过, ${fail} 失败`);
if (fail) {
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
