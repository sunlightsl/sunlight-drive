#!/usr/bin/env node
/**
 * 单元测试（零依赖，直接 node test/run.js）
 * ------------------------------------------------------------------
 * 覆盖三块最容易出隐性 bug 的逻辑：
 *   1. 名字消毒 + 文件树操作（环、越权、重名）
 *   2. TOTP（拿 RFC 6238 官方向量对）
 *   3. 分享密码哈希
 *
 * 这几块出问题不会崩，只会安静地做错事（下错文件、越权拿到别的资源），
 * 所以必须有回归测试兜着。
 */

const path = require('path');
const T = require('../lib/tree');
const totp = require('../lib/totp');
const auth = require('../lib/auth');
const preview = require('../lib/preview');

let pass = 0, fail = 0;
const failures = [];

function ck(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, failures.push(label));
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `\n         got  = ${JSON.stringify(got)}\n         want = ${JSON.stringify(want)}`}`);
}

function throws(label, fn, msgPart) {
  try {
    fn();
    fail++; failures.push(label);
    console.log(` FAIL  ${label}  （没抛异常，但应该抛）`);
  } catch (e) {
    const ok = !msgPart || e.message.includes(msgPart);
    ok ? pass++ : (fail++, failures.push(label));
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}  -> ${e.message}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m== ${title} ==\x1b[0m`);
}

/* ================================================================
   1. 名字消毒
   ================================================================ */
section('名字消毒');
const S = T.sanitizeName;

ck('普通中文', S('升级包'), '升级包');
ck('中文带空格', S('示例目录 升级包'), '示例目录 升级包');
ck('路径穿越 ../../etc/passwd', S('../../etc/passwd'), 'etc-passwd');
ck('路径穿越 ..\\..\\win.ini', S('..\\..\\win.ini'), 'win.ini');
throws('单独的 ..', () => S('..'), '名称不能为空');

ck('正斜杠', S('a/b.txt'), 'a-b.txt');
ck('反斜杠', S('a\\b.txt'), 'a-b.txt');
ck('Windows 非法字符', S('a*?<>|:"b.txt'), 'a-b.txt');
ck('控制字符', S('a\u0000b\u001fc'), 'a-b-c');
ck('首尾点空格', S('  ..name..  '), 'name');
ck('连字符折叠', S('a///b'), 'a-b');
ck('保留隐藏文件名 .env', S('.env'), '.env');
ck('保留隐藏文件名 .gitignore', S('.gitignore'), '.gitignore');
ck('设备名 CON.txt', S('CON.txt'), '_CON.txt');
ck('设备名 com1', S('com1'), '_com1');
ck('不误伤 CONSOLE', S('CONSOLE.txt'), 'CONSOLE.txt');
ck('超长名保留扩展名', S('x'.repeat(200) + '.rar').endsWith('.rar'), true);
ck('超长名不超 120', S('x'.repeat(200) + '.rar').length, 120);
throws('全非法字符 ///', () => S('///'), '名称不能为空');
throws('空字符串', () => S(''), '名称不能为空');
throws('纯空白', () => S('   '), '名称不能为空');

/* ================================================================
   2. 文件树
   ================================================================ */
section('文件树操作');

function freshTree() {
  const s = { nodes: {}, shares: {} };
  const gk = T.createFolder(s, '示例目录', null);
  const up = T.createFolder(s, '升级包', gk.id);
  const f1 = T.addFile(s, { name: 'JMPUpdater1.051A.rar', parentId: up.id, size: 100, ossKey: 'release/updater/a.rar' });
  const f2 = T.addFile(s, { name: 'JMPUpdater2.970A.zip', parentId: up.id, size: 200, ossKey: 'release/updater/b.zip' });
  return { s, gk, up, f1, f2 };
}

