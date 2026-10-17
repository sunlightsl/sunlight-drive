/**
 * 上传请求的中断判定
 * ------------------------------------------------------------------
 * 单独成文件是为了可测：这段判定边界较多，不适合内联在路由里。
 *
 * 判定难点：
 *   /api/upload 要把"客户端传一半就跑了"和"传完了"分开。传一半就登记
 *   进文件树的话，用户会看到一个大小正确、点下载却是坏的文件。
 *
 *   直觉上写 req.on('close', ...) 来判断中断是错的。实测（见
 *   test/run.js 的「上传中断判定」一节，用真实 http 服务跑）：
 *
 *     正常上传： end → close( req.complete = true  )
 *     中途断开： aborted → error → close( req.complete = false )
 *
 *   也就是说正常上传时 close 照样触发。用 close 当"中断"信号，
 *   每一次成功的上传都会被误判成中断、被删掉刚传上去的对象、
 *   返回 400 —— 上传功能整体不可用，而且只会在真连上 OSS 时才暴露。
 *
 * 正确判据：
 *   1. 'aborted' / 'error' 事件（只有真中断才触发）
 *   2. req.complete —— Node 官方字段，"完整的 HTTP 报文已收到并解析成功"
 *      才是 true。这个才是权威判据，前面两个只是更早的提示。
 */

/**
 * 给一个上传请求挂上中断追踪。
 * @param {import('http').IncomingMessage} req
 * @returns {{aborted:boolean, isAborted:()=>boolean}}
 */
function trackRequest(req) {
  let aborted = false;
  const onAbort = () => { aborted = true; };

  req.on('aborted', onAbort);   // 已废弃但仍在用，语义明确：连接被提前掐断
  req.on('error', onAbort);

  return {
    /** 是否收到过中断信号（早期提示，可能还没等到 complete 落地） */
    get aborted() { return aborted; },

    /**
     * 最终判定。请求流读完之后才能调，结论才算数。
     * 不只看事件：req.complete 是 Node 给的权威结论，
     * 万一某种传输层的断法没触发 aborted 事件，这里也兜得住。
     */
    isAborted() { return aborted || req.complete === false; }
  };
}

module.exports = { trackRequest };
