/**
 * 文件树操作
 * ------------------------------------------------------------------
 * 结构：nodes 是个 id -> node 的平表，父子关系靠 node.parent 指向。
 *   顶层节点的 parent 是 null。没有"根节点"这个实体——这样顶层文件夹
 *   也能正常改名、移动、删除，不用给根开特例。
 *
 * 无限嵌套，所以有两个必须防的坑：
 *   1. 把文件夹移进它自己的子目录 → 整棵子树从树上掉下来，谁也访问不到
 *   2. 分享一个文件夹后，别人构造任意 nodeId 去下载别的文件 → 越权
 *      对应 isDescendant()，每个按分享 token 走的下载都要过这一关
 */

const crypto = require('crypto');

/* 这些名字在 Windows 上是设备名，建了会有诡异问题（打不开、删不掉） */
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

const MAX_NAME = 120;

/* ================================================================
   名字消毒
   ================================================================ */

/**
 * 把用户给的名字清成一个能安全用作 OSS key 片段、也能落到 Windows 磁盘的名字。
 * 返回消毒后的结果；完全不合法时抛错（调用方转成 400）。
 *
 * 注意：是「清洗」而不是「拒绝」。像 "a/b.txt" 这种，直接报错会让用户困惑
 * （在他看来就是个普通名字），改成 "a-b.txt" 并把这个结果回给前端说明，
 * 比报错好用。真正该拒绝的只有一种：清洗完什么都不剩。
 */
function sanitizeName(input) {
  let n = String(input == null ? '' : input).normalize('NFC');

  // 先干掉 .. ：必须在替换分隔符之前做。
  // 否则 "../../etc/passwd" 会变成 "..-..-etc-passwd"，看着还是像个穿越尝试。
  // 注意只折叠连续的点，不能动单个前导点——.env / .gitignore 还要用。
  n = n.replace(/\.{2,}/g, '-');

  // 控制字符、路径分隔符、Windows 非法字符 —— 一律换成短横线
  n = n.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '-');

  // 折叠连续短横线，免得 "a///b" 变成 "a---b"
  n = n.replace(/-{2,}/g, '-');

  // 首尾的空白和短横线（它们基本都是上面替换留下的残渣）
  n = n.replace(/^[\s-]+/, '').replace(/[\s-]+$/, '');

  // 走到这里如果只剩点，说明原名是 "." / ".." / "..." 这类，不能要
  if (/^\.+$/.test(n)) n = '';

  if (n.length > MAX_NAME) {
    const dot = n.lastIndexOf('.');
    // 尽量保住扩展名，用户认扩展名
    if (dot > 0 && n.length - dot <= 12) {
      const ext = n.slice(dot);
      n = n.slice(0, MAX_NAME - ext.length) + ext;
    } else {
      n = n.slice(0, MAX_NAME);
    }
  }

  if (!n) {
    const e = new Error('名称不能为空，且不能只有非法字符');
    e.status = 400;
    throw e;
  }

  if (WINDOWS_RESERVED.has(n.toUpperCase().replace(/\.[^.]*$/, ''))) {
    n = '_' + n;
  }

  return n;
}

/* ================================================================
   id 生成
   ================================================================ */

function newId(prefix, taken) {
  for (let i = 0; i < 50; i++) {
    const id = prefix + crypto.randomBytes(5).toString('hex');
    if (!taken.has(id)) return id;
  }
  // 概率上到不了这，但真到了也不能返回重复 id
  throw new Error('生成唯一 id 失败（重试 50 次仍冲突）');
}

/* ================================================================
   读取
   ================================================================ */

/**
 * 取节点。同时接受 id 字符串和节点对象——
 * 传对象进来时会静默变成 "[object Object]" 这种字符串 key，查不到也不报错，
 * 排查起来很费劲。这里直接容错，省得踩。
 */
function get(s, id) {
  if (!id) return null;
  const key = typeof id === 'object' ? id.id : id;
  return (key && s.nodes[key]) || null;
}

