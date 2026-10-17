#!/usr/bin/env node
/**
 * 分片签名 URL 测试（node test/multipart.js）
 * 关键点：签名算法错一个字节就是全量 403，所以这里用「两份独立实现
 * 交叉验证」—— lib 里一份，测试里按官方规范再写一份，两边必须一致。
 */

const crypto = require('crypto');
const oc = require('../lib/ossconfig');

let pass = 0, failN = 0;
const ck = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : failN++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

/* ---- 测试专用配置（值是假的，不指向任何真实账号） ---- */
const cfg = {
  region: 'oss-cn-hangzhou',
  bucket: 'test-bucket-abc',
  keyId: 'FAKETESTKEY0001',
  keySecret: 'k'.repeat(24) + '1',
  endpoint: ''
};

/* 独立实现：严格按 OSS 官方 V1 URL 签名规范另写一遍 */
function independentSign(c, key, uploadId, partNumber, expiresAtSec) {
  // CanonicalizedResource：bucket/key + sub-resource 按字典序（partNumber < uploadId）
  const canonical = '/' + c.bucket + '/' + key +
    '?partNumber=' + partNumber + '&uploadId=' + encodeURIComponent(uploadId);
  const sts = 'PUT\n\n\n' + expiresAtSec + '\n' + canonical;
  const sig = crypto.createHmac('sha1', c.keySecret).update(sts).digest('base64');
  return sig;
}

const key = 'drive/202610/ab12cd_大文件.bin';
const ossUploadId = 'abc123/+xyz=='; // 故意带需要 urlencode 的字符
const expiresAt = Math.floor(Date.now() / 1000) + 900;

const url = oc.signPartUrl(cfg, key, ossUploadId, 7, 900);

ck('协议与 host', url.startsWith('https://test-bucket-abc.oss-cn-hangzhou.aliyuncs.com/' + key + '?'), true);
ck('带 OSSAccessKeyId', url.includes('OSSAccessKeyId=' + encodeURIComponent(cfg.keyId)), true);
ck('带 Expires', /Expires=\d{10}/.test(url), true);
ck('uploadId 被 urlencode', url.includes('uploadId=' + encodeURIComponent(ossUploadId)), true);
ck('sub-resource 齐全', url.includes('partNumber=7'), true);

/* 从 URL 里解析出 Signature，与独立实现比对 */
const m = url.match(/[?&]Signature=([^&]+)/);
ck('Signature 存在', !!m, true);
ck('签名与独立实现一致', decodeURIComponent(m[1]), independentSign(cfg, key, ossUploadId, 7, expiresAt));

/* 确定性：同输入两次调用（同一 Expires 才可比）——用内部逻辑重演：
   把 URL 的 Expires 抠出来，按独立实现重算一遍 */
const exp = parseInt(url.match(/Expires=(\d+)/)[1], 10);
const sig2 = independentSign(cfg, key, ossUploadId, 7, exp);
ck('换算实际 Expires 后签名仍一致', decodeURIComponent(m[1]), sig2);

/* 换分片号签名必须变化（防止 partNumber 不参与签名的实现错误） */
const urlB = oc.signPartUrl(cfg, key, ossUploadId, 8, exp);
const sigB = decodeURIComponent(urlB.match(/[?&]Signature=([^&]+)/)[1]);
ck('分片号变化 → 签名变化', sigB !== sig2, true);

/* 自定义 endpoint 也生效 */
const urlC = oc.signPartUrl({ ...cfg, endpoint: 'internal.aliyuncs.com' }, key, ossUploadId, 7, exp);
ck('自定义 endpoint 参与 host', urlC.startsWith('https://test-bucket-abc.internal.aliyuncs.com/'), true);

console.log(`\n${pass} 通过, ${failN} 失败`);
process.exit(failN ? 1 : 0);
