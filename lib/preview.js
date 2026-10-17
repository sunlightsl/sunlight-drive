/**
 * 预览能力判定 —— 前后端共用一份
 * ==================================================================
 * 为什么要有这个文件：
 *   前端要决定"点这个文件是打开预览还是直接下载"，
 *   后端要决定"签这条链接时给 inline 还是 attachment"。
 *   两边如果各写一套判断，迟早会出现"前端打开了预览、后端却给
 *   attachment，结果浏览器还是下载"这种自相矛盾的状态。
 *
 * 安全上它是**白名单**，不是黑名单：
 *   只有明确列出来的类型才允许 inline。SVG 和 HTML 故意不在列 ——
 *   对它们签 inline，浏览器会**直接执行里面的脚本**，等于让上传者
 *   在你的域名下拿到同源执行权（能读会话 token）。
 *
 * 判定以**扩展名**为主、mime 为辅：
 *   上传时记录的 mime 可能是空串或 application/octet-stream（老数据、
 *   迁移来的、某些客户端），靠它判断会漏掉大量本该能预览的文件。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PREVIEW = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  /* 图片：都能被 <img> 直接渲染 */
  const IMAGE = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'];
  /* 视频：浏览器原生支持的容器。mkv/avi/wmv 不在列 —— 播不了就别假装能播 */
  const VIDEO = ['mp4', 'm4v', 'mov', 'webm', 'ogv'];
  const AUDIO = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac'];
  const PDF = ['pdf'];

  const picks = s => new Set(s.split(' '));
  const SETS = {
    image: picks(IMAGE.join(' ')),
    video: picks(VIDEO.join(' ')),
    audio: picks(AUDIO.join(' ')),
    pdf: picks(PDF.join(' '))
  };

  /* 每个类别对应的 content-type，签名时覆盖给 OSS。
     不覆盖的话 OSS 可能回 application/octet-stream，浏览器就下载而不是渲染了 */
  const TYPE_OF = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
    webm: 'video/webm', ogv: 'video/ogg',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
    m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
    pdf: 'application/pdf'
  };

  /** 取小写扩展名（不含点）。没有扩展名返回空串 */
  function extOf(name) {
    const s = String(name || '');
    const i = s.lastIndexOf('.');
    if (i < 0 || i === s.length - 1) return '';
    return s.slice(i + 1).toLowerCase();
  }

  /** 这个文件能预览吗？返回 'image' | 'video' | 'audio' | 'pdf' | '' */
  function kindOf(node) {
    if (!node || node.type !== 'file') return '';
    const e = extOf(node.name);
    if (!e) return '';
    for (const k of ['image', 'video', 'audio', 'pdf']) {
      if (SETS[k].has(e)) return k;
    }
    return '';
  }

  const canPreview = node => !!kindOf(node);

  /** 预览时应该用的 content-type；未知返回空串（未知就别乱猜） */
  const contentTypeOf = node => TYPE_OF[extOf(node && node.name)] || '';

  /* 上传时写进对象存储的 content-type。
     预览的那些类型的映射和上面共用；下面再补一批常见的非预览类型 ——
     它们不影响预览（点击就是下载），但写对了对将来接入别的消费方有好处。
     不在这里的类型一律 application/octet-stream，这是安全默认值：
     宁可让浏览器下载，也不要猜错类型让它去渲染。 */
  const UPLOAD_EXTRA = {
    zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
    tar: 'application/x-tar', gz: 'application/gzip',
    txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8',
    json: 'application/json', xml: 'application/xml',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    exe: 'application/vnd.microsoft.portable-executable',
    msi: 'application/x-msi'
  };

  /**
   * 上传时要写到对象存储上的 content-type。
   *
   * **为什么必须在写入时就给对，而不是签名时补救**：
   * OSS 拒绝对 content-type 做响应头覆盖，会直接回
   * 400 `Can not override response header on content-type`（实测）。
   * 所以对象的类型在落盘那一刻就定死了，签名阶段只能改 disposition。
   */
  function mimeForUpload(name) {
    const e = extOf(name);
    if (!e) return 'application/octet-stream';
    return TYPE_OF[e] || UPLOAD_EXTRA[e] || 'application/octet-stream';
  }

  return { kindOf, canPreview, contentTypeOf, mimeForUpload, isText, extOf, SETS, TYPE_OF };

  /**
   * 文本预览？单独一个判断，因为它走的是"取回内容自己渲染"而不是"给浏览器一个 URL"。
   * 只认这些扩展名 —— 不按 mime 猜，避免把一个 .html 当成纯文本读进来后又渲染出去。
   */
  const TEXT = picks('txt log md json xml yml yaml csv ini conf cfg js css html htm ts py java c cpp h sh sql');
  function isText(node) {
    if (!node || node.type !== 'file') return false;
    const e = extOf(node.name);
    return !!e && TEXT.has(e);
  }

  return { kindOf, canPreview, contentTypeOf, isText, extOf, SETS, TYPE_OF };
});
