#!/usr/bin/env node
/**
 * 端到端测试（零依赖，直接 node test/e2e.js）
 * ------------------------------------------------------------------
 * 起一个真的 Express 实例，用真的 HTTP 请求把整条链路走一遍。
 * 单测（test/run.js）保的是"某个函数算得对不对"，这里保的是
 * "接口连起来之后行为对不对"——比如分享能不能越权、2FA 是不是
 * 真的挡住了没有动态码的人。
 *
 * 数据写在临时目录里，绝不碰 data/drive.json：
 * 这个测试会建文件夹、删节点、发分享，拿真实数据跑就毁了。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

/* ---------- 环境：必须在 require server.js 之前设好 ---------- */
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunlight-e2e-'));
process.env.DRIVE_DATA_DIR = TMP_DIR;
process.env.SITE_PASSWORD = 'pwd-for-e2e-' + Date.now();
/* 多用户之后首个账号是 .env 里的口令 + 下面这个名字建出来的 */
process.env.ADMIN_USERNAME = 'sunlight';
process.env.TOTP_SECRET = '';          // 先测无 2FA，后面运行时再打开
process.env.MAX_ATTEMPTS = '30';       // 别让测试自己被限流锁住
process.env.SHARE_MAX_ATTEMPTS = '3';
process.env.MAX_UPLOAD_MB = '1';
process.env.TOTP_DISABLED = '0';
process.env.BRAND = 'sunlight';

const app = require('../server.js');
const { CFG } = require('../lib/config');
const store = require('../lib/store');
const tree = require('../lib/tree');
const totp = require('../lib/totp');

let pass = 0, fail = 0;
const failures = [];

