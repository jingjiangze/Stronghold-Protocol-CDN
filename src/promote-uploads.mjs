// 把后台收到的上传发布出去：核对摘要 → CopyObject 到对外键 → 登记 hosted.json → 刷新浏览面。
//
//   node src/promote-uploads.mjs            处理 cdn/incoming/ 下所有已提交 claim 的上传
//   node src/promote-uploads.mjs --dry      只报告，不写字节、不改 hosted.json
//   node src/promote-uploads.mjs --max=5    单轮上限（默认 20）
//
// 为什么这一半放在 Actions 而不是边缘：
//   - 摘要要逐字节算。600 MB 的素材在 Pages Functions 上算不动（免费档每次调用 10 ms CPU、
//     128 MB 内存），在 runner 上是流式一遍，几秒钟的事；
//   - 登记 hosted.json 是要进 git 的 —— 谁传的、传了什么，答案必须在提交历史里，
//     而不是只在某个对象的字段里。
// 只增不删在这里同样成立：目标键已有对象且摘要不同 → 拒绝；摘要相同 → 视为上一次发布已落地，
// 清掉 staging 继续走。删除只发生在本通道自己的 cdn/incoming/ 对象上。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { HOSTED_FILE } from './hosted.mjs';
import {
  r2Config,
  getObject,
  getObjectStream,
  headObject,
  putObject,
  deleteObject,
  copyObject,
  listKeys,
  mimeFor,
  IMMUTABLE,
  SHORT,
} from './r2.mjs';
import {
  HOSTED_INDEX_KEY,
  LOG_KEY,
  REMOVAL_PREFIX,
  STAGING_PREFIX,
  appendToLog,
  buildHostedIndex,
  claimIsPublishable,
  claimKeyFor,
  claimsFromListing,
  collectReferences,
  emptyLog,
  hostedGroupFor,
  mergeHosted,
  removeKeysFromHosted,
  removalVerdict,
} from './upload.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.log('[promote]', ...a);

function parseArgs(argv) {
  const opts = { dry: false, max: 20 };
  for (const arg of argv) {
    if (arg === '--dry') opts.dry = true;
    else if (arg.startsWith('--max=')) opts.max = Math.max(1, Number(arg.slice('--max='.length)) || 20);
    else throw new Error(`未知参数：${arg}`);
  }
  return opts;
}

/** 流式算 sha256，不把整个对象读进内存。 */
async function sha256OfObject(config, key, expectedSize) {
  const { res, statusCode } = await getObjectStream(config, key);
  if (statusCode !== 200) {
    res.resume();
    throw new Error(`GET ${key} → HTTP ${statusCode}`);
  }
  const hash = createHash('sha256');
  let seen = 0;
  for await (const chunk of res) {
    hash.update(chunk);
    seen += chunk.length;
  }
  if (Number.isFinite(expectedSize) && seen !== expectedSize) {
    throw new Error(`读到的字节数 ${seen} 与声明 ${expectedSize} 不符（传输被截断）`);
  }
  return { sha256: hash.digest('hex'), bytes: seen };
}