{
  const { s, gk, up, f1 } = freshTree();
  ck('顶层只有示例目录', T.childrenOf(s, null).map(n => n.name), ['示例目录']);
  ck('示例目录下只有升级包', T.childrenOf(s, gk.id).map(n => n.name), ['升级包']);
  ck('祖先链', T.ancestorsOf(s, f1.id).map(n => n.name), ['示例目录', '升级包']);
  ck('示例目录子树 4 个节点', T.subtreeIds(s, gk.id).length, 4);
  ck('升级包子树 3 个节点', T.subtreeIds(s, up.id).length, 3);
  ck('排序：文件夹在前', T.childrenOf(s, gk.id)[0].type, 'folder');
}

section('环检测（无限嵌套最危险处）');
{
  const { s, gk, up } = freshTree();
  const deep = T.createFolder(s, '二级', up.id);
  throws('不能移进自己', () => T.move(s, gk.id, gk.id), '不能把文件夹移进它自己');
  throws('不能移进直接子目录', () => T.move(s, gk.id, up.id), '不能把文件夹移进它自己的子目录');
  throws('不能移进更深的后代', () => T.move(s, gk.id, deep.id), '不能把文件夹移进它自己的子目录');
  T.move(s, deep.id, gk.id);
  ck('合法的向上移动', T.get(s, deep.id).parent, gk.id);
  T.move(s, up.id, null);
  ck('合法移到顶层', T.get(s, up.id).parent, null);
  // get() 也接受节点对象，避免以后有人传对象进来查不到还不报错
  ck('get() 接受节点对象', T.get(s, deep).name, '二级');
}

section('越权判定（分享安全的核心）');
{
  const { s, gk, up, f1 } = freshTree();
  const other = T.createFolder(s, '私人', null);
  ck('分享升级包 → 取内部子文件 允许', T.isDescendant(s, up.id, f1.id), true);
  ck('分享升级包 → 取升级包自身 允许', T.isDescendant(s, up.id, up.id), true);
  ck('分享升级包 → 取父级示例目录 禁止', T.isDescendant(s, up.id, gk.id), false);
  ck('分享升级包 → 取另一个顶层 禁止', T.isDescendant(s, up.id, other.id), false);
  ck('分享升级包 → 取不存在的节点 禁止', T.isDescendant(s, up.id, 'n_nope'), false);
  ck('分享顶层示例目录 → 取升级包子文件 允许', T.isDescendant(s, gk.id, f1.id), true);
}

section('重名与删除');
{
  const { s, gk, up, f1, f2 } = freshTree();
  ck('文件夹重名 -> (2)', T.createFolder(s, '升级包', gk.id).name, '升级包 (2)');
  ck('文件夹重名 -> (3)', T.createFolder(s, '升级包', gk.id).name, '升级包 (3)');
  ck('文件重名 -> (2)', T.addFile(s, { name: 'JMPUpdater1.051A.rar', parentId: up.id, size: 1, ossKey: 'x' }).name,
    'JMPUpdater1.051A (2).rar');
  ck('改名不和自己冲突', T.rename(s, f2.id, 'JMPUpdater2.970A.zip').name, 'JMPUpdater2.970A.zip');

  s.shares['s_a'] = { token: 's_a', nodeId: up.id };
  s.shares['s_b'] = { token: 's_b', nodeId: gk.id };
  const r = T.remove(s, gk.id);
  // 上面那个重名测试也往 up 里塞了一个 ossKey='x' 的文件，一起被回收才对
  ck('回收 OSS key', r.ossKeys.sort(), ['release/updater/a.rar', 'release/updater/b.zip', 'x']);
  ck('指向子树的分享被作废', r.revokedShares.sort(), ['s_a', 's_b']);
  ck('树已清空', T.childrenOf(s, null).length, 0);
  throws('删不存在的节点', () => T.remove(s, f1.id), '节点不存在');
}

