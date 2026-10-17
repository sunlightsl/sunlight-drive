/**
 * 保存到我的网盘（转存）的端到端验证
 * ------------------------------------------------------------------
 * 真实的 OSS 复制需要真凭证，本地跑不了。所以这里把 OSS 客户端替换成
 * 一个**内存假桶**：copy/delete/put 都记账，并且能按指令注入失败。
 * 这样下面这些**不需要真 OSS 就能测**的东西才有覆盖：
 *
 *   · 跨桶为什么转不了（两套凭证的死结）—— 这条是本期最关键的边界
 *   · 配额预检与"复制完再判一次"
 *   · 中途失败的回滚（不留孤儿对象、不留半截文件树）
 *   · 树结构还原（嵌套文件夹、重名加序号）
 *   · 越权：分享范围外的、别人的分享
 *   · 限流
 *
 * 真正需要真 OSS 才能验的（对象字节是否真的复制对了），见文件尾的说明。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

/* ---------- 环境：必须在 require server 之前设好 ---------- */
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunlight-save-'));
process.env.DRIVE_DATA_DIR = TMP_DIR;
process.env.SITE_PASSWORD = 'pwd-for-save-' + Date.now();
process.env.ADMIN_USERNAME = 'boss';
process.env.TOTP_SECRET = '';
process.env.TOTP_DISABLED = '0';
process.env.MAX_ATTEMPTS = '100';
process.env.SHARE_MAX_ATTEMPTS = '100';
process.env.QUOTA_GB = '1';
process.env.BRAND = 'sunlight';
/* 平台存储配置：只有非空才会让 active() 认为是"已配置" */
process.env.OSS_REGION = 'oss-cn-hangzhou';
process.env.OSS_KEY_ID = 'FAKEKEYID0001';
process.env.OSS_KEY_SECRET = 'k'.repeat(24) + '1';
process.env.OSS_BUCKET = 'fake-platform-bucket';
process.env.OSS_UPLOAD_PREFIX = 'drive';

const app = require('../server.js');
const ossconfig = require('../lib/ossconfig');
const store = require('../lib/store');
const tree = require('../lib/tree');
const users = require('../lib/users');
const auth = require('../lib/auth');
const sha = require('crypto').createHash;

/* ================================================================
   内存假桶
   ================================================================ */
const bucket = new Map();          // key -> { size }
const calls = { copy: [], del: [], sign: [] };
let failOn = null;                 // 让第 N 次 copy 抛错（从 1 开始）

const fakeClient = {
  async copy(destKey, srcKey) {
    calls.copy.push([destKey, srcKey]);
    if (failOn !== null && calls.copy.length === failOn) {
      throw Object.assign(new Error('模拟的 OSS 复制失败'), { status: 403 });
    }
    if (!bucket.has(srcKey)) {
      throw Object.assign(new Error('NoSuchKey: ' + srcKey), { status: 404 });
    }
    bucket.set(destKey, { size: bucket.get(srcKey).size });
    return { data: { etag: '"' + sha('md5').update(destKey).digest('hex') + '"', lastModified: new Date().toISOString() } };
  },
  async delete(key) {
    calls.del.push(key);
    bucket.delete(key);
  },
  async put(key, body) {
    bucket.set(key, { size: (body && body.length) || 0 });
  },
  deleteMulti(keys) { keys.forEach(k => { calls.del.push(k); bucket.delete(k); }); },
  signatureUrl(key, opts) {
    calls.sign.push(key);
    return 'https://fake/' + encodeURIComponent(key) + '?sig=1';
  },
  async listUploads() { return { uploads: [] }; },
  async abortMultipartUpload() {}
};

/* 塞进 ossconfig 自己的客户端缓存：这样 activeFor() / getClientFor() 的
   解析逻辑仍然是真的，只是拿到的是假客户端。 */
const platformCfg = ossconfig.active().cfg;
ossconfig.getClientFor = (userId) => {
  const a = ossconfig.activeFor(userId);
  if (!a) throw new Error('OSS 未配置');
  return fakeClient;
};

/* ---------- 断言小工具 ---------- */
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

