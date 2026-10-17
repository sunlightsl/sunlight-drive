/**
 * 刷新恢复的端到端验证（node tmp/recover.js）
 * ------------------------------------------------------------------
 * 覆盖的是这个场景：正在传一堆文件时按了 F5，未完成的记录会不会丢、
 * 能不能找回来、找回来是"续传"还是"重传"。
 *
 * 起真服务、开真浏览器（Edge 无头），用 CDP 驱动。不依赖任何第三方包 ——
 * WebSocket 用的是 Node 22 内置的那个（浏览器同款 API）。
 *
 * 需要本机装了 Edge；没装就跳过。
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];
const BROWSER = EDGE_CANDIDATES.find(p => fs.existsSync(p));
if (!BROWSER) { console.log('  (没找到 Edge/Chrome，跳过界面测试)'); process.exit(0); }
if (typeof WebSocket !== 'function') {
  console.log('  (需要 Node 22+ 的内置 WebSocket，当前 ' + process.version + '，跳过)');
  process.exit(0);
}

const CPORT = 9399, SPORT = 3666;
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'tmp', '_rr');

let pass = 0, fail = 0;
const ck = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `   got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const getJson = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CPORT, path: p }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(SPORT), DRIVE_DATA_DIR: DATA,
           SITE_PASSWORD: 'rr-pass-123', ADMIN_USERNAME: 'boss',
           TOTP_DISABLED: '1', TOTP_SECRET: '', BRAND: 'Sunlight云盘' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  srv.stdout.on('data', d => log += d);
  for (let i = 0; i < 30 && !/页面\s+http/.test(log); i++) await wait(400);
  ck('server up', /页面\s+http/.test(log), true);

  const profile = path.join(ROOT, 'tmp', '_ep-rec');
  fs.rmSync(profile, { recursive: true, force: true });
  const edge = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${CPORT}`, `--user-data-dir=${profile}`,
    '--window-size=1200,900', `http://127.0.0.1:${SPORT}/`], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try { targets = await getJson('/json/list'); if (targets.some(t => t.url.includes(String(SPORT)))) break; } catch (_) {}
    await wait(500);
  }
  const page = targets.find(t => t.type === 'page' && t.url.includes(String(SPORT)));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  ws.addEventListener('message', ev => {
    const x = JSON.parse(ev.data);
    if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    setTimeout(() => rej(new Error('CDP 连接超时')), 15000);
  });
  const send = (m, p) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const js = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value
      : (r.result && r.result.exceptionDetails ? 'ERR:' + r.result.exceptionDetails.text : undefined);
  };
  await wait(2200);

  ck('login', await js(`(async () => {
    const r = await fetch('/api/auth', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({username:'boss', password:'rr-pass-123'}) });
    const d = await r.json();
    if (!d.token) return 'FAIL';
    S.token = d.token;
    sessionStorage.setItem('sunlight.token', d.token);
    const me = await (await fetch('/api/account', { headers:{Authorization:'Bearer '+d.token} })).json();
    S.account = me.account;
    document.getElementById('gate').style.display='none';
    document.getElementById('app').style.display='block';
    return 'ok';
  })()`), 'ok');

  console.log('\n== 1. 传一半：3 个任务（1 大 + 2 小）==');
  ck('seed jobs', await js(`
    (() => {
      localStorage.setItem('sl_mp_boss|big.zip|104857600|1730000000000', 'OSSID-abc');
      S.uploads = [
        {id:'j1',name:'small1.zip',size:5*1024*1024,loaded:2*1024*1024,status:'up',parent:null,
         file:{name:'small1.zip',size:5*1024*1024,lastModified:11}},
        {id:'j2',name:'small2.zip',size:8*1024*1024,loaded:0,status:'wait',parent:null,
         file:{name:'small2.zip',size:8*1024*1024,lastModified:22}},
        {id:'j3',name:'big.zip',size:100*1024*1024,loaded:40*1024*1024,status:'up',parent:null,
         file:{name:'big.zip',size:100*1024*1024,lastModified:1730000000000}}
      ];
      renderUploads();
      $('upPanel').classList.add('on');
      return 'ok';
    })()
  `), 'ok');
  ck('rows in panel', await js(`document.querySelectorAll('.up-item').length`), 3);
  ck('pending written', await js(`JSON.parse(localStorage.getItem('sunlight.pending')||'{}').rows?.length`), 3);
  ck('record user-scoped', await js(`JSON.parse(localStorage.getItem('sunlight.pending')||'{}').user`), 'boss');

  console.log('\n== 2. 刷新页面 ==');
  await send('Page.reload', {});
  await wait(4000);
  ck('memory queue cleared', await js(`S.uploads.length`), 0);
  ck('breakpoint survived', await js(`Object.keys(localStorage).some(k=>k.startsWith('sl_mp_'))`), true);
  ck('record survived', await js(`JSON.parse(localStorage.getItem('sunlight.pending')||'{}').rows?.length`), 3);

  console.log('\n== 3. 恢复提示 ==');
  ck('block visible', await js(`getComputedStyle($('upRecover')).display !== 'none'`), true);
  ck('S.pending loaded', await js(`(S.pending||[]).length`), 3);
  ck('headline', await js(`document.querySelector('.up-recover .rc-t')?.textContent`), '有 3 个文件没传完');
  ck('rows listed', await js(`document.querySelectorAll('.up-recover .rc-item').length`), 3);
  ck('big marked resumable', await js(`document.querySelectorAll('.up-recover .rc-item.rs').length`), 1);
  ck('note mentions resume', await js(`/可以接着传/.test(document.querySelector('.up-recover .rc-note')?.textContent||'')`), true);

  console.log('\n== 4. 重新选中同一个文件 -> 续传而不是重传 ==');
  const restored = await js(`
    (() => {
      const mk = (name, size, last) => ({ name, size, lastModified: last });
      const r = restorePending([
        mk('small1.zip', 5*1024*1024, 11),
        mk('small2.zip', 8*1024*1024, 22),
        mk('big.zip', 100*1024*1024, 1730000000000)
      ]);
      return { r, jobs: S.uploads.length, left: (S.pending||[]).length, names: S.uploads.map(u=>u.name).join(',') };
    })()
  `);
  ck('restore true', restored.r, true);
  ck('3 jobs queued', restored.jobs, 3);
  ck('nothing left over', restored.left, 0);
  ck('block hidden', await js(`getComputedStyle($('upRecover')).display`), 'none');
  ck('breakpoint kept for resume', await js(`localStorage.getItem('sl_mp_boss|big.zip|104857600|1730000000000')`), 'OSSID-abc');
  ck('names kept', restored.names, 'small1.zip,small2.zip,big.zip');

  console.log('\n== 4b. 只找回一个，另一个仍要留着提示 ==');
  ck('partial restore', await js(`
    (() => {
      const realPump = window.pump;
      window.pump = () => {};            // 冻住队列，否则任务立刻跑完、记录被正确地清掉
      S.uploads = [];
      S.pending = [
        {name:'a.bin',size:1000,last:1,loaded:0,parent:null,resumable:false},
        {name:'b.bin',size:2000,last:2,loaded:0,parent:null,resumable:false}
      ];
      let out;
      try {
        const r = restorePending([{name:'a.bin',size:1000,lastModified:1}]);
        out = { r, queued: S.uploads.length, left: S.pending.map(x=>x.name).join(','),
                saved: JSON.parse(localStorage.getItem('sunlight.pending')||'{}').rows?.map(x=>x.name).join(',') };
      } finally { window.pump = realPump; }
      return out;
    })()
  `).then(v => [v.r, v.queued, v.left, v.saved]), [true, 1, 'b.bin', 'b.bin']);

  console.log('\n== 4c. 走真实的 change 事件入口 ==');
  ck('recovering path', await js(`
    (() => {
      S.uploads = [];
      S.pending = [{name:'c.bin',size:3000,last:3,loaded:0,parent:null,resumable:false}];
      renderRecovery();
      $('rcPick').click();
      const flag = S.recovering;
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(1)], 'c.bin', { lastModified: 3 }));
      Object.defineProperty(dt.files[0], 'size', { value: 3000, configurable: true });
      const inp = $('fileInput');
      Object.defineProperty(inp, 'files', { value: dt.files, configurable: true });
      inp.dispatchEvent(new Event('change'));
      return { flag, queued: S.uploads.length, after: S.recovering };
    })()
  `).then(v => [v.flag, v.queued, v.after]), [true, 1, false]);

  console.log('\n== 5. 对不上的文件不该被误收 ==');
  ck('mismatch rejected', await js(`
    (() => {
      S.pending = [{name:'x.zip',size:999,last:1,loaded:0,parent:null,resumable:false}];
      S.uploads = [];
      const r = restorePending([{name:'other.zip',size:111,lastModified:5}]);
      return { r, queued: S.uploads.length };
    })()
  `).then(v => v.r), false);

  ws.close(); edge.kill(); srv.kill(); await wait(700);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n====================\n${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('TEST ERROR:', e.message); process.exit(1); });
