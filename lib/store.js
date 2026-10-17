/**
 * 数据存储：data/drive.json 的读写
 * ------------------------------------------------------------------
 * 为什么用 JSON 文件而不是数据库：
 *   这是个人网盘，节点量级是几百到几千。JSON 一条文件全装得下，
 *   不需要运维一个数据库，出问题用记事本就能看能改。
 *   真到几万节点再换 SQLite，接口不用动。
 *
 * 写入必须原子：先写 .tmp，再 rename 覆盖。rename 在同一分区上是原子操作，
 * 中途断电要么是旧内容、要么是新内容，不会出现写了一半的半截 JSON。
 *
 * 所有写操作串行化：Node 单线程，但 await 之间会切出去。两个请求同时
 * 「读-改-写」会互相覆盖。这里用一条 promise 链把写操作排队。
 */

const fs = require('fs');
const path = require('path');

/* 允许用环境变量换数据目录：端到端测试要跑在临时文件上，
   不能拿真实的 drive.json 做实验（测试会建文件夹、删节点、发分享）。

   **必须 trim**：`.env` 里写 `DRIVE_DATA_DIR=`（常见的手滑）会得到空串，
   那样能被 `||` 兜住；但写成 `DRIVE_DATA_DIR=  `（只有空格）会得到非空串，
   于是数据被写进一个名字叫两个空格的目录里 —— 出问题时极难想到原因。 */
const envPath = name => {
  const v = process.env[name];
  if (typeof v !== 'string') return '';
  return v.trim();
};

const DATA_DIR = envPath('DRIVE_DATA_DIR') || path.join(__dirname, '..', 'data');
const FILE = envPath('DRIVE_DATA_FILE') || path.join(DATA_DIR, 'drive.json');
const TMP = FILE + '.tmp';
const BAK = FILE + '.bak';

/* 当前数据结构版本。v1 = 单用户（口令在 .env、资料在 profile 字段）；
   v2 = 多用户（users 表 + 节点/分享带 owner）。 */
const CURRENT_VERSION = 2;

const EMPTY = () => ({
  version: CURRENT_VERSION,
  brand: 'sunlight',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  users: {},      // id -> user（v2 起，多用户）
  nodes: {},      // id -> node（带 owner）
  shares: {}      // token -> share（带 owner）
});

let state = null;

/* ---------------- 加载 ---------------- */

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(FILE)) {
    state = EMPTY();
    persist();
    return state;
  }

  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.nodes) {
      throw new Error('结构不对（缺 nodes）');
    }
    // 补齐可能缺的字段，容忍旧版本文件
    parsed.shares = parsed.shares || {};
    /* v1 的库没有 users。这里不补默认用户 —— 建账号要有密码，
       那是 lib/users.js 的事（adoptLegacyData），store 只管文件读写。 */
    parsed.users = parsed.users || {};
    parsed.brand = parsed.brand || 'sunlight';
    /* 版本号往上顶，不往下拉。读到 v1 的文件说明是单用户时代留下来的，
       补上 users 之后结构已经是 v2 了，标成 v2 才对得上实际形状 ——
       留着一个和内容不符的版本号，以后想按版本分支处理就会走错。 */
    parsed.version = Math.max(Number(parsed.version) || 1, CURRENT_VERSION);
    state = parsed;
    return state;
  } catch (e) {
    // 文件坏了不能装没事——先把坏文件留证，再起一个空的
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bad = FILE + '.corrupt-' + stamp;
    try { fs.renameSync(FILE, bad); } catch (_) {}
    console.error(`[store] drive.json 解析失败：${e.message}`);
    console.error(`[store] 已把原文件另存为 ${path.basename(bad)}，用一个新的空清单启动。`);
    console.error('[store] 修好那个文件再改名回 drive.json 就能恢复。');
    state = EMPTY();
    persist();
    return state;
  }
}

function get() {
  if (!state) load();
  return state;
}

/* ---------------- 保存 ---------------- */

function persist() {
  const data = get();
  data.updatedAt = new Date().toISOString();
  const text = JSON.stringify(data, null, 2);

  fs.writeFileSync(TMP, text, 'utf8');
  // 留一份上一版，误操作后还能捞
  try { if (fs.existsSync(FILE)) fs.copyFileSync(FILE, BAK); } catch (_) {}
  fs.renameSync(TMP, FILE);
}

/* 写操作排队：避免两个请求的「读-改-写」互相覆盖 */
let chain = Promise.resolve();

/**
 * 在串行队列里执行一段会改数据的逻辑。
 *   await store.mutate(() => { ...改 get() 返回的对象... });
 * 回调抛异常则不落盘（返回 rejected）。
 */
function mutate(fn) {
  const run = chain.then(async () => {
    const s = get();
    const result = await fn(s);
    persist();
    return result;
  });
  // 即使这次失败，后面的也要接着排队，不能把链断了
  chain = run.then(() => undefined, () => undefined);
  return run;
}

/** 只读，不进队列 */
function read(fn) {
  return fn(get());
}

module.exports = { load, get, persist, mutate, read, FILE, DATA_DIR };
