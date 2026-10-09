// GET /api/cdn/upload/status —— 后台与 agent 的「我这批到哪一步了」。
// 读的是事实而不是缓存：staging 前缀列一遍（S3 列举强一致）+ 发布日志尾部。
import { r2Config, s3fetch } from './_edge.js';
import { checkAuth, deny, json, sameOriginOrNone } from './_http.js';
import { LOG_KEY, STAGING_PREFIX, claimsFromListing } from '../../../../src/upload.mjs';

// 与 r2.mjs 的 mimeFor 同源：这里只用于把 claim 里的键显示成人类认得出的类型。
const TYPE_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', json: 'application/json', txt: 'text/plain', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', zip: 'application/zip', bin: 'application/octet-stream' };

async function listStaging(cfg) {
  const q = `list-type=2&max-keys=1000&prefix=${encodeURIComponent(STAGING_PREFIX)}`;
  const res = await s3fetch(cfg, 'GET', null, { query: q });
  if (!res.ok) throw new Error(`列 staging 失败：HTTP ${res.status}`);
  const xml = await res.text();
  const rows = [...xml.matchAll(/<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>/g)].map((m) => ({ key: m[1], size: Number(m[2]) }));
  return rows;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const originProblem = sameOriginOrNone(request);
  if (originProblem) return deny(originProblem, 403);
  const authProblem = checkAuth(request, env);
  if (authProblem) return deny(authProblem, 401);

  let cfg;
  try {
    cfg = r2Config(env);
  } catch (e) {
    return deny(`后台未配置好 R2：${e.message}`, 500);
  }

  let rows;
  try {
    rows = await listStaging(cfg);
  } catch (e) {
    return deny(e.message, 502);
  }
  const groups = claimsFromListing(rows);

  // 只对「有 claim」的那一组再取 claim.json —— 只传了字节没点提交的，列出来但不读。
  const items = [];
  for (const g of groups) {
    const base = {
      id: g.id,
      stagingKey: g.payload?.key || null,
      stagedSize: g.payload?.size ?? null,
      hasClaim: Boolean(g.claim),
      junkKeys: g.junk,
    };
    if (!g.claim) {
      items.push({ ...base, state: 'awaiting-commit' });
      continue;
    }
    let claim = null;
    try {
      const r = await s3fetch(cfg, 'GET', g.claim.key);
      if (r.ok) claim = await r.json();
    } catch {
      claim = null;
    }
    items.push({
      ...base,
      state: claim ? claim.state : 'claim-unreadable',
      key: claim?.key || null,
      size: claim?.size ?? null,
      sha256: claim?.sha256 || null,
      source: claim?.source || null,
      what: claim?.what || null,
      claimedAt: claim?.claimedAt || null,
      contentType: claim ? TYPE_BY_EXT[(String(claim.key).split('.').pop() || '').toLowerCase()] || 'application/octet-stream' : null,
    });
  }

  let log = { items: [] };
  try {
    const r = await s3fetch(cfg, 'GET', LOG_KEY);
    if (r.ok) log = await r.json();
  } catch {
    // 第一次发布之前这张表还不存在，属于正常状态。
  }

  return json({
    ok: true,
    staging: items,
    pending: items.filter((i) => i.hasClaim).length,
    awaitingCommit: items.filter((i) => !i.hasClaim).length,
    log: (log.items || []).slice(0, 20),
    hostedIndex: '/cdn/v1/hosted-index.json',
    tree: '/cdn/v1/tree.json',
  });
}

export function onRequestOptions() {
  return deny('这个端点不接受跨源调用', 405);
}
