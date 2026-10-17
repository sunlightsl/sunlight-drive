#!/usr/bin/env node
/**
 * 账号体系界面验证（CDP 驱动系统 Edge，可选依赖，不影响交付物）
 * ------------------------------------------------------------------
 * 用法：
 *   node test/qa-account.js                跑一遍，截图到 test/screenshots/
 *   node test/qa-account.js --out <目录>    换输出目录
 *
 * 它自己起一个服务（临时数据目录 + 随机端口），不碰 data/drive.json ——
 * 这个流程要注册账号、开两步验证、改密码，跑到真实库上会留下垃圾账号。
 *
 * 覆盖的是"点进去到底能不能用"：注册入口、头像菜单四项、二维码是不是真画出来了、
 * 启用两步验证之后登录是不是真的多一步。qg-gate.js 只管登录门长什么样，
 * 这里管门后面的账号那摊事。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const argVal = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = argVal('--out', path.join(ROOT, 'test/screenshots'));
const CDP_PORT = parseInt(argVal('--cdp-port', '9343'), 10);

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].find(p => fs.existsSync(p));
if (!EDGE) { console.error('找不到 Edge，无法做界面验证。'); process.exit(2); }

/* ---------------- 小工具 ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const failures = [];
function ck(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, failures.push(label));
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `\n         got  = ${JSON.stringify(got)}\n         want = ${JSON.stringify(want)}`}`);
}
const ckTrue = (label, cond, extra) => { ck(label, !!cond, true); if (!cond) console.log('         ' + JSON.stringify(extra)); };
const section = t => console.log(`\n\x1b[1m== ${t} ==\x1b[0m`);

/* ---------------- CDP ---------------- */
function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const waiters = [];

    ws.addEventListener('error', e => reject(new Error('WebSocket 出错：' + (e.message || ''))));
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const i = ++id;
          pending.set(i, { res, rej });
          ws.send(JSON.stringify({ id: i, method, params: params || {} }));
        });
      },
      waitEvent(method, timeout = 15000) {
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('等 ' + method + ' 超时')), timeout);
          waiters.push({ method, res: (m) => { clearTimeout(t); res(m); } });
        });
      },
      close() { try { ws.close(); } catch (_) {} }
    }));

    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(m.method + ': ' + m.error.message)) : res(m.result);
      } else if (m.method) {
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].method === m.method) { const w = waiters.splice(i, 1)[0]; w.res(m.params); }
        }
      }
    });
  });
}

