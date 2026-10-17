/**
 * 按用户切一刀的文件树视图
 * ------------------------------------------------------------------
 * 多用户之后，「取节点」不再只有一种含义：管理员要能取到任何节点，分享页
 * 要按分享范围取，普通用户只能取到自己名下的。这三种口径如果都压进一个
 * get() 里靠参数切换，迟早会有人在某条路由上漏传一个参数，把别人的文件
 * 读出去 —— 而且这种漏洞不会报错，只会安静地发生。
 *
 * 所以这里做成显式的视图：open(state, userId) 返回一套接口，取不到就是
 * null / 抛 404。调用方拿到的东西天然只属于这个人。想越权得先绕开这一层，
 * 而绕开是有痕的（要去直接摸 state.nodes），review 时一眼能看见。
 *
 * 三条约定：
 *   · 越权一律当「不存在」。不回 403 —— 告诉对方「这个 id 存在但不归你」，
 *     等于把别人文件的存在性泄露出去。
 *   · 父目录校验和归属校验在同一处做。分成两个函数，就一定有人只调其中一个。
 *   · 视图不缓存任何东西，每次都从 state 现取。state 是 store.mutate 里那份，
 *     一次事务里可能被改很多次，缓存了就会读到旧值。
 */

const tree = require('./tree');

const fail = (msg, status) => {
  const e = new Error(msg);
  e.status = status || 400;
  return e;
};

/**
 * @param {object} state drive.json 里那份数据
 * @param {string} userId 当前登录用户
 */
function open(state, userId) {
  if (!state) throw new Error('scope: 缺少 state');
  if (!userId) throw new Error('scope: 缺少 userId');

  const owns = (n) => !!n && n.owner === userId;

  /** 取自己名下的节点。别人的、不存在的一律 null */
  const get = (id) => {
    const n = tree.get(state, id);
    return owns(n) ? n : null;
  };

  /** 取不到就抛 404。大部分接口就是这个语义 */
  const must = (id) => get(id) || (() => { throw fail('资源不存在', 404); })();

  /**
   * 父目录校验：不填表示放在顶层；填了必须是自己的文件夹。
   * 注意别人的文件夹走的也是「不存在」这条分支。
   */
  const parentOf = (parentId) => {
    if (!parentId) return null;
    const p = get(parentId);
    if (!p) throw fail('目标文件夹不存在', 404);
    if (p.type !== 'folder') throw fail('目标不是文件夹');
    return p;
  };

  const childrenOf = (parentId) => tree.childrenOf(state, parentId).filter(owns);

  /* 面包屑也过一遍归属。父子归属理论上一致，但万一 parent 指到了别人的文件夹，
     面包屑就会把别人的目录名显示出来 —— 静默泄露，不留痕迹。 */
  const ancestorsOf = (id) => tree.ancestorsOf(state, id).filter(owns);

  /** 自己名下的全部节点，前端做全站搜索和「移动到」用 */
  const all = () => Object.values(state.nodes).filter(owns);

  /**
   * 统计只算调用者自己的。tree.stats(s) 是全局统计，
   * 直接使用会把别人的文件数和体积算到当前用户头上。
   */
  const stats = () => {
    let folders = 0, files = 0, bytes = 0;
    for (const n of Object.values(state.nodes)) {
      if (!owns(n)) continue;
      if (n.type === 'folder') folders++;
      else { files++; bytes += n.size || 0; }
    }
    return { folders, files, total: folders + files, bytes };
  };

  return {
    state,
    userId,
    get, must, parentOf, childrenOf, ancestorsOf, all, stats,
    owns,

    /* ---------- 写 ---------- */

    createFolder(name, parentId) {
      parentOf(parentId);
      return tree.createFolder(state, name, parentId || null, userId);
    },

    addFile(opts) {
      parentOf(opts.parentId);
      return tree.addFile(state, { ...opts, owner: userId });
    },

    rename(id, name) {
      must(id);
      return tree.rename(state, id, name);
    },

    move(id, parentId) {
      must(id);
      parentOf(parentId);
      return tree.move(state, id, parentId || null);
    },

    /** 返回 { removed, ossKeys, revokedShares }，OSS 清理交给调用方 */
    remove(id) {
      must(id);
      return tree.remove(state, id, userId);
    }
  };
}

module.exports = { open };
