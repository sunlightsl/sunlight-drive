/**
 * 二维码编码器（零依赖）
 * ------------------------------------------------------------------
 * 为什么自己写：这个项目从头到尾没引过第三方包 —— TOTP 是拿 Node 自带的
 * crypto 拼出来的，如果为了「显示一张绑定图」去装个依赖，前面那些克制就
 * 白费了。而且二维码是标准化程度极高的东西，规格封在 ISO/IEC 18004 里，
 * 不会变，自己实现一次就够了。
 *
 * 范围刻意收窄了：只做 byte 模式（UTF-8 字节）、纠错级别 M、版本 1–10。
 * 10 版能装 216 个数据码字、213 个字节，而 otpauth:// 那种 URI 一般也就
 * 六十几个字节，版本 4 就够。不做数字/字母数字模式、不做 Kanji、不做多级
 * 纠错 —— 用不上的分支在这里只会变成没人敢动的负担。
 *
 * 输出是 SVG 路径，前端直接塞进 <svg viewBox="0 0 N N"><path d="…"/></svg>，
 * 不用 canvas，也不用额外发一次图片请求。
 *
 * 流程按 ISO/IEC 18004：
 *   数据编码 → 分块 → RS 纠错 → 交织 → 排矩阵 → 8 种掩码逐一试打分 → 格式信息
 *
 * 关于掩码选择的一点说明（免得以后有人照着别的库把它"修"歪了）：
 * N3 那条规则（1:1:3:1:1 的定位图案相似度）各家实现口径不一 —— 差别在于
 * 贴着符号边缘的那种，要不要把外面的静默区也算作"4 模块宽的浅色区"。
 * 这里按规格字面意思算（静默区算），所以同一个内容选出来的掩码可能和
 * node-qrcode、qrcode-generator 不同；那两个自己互相也不一致。
 * 掩码只影响扫描的稳健程度，不影响能不能扫出来 —— 八种掩码都是合法的，
 * 格式信息里带着用的是哪一种。已用独立解码器对 1–10 版逐个回读验证过。
 */

'use strict';

/* ================================================================
   GF(256)
   ================================================================ */

/* 本原多项式 x^8 + x^4 + x^3 + x^2 + 1 = 0x11D */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

/**
 * 生成多项式 Π(x − α^i)，i = 0…n−1。
 * 系数按次数从高到低排，首项恒为 1（首一多项式）。
 */
function genPoly(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];                       // 乘 x：整体左移
      next[j + 1] ^= gfMul(g[j], EXP[i]);    // 加上 α^i 那一项
    }
    g = next;
  }
  return g;
}

/** 多项式除法取余，返回 n 个纠错码字 */
function rsEncode(data, n) {
  const g = genPoly(n);
  const buf = new Uint8Array(data.length + n);
  buf.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i];
    if (!coef) continue;
    /* g[0] 恒为 1，这一步会把 buf[i] 本身消成 0，所以不用单独置零 */
    for (let j = 0; j < g.length; j++) buf[i + j] ^= gfMul(g[j], coef);
  }
  return buf.slice(data.length);
}

/* ================================================================
   规格表（纠错级别 M）
   ================================================================ */

/* ec = 每块的纠错码字数；groups = [块数, 每块数据码字数][]。
   M 级别下 8–10 版有两种块长，所以得写成数组而不是单个数字。 */
const ECC = {
  1: { ec: 10, groups: [[1, 16]] },
  2: { ec: 16, groups: [[1, 28]] },
  3: { ec: 26, groups: [[1, 44]] },
  4: { ec: 18, groups: [[2, 32]] },
  5: { ec: 24, groups: [[2, 43]] },
  6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] },
  8: { ec: 22, groups: [[2, 38], [2, 39]] },
  9: { ec: 22, groups: [[3, 36], [2, 37]] },
  10: { ec: 26, groups: [[4, 43], [1, 44]] }
};

const MAX_VERSION = 10;

/* 对齐图案的中心坐标。1 版没有对齐图案，是为了留出足够的定位区 */
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
};

const sizeOf = (v) => v * 4 + 17;
const dataCwOf = (v) => ECC[v].groups.reduce((a, [n, k]) => a + n * k, 0);

