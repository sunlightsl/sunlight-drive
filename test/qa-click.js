/**
 * 交互验证：点击行为到底对不对
 * ------------------------------------------------------------------
 * 只盯两件事，都是实际被反馈过的问题：
 *
 *   1. 单击文件夹能不能进去。
 *      单击若一律选中，想进入目录的用户会被误选。判定依据：
 *      「没有点击勾选却被选中，且无法进入下级目录」。
 *
 *   2. 点完之后列表的 DOM 有没有被整体重建。
 *      这是上面那个问题的另一半：单击时若调 renderPanel()，整片 DOM 被换掉，
 *      浏览器判定「两次点击落在同一个元素上」的依据就没了，dblclick 永不触发。
 *      所以这里直接抓一个行元素的引用，点完之后看它还在不在文档里。
 *
 * 用真浏览器（系统 Edge）+ DevTools 协议，登录走真的两段（密码 + 动态码）。
 * 跑之前先把服务起起来：node dev.js
 *
 *   node test/qa-click.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const totp = require('../lib/totp');
const { CFG } = require('../lib/config');

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].find(p => fs.existsSync(p));

const BASE = process.env.QA_BASE || `http://127.0.0.1:${CFG.port}`;
const CDP_PORT = 9400 + Math.floor(Math.random() * 300);

let pass = 0, fail = 0;
function ck(label, got, want) {
  const ok = String(got) === String(want);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else {
    fail++;
    console.log('  FAIL ' + label);
    console.log(`       期望 ${JSON.stringify(want)}`);
    console.log(`       实际 ${JSON.stringify(got)}`);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function main() {
  if (!EDGE) { console.error('找不到 Edge，跑不了界面验证。'); process.exit(2); }
  if (!CFG.password) { console.error('.env 里没有 SITE_PASSWORD。'); process.exit(2); }
  if (!CFG.totpSecret) {
    console.error('没有 TOTP_SECRET。这个脚本要真走两段登录，请先 node setup-2fa.js。');
    console.error('（只想验密码那一段的话，临时 TOTP_DISABLED=1 起服务再跑，脚本会自动只走一步）');
    if (!CFG.totpHardOff) process.exit(2);
  }

  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'sunlight-click-'));
  const edge = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${udd}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1416,900',
    'about:blank'
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    /* ---------- 连 CDP ---------- */
    let target = null;
    for (let i = 0; i < 80 && !target; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
        const list = await r.json();
        target = list.find(t => t.type === 'page');
      } catch (_) { /* 还没起来，接着等 */ }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('连不上 Edge 的调试端口');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });

    let seq = 0;
    const waiting = new Map();
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
    });

    const send = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });

    /* 在页面里跑一段表达式，把结果按值取回来 */
    async function ev(expr) {
      const r = await send('Runtime.evaluate', {
        // 包成 async 才能在里面写 await（比如 await gotoDir(...)），
        // awaitPromise 负责把返回的 promise 等到落地再取值
        expression: `(async function(){ ${expr} })()`,
        awaitPromise: true,
        returnByValue: true
      });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error((d.exception && d.exception.description) || d.text);
      }
      return r.result.value;
    }

    async function waitFor(expr, label, timeout = 15000) {
      const t0 = Date.now();
      let last = null;
      while (Date.now() - t0 < timeout) {
        try { if (await ev(`return !!(${expr});`)) return true; } catch (e) { last = e; }
        await sleep(150);
      }
      throw new Error(`等不到「${label}」${last ? '（' + last.message + '）' : ''}`);
    }

    await send('Page.enable');
    await send('Runtime.enable');

    /* ---------- 打开页面 ---------- */
    console.log('\n== 打开 ' + BASE + ' ==');
    await send('Page.navigate', { url: BASE });
    await waitFor('document.querySelector("#pwd")', '密码输入框');

    /* ---------- 第一段：密码 ---------- */
    console.log('\n== 登录：第一段 密码 ==');
    await ev(`document.querySelector('#pwd').value = ${JSON.stringify(CFG.password)}; submitPwd();`);
    if (CFG.totpHardOff || !CFG.totpSecret) {
      await waitFor('document.querySelector("#app").classList.contains("on")', '进入主界面');
    } else {
      await waitFor('getComputedStyle(document.querySelector("#step2")).display !== "none"', '动态码这一步');

      /* ---------- 第二段：动态码 ---------- */
      console.log('== 登录：第二段 动态码 ==');
      const code = totp.code(CFG.totpSecret);
      await ev(`document.querySelector('#code').value = ${JSON.stringify(code)}; submitCode();`);
      await waitFor('document.querySelector("#app").classList.contains("on")', '进入主界面');
    }
    await waitFor('S.children && S.children.length > 0', '文件列表加载完成');

    /* ================================================================
       1. 单击文件夹应该进目录
       ================================================================ */
    console.log('\n== 单击文件夹 ==');
    ck('顶层第一个是「示例目录」', await ev('return S.children[0] && S.children[0].name;'), '示例目录');
    ck('此刻在顶层（current 为空）', await ev('return S.current === null || S.current === undefined;'), true);

    const wantSub = JSON.stringify(['主程序', '升级包', '工具软件', '故障处理'].sort());
    await ev(`document.querySelector('#panel [data-id]').click(); return 1;`);
    await sleep(700);

    ck('单击文件夹后真的进去了',
      await ev('return JSON.stringify(S.children.map(n => n.name).sort());'), wantSub);
    ck('面包屑记下了当前层级',
      await ev('return S.current ? S.current.name : "(空)";'), '示例目录');
    ck('面包屑的祖先链不含当前目录（契约如此）',
      await ev('return S.breadcrumb.length;'), 0);

    /* ================================================================
       2. 点勾选框：只选中，不该进目录
       ================================================================ */
    console.log('\n== 点勾选框 ==');
    await ev(`await gotoDir('__root'); return 1;`);
    await sleep(500);
    ck('回到顶层', await ev('return S.current === null;'), true);

    await ev(`document.querySelector('#panel [data-id] .cb').click(); return 1;`);
    await sleep(250);
    ck('勾选框把这一项选中了', await ev('return S.sel.size;'), 1);
    ck('点勾选框不会误进目录', await ev('return S.current === null;'), true);
    ck('行上有选中样式', await ev(`return document.querySelector('#panel [data-id]').classList.contains('sel');`), true);

    /* ================================================================
       3. 关键：点击后列表 DOM 不能被整体重建
       —— 重建就等于 dblclick 永久失效（两次点击落在不同元素上）
       ================================================================ */
    console.log('\n== 点击会不会重建列表 DOM ==');
    await ev(`window.__probe = document.querySelector('#panel [data-id]'); return 1;`);
    await ev(`document.querySelector('#panel [data-id] .cb').click(); return 1;`);
    await sleep(250);
    ck('点击后原来的行元素还在文档里（DOM 没被重建）',
      await ev('return document.contains(window.__probe);'), true);

    // 再点一次另一个（清掉选中），确认反复点击也不重建
    await ev(`document.querySelector('#panel [data-cb="__all"]').click(); return 1;`);
    await sleep(250);
    ck('全选之后原元素仍在（没有整片重绘）',
      await ev('return document.contains(window.__probe);'), true);
    ck('全选把当前目录的项全选上了',
      await ev('return S.sel.size === currentList().length;'), true);
    ck('表头的全选勾选框亮起来了',
      await ev(`return document.querySelector('#panel [data-cb="__all"]').classList.contains('on');`), true);

    /* ================================================================
       4. 单击文件：应该是选中，不该触发下载
       ================================================================ */
    console.log('\n== 单击文件 ==');
    // 从全站扁平列表拿 id：此刻还在顶层，S.children 里只有「示例目录」
    await ev(`await gotoDir(S.flat.find(n => n.name === '升级包').id); return 1;`);
    await sleep(800);
    ck('进了「升级包」', await ev('return S.children.length;'), 143);
    ck('里面都是文件', await ev(`return S.children.every(n => n.type === 'file');`), true);

    await ev(`S.sel.clear(); syncSel(); document.querySelector('#panel [data-id]').click(); return 1;`);
    await sleep(300);
    ck('单击文件是选中', await ev('return S.sel.size;'), 1);
    ck('单击文件没有触发下载', await ev('return S.busy.size;'), 0);

    /* ================================================================
       5. 截一张带选中状态的图（人眼核对布局用）
       ================================================================ */
    console.log('\n== 截图 ==');
    await ev(`
      scrollTo(0, 0);
      S.sel.clear();
      S.sel.add(S.children[0].id);
      if (S.children[1]) S.sel.add(S.children[1].id);
      syncSel();
      return 1;
    `);
    await sleep(600);            // 等操作条的滑入动画走完
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const shotPath = path.join(os.tmpdir(), 'sunlight-click.png');
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log('  已保存：' + shotPath);

    // 暗色下再看一眼：浮层用 --bg-sunken，比页面底色略亮，主要靠边框分界
    await ev(`document.documentElement.setAttribute('data-theme', 'dark'); return 1;`);
    await sleep(350);
    const shot2 = await send('Page.captureScreenshot', { format: 'png' });
    const shotPath2 = path.join(os.tmpdir(), 'sunlight-click-dark.png');
    fs.writeFileSync(shotPath2, Buffer.from(shot2.data, 'base64'));
    console.log('  已保存：' + shotPath2);

    /* ---------- 收尾 ---------- */
    console.log('\n' + '='.repeat(52));
    if (fail) {
      console.log(`\x1b[31m失败 ${fail} 项\x1b[0m，通过 ${pass} 项`);
      process.exitCode = 1;
    } else {
      console.log(`\x1b[32m全部通过\x1b[0m（${pass} 项）`);
      process.exitCode = 0;
    }
  } catch (e) {
    console.error('\n验证脚本本身崩了：', (e && e.stack) || e);
    process.exitCode = 1;
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { edge.kill(); } catch (_) {}
    await sleep(400);
    try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {}
    process.exit(process.exitCode || 0);
  }
})();
