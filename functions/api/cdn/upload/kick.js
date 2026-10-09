// POST /api/cdn/upload/kick —— 手动催一次发布轮（页面上的「催一次发布」，agent 的 --kick）。
// 触发逻辑与 commit/put/remove 用的是同一个 helper：一处配错，四处都要能看出来，而不是只有这里能发。
import { checkAuth, deny, json, sameOriginOrNone, triggerPublish } from './_http.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const originProblem = sameOriginOrNone(request);
  if (originProblem) return deny(originProblem, 403);
  const authProblem = checkAuth(request, env);
  if (authProblem) return deny(authProblem, 401);

  const out = await triggerPublish(env);
  if (out.dispatched) {
    return json({ ok: true, dispatched: true, message: '已叫起一次发布，约 1–2 分钟后再看状态' });
  }
  if (!out.status) return deny(`叫不动发布轮：${out.reason}（需要 Pages secret GH_DISPATCH_TOKEN 与 GH_REPO）`, 202, { dispatched: false });
  if (out.status === 401 || out.status === 403) return deny(`GitHub 拒绝了这个口令（${out.reason}）：需要对本仓有 actions:write`, 502, { dispatched: false });
  return deny(`dispatch 失败：${out.reason}`, 502, { dispatched: false });
}

export function onRequestOptions() {
  return deny('这个端点不接受跨源调用', 405);
}
