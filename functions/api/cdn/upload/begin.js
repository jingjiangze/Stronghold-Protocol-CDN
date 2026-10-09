// POST /api/cdn/upload/begin —— 申请一次上传，拿到「直传桶」的 presigned PUT。
//
// 这一步不落任何对外可见的字节：目标是 staging 键 cdn/incoming/<id>/…，它不在任何清单里，
// 上传中断也只是留一个待清的对象。真正的上线由 Actions 核对 sha256 之后 CopyObject 完成。
// 只增不改不删在这里的体现：begin 会 HEAD 最终键，已存在就 409 —— 后台没有覆盖入口。
import { headKey, presignPut, r2Config } from './_edge.js';
import { checkAuth, deny, json, readBody, sameOriginOrNone } from './_http.js';
import { cleanNote, cleanSource, makeId, stagingKeyFor, validateKey, validateSha, validateSize } from '../../../../src/upload.mjs';

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
  const s = validateSha(doc.sha256);
  if (!s.ok) return deny(s.reason, 400);
  const z = validateSize(doc.size);
  if (!z.ok) return deny(z.reason, 400);
  const src = cleanSource(doc.source);
  if (!src.ok) return deny(src.reason, 400);

  let cfg;
  try {
    cfg = r2Config(env);
  } catch (e) {
    return deny(`后台未配置好 R2：${e.message}`, 500);
  }

  // 只增：最终键已经有对象就到此为止。
  let existing;
  try {
    existing = await headKey(cfg, k.key);
  } catch (e) {
    return deny(`检查目标键失败：${e.message}`, 502);
  }
  if (existing.exists) {
    return deny(`目标键已存在（${existing.size} 字节）。后台只能新增，不能覆盖或删除现网素材。`, 409, { key: k.key, currentSize: existing.size });
  }

  const id = makeId(() => crypto.getRandomValues(new Uint8Array(12)).reduce((a, b) => a + b.toString(16).padStart(2, '0'), ''));
  const stagingKey = stagingKeyFor(id, k.key);
  let putUrl;
  try {
    putUrl = await presignPut(cfg, stagingKey, { expiresSec: 900 });
  } catch (e) {
    return deny(`签名失败：${e.message}`, 500);
  }

  return json({
    ok: true,
    id,
    key: k.key,
    stagingKey,
    size: z.size,
    sha256: s.sha256,
    source: src.source,
    note: cleanNote(doc.note),
    putUrl,
    // 直传桶的 S3 端点：经 CF 代理的自定义域名单次请求体上限是 100 MB，这里不受那个限制。
    putMethod: 'PUT',
    expiresInSec: 900,
    next: '/api/cdn/upload/commit',
    howTo: "curl -X PUT --upload-file <你的文件> \"<putUrl>\" 之后 POST /api/cdn/upload/commit {id}",
  });
}

export function onRequestOptions() {
  return deny('这个端点不接受跨源调用', 405);
}
