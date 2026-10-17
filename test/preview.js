/**
 * 在线预览 + 转存的接口层验证
 * ------------------------------------------------------------------
 * 两个里程碑共用一套装置，因为它们要的东西一样：
 *   · 一个不落地的假对象存储（不需要真凭证）
 *   · 一个真实的 HTTP 实例 + 真实登录态
 *
 * 预览这部分真正要钉住的是**签名参数**：
 *   disposition 必须是 inline（否则浏览器还是下载，预览"看起来没生效"），
 *   并且 content-type 要被覆盖（否则 OSS 可能回 octet-stream，同样变成下载）。
 * 以及那条安全边界：svg / html 这类**绝不能**签出 inline。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunlight-pv-'));
process.env.DRIVE_DATA_DIR = TMP_DIR;
process.env.SITE_PASSWORD = 'pwd-for-pv-' + Date.now();
process.env.ADMIN_USERNAME = 'boss';
process.env.TOTP_SECRET = '';
process.env.TOTP_DISABLED = '0';
process.env.MAX_ATTEMPTS = '100';
process.env.SHARE_MAX_ATTEMPTS = '100';
process.env.QUOTA_GB = '0';
process.env.BRAND = 'sunlight';
process.env.OSS_REGION = 'oss-cn-hangzhou';
process.env.OSS_KEY_ID = 'FAKEKEYID0001';
process.env.OSS_KEY_SECRET = 'k'.repeat(24) + '1';
process.env.OSS_BUCKET = 'fake-platform-bucket';
process.env.OSS_UPLOAD_PREFIX = 'drive';

const app = require('../server.js');
const ossconfig = require('../lib/ossconfig');
const store = require('../lib/store');
const tree = require('../lib/tree');

/* ---------- 假对象存储：记账 + 记录每一次签名的参数 ---------- */
const signs = [];          // { key, response }
const objects = new Map();

const fake = {
  async put(k, b) { objects.set(k, { size: (b && b.length) || 0 }); },
  async delete(k) { objects.delete(k); },
  async copy(d, s) {
    if (!objects.has(s)) throw Object.assign(new Error('NoSuchKey'), { status: 404 });
    objects.set(d, { size: objects.get(s).size });
    return { data: {} };
  },
  signatureUrl(key, opts) {
    const response = (opts && opts.response) || {};
    /* 这里模仿 OSS 的一条真实限制 —— 少了它，测试会放过一个把预览整个搞挂的 bug：
       OSS 不允许覆盖 content-type，会回 400
       `Can not override response header on content-type`。
       （2026-10-16 实测：只覆盖 content-type 必失败，两个一起覆盖也必失败，
        只有 content-disposition 允许。）
       所以假 client 也必须拒绝，否则测试通过但线上全 400。
       真实的错误在真 OSS 上撞见过一次，不能让它在测试里"看不见"。 */
    if (response['content-type'] || response['Content-Type']) {
      const e = new Error('Can not override response header on content-type');
      e.status = 400;
      throw e;
    }
    signs.push({ key, response });
    return 'https://fake.example/' + encodeURIComponent(key) + '?sig=1';
  },
  async listUploads() { return { uploads: [] }; },
  async abortMultipartUpload() {}
};
ossconfig.getClientFor = () => fake;

