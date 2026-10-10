// 阶段 1：对每个候选镜像做可机读实测，产出 docs/audit/free-mirror-verification.json。
//
// 只读公网，不写任何远端。判据不是「探针能通」，而是「客户端真正用到的素材目录能通且字节正确」：
// 探针在 main 分支里存在，所以只测探针会把 @main 源判成好源——那正是要避免的误判。
//
// 用法：
//   node tools/verify-mirrors.mjs [--index=work/v0.2.2/index.json] [--out=docs/audit/free-mirror-verification.json]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const INDEX_PATH = path.resolve(ROOT, arg('index', 'work/v0.2.2/index.json'));
const OUT_PATH = path.resolve(ROOT, arg('out', 'docs/audit/free-mirror-verification.json'));
const CDN = 'https://weishucdn.jiangjiangze.icu';
const TIMEOUT = 20000;

const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
const files = index.files || index;
const KEYS = Object.keys(files).sort();

/** Deterministic representative paths: the directories a client actually loads, plus a large file. */
function pickPaths() {
  const has = (re) => KEYS.filter((k) => re.test(k));
  const largest = (list) => list.sort((a, b) => (files[b].size || 0) - (files[a].size || 0))[0];
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  add(has(/^assets\/spine\/op\/.*\/front\/.*\.skel$/)[0]);
  add(has(/^assets\/spine\/op\/.*\/front\/.*\.atlas$/)[0]);
  add(has(/^assets\/spine\/op\/.*\.png$/)[0]);
  add(has(/^assets\/char\/avatar\/.*\.png$/)[0]);
  add(has(/^fonts\/.*\.woff2$/)[0]);
  add(largest(has(/^assets\//))); // the biggest asset: the one a truncating mirror fails first
  return out;
}
const PATHS = pickPaths();

const retry = async (fn, attempts = 3) => {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 700 * (i + 1))); }
  }
  throw last;
};

