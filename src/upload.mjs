// 上传后台的契约层：纯函数，运行时无关（Pages Functions / Actions / CLI / 测试共用这一份）。
// 因此这里不 import node:crypto、不用 Buffer —— 边缘没有它们。
//
// 三条硬规矩由这里的函数负责，端点只是把它们接起来：
//   1. 只增不改不删 —— begin 会 HEAD 最终键，已存在就 409；全仓没有删除入口。
//   2. 只写本仓负责的素材前缀 —— cdn/ data/ apk/ site/ scout/ 这些契约与其它产品线的键，后台碰不到。
//   3. 字节先进 staging，发布由 Actions 逐字节核对 sha256 之后才落到对外键。
// 第 3 条为什么要绕一圈：最终键一旦被引用就是玩家会下载的地址，把未经核对的半成品直接放上去，
// 等于把「上传中断」变成「线上坏文件」。

/** 后台能写的键前缀。其它一律拒绝。 */
export const UPLOAD_PREFIXES = ['assets/', 'fonts/', 'packs/'];

/**
 * 扩展名白名单（不是黑名单）。
 *
 * 这个桶的自定义域名对全世界发 ACAO `*`，放一个 .html/.svg/.js 上去就是在自己的域名上开一个
 * 可执行内容位（SVG 能带脚本）。素材面不需要那种东西，所以默认拒绝、按名单放行。
 */
export const UPLOAD_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'atlas', 'skel', 'json', 'txt',
  'mp3', 'ogg', 'wav', 'm4a',
  'woff', 'woff2', 'ttf', 'otf',
  'zip', 'bin', 'data', 'xml',
]);

export const LOG_KEY = 'cdn/v1/upload-log.json';
export const HOSTED_INDEX_KEY = 'cdn/v1/hosted-index.json';
export const LOG_SCHEMA = 1;
export const CLAIM_SCHEMA = 1;

/** staging 前缀：在 OWNED_PREFIXES 的 cdn/ 之下，prune 看不到它，契约也不引用它。 */
export const STAGING_PREFIX = 'cdn/incoming/';

const BAD_CHARS = /[\uFFFD\u0000-\u001F\u007F]/;
const encoder = new TextEncoder();

const byteLength = (s) => encoder.encode(s).length;

export const nowIso = () => new Date().toISOString();

/** 键名规范化 + 全部规则检查。返回 { ok, key, reason }。 */
export function validateKey(rawKey) {
  if (typeof rawKey !== 'string' || !rawKey) return { ok: false, reason: 'key 必须是字符串' };
  const key = rawKey.trim().replace(/^\/+/, '');
  if (!key) return { ok: false, reason: 'key 为空' };
  if (key.includes('..') || key.includes('//') || key.includes('\\')) return { ok: false, reason: 'key 含 .. 、// 或反斜杠' };
  if (BAD_CHARS.test(key)) return { ok: false, reason: 'key 含控制字符或替换符' };
  if (byteLength(key) > 1024) return { ok: false, reason: 'key 超过 1024 字节（R2 键长上限）' };
  if (!UPLOAD_PREFIXES.some((p) => key.startsWith(p))) {
    return { ok: false, reason: `key 必须在 ${UPLOAD_PREFIXES.join(' / ')} 之下（契约与其它产品线不走后台）` };
  }
  const ext = (key.split('.').pop() || '').toLowerCase();
  if (!UPLOAD_EXTENSIONS.has(ext)) return { ok: false, reason: `不允许的扩展名 .${ext}` };
  return { ok: true, key };
}

/** 自述文字：限长、去控制字符。乱码标题会直接出现在浏览面上，所以这里就挡掉。 */
export function cleanNote(raw, max = 120) {
  if (typeof raw !== 'string') return '';
  return raw.replace(BAD_CHARS, '').trim().slice(0, max);
}

/** 来源标识：它会成为 hosted.json 的分组 id，也是「这批字节是谁的」的唯一答案。 */
export function cleanSource(raw) {
  const s = cleanNote(raw, 60);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,59}$/.test(s)) {
    return { ok: false, reason: 'source 需要是 2–60 位的字母数字 . _ - （它会成为 hosted.json 的分组 id）' };
  }
  return { ok: true, source: s };
}

export function validateSha(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'sha256 必须是字符串' };
  const s = raw.trim().toLowerCase().replace(/^sha256[:_-]/i, '');
  if (!/^[0-9a-f]{64}$/.test(s)) return { ok: false, reason: 'sha256 需要是 64 位十六进制' };
  return { ok: true, sha256: s };
}

export function validateSize(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return { ok: false, reason: 'size 需要是正整数（字节）' };
  // 5 GiB 是 R2 单次 PUT 的上限。本通道用一次 presigned PUT 传，超过就该分片，而分片不在这一版。
  if (n > 5 * 1024 ** 3) return { ok: false, reason: 'size 超过单次 PUT 的 5 GiB 上限（需要分片上传）' };
  return { ok: true, size: n };
}

