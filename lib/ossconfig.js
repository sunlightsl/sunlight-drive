/**
 * OSS 配置的存储、校验与解析
 * ------------------------------------------------------------------
 * P0 的目标：让「连 OSS 需要哪些信息」从 .env 搬到页面里，由管理员填写。
 *
 * 三条底线：
 *   1. AccessKeySecret 属于敏感凭证，落盘必须加密（AES-256-GCM），
 *      明文只存在于内存里，接口返回前一律脱敏。
 *   2. 加密用的主密钥不能和数据放一起：优先取环境变量 MASTER_KEY
 *      （托管模式下的正确姿势），没有才自动生成 data/.master.key
 *      （自建模式的兜底，权限 0600）。两者都没有时才无法工作。
 *   3. 解析顺序：页面配置（按用户存） > .env > 未配置。
 *      代码里所有"有没有 OSS"的判断都走 active()，不再看 CFG.hasOss ——
 *      后者只在进程启动时读一次，页面上配完它不会变。
 *
 * 条目按用户 ID 分开存（entries[userId]）。P0 只有平台级一条
 * （entries.platform，对应自建站长的全局 OSS）；P1 的"用户绑定自己的
 * bucket"直接再加条目，不用改存储格式。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CFG } = require('./config');

/* 数据目录跟随 store.js 的口径：DRIVE_DATA_DIR 优先（测试隔离靠它），
   默认落 data/。两个密钥文件都只放这里。 */
const DATA_DIR = process.env.DRIVE_DATA_DIR || CFG.DATA_DIR;
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');
const MASTER_KEY_FILE = path.join(DATA_DIR, '.master.key');

/** 平台级条目的键名（自建站长的全局 OSS 配置） */
const PLATFORM = 'platform';

/* ================================================================
   主密钥
   ================================================================ */

let _masterKey = null;

/**
 * 取 32 字节主密钥。
 * 环境变量 MASTER_KEY 是任意字符串（口令式），这里用 SHA-256 压成定长；
 * 文件里存的是 hex 编码的随机数。两条路殊途同归，都能当 AES-256 的钥匙。
 */
function masterKey() {
  if (_masterKey) return _masterKey;
  const envKey = (process.env.MASTER_KEY || '').trim();
  if (envKey) {
    if (envKey.length < 16) {
      throw new Error('MASTER_KEY 太短：至少 16 个字符，否则起不到加密作用');
    }
    _masterKey = crypto.createHash('sha256').update(envKey).digest();
    return _masterKey;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(MASTER_KEY_FILE)) {
    const hex = fs.readFileSync(MASTER_KEY_FILE, 'utf8').trim();
    const k = Buffer.from(hex, 'hex');
    if (k.length !== 32) throw new Error('主密钥文件损坏（长度不对），请检查 ' + MASTER_KEY_FILE);
    _masterKey = k;
    return _masterKey;
  }
  const k = crypto.randomBytes(32);
  fs.writeFileSync(MASTER_KEY_FILE, k.toString('hex') + '\n', { mode: 0o600 });
  _masterKey = k;
  return _masterKey;
}

/* ================================================================
   加解密（AES-256-GCM）
   ================================================================ */

/** 加密一段文本 → {iv, tag, data}，iv 每次随机，tag 防篡改 */
function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return {
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
}

/** 解密。tag 对不上会直接抛 —— 数据被人动过就该响，而不是悄悄给假数据 */
function unseal(box) {
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
}

/* ================================================================
   密钥库读写
   ================================================================ */

let _cache = null; // 解密后的 entries 对象

/** 读出全部条目（解密）。文件不存在视为空库 */
function load() {
  if (_cache) return _cache;
  if (!fs.existsSync(SECRETS_FILE)) {
    _cache = { version: 1, entries: {} };
    return _cache;
  }
  try {
    /* 文件里是 {version, iv, tag, data} 的密封盒，data 才是加密的条目 */
    const box = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
    _cache = JSON.parse(unseal(box));
  } catch (e) {
    // 要么文件被手工改过，要么 MASTER_KEY 换了 —— 两种都该大声报错，
    // 绝不能当成"没配置"继续跑：那等于让管理员以为配置丢了是正常的。
    throw new Error('secrets.json 无法解密（' + e.message + '）。' +
      '常见原因：MASTER_KEY 与加密时不一致，或文件被手工修改。');
  }
  if (!_cache.entries) _cache.entries = {};
  return _cache;
}

