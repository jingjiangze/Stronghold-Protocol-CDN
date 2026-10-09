// PUT /api/cdn/upload/put —— 给浏览器用的一条式上传（元数据走请求头，body 就是文件本身）。
//
// 为什么不复用 begin+commit：那是 presigned 直传桶的 S3 端点，从浏览器打过去要先过 CORS 预检，
// 而给桶加 CORS 规则属于改共享基础设施。浏览器改走这条同源路径：一次请求就把字节和声明送到暂存区，
// 代价是吃经代理域名的 100 MB 请求体上限，所以这里把上限压到 64 MiB —— 更大的文件请用 agent 通道。
// 摘要不在边缘算（免费档每次调用 10 ms CPU，算不动几十 MB），状态留 queued，由发布机逐字节核对。
import { headKey, r2Config, s3fetch, sha256Hex } from './_edge.js';
import { actorHash, checkAuth, deny, json, sameOriginOrNone, triggerPublish } from './_http.js';
import { claimKeyFor, cleanNote, cleanSource, makeId, stagingKeyFor, validateKey, validateSha, validateSize } from '../../../../src/upload.mjs';

const MAX_BODY = 64 * 1024 * 1024;

export async function onRequestPut(context) {
  const { request, env } = context;
  const originProblem = sameOriginOrNone(request);
  if (originProblem) return deny(originProblem, 403);
  const authProblem = checkAuth(request, env);
  if (authProblem) return deny(authProblem, 401);

  // 元数据走查询串，不走请求头：HTTP 头只允许 ISO-8859-1，而「这批是什么」是中文的 ——
  // 用 header 传会在浏览器里直接抛异常，还是个跟业务无关的错。
  const q = new URL(request.url).searchParams;
  const declaredKey = q.get('key') || '';
  const declaredSha = q.get('sha256') || '';
  const declaredSize = q.get('size') || '';
  const rawSource = q.get('source') || '';
  const what = cleanNote(q.get('what') || '', 200);

  const k = validateKey(declaredKey);
  if (!k.ok) return deny(k.reason, 400);
  const s = validateSha(declaredSha);
  if (!s.ok) return deny(s.reason, 400);
  const z = validateSize(declaredSize);
  if (!z.ok) return deny(z.reason, 400);
  const src = cleanSource(rawSource);
  if (!src.ok) return deny(src.reason, 400);
  if (Number(z.size) > MAX_BODY) {
    return deny(`本页面单次上限 ${MAX_BODY / 1024 / 1024} MiB，${(z.size / 1048576).toFixed(1)} MiB 请用 tools/agent-upload.mjs（走 presigned 直传，不受这个限制）`, 413);
  }

  let cfg;
  try {
    cfg = r2Config(env);
  } catch (e) {
    return deny(`后台未配置好 R2：${e.message}`, 500);
  }

  // 只增：最终键已有对象就到此为止，字节都不收。
  const exists = await headKey(cfg, k.key);
  if (exists.exists) {
    return deny(`目标键已存在（${exists.size} 字节）。后台只能新增，不覆盖现网素材。`, 409, { key: k.key, currentSize: exists.size });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength !== Number(z.size)) {
    return deny(`收到 ${body.byteLength} 字节，与声明的 ${z.size} 不符 —— 未写入`, 412);
  }

  const id = makeId(() => crypto.getRandomValues(new Uint8Array(12)).reduce((a, b) => a + b.toString(16).padStart(2, '0'), ''));
  const stagingKey = stagingKeyFor(id, k.key);
  const put = await s3fetch(cfg, 'PUT', stagingKey, { body: new Uint8Array(body), extraHeaders: { 'content-type': 'application/octet-stream' } });
  if (!put.ok) return deny(`写暂存区失败：HTTP ${put.status} ${(await put.text()).slice(0, 160)}`, 502);

  // 64 MiB 以内的字节已经在内存里了，顺手算一次摘要 —— 不符就当场拒，别留给发布机发现。
  const measured = await sha256Hex(body);
  const state = measured === s.sha256 ? 'verified-at-edge' : null;
  if (!state) {
    await s3fetch(cfg, 'DELETE', stagingKey);
    return deny(`sha256 不符（实测 ${measured}）—— 已丢弃这次上传，请重新选文件`, 412);
  }

  const claim = {
    schema: 1,
    id,
    key: k.key,
    stagingKey,
    size: Number(z.size),
    sha256: s.sha256,
    source: src.source,
    what,
    state,
    edgeSha256: measured,
    claimedAt: new Date().toISOString(),
    ...actorHash(request),
  };
  const claimRes = await s3fetch(cfg, 'PUT', claimKeyFor(id), {
    body: `${JSON.stringify(claim, null, 2)}\n`,
    extraHeaders: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  if (!claimRes.ok) return deny(`写领取单失败：HTTP ${claimRes.status}`, 502);

  // 浏览器这条一次到位，所以更要当场叫发布轮 —— 否则用户看见的是"传完了，然后等 20 分钟"。
  const trigger = await triggerPublish(env);
  return json({
    ok: true,
    id,
    key: k.key,
    size: claim.size,
    state,
    dispatched: trigger.dispatched,
    message: trigger.dispatched
      ? '已收下并核对过摘要，正在落到对外键'
      : `已收下并核对过摘要，但叫不动发布轮（${trigger.reason}）—— 等定时兜底，或点「催一次发布」`,
  }, 202);
}

export function onRequestOptions() {
  return deny('这个端点不接受跨源调用', 405);
}