/** 某个目录下的直接子节点，已排序：文件夹在前，然后按名称（数字感知） */
function childrenOf(s, parentId) {
  const out = [];
  for (const id in s.nodes) {
    const n = s.nodes[id];
    if ((n.parent || null) === (parentId || null)) out.push(n);
  }
  return sortNodes(out);
}

const collator = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' });

function sortNodes(list) {
  return list.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
}

/**
 * 从顶层到该节点的祖先链（不含自己）。用于面包屑。
 * 顺手做环检测：真出现环（不该发生）就截断，不能让接口把进程转死。
 */
function ancestorsOf(s, id) {
  const out = [];
  const seen = new Set([id]);
  let cur = get(s, id);
  let guard = 0;
  while (cur && cur.parent && guard++ < 512) {
    const p = get(s, cur.parent);
    if (!p || seen.has(p.id)) break;   // 环或断链，停下
    seen.add(p.id);
    out.unshift(p);
    cur = p;
  }
  return out;
}

/** 自己 + 所有后代 */
function subtreeIds(s, id) {
  const out = [id];
  const stack = [id];
  const seen = new Set([id]);
  let guard = 0;
  while (stack.length && guard++ < 200000) {
    const cur = stack.pop();
    for (const nid in s.nodes) {
      const n = s.nodes[nid];
      if (n.parent === cur && !seen.has(nid)) {
        seen.add(nid);
        out.push(nid);
        if (n.type === 'folder') stack.push(nid);
      }
    }
  }
  return out;
}

/** candidate 是否在 ancestor 的子树里（含自身）。分享越权校验就靠它 */
function isDescendant(s, ancestorId, candidateId) {
  if (ancestorId === candidateId) return true;
  let cur = get(s, candidateId);
  let guard = 0;
  while (cur && cur.parent && guard++ < 512) {
    if (cur.parent === ancestorId) return true;
    cur = get(s, cur.parent);
  }
  return false;
}

/** 同级重名时自动加序号：report.pdf -> report (2).pdf */
function uniqueName(s, parentId, name, ignoreId) {
  const siblings = childrenOf(s, parentId)
    .filter(n => n.id !== ignoreId)
    .map(n => n.name.toLowerCase());
  if (!siblings.includes(name.toLowerCase())) return name;

  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 1000; i++) {
    const cand = `${base} (${i})${ext}`;
    if (!siblings.includes(cand.toLowerCase())) return cand;
  }
  return `${base}-${Date.now()}${ext}`;
}

/* ================================================================
   写操作
   ================================================================ */

function requireFolder(s, parentId) {
  if (!parentId) return null;                      // 顶层
  const p = get(s, parentId);
  if (!p) { const e = new Error('目标文件夹不存在'); e.status = 404; throw e; }
  if (p.type !== 'folder') { const e = new Error('目标不是文件夹'); e.status = 400; throw e; }
  return p;
}

function createFolder(s, name, parentId, owner) {
  requireFolder(s, parentId);
  const clean = sanitizeName(name);
  const node = {
    id: newId('n_', new Set(Object.keys(s.nodes))),
    type: 'folder',
    name: uniqueName(s, parentId, clean),
    parent: parentId || null,
    createdAt: new Date().toISOString()
  };
  if (owner) node.owner = owner;
  s.nodes[node.id] = node;
  return node;
}

