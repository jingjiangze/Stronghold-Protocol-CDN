// sync-mirrors.js — POST /api/cdn/upload/sync-mirrors
//
// 「同步到镜像源」：按依赖顺序把素材树推到 git 链下游（assets-raw → openi + 魔搭数据集 + git 挂载源）。
// 为什么做成手动按钮而不是每次 commit 都自动（2026-10-15 用户口径）：批量上传时一次提交叫一轮发布
// 会把 Actions 队列打爆（实测 5000 份上传 → 5000 次 workflow_dispatch，GitHub 开始取消别人的排队）。
// 现在：上传只写暂存区、不叫发布轮；要发布/同步时由人点一下。
//
// 顺序（硬依赖，不能并发乱序）：
//   1. promote-uploads.yml —— 把暂存区字节核对后落对外键 + hosted.json（必须先把 git-art-sync 要读的登记写好）
//   2. git-art-sync.yml --write=true —— R2 已上线字节补进 assets-raw 分支（下游三条链的中枢）
//   3. ①② 之外的镜像腿由 git-art 链尾自动派发（openi / dataset-tree / gitcdn 等）——
//      这里不再重复派发，避免双发（git-art 的收尾步只在 assets-raw 真前进时才链发）。
import { checkAuth, deny, json, sameOriginOrNone, triggerPublish } from './_http.js';

const GH = 'https://api.github.com';

/** 派发一个 workflow（需要本仓 actions:write）。 */
async function dispatch(env, file, inputs) {
  if (!env.GH_DISPATCH_TOKEN || !env.GH_REPO) {
    return { ok: false, reason: '未配置 GH_DISPATCH_TOKEN / GH_REPO' };
  }
  const [owner, repo] = String(env.GH_REPO).split('/');
  if (!owner || !repo) return { ok: false, reason: 'GH_REPO 形状不对（要 owner/repo）' };
  try {
    const res = await fetch(`${GH}/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        'content-type': 'application/json',
        'user-agent': 'stronghold-cdn-admin',
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main', ...(inputs ? { inputs } : {}) }),
    });
    if (res.status === 204) return { ok: true, file };
    return { ok: false, file, reason: `HTTP ${res.status} ${(await res.text()).slice(0, 120)}` };
  } catch (error) {
    return { ok: false, file, reason: String((error && error.message) || error) };
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const originProblem = sameOriginOrNone(request);
  if (originProblem) return deny(originProblem, 403);
  const authProblem = checkAuth(request, env);
  if (authProblem) return deny(authProblem, 401);

  const steps = [];
  // ① 发布轮：暂存 → 对外键 + hosted.json（上传完不叫它，只有这里叫）
  const pub = await triggerPublish(env);
  steps.push({ step: 'promote-uploads', ...pub });
  // ② git 链：R2 → assets-raw（下游 openi/数据集/挂载源的共同上游）
  const git = await dispatch(env, 'git-art-sync.yml', { write: true });
  steps.push({ step: 'git-art-sync', ...git });

  const anyOk = steps.some((s) => s.ok || s.dispatched);
  const allOk = steps.every((s) => s.ok || s.dispatched);
  return json({
    ok: allOk,
    dispatched: steps,
    message: allOk
      ? '已按顺序触发：发布轮 → git-art-sync（下游 openi / 魔搭数据集由 git-art 链尾自动跟进）。看 Actions 页约 2–20 分钟。'
      : anyOk
        ? '部分触发成功，失败项见 dispatched（多为 GitHub 抖动，可再点一次；点重是幂等的）'
        : '一个都没触发成功：检查 Pages secret GH_DISPATCH_TOKEN / GH_REPO',
  }, anyOk ? 202 : 502);
}

export function onRequestOptions() {
  return deny('这个端点不接受跨源调用', 405);
}