/** staging 键：每次上传一个独立对象，避免同一目标键的并发上传互相踩。 */
export function stagingKeyFor(id, key) {
  return `${STAGING_PREFIX}${id}/${key.split('/').pop()}`;
}

/** 领取单：与 payload 同目录的另一张小对象，是「这一份声明完了」的唯一凭据。 */
export function claimKeyFor(id) {
  return `${STAGING_PREFIX}${id}/claim.json`;
}

/**
 * 撤销请求的前缀。放在暂存区之外：撤销不是「一次上传」，混在 cdn/incoming/ 里
 * 会让发布轮把「要上线的」和「要下线的」当成同一批事务处理。
 */
export const REMOVAL_PREFIX = 'cdn/removals/';

export function removalKeyFor(id) {
  return `${REMOVAL_PREFIX}${id}.json`;
}

/** 撤销请求的判定：只允许删「后台自己上线、且现在没人引用」的键。 */
export function removalVerdict(rawKey, { logged, inUpstreamIndex, referenced, exists }) {
  const k = validateKey(rawKey);
  if (!k.ok) return { ok: false, reason: k.reason };
  const key = k.key;
  if (!exists) return { ok: false, reason: `键 ${key} 在桶里不存在，无需撤销`, key };
  if (!logged) return { ok: false, reason: `撤销只针对后台上线过的文件（要在 upload-log.json 里）；${key} 不是这条通道上线的`, key };
  if (inUpstreamIndex) return { ok: false, reason: `${key} 在上游素材清单里，属于镜像内容，后台无权删`, key };
  if (referenced) return { ok: false, reason: `${key} 仍被线上契约引用（${referenced}），删了会静默 404`, key };
  return { ok: true, key };
}

/**
 * 从 hosted.json 里摘掉这些键（mergeHosted 的反向）。
 * 分组被清空时整组删掉 —— 留一个 files:0 的空组，只会让下一个人以为还有内容受保护。
 */
export function removeKeysFromHosted(doc, keys) {
  const drop = new Set(keys);
  const out = [];
  let removed = 0;
  let emptied = 0;
  for (const entry of doc?.hosted || []) {
    const kept = (entry.keys || []).filter((row) => !drop.has(Array.isArray(row) ? row[0] : row));
    const gone = (entry.keys || []).length - kept.length;
    if (gone) removed += gone;
    if (!kept.length) {
      emptied++;
      continue;
    }
    out.push({
      ...entry,
      keys: kept,
      files: kept.length,
      bytes: kept.reduce((a, row) => a + (Array.isArray(row) ? Number(row[1]) || 0 : 0), 0),
    });
  }
  return { doc: { ...doc, hosted: out }, removed, emptied };
}

/** 被引用的键集合：上游 index、APK 素材包清单、以及三张客户端清单里出现过的路径。 */
export function collectReferences({ indexFiles, packKeys, manifestTexts = [] }) {
  const refs = new Set();
  for (const key of Object.keys(indexFiles || {})) refs.add(key);
  for (const key of packKeys || []) refs.add(key);
  for (const text of manifestTexts) {
    if (typeof text !== 'string') continue;
    for (const m of text.matchAll(/(?:assets|fonts|packs)\/[\w.\-\/%]+/g)) {
      refs.add(decodeURIComponent(m[0]));
    }
  }
  return refs;
}

/** 新上传 id：随机串由调用方注入（测试要确定性），这里只做形状约束。 */
export function makeId(randomHex) {
  const hex = String(randomHex());
  if (!/^[0-9a-f]{12,32}$/.test(hex)) throw new Error('makeId 需要一个 12–32 位十六进制的随机串');
  return hex.toLowerCase().slice(0, 24);
}

/**
 * 把 ListObjectsV2 的行归并成「每个上传一份待办」。
 *
 * 待办从一个共享队列文件改成 claim 小对象，是因为多个上传同时读-改-写同一个 JSON 会互相盖掉
 * （这条清单在 dl-site 那边真实翻过车）。列前缀是强一致的，没有共享可变量就没有丢更新。
 * @param {{key:string,size:number}[]} rows
 */
export function claimsFromListing(rows) {
  const byId = new Map();
  for (const row of rows || []) {
    if (!row || typeof row.key !== 'string' || !row.key.startsWith(STAGING_PREFIX)) continue;
    const rest = row.key.slice(STAGING_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash < 0) continue;
    const id = rest.slice(0, slash);
    const name = rest.slice(slash + 1);
    const entry = byId.get(id) || { id, payload: null, claim: null, junk: [] };
    if (name === 'claim.json') entry.claim = { key: row.key, size: row.size };
    else if (name.startsWith('_')) entry.junk.push(row.key); // 自检残留之类的下划线键，不当事务对象
    else entry.payload = { key: row.key, size: row.size };
    byId.set(id, entry);
  }
  return [...byId.values()];
}