function addFile(s, { name, parentId, size, ossKey, sha256, mime, updatedAt, owner }) {
  requireFolder(s, parentId);
  const clean = sanitizeName(name);
  const node = {
    id: newId('n_', new Set(Object.keys(s.nodes))),
    type: 'file',
    name: uniqueName(s, parentId, clean),
    parent: parentId || null,
    size: Number(size) || 0,
    ossKey,
    sha256: sha256 || '',
    mime: mime || 'application/octet-stream',
    /* 完整时间戳。只存日期（零点）的话，前端按相对时间计算会把
       当天中午上传的文件显示成"4 小时前" */
    updatedAt: updatedAt || new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  if (owner) node.owner = owner;
  s.nodes[node.id] = node;
  return node;
}

function rename(s, id, name) {
  const n = get(s, id);
  if (!n) { const e = new Error('节点不存在'); e.status = 404; throw e; }
  const clean = sanitizeName(name);
  n.name = uniqueName(s, n.parent, clean, id);
  n.updatedAt = new Date().toISOString();
  return n;
}

function move(s, id, newParentId) {
  const n = get(s, id);
  if (!n) { const e = new Error('节点不存在'); e.status = 404; throw e; }
  requireFolder(s, newParentId);

  if (newParentId === id) {
    const e = new Error('不能把文件夹移进它自己'); e.status = 400; throw e;
  }
  // 关键：不能移进自己的后代，否则整棵子树脱离树，永远访问不到
  if (newParentId && isDescendant(s, id, newParentId)) {
    const e = new Error('不能把文件夹移进它自己的子目录'); e.status = 400; throw e;
  }

  n.parent = newParentId || null;
  n.name = uniqueName(s, n.parent, n.name, id);
  n.updatedAt = new Date().toISOString();

  // 移动后，指向被移节点及其后代的分享仍然有效（分享记的是 nodeId，不是路径）
  return n;
}

/**
 * 删除节点及其整棵子树。
 * 返回 { removed: [...nodes], ossKeys: [...] }——
 * ossKeys 交给调用方去删 OSS 对象，树和对象存储分开处理，
 * 万一 OSS 删除失败，至少树已经对了，日志里能看到要清理哪些 key。
 *
 * owner 传了就只删属于这个人的。多用户下这不该是"万一"——
 * 父子归属理论上一致，但真出现脏数据时，宁可在树上留个孤儿，
 * 也不能顺着 parent 指向把别人的文件删掉。
 */
function remove(s, id, owner) {
  const n = get(s, id);
  if (!n) { const e = new Error('节点不存在'); e.status = 404; throw e; }
  if (owner && n.owner !== owner) { const e = new Error('节点不存在'); e.status = 404; throw e; }

  let ids = subtreeIds(s, id);
  if (owner) ids = ids.filter(i => s.nodes[i] && s.nodes[i].owner === owner);

  const removed = ids.map(i => s.nodes[i]).filter(Boolean);
  const ossKeys = removed.filter(x => x.type === 'file' && x.ossKey).map(x => x.ossKey);

  for (const i of ids) delete s.nodes[i];

  /* 顺手作废指向这些节点的分享，不然分享页会指向一个不存在的节点。
     一条分享可能挂着多项，只要有一项被删到就整条作废 —— 部分失效的
     分享链接比直接失效更难解释，用户会把"少了几项"当成 bug 报上来。 */
  const revoked = [];
  const gone = new Set(ids);
  for (const tok in s.shares) {
    const sh = s.shares[tok];
    const refs = Array.isArray(sh.items) && sh.items.length
      ? sh.items.map(it => it.id)
      : (sh.nodeId ? [sh.nodeId] : []);
    if (refs.some(r => gone.has(r))) {
      revoked.push(tok);
      delete s.shares[tok];
    }
  }

  return { removed, ossKeys, revokedShares: revoked };
}

/* ================================================================
   统计
   ================================================================ */

function stats(s) {
  let folders = 0, files = 0, bytes = 0;
  for (const id in s.nodes) {
    const n = s.nodes[id];
    if (n.type === 'folder') folders++;
    else { files++; bytes += n.size || 0; }
  }
  return { folders, files, total: folders + files, bytes };
}

module.exports = {
  sanitizeName, newId,
  get, childrenOf, ancestorsOf, subtreeIds, isDescendant, uniqueName, sortNodes,
  createFolder, addFile, rename, move, remove, stats,
  MAX_NAME
};