/** 整库加密落盘：先把条目整体 seal 成密文盒，再写文件。
    先写临时文件再改名，断电也不会留下半个文件 */
function persist(entries) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const box = seal(JSON.stringify({ version: 1, entries }));
  const tmp = SECRETS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(box, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SECRETS_FILE);
  _cache = { version: 1, entries };
}

/** 取某个用户的配置条目（解密后的明文对象），没有返回 null */
function getEntry(userId) {
  const e = load().entries[userId];
  return e ? JSON.parse(JSON.stringify(e)) : null;
}

/** 存某个用户的配置条目。整对象覆盖，调用方负责先 validate */
function setEntry(userId, cfg) {
  const all = load();
  all.entries[userId] = cfg;
  persist(all.entries);
}

/** 删掉某个用户的配置条目 */
function deleteEntry(userId) {
  const all = load();
  if (!(userId in all.entries)) return false;
  delete all.entries[userId];
  persist(all.entries);
  return true;
}

/* ================================================================
   校验与脱敏
   ================================================================ */

/**
 * 校验并规整一份表单输入。
 * 必填：region / keyId / keySecret / bucket / prefix（前缀必须有，P1 计费靠它分用户）。
 * 可选：endpoint（内网地址）、domain（自定义域名）、versioning、sseKms。
 * 返回规整后的对象；不合法就抛错，消息直接给用户看。
 *
 * @param {object} input  表单原始输入
 * @param {object} [prev] 已存的旧配置 —— keySecret 留空表示"沿用旧的"
 */