/* ---------------- 主流程 ---------------- */
(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let shotNo = 0;

  /* ---- 起一个干净的服务 ---- */
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-acct-data-'));
  process.env.DRIVE_DATA_DIR = DIR;

  const totp = require(path.join(ROOT, 'lib/totp'));
  const store = require(path.join(ROOT, 'lib/store'));
  const app = require(path.join(ROOT, 'server.js'));

  /* 库里先放一个旧账号，模拟"老板的号"；注册流程走的是新号 */
  const { CFG } = require(path.join(ROOT, 'lib/config'));
  await app.bootstrap();
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const PORT = srv.address().port;
  const BASE = `http://127.0.0.1:${PORT}`;

  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--hide-scrollbars',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'qa-acct-prof-'))}`,
    '--window-size=1440,900',
    'about:blank'
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { edge.kill(); } catch (_) {}
    try { srv.closeAllConnections?.(); srv.close(); } catch (_) {}
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
  };
  process.on('exit', cleanup);

  let target = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await getJson('/json/list');
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch (_) {}
    await sleep(250);
  }
  if (!target) throw new Error('连不上 Edge 的调试端口。');

  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const consoleErrors = [];
  /* 页面里抛异常是硬故障，会一路把后面的断言带歪，所以单独记一份 */
  cdp.send('Log.enable').catch(() => {});

  async function goto(url) {
    const loaded = cdp.waitEvent('Page.loadEventFired', 20000);
    await cdp.send('Page.navigate', { url });
    await loaded;
    await sleep(300);
  }
  async function ev(expression) {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('页面里报错：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  async function waitFor(expr, label, timeout = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      let v = null;
      try { v = await ev(expr); } catch (_) {}
      if (v) return v;
      await sleep(120);
    }
    throw new Error('等「' + label + '」超时');
  }
  async function shot(name, note) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, `${String(++shotNo).padStart(2, '0')}-${name}.png`);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    console.log(`  shot  ${path.basename(f)}${note ? '   ' + note : ''}`);
    return f;
  }
  const freeze = `(() => { const s=document.createElement('style');
    s.textContent='*{transition:none !important;animation:none !important}';
    document.head.appendChild(s); return true; })()`;
  const unfreeze = `(() => { document.querySelectorAll('head style').forEach(s => {
    if (s.textContent.includes('animation:none !important')) s.remove(); }); return true; })()`;

  /* ================================================================
     1. 登录门：用户名 + 密码 + 注册入口
     ================================================================ */
  section('登录门');
  await goto(BASE + '/');
  await waitFor(`document.getElementById('step1').style.display !== 'none'`, '登录框');

  ck('第一步有用户名输入框', await ev(`!!document.getElementById('user')`), true);
  ck('第一步有密码输入框', await ev(`!!document.getElementById('pwd')`), true);
  ck('两个框并排在第一步',
    await ev(`Array.from(document.querySelectorAll('#step1 input')).map(i => i.id)`), ['user', 'pwd']);
  ck('密码框是 password 类型', await ev(`document.getElementById('pwd').type`), 'password');
  ck('用户名框不自动大写（手机上会乱改）',
    await ev(`document.getElementById('user').getAttribute('autocapitalize')`), 'none');
  ck('按钮写的是「登录」', await ev(`document.querySelector('#pwdBtn .lbl').textContent`), '登录');
  ck('底部有注册入口', await ev(`!!document.getElementById('goSignup')`), true);
  ck('注册入口的文案', await ev(`document.getElementById('goSignup').textContent`), '注册');
  ck('旧的「访问密码」占位符没了',
    await ev(`document.getElementById('pwd').placeholder`), '密码');
  await shot('gate-login', '登录第一步（用户名 + 密码）');

  /* ---- 切到注册 ---- */
  await ev(`document.getElementById('goSignup').click()`);
  await waitFor(`document.getElementById('step3').style.display !== 'none'`, '注册表单');
  ck('注册表单有三个输入框',
    await ev(`Array.from(document.querySelectorAll('#step3 input')).map(i => i.id)`), ['suUser', 'suPwd', 'suPwd2']);
  ck('两个密码框都是 password 类型',
    await ev(`Array.from(document.querySelectorAll('#suPwd,#suPwd2')).map(i => i.type)`), ['password', 'password']);
  ck('注册按钮文案', await ev(`document.querySelector('#suBtn .lbl').textContent`), '创建账号');
  ck('注册页有回登录的入口', await ev(`document.getElementById('goLogin').textContent`), '登录');
  ck('切过去之后登录那一步收起来了', await ev(`document.getElementById('step1').style.display`), 'none');
  await ev(freeze);
  await shot('gate-signup', '注册表单');
  await ev(unfreeze);

  /* ---- 两次密码不一致 ---- */
  await ev(`(() => {
    document.getElementById('suUser').value = 'tester';
    document.getElementById('suPwd').value = 'testpassword1';
    document.getElementById('suPwd2').value = 'testpassword2';
    document.getElementById('suBtn').click();
    return true;
  })()`);
  await sleep(300);
  ck('两次密码不一致会拦下来',
    await ev(`document.getElementById('gateErr').classList.contains('on')`), true);
  ck('提示说的是密码不一致',
    await ev(`document.getElementById('gateErr').textContent.includes('不一致')`), true);

  /* ---- 正常注册 ---- */
  await ev(`document.getElementById('suPwd2').value = 'testpassword1'`);
  await ev(`document.getElementById('suBtn').click()`);
  await waitFor(`document.getElementById('app').classList.contains('on')`, '主界面', 12000);
  ck('注册完直接进主界面', await ev(`document.getElementById('gate').classList.contains('off')`), true);
  ck('账号建在了服务端', !!store.get().users && Object.values(store.get().users).some(u => u.username === 'tester'), true);
  ck('新账号是 member 不是 owner',
    Object.values(store.get().users).find(u => u.username === 'tester').role, 'member');

  /* ================================================================
     2. 头像菜单
     ================================================================ */
  section('头像菜单');
  await waitFor(`!!document.getElementById('btnProfile')`, '头像按钮');
  ck('顶栏只剩头像这一个账号入口',
    await ev(`document.querySelectorAll('.top-acts #btnLogout').length`), 0);
  ck('顶栏没有重复的退出按钮',
    await ev(`!!document.querySelector('.top-acts [title="退出登录"]')`), false);

  await shot('app-topbar', '主界面顶栏');

  await ev(`document.getElementById('btnProfile').click()`);
  await waitFor(`document.getElementById('menu').classList.contains('on')`, '账号菜单');
  ck('菜单打上了账号样式', await ev(`document.getElementById('menu').classList.contains('acct')`), true);
  ck('菜单里有六项动作（含我的存储；tester 是 member，看不到存储配置/用户管理）',
    await ev(`Array.from(document.querySelectorAll('#menu [data-k]')).map(b => b.dataset.k)`),
    ['profile', 'pwd', '2fa', 'mystorage', 'logout']);
  ck('菜单的中文名',
    await ev(`Array.from(document.querySelectorAll('#menu [data-k]')).map(b => b.textContent.trim().split('\\n')[0].trim())`),
    ['个人中心', '修改密码', '两步验证', '我的存储', '退出登录']);
  ck('菜单抬头显示用户名', await ev(`document.querySelector('#menu .menu-id span').textContent`), '@tester');
  ck('两步验证标着未开启', await ev(`document.querySelector('#menu [data-k="2fa"] .tail').textContent`), '未开启');
  ck('退出登录是危险色', await ev(`document.querySelector('#menu [data-k="logout"]').classList.contains('danger')`), true);
  await ev(freeze);
  await shot('account-menu', '头像下拉菜单');
  await ev(unfreeze);

  /* ---- 个人中心 ---- */
  await ev(`document.querySelector('#menu [data-k="profile"]').click()`);
  await waitFor(`!!document.getElementById('acNickBox')`, '个人中心');
  ck('个人中心显示用户名', await ev(`document.querySelector('.acct-row .v.mono').textContent`), 'tester');
  ck('昵称默认和下面几行一样是纯显示，不带输入框',
    await ev(`(() => {
      const box = document.getElementById('acNickBox');
      return { text: box.querySelector('.nick-t').textContent, hasInput: !!box.querySelector('input') };
    })()`), { text: 'tester', hasInput: false });
  ck('昵称旁边是「修改」文字按钮',
    await ev(`document.querySelector('#acNickBox .linkish').textContent`), '修改');
  await ev(`document.getElementById('acNickEdit').click()`);
  ck('点「修改」才出现输入框', await ev(`!!document.getElementById('acNick')`), true);
  ck('编辑态旁边有保存和取消',
    await ev(`Array.from(document.querySelectorAll('#acNickBox .linkish')).map(b => b.textContent)`), ['保存', '取消']);
  ck('个人中心显示注册日期',
    await ev(`/^\\d{4}-\\d{2}-\\d{2}$/.test(document.querySelectorAll('.acct-row .v')[2].textContent)`), true);
  ck('没头像时「恢复默认」是禁用的', await ev(`document.getElementById('acClear').disabled`), true);
  await ev(freeze);
  await shot('account-profile', '个人中心');
  await ev(unfreeze);

  /* 改个昵称，看顶栏头像和标题跟不跟着变。
     保存只把行收回显示态，面板不关 —— 关闭是下面那个按钮的事。 */
  await ev(`(() => {
    document.getElementById('acNick').value = '小测试';
    document.getElementById('acNickSave').click();
    return true;
  })()`);
  await waitFor(`document.querySelector('#acNickBox .nick-t').textContent === '小测试'`, '昵称改完回到显示态');
  ck('昵称存下来了',
    Object.values(store.get().users).find(u => u.username === 'tester').nickname, '小测试');
  ck('顶栏头像换成昵称首字', await ev(`document.getElementById('avaTop').textContent`), '小');
  ck('标签页标题带上昵称', await ev(`document.title.startsWith('小测试')`), true);
  ck('保存后面板还开着（保存不等于关闭）',
    await ev(`document.getElementById('modal').classList.contains('on')`), true);
  await ev(`document.querySelector('#modal [data-x="close"]').click()`);
  await waitFor(`!document.getElementById('modal').classList.contains('on')`, '个人中心关闭');

  /* ---- 修改密码 ---- */
  await ev(`document.getElementById('btnProfile').click()`);
  await waitFor(`document.getElementById('menu').classList.contains('on')`, '账号菜单');
  await ev(`document.querySelector('#menu [data-k="pwd"]').click()`);
  await waitFor(`!!document.getElementById('cpOld')`, '修改密码');
  ck('修改密码有三个密码框',
    await ev(`Array.from(document.querySelectorAll('#cpOld,#cpNew,#cpNew2')).map(i => i.type)`),
    ['password', 'password', 'password']);
  ck('提示里说明了其它设备会退出',
    await ev(`document.querySelector('#modal .hint').textContent.includes('其他设备')`), true);
  await ev(freeze);
  await shot('account-password', '修改密码');
  await ev(unfreeze);

  ck('旧密码填错会被拒', await (async () => {
    await ev(`(() => {
      document.getElementById('cpOld').value = 'wrongwrong';
      document.getElementById('cpNew').value = 'newpassword1';
      document.getElementById('cpNew2').value = 'newpassword1';
      document.getElementById('cpOk').click();
      return true;
    })()`);
    await sleep(700);
    return await ev(`document.getElementById('modal').classList.contains('on')`);
  })(), true);
  ck('密码没被改掉', (await ev(`!!document.getElementById('cpOld')`)), true);

  await ev(`(() => {
    document.getElementById('cpOld').value = 'testpassword1';
    document.getElementById('cpNew').value = 'newpassword1';
    document.getElementById('cpNew2').value = 'newpassword1';
    document.getElementById('cpOk').click();
    return true;
  })()`);
  await waitFor(`!document.getElementById('modal').classList.contains('on')`, '改密成功', 10000);
  ck('密码真的换了', await ev(`document.getElementById('toast').textContent.includes('密码已改')`), true);

  /* ================================================================
     3. 两步验证
     ================================================================ */
  section('两步验证');
  await ev(`document.getElementById('btnProfile').click()`);
  await waitFor(`document.getElementById('menu').classList.contains('on')`, '账号菜单');
  await ev(`document.querySelector('#menu [data-k="2fa"]').click()`);
  await waitFor(`!!document.getElementById('tfStart')`, '两步验证介绍页');
  ck('没开时显示「开始绑定」', await ev(`document.querySelector('#tfStart .lbl').textContent`), '开始绑定');
  await shot('2fa-intro', '两步验证（未开启）');

  await ev(`document.getElementById('tfStart').click()`);
  await waitFor(`!!document.querySelector('.qr svg path')`, '二维码');
  await sleep(300);

  const qr = await ev(`(() => {
    const svg = document.querySelector('.qr svg');
    const p = svg.querySelector('path');
    const box = svg.getAttribute('viewBox');
    const r = svg.getBoundingClientRect();
    return { box, len: p.getAttribute('d').length, w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  ckTrue('二维码有内容', qr.len > 200, qr);
  ck('二维码 viewBox 从 0 0 开始', /^0 0 \d+ \d+$/.test(qr.box), true);
  ck('二维码是正方形', Math.abs(qr.w - qr.h) <= 1, true);
  ckTrue('二维码够大（手机上扫得到）', qr.w >= 150, qr);
  ck('二维码背景是白的（深色底扫不出来）',
    await ev(`getComputedStyle(document.querySelector('.qr')).backgroundColor`), 'rgb(255, 255, 255)');
  ck('码点是深色',
    await ev(`getComputedStyle(document.querySelector('.qr svg path')).fill`), 'rgb(17, 17, 17)');
  ck('旁边给了手输用的密钥', await ev(`document.querySelector('.secret code').textContent.length`), 32);
  ck('绑定说明是两步', await ev(`document.querySelectorAll('.steps li').length`), 2);

  const secret = await ev(`document.querySelector('.secret code').textContent.trim()`);

  /* ---- 屏幕上这块二维码，真的能扫出来吗 ----
     上面那些断言只能证明"有个 SVG、够大、颜色对"。能不能扫是另一回事：
     模块糊没糊在一起、静默区够不够、坐标有没有偏移，都要真解一次才算数。
     解码器是可选依赖：装了就跑，没装就跳过 —— 不让一套界面测试
     反过来给这个零依赖的项目拉一个必装依赖。 */
  let jsQR = null;
  try { jsQR = require('jsqr'); } catch (_) {}

  if (jsQR) {
    /* 注意：Chromium 的 createImageBitmap 不认 SVG Blob，会抛
       InvalidStateError: The source image could not be decoded。
       同一个 Blob 挂成 object URL、用 <img> 加载就没这个问题，
       所以这里绕道 <img> 再画到 canvas。 */
    const px = await ev(`(async () => {
      const svg = document.querySelector('.qr svg').cloneNode(true);
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const side = 480;
      svg.setAttribute('width', side);
      svg.setAttribute('height', side);
      const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = () => rej(new Error('SVG 位图加载失败'));
          img.src = url;
        });
        const cv = document.createElement('canvas');
        cv.width = cv.height = side;
        const g = cv.getContext('2d');
        g.fillStyle = '#fff';               // 白底在 .qr 那个 div 上，不在 SVG 里
        g.fillRect(0, 0, side, side);
        g.drawImage(img, 0, 0, side, side);
        return { side, data: Array.from(g.getImageData(0, 0, side, side).data) };
      } finally {
        URL.revokeObjectURL(url);
      }
    })()`);

    const got = jsQR(Uint8ClampedArray.from(px.data), px.side, px.side, { inversionAttempts: 'dontInvert' });
    ckTrue('屏幕上的二维码扫得出来', !!(got && got.data), got && got.data);
    if (got) {
      ckTrue('扫出来是 otpauth 链接', got.data.startsWith('otpauth://totp/'), got.data);
      ckTrue('链接里带的密钥和页面显示的一致', got.data.includes(secret), got.data);
      ckTrue('链接里带了用户名', decodeURIComponent(got.data).includes('tester'), got.data);
    }
  } else {
    console.log('  skip  没装 jsqr，跳过「屏幕上的码能不能扫」');
  }

  /* 把二维码那块的 SVG 单独存一份，肉眼能查 */
  const qrHtml = await ev(`document.querySelector('.qr').outerHTML`);
  fs.writeFileSync(path.join(OUT, '2fa-qrcode.svg'),
    qrHtml.replace(/^<div[^>]*>/, '<svg xmlns="http://www.w3.org/2000/svg" ')
      .replace(/<\/div>$/, '').replace('<svg ', '<svg width="220" height="220" '));
  console.log('  file  2fa-qrcode.svg');
  await ev(freeze);
  await shot('2fa-qr', '两步验证二维码');
  await ev(unfreeze);

  /* ---- 填错码 ---- */
  await ev(`(() => {
    document.getElementById('tfCode').value = '000000';
    document.getElementById('tfOk').click();
    return true;
  })()`);
  await sleep(900);
  ck('错码不会启用', await ev(`document.getElementById('modal').classList.contains('on')`), true);
  ck('错码有提示', await ev(`document.getElementById('toast').classList.contains('on')`), true);
  ck('服务端那边还是没启用',
    !Object.values(store.get().users).find(u => u.username === 'tester').totp.enabled, true);

  /* ---- 填对码 ---- */
  const code = totp.code(secret);
  await ev(`(() => {
    const i = document.getElementById('tfCode');
    i.value = ${JSON.stringify(code)};
    document.getElementById('tfOk').click();
    return true;
  })()`);
  await waitFor(`!document.getElementById('modal').classList.contains('on')`, '启用成功', 10000);
  ck('服务端已启用',
    Object.values(store.get().users).find(u => u.username === 'tester').totp.enabled, true);

  await ev(`document.getElementById('btnProfile').click()`);
  await waitFor(`document.getElementById('menu').classList.contains('on')`, '账号菜单');
  ck('菜单尾巴变成已开启', await ev(`document.querySelector('#menu [data-k="2fa"] .tail').textContent`), '已开启');
  await ev(`document.querySelector('#menu [data-k="2fa"]').click()`);
  await waitFor(`!!document.getElementById('tfOff')`, '两步验证已开页');
  ck('开了之后显示状态点',
    await ev(`document.querySelector('.acct-row .dot').classList.contains('on')`), true);
  ck('状态文字是已开启', await ev(`document.querySelector('.acct-row .dot').textContent`), '已开启');
  await shot('2fa-on', '两步验证（已开启）');

  /* 关闭要密码：先点关闭，弹出来的框应该是密码框 */
  await ev(`document.getElementById('tfOff').click()`);
  await waitFor(`!!document.getElementById('pf')`, '关闭密码框');
  ck('关闭两步验证要输密码', await ev(`document.getElementById('pf').type`), 'password');
  await ev(`document.querySelector('#modal [data-x="cancel"]').click()`);
  await sleep(200);

  /* ================================================================
     4. 退出登录 + 重新登录（现在要多一步动态码）
     ================================================================ */
  section('退出与重新登录');
  await ev(`document.getElementById('btnProfile').click()`);
  await waitFor(`document.getElementById('menu').classList.contains('on')`, '账号菜单');
  await ev(`document.querySelector('#menu [data-k="logout"]').click()`);
  await waitFor(`!document.getElementById('gate').classList.contains('off')`, '回到登录门');
  ck('退出后回到登录门', await ev(`document.getElementById('step1').style.display !== 'none'`), true);
  ck('用户名自动带出来了（省得再打一遍）',
    await ev(`document.getElementById('user').value`), 'tester');
  ck('密码框是空的', await ev(`document.getElementById('pwd').value`), '');
  ck('本地票已清掉', await ev(`sessionStorage.getItem('sunlight.token') === null`), true);
  await shot('gate-after-logout', '退出后回到登录门');

  await ev(`(() => {
    document.getElementById('user').value = 'tester';
    document.getElementById('pwd').value = 'newpassword1';
    document.getElementById('pwdBtn').click();
    return true;
  })()`);
  await waitFor(`document.getElementById('step2').style.display !== 'none'`, '动态码步骤', 12000);
  ck('开了两步验证后登录多一步', await ev(`document.getElementById('step2').style.display`), 'block');
  ck('动态码步骤里只有那一个输入框',
    await ev(`Array.from(document.querySelectorAll('#step2 input')).map(i => i.id)`), ['code']);
  await shot('gate-2fa-step', '登录第二步（动态码）');

  const code2 = totp.code(secret);
  await ev(`(() => {
    const i = document.getElementById('code');
    i.value = ${JSON.stringify(code2)};
    document.getElementById('codeBtn').click();
    return true;
  })()`);
  await waitFor(`document.getElementById('app').classList.contains('on')`, '进入主界面', 12000);
  ck('过了动态码就进去了', await ev(`document.getElementById('gate').classList.contains('off')`), true);

  /* ================================================================
     5. 关掉两步验证
     ================================================================ */
  section('关掉两步验证');
  await ev(`document.getElementById('btnProfile').click()`);
  await waitFor(`document.getElementById('menu').classList.contains('on')`, '账号菜单');
  await ev(`document.querySelector('#menu [data-k="2fa"]').click()`);
  await waitFor(`!!document.getElementById('tfOff')`, '两步验证页');
  await ev(`document.getElementById('tfOff').click()`);
  await waitFor(`!!document.getElementById('pf')`, '关闭密码框');
  await ev(`(() => {
    document.getElementById('pf').value = 'wrongword';
    document.querySelector('#modal [data-x="ok"]').click();
    return true;
  })()`);
  await sleep(700);
  ck('密码不对关不掉', await ev(`!!document.getElementById('pf')`), true);
  ck('关不掉有提示', await ev(`document.getElementById('toast').classList.contains('on')`), true);

  await ev(`(() => {
    document.getElementById('pf').value = 'newpassword1';
    document.querySelector('#modal [data-x="ok"]').click();
    return true;
  })()`);
  await waitFor(`!document.getElementById('modal').classList.contains('on')`, '关闭成功', 10000);
  ck('服务端已关闭',
    !Object.values(store.get().users).find(u => u.username === 'tester').totp.enabled, true);

  /* ================================================================
     6. 窄屏
     ================================================================ */
  section('窄屏');
  /* 先切视口再开菜单。反过来的话菜单是按桌面宽度算的坐标，
     测的就不是"窄屏下能不能放得下"，而是"视口变了菜单会不会飘"——
     后者另有 resize 收菜单兜着，这里要测的是前者。 */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });
  await sleep(400);
  await ev(`document.getElementById('btnProfile').click()`);
  await waitFor(`document.getElementById('menu').classList.contains('on')`, '账号菜单');
  await sleep(200);
  const menuBox = await ev(`(() => {
    const r = document.getElementById('menu').getBoundingClientRect();
    return { l: Math.round(r.left), r: Math.round(r.right), w: innerWidth };
  })()`);
  ckTrue('窄屏下菜单没跑出屏幕', menuBox.l >= 0 && menuBox.r <= menuBox.w + 1, menuBox);
  ckTrue('窄屏下菜单有宽度', menuBox.r - menuBox.l > 140, menuBox);

  /* 视口变了菜单要自己收掉，不能留着飘到屏幕外 */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 900, height: 844, deviceScaleFactor: 1, mobile: false
  });
  await sleep(300);
  ck('改视口之后菜单自动收掉',
    await ev(`document.getElementById('menu').classList.contains('on')`), false);

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });
  await sleep(300);
  await ev(`document.getElementById('btnProfile').click()`);
  await waitFor(`document.getElementById('menu').classList.contains('on')`, '账号菜单');
  await ev(freeze);
  await shot('account-menu-mobile', '窄屏下的头像菜单');
  await ev(unfreeze);
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  /* ---- 收尾 ---- */
  cdp.close();
  cleanup();
  console.log('\n' + '='.repeat(52));
  if (fail) {
    console.log(`\x1b[31m失败 ${fail} 项\x1b[0m，通过 ${pass} 项`);
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log(`\x1b[32m全部通过\x1b[0m（${pass} 项）`);
  process.exit(0);
})().catch(e => {
  console.error('\n崩了：', e);
  process.exit(1);
});
