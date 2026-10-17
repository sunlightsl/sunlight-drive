/**
 * 会话 cookie + 登录回跳的验证
 * ------------------------------------------------------------------
 * 要钉住两件事：
 *
 * ① **cookie 能独立完成认证**。
 *    分享页拿不到 sessionStorage 里那份票（它是 sessionStorage，按标签页隔离），
 *    所以登录时必须额外种一个 cookie，分享页靠它被认出身份。
 *    没有这条，分享页永远显示「去登录」—— 这正是当时的 bug。
 *
 * ② **cookie 的属性不能松**。
 *    HttpOnly（XSS 偷不走）、SameSite=Lax（挡 CSRF）、Secure（只在 HTTPS 发）。
 *    任何一条丢了都是安全问题，不是"小瑕疵"。
 *
 * ③ 回跳参数只允许站内相对路径 —— 否则就是一个开放重定向。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunlight-ck-'));
process.env.DRIVE_DATA_DIR = TMP_DIR;
process.env.SITE_PASSWORD = 'pwd-for-ck-' + Date.now();
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

const fake = {
  async put() {}, async delete() {}, async copy() { return { data: {} }; },
  signatureUrl: (k) => 'https://fake.example/' + encodeURIComponent(k) + '?sig=1',
  async listUploads() { return { uploads: [] }; }, async abortMultipartUpload() {}
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
function req(method, url, { token, cookie, body, proto } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const h = Object.assign({ Accept: 'application/json' },
      data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (cookie) h.Cookie = cookie;
    if (proto) h['X-Forwarded-Proto'] = proto;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: url, method, headers: h }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(out); } catch (_) {}
        resolve({ status: res.statusCode, json: j, setCookie: res.headers['set-cookie'] || [] });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const GET = (u, o) => req('GET', u, o);
const POST = (u, o) => req('POST', u, o);

/* 从 Set-Cookie 里取出会话 cookie 的整段 */
const pickCookie = list => (list || []).find(c => c.startsWith('sl_sess=')) || '';
/* 只取 name=value 部分，用于后续请求 */
const cookiePair = list => {
  const full = pickCookie(list);
  return full ? full.split(';')[0] : '';
};