function validate(input, prev) {
  const v = (x) => String(x == null ? '' : x).trim();
  const region = v(input.region).replace(/\/+$/, '');
  let keyId = v(input.keyId);
  const bucket = v(input.bucket).toLowerCase();
  const prefix = v(input.prefix).replace(/^\/+|\/+$/g, '');
  const endpoint = v(input.endpoint);
  const domain = v(input.domain);
  const keySecret = String(input.keySecret == null ? '' : input.keySecret);

  if (!region) throw err('Region 不能为空');
  // 允许两种写法：标准 region（oss-cn-hangzhou）或完整内网/公网 endpoint
  if (!/^oss-[a-z0-9-]+$/.test(region) && !/^https?:\/\/[a-z0-9.-]+$/.test(region)) {
    throw err('Region 格式不正确：应形如 oss-cn-hangzhou，或填写完整的 endpoint 地址');
  }
  if (!keyId) throw err('AccessKey ID 不能为空');
  /* 页面回显的是脱敏值（LTAI****3f2a）。用户没动它就还原成真值 ——
     不然每次改个前缀都得把整串 ID 重输一遍。 */
  if (keyId.includes('****')) {
    if (prev && prev.keyId && masked(prev).keyId === keyId) keyId = prev.keyId;
    else throw err('AccessKey ID 不能用脱敏值，请填完整 ID');
  }
  if (!/^[A-Za-z0-9]{8,64}$/.test(keyId)) throw err('AccessKey ID 格式不正确：应为字母数字，8-64 位');
  if (!bucket) throw err('Bucket 不能为空');
  // 阿里云 bucket 命名规则：小写字母数字和 -，3-63 位，字母或数字开头结尾
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw err('Bucket 格式不正确：仅限小写字母、数字和中划线，3-63 位');
  }
  if (!prefix) throw err('上传前缀不能为空');
  if (prefix.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) {
    throw err('上传前缀不能包含空段或 ..');
  }

  // keySecret 留空 = 修改时不想重输，沿用已保存的那份
  let secret = keySecret;
  if (!secret) {
    if (prev && prev.keySecret) secret = prev.keySecret;
    else throw err('AccessKey Secret 不能为空');
  }
  if (!/^[A-Za-z0-9+/=]{16,128}$/.test(secret)) throw err('AccessKey Secret 格式不正确');

  if (endpoint && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(endpoint.replace(/^https?:\/\//, ''))) {
    throw err('内网 Endpoint 格式不正确：应形如 oss-cn-hangzhou-internal.aliyuncs.com');
  }
  if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain.replace(/^https?:\/\//, ''))) {
    throw err('自定义域名格式不正确');
  }

  return {
    region, keyId, keySecret: secret, bucket, prefix,
    endpoint: endpoint || '',
    domain: domain || '',
    versioning: !!input.versioning,
    sseKms: !!input.sseKms,
    savedAt: new Date().toISOString()
  };
}

function err(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

/** 脱敏视图：给页面回显用，绝不能带完整 Secret 出门 */
function masked(cfg) {
  if (!cfg) return null;
  const id = cfg.keyId || '';
  return {
    region: cfg.region,
    bucket: cfg.bucket,
    prefix: cfg.prefix,
    endpoint: cfg.endpoint || '',
    domain: cfg.domain || '',
    versioning: !!cfg.versioning,
    sseKms: !!cfg.sseKms,
    keyId: id.length > 8 ? id.slice(0, 4) + '****' + id.slice(-4) : '****',
    hasSecret: !!cfg.keySecret,
    savedAt: cfg.savedAt || ''
  };
}

/* ================================================================
   解析与客户端
   ================================================================ */

/**
 * 当前生效的 OSS 配置。优先级：平台条目 > .env。
 * 返回 { source: 'ui'|'env', cfg } 或 null（未配置）。
 */
function active() {
  const ui = getEntry(PLATFORM);
  if (ui) return { source: 'ui', cfg: ui };
  if (CFG.keyId && CFG.keySecret && CFG.bucket) {
    return {
      source: 'env',
      cfg: {
        region: CFG.region, keyId: CFG.keyId, keySecret: CFG.keySecret,
        bucket: CFG.bucket, prefix: CFG.uploadPrefix,
        endpoint: '', domain: '', versioning: false, sseKms: false
      }
    };
  }
  return null;
}

/** 有没有可用的 OSS（所有上传下载判断都改走这里） */
function ready() {
  return !!active();
}

/* ---- 客户端缓存：按配置内容做键。平台配置、各用户绑定的桶，
       各自的客户端各建各的，互不串 —— 用户换配置只影响自己那把钥匙 ---- */
const _clients = new Map(); // clientKey -> OSS client

function clientKey(cfg) {
  return [cfg.keyId, cfg.keySecret, cfg.bucket, cfg.region, cfg.endpoint].join('\u0000');
}

function clientForCfg(cfg) {
  const key = clientKey(cfg);
  let c = _clients.get(key);
  if (!c) {
    const OSS = require('ali-oss');
    c = new OSS({
      region: cfg.region,
      accessKeyId: cfg.keyId,
      accessKeySecret: cfg.keySecret,
      bucket: cfg.bucket,
      endpoint: cfg.endpoint ? 'https://' + cfg.endpoint.replace(/^https?:\/\//, '') : undefined,
      secure: true,
      timeout: 30 * 60 * 1000
    });
    _clients.set(key, c);
  }
  return c;
}

function notConfigured() {
  const e = new Error('OSS 未配置');
  e.code = 'OSS_NOT_CONFIGURED';
  return e;
}

/** 某个用户当前生效的配置：他自己绑的桶 > 平台配置 > .env。
    Mode B 的解析核心 —— 文件落在哪个桶、下载用谁的钥匙，都由这里决定。 */
function activeFor(userId) {
  const own = getEntry(userId);
  if (own) return { source: 'ui-user', cfg: own };
  return active();
}

/** 平台级客户端（孤儿分片扫描等全局操作用） */
function getClient() {
  const a = active();
  if (!a) throw notConfigured();
  return clientForCfg(a.cfg);
}

/** 按用户取客户端：他绑了自己的桶就用他的，否则用平台的 */
function getClientFor(userId) {
  const a = activeFor(userId);
  if (!a) throw notConfigured();
  return clientForCfg(a.cfg);
}

/**
 * 连接测试：put 一个小探测对象 → 读回来 → 删掉。
 * 全链路走真实请求，比"配置能通过格式检查"可信得多。
 * 返回 { ok:true, latencyMs } 或抛错（消息带原因）。
 */
async function testConnection(cfg) {
  const OSS = require('ali-oss');
  const c = new OSS({
    region: cfg.region,
    accessKeyId: cfg.keyId,
    accessKeySecret: cfg.keySecret,
    bucket: cfg.bucket,
    endpoint: cfg.endpoint ? 'https://' + cfg.endpoint.replace(/^https?:\/\//, '') : undefined,
    secure: true,
    timeout: 15000
  });
  const probe = cfg.prefix + '/.conn-test-' + crypto.randomBytes(4).toString('hex');
  const t0 = Date.now();
  await c.put(probe, Buffer.from('sunlight-conn-test'));
  const got = await c.get(probe);
  if (String(got.content) !== 'sunlight-conn-test') {
    throw new Error('写入成功但读回的内容不一致，bucket 状态异常');
  }
  await c.delete(probe);
  return { ok: true, latencyMs: Date.now() - t0 };
}

/**
 * 浏览器直传（PostObject）要 POST 到的地址。
 * 规则：自定义/内网 endpoint → {bucket}.{endpoint}；
 *      标准 region（oss-cn-hangzhou）→ {bucket}.{region}.aliyuncs.com。
 */
function postHost(cfg) {
  const host = String(cfg.endpoint || '').replace(/^https?:\/\//, '');
  if (host) return cfg.bucket + '.' + host;
  const region = String(cfg.region || '').replace(/^https?:\/\//, '');
  return cfg.bucket + '.' + region + (region.includes('.') ? '' : '.aliyuncs.com');
}

/**
 * 给"上传一个分片"签一个 PUT URL（V1 签名，15 分钟内有效）。
 * 浏览器拿它直接 PUT 分片到 OSS，不走本服务。
 *
 * V1 URL 签名规范（aliyun）：
 *   StringToSign = VERB \n Content-MD5 \n Content-Type \n Expires \n
 *                  CanonicalizedOSSHeaders + CanonicalizedResource
 *   分片的 uploadId/partNumber 属于 OSS 定义的 sub-resource，必须参与签名；
 *   按字典序排在 CanonicalizedResource 的 '?' 后面。
 * 手写而不是用 ali-oss 的 signatureUrl：后者对 sub-resource 的支持版本间
 * 有差异，签名这种错一点就全 403 的东西，按规范自己写反而可控。
 * 正确性由 test/oss-config.js 里的一份独立实现交叉验证兜底。
 */
function signPartUrl(cfg, key, ossUploadId, partNumber, expiresSec) {
  const host = postHost(cfg);
  const expires = Math.floor(Date.now() / 1000) + expiresSec;
  const resource = '/' + cfg.bucket + '/' + key +
    '?partNumber=' + partNumber + '&uploadId=' + encodeURIComponent(ossUploadId);
  const stringToSign = 'PUT\n\n\n' + expires + '\n' + resource;
  const sig = crypto.createHmac('sha1', cfg.keySecret).update(stringToSign).digest('base64');
  return 'https://' + host + '/' + key +
    '?OSSAccessKeyId=' + encodeURIComponent(cfg.keyId) +
    '&Expires=' + expires +
    '&Signature=' + encodeURIComponent(sig) +
    '&partNumber=' + partNumber +
    '&uploadId=' + encodeURIComponent(ossUploadId);
}

/** 测试里要能重置缓存（换了一_tmp 数据目录等场景） */
function _resetForTest() {
  _cache = null;
  _clients.clear();
  _masterKey = null;
}

module.exports = {
  PLATFORM, SECRETS_FILE, MASTER_KEY_FILE,
  load, persist, getEntry, setEntry, deleteEntry,
  validate, masked, active, activeFor, ready, getClient, getClientFor, clientForCfg,
  testConnection, postHost, signPartUrl,
  seal, unseal,
  _resetForTest
};