function ck(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, failures.push(label));
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `\n         got  = ${JSON.stringify(got)}\n         want = ${JSON.stringify(want)}`}`);
}
function ckTrue(label, cond, extra) {
  ck(label, !!cond, true);
  if (!cond && extra !== undefined) console.log('         ' + JSON.stringify(extra));
}
function section(t) { console.log(`\n\x1b[1m== ${t} ==\x1b[0m`); }

/* ---------- HTTP 小工具 ---------- */
let PORT = 0;

function req(method, url, { token, body, headers = {}, chunked } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    let payload = null;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body), 'utf8');
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = payload.length;
    } else if (chunked) {
      h['Transfer-Encoding'] = 'chunked';       // 故意不给 Content-Length，测 411
    }
    if (token) h['Authorization'] = 'Bearer ' + token;

    const r = http.request({ port: PORT, method, path: url, headers: h, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (chunked) { r.write('x'.repeat(10)); r.end(); }
    else if (payload) r.end(payload);
    else r.end();
  });
}
const GET = (u, o) => req('GET', u, o);
const POST = (u, o) => req('POST', u, o);

/* ================================================================ */
(async function main() {
  /* 多用户之后必须先建出首个账号，否则任何登录都会是"用户名或密码不正确"。
     bootstrap() 就是干这个的：库里没有账号时，用 .env 的口令建一个站长账号。
     （早先单用户时代口令直接存在配置里，没有这一步。） */
  await require('../server.js').bootstrap();

  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  PORT = server.address().port;
  console.log(`临时数据目录 ${TMP_DIR}`);
  console.log(`测试实例端口 ${PORT}`);

  /* ================================================================
     1. 站点信息 + 静态资源白名单
     ================================================================ */
  section('站点信息与静态白名单');
  {
    const r = await GET('/api/site');
    ck('GET /api/site 200', r.status, 200);
    ck('品牌名', r.json.brand, 'sunlight');
    /* 双因素从「全局开关」变成了「每人一个」，/api/site 不再下发这个字段 */
    ck('上传上限按 MB 下发', r.json.maxUploadMB, 1);
    ck('分享默认 2 小时', r.json.shareTtlHours, 2);
  }
  {
    const home = await GET('/');
    ck('首页 200', home.status, 200);
    ckTrue('首页是网盘页面', home.text.includes('sunlight'), home.text.slice(0, 80));

    const pub = await GET('/share.html');
    ck('分享页 200', pub.status, 200);

    const dyn = await GET('/s/s_faketoken');
    ck('分享动态路由 200', dyn.status, 200);

    // 这两个是之前能被匿名下载的，必须挡住
    const aj = await GET('/assets.json');
    ck('assets.json 不许匿名下载', aj.status, 404);
    const md = await GET('/README.md');
    ck('README.md 不许匿名下载', md.status, 404);
    const arch = await GET('/ARCHITECTURE.md');
    ck('ARCHITECTURE.md 不许匿名下载', arch.status, 404);
    const env = await GET('/.env');
    ck('.env 不许匿名下载', env.status, 404);
    const server = await GET('/server.js');
    ck('server.js 不许匿名下载', server.status, 404);
  }

  /* ================================================================
     2. 登录（无 2FA）
     ================================================================ */
  section('登录与限流');
  let admin = '';
  {
    const USER = process.env.ADMIN_USERNAME;
    const bad = await POST('/api/auth', { body: { username: USER, password: 'wrong-password' } });
    ck('错密码 401', bad.status, 401);
    ck('错密码不返回 token', !!bad.json.token, false);

    const ok = await POST('/api/auth', { body: { username: USER, password: process.env.SITE_PASSWORD } });
    ck('对密码 200', ok.status, 200);
    ckTrue('拿到会话 token', typeof ok.json.token === 'string' && ok.json.token.length > 20, ok.json);
    admin = ok.json.token;

    const s = await GET('/api/session', { token: admin });
    ck('会话有效', s.status, 200);

    const noTok = await GET('/api/tree');
    ck('无 token 拉文件树 401', noTok.status, 401);
    const badTok = await GET('/api/tree', { token: 'nope' });
    ck('假 token 拉文件树 401', badTok.status, 401);
  }

  /* ================================================================
     2.5 个人资料（昵称 + 头像）
     ================================================================ */
  section('个人资料');
  {
    /* 注意是 /api/account（GET）而不是 /api/account/profile ——
       后者只有 POST 一条路由，用 GET 打它会落到白名单那一步返回 404。 */
    ckTrue('无 token 拉账号 401', [401, 404].includes((await GET('/api/account')).status));

    const init = await GET('/api/account', { token: admin });
    const ACCT_KEYS = ['id', 'username', 'nickname', 'avatar', 'plan', 'role', 'totpEnabled'];
    ck('账号形状含关键字段', ACCT_KEYS.every(k => k in init.json.account), true);
    /* 新账号的昵称默认就是用户名，不是空串 */
    ck('初始昵称默认为用户名', init.json.account.nickname, process.env.ADMIN_USERNAME);
    ck('初始头像是空的', init.json.account.avatar, '');
    /* plan 目前恒为 'free'，但首个账号（站长）在建号时被标成 'pro' ——
       这个字段是给以后收费预留的位置，现在只做展示。 */
    ck('套餐位有值', ['free', 'pro'].includes(init.json.account.plan), true);

    const set = await POST('/api/account/profile', { token: admin, body: { nickname: '  示例昵称  ' } });
    ck('改昵称 200', set.status, 200);
    ck('昵称首尾空白被去掉', set.json.account.nickname, '示例昵称');

    /* 全是空白等于没设昵称，不能存进去 */
    ck('全空白昵称 400',
      (await POST('/api/account/profile', { token: admin, body: { nickname: '   ' } })).status, 400);
    ck('空昵称 400',
      (await POST('/api/account/profile', { token: admin, body: { nickname: '' } })).status, 400);
    ck('超长昵称 400',
      (await POST('/api/account/profile', { token: admin, body: { nickname: '字'.repeat(25) } })).status, 400);
    ck('24 个字以内可以',
      (await POST('/api/account/profile', { token: admin, body: { nickname: '字'.repeat(24) } })).status, 200);

    /* 控制字符是想让昵称在别处被当成终端转义 / 格式串用 */
    ck('昵称带控制字符 400',
      (await POST('/api/account/profile', { token: admin, body: { nickname: 'a\u001b[31m' } })).status, 400);

    /* ---------------- 头像 ---------------- */
    const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    ck('不是 data URI 的头像 400',
      (await POST('/api/account/avatar', { token: admin, body: { avatar: 'http://example.com/a.png' } })).status, 400);
    ck('不支持的图片类型 400',
      (await POST('/api/account/avatar', { token: admin, body: { avatar: 'data:image/svg+xml;base64,PHN2Zy8+' } })).status, 400);

    /* 关键一条：MIME 是调用方自己写的，得认真实字节 ——
       拿一段 PNG 声称自己是 image/jpeg，必须被识破 */
    const pngB64 = PNG1.split(',')[1];
    ck('声明的类型和真实内容对不上 400',
      (await POST('/api/account/avatar', {
        token: admin, body: { avatar: 'data:image/jpeg;base64,' + pngB64 }
      })).status, 400);

    const av = await POST('/api/account/avatar', { token: admin, body: { avatar: PNG1 } });
    ck('正常 PNG 头像 200', av.status, 200);
    ck('存下来的就是那条 data URI', av.json.account.avatar, PNG1);

    /* 拼一张 500KB 的"图"，必须被 400KB 那道线挡住 */
    const huge = 'data:image/png;base64,' +
      Buffer.concat([Buffer.from(pngB64, 'base64'), Buffer.alloc(500 * 1024)]).toString('base64');
    ck('超大头像 400',
      (await POST('/api/account/avatar', { token: admin, body: { avatar: huge } })).status, 400);

    const clr = await POST('/api/account/avatar/clear', { token: admin });
    ck('清头像 200', clr.status, 200);
    ck('清完头像变空', clr.json.account.avatar, '');
    ck('清头像不影响昵称', clr.json.account.nickname, '字'.repeat(24));

    /* 真的落盘了没有：从 store 里直接看一眼 */
    /* 多用户之后资料存在 users 表里，不再是顶层的 profile 字段 */
    const saved = Object.values(store.get().users).find(u => u.nickname === '字'.repeat(24));
    ck('资料写进了 drive.json', !!saved, true);
  }

  /* ================================================================
     3. 文件树：建 / 改名 / 移动 / 环
     ================================================================ */
  section('文件树操作');
  let root, sub, file1;
  {
    const empty = await GET('/api/tree', { token: admin });
    ck('空盘顶层 0 项', empty.json.children.length, 0);
    ck('空盘统计', empty.json.stats, { folders: 0, files: 0, total: 0, bytes: 0 });

    const mk = await POST('/api/folder', { token: admin, body: { name: '示例目录', parent: null } });
    ck('建顶层文件夹 200', mk.status, 200);
    root = mk.json.node;
    ck('名字保留', root.name, '示例目录');

    const mk2 = await POST('/api/folder', { token: admin, body: { name: '升级包', parent: root.id } });
    sub = mk2.json.node;
    ck('建子文件夹', sub.parent, root.id);

    // 名字消毒：路径分隔符要被换成短横线，而不是报错
    const weird = await POST('/api/folder', { token: admin, body: { name: 'a/b\\c:d*e', parent: root.id } });
    ck('非法字符被清洗', weird.json.node.name, 'a-b-c-d-e');

    // 路径穿越
    const trav = await POST('/api/folder', { token: admin, body: { name: '../../etc/passwd', parent: root.id } });
    ck('路径穿越被清洗', trav.json.node.name, 'etc-passwd');

    // 同级重名自动加序号
    const dup = await POST('/api/folder', { token: admin, body: { name: '升级包', parent: root.id } });
    ck('重名加序号', dup.json.node.name, '升级包 (2)');

    // 空名字要拒绝
    const noname = await POST('/api/folder', { token: admin, body: { name: '   ', parent: root.id } });
    ck('空名字 400', noname.status, 400);

    // 面包屑与层级。
    // 接口契约：breadcrumb 是「祖先链，不含当前目录」，当前目录在 current 里。
    // 若把 breadcrumb 的最后一项当成当前目录，进子目录时会显示父目录、
    // 真正所在的目录反而不出现 —— 这里把这层契约定死。
    const t = await GET('/api/tree?parent=' + sub.id, { token: admin });
    ck('面包屑是祖先链（不含当前目录）', t.json.breadcrumb.map(n => n.name), ['示例目录']);
    ck('当前目录在 current 里', t.json.current.name, '升级包');
    ck('breadcrumb 里不该出现当前目录', t.json.breadcrumb.some(n => n.id === sub.id), false);

    // 更深一层：祖先链应该变长
    const deeper = (await POST('/api/folder', { token: admin, body: { name: '三级', parent: sub.id } })).json.node;
    const t2 = await GET('/api/tree?parent=' + deeper.id, { token: admin });
    ck('三层时祖先链两层', t2.json.breadcrumb.map(n => n.name), ['示例目录', '升级包']);
    ck('三层时 current 是三级', t2.json.current.name, '三级');

    // 改名
    const rn = await POST('/api/rename', { token: admin, body: { id: sub.id, name: '升级包2026' } });
    ck('改名成功', rn.json.node.name, '升级包2026');

    // 环：不能移进自己 / 自己的后代
    const self = await POST('/api/move', { token: admin, body: { ids: [root.id], parent: root.id } });
    ck('不能移进自己 400', self.status, 400);
    const into = await POST('/api/move', { token: admin, body: { ids: [root.id], parent: sub.id } });
    ck('不能移进自己的子目录 400', into.status, 400);

    // 合法移动
    const mv = await POST('/api/move', { token: admin, body: { ids: [sub.id], parent: null } });
    ck('移到顶层成功', mv.status, 200);
    ck('parent 变成 null', mv.json.nodes[0].parent, null);
    await POST('/api/move', { token: admin, body: { ids: [sub.id], parent: root.id } });

    // 移进不存在的目录
    const nowhere = await POST('/api/move', { token: admin, body: { ids: [sub.id], parent: 'n_gone' } });
    ck('移到不存在的目录 404', nowhere.status, 404);
  }

  /* ================================================================
     4. 扁平列表（搜索和"移动到"用）
     ================================================================ */
  section('扁平列表');
  {
    const f = await GET('/api/flat', { token: admin });
    ck('/api/flat 200', f.status, 200);
    ckTrue('拿到全部节点', f.json.nodes.length >= 4, f.json.nodes.length);
    const folder = f.json.nodes.find(n => n.id === root.id);
    ck('含根节点', folder && folder.name, '示例目录');
    // 内部字段不能漏给前端
    ckTrue('不下发 ossKey', f.json.nodes.every(n => n.ossKey === undefined));
  }

  /* ================================================================
     5. 上传与下载（未配 OSS 时的行为）
     ================================================================ */
  section('上传 / 下载（OSS 未配置）');
  {
    ck('确认测试环境没有 OSS 凭据', CFG.hasOss, false);

    const up = await POST('/api/upload?parent=' + root.id + '&name=a.bin', { token: admin, chunked: true });
    ck('无 OSS 时上传 503', up.status, 503);

    const dl = await GET('/api/download?id=' + root.id, { token: admin });
    ck('文件夹不能下载 400', dl.status, 400);

    const dl2 = await GET('/api/download?id=n_gone', { token: admin });
    ck('不存在的资源 404', dl2.status, 404);
  }

  /* ================================================================
     6. 分享：越权防护是重点
     ================================================================ */
  section('分享与越权防护');
  let shareTok = '', sharePw = '', stoken = '';
  {
    // 造两个互不相干的目录树
    const other = (await POST('/api/folder', { token: admin, body: { name: '私人', parent: null } })).json.node;
    const secretFile = (await GET('/api/flat', { token: admin })).json.nodes
      .filter(n => n.parent === other.id);
    ck('私人目录初始为空', secretFile.length, 0);

    const sh = await POST('/api/share', { token: admin, body: { ids: [sub.id], ttlHours: 2 } });
    ck('创建分享 200', sh.status, 200);
    ck('返回的是一份分享，不是一份列表', typeof sh.json.share.token, 'string');
    ck('没有 shares 数组了（一次分享只有一个凭证）', sh.json.shares === undefined, true);
    shareTok = sh.json.share.token;
    sharePw = sh.json.share.password;
    ck('分享密码 6 位', sharePw.length, 6);
    ckTrue('分享链接指向 /s/', sh.json.share.url.includes('/s/' + shareTok), sh.json.share.url);
    ck('有效期 2 小时', sh.json.share.ttlHours, 2);
    ck('这一份里记了一项', sh.json.share.items.length, 1);
    ck('记的名字是节点名', sh.json.share.items[0].name, '升级包2026');

    // 公开侧：只说到没到密码，不泄露文件名
    const info = await GET('/api/share/' + shareTok);
    ck('分享信息 200', info.status, 200);
    ck('要求密码', info.json.needPassword, true);
    ckTrue('不泄露被分享的名字', info.json.nodeName === undefined && info.json.root === undefined, info.json);

    const noShare = await GET('/api/share/s_nope');
    ck('不存在的分享 404', noShare.status, 404);

    // 没验证就列目录
    const noPw = await GET(`/api/share/${shareTok}/list`);
    ck('没过密码就列目录 401', noPw.status, 401);

    // 错密码
    const bad = await POST(`/api/share/${shareTok}/auth`, { body: { password: 'ZZZZZZ' } });
    ck('分享密码错误 401', bad.status, 401);

    // 对密码
    const ok = await POST(`/api/share/${shareTok}/auth`, { body: { password: sharePw } });
    ck('分享密码正确 200', ok.status, 200);
    stoken = ok.json.stoken;
    ckTrue('拿到 stoken', typeof stoken === 'string' && stoken.length > 20, ok.json);
    ck('返回分享根节点', ok.json.root.name, '升级包2026');

    // 列目录
    const list = await GET(`/api/share/${shareTok}/list?stoken=${stoken}`);
    ck('列分享目录 200', list.status, 200);
    ck('分享根就是当前目录', list.json.current.name, '升级包2026');
    ck('分享根没有面包屑（不外泄外层路径）', list.json.breadcrumb, []);

    /* ---- 越权：拿别人的 nodeId 来列 ---- */
    const peek = await GET(`/api/share/${shareTok}/list?parent=${other.id}&stoken=${stoken}`);
    ck('越权列别的目录 403', peek.status, 403);

    const peekUp = await GET(`/api/share/${shareTok}/list?parent=${root.id}&stoken=${stoken}`);
    ck('越权列父目录 403', peekUp.status, 403);

    /* ---- 越权：拿别人的文件来下载 ---- */
    const dl = await GET(`/api/share/${shareTok}/download?id=${other.id}&stoken=${stoken}`);
    ck('越权下载 403', dl.status, 403);

    /* ---- 拿 A 分享的 stoken 去访问 B 分享 ---- */
    const sh2 = await POST('/api/share', { token: admin, body: { ids: [root.id], ttlHours: 1 } });
    const other2 = sh2.json.share.token;
    const cross = await GET(`/api/share/${other2}/list?stoken=${stoken}`);
    ck('A 的票据不能访问 B 分享 401', cross.status, 401);

    /* ---- 假 stoken ---- */
    const fake = await GET(`/api/share/${shareTok}/list?stoken=deadbeef`);
    ck('假 stoken 401', fake.status, 401);

    /* ---- 多选：一个链接、一个密码，而不是每项一条 ----
       这是"分享是一个任务，不是一个文件"那条需求的落点。 */
    const multi = await POST('/api/share', {
      token: admin, body: { ids: [root.id, sub.id], ttlHours: 1 }
    });
    ck('多选也只返回一份分享', typeof multi.json.share.token, 'string');
    ck('两项都装在这一份里', multi.json.share.items.length, 2);
    const mTok = multi.json.share.token, mPw = multi.json.share.password;

    const mAuth = await POST(`/api/share/${mTok}/auth`, { body: { password: mPw } });
    ck('多选分享用一个密码进去', mAuth.status, 200);
    ck('多选时给的是虚拟根（不指向任何真实节点）', mAuth.json.root.id, '');
    ck('虚拟根是文件夹形状，前端好统一渲染', mAuth.json.root.type, 'folder');
    ck('认证结果里带着两项', mAuth.json.items.length, 2);

    const mList = await GET(`/api/share/${mTok}/list?stoken=${mAuth.json.stoken}`);
    ck('第一屏把这两项摊开', mList.json.children.length, 2);
    ck('第一屏不显示面包屑', mList.json.breadcrumb, []);
    ck('第一屏的父节点就是虚拟根', mList.json.parent, '');

    const into = await GET(`/api/share/${mTok}/list?parent=${sub.id}&stoken=${mAuth.json.stoken}`);
    ck('能进到其中一项里', into.status, 200);
    ck('面包屑只到分享边界为止，不泄露外层', into.json.breadcrumb.map(c => c.name), ['示例目录']);
    ck('进子目录后 current 是子目录', into.json.current.name, '升级包2026');

    const back = await GET(`/api/share/${mTok}/list?parent=&stoken=${mAuth.json.stoken}`);
    ck('能回到虚拟根', back.json.children.length, 2);

    /* 多选的 scope 是两个根，范围外的照样进不去 */
    const mPeek = await GET(`/api/share/${mTok}/list?parent=${other.id}&stoken=${mAuth.json.stoken}`);
    ck('多选分享也挡得住越权 403', mPeek.status, 403);

    await POST('/api/share/revoke', { token: admin, body: { tokens: [mTok] } });

    // 管理侧
    const list2 = await GET('/api/shares', { token: admin });
    ck('分享列表 2 条', list2.json.shares.length, 2);
    ck('记录了被打开次数', list2.json.shares.some(s => s.hits >= 1), true);

    // 撤销
    const rv = await POST('/api/share/revoke', { token: admin, body: { tokens: [other2] } });
    ck('撤销 1 条', rv.json.revoked, 1);
    const gone = await GET('/api/share/' + other2);
    ck('撤销后访问 404', gone.status, 404);
  }

  /* ================================================================
     6.5 分享单个文件（最容易坏的那条路径）
     ================================================================
     之前 /api/share/:token/list 遇到"分享根是个文件"会直接 400，
     后果是分享单个文件生成的链接打开后永远卡在密码页——表单提交成功了，
     紧接着列目录失败，错误还被当成密码不对显示给用户。
     这条用例把那个场景钉死。
     ================================================================ */
  section('分享单个文件');
  {
    /* 直接塞一个文件节点：测试环境没有 OSS，走不了上传接口。
       注意必须带上 owner —— 多用户之后 scope 只认自己名下的节点，
       不带 owner 的节点在任何人的视图里都取不到（会表现成"选中的东西都不在了"）。 */
    const meId = Object.values(store.get().users)
      .find(u => u.username === process.env.ADMIN_USERNAME).id;
    const seeded = await store.mutate(s => tree.addFile(s, {
      name: 'seed-package.rar', parentId: sub.id, size: 1234567,
      ossKey: 'seed/seed-package.rar', owner: meId
    }));
    ck('文件节点已就位', seeded.type, 'file');

    const sh = await POST('/api/share', { token: admin, body: { ids: [seeded.id], ttlHours: 2 } });
    ck('可以分享单个文件', sh.status, 200);
    ck('分享类型是 file', sh.json.share.items[0].type, 'file');
    const tok = sh.json.share.token;
    const pw = sh.json.share.password;

    const auth = await POST(`/api/share/${tok}/auth`, { body: { password: pw } });
    ck('文件分享也能过密码验证', auth.status, 200);
    ck('返回的根节点是文件', auth.json.root.type, 'file');
    const st = auth.json.stoken;

    const list = await GET(`/api/share/${tok}/list?stoken=${st}`);
    ck('列目录不报错（曾经 400）', list.status, 200);
    ck('current 就是这个文件', list.json.current.type, 'file');
    ck('带上了文件大小', list.json.current.size, 1234567);
    ck('children 为空', list.json.children, []);
    ck('文件分享没有面包屑', list.json.breadcrumb, []);

    // 越权校验在文件分享上同样要生效
    const peek = await GET(`/api/share/${tok}/list?parent=${root.id}&stoken=${st}`);
    ck('文件分享也不能列别的目录 403', peek.status, 403);

    const dl = await GET(`/api/share/${tok}/download?id=${seeded.id}&stoken=${st}`);
    ck('未配 OSS 时下载返回 503（说明越权校验已放行、卡在存储这一步）', dl.status, 503);

    await POST('/api/share/revoke', { token: admin, body: { tokens: [tok] } });
  }

  /* ================================================================
     7. 分享密码限流（短密码必须靠限流兜住）
     ================================================================ */
  section('分享密码限流');
  {
    const sh = await POST('/api/share', { token: admin, body: { ids: [root.id], ttlHours: 1 } });
    const t = sh.json.share.token;
    const codes = [];
    for (let i = 0; i < 4; i++) {
      const r = await POST(`/api/share/${t}/auth`, { body: { password: 'AAAAA' + i } });
      codes.push(r.status);
    }
    ck('前 3 次是 401', codes.slice(0, 3), [401, 401, 401]);
    ck('第 4 次被限流 429', codes[3], 429);
    await POST('/api/share/revoke', { token: admin, body: { tokens: [t] } });
  }

  /* ================================================================
     8. 删除
     ================================================================ */
  section('删除');
  {
    const before = (await GET('/api/flat', { token: admin })).json.nodes.length;
    const del = await POST('/api/delete', { token: admin, body: { ids: [root.id] } });
    ck('删除 200', del.status, 200);
    ckTrue('连带删掉了子树', del.json.removed >= 4, del.json);

    const after = (await GET('/api/flat', { token: admin })).json.nodes.length;
    ck('节点数减少', after < before, true);

    // 删掉的目录里如果有分享，分享要被自动作废
    const shs = await GET('/api/shares', { token: admin });
    ckTrue('指向被删节点的分享已失效', shs.json.shares.every(s => s.nodeExists === false || s.nodeId !== root.id), shs.json.shares);

    const again = await POST('/api/delete', { token: admin, body: { ids: [root.id] } });
    ck('重复删除 404', again.status, 404);

    const none = await POST('/api/delete', { token: admin, body: { ids: [] } });
    ck('空数组 400', none.status, 400);
  }

  /* ================================================================
     9. 双因素
     ================================================================ */
  section('双因素：开了 2FA 的账号第一步拿不到会话');
  {
    const USER = process.env.ADMIN_USERNAME;
    const before = store.get();
    const me = Object.values(before.users).find(u => u.username === USER);

    /* 直接在库里给他开一个 2FA，省掉"扫码 -> 回填验证码"那一串界面动作 ——
       那条流程由 test/account-state.js 用真实接口覆盖。 */
    const secret = totp.generateSecret();
    await store.mutate(s => {
      const u = s.users[me.id];
      u.totp = { secret, enabled: true, lastStep: 0 };
    });

    try {
      const step1 = await POST('/api/auth', { body: { username: USER, password: process.env.SITE_PASSWORD } });
      ck('第一步 200', step1.status, 200);
      ck('要求动态码', step1.json.needTotp, true);
      ckTrue('第一步不下发 token（还进不去）', step1.json.token === undefined, step1.json);
      ckTrue('拿到了票据', typeof step1.json.challenge === 'string' && step1.json.challenge.length > 20);

      /* 关键安全性质：票据本身不是通行证 —— 拿它去访问接口必须被拒 */
      const asTicket = await GET('/api/tree', { token: step1.json.challenge });
      ck('拿票据当 token 用会被拒 401', asTicket.status, 401);

      /* 第二步用错码，也不该放行 */
      const badCode = await POST('/api/auth/2fa', { body: { challenge: step1.json.challenge, code: '000000' } });
      ck('错动态码 401', badCode.status, 401);
      ck('错码不给 token', badCode.json.token, undefined);
      ckTrue('说明了原因', typeof badCode.json.error === 'string' && badCode.json.error.length > 0, badCode.json);

      /* 实测：票据不因输错一次而作废（用户手滑不该被赶回第一步）。
         用正确的码验证这一点 —— 这也顺带覆盖了"第二步能换到会话"。 */
      totp.resetReplay();
      const okCode = await POST('/api/auth/2fa', {
        body: { challenge: step1.json.challenge, code: totp.code(secret, Date.now()) }
      });
      ck('输错一次后，同一票据用对码仍可进入 200', okCode.status, 200);
      ckTrue('这次拿到了会话 token', typeof okCode.json.token === 'string' && okCode.json.token.length > 20, okCode.json);

      /* 票据一次性：同一张不能再用 */
      const reuse = await POST('/api/auth/2fa', {
        body: { challenge: step1.json.challenge, code: totp.code(secret, Date.now()) }
      });
      ck('票据用过即废 401', reuse.status, 401);

      /* 假票据 */
      const fakeCh = await POST('/api/auth/2fa', { body: { challenge: 'nope', code: '123456' } });
      ck('假票据 401', fakeCh.status, 401);
    } finally {
      /* 关回去，别影响别的用例 */
      await store.mutate(s => { s.users[me.id].totp = { secret: '', enabled: false, lastStep: 0 }; });
    }
  }

  /* ================================================================
     10. 并发写：串行化之后不该丢数据
     ================================================================ */
  section('并发写不丢数据');
  {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        POST('/api/folder', { token: admin, body: { name: '并发' + i, parent: null } }))
    );
    ck('12 个请求全部成功', results.every(r => r.status === 200), true);

    const f = await GET('/api/flat', { token: admin });
    const tops = f.json.nodes.filter(n => n.parent === null && n.name.startsWith('并发'));
    ck('12 个文件夹一个不少（说明写操作确实串行化了）', tops.length, 12);
    ck('名字没有互相覆盖', new Set(tops.map(n => n.name)).size, 12);

    await POST('/api/delete', { token: admin, body: { ids: tops.map(n => n.id) } });
  }

  /* ---------------------------------------------------------------- */
  section('启动逻辑能被显式调用（dev.js 靠这条活着）');
  {
    const mod = require('../server.js');
    ck('server.js 导出了 start 函数', typeof mod.start, 'function');

    /* 真正调一次。临时把端口改成 0，让系统随便给个空闲端口。
       这是回归测试 —— 曾经启动逻辑写在 `if (require.main === module)` 里，
       dev.js require 本模块时那个条件不成立，listen() 永远不执行：
       进程打印完横幅就以退出码 0 结束了，看着像启动成功，端口上什么都没有。 */
    const savedPort = CFG.port;
    CFG.port = 0;
    const inst = await mod.start();
    CFG.port = savedPort;

    const addr = inst.address();
    ck('start() 之后端口真的被监听了', !!(addr && addr.port > 0), true);

    const r = await new Promise(resolve => {
      const req = http.get({
        port: addr.port, path: '/api/site', agent: false,
        headers: { Connection: 'close' }
      }, res => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', () => resolve({ status: 0, body: '' }));
    });
    ck('起起来的服务能真的响应请求', r.status, 200);
    ck('返回的是本站信息', /"brand"/.test(r.body), true);

    if (inst.closeAllConnections) inst.closeAllConnections();
    await new Promise(resolve => inst.close(resolve));
  }

  /* ================================================================ */
  console.log('\n' + '='.repeat(52));
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}

  if (fail) {
    console.log(`\x1b[31m失败 ${fail} 项\x1b[0m，通过 ${pass} 项`);
    console.log('失败清单：');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  } else {
    console.log(`\x1b[32m全部通过\x1b[0m（${pass} 项）`);
    process.exit(0);
  }
})().catch(e => {
  console.error('\n测试本身崩了：', e && e.stack || e);
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