/** 一份 claim 够不够格进发布流程。返回 { ok, reason }。 */
export function claimIsPublishable(claim, { payloadSize } = {}) {
  if (!claim || typeof claim !== 'object') return { ok: false, reason: '没有 claim 对象' };
  if (claim.schema !== CLAIM_SCHEMA) return { ok: false, reason: `claim schema=${claim.schema} 不认识` };
  const k = validateKey(claim.key);
  if (!k.ok) return { ok: false, reason: k.reason };
  if (k.key !== claim.key) return { ok: false, reason: 'claim.key 与规范化结果不一致（不应发生）' };
  const s = validateSha(claim.sha256);
  if (!s.ok) return { ok: false, reason: s.reason };
  const z = validateSize(claim.size);
  if (!z.ok) return { ok: false, reason: z.reason };
  if (Number.isFinite(payloadSize) && payloadSize !== z.size) {
    return { ok: false, reason: `staging 大小 ${payloadSize} 与 claim 声明 ${z.size} 不符` };
  }
  if (claim.state !== 'verified-at-edge' && claim.state !== 'queued') {
    return { ok: false, reason: `claim 状态 ${claim.state} 不该出现在待办里` };
  }
  return { ok: true };
}

export function emptyLog() {
  return { schema: LOG_SCHEMA, updatedAt: nowIso(), items: [] };
}

/** 发布日志：新条目放最前，只留 keep 条。由 Actions 单方面写，所以没有并发问题。 */
export function appendToLog(log, entry, { keep = 60 } = {}) {
  const items = [entry, ...(Array.isArray(log?.items) ? log.items : [])].slice(0, keep);
  return { schema: LOG_SCHEMA, updatedAt: nowIso(), items };
}

/**
 * hosted.json 分组。后台上传的字节必须在这里登记，否则两件事会发生：
 * prune 把它们当镜像残渣删掉（hosted.json 存在的意义正是挡这件事），
 * 以及浏览面 tree.json 不把它们的目录算进去 —— 「我传上去了吗」就没有答案。
 */
export function hostedGroupFor({ source, what, addedAt, keysWithSizes }) {
  const bytes = keysWithSizes.reduce((a, row) => a + (Number(row[1]) || 0), 0);
  return {
    id: source,
    what,
    addedAt,
    source: 'admin upload（只增不删；撤销请改本文件走 review）',
    files: keysWithSizes.length,
    bytes,
    keys: keysWithSizes.map((row) => [row[0], Number(row[1])]),
  };
}

/** 并进 hosted.json：同 id 合并键集（按 key 去重），新 id 追加。只增不删。 */
export function mergeHosted(doc, group) {
  const entries = Array.isArray(doc?.hosted) ? doc.hosted.slice() : [];
  const at = entries.findIndex((e) => e && e.id === group.id);
  if (at < 0) return { doc: { ...doc, hosted: [...entries, group] }, added: group.keys.length, replaced: 0 };

  const prev = entries[at];
  const map = new Map((prev.keys || []).map((k) => (Array.isArray(k) ? [k[0], k[1]] : [k, null])));
  let added = 0;
  let replaced = 0;
  for (const [key, size] of group.keys) {
    if (map.has(key)) replaced++;
    else added++;
    map.set(key, size);
  }
  const merged = {
    ...prev,
    ...group,
    what: group.what || prev.what,
    files: map.size,
    bytes: [...map.values()].reduce((a, s) => a + (Number(s) || 0), 0),
    keys: [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((row) => [row[0], row[1]]),
  };
  entries[at] = merged;
  return { doc: { ...doc, hosted: entries }, added, replaced };
}

/**
 * hosted-index.json：给托管字节补摘要。
 * index.json 刻意保持「等于上游树」，否则「CDN 是否完整」这个问题就答不出来；
 * 所以后台的字节走这张单独的表，浏览面仍然由 tree.json 统一呈现（mod=1）。
 */
export function buildHostedIndex(bySource) {
  const files = {};
  for (const [source, rows] of Object.entries(bySource)) {
    for (const row of rows) files[row.key] = { size: Number(row.size), sha256: row.sha256, source };
  }
  const sorted = {};
  for (const key of Object.keys(files).sort()) sorted[key] = files[key];
  const doc = {
    schema: 1,
    updatedAt: nowIso(),
    _how: '后台上传、不在上游 index.json 里的字节；sha256 由 Actions 发布前逐字节算出。目录浏览看 /cdn/v1/tree.json，mod=1 的条目来源于此。',
    totals: { files: Object.keys(sorted).length, bytes: Object.values(sorted).reduce((a, v) => a + v.size, 0) },
    files: sorted,
  };
  return { doc, json: `${JSON.stringify(doc, null, 2)}\n` };
}