/* 字符计数指示符的位宽：1–9 版 8 位，10 版起 16 位 */
const countBits = (v) => (v <= 9 ? 8 : 16);

/** 这个版本能装多少字节（已经扣掉模式指示符和字符计数） */
const capacityOf = (v) => Math.floor((dataCwOf(v) * 8 - 4 - countBits(v)) / 8);

/* ================================================================
   编码
   ================================================================ */

/** 挑一个装得下这些字节的最小版本 */
function pickVersion(bytes, minVersion) {
  for (let v = Math.max(1, minVersion | 0); v <= MAX_VERSION; v++) {
    if (bytes.length <= capacityOf(v)) return v;
  }
  throw new Error(
    `内容太长了（${bytes.length} 字节），${MAX_VERSION} 版最多装 ${capacityOf(MAX_VERSION)} 字节`
  );
}

/** 数据编码：模式指示符 + 字符计数 + 内容 + 终止符 + 补齐 */
function encodeData(bytes, version) {
  const dataCw = dataCwOf(version);
  const capBits = dataCw * 8;
  const ccBits = countBits(version);

  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };

  push(0b0100, 4);              // byte 模式
  push(bytes.length, ccBits);
  for (const b of bytes) push(b, 8);

  for (let i = 0; i < 4 && bits.length < capBits; i++) bits.push(0);  // 终止符，最多 4 位
  while (bits.length % 8) bits.push(0);                               // 补到字节边界

  const cw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    cw.push(v);
  }

  /* 还没填满就交替补 0xEC / 0x11。这两个值不是随便挑的，
     规格里指定用它们，图的就是和前后数据凑不出长同色块。 */
  const PAD = [0xec, 0x11];
  for (let i = 0; cw.length < dataCw; i++) cw.push(PAD[i % 2]);

  return cw;
}

/** 分块 → RS 纠错 → 交织成一个码字序列 */
function buildCodewords(bytes, version) {
  const spec = ECC[version];
  const data = encodeData(bytes, version);

  const blocks = [];
  let off = 0;
  for (const [n, k] of spec.groups) {
    for (let i = 0; i < n; i++) {
      const d = data.slice(off, off + k);
      off += k;
      blocks.push({ data: d, ec: rsEncode(d, spec.ec) });
    }
  }

  /* 交织：先按列取数据码字（短块跳过），再按列取纠错码字。
     这么绕是为了让连续一段划伤分散到多个块里，各块各自纠错才救得回来。 */
  const out = [];
  const maxData = Math.max(...blocks.map(b => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < spec.ec; i++) {
    for (const b of blocks) out.push(b.ec[i]);
  }
  return out;
}

/* ================================================================
   矩阵
   ================================================================ */

/** 画定位图案 + 分隔符（左上、右上、左下各一个） */
function drawFinder(mod, fn, size, r0, c0) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = r0 + r;
      const cc = c0 + c;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      let v = 0;
      if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
        const edge = (r === 0 || r === 6 || c === 0 || c === 6);
        const core = (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        v = (edge || core) ? 1 : 0;
      }
      mod[rr][cc] = v;
      fn[rr][cc] = 1;
    }
  }
}

/** 定位图案占据的九宫格范围（对齐图案要躲开这三个角） */
const nearFinder = (size, r, c) =>
  (r <= 7 && c <= 7) || (r <= 7 && c >= size - 8) || (r >= size - 8 && c <= 7);

/**
 * 铺功能图案：定位、分隔、时序、对齐、暗模块。
 * 数据区留空，格式信息留空（要等掩码定了才画）。
 */
