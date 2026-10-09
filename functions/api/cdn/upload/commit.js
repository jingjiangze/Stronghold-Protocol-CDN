// POST /api/cdn/upload/commit —— 声明「这一份字节已经传完了」，并写下不可变的领取单。
//
// 为什么用一张 claim 对象、而不是往一个共享队列文件里追加：多个上传同时读-改-写同一个 JSON
// 会互相盖掉（这条清单在 dl-site 那边真实翻过车）。每个上传一份 claim，Actions 列前缀就能拿到
// 完整待办，没有共享可变量就没有丢更新。
// 这里能核对的只有「大小对不对」和（小文件）边缘直接算一次 sha256；大文件的摘要由 Actions
// 逐字节算 —— 边缘 10 ms CPU 与 128 MB 内存撑不起 600 MB 的哈希，别在这儿假充。
import { headKey, r2Config, s3fetch, sha256Hex } from './_edge.js';
import { actorHash, checkAuth, deny, json, readBody, sameOriginOrNone, triggerPublish } from './_http.js';
import { claimKeyFor, validateSha, validateSize } from '../../../../src/upload.mjs';

const EDGE_HASH_LIMIT = 4 * 1024 * 1024;

export async function onRequestPost(context) {
  const { request, env } = context;

  const originProblem = sameOriginOrNone(request);
  if (originProblem) return deny(originProblem, 403);
  const authProblem = checkAuth(request, env);
  if (authProblem) return deny(authProblem, 401);

  const { doc, error } = await readBody(request);
  if (error) return deny(error, 400);

  const id = String(doc.id || '').trim();
  if (!/^[0-9a-f]{12,24}$/.test(id)) return deny('id 需要是 begin 返回的十六进制串', 400);
  const s = validateSha(doc.sha256);
  if (!s.ok) return deny(s.reason, 400);

  let cfg;
  try {
    cfg = r2Config(env);
  } catch (e) {
    return deny(`后台未配置好 R2：${e.message}`, 500);
  }

  const stagingKey = String(doc.stagingKey || '').trim();
  const finalKey = String(doc.key || '').trim();
  // 只接受 begin 生成的那一对键，避免调用方把 claim 指到别的对象上。
  if (!stagingKey.startsWith(`cdn/incoming/${id}/`)) return deny('stagingKey 与 id 不匹配', 400);
  if (!finalKey || finalKey.includes('..')) return deny('key 缺失或不合法', 400);

  let staged;
  try {
    staged = await headKey(cfg, stagingKey);
  } catch (e) {
    return deny(`读 staging 失败：${e.message}`, 502);
  }
  if (!staged.exists) return deny('还没上传字节，或 presigned PUT 未成功', 412);

  const z = validateSize(staged.size);
  if (!z.ok) return deny(`staging 对象大小异常：${staged.size}`, 412);
  if (Number.isInteger(Number(doc.size)) && Number(doc.size) !== staged.size) {
    return deny(`大小与 begin 声明不一致（声明 ${doc.size}，实收 ${staged.size}）—— 多半是上传被截断，重传一次`, 412, { claimed: Number(doc.size), staged: staged.size });
  }

  // 小文件在边缘就能给确定答案；大文件到 Actions 才算，状态写 verifying 而不是假装通过。
  let edgeSha = null;
  let edgeMismatch = false;
  if (staged.size <= EDGE_HASH_LIMIT) {
    try {
      const res = await s3fetch(cfg, 'GET', stagingKey);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      edgeSha = await sha256Hex(await res.arrayBuffer());
      edgeMismatch = edgeSha !== s.sha256;
    } catch (e) {
      // 边缘算不动就算不了，不代表失败 —— 交给 Actions 复核。
      edgeSha = null;
    }
  }
  if (edgeMismatch) return deny(`字节与声明的 sha256 不符（边缘实测 ${edgeSha}）—— 已拒绝，不会上线`, 412, { staged: staged.size });

  const claim = {
    schema: 1,
    id,
    key: finalKey,
    stagingKey,
    size: staged.size,
    sha256: s.sha256,
    source: String(doc.source || '').slice(0, 60),
    what: String(doc.what || doc.note || '').slice(0, 200),
    state: edgeSha ? 'verified-at-edge' : 'queued',
    edgeSha256: edgeSha,
    claimedAt: new Date().toISOString(),
    ...actorHash(request),
  };

  const text = `${JSON.stringify(claim, null, 2)}\n`;
  const put = await s3fetch(cfg, 'PUT', claimKeyFor(id), {
    body: text,
    extraHeaders: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  if (!put.ok) return deny(`写 claim 失败：HTTP ${put.status}`, 502);

  // 触发式发布：收下就立刻叫一轮发布，不让人等定时。催不动也照实说（定时轮是兜底）。
  const trigger = await triggerPublish(env);

  return json({
    ok: true,
    id,
    key: finalKey,
    state: claim.state,
    size: staged.size,
    dispatched: trigger.dispatched,
    message: trigger.dispatched
      ? '已收下，正在发布（Actions 会逐字节核对后落到对外键，并写进 hosted.json）'
      : `已收下，但这次叫不动发布轮（${trigger.reason}）—— 等定时兜底；要马上发可在后台点「催一次发布」`,
  }, 202);
}

export function onRequestOptions() {
  return deny('这个端点不接受跨源调用', 405);
}