async function readJsonKey(config, key) {
  const body = await getObject(config, key);
  if (!body) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * 处理撤销请求（下线后台自己上线过的键）。
 *
 * 判定顺序是有意的：先确认它是后台上线的（日志 + hosted.json 两处都要在），
 * 再确认现在没人引用它（上游 index、APK 素材包清单、三张客户端清单的正文）。
 * 任一不成立就整条拒绝，删下去的代价是玩家端静默 404 —— 那种问题查起来极慢。
 * 删完要连带摘 hosted.json 的登记、重建 hosted-index、并在日志里留 tombstone（记录不抹，只标已下线）。
 */
export async function processRemovals(config, { dry = false, log = console.log } = {}) {
  const out = { removed: [], refused: [], errors: [] };
  let requests;
  try {
    requests = await listKeys(config, REMOVAL_PREFIX);
  } catch (error) {
    out.errors.push({ error: `列撤销请求失败：${error.message}` });
    return out;
  }
  if (!requests.length) return out;

  const indexDoc = (await readJsonKey(config, 'cdn/v1/index.json')) || {};
  const indexFiles = indexDoc.files || indexDoc;
  const packKeys = new Set();
  const manifestTexts = [];
  for (const key of ['site/manifest.json', 'site/manifest-re.json', 'data/assets.json', 'data/local-assets.json', 'data/emotes.json']) {
    const body = await getObject(config, key);
    if (!body) continue;
    const text = body.toString('utf8');
    manifestTexts.push(text);
    if (key.startsWith('site/manifest')) {
      try {
        const doc = JSON.parse(text);
        for (const pack of doc?.art?.packs || []) {
          for (const url of pack.urls || []) {
            try {
              packKeys.add(decodeURIComponent(new URL(url).pathname).replace(/^\//, ''));
            } catch {
              /* 镜像前缀那条不是绝对 URL，忽略 */
            }
          }
        }
      } catch {
        /* 解析不了就把这一份正文留在 manifestTexts 里做字符串引用检查 */
      }
    }
  }
  const references = collectReferences({ indexFiles, packKeys, manifestTexts });
  const uploadLog = (await readJsonKey(config, LOG_KEY)) || emptyLog();
  const loggedKeys = new Set((uploadLog.items || []).filter((i) => i && i.key && !i.removedAt).map((i) => i.key));

  const hostedPath = path.join(ROOT, HOSTED_FILE);
  let hostedDoc = fs.existsSync(hostedPath) ? JSON.parse(fs.readFileSync(hostedPath, 'utf8')) : { hosted: [] };
  let hostedTouched = false;
  const removedRows = [];

  for (const row of requests) {
    let req = null;
    try {
      req = await readJsonKey(config, row.key);
    } catch (error) {
      out.errors.push({ key: row.key, error: `读请求失败：${error.message}` });
      continue;
    }
    if (!req || typeof req.key !== 'string') {
      out.errors.push({ key: row.key, error: '撤销请求不是合法 JSON' });
      continue;
    }
    const exists = await headObject(config, req.key);
    const verdict = removalVerdict(req.key, {
      logged: loggedKeys.has(req.key),
      inUpstreamIndex: Boolean(indexFiles[req.key]),
      referenced: references.has(req.key) ? '线上清单仍写着这个路径' : null,
      exists: Boolean(exists),
    });
    if (!verdict.ok) {
      out.refused.push({ key: req.key, reason: verdict.reason });
      if (!dry) await deleteObject(config, row.key); // 明确拒绝的请求也不留着：它会每次重跑同一个判定
      continue;
    }

    if (dry) {
      out.removed.push({ key: req.key, size: exists.size, dry: true });
      log(`dry-run：会下线 ${req.key}（${exists.size} 字节）`);
      continue;
    }

    await deleteObject(config, req.key);
    const after = await headObject(config, req.key);
    if (after) {
      out.errors.push({ key: req.key, error: '删完 HEAD 还在，桶没响应一致，保留登记不动' });
      continue;
    }
    const strip = removeKeysFromHosted(hostedDoc, [req.key]);
    if (strip.removed) {
      hostedDoc = strip.doc;
      hostedTouched = true;
    }
    removedRows.push(req.key);
    uploadLog.items = (uploadLog.items || []).map((i) => (i && i.key === req.key ? { ...i, removedAt: new Date().toISOString(), removedReason: req.reason || '' } : i));
    await deleteObject(config, row.key);
    out.removed.push({ key: req.key, size: exists.size, source: req.publishedSource });
    log(`removed ${req.key}（${exists.size} 字节）`);
  }

  if (removedRows.length && !dry) {
    if (hostedTouched) fs.writeFileSync(hostedPath, `${JSON.stringify(hostedDoc, null, 2)}\n`, 'utf8');
    const existingIndex = (await readJsonKey(config, HOSTED_INDEX_KEY)) || { files: {} };
    const files = { ...(existingIndex.files || {}) };
    for (const key of removedRows) delete files[key];
    const bySource = {};
    for (const [key, v] of Object.entries(files)) {
      const source = v.source || 'unknown';
      (bySource[source] = bySource[source] || []).push({ key, size: Number(v.size) || 0, sha256: v.sha256 });
    }
    const rebuilt = buildHostedIndex(bySource);
    await putObject(config, HOSTED_INDEX_KEY, Buffer.from(rebuilt.json, 'utf8'), { contentType: 'application/json', cacheControl: SHORT });
    await putObject(config, LOG_KEY, Buffer.from(`${JSON.stringify(uploadLog, null, 2)}\n`, 'utf8'), { contentType: 'application/json', cacheControl: SHORT });
    out.hostedIndexTotals = rebuilt.doc.totals;
    reportRemovalChange(out, removedRows.length);
  }
  return out;
}

function reportRemovalChange(out, count) {
  out.hostedRewritten = count;
}

/** 按来源分组，喂给 buildHostedIndex（它要的形状是 {source: [{key,size,sha256}]}）。 */
function bySourceAll(filesByKey) {
  const out = {};
  for (const [key, v] of Object.entries(filesByKey || {})) {
    const source = v.source || 'unknown';
    (out[source] = out[source] || []).push({ key, size: Number(v.size) || 0, sha256: v.sha256 });
  }
  return out;
}

/** 只清本通道自己的对象；任何其它前缀一律拒绝，免得删别人家的字节。 */
async function dropStaging(config, key, { dry }) {
  if (!key.startsWith(STAGING_PREFIX)) throw new Error(`拒绝删除 staging 之外的键：${key}`);
  if (dry) return;
  await deleteObject(config, key);
}

export async function promote({ dry = false, max = 20 } = {}) {
  const config = r2Config(process.env);
  const report = { dry, scanned: 0, published: [], rejected: [], already: [], skippedNoClaim: 0, errors: [] };

  const rows = await listKeys(config, STAGING_PREFIX);
  report.scanned = rows.length;
  const groups = claimsFromListing(rows);

  for (const g of groups) {
    if (!g.claim) {
      report.skippedNoClaim++;
      continue;
    }
    if (report.published.length + report.rejected.length + report.already.length >= max) {
      log(`到单轮上限 ${max}，剩下的下一轮再处理`);
      break;
    }
    const payloadSize = g.payload?.size ?? null;
    let claim = null;
    try {
      claim = await readJsonKey(config, g.claim.key);
    } catch (error) {
      report.errors.push({ id: g.id, error: `读 claim 失败：${error.message}` });
      continue;
    }
    if (!claim) {
      report.errors.push({ id: g.id, error: 'claim.json 不是合法 JSON' });
      continue;
    }

    const verdict = claimIsPublishable(claim, { payloadSize });
    if (!verdict.ok || !g.payload) {
      report.rejected.push({ id: g.id, key: claim.key, reason: !g.payload ? '有 claim 但没有字节对象' : verdict.reason });
      if (!dry) {
        await dropStaging(config, g.claim.key, { dry });
        if (g.payload) await dropStaging(config, g.payload.key, { dry });
      }
      continue;
    }

    // 只增：目标键已经有东西了，只有「字节就是同一份」才允许继续。
    const before = await headObject(config, claim.key);
    if (before) {
      const same = Number(before.size) === Number(claim.size) && String(before.meta?.sha256 || '') === claim.sha256;
      if (!same) {
        report.rejected.push({
          id: g.id,
          key: claim.key,
          reason: `目标键已存在且不是同一份（现网 ${before.size} 字节 / 声明 ${claim.size} 字节）—— 后台不覆盖`,
        });
        if (!dry) {
          await dropStaging(config, g.payload.key, { dry });
          await dropStaging(config, g.claim.key, { dry });
        }
        continue;
      }
      report.already.push({ id: g.id, key: claim.key, size: before.size });
      if (!dry) {
        await dropStaging(config, g.payload.key, { dry });
        await dropStaging(config, g.claim.key, { dry });
      }
      continue;
    }

    // 摘要以字节为准，不以调用方声明为准 —— 这是「上线的确实是你传的那份」的唯一凭据。
    let measured;
    try {
      measured = await sha256OfObject(config, g.payload.key, claim.size);
    } catch (error) {
      report.errors.push({ id: g.id, key: claim.key, error: `读字节失败：${error.message}` });
      continue;
    }
    if (measured.sha256 !== claim.sha256) {
      report.rejected.push({
        id: g.id,
        key: claim.key,
        reason: `sha256 不符：声明 ${claim.sha256}，实测 ${measured.sha256}`,
      });
      if (!dry) {
        await dropStaging(config, g.payload.key, { dry });
        await dropStaging(config, g.claim.key, { dry });
      }
      continue;
    }

    if (dry) {
      report.published.push({ id: g.id, key: claim.key, size: claim.size, sha256: measured.sha256, source: claim.source, dry: true });
      log(`dry-run：${claim.key}（${claim.size} 字节）核对通过，未写入`);
      continue;
    }

    await copyObject(config, g.payload.key, claim.key, {
      contentType: mimeFor(claim.key),
      cacheControl: IMMUTABLE,
      meta: { sha256: measured.sha256, source: claim.source || '', upload: g.id },
    });
    const after = await headObject(config, claim.key);
    if (!after || Number(after.size) !== Number(claim.size)) {
      // 复制没落地就把 staging 留着，claim 也不删 —— 下一轮还能重试，别把字节丢了。
      report.errors.push({ id: g.id, key: claim.key, error: `复制后 HEAD ${after ? `${after.size} 字节` : '为空'}，与声明 ${claim.size} 不符` });
      continue;
    }
    await dropStaging(config, g.payload.key, { dry });
    await dropStaging(config, g.claim.key, { dry });
    report.published.push({
      id: g.id,
      key: claim.key,
      size: after.size,
      sha256: measured.sha256,
      source: claim.source,
      what: claim.what,
    });
    log(`published ${claim.key} (${after.size} B, sha256 ${measured.sha256.slice(0)}…)`);
  }

  if (!report.published.length) return report;

  // 1) hosted.json —— 这批字节从此有名字、有理由，prune 不再把它们当镜像残渣。
  const bySource = {};
  for (const p of report.published) (bySource[p.source] = bySource[p.source] || []).push(p);
  const hostedPath = path.join(ROOT, HOSTED_FILE);
  const hostedDoc = fs.existsSync(hostedPath) ? JSON.parse(fs.readFileSync(hostedPath, 'utf8')) : { hosted: [] };
  const touched = [];
  for (const [source, rowsForSource] of Object.entries(bySource)) {
    const group = hostedGroupFor({
      source,
      what: rowsForSource.map((r) => r.what).filter(Boolean)[0] || `后台上传的 ${rowsForSource.length} 个文件`,
      addedAt: new Date().toISOString().slice(0, 10),
      keysWithSizes: rowsForSource.map((r) => [r.key, r.size]),
    });
    const merged = mergeHosted(hostedDoc, group);
    hostedDoc.hosted = merged.doc.hosted;
    touched.push({ source, added: merged.added, replaced: merged.replaced });
  }
  if (!dry) fs.writeFileSync(hostedPath, `${JSON.stringify(hostedDoc, null, 2)}\n`, 'utf8');
  report.hosted = touched;

  // 2) hosted-index.json —— 托管字节的摘要表（index.json 保持「等于上游树」，不往里塞）。
  const existingIndex = (await readJsonKey(config, HOSTED_INDEX_KEY)) || { files: {} };
  const mergedFiles = { ...(existingIndex.files || {}) };
  for (const [source, rowsForSource] of Object.entries(bySource)) {
    for (const r of rowsForSource) mergedFiles[r.key] = { size: r.size, sha256: r.sha256, source };
  }
  const rebuilt = buildHostedIndex(bySourceAll(mergedFiles));
  if (!dry) {
    await putObject(config, HOSTED_INDEX_KEY, Buffer.from(rebuilt.json, 'utf8'), { contentType: 'application/json', cacheControl: SHORT });
  }
  report.hostedIndexTotals = rebuilt.doc.totals;

  // 3) 发布日志 —— 「谁在什么时候传了什么」的单一答案。
  const prior = (await readJsonKey(config, LOG_KEY)) || emptyLog();
  let nextLog = prior;
  for (const p of report.published) {
    nextLog = appendToLog(nextLog, {
      at: new Date().toISOString(),
      id: p.id,
      key: p.key,
      size: p.size,
      sha256: p.sha256,
      source: p.source,
      what: p.what,
      via: 'promote-uploads',
    });
  }
  if (!dry) {
    await putObject(config, LOG_KEY, Buffer.from(`${JSON.stringify(nextLog, null, 2)}\n`, 'utf8'), { contentType: 'application/json', cacheControl: SHORT });
  }

  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const report = await promote(opts);
  // 下线独立跑一遍：哪怕这一轮没有任何新上传，撤销请求也得被处理掉。
  let removals = { removed: [], refused: [], errors: [] };
  try {
    removals = await processRemovals(r2Config(process.env), { dry: opts.dry, log });
  } catch (error) {
    removals.errors.push({ error: `撤销阶段整体失败：${error.message}` });
  }
  report.removals = removals;

  console.log(`\n== 发布结果${opts.dry ? '（dry-run）' : ''} ==`);
  console.log(`staging 对象 ${report.scanned} 个；未提交 claim ${report.skippedNoClaim} 组`);
  console.log(`published ${report.published.length}，already ${report.already.length}，rejected ${report.rejected.length}，errors ${report.errors.length}`);
  for (const p of report.published) console.log(`  + ${p.key}  ${p.size} B  ${p.source}`);
  for (const r of report.rejected) console.log(`  ✗ ${r.key || r.id} — ${r.reason}`);
  for (const e of report.errors) console.log(`  ! ${e.key || e.id} — ${e.error}`);
  console.log(`\n== 撤销结果 ==`);
  console.log(`removed ${removals.removed.length}，refused ${removals.refused.length}，errors ${removals.errors.length}`);
  for (const r of removals.removed) console.log(`  − ${r.key}${r.dry ? '（干跑）' : ''}`);
  for (const r of removals.refused) console.log(`  ✗ 拒撤 ${r.key} — ${r.reason}`);
  for (const e of removals.errors) console.log(`  ! ${e.key || ''} ${e.error}`);
  if (report.hosted) console.log('hosted.json：', report.hosted.map((h) => `${h.source} +${h.added}`).join(', '));
  if (report.hostedIndexTotals) console.log('hosted-index.json：', JSON.stringify(report.hostedIndexTotals));
  if (removals.hostedIndexTotals) console.log('hosted-index.json（撤销后）：', JSON.stringify(removals.hostedIndexTotals));
  // 供工作流判断「要不要接着提交 hosted.json / 刷 tree.json / 部署站点」
  console.log(`PUBLISHED_COUNT=${report.published.length}`);
  console.log(`REMOVED_COUNT=${removals.removed.length}`);
  return report;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[promote] 失败：${error.stack || error.message}`);
    process.exit(1);
  });
}
