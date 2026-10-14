// POST /api/cdn/upload/release —— 人工审计放行一张「非静态素材」的待办。
//
// 后台默认只把静态素材发到对外键（判据 = 格式 + 落点，见 src/upload.mjs 的 formatVerdict）。
// zip 包、mod 清单、元数据 JSON 这一类会收进暂存区但不上线。要上线就得有人明确放行一次：
// 这一步是「我看过了，这份东西该出现在玩家会下载的域名上」的凭据，所以它单向、一次性、留痕。
//
// 这里只写 claim，不搬字节 —— 落对外键仍然由发布轮逐字节核对 sha256 之后做，
// 和直发那条路是同一套验收，放行不等于降低标准。
import { claimKeyFor, formatVerdict, releaseClaim, validateSize } from '../../../../src/upload.mjs';
import { headKey, readJson, r2Config, s3fetch } from './_edge.js';
import { actorHash, checkAuth, deny, json, readBody, sameOriginOrNone, triggerPublish } from './_http.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  const originProblem = sameOriginOrNone(request);
  if (originProblem) return deny(originProblem, 403);
  const authProblem = checkAuth(request, env);
  if (authProblem) return deny(authProblem, 401);

  const { doc, error } = await readBody(request);
  if (error) return deny(error, 400);

  const id = String(doc.id || '').trim();
  if (!/^[0-9a-f]{12,24}$/.test(id)) return deny('id 需要是 begin/commit 返回的十六进制串', 400);

  let cfg;
  try {
    cfg = r2Config(env);
  } catch (e) {
    return deny(`后台未配置好 R2：${e.message}`, 500);
  }

  let claim = null;
  try {
    claim = await readJson(cfg, claimKeyFor(id));
  } catch (e) {
    return deny(`读领取单失败：${e.message}`, 502);
  }
  if (!claim) return deny(`没有 ${id} 这张领取单 —— 它还没 commit，或者已经被发布轮处理掉了`, 404, { id });

  // 已经不在待审状态的两件事要分开说：静态素材本来就会自己上线；已上线的没有可放行的了。
  const fmt = formatVerdict(claim.key);
  if (fmt.tier !== 'hold') {
    return deny('这一份是静态素材，发布轮本来就会直接上线，不需要放行', 200, { id, key: claim.key, tier: fmt.tier });
  }

  // 放行之前确认字节还在：暂存区被清过（或发布轮已经删掉）的话，放行只会得到一张永远发不出去的单子。
  let staged;
  try {
    staged = await headKey(cfg, claim.stagingKey || '');
  } catch (e) {
    return deny(`检查暂存字节失败：${e.message}`, 502);
  }
  if (!staged.exists) {
    return deny('暂存区里已经没有这份字节了（被清理或已发布）—— 要上线请重新上传一次', 409, { id, key: claim.key, stagingKey: claim.stagingKey });
  }
  const z = validateSize(staged.size);
  if (!z.ok || z.size !== Number(claim.size)) {
    return deny(`暂存字节 ${staged.size} 与领取单声明 ${claim.size} 不符，不放行`, 412, { id, key: claim.key });
  }

  const out = releaseClaim(claim, { note: doc.note || doc.reason || '', actor: actorHash(request) });
  if (!out.ok) return deny(out.reason, 409, { id, key: claim.key, releasedAt: claim.releasedAt || null });

  const put = await s3fetch(cfg, 'PUT', claimKeyFor(id), {
    body: `${JSON.stringify(out.claim, null, 2)}\n`,
    extraHeaders: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  if (!put.ok) return deny(`写回领取单失败：HTTP ${put.status}`, 502);

  // 放行就是要马上落地，所以叫一轮；叫不动也照实说（定时兜底仍在）。
  const trigger = await triggerPublish(env);

  return json({
    ok: true,
    id,
    key: claim.key,
    size: staged.size,
    tier: 'hold',
    releasedAt: out.claim.releasedAt,
    dispatched: trigger.dispatched,
    message: trigger.dispatched
      ? '已放行，发布轮会逐字节核对 sha256 后落到对外键'
      : `已放行，但这次叫不动发布轮（${trigger.reason}）—— 等定时兜底，或点「催一次发布」`,
  }, 202);
}

export function onRequestOptions() {
  return deny('这个端点不接受跨源调用', 405);
}