/** A HEAD through an edge cache can answer 200 with content-length:0; fall back to a 1-byte range. */
async function sizeOf(url) {
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
  const headers = Object.fromEntries(head.headers);
  const len = Number(head.headers.get('content-length') || 0);
  let size = Number.isFinite(len) && len > 0 ? len : null;
  if (size == null && head.ok) {
    const r = await fetch(url, { headers: { range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
    const cr = r.headers.get('content-range');
    const m = cr && cr.match(/\/(\d+)$/);
    if (m) size = Number(m[1]);
  }
  return { status: head.status, size, headers };
}

async function checkPath(root, key) {
  const url = `${root}/${key}`;
  const expected = files[key];
  const rec = { path: key, expected };

  // Headers first: status, CORS, cache policy. The HEAD content-length is NOT used for the size
  // verdict: an origin that compresses (jsDelivr/ghfast serve .atlas/.skel with br/gzip) reports the
  // COMPRESSED length there, so comparing it to the manifest size reports a false mismatch on a
  // mirror whose bytes are in fact correct.
  try {
    const { status, headers } = await retry(() => sizeOf(url));
    rec.headStatus = status;
    rec.cors = headers['access-control-allow-origin'] || null;
    rec.contentType = headers['content-type'] || null;
    rec.cacheControl = headers['cache-control'] || null;
    rec.contentEncoding = headers['content-encoding'] || null;
    rec.wireLength = Number(headers['content-length'] || 0) || null;
  } catch (e) { rec.error = String(e.message || e).slice(0, 80); return rec; }

  // Range: the client's resumable/segmented path needs 206 + Content-Range.
  try {
    const r = await fetch(url, { headers: { range: 'bytes=0-1023' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
    rec.rangeStatus = r.status;
    rec.contentRange = r.headers.get('content-range') || null;
  } catch (e) { rec.rangeError = String(e.message || e).slice(0, 60); }

  // The authority is the DECODED body: its length must equal the manifest size and its sha256 must
  // match the release index. Anything else (a re-encoded copy, a truncating mirror) is caught here.
  if ((expected.size || 0) <= 6 * 1024 * 1024) {
    try {
      const r = await retry(() => fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) }));
      const buf = Buffer.from(await r.arrayBuffer());
      rec.size = buf.byteLength;
      rec.sizeOk = buf.byteLength === expected.size;
      rec.sha256Match = createHash('sha256').update(buf).digest('hex') === expected.sha256;
    } catch (e) { rec.sha256Error = String(e.message || e).slice(0, 60); }
  } else {
    const m = rec.contentRange && rec.contentRange.match(/\/(\d+)$/);
    rec.size = m ? Number(m[1]) : null;
    rec.sizeOk = rec.size == null ? null : rec.size === expected.size;
  }
  return rec;
}

function verdictOf(mirror, checks) {
  const reasons = [];
  const okPaths = checks.filter((c) => c.headStatus === 200);
  const wrongSize = checks.filter((c) => c.sizeOk === false);
  const badSha = checks.filter((c) => c.sha256Match === false);
  if (mirror.coverage === 'partial') reasons.push('coverage=partial：不含素材树');
  if (!okPaths.length) reasons.push('没有任何代表性素材路径返回 200');
  if (wrongSize.length) reasons.push(`${wrongSize.length} 条尺寸不符`);
  if (badSha.length) reasons.push(`${badSha.length} 条 sha256 不符`);
  if (mirror.proxied) reasons.push('Worker 中继：可用但不得作为默认直连候选');
  // Bytes that are missing or wrong disqualify a source outright — "it answered 200" is not enough.
  if (!okPaths.length || mirror.coverage === 'partial' || wrongSize.length || badSha.length) {
    return { verdict: 'ineligible', reasons };
  }
  if (checks.some((c) => c.error)) return { verdict: 'pending', reasons: [...reasons, '部分路径不可达（本机网络/源抖动）'] };
  // A relay is a distinct category: bytes are fine, but it must not be a default candidate.
  return { verdict: mirror.proxied ? 'relay' : 'eligible', reasons };
}

async function main() {
  let flat = [];
  try {
    const res = await retry(() => fetch(`${CDN}/cdn/v1/mirrors.json`, { signal: AbortSignal.timeout(TIMEOUT) }));
    flat = (await res.json()).flat || [];
    console.log(`mirrors from live mirrors.json: ${flat.length}`);
  } catch {
    const origins = JSON.parse(fs.readFileSync(path.join(ROOT, 'origins.json'), 'utf8'));
    flat = [
      { id: 'r2', kind: 'r2', root: CDN, base: `${CDN}/assets/` },
      { id: 'pages', kind: 'pages', root: 'https://spages.jiangjiangze.icu', base: 'https://spages.jiangjiangze.icu/assets/' },
      ...(origins.extraOrigins || []).map((o) => ({ ...o, base: `${o.root}/assets/` })),
      ...(origins.gitOrigins || []).map((o) => ({ ...o, base: `${o.root}/assets/` })),
    ];
    console.log(`mirrors from origins.json (live fetch failed): ${flat.length}`);
  }

  const out = { generatedAt: new Date().toISOString(), indexToken: path.basename(path.dirname(INDEX_PATH)), indexFiles: KEYS.length, sampledPaths: PATHS,
    notes: [
      'r2 与 r2-alt 是同一个 R2 桶的第二个自定义域名：不同入口，但不是独立数据副本，共享 faultDomain=r2-bucket，选源时不得当两个独立故障域。',
      'gitcdn-own 是 Worker 中继（proxy），字节正确但素材流量会过 Worker；按免费额度约束不得作为默认直连候选。',
      '判据是解压后字节的 sha256 + 长度，不是 HEAD 的 content-length：jsDelivr/ghfast 对文本类素材压缩，HEAD 给的是压缩后长度。',
    ],
    mirrors: [], summary: {} };
  for (const m of flat) {
    const root = String(m.root || '').replace(/\/+$/, '');
    // A relay fronting the mirrors is not a direct origin: it carries the bytes through a Worker, so
    // it must never be a default candidate (free-plan request budget). The published `note` is what
    // says so today; Stage 2 turns this into a first-class `proxied` field.
    const proxied = /中转|中继|relay/i.test(m.note || '');
    const entry = { id: m.id, kind: m.kind, root, coverage: m.coverage || 'full', probe: m.probe || null, proxied, checks: [] };
    for (const key of PATHS) entry.checks.push(await checkPath(root, key));
    Object.assign(entry, verdictOf(entry, entry.checks));
    out.mirrors.push(entry);
    console.log(`${entry.verdict.padEnd(10)} ${entry.id.padEnd(16)} ${entry.reasons.join('; ') || 'ok'}`);
  }
  out.summary = out.mirrors.reduce((acc, m) => { acc[m.verdict] = (acc[m.verdict] || 0) + 1; return acc; }, {});
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${path.relative(ROOT, OUT_PATH)} — ${JSON.stringify(out.summary)}`);
}

await main();