(async function main() {
  await app.bootstrap();
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  PORT = server.address().port;
  console.log(`临时数据目录 ${TMP_DIR}`);
  console.log(`测试实例端口 ${PORT}`);

  const USER = process.env.ADMIN_USERNAME;
  const PW = process.env.SITE_PASSWORD;
  let tok2 = '';        // 4.5 那节复用第一张会话票

  /* ================================================================
     1. 登录必须种 cookie，且属性不能松
     ================================================================ */
  section('1. 登录种 cookie，属性齐全');
  const login = await POST('/api/auth', { body: { username: USER, password: PW } });
  ck('登录 200', login.status, 200);
  const tok = login.json.token;
  ckTrue('仍然返回 token（单页应用那条路没被破坏）', !!tok);

  const ckSet = pickCookie(login.setCookie);
  ckTrue('种了 sl_sess cookie', !!ckSet, login.setCookie);

  section('2. cookie 属性');
  ckTrue('HttpOnly（脚本读不到，XSS 偷不走）', /HttpOnly/i.test(ckSet), ckSet);
  ckTrue('SameSite=Lax（挡 CSRF，又不影响从外链点进来）', /SameSite=Lax/i.test(ckSet), ckSet);
  ckTrue('Path=/', /Path=\//i.test(ckSet), ckSet);
  ckTrue('Max-Age 是正数（会过期，不是会话级永驻）', /Max-Age=[1-9]/.test(ckSet), ckSet);
  ckTrue('http 下**不加** Secure（否则本地调试整条链路失效）', !/Secure/i.test(ckSet), ckSet);

  /* 走 HTTPS 时必须加 Secure */
  const httpsLogin = await POST('/api/auth', {
    body: { username: USER, password: PW }, proto: 'https'
  });
  const httpsCk = pickCookie(httpsLogin.setCookie);
  ckTrue('https 下加 Secure', /Secure/i.test(httpsCk), httpsCk);

  /* ================================================================
     3. 只有 cookie、没有 Authorization —— 这才是分享页的处境
     ================================================================ */
  section('3. 光靠 cookie 就能认证（分享页的处境）');
  const pair = cookiePair(login.setCookie);

  ck('无头无 cookie → 401', (await GET('/api/account')).status, 401);
  ck('带 cookie、不带 Authorization → 200', (await GET('/api/account', { cookie: pair })).status, 200);
  ck('带 Authorization、不带 cookie → 200（两条路并存）',
    (await GET('/api/account', { token: tok })).status, 200);

  const me = await GET('/api/account', { cookie: pair });
  ck('cookie 认出来的是同一个人', me.json.account.username, USER);

  ck('假 cookie 401', (await GET('/api/account', { cookie: 'sl_sess=nope' })).status, 401);
  ck('畸形 cookie 不崩', (await GET('/api/account', { cookie: 'sl_sess=%E0%A4%A' })).status, 401);

  /* ================================================================
     4. 转存接口在"只有 cookie"时可用 —— 这是真正要修的场景
     ================================================================ */
  section('4. 分享页转存：只有 cookie 也能用');
  {
    const st = store.get();
    const ownerId = st.users[me.json.account.id].id;
    const dir = await store.mutate(s => tree.createFolder(s, '素材', null, ownerId));
    await store.mutate(s => tree.addFile(s, {
      name: '图.png', parentId: dir.id, size: 100, ossKey: 'drive/seed/图.png', owner: ownerId
    }));

    const sh = await POST('/api/share', { token: tok, body: { ids: [dir.id], password: 'sharepw123' } });
    const stoken = (await POST(`/api/share/${sh.json.share.token}/auth`,
      { body: { password: 'sharepw123' } })).json.stoken;
    const T = sh.json.share.token;
    const q = `stoken=${encodeURIComponent(stoken)}`;
    tok2 = tok;   // 4.5 那节还要用

    const noCookie = await GET(`/api/share/${T}/save-info?${q}`);
    ck('不带登录态 → 401（分享页据此显示"登录后转存"）', noCookie.status, 401);

    const withCookie = await GET(`/api/share/${T}/save-info?${q}`, { cookie: pair });
    ck('带 cookie → 200（登录之后就能转存了）', withCookie.status, 200);
    ck('可以转存', withCookie.json.canSave, true);
    ck('文件数正确', withCookie.json.files, 1);

    /* 真的转一次，确认整条链路通 */
    const saved = await POST(`/api/share/${T}/save?${q}`, { cookie: pair, body: {} });
    ck('用 cookie 完成转存 200', saved.status, 200);
    ck('存了 1 个文件', saved.json.saved, 1);
  }

  /* ================================================================
     4.5 /api/session 要回传票 —— 否则主站"只有 cookie"时没法继续用
     ================================================================ */
  section('4.5 /api/session 回传票');
  {
    const relog = await POST('/api/auth', { body: { username: USER, password: PW } });
    const p2 = cookiePair(relog.setCookie);
    /* 关键：不带 Authorization，只靠 cookie —— 主站从分享页跳回来时就是这个处境 */
    const s = await GET('/api/session', { cookie: p2 });
    ck('只有 cookie 也能拿到会话信息', s.status, 200);
    ckTrue('回传了 token（主站据此继续走 Authorization 头）',
      typeof s.json.token === 'string' && s.json.token.length > 20, s.json.token);
    ck('回传的 token 就是这一张', s.json.token, relog.json.token);
    ckTrue('顺带给了用户信息', !!s.json.user && s.json.user.username === USER);

    /* 分享页"回来时凭本地记的 stoken 换上下文"用的接口 */
    const st0 = store.get();
    const ownerId = st0.users[me.json.account.id].id;
    const dir = await store.mutate(x => tree.createFolder(x, '素材2', null, ownerId));
    const sh = await POST('/api/share', { token: tok2, body: { ids: [dir.id], password: 'sharepw123' } });
    const T = sh.json.share.token;
    ck('错密码换不到 stoken',
      (await POST(`/api/share/${T}/auth`, { body: { password: 'wrong' } })).status, 401);
    const good = await POST(`/api/share/${T}/auth`, { body: { password: 'sharepw123' } });
    const stk = good.json.stoken;

    ck('没带 stoken 换上下文 401',
      (await POST(`/api/share/${T}/session`)).status, 401);
    ck('假 stoken 换上下文 401',
      (await POST(`/api/share/${T}/session?stoken=deadbeef`)).status, 401);

    const ctx = await POST(`/api/share/${T}/session?stoken=${encodeURIComponent(stk)}`);
    ck('凭手上的 stoken 换回上下文 200', ctx.status, 200);
    ckTrue('给了 root（分享页要靠它拼面包屑）', !!ctx.json.root && !!ctx.json.root.id, ctx.json.root);
    ck('给了分享人（头像昵称那一行）', !!ctx.json.sharer, true);
    ck('回传的 stoken 就是同一张', ctx.json.stoken, stk);
    ckTrue('没有下发新票（不是绕过密码）', ctx.json.expire === undefined, ctx.json.expire);

    /* 水印文案由服务端拼好下发（品牌 · 分享人 · 日期）。
       前端只负责画 —— 品牌名在服务端，前端那份是渲染后的 DOM 文本。 */
    ckTrue('给了水印文案', typeof ctx.json.watermark === 'string' && ctx.json.watermark.length > 0, ctx.json.watermark);

    /* 密码验证那条路也要给（两条入口都会渲染水印） */
    const again2 = await POST(`/api/share/${T}/auth`, { body: { password: 'sharepw123' } });
    ckTrue('密码路径也带水印文案', typeof again2.json.watermark === 'string' && again2.json.watermark.length > 0, again2.json.watermark);
  }

  /* ================================================================
     5. 登出要清 cookie
     ================================================================ */
  section('5. 登出清 cookie');
  {
    const out = await POST('/api/logout', { cookie: pair });
    ck('登出 200', out.status, 200);
    const c = pickCookie(out.setCookie);
    ckTrue('下发了清空用的 Set-Cookie', !!c, out.setCookie);
    ckTrue('Max-Age=0（立刻失效）', /Max-Age=0/.test(c), c);

    ck('登出后原 cookie 失效 401', (await GET('/api/account', { cookie: pair })).status, 401);
    ck('登出后原 token 也失效 401', (await GET('/api/account', { token: tok })).status, 401);
  }

  console.log(`\n${'='.repeat(52)}`);
  if (fail) {
    console.log(`\x1b[31m失败 ${fail} 项\x1b[0m，通过 ${pass} 项`);
    failures.forEach(f => console.log('  - ' + f));
  } else {
    console.log(`\x1b[32m全部通过\x1b[0m（${pass} 项）`);
  }

  server.close();
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试本身崩了：', e); process.exit(1); });