function drawFunctions(mod, fn, version) {
  const size = sizeOf(version);

  drawFinder(mod, fn, size, 0, 0);
  drawFinder(mod, fn, size, 0, size - 7);
  drawFinder(mod, fn, size, size - 7, 0);

  /* 时序图案：第 6 行和第 6 列，在两个定位图案之间黑白相间 */
  for (let i = 8; i <= size - 9; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    mod[6][i] = v; fn[6][i] = 1;
    mod[i][6] = v; fn[i][6] = 1;
  }

  /* 对齐图案必须画在时序之后：它压在时序线上时要盖过去 */
  const centers = ALIGN[version];
  for (const r0 of centers) {
    for (const c0 of centers) {
      if (nearFinder(size, r0, c0)) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const v = (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)) ? 1 : 0;
          mod[r0 + r][c0 + c] = v;
          fn[r0 + r][c0 + c] = 1;
        }
      }
    }
  }

  /* 格式信息占用的位置先占坑，免得数据码字填进去 */
  for (let i = 0; i <= 8; i++) {
    if (!fn[8][i]) { fn[8][i] = 1; mod[8][i] = 0; }
    if (!fn[i][8]) { fn[i][8] = 1; mod[i][8] = 0; }
  }
  for (let i = 0; i < 8; i++) {
    if (!fn[8][size - 1 - i]) { fn[8][size - 1 - i] = 1; mod[8][size - 1 - i] = 0; }
    if (!fn[size - 1 - i][8]) { fn[size - 1 - i][8] = 1; mod[size - 1 - i][8] = 0; }
  }

  /* 7 版起才有版本信息，占 18 位 */
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      fn[a][b] = 1; mod[a][b] = 0;
      fn[b][a] = 1; mod[b][a] = 0;
    }
  }
}

/**
 * 把交织好的码字按「两列一竖排、蛇形上下走」铺进数据区。
 * 从最右一列往左，每两列一组；第 6 列是时序图案，跳过整列。
 */
function drawData(mod, fn, version, codewords) {
  const size = sizeOf(version);
  const total = codewords.length;
  let i = 0;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;    // 让开时序那一列
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (fn[row][col] || i >= total * 8) continue;
        mod[row][col] = (codewords[i >> 3] >> (7 - (i & 7))) & 1;
        i++;
      }
    }
  }
}

/* ---- 掩码 ---- */

function maskBit(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

/** 拼 15 位格式信息：5 位数据 + BCH(15,5) 校验，最后异或固定掩码 0x5412 */
function formatBits(eccBits, mask) {
  const data = (eccBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 拼 18 位版本信息：6 位版本 + BCH(18,6) 校验（7 版起才用） */
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

/** 格式信息画两份：左上角一份，右上+左下拼一份 */
function drawFormat(mod, version, mask) {
  const size = sizeOf(version);
  const bits = formatBits(0b00, mask);   // 纠错级别 M 的编码就是 00
  const get = (i) => (bits >>> i) & 1;

  for (let i = 0; i <= 5; i++) mod[i][8] = get(i);
  mod[7][8] = get(6);
  mod[8][8] = get(7);
  mod[8][7] = get(8);
  for (let i = 9; i < 15; i++) mod[8][14 - i] = get(i);

  for (let i = 0; i < 8; i++) mod[8][size - 1 - i] = get(i);
  for (let i = 8; i < 15; i++) mod[size - 15 + i][8] = get(i);
  mod[size - 8][8] = 1;                  // 那个固定为黑的模块
}

function drawVersion(mod, version) {
  if (version < 7) return;
  const size = sizeOf(version);
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >>> i) & 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    mod[a][b] = bit;
    mod[b][a] = bit;
  }
}

/* ---- 打分 ---- */

const N1 = 3, N2 = 3, N3 = 40, N4 = 10;

/** 把一段连续同色长度记进滑动记录里，供「像定位图案」判定用 */
function addHistory(len, hist, size) {
  if (hist[0] === 0) len += size;    // 边界外的白色算延伸
  for (let i = hist.length - 1; i > 0; i--) hist[i] = hist[i - 1];
  hist[0] = len;
}

/** 1:1:3:1:1 且两侧留白够 —— 这正是定位图案的特征，出现就要罚分 */
function countFinderLike(hist) {
  const n = hist[1];
  const core = n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n;
  if (!core) return 0;
  return (hist[0] >= n * 4 && hist[6] >= n ? 1 : 0) +
         (hist[6] >= n * 4 && hist[0] >= n ? 1 : 0);
}

function scoreLine(modules, size, get) {
  let score = 0;
  for (let a = 0; a < size; a++) {
    let runColor = 0;
    let runLen = 0;
    const hist = [0, 0, 0, 0, 0, 0, 0];
    for (let b = 0; b < size; b++) {
      const v = get(modules, a, b);
      if (v === runColor) {
        runLen++;
        if (runLen === 5) score += N1;
        else if (runLen > 5) score++;
      } else {
        addHistory(runLen, hist, size);
        if (!runColor) score += countFinderLike(hist) * N3;
        runColor = v;
        runLen = 1;
      }
    }
    /* 收尾：末尾那段要按「后面接的都是白」再算一次 */
    if (runColor) { addHistory(runLen, hist, size); runLen = 0; }
    runLen += size;
    addHistory(runLen, hist, size);
    score += countFinderLike(hist) * N3;
  }
  return score;
}

function penalty(mod, size) {
  let score = scoreLine(mod, size, (m, a, b) => m[a][b]);      // 按行
  score += scoreLine(mod, size, (m, a, b) => m[b][a]);         // 按列

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = mod[r][c];
      if (v === mod[r][c + 1] && v === mod[r + 1][c] && v === mod[r + 1][c + 1]) score += N2;
    }
  }

  /* 黑白比例偏离 50% 的程度，每偏 5% 罚 10 分 */
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += mod[r][c];
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * N4;

  return score;
}

