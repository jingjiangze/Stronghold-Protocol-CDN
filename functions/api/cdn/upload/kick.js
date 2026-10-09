// POST /api/cdn/upload/kick —— 让人类界面和 agent 都能催一次发布，而不是等定时轮。
// 这里只做一件事：用 Pages secret 里的口令去 dispatch 那个 workflow。搬字节与核对摘要在 Actions 里。
// 没配 GH_DISPATCH_TOKEN 就明确说「催不动」，让调用方知道自己在等定时任务，而不是以为已经上线了。
import { checkAuth, deny, json, sameOriginOrNone } from './_http.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const originProblem = sameOriginOrNone(request);
  if (originProblem) return deny(originProblem, 403);
  const authProblem = checkAuth(request, env);
  if (authProblem) return deny(authProblem, 401);

  if (!env.GH_DISPATCH_TOKEN || !env.GH_REPO) {
    return json({ ok: false, dispatched: false, error: '后台没配 GH_DISPATCH_TOKEN / GH_REPO，只能等发布定时轮（每 20 分钟）' }, 202);
  }

  const [owner, repo] = String(env.GH_REPO).split('/');
  if (!owner || !repo) return deny('GH_REPO 形状不对（要 owner/repo）', 500);

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/promote-uploads.yml/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      'content-type': 'application/json',
      'user-agent': 'stronghold-cdn-admin',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ ref: 'main' }),
  });

  if (res.status === 204) return json({ ok: true, dispatched: true, message: '已叫起一次发布，约 1–2 分钟后再看状态' });
  if (res.status === 401 || res.status === 403) return deny(`GitHub 拒绝了这个口令（HTTP ${res.status}）：需要对本仓有 actions:write`, 502);
  const text = (await res.text()).slice(0, 200);
  return deny(`dispatch 失败：HTTP ${res.status} ${text}`, 502);
}

export function onRequestOptions() {
  return deny('这个端点不接受跨源调用', 405);
}
