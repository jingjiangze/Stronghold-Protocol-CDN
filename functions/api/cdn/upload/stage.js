// GET /api/cdn/upload/stage —— 暂存区的「只读精简视图」，给 /stage 页面与脚本用。
//
// 为什么不是直接复用 status：status 是后台页面的数据源，为了画两棵树（暂存区 + 最近发布 20 条）
// 和几个计数，它把发布日志、撤销请求、每个 claim.json 的内文全取回来。对「暂存区里到底有什么」
// 这一个问题来说这是三到四倍的字节和十几次额外往返，而且其中一半只有在页面上看才需要
// （contentType、link 用的 cdnBase、deletes 说明）。
//
// 这里只回答那一个问题：列一遍 staging 前缀，有 claim 的读它，按目标键成组，加上一句人话说明。
// 没有日志、没有撤销、没有 hosted/cdnBase 那些只服务于「上传完同步到哪」的字段。
//
// 鉴权与同源和 status 完全一致（这个接口同样会泄露上传方的键名与来源，不能给公共缓存）。
import { r2Config, s3fetch } from './_edge.js';
import { checkAuth, deny, json, sameOriginOrNone } from './_http.js';
import { STAGING_PREFIX, claimsFromListing } from '../../../../src/upload.mjs';

function fmtSize(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return '0 B';
  if (x >= 1048576) return `${(x / 1048576).toFixed(1)} MiB`;
  if (x >= 1024) return `${(x / 1024).toFixed(1)} KiB`;
  return `${x} B`;
}

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
  const items = [];
  for (const g of groups) {
    const base = { id: g.id, stagedSize: g.payload?.size ?? null, junk: g.junk.length };
    if (!g.claim) {
      // 和 status 同一套口径（缺 claim 的组永远不会上线），但这里不贴那么长的解释 ——
      // 精简页要的是「一眼扫完」，完整的那句在 /admin。
      items.push({
        ...base,
        state: 'awaiting-commit',
        reason: g.payload
          ? `字节已传（${fmtSize(g.payload.size)}）但没有 claim：没点「提交 / commit」，发布轮会跳过这一组`
          : '暂存区只有残留对象（没有字节也没有 claim），多半是中断的上传',
      });
      continue;
    }
    let claim = null;
    try {
      const r = await s3fetch(cfg, 'GET', g.claim.key);
      if (r.ok) claim = await r.json();
    } catch {
      claim = null;
    }
    if (!claim) {
      items.push({ ...base, state: 'claim-unreadable', reason: 'claim.json 读不到（内容不是合法 JSON）' });
      continue;
    }
    items.push({
      ...base,
      state: claim.state,
      key: claim.key || null,
      size: claim.size ?? null,
      sha256: claim.sha256 || null,
      source: claim.source || null,
      what: claim.what || null,
      claimedAt: claim.claimedAt || null,
      releasedAt: claim.releasedAt || null,
    });
  }

  return json({
    ok: true,
    staging: items,
    // 这两个计数就是 /stage 上那一行摘要；不给日志和撤销，那边不需要。
    pending: items.filter((i) => i.state !== 'awaiting-commit' && i.state !== 'claim-unreadable').length,
    awaitingCommit: items.filter((i) => i.state === 'awaiting-commit').length,
    bytes: items.reduce((s, i) => s + (i.size || i.stagedSize || 0), 0),
    // 让读者一眼知道这份清单是多久前的，而不是猜「是不是刷一下就又变了」。
    at: new Date().toISOString(),
    note: '这一页只读暂存区；上传与发布按钮在 /admin（同一个站点、同一个口令）。',
  });
}

export function onRequestOptions() {
  return deny('这个端点不接受跨源调用', 405);
}