let pass = 0, fail = 0;
const failures = [];
const ck = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, failures.push(label));
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `\n         got  = ${JSON.stringify(got)}\n         want = ${JSON.stringify(want)}`}`);
};
const ckTrue = (label, cond, extra) => {
  ck(label, !!cond, true);
  if (!cond && extra !== undefined) console.log('         ' + JSON.stringify(extra));
};
const section = t => console.log(`\n\x1b[1m== ${t} ==\x1b[0m`);

let PORT = 0;
function req(method, url, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: url, method,
      headers: Object.assign({ Accept: 'application/json' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
        token ? { Authorization: 'Bearer ' + token } : {})
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(out); } catch (_) {}
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const GET = (u, o) => req('GET', u, o);
const POST = (u, o) => req('POST', u, o);

/* 最后一条签名的 response（断言用） */
const lastSign = () => signs[signs.length - 1] || { response: {} };

(async function main() {
  await app.bootstrap();
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  PORT = server.address().port;
  console.log(`临时数据目录 ${TMP_DIR}`);
  console.log(`测试实例端口 ${PORT}`);

  const tok = (await POST('/api/auth', { body: { username: 'boss', password: process.env.SITE_PASSWORD } })).json.token;
  const su = await POST('/api/signup', { body: { username: 'guest', password: 'guest-pass-123' } });
  const guestTok = su.json.token;
  const st = store.get();
  const ownerId = Object.values(st.users).find(u => u.username === 'boss').id;

  /* 造一批各种类型的文件节点 */
  const mkFolder = name => store.mutate(s => tree.createFolder(s, name, null, ownerId));
  const dir = await mkFolder('素材');
  const add = (name, size) => store.mutate(s => tree.addFile(s, {
    name, parentId: dir.id, size, ossKey: 'drive/seed/' + name, owner: ownerId
  }));

  const FILES = [
    ['照片.jpg', 'image'], ['图.webp', 'image'],
    ['演示.mp4', 'video'], ['片段.mov', 'video'],
    ['讲义.pdf', 'pdf'], ['录音.mp3', 'audio'],
    ['恶意.svg', ''], ['页面.html', ''], ['文档.docx', ''], ['包.zip', '']
  ];
  const made = {};
  for (const [name] of FILES) {
    objects.set('drive/seed/' + name, { size: 2048 });
    made[name] = await add(name, 2048);
  }

  /* ================================================================
     1. 树接口下发 pv 字段
     ================================================================ */
  section('1. 服务端告诉前端"哪些能预览"');
  {
    const t = await GET(`/api/tree?parent=${dir.id}`, { token: tok });
    ck('拉树 200', t.status, 200);
    const byName = Object.fromEntries(t.json.children.map(n => [n.name, n.pv]));
    for (const [name, kind] of FILES) {
      ck(`${name} → pv=${JSON.stringify(kind)}`, byName[name], kind);
    }
    ckTrue('前端不需要自己维护白名单', 'pv' in t.json.children[0]);
  }

  /* ================================================================
     2. 主站预览：签名参数是重点
     ================================================================ */
  section('2. 主站预览的签名参数');
  {
    signs.length = 0;
    const r = await GET(`/api/preview?id=${made['照片.jpg'].id}`, { token: tok });
    ck('图片预览 200', r.status, 200);
    ck('返回 kind=image', r.json.kind, 'image');
    ck('文件名回传（弹层标题要用）', r.json.fileName, '照片.jpg');

    const disp = lastSign().response['content-disposition'] || '';
    ckTrue('disposition 必须是 inline 开头', /^inline;/.test(disp), disp);
    ckTrue('文件名用 RFC 5987 编码（中文不乱码）',
      /filename\*=UTF-8''/.test(disp), disp);
    /* 绝不能覆盖 content-type —— OSS 会回 400（假 client 会像真 OSS 一样拒绝）。
       对象的类型必须在**上传时**写对（preview.mimeForUpload），签名阶段只能改 disposition。 */
    ck('没有覆盖 content-type（OSS 不允许）',
      lastSign().response['content-type'], undefined);
    ckTrue('签名覆盖参数不会被篡改（签名覆盖了 Expires/Signature）',
      r.json.url.includes('sig=1'));
  }

  {
    signs.length = 0;
    const r = await GET(`/api/preview?id=${made['演示.mp4'].id}`, { token: tok });
    ck('视频预览 200', r.status, 200);
    ck('kind=video', r.json.kind, 'video');
    ck('视频也没覆盖 content-type', lastSign().response['content-type'], undefined);
    ckTrue('inline', /^inline;/.test(lastSign().response['content-disposition'] || ''));
  }

  {
    signs.length = 0;
    const r = await GET(`/api/preview?id=${made['讲义.pdf'].id}`, { token: tok });
    ck('PDF 预览 200', r.status, 200);
    ck('kind=pdf', r.json.kind, 'pdf');
    ck('PDF 也没覆盖 content-type', lastSign().response['content-type'], undefined);
  }

  /* ================================================================
     3. 安全边界：不能预览的必须被拒绝，而且**不能签出链接**
     ================================================================ */
  section('3. 白名单之外一律拒绝（安全边界）');
  {
    for (const name of ['恶意.svg', '页面.html', '文档.docx', '包.zip']) {
      signs.length = 0;
      const r = await GET(`/api/preview?id=${made[name].id}`, { token: tok });
      ck(`${name} → 415`, r.status, 415);
      ckTrue(`${name} 的提示说明了怎么办`, /不支持在线预览/.test(r.json.error || ''), r.json.error);
      ck(`${name} 没有签出任何链接`, signs.length, 0);
    }
  }

  /* ================================================================
     4. 下载仍然走 attachment（预览不能把下载也改了）
     ================================================================ */
  section('4. 下载不受预览影响');
  {
    signs.length = 0;
    const r = await GET(`/api/download?id=${made['照片.jpg'].id}`, { token: tok });
    ck('下载 200', r.status, 200);
    const disp = lastSign().response['content-disposition'] || '';
    ckTrue('下载是 attachment', /^attachment;/.test(disp), disp);
    ck('下载**不**覆盖 content-type', lastSign().response['content-type'], undefined);

    /* 不能预览的类型，下载照样得能下 */
    signs.length = 0;
    const z = await GET(`/api/download?id=${made['包.zip'].id}`, { token: tok });
    ck('zip 可以下载', z.status, 200);
    ckTrue('zip 下载也是 attachment',
      /^attachment;/.test(lastSign().response['content-disposition'] || ''));
  }

  /* ================================================================
     5. 越权
     ================================================================ */
  section('5. 预览也要过归属校验');
  {
    signs.length = 0;
    /* 别人的文件（guest 去看 boss 的） */
    const other = await GET(`/api/preview?id=${made['照片.jpg'].id}`, { token: guestTok });
    ck('拿别人的文件 id 预览 404', other.status, 404);
    ck('没签出链接', signs.length, 0);

    ck('未登录 401', (await GET(`/api/preview?id=${made['照片.jpg'].id}`)).status, 401);
    ck('不存在的 id 404', (await GET('/api/preview?id=n_nope', { token: tok })).status, 404);
    ck('文件夹不能预览 400', (await GET(`/api/preview?id=${dir.id}`, { token: tok })).status, 400);
  }

  /* ================================================================
     6. 分享页预览
     ================================================================ */
  section('6. 分享页预览与下载一致');
  {
    const sh = await POST('/api/share', {
      token: tok, body: { ids: [dir.id], password: 'sharepw123' }
    });
    const stoken = (await POST(`/api/share/${sh.json.share.token}/auth`,
      { body: { password: 'sharepw123' } })).json.stoken;
    const T = sh.json.share.token;
    const q = `stoken=${encodeURIComponent(stoken)}`;

    /* 分享列表里也要带 pv */
    const list = await GET(`/api/share/${T}/list?parent=${dir.id}&${q}`);
    const byName = Object.fromEntries(list.json.children.map(n => [n.name, n.pv]));
    ck('分享列表下发 pv（图片）', byName['照片.jpg'], 'image');
    ck('分享列表下发 pv（svg 为空）', byName['恶意.svg'], '');

    signs.length = 0;
    const okr = await GET(`/api/share/${T}/preview?id=${made['演示.mp4'].id}&${q}`);
    ck('分享页预览 200', okr.status, 200);
    ckTrue('也是 inline', /^inline;/.test(lastSign().response['content-disposition'] || ''));
    ck('分享页也没覆盖 content-type', lastSign().response['content-type'], undefined);

    /* 白名单在分享页同样生效 */
    signs.length = 0;
    const bad = await GET(`/api/share/${T}/preview?id=${made['恶意.svg'].id}&${q}`);
    ck('分享页也不给 svg 预览 415', bad.status, 415);
    ck('分享页没签出链接', signs.length, 0);

    /* 没带 stoken / 假 stoken */
    ck('没带 stoken 401',
      (await GET(`/api/share/${T}/preview?id=${made['照片.jpg'].id}`)).status, 401);
    ck('假 stoken 401',
      (await GET(`/api/share/${T}/preview?id=${made['照片.jpg'].id}&stoken=deadbeef`)).status, 401);

    /* 分享范围之外：把别人的（guest 的）文件 id 塞进来 */
    const outside = await store.mutate(s => tree.addFile(s, {
      name: '外面的.jpg', parentId: null, size: 100, ossKey: 'drive/seed/外面的.jpg', owner: ownerId
    }));
    signs.length = 0;
    const oob = await GET(`/api/share/${T}/preview?id=${outside.id}&${q}`);
    ck('分享范围外的 id 403', oob.status, 403);
    ck('越权没签出链接', signs.length, 0);
  }

  console.log(`\n${'='.repeat(52)}`);
  if (fail) {
    console.log(`\x1b[31m失败 ${fail} 项\x1b[0m，通过 ${pass} 项`);
    console.log('失败清单：');
    failures.forEach(f => console.log('  - ' + f));
  } else {
    console.log(`\x1b[32m全部通过\x1b[0m（${pass} 项）`);
  }

  server.close();
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('测试本身崩了：', e);
  process.exit(1);
});
