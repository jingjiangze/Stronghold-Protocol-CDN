// DELETE /api/cdn/upload/staging?id=<上传 id> —— 立刻清掉一次「还没上线」的上传。
//
// 暂存区里的字节对外没有任何用处：没有任何清单引用它，删掉不影响任何玩家。留着反而占额度，
// 一次失败的上传还可能被误当成「已交付」。所以这条路是真删，不走发布轮。
// 边界只有一条：只准动 cdn/incoming/<id>/ 这一个目录，id 必须是 begin 发的那种十六进制串 ——
// 拼出来的前缀里不许有 '/'、'..' 或空值，免得把一个删除请求变成「清空整个桶」的入口。
import { r2Config, s3fetch } from './_edge.js';
import { checkAuth, deny, json, sameOriginOrNone } from './_http.js';
import { STAGING_PREFIX } from '../../../../src/upload.mjs';

async function listUnder(cfg, prefix) {
  const q = `list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}`;
  const res = await s3fetch(cfg, 'GET', null, { query: q });
  if (!res.ok) throw new Error(`列暂存失败：HTTP ${res.status}`);
  const xml = await res.text();
  const rows = [...xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)];
  return rows.map((m) => ({ key: m[1], size: Number(m[2]) }));
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const originProblem = sameOriginOrNone(request);
  if (originProblem) return deny(originProblem, 403);
  const authProblem = checkAuth(request, env);
  if (authProblem) return deny(authProblem, 401);

  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^[0-9a-f]{12,24}$/.test(id)) return deny('id 需要是 begin 返回的十六进制串', 400);

  let cfg;
  try {
    cfg = r2Config(env);
  } catch (e) {
    return deny(`后台未配置好 R2：${e.message}`, 500);
  }

  const prefix = `${STAGING_PREFIX}${id}/`;
  let rows;
  try {
    rows = await listUnder(cfg, prefix);
  } catch (e) {
    return deny(e.message, 502);
  }
  if (!rows.length) return deny(`暂存区里没有 ${id} 这一组（可能已经发布了）`, 404);

  const freed = rows.reduce((a, r) => a + r.size, 0);
  const failed = [];
  for (const row of rows) {
    if (!row.key.startsWith(prefix)) {
      failed.push(`${row.key}（越界，拒绝删）`);
      continue;
    }
    const res = await s3fetch(cfg, 'DELETE', row.key);
    // S3 删除成功回 204；404 说明被别人抢先删了，同样算达成
    if (!res.ok && res.status !== 404) failed.push(`${row.key}（HTTP ${res.status}）`);
  }
  if (failed.length) return deny(`部分没删掉：${failed.join('; ')}`, 502, { id });

  return json({ ok: true, id, deleted: rows.length, freed, message: '暂存区已清空这一组，未占用对外地址' });
}

export function onRequestOptions() {
  return deny('这个端点不接受跨源调用', 405);
}