section('排序：版本号要按数字大小，不是字符串');
{
  const s = { nodes: {}, shares: {} };
  const d = T.createFolder(s, '升级包', null);
  for (const v of ['1.051A', '1.101A', '2.816C', '2.970A', '10.001A', '2.9A']) {
    T.addFile(s, { name: `JMPUpdater${v}.rar`, parentId: d.id, size: 1, ossKey: 'k/' + v });
  }
  const names = T.childrenOf(s, d.id).map(n => n.name.replace(/^JMPUpdater|\.rar$/g, ''));
  ck('2.9A 排在 2.816C 前（数字感知）', names.indexOf('2.9A') < names.indexOf('2.816C'), true);
  ck('10.001A 排在 2.x 之后', names.indexOf('10.001A') > names.indexOf('2.970A'), true);
  console.log('       实际顺序： ' + names.join('  '));
}

/* ================================================================
   3. TOTP —— 用 RFC 6238 附录 B 的官方向量
   ================================================================ */
section('TOTP（RFC 6238 官方向量）');
{
  const b32 = totp.base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  ck('base32 编码', b32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  ck('base32 往返', totp.base32Decode(b32).toString('ascii'), '12345678901234567890');

  const vectors = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']
  ];
  for (const [t, expect8] of vectors) {
    ck(`T=${t}`, totp.code(b32, t * 1000), expect8.slice(-6));
  }
}

section('TOTP 容差、防重放与失败原因');
{
  const secret = totp.generateSecret();
  const now = Date.now();
  const V = (c, ms) => totp.verifyCode(secret, c, ms);

  ck('正确码通过', V(totp.code(secret, now)).reason, 'ok');

  // 手机上的码明明是对的，但这一片已经用过了 —— 必须能区分出来，
  // 否则前端只能回一句"动态码不对"，用户会以为密钥配错了
  const again = V(totp.code(secret, now));
  ck('同一个码不能用第二遍', again.ok, false);
  ck('第二遍的失败原因是 replayed 而不是 mismatch', again.reason, 'replayed');

  ck('错码原因是 mismatch', V('000001').reason === 'mismatch' || V('000002').reason === 'mismatch', true);
  ck('位数不对原因 format', V('12345').reason, 'format');
  ck('空输入原因 format', V('').reason, 'format');
  ck('上一个时间片容忍（±30s）', V(totp.code(secret, now - 30000)).ok, true);
  ck('2 分钟前的码拒绝', V(totp.code(secret, now - 120000)).ok, false);
  ck('带空格的输入', V(' ' + totp.code(secret, now + 30000) + ' ').ok, true);
  ck('倒计时在 1..30', totp.secondsLeft() >= 1 && totp.secondsLeft() <= 30, true);

  totp.resetReplay();
  ck('resetReplay 之后同一个码又能用了', V(totp.code(secret, now)).ok, true);
}

/* ================================================================
   4. 分享密码
   ================================================================ */
section('分享密码');
{
  const pw = auth.makeSharePassword();
  ck('长度 6', pw.length, 6);
  ck('不含易混字符 0/O/1/I/l', /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/.test(pw), true);
  ck('多次生成不重样', new Set(Array.from({ length: 200 }, () => auth.makeSharePassword())).size > 190, true);

  const h = auth.hashSharePassword(pw);
  ck('哈希不是明文', h.includes(pw), false);
  ck('正确密码验证通过', auth.verifySharePassword(h, pw), true);
  ck('错误密码拒绝', auth.verifySharePassword(h, 'XXXXXX'), false);
  ck('同一密码两次哈希不同（有盐）', auth.hashSharePassword(pw) === h, false);
  ck('损坏的哈希不抛异常', auth.verifySharePassword('garbage', pw), false);
  ck('空哈希不抛异常', auth.verifySharePassword('', pw), false);
}

/* ================================================================
   5. 常量时间比较
   ================================================================ */
