// Pages Functions 侧的 R2 客户端：SigV4（header 鉴权）+ presigned PUT，只用 WebCrypto 与 fetch。
//
// 为什么不用 Pages 的 R2 绑定：
//   - 绑定不能签发 presigned URL，而 >100 MB 的素材只能让客户端直传桶的 S3 端点
//     （经 CF 代理的自定义域名单次请求体上限是 100 MB，Free/Pro 套餐都是这个数）；
//   - 绑定还要给 Pages 项目挂 R2 权限，多一道需要单独批准的配置。
// 所以这里只依赖四个环境变量（Pages secrets）：R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET。
// 密钥不进代码、不进日志，也不回给调用方 —— 调用方拿到的是 presigned URL，作用域只有一个键、15 分钟。
const REGION = 'auto';
const SERVICE = 's3';
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const enc = new TextEncoder();

const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data) {
  if (data === '' || data === null || data === undefined) return EMPTY_SHA;
  const bytes = typeof data === 'string' ? enc.encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export function r2Config(env) {
  const endpoint = env.R2_ENDPOINT || '';
  const host = String(endpoint).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const accessKeyId = env.R2_ACCESS_KEY_ID || '';
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY || '';
  const bucket = env.R2_BUCKET || 'stronghold-assets';
  if (!host || !accessKeyId || !secretAccessKey) throw new Error('R2 配置不全：需要 R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY');
  return { host, accessKeyId, secretAccessKey, bucket };
}

// SigV4 的百分号编码：只允许未保留字符与 '/'，其余按 UTF-8 逐字节编码。
// encodeURIComponent 会留下 !*'() —— 规范不允许，签出来就对不上。
function qencode(s) {
  return [...String(s)]
    .map((c) => {
      if (/[A-Za-z0-9\-._~]/.test(c)) return c;
      return [...enc.encode(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
    })
    .join('');
}

export const encodeKeyPath = (key) => key.split('/').map(qencode).join('/');

function canonicalQuerySorted(queryString) {
  if (!queryString) return '';
  return queryString
    .split('&')
    .filter(Boolean)
    .map((pair) => pair.split('='))
    .sort((a, b) => (a[0] === b[0] ? (a[1] || '') < (b[1] || '') ? -1 : 1 : a[0] < b[0] ? -1 : 1))
    .map((p) => `${p[0]}=${p[1] || ''}`)
    .join('&');
}

async function signingKey(secret, dateStamp) {
  let k = await hmac(enc.encode(`AWS4${secret}`), dateStamp);
  for (const part of [REGION, SERVICE, 'aws4_request']) k = await hmac(k, part);
  return k;
}

function amzStamps(now = new Date()) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: `${iso.slice(0, 15)}Z`, dateStamp: iso.slice(0, 8) };
}

/**
 * 给一次 S3 请求签名（header 鉴权）。
 * extraHeaders 里的头会一起进 SignedHeaders —— 内容类型与缓存头必须被保护，
 * 否则「签的是 A、发出去是 B」这种替换就没人挡得住。
 */
export async function signedHeaders(cfg, method, key, { query = '', bodyBytes = '', extraHeaders = {} } = {}) {
  const { amzDate, dateStamp } = amzStamps();
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const payloadHash = bodyBytes ? await sha256Hex(bodyBytes) : EMPTY_SHA;
  const all = {
    host: cfg.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), String(v)])),
  };
  const names = Object.keys(all).sort();
  // path-style：桶名永远是第一段，键名在其后。少写桶名会把键的第一段（assets / cdn）当成桶名，
  // 而 R2 对不存在的桶回 404 —— 看起来就像「这个键还不存在」，配置错误会伪装成空结果。
  const canonicalUri = `/${cfg.bucket}${key === null ? '' : `/${encodeKeyPath(key)}`}`;
  const canonicalHeaders = names.map((n) => `${n}:${String(all[n]).trim()}\n`).join('');
  const canonicalRequest = [method, canonicalUri, canonicalQuerySorted(query), canonicalHeaders, names.join(';'), payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const signature = hex(await hmac(await signingKey(cfg.secretAccessKey, dateStamp), stringToSign));
  const out = {
    ...all,
    Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
  return { headers: out, canonicalUri };
}

/** 只读/小对象读写用的 fetch 封装。状态码交给调用方判断，不在此处抛。 */
export async function s3fetch(cfg, method, key, { query = '', body = null, extraHeaders = {} } = {}) {
  const bodyBytes = body === null || body === undefined ? '' : body;
  const { headers, canonicalUri } = await signedHeaders(cfg, method, key, { query, bodyBytes, extraHeaders });
  // 直接用签名时那条 canonicalUri 拼 URL：两者必须是同一个字符串，否则签的路径与发的路径
  // 差一个斜杠就变成 SignatureDoesNotMatch，而这种错极难从响应里看出来。
  const uri = `https://${cfg.host}${canonicalUri}`;
  const res = await fetch(uri + (query ? `?${query}` : ''), {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : bodyBytes,
  });
  return res;
}

export async function readJson(cfg, key) {
  const res = await s3fetch(cfg, 'GET', key);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${key} → HTTP ${res.status}`);
  return res.json();
}

export async function writeJson(cfg, key, doc) {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  const res = await s3fetch(cfg, 'PUT', key, {
    body: text,
    extraHeaders: { 'content-type': 'application/json', 'cache-control': 'public, max-age=15' },
  });
  if (!res.ok) throw new Error(`PUT ${key} → HTTP ${res.status} ${await res.text()}`);
  return true;
}

/** 目标键是否已有对象 —— 「只增不改」的判据就靠它。返回 {exists, size}。 */
export async function headKey(cfg, key) {
  const res = await s3fetch(cfg, 'HEAD', key);
  if (res.status === 404) {
    // HEAD 没有响应体，分不清「键不存在」与「桶名/端点配错了」—— 后者会把「不存在」当成
    // 「还没人传过」，于是只增守卫永远放行。这里补一次桶级探测，把配错变成明确错误。
    const probe = await s3fetch(cfg, 'GET', null, { query: 'max-keys=0' });
    if (probe.status !== 200) {
      throw new Error(`桶 ${cfg.bucket} 在 ${cfg.host} 上不可用（HTTP ${probe.status}）—— 检查 R2_BUCKET / R2_ENDPOINT / 密钥`);
    }
    return { exists: false };
  }
  if (!res.ok) throw new Error(`HEAD ${key} → HTTP ${res.status}`);
  return { exists: true, size: Number(res.headers.get('content-length') || 0), etag: res.headers.get('etag') || '' };
}

/**
 * presigned PUT：客户端拿它把字节直接推到桶的 S3 端点，绕开经代理域名的 100 MB 请求体上限。
 * payload 用 UNSIGNED-PAYLOAD（浏览器算不出也不需要算），有效期 15 分钟，作用域只有一个键。
 *
 * 只签 host：客户端的 Content-Type 因此不进签名，可以被上传方自己填 —— 这里不靠它，
 * 最终键的 Content-Type 由 Actions 在 CopyObject 时按扩展名重新指定。
 */
export async function presignPut(cfg, key, { expiresSec = 900 } = {}) {
  const { amzDate, dateStamp } = amzStamps();
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSec),
    'X-Amz-SignedHeaders': 'host',
  };
  const query = Object.keys(params)
    .sort()
    .map((k) => `${qencode(k)}=${qencode(params[k])}`)
    .join('&');
  // path-style寻址：桶名是第一段，键名从第二段开始。少写桶名会把键的第一段（cdn）当桶名，
  // R2 回 NoSuchBucket —— 而在此之前先撞上的是凭证斜杠没编码导致的 SignatureDoesNotMatch。
  const canonicalUri = `/${cfg.bucket}/${encodeKeyPath(key)}`;
  const canonicalRequest = ['PUT', canonicalUri, query, `host:${cfg.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  // canonicalRequest 里那行 query 必须和最终 URL 上的一模一样，所以这里不再二次编码。
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const signature = hex(await hmac(await signingKey(cfg.secretAccessKey, dateStamp), stringToSign));
  return `https://${cfg.host}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
}

/** 定长时间比较：口令比较不走短路，免得用响应时间一项项试。 */
export function timingSafeEqual(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}