/* ================================================================
   对外
   ================================================================ */

/**
 * 编码成模块矩阵。
 * @param {string} text
 * @param {{minVersion?:number}} [opts]
 * @returns {{version:number, size:number, modules:Uint8Array[]}} modules 不含静默区
 */
function encode(text, opts) {
  const bytes = Buffer.from(String(text), 'utf8');
  const version = pickVersion(bytes, (opts && opts.minVersion) || 1);
  const size = sizeOf(version);

  const mod = Array.from({ length: size }, () => new Uint8Array(size));
  const fn = Array.from({ length: size }, () => new Uint8Array(size));
  drawFunctions(mod, fn, version);
  drawData(mod, fn, version, buildCodewords(bytes, version));

  /* 八种掩码逐一试，挑罚分最低的那个。
     掩码不是装饰 —— 是为了打散大片同色块和伪定位图案，
     否则扫描器会把数据区误认成定位角。 */
  let best = null;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = mod.map(row => Uint8Array.from(row));
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!fn[r][c] && maskBit(mask, r, c)) m[r][c] ^= 1;
      }
    }
    drawFormat(m, version, mask);
    drawVersion(m, version);
    const s = penalty(m, size);
    if (s < bestScore) { bestScore = s; best = m; bestMask = mask; }
  }

  return { version, size, modules: best, mask: bestMask, penalty: bestScore };
}

/**
 * 生成可直接塞进 SVG 的路径。
 *
 * 同一行里连续的黑模块合成一条横线，而不是一个方块画一次 ——
 * 33×33 的码大概有一半是黑块，逐个画路径能差出十几倍体积。
 *
 * @param {string} text
 * @param {{minVersion?:number, margin?:number, scale?:number}} [opts]
 * @returns {{version:number, dim:number, path:string}} dim 是含静默区的边长（模块数）
 */
function svgPath(text, opts) {
  const o = opts || {};
  const q = o.margin === undefined ? 4 : o.margin;   // 静默区，规格要求至少 4 模块
  const { version, size, modules } = encode(text, o);

  const parts = [];
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!modules[r][c]) { c++; continue; }
      let len = 1;
      while (c + len < size && modules[r][c + len]) len++;
      parts.push(`M${c + q} ${r + q}h${len}v1h-${len}z`);
      c += len;
    }
  }

  return { version, dim: size + q * 2, path: parts.join('') };
}

module.exports = {
  encode, svgPath, MAX_VERSION, capacityOf, ECC,
  /* 只给测试用：把"编码"和"排布"两步拆开测，
     否则出了错只能看到一个最终矩阵，分不清是哪一步的问题 */
  _internal: { rsEncode, genPoly, encodeData, buildCodewords, drawFunctions, drawData, maskBit, penalty, formatBits, versionBits }
};