section('常量时间比较');
{
  ck('相同', auth.safeEqual('abc', 'abc'), true);
  ck('不同', auth.safeEqual('abc', 'abd'), false);
  ck('长度不同', auth.safeEqual('abc', 'abcd'), false);
  ck('空', auth.safeEqual('', ''), true);
  ck('中文', auth.safeEqual('密码', '密码'), true);
  ck('中文不同', auth.safeEqual('密码', '密玛'), false);
}

/* ================================================================
   6. 二维码
   ================================================================
   自己实现的东西最怕"看着对"。这里用两种办法锁住：
     · 结构断言 —— 定位图案、时序图案、暗模块、尺寸必须长在对的位置
     · 基准矩阵 —— 两段固定内容的完整矩阵逐格写死，任何一处改动都会露馅
   基准值不是随手抄的：是用独立解码器回读验证过、并和 node-qrcode 的
   byte 模式输出逐格比对一致的。
   ================================================================ */
section('二维码');
{
  const Q = require('../lib/qrcode');

  /* —— 版本与容量 —— */
  ck('各级容量', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => Q.capacityOf(v)),
    [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]);
  ck('容量刚好装下走低版本', Q.encode('x'.repeat(14)).version, 1);
  ck('超一个字节就升版本', Q.encode('x'.repeat(15)).version, 2);
  ck('顶到 10 版上限', Q.encode('x'.repeat(213)).version, 10);
  throws('再长就报错', () => Q.encode('x'.repeat(214)), '内容太长了');
  throws('中文按字节算，不是按字数', () => Q.encode('中'.repeat(80)), '内容太长了');

  ck('尺寸 = 版本 × 4 + 17', Q.encode('x'.repeat(213)).size, 57);
  ck('同一内容两次结果一致', Q.encode('hello world').modules.map(String), Q.encode('hello world').modules.map(String));

  /* —— 功能图案必须长在对的位置 —— */
  const { size, modules } = Q.encode('hello world');
  const at = (r, c) => modules[r][c];

  const finderOk = (r0, c0) => {
    const want = [
      [1, 1, 1, 1, 1, 1, 1],
      [1, 0, 0, 0, 0, 0, 1],
      [1, 0, 1, 1, 1, 0, 1],
      [1, 0, 1, 1, 1, 0, 1],
      [1, 0, 1, 1, 1, 0, 1],
      [1, 0, 0, 0, 0, 0, 1],
      [1, 1, 1, 1, 1, 1, 1]
    ];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
      if (at(r0 + r, c0 + c) !== want[r][c]) return false;
    }
    return true;
  };
  ck('左上定位图案', finderOk(0, 0), true);
  ck('右上定位图案', finderOk(0, size - 7), true);
  ck('左下定位图案', finderOk(size - 7, 0), true);

  ck('定位图案外侧一圈是分隔符（白）', [at(7, 7), at(0, 7), at(7, 0)], [0, 0, 0]);

  let timing = true;
  for (let i = 8; i <= size - 9; i++) {
    if (at(6, i) !== (i % 2 === 0 ? 1 : 0)) timing = false;
    if (at(i, 6) !== (i % 2 === 0 ? 1 : 0)) timing = false;
  }
  ck('时序图案黑白相间', timing, true);
  ck('固定黑模块存在', at(size - 8, 8), 1);

  /* 对齐图案：5×5，中心一个黑点，外面一圈白、最外一圈黑。
     1 版不设对齐图案；2 版起在 (18,18) 有一个，正好拿来对照。 */
  const alignOk = (mods, r0, c0) => {
    const get = (r, c) => mods[r0 + r][c0 + c];
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const want = (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)) ? 1 : 0;
        if (get(r, c) !== want) return false;
      }
    }
    return true;
  };
  ck('1 版：该放对齐图案的位置是空的', alignOk(Q.encode('hello world').modules, 18, 18), false);
  ck('2 版：对齐图案在 (18,18)', alignOk(Q.encode('x'.repeat(15)).modules, 18, 18), true);

  /* —— SVG 输出 —— */
  const svg = Q.svgPath('hello world');
  ck('SVG 尺寸含静默区', svg.dim, size + 8);
  ck('SVG 路径非空', svg.path.length > 0, true);
  ck('SVG 路径用的是相对横线画法', /^M\d+ \d+h\d+v1h-\d+z/.test(svg.path), true);
  ck('路径里不含 NaN', svg.path.includes('NaN'), false);

  /* 所有落笔坐标都必须落在静默区以内，否则贴边会被裁掉 */
  const starts = [...svg.path.matchAll(/M(\d+) (\d+)/g)].map(m => [+m[1], +m[2]]);
  const margin = 4;
  ck('落笔坐标不越过静默区',
    starts.every(([x, y]) => x >= margin && y >= margin && x < svg.dim - margin && y < svg.dim - margin), true);
  ck('落笔点数量合理（黑块的行段数）', starts.length > 20 && starts.length < size * size, true);
  ck('自定义静默区', Q.svgPath('hello world', { margin: 0 }).dim, size);

  /* —— 基准矩阵 —— */
  const GOLDEN_V1 = [
    '111111100101101111111',
    '100000100010001000001',
    '101110101111001011101',
    '101110101110101011101',
    '101110101010101011101',
    '100000101001001000001',
    '111111101010101111111',
    '000000001010000000000',
    '101111100101001111100',
    '011011010101111111101',
    '101011110110111001110',
    '101001000101110011100',
    '000101111100111000001',
    '000000001010100011001',
    '111111100001001000110',
    '100000101000010101111',
    '101110101001001100001',
    '101110101100111111000',
    '101110101100100100100',
    '100000100110110011100',
    '111111101101101010010'
  ];
  const gotV1 = Q.encode('hello world').modules.map(r => Array.from(r).join(''));
  ck('基准矩阵（hello world / 1 版）', gotV1, GOLDEN_V1);

  const GOLDEN_V7 = [
    '111111100111001010101100001001111100101111111',
    '100000101111010100111001111000000001001000001',
    '101110101100001011100000010000001101001011101',
    '101110101001011101100110000111111101101011101',
    '101110100100110110011111100100110111101011101',
    '100000100111101010101000101011001000001000001',
    '111111101010101010101010101010101010101111111',
    '000000001001111001001000101010111110000000000',
    '100000101010011000101111110001010011111001110',
    '010111011000101101010110011011110011111111110',
    '100000111100111000011011101011000110111000110',
    '011000010100101111100100000111110110100010111',
    '111000101000111010101101111110001010000010000',
    '011111010111010110011010010101111100110001111',
    '001100110011011101101001100010010100111110110',
    '001110010101010001011111111101010001101111110',
    '111001111011111001101110010001010100000001111',
    '100110010101001101110001110101100100110000100',
    '010010100101000110001000110000001011011101001',
    '111101000010110000110100110000101000011011111',
    '000011111011101101101111101001010000111110000',
    '000110001000100010011000111111101010100011110',
    '101110101010010100101010111000110011101010110',
    '100110001111110000101000110011111110100011100',
    '010111111101101001111111100010101000111110010',
    '100100001110101110111110110011110101110101001',
    '110001111011000011000101001010001010000001010',
    '110110001010000010110010100100011000010111100',
    '111101111101100000011000111101110110010011001',
    '110000000110110010010001100111111101100100101',
    '001010111001001000011100000110011111001011101',
    '010111000110011111001001111110111001001001111',
    '011000100001000000000001101101010100000110110',
    '010101011101010001011101111001110010000110010',
    '000010101101000111100010001101011110010101100',
    '011110000011100111101111100001101001101101110',
    '100110101111011100111111111011101011111110010',
    '000000001000001100101000110001101000100010101',
    '111111100011101001001010101101110110101010110',
    '100000100011000110111000100001100110100011110',
    '101110100101010110101111100001110101111110010',
    '101110100100111010101100110101101101101000111',
    '101110100110101110010100000010001100100010001',
    '100000100011100001101101100111110001100101100',
    '111111101101110111110001111000110111011000010'
  ];
  const otpText = 'otpauth://totp/sunlight:sunlight?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=sunlight&algorithm=SHA1&digits=6&period=30';
  const gotV7 = Q.encode(otpText).modules.map(r => Array.from(r).join(''));
  ck('基准矩阵（绑定 URI / 7 版）', gotV7, GOLDEN_V7);
  ck('绑定 URI 落在 7 版', Q.encode(otpText).version, 7);

  /* —— 表结构自检：ECC 表里写的块数×块长，加起来必须等于该版本的总码字数 —— */
  const TOTAL = { 1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292, 10: 346 };
  ck('ECC 表自洽（数据码字 + 纠错码字 = 总码字）',
    Object.keys(TOTAL).map(v => {
      const spec = Q.ECC[v];
      const data = spec.groups.reduce((a, [n, k]) => a + n * k, 0);
      const blocks = spec.groups.reduce((a, [n]) => a + n, 0);
      return data + blocks * spec.ec === TOTAL[v];
    }),
    Object.keys(TOTAL).map(() => true));

  /* —— RS 纠错：拿教材上的向量对。
        度 10 生成多项式 + 16 个数据码字 → 10 个纠错码字。
        纠错余数依赖整段数据，只取前几个码字算不出一样的结果。 —— */
  ck('RS 生成多项式（度 10）', Q._internal.genPoly(10),
    [1, 216, 194, 159, 111, 199, 94, 95, 113, 157, 193]);
  const rsIn = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  ck('RS 纠错向量',
    Array.from(Q._internal.rsEncode(Uint8Array.from(rsIn), 10)),
    [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  ck('数据+纠错整段再取余为 0',
    Array.from(Q._internal.rsEncode(Uint8Array.from(rsIn.concat([196, 35, 39, 119, 235, 215, 231, 226, 93, 23])), 10)),
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  /* —— 格式信息：纠错级别 M + 掩码 0..7 的 15 位值 ——
     这 8 个值不是随便编的，是 BCH(15,5) 码字异或固定掩码 0x5412 得到的。
     下面两条性质把它们钉死：异或回来必须能被生成多项式整除，
     且两两之间要拉开足够距离（否则扫歪一位就认成另一种掩码）。 */
  ck('格式信息向量', [0, 1, 2, 3, 4, 5, 6, 7].map(m => Q._internal.formatBits(0b00, m)),
    [0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0]);
  ck('格式信息是合法 BCH 码字',
    [0, 1, 2, 3, 4, 5, 6, 7].map(m => {
      let v = Q._internal.formatBits(0b00, m) ^ 0x5412;
      for (let i = 14; i >= 10; i--) if (v & (1 << i)) v ^= 0x537 << (i - 10);
      return v === 0;
    }),
    [0, 1, 2, 3, 4, 5, 6, 7].map(() => true));
  (() => {
    let min = 99;
    for (let a = 0; a < 8; a++) {
      for (let b = a + 1; b < 8; b++) {
        let x = Q._internal.formatBits(0b00, a) ^ Q._internal.formatBits(0b00, b);
        let d = 0;
        while (x) { d += x & 1; x >>= 1; }
        min = Math.min(min, d);
      }
    }
    ck('格式信息两两汉明距离 >= 2', min >= 2, true);
  })();
  ck('版本信息向量', [7, 8, 9, 10].map(v => Q._internal.versionBits(v)),
    [0x07C94, 0x085BC, 0x09A99, 0x0A4D3]);
}

/* ================================================================
   7. 上传中断判定
   ================================================================
   这一节要起一个真的 http 服务，所以放在最后异步跑。
   它守的是一个具体踩过的坑：如果用 req 的 'close' 事件判断"上传中断"，
   正常上传也会被判成中断，每次成功上传都会删掉刚传的对象并返回 400。
   详见 lib/reqguard.js 的注释。
   ================================================================ */
(async () => {
  section('上传中断判定');

  const http = require('http');
  const { trackRequest } = require('../lib/reqguard');

  // 和 server.js 里一样的用法：读完请求流之后问 guard.isAborted()。
  // 这里额外挂 close，因为中断时 'end' 根本不触发，光靠 end 记不到。
  const seen = [];
  const server = http.createServer((req, res) => {
    const guard = trackRequest(req);
    req.resume();

    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      seen.push({ aborted: guard.isAborted(), complete: req.complete });
      try { res.end('ok'); } catch (_) {}
    };

    req.on('end', () => setImmediate(record));
    req.on('close', () => setImmediate(record));
  });

  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const post = (opts = {}) => new Promise(resolve => {
    const body = Buffer.alloc(32 * 1024, 'a');
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };

    // agent:false —— Node 19+ 的全局 agent 默认 keep-alive，
    // 复用连接会让 server.close() 一直等下去，测试直接挂住
    const req = http.request({ port, method: 'POST', path: '/u', agent: false,
      headers: { 'Content-Length': body.length, Connection: 'close' } });

    req.on('error', () => {});                       // 自己 destroy 会报 ECONNRESET，忽略
    req.on('response', res => { res.resume(); res.on('end', () => setTimeout(finish, 40)); });

    req.write(body.subarray(0, 512));

    if (opts.abortAfter) {
      // 断开之后服务端不会回响应（请求体没读完），只能等一小会儿再收工
      setTimeout(() => { req.destroy(); setTimeout(finish, 250); }, opts.abortAfter);
    } else {
      req.end(body.subarray(512));
    }

    setTimeout(finish, 3000);                        // 兜底，任何情况都别把测试挂死
  });

  await post({});
  ck('正常上传：不算中断', seen[0] && seen[0].aborted, false);
  ck('正常上传：req.complete 为 true', seen[0] && seen[0].complete, true);

  await post({ abortAfter: 30 });
  ck('中途断开：算中断', seen[1] && seen[1].aborted, true);
  ck('中途断开：req.complete 为 false', seen[1] && seen[1].complete, false);
  ck('两个场景都被服务端观察到', seen.length, 2);

  server.closeAllConnections?.();          // 兜底：还有什么连着就直接断掉
  await new Promise(r => server.close(r));

  /* ================================================================
     预览能力判定（lib/preview.js）
     ================================================================
     这个白名单是**安全边界**，不只是功能开关：
     对 SVG / HTML 签 inline 等于把同源执行权交给上传者。
     所以下面既有"该能预览的能预览"，也有"绝不能预览的必须拒绝"。 */
  console.log('\n\x1b[1m== 预览能力判定 ==\x1b[0m');
  {
    const f = name => ({ type: 'file', name });
    const d = name => ({ type: 'folder', name });

    /* 能预览的 */
    ck('jpg', preview.kindOf(f('a.jpg')), 'image');
    ck('大写的 JPG 也认', preview.kindOf(f('照片.JPG')), 'image');
    ck('png', preview.kindOf(f('b.png')), 'image');
    ck('webp', preview.kindOf(f('c.webp')), 'image');
    ck('mp4', preview.kindOf(f('培训.mp4')), 'video');
    ck('mov', preview.kindOf(f('a.mov')), 'video');
    ck('webm', preview.kindOf(f('a.webm')), 'video');
    ck('pdf', preview.kindOf(f('讲义.pdf')), 'pdf');
    ck('mp3', preview.kindOf(f('录音.mp3')), 'audio');
    ck('m4a', preview.kindOf(f('录音.m4a')), 'audio');

    /* 关键：这些**绝不能** inline。svg/html 会执行脚本；其余是浏览器渲染不了 */
    ck('svg 不允许预览', preview.kindOf(f('evil.svg')), '');
    ck('html 不允许预览', preview.kindOf(f('evil.html')), '');
    ck('htm 不允许预览', preview.kindOf(f('evil.htm')), '');
    ck('docx 不允许预览', preview.kindOf(f('d.docx')), '');
    ck('pptx 不允许预览', preview.kindOf(f('p.pptx')), '');
    ck('zip 不允许预览', preview.kindOf(f('a.zip')), '');
    ck('mkv 不允许预览（浏览器放不了）', preview.kindOf(f('a.mkv')), '');
    ck('exe 不允许预览', preview.kindOf(f('a.exe')), '');
    ck('没有扩展名', preview.kindOf(f('README')), '');
    ck('只有点结尾', preview.kindOf(f('weird.')), '');
    ck('文件夹不预览', preview.kindOf(d('照片.jpg')), '');

    /* content-type 覆盖：不覆盖的话 OSS 可能回 octet-stream，浏览器就下载了 */
    ck('图片的 content-type', preview.contentTypeOf(f('a.JPG')), 'image/jpeg');
    ck('视频的 content-type', preview.contentTypeOf(f('a.mp4')), 'video/mp4');
    ck('pdf 的 content-type', preview.contentTypeOf(f('a.pdf')), 'application/pdf');
    ck('未知类型不覆盖', preview.contentTypeOf(f('a.svg')), '');

    ck('canPreview 对图片为真', preview.canPreview(f('a.png')), true);
    ck('canPreview 对 svg 为假', preview.canPreview(f('a.svg')), false);
  }

  /* ================================================================
     登录回跳参数（index.html 的 safeNext）
     ================================================================
     它是**开放重定向**的唯一防线：next 参数直接来自 URL，
     如果允许绝对地址，攻击者就能构造
       /?next=https://evil.com
     让用户在我们的域名上登录、然后被送到钓鱼站。
     下面这些"看起来像站内路径"的写法都必须被拒。
     判定逻辑与 index.html 里的实现逐字一致。 */
  console.log('\n\x1b[1m== 登录回跳参数（开放重定向防护）==\x1b[0m');
  {
    const safeNext = raw => {
      if (!raw) return '';
      let s = String(raw).replace(/[\u0000-\u001f\u007f]/g, '');
      if (s[0] !== '/') return '';
      if (s[1] === '/' || s[1] === '\\') return '';
      return s;
    };

    /* 该放行的 */
    ck('普通站内路径', safeNext('/'), '/');
    ck('带查询串', safeNext('/s/s_abc?x=1'), '/s/s_abc?x=1');
    ck('分享页地址', safeNext('/s/s_abc123'), '/s/s_abc123');

    /* 必须拒的 */
    ck('空', safeNext(''), '');
    ck('null', safeNext(null), '');
    ck('绝对地址', safeNext('https://evil.com'), '');
    ck('协议相对 //', safeNext('//evil.com'), '');
    ck('协议相对带路径', safeNext('//evil.com/a'), '');
    ck('反斜杠混淆', safeNext('/\\evil.com'), '');
    ck('不带前导斜杠', safeNext('s/s_abc'), '');
    ck('javascript:', safeNext('javascript:alert(1)'), '');
    ck('换行注入被清掉后仍是相对路径', safeNext('/a\nb'), '/ab');
    ck('控制字符被清掉', safeNext('/a\u0000b'), '/ab');
    ck('只有控制字符', safeNext('\u0000\u0001'), '');
  }

  /* ================================================================ */
  console.log('\n' + '='.repeat(52));
  if (fail) {
    console.log(`\x1b[31m失败 ${fail} 项\x1b[0m，通过 ${pass} 项`);
    console.log('失败清单：');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  } else {
    console.log(`\x1b[32m全部通过\x1b[0m（${pass} 项）`);
  }
})();
