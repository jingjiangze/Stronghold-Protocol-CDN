// GET /api/cdn/upload/status —— 后台与 agent 的「我这批到哪一步了」。
// 读的是事实而不是缓存：staging 前缀列一遍（S3 列举强一致）+ 发布日志尾部。
import { r2Config, s3fetch } from './_edge.js';
import { checkAuth, deny, json, sameOriginOrNone } from './_http.js';
import { LOG_KEY, REMOVAL_PREFIX, STAGING_PREFIX, claimsFromListing } from '../../../../src/upload.mjs';

// 与 r2.mjs 的 mimeFor 同源：这里只用于把 claim 里的键显示成人类认得出的类型。
const TYPE_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', json: 'application/json', txt: 'text/plain', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', zip: 'application/zip', bin: 'application/octet-stream' };

// 与前端共用的轻量体积格式（这里不依赖前端代码，避免跨层耦合）。仅用于状态里的人类可读说明。
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
      // 「只传了字节、没提交」—— 明确说清为什么它永远上不了线，免得管理员对着一排同名行猜原因。
      // 这里不 HEAD 最终键：awaiting-commit 的组根本没落地最终键（claim 没写，publisher 不碰它），
      // 所以「重复」不是这一态的成因；真正的重复会在 commit/put 时以 409 当场拒绝。这一态的唯一成因是
      // 字节进了暂存区、却没点 commit（begin + presigned PUT 那条路），于是 publisher 按设计跳过。
      const reason = g.payload
        ? `字节已传（${fmtSize(g.payload.size)}）但缺少 claim：没点「提交 / commit」。发布轮只处理有 claim 的组，所以这组的字节永远不会上线、也不会被任何清单引用 —— 清暂存即可，对外地址零影响。`
        : `暂存区只有残留对象（没有字节也没有 claim），多半是中断的上传或自检残留 —— 清掉不影响任何对外地址。`;
      items.push({ ...base, state: 'awaiting-commit', reason });
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

  // 待处理的撤销请求：让页面能显示「已提交撤销、等发布轮」，而不是让人以为按钮没生效。
  let removals = [];
  try {
    const rq = `list-type=2&max-keys=1000&prefix=${encodeURIComponent(REMOVAL_PREFIX)}`;
    const rr = await s3fetch(cfg, 'GET', null, { query: rq });
    if (rr.ok) {
      const xml = await rr.text();
      for (const m of xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<\/Contents>/g)) {
        try {
          const one = await s3fetch(cfg, 'GET', m[1]);
          if (one.ok) {
            const doc = await one.json();
            removals.push({ id: doc.id, key: doc.key, requestedAt: doc.requestedAt, reason: doc.reason });
          }
        } catch {
          removals.push({ key: m[1], requestedAt: null, reason: '（读不到请求内容）' });
        }
      }
    }
  } catch {
    removals = [];
  }

  const CDN_BASE = 'https://weishucdn.jiangjiangze.icu';
  const linkable = (key) => (key ? `${CDN_BASE}/${String(key).split('/').map(encodeURIComponent).join('/')}` : null);
  for (const item of items) item.url = linkable(item.key || item.stagingKey);
  for (const entry of log.items || []) entry.url = linkable(entry.key);

  return json({
    ok: true,
    cdnBase: CDN_BASE,
    staging: items,
    pending: items.filter((i) => i.hasClaim).length,
    awaitingCommit: items.filter((i) => !i.hasClaim).length,
    removals,
    log: (log.items || []).slice(0, 20),
    hostedIndex: '/cdn/v1/hosted-index.json',
    tree: '/cdn/v1/tree.json',
    // 文档路径不写死在这里：索引由部署生成，接入说明是「索引里提到上传通道的最新一份」。
    // 以前这里返回一个固定路径，改文档名就会静默指向不存在的地方。
    docsIndex: '/data/docs.json',
    agentDoc: '/api/cdn/upload/agent-doc',
    deletes: {
      staging: 'DELETE /api/cdn/upload/staging?id=<上传 id>（立刻生效）',
      published: 'POST /api/cdn/upload/remove {key}（发布轮核对无引用后才真删）',
      cli: 'node tools/agent-upload.mjs --purge=<上传 id> | --rm=<键> [--yes]',
      note: '删除只走 agent 通道，后台页面上没有按钮 —— 一次误点就会拿掉对外正被引用的字节。',
    },
  });
}

export function onRequestOptions() {
  return deny('这个端点不接受跨源调用', 405);
}
