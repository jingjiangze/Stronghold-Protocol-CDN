// POST /api/cdn/upload/remove —— 提交一条撤销请求（下线后台自己上线过的文件）。
//
// 边缘只做「这条是不是后台上线的」这一件便宜的事（读 upload-log.json，几十 KB），
// 权威判定在发布轮：那里才拿得到上游 index.json（1.7 MB）与 APK 素材包清单，
// 也才改得动 git 里的 hosted.json。在这里假装判过，等于给一个「看起来安全」的空壳。
import { headKey, r2Config, readJson, s3fetch } from './_edge.js';
import { actorHash, checkAuth, deny, json, readBody, sameOriginOrNone } from './_http.js';
import { LOG_KEY, cleanNote, removalKeyFor, validateKey } from '../../../../src/upload.mjs';

export async function onRequestPost(context) {
  const { request, env } = context;
  const originProblem = sameOriginOrNone(request);
  if (originProblem) return deny(originProblem, 403);
  const authProblem = checkAuth(request, env);
  if (authProblem) return deny(authProblem, 401);

  const { doc, error } = await readBody(request);
  if (error) return deny(error, 400);

  const k = validateKey(doc.key);
  if (!k.ok) return deny(k.reason, 400);

  let cfg;
  try {
    cfg = r2Config(env);
  } catch (e) {
    return deny(`后台未配置好 R2：${e.message}`, 500);
  }

  let log = null;
  try {
    log = await readJson(cfg, LOG_KEY);
  } catch (e) {
    return deny(`读发布日志失败：${e.message}`, 502);
  }
  const entries = Array.isArray(log?.items) ? log.items : [];
  const published = entries.find((item) => item && item.key === k.key);
  if (!published) {
    return deny('撤销只针对后台上线过的文件。上游镜像件与 APK 素材包不在这条通道里，删不掉（也不该由这里删）。', 403, { key: k.key });
  }

  let head;
  try {
    head = await headKey(cfg, k.key);
  } catch (e) {
    return deny(`检查键失败：${e.message}`, 502);
  }
  if (!head.exists) {
    return deny(`键 ${k.key} 在桶里已经不在了，无需撤销`, 409);
  }

  const id = crypto.getRandomValues(new Uint8Array(12)).reduce((a, b) => a + b.toString(16).padStart(2, '0'), '');
  const request0 = {
    schema: 1,
    id,
    key: k.key,
    publishedAt: published.at,
    publishedSha256: published.sha256,
    publishedSource: published.source,
    reason: cleanNote(doc.reason || '', 160),
    state: 'requested',
    requestedAt: new Date().toISOString(),
    ...actorHash(request),
  };
  const put = await s3fetch(cfg, 'PUT', removalKeyFor(id), {
    body: `${JSON.stringify(request0, null, 2)}\n`,
    extraHeaders: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  if (!put.ok) return deny(`写撤销请求失败：HTTP ${put.status}`, 502);

  // 撤销也走触发式：点了下线却还要等定时轮，看起来就跟"没反应"一样（这就是 2026-10-10 那个反馈）。
  const trigger = await triggerPublish(env);

  return json(
    {
      ok: true,
      id,
      key: k.key,
      state: 'requested',
      dispatched: trigger.dispatched,
      message: trigger.dispatched
        ? '撤销请求已入队并已叫起发布轮：核对「不在上游素材清单、且没有任何线上清单引用」后真删，并同步摘掉 hosted.json 的登记。'
        : `撤销请求已入队，但叫不动发布轮（${trigger.reason}）—— 下一次定时兜底会处理；也可以在后台点「催一次发布」。`,
    },
    202,
  );
}

export function onRequestOptions() {
  return deny('这个端点不接受跨源调用', 405);
}