/* ---------- HTTP ---------- */
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
        resolve({ status: res.statusCode, json: j, text: out });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const GET = (u, o) => req('GET', u, o);
const POST = (u, o) => req('POST', u, o);

/* ================================================================ */
(async function main() {
  await app.bootstrap();
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  PORT = server.address().port;
  console.log(`临时数据目录 ${TMP_DIR}`);
  console.log(`测试实例端口 ${PORT}`);

  /* ---- 两个账号：分享者 + 接收者 ---- */
  const ownerTok = (await POST('/api/auth', { body: { username: 'boss', password: process.env.SITE_PASSWORD } })).json.token;
  const su = await POST('/api/signup', { body: { username: 'receiver', password: 'receiver-pass-123' } });
  ck('接收者注册成功', su.status, 200);
  const recvTok = su.json.token;
  const recvId = su.json.user.id;

  const st = store.get();
  const ownerId = Object.values(st.users).find(u => u.username === 'boss').id;

  /* 帮接收者把他的平台配置也"准备好"：他走平台桶，所以不用额外设置。
     但要把他的配额明确设成 1GB（默认就是 QUOTA_GB=1）。 */

  /* ---------------------------------------------------------------
     造一棵分享者的树：
       素材/                    ← 用来测"结构还原"
         子目录/
           a.bin (60KB)
           b.bin (60KB)
       大文件.bin (1.2GB)       ← 单独放在顶层，用来测"超过复制上限"
                                    （不能塞进「素材」里，否则分享整棵时
                                     canSave 会因为它而变 false，两件事混在一起）
     --------------------------------------------------------------- */
  const mk = (name, parentId, owner) => store.mutate(s => tree.createFolder(s, name, parentId, owner));
  const root = await mk('素材', null, ownerId);
  const sub = await mk('子目录', root.id, ownerId);

  const putBlob = (key, size) => bucket.set(key, { size });
  const addFile = (name, parentId, size, owner) => store.mutate(s => tree.addFile(s, {
    name, parentId, size, ossKey: 'drive/seed/' + name, owner
  }));

  putBlob('drive/seed/a.bin', 60 * 1024);
  putBlob('drive/seed/b.bin', 60 * 1024);
  putBlob('drive/seed/大文件.bin', 1200 * 1024 * 1024);
  const fa = await addFile('a.bin', sub.id, 60 * 1024, ownerId);
  const fb = await addFile('b.bin', sub.id, 60 * 1024, ownerId);
  const fbig = await addFile('大文件.bin', null, 1200 * 1024 * 1024, ownerId);

  const mkShare = async (ids) => {
    const r = await POST('/api/share', { token: ownerTok, body: { ids, password: 'sharepw123' } });
    const tok = r.json.share.token;
    const a = await POST(`/api/share/${tok}/auth`, { body: { password: 'sharepw123' } });
    return { tok, stoken: a.json.stoken };
  };

  /* ---------------------------------------------------------------
     每个小节开始前把接收者的网盘清空。
     不这么做的话上一节存进去的文件会留在树里，让下一节的结构断言
     和"对象数回到原值"全都不成立 —— 每节只应该验证一件事。
     --------------------------------------------------------------- */
  const resetReceiver = async () => {
    await store.mutate(s => {
      for (const [id, n] of Object.entries(s.nodes)) if (n.owner === recvId) delete s.nodes[id];
      users.setQuota(s, s.users[recvId], 0);      // 0 = 不限，配额用例自己再设
    });
    /* 接收者名下的对象也从假桶里清掉，让"对象数"断言有意义 */
    for (const k of [...bucket.keys()]) if (k.startsWith('drive/receiver/')) bucket.delete(k);
    calls.copy.length = 0;
    calls.del.length = 0;
  };

  /* ================================================================
     1. 基本可用性
     ================================================================ */
  section('1. 分享页的转存可用性');
  {
    const { tok, stoken } = await mkShare([root.id]);

    ck('未登录 → save-info 401', (await GET(`/api/share/${tok}/save-info`)).status, 401);

    const info = await GET(`/api/share/${tok}/save-info?stoken=${stoken}`, { token: recvTok });
    ck('已登录 → 200', info.status, 200);
    ck('可以转存', info.json.canSave, true);
    ck('文件数（含子目录里的）', info.json.files, 2);
    ck('总字节', info.json.bytes, 60 * 1024 * 2);
    ck('默认落点', info.json.defaultFolder, '来自分享');
    ck('没有 stoken 时拿不到（作用域校验）',
      (await GET(`/api/share/${tok}/save-info`, { token: recvTok })).status, 401);
  }

  /* ================================================================
     2. 跨桶死结：接收者绑了自己的桶就必须拦住
     ================================================================ */
  section('2. 跨桶：绑了自己桶的接收者要被拦住');
  {
    await resetReceiver();
    const { tok, stoken } = await mkShare([sub.id]);
    ossconfig.setEntry(recvId, {
      region: 'oss-cn-beijing', bucket: 'receiver-own-bucket',
      keyId: 'FAKEKEYID0002', keySecret: 'k'.repeat(24) + '2', prefix: 'drive'
    });

    const info = await GET(`/api/share/${tok}/save-info?stoken=${stoken}`, { token: recvTok });
    ck('save-info 里标记为不可转存', info.json.canSave, false);
    ckTrue('给出了原因', /绑定/.test(info.json.reason || ''), info.json.reason);

    const before = calls.copy.length;
    const r = await POST(`/api/share/${tok}/save?stoken=${stoken}`, { token: recvTok, body: {} });
    ck('save 返回 409', r.status, 409);
    ckTrue('提示说明了怎么办', /下载后上传/.test(r.json.error || ''), r.json.error);
    ck('一次对象复制都没发起', calls.copy.length - before, 0);

    /* 解绑，恢复成平台存储，后面继续测 */
    ossconfig.deleteEntry(recvId);
    ck('解绑后又能转存', (await GET(`/api/share/${tok}/save-info?stoken=${stoken}`, { token: recvTok })).json.canSave, true);
  }

  /* ================================================================
     3. 超过服务端复制上限（1GB）
     ================================================================ */
  section('3. 单个文件超过复制上限');
  {
    await resetReceiver();
    const { tok, stoken } = await mkShare([fbig.id]);
    const info = await GET(`/api/share/${tok}/save-info?stoken=${stoken}`, { token: recvTok });
    ck('标记为不可转存', info.json.canSave, false);
    ckTrue('指出了是哪个文件', /大文件\.bin/.test(info.json.reason || ''), info.json.reason);

    const r = await POST(`/api/share/${tok}/save?stoken=${stoken}`, { token: recvTok, body: {} });
    ck('save 返回 413', r.status, 413);
  }

  /* ================================================================
     4. 配额
     ================================================================ */
  section('4. 配额预检');
  {
    await resetReceiver();
    /* 这个分享里是 2 × 60KB = 120KB。把配额压到 119KB —— 刚好差一点，
       这样"被拦住"和"刚好够"两种情形都能精确构造，不靠大约。 */
    await store.mutate(s => users.setQuota(s, s.users[recvId], 119 * 1024));
    const { tok, stoken } = await mkShare([sub.id]);

    const r = await POST(`/api/share/${tok}/save?stoken=${stoken}`, { token: recvTok, body: {} });
    ck('空间不足 413', r.status, 413);
    ckTrue('报出了具体数字', /本次需要/.test(r.json.error || ''), r.json.error);
    ck('没有留下任何对象', calls.copy.filter(c => c[0].includes('receiver')).length, 0);

    /* 放到刚好够（多 1KB） */
    await store.mutate(s => users.setQuota(s, s.users[recvId], 121 * 1024));
    const okRun = await POST(`/api/share/${tok}/save?stoken=${stoken}`, { token: recvTok, body: {} });
    ck('配额刚够时成功', okRun.status, 200);
    ck('存了 2 个文件', okRun.json.saved, 2);

    /* 已经用满之后再存一次 —— 又该被拦住（配额算的是累计，不是单次） */
    const again = await POST(`/api/share/${tok}/save?stoken=${stoken}`, { token: recvTok, body: {} });
    ck('用满后再存被拦 413', again.status, 413);
  }

  /* ================================================================
     5. 成功路径：树结构还原
     ================================================================ */
  section('5. 转存后的树结构');
  {
    await resetReceiver();
    await store.mutate(s => users.setQuota(s, s.users[recvId], 0));   // 不限，专心测结构
    const { tok, stoken } = await mkShare([root.id]);
    calls.copy.length = 0;

    const r = await POST(`/api/share/${tok}/save?stoken=${stoken}`, { token: recvTok, body: {} });
    ck('转存成功', r.status, 200);
    ck('2 个文件', r.json.saved, 2);
    ck('复制了 2 次', calls.copy.length, 2);

    const s2 = store.get();
    const sc = require('../lib/scope').open(s2, recvId);
    const top = sc.childrenOf(null).map(n => n.name);
    ckTrue('根目录出现「来自分享」', top.includes('来自分享'), top);

    const saved = sc.childrenOf(null).find(n => n.name === '来自分享');
    const lv1 = sc.childrenOf(saved.id).map(n => n.name);
    ck('里面是「素材」', lv1, ['素材']);
    const sub2 = sc.childrenOf(saved.id)[0];
    const lv2 = sc.childrenOf(sub2.id).map(n => `${n.type}:${n.name}`).sort();
    /* 分享的是「素材」，它下面只有一个「子目录」——文件在再下一层 */
    ck('子结构还原（素材/子目录）', lv2, ['folder:子目录']);
    const subsub = sc.childrenOf(sub2.id).find(n => n.type === 'folder');
    ck('再下一层也还原了', sc.childrenOf(subsub.id).map(n => n.name).sort(), ['a.bin', 'b.bin']);

    /* 新节点的 ossKey 必须是**新的**，且与源不同 —— 否则删一边会连累另一边 */
    const all = sc.all().filter(n => n.type === 'file');
    const newKeys = all.map(n => n.ossKey);
    ckTrue('所有权都不含源 key', !newKeys.some(k => k.startsWith('drive/seed/')), newKeys.slice(0, 3));
    ck('新对象都在假桶里', all.every(n => bucket.has(n.ossKey)), true);

    /* 字节数对得上（假桶按 size 记账） */
    const sizes = all.map(n => bucket.get(n.ossKey).size).sort((a, b) => a - b);
    ck('对象大小与源一致', sizes, [60 * 1024, 60 * 1024]);
  }

  /* ================================================================
     6. 重名 + 自选目录
     ================================================================ */
  section('6. 重名与自选目录');
  {
    await resetReceiver();
    const s3 = store.get();
    const sc = require('../lib/scope').open(s3, recvId);
    const mine = await store.mutate(s => tree.createFolder(s, '我的目录', null, recvId));

    const { tok, stoken } = await mkShare([sub.id]);
    const r = await POST(`/api/share/${tok}/save?stoken=${stoken}`,
      { token: recvTok, body: { parent: mine.id } });
    ck('存进指定目录', r.status, 200);

    const s4 = store.get();
    const sc4 = require('../lib/scope').open(s4, recvId);
    /* 分享的是一整个「子目录」，所以它在目标目录下被还原成同名文件夹，
       文件在它里面 —— 这正是"保留原结构"该有的样子。 */
    const names = sc4.childrenOf(mine.id).map(n => n.name).sort();
    ck('装进了自选目录（原文件夹被还原）', names, ['子目录']);
    const inner = sc4.childrenOf(mine.id)[0];
    ck('文件在还原出来的文件夹里', sc4.childrenOf(inner.id).map(n => n.name).sort(), ['a.bin', 'b.bin']);

    /* 再存一次同名 —— 应该自动加序号，而不是覆盖 */
    const r2 = await POST(`/api/share/${tok}/save?stoken=${stoken}`,
      { token: recvTok, body: { parent: mine.id } });
    ck('重复转存也成功', r2.status, 200);
    const s5 = store.get();
    const sc5 = require('../lib/scope').open(s5, recvId);
    const names2 = sc5.childrenOf(mine.id).map(n => n.name).sort();
    ckTrue('重名自动加序号', names2.includes('子目录 (2)'), names2);

    /* 不存在的目标目录 */
    const bad = await POST(`/api/share/${tok}/save?stoken=${stoken}`,
      { token: recvTok, body: { parent: 'n_nope' } });
    ck('目标目录不存在 404', bad.status, 404);
  }

  /* ================================================================
     7. 失败回滚
     ================================================================ */
  section('7. 中途失败要回滚干净');
  {
    await resetReceiver();
    const { tok, stoken } = await mkShare([sub.id]);
    const before = calls.copy.length;
    /* 只看**这次**新产生的对象：前面几节会留下别的对象，
       拿假桶总数对比是测不准的。 */
    const keysBefore = new Set(bucket.keys());
    failOn = 2;                       // 第 2 次复制抛错

    const r = await POST(`/api/share/${tok}/save?stoken=${stoken}`, { token: recvTok, body: {} });
    failOn = null;
    ck('返回失败', r.status >= 400, true);
    ck('尝试了 2 次复制', calls.copy.length - before, 2);

    /* 第 1 个已经复制成功，必须被回滚删掉 —— 不能留孤儿对象 */
    const leaked = [...bucket.keys()].filter(k => !keysBefore.has(k));
    ck('没有留下孤儿对象', leaked, []);
    ckTrue('回滚时确实调了删除', calls.del.length > 0, true);

    /* 树里不能多出半截结构：失败就该什么都不留。
       （这一节开头清过接收者的网盘，所以"零个节点"就是准确预期，
        不是"没新增"这种模糊说法。） */
    const s6 = store.get();
    const sc6 = require('../lib/scope').open(s6, recvId);
    ck('失败后接收者网盘完全没动', sc6.all().length, 0);
    ckTrue('也没有建出「来自分享」', !sc6.childrenOf(null).some(n => n.name === '来自分享'));
  }

  /* ================================================================
     8. 越权
     ================================================================ */
  section('8. 越权');
  {
    const { tok } = await mkShare([sub.id]);

    /* 拿别人的分享 token，但没有 stoken（没过密码） */
    const noStoken = await POST(`/api/share/${tok}/save`, { token: recvTok, body: {} });
    ck('没带 stoken 401', noStoken.status, 401);

    /* 伪造 stoken */
    const fake = await POST(`/api/share/${tok}/save?stoken=deadbeef`, { token: recvTok, body: {} });
    ck('假 stoken 401', fake.status, 401);

    /* 分享不存在的 token */
    const nope = await POST('/api/share/s_nope/save?stoken=x', { token: recvTok, body: {} });
    ck('不存在的分享 404', nope.status, 404);

    /* 未登录 */
    const anon = await POST(`/api/share/${tok}/save?stoken=x`, { body: {} });
    ck('未登录 401', anon.status, 401);
  }

  /* ================================================================
     8.5 分享者的三项限制（预览 / 下载 / 转存）
     ================================================================
     这三项是分享者明确表达过的意愿，所以**每一项都必须在服务端硬拦**——
     只把前端按钮置灰不构成限制，绕过前端直接打接口是几行脚本的事。
     下面每一组都验两件事：接口如实告知（前端据此置灰）+ 真动手时被拒。
     ================================================================ */
  section('8.5 分享者的三项限制');
  {
    await resetReceiver();

    /* 建一条带权限的分享。不传的项默认全开 */
    const mk = async (perm) => {
      const r = await POST('/api/share', {
        token: ownerTok,
        body: Object.assign({ ids: [sub.id], password: 'sharepw123' }, perm || {})
      });
      const tok = r.json.share.token;
      const a = await POST(`/api/share/${tok}/auth`, { body: { password: 'sharepw123' } });
      return { tok, stoken: a.json.stoken };
    };

    /* ---------- 全开：对照 ---------- */
    {
      const { tok, stoken } = await mk();
      const info = await GET(`/api/share/${tok}/save-info?stoken=${stoken}`, { token: recvTok });
      ck('全开时 canSave=true', info.json.canSave, true);
      ck('全开时下载可用',
        (await GET(`/api/share/${tok}/download?id=${fa.id}&stoken=${stoken}`)).status, 200);

      const auth = await POST(`/api/share/${tok}/auth`, { body: { password: 'sharepw123' } });
      ck('全开时 perm 四项都为 true', auth.json.perm, { pv: true, dl: true, sv: true, wm: true });
    }

    /* ---------- 只关转存（用户最初的诉求） ---------- */
    {
      const { tok, stoken } = await mk({ allowSave: false });

      const info = await GET(`/api/share/${tok}/save-info?stoken=${stoken}`, { token: recvTok });
      ck('关转存：canSave=false', info.json.canSave, false);
      ckTrue('关转存：给出了原因', /不允许转存/.test(info.json.reason || ''), info.json.reason);
      ck('关转存：文件数仍如实给出（页面还要显示内容）', info.json.files, 2);

      const before = calls.copy.length;
      const r = await POST(`/api/share/${tok}/save?stoken=${stoken}`, { token: recvTok, body: {} });
      ck('关转存：直接调 save 被拒 403', r.status, 403);
      ck('关转存：一次对象复制都没发起', calls.copy.length - before, 0);

      /* 下载和预览**不该**被牵连 */
      ck('关转存不影响下载',
        (await GET(`/api/share/${tok}/download?id=${fa.id}&stoken=${stoken}`)).status, 200);
      ckTrue('关转存不影响预览',
        (await GET(`/api/share/${tok}/preview?id=${fa.id}&stoken=${stoken}`)).status !== 403);
    }

    /* ---------- 关下载：培训资料"只能看不能拿走" ---------- */
    {
      const { tok, stoken } = await mk({ allowDownload: false });

      const d = await GET(`/api/share/${tok}/download?id=${fa.id}&stoken=${stoken}`);
      ck('关下载：download 被拒 403', d.status, 403);
      ckTrue('关下载：提示说明怎么办', /不允许下载/.test(d.json.error || ''), d.json.error);
      ck('关下载：没给出任何链接', d.json.url, undefined);

      /* 预览和转存不受影响 —— 三项是独立的 */
      ckTrue('关下载不影响预览',
        (await GET(`/api/share/${tok}/preview?id=${fa.id}&stoken=${stoken}`)).status !== 403);

      const sv = await POST(`/api/share/${tok}/save?stoken=${stoken}`, { token: recvTok, body: {} });
      ck('关下载不影响转存', sv.status, 200);
    }

    /* ---------- 关预览 ---------- */
    {
      const { tok, stoken } = await mk({ allowPreview: false });

      const pv = await GET(`/api/share/${tok}/preview?id=${fa.id}&stoken=${stoken}`);
      ck('关预览：preview 被拒 403', pv.status, 403);
      ckTrue('关预览：提示说明怎么办', /不允许在线预览/.test(pv.json.error || ''), pv.json.error);
      ck('关预览：没给出任何链接', pv.json.url, undefined);

      ck('关预览不影响下载',
        (await GET(`/api/share/${tok}/download?id=${fa.id}&stoken=${stoken}`)).status, 200);
    }

    /* ---------- 三个全关：只剩文件名 ---------- */
    {
      const { tok, stoken } = await mk({ allowPreview: false, allowDownload: false, allowSave: false, allowWatermark: false });

      ck('全关：预览 403',
        (await GET(`/api/share/${tok}/preview?id=${fa.id}&stoken=${stoken}`)).status, 403);
      ck('全关：下载 403',
        (await GET(`/api/share/${tok}/download?id=${fa.id}&stoken=${stoken}`)).status, 403);
      ck('全关：转存 403',
        (await POST(`/api/share/${tok}/save?stoken=${stoken}`, { token: recvTok, body: {} })).status, 403);

      /* 但列目录还得能列 —— 否则对方连"里面有什么"都不知道，页面是空的 */
      const list = await GET(`/api/share/${tok}/list?parent=${sub.id}&stoken=${stoken}`);
      ck('全关：仍然能列目录（否则页面空白）', list.status, 200);
      ck('全关：文件仍然列得出来', list.json.children.length, 2);

      const auth = await POST(`/api/share/${tok}/auth`, { body: { password: 'sharepw123' } });
      ck('全关：perm 四项都是 false', auth.json.perm, { pv: false, dl: false, sv: false, wm: false });
    }

    /* ---------- 老分享（没有 perm 字段）必须读作全开 ---------- */
    {
      const { tok, stoken } = await mk();
      /* 手动把 perm 抹掉，模拟升级前建的分享 */
      await store.mutate(s => { delete s.shares[tok].perm; });

      const auth = await POST(`/api/share/${tok}/auth`, { body: { password: 'sharepw123' } });
      ck('老分享读作全开', auth.json.perm, { pv: true, dl: true, sv: true, wm: true });
      ck('老分享下载照常',
        (await GET(`/api/share/${tok}/download?id=${fa.id}&stoken=${stoken}`)).status, 200);
    }

    /* ---------- 关水印 ---------- */
    {
      const { tok, stoken } = await mk({ allowWatermark: false });
      const auth = await POST(`/api/share/${tok}/auth`, { body: { password: 'sharepw123' } });
      ck('关水印：perm.wm=false', auth.json.perm.wm, false);
      ck('关水印：其余三项不受影响',
        [auth.json.perm.pv, auth.json.perm.dl, auth.json.perm.sv], [true, true, true]);

      /* 水印文案仍然下发（关的只是"显示"），前端据此自己决定画不画 */
      ckTrue('关水印：文案仍照常下发', typeof auth.json.watermark === 'string', auth.json.watermark);
      ckTrue('水印文案不含访问者 IP（已按需求去掉）',
        !/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(auth.json.watermark || ''), auth.json.watermark);
    }

    /* ---------- 水印文案的内容 ---------- */
    {
      const { tok } = await mk();
      const auth = await POST(`/api/share/${tok}/auth`, { body: { password: 'sharepw123' } });
      const wm = auth.json.watermark || '';
      /* 首个账号的 nickname 取的是品牌名（不是 username），
         所以用库里的真实值比对，别假设成 'boss' */
      const bossNick = Object.values(store.get().users).find(u => u.username === 'boss').nickname;
      ckTrue('水印含分享人昵称', wm.includes(bossNick), { wm, bossNick });
      ckTrue('水印含日期', /\d{4}-\d{2}-\d{2}/.test(wm), wm);
      ck('不再下发 viewer 字段', auth.json.viewer, undefined);
    }

    /* ---------- 改已有分享的权限 ----------
       分享发出去之后需求会变，必须能改 —— 只能删了重建的话，
       链接和密码都会换掉，已经拿到链接的人就用不了了。 */
    {
      const { tok, stoken } = await mk();   // 先建一条全开的

      const auth0 = await POST(`/api/share/${tok}/auth`, { body: { password: 'sharepw123' } });
      ck('新建时全开', auth0.json.perm, { pv: true, dl: true, sv: true, wm: true });

      /* 关掉下载 */
      const r1 = await POST('/api/share/perm', { token: ownerTok, body: { token: tok, perm: { dl: false } } });
      ck('改权限 200', r1.status, 200);
      ck('只关了下载，其余不动', r1.json.perm, { pv: true, dl: false, sv: true, wm: true });

      /* 立刻生效：下载被拒、预览照常 */
      ck('改完立刻生效（下载 403）',
        (await GET(`/api/share/${tok}/download?id=${fa.id}&stoken=${stoken}`)).status, 403);
      /* 预览这条：素材里那几个文件都不是可预览类型（.bin），
         所以**不能**断言 200 —— 完整链路会回 415「不支持预览」。
         要验的是「没有被权限拦下」，也就是**不是 403**。
         用一张真的图片才能区分这两件事，见下面专门的一条。 */
      const pvAfter = await GET(`/api/share/${tok}/preview?id=${fa.id}&stoken=${stoken}`);
      ckTrue('其余权限没被牵连（预览没被 403 拦下，415 是类型不支持）',
        pvAfter.status !== 403, pvAfter.status);

      /* 用真实图片确认"允许预览时确实给得出链接" */
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const img = await store.mutate(s => tree.addFile(s, {
        name: '权限测试.png', parentId: sub.id, size: png.length,
        ossKey: 'drive/seed/权限测试.png', owner: ownerId
      }));
      bucket.set(img.ossKey, { size: png.length });

      const pvOk = await GET(`/api/share/${tok}/preview?id=${img.id}&stoken=${stoken}`);
      ck('允许预览时真的给得出签名链接', pvOk.status, 200);
      /* 签名到底是 inline 还是 attachment，由 test/preview.js 专门验 ——
         这里只关心「权限允许时拿得到链接」 */

      /* 关掉预览 → 同一张图应被 403 拦下 */
      await POST('/api/share/perm', { token: ownerTok, body: { token: tok, perm: { pv: false } } });
      const pvNo = await GET(`/api/share/${tok}/preview?id=${img.id}&stoken=${stoken}`);
      ck('关掉预览后同一张图 403', pvNo.status, 403);
      ck('关掉预览后不给链接', pvNo.json.url, undefined);
      /* 改回去，别影响后面的用例 */
      await POST('/api/share/perm', { token: ownerTok, body: { token: tok, perm: { pv: true } } });

      /* 再关水印 */
      const r2 = await POST('/api/share/perm', { token: ownerTok, body: { token: tok, perm: { wm: false } } });
      ck('多次改是累加的，不会重置别的项', r2.json.perm, { pv: true, dl: false, sv: true, wm: false });

      /* 全部恢复 → perm 字段应被删掉（保持"全开=不写字段"的约定） */
      const r3 = await POST('/api/share/perm', {
        token: ownerTok,
        body: { token: tok, perm: { pv: true, dl: true, sv: true, wm: true } }
      });
      ck('恢复全开后四项都是 true', r3.json.perm, { pv: true, dl: true, sv: true, wm: true });
      ck('全开后 perm 字段被删掉（不留冗余）', store.get().shares[tok].perm, undefined);
      ck('恢复后下载又能用了',
        (await GET(`/api/share/${tok}/download?id=${fa.id}&stoken=${stoken}`)).status, 200);

      /* 参数校验 + 归属校验 */
      ck('没传 perm 400',
        (await POST('/api/share/perm', { token: ownerTok, body: { token: tok } })).status, 400);
      ck('传了 perm 但没一个合法键 400',
        (await POST('/api/share/perm', { token: ownerTok, body: { token: tok, perm: { xx: false } } })).status, 400);
      ck('不存在的分享 404',
        (await POST('/api/share/perm', { token: ownerTok, body: { token: 's_nope', perm: { dl: false } } })).status, 404);
      ck('未登录 401',
        (await POST('/api/share/perm', { body: { token: tok, perm: { dl: false } } })).status, 401);

      /* 别人的分享改不了：接收者拿自己的会话去改 */
      ck('非本人改不了 404',
        (await POST('/api/share/perm', { token: recvTok, body: { token: tok, perm: { dl: false } } })).status, 404);
    }

    /* ---------- 分享管理里要标出限制了哪些 ---------- */
    {
      const { tok } = await mk({ allowDownload: false, allowSave: false });
      const shares = await GET('/api/shares', { token: ownerTok });
      const me = shares.json.shares.find(x => x.token === tok);
      ck('管理列表下发 perm', me.perm, { pv: true, dl: false, sv: false, wm: true });
    }
  }

  /* ================================================================
     9. 限流
     ================================================================ */
  section('9. 转存限流');
  {
    await resetReceiver();
    const { tok, stoken } = await mkShare([sub.id]);
    let blockedAt = 0;
    for (let i = 1; i <= 12; i++) {
      const r = await POST(`/api/share/${tok}/save?stoken=${stoken}`, { token: recvTok, body: {} });
      if (r.status === 429) { blockedAt = i; break; }
    }
    ckTrue('连续转存会被限流（10 次/小时）', blockedAt > 0 && blockedAt <= 11, { blockedAt });
  }

  console.log(`\n${'='.repeat(52)}`);
  if (fail) { console.log(`\x1b[31m失败 ${fail} 项\x1b[0m，通过 ${pass} 项`); console.log('失败清单：'); failures.forEach(f => console.log('  - ' + f)); }
  else console.log(`\x1b[32m全部通过\x1b[0m（${pass} 项）`);

  server.close();
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('测试本身崩了：', e);
  process.exit(1);
});
