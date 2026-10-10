// The aggregation endpoint's client half: given the published mirror list, measure the mirrors and
// hand back the fastest one that can ACTUALLY serve the assets. This is the piece that makes
// "which mirror" a runtime decision rather than a hard-coded host — a deployment in one network and
// a player in another do not agree.
//
// It is served from the CDN itself (cdn/v1/pick.js) and is dependency-free ES module code, so a
// consumer can either import it or paste the probe into their own loader. It runs in a browser and
// in Node unchanged, and it must keep running on the client's WebView floor (Chromium 89): nothing
// here may rely on an API newer than that, which is why the timeout is built from AbortController
// rather than AbortSignal.timeout (Chrome 103+).
//
// WHAT "FASTEST" MEANS HERE
//   Throughput first (that is what the assets cost), then time-to-first-byte as the tiebreak. A
//   source that answers 200 is NOT automatically a candidate: a `@main` git mount carries the
//   interface files and the probe, and answers 404 for every `assets/**` path, so measuring it on a
//   path it happens to have makes it look fast while every model it would serve is a 404.
//   `servesAssets` is what excludes it, from the published `assetEligible`/`coverage` fields.

/** Default probe when a mirror declares none. Overridable by the caller. */
const DEFAULT_PROBE = '/robots.txt';

/** A timeout signal that also works on Chromium 89, where AbortSignal.timeout does not exist. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => { try { ctrl.abort(new Error('timeout')); } catch { /* already settled */ } }, ms);
  return ctrl.signal;
}

/**
 * Whether a source may serve the assets being fetched.
 *
 * `assetEligible:false` is the published field; `coverage:'partial'` is the same fact on manifests
 * published before the field existed. Either one disqualifies. A source with NEITHER field is a
 * flat origin (r2/pages) and is eligible — so this filter is a no-op on older manifests, which is
 * what keeps it backward compatible.
 */
export function servesAssets(mirror) {
  if (mirror?.assetEligible === false) return false;
  if (mirror?.coverage === 'partial') return false;
  return true;
}

/**
 * The sources a selector is allowed to use: enabled, asset-eligible, and — unless the caller opts in
 * — not a Worker relay (a relay carries the bytes through a Worker, which the free-plan request
 * budget cannot afford for bulk traffic).
 */
export function eligibleMirrors(mirrors, { requireAssets = true, allowRelay = false } = {}) {
  return (mirrors || []).filter((m) => {
    if (!m || !(m.root || m.base)) return false;
    if (m.enabled === false) return false;
    if (!allowRelay && m.proxied) return false;
    if (requireAssets && !servesAssets(m)) return false;
    return true;
  });
}

/**
 * One probe. `maxBytes` caps the download (the caller reads and cancels) without needing Range,
 * which the Pages origin rejects at the CORS preflight.
 */
async function measureOnce(mirror, { path = DEFAULT_PROBE, timeoutMs = 6000, maxBytes = 0, fetchImpl = fetch } = {}) {
  const origin = String(mirror.root || mirror.base || '').replace(/\/+$/, '');
  const probePath = mirror.probe || path;
  const started = Date.now();
  const res = await fetchImpl(`${origin}${probePath}?probe=${Date.now()}`, {
    method: 'GET',
    cache: 'no-store',
    signal: timeoutSignal(timeoutMs),
  });
  const ttfbMs = Date.now() - started;
  if (!res.ok) throw new Error(`${mirror.id}: HTTP ${res.status}`);

  let byteLength;
  let capped = false;
  if (maxBytes > 0 && res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    let read = 0;
    while (read < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      // Count only up to the cap. A stream may hand over a whole chunk larger than what is left,
      // so the transport can deliver up to one chunk beyond `maxBytes`; the ACCOUNTING is exact so
      // the byte budget a caller reports stays true.
      read += Math.min(value.length, maxBytes - read);
    }
    capped = read >= maxBytes;
    try { await reader.cancel(); } catch { /* the cap already decided the sample */ }
    byteLength = read;
  } else {
    byteLength = (await res.arrayBuffer()).byteLength;
  }

  const totalMs = Date.now() - started;
  const declared = Number(res.headers.get('content-length') || 0);
  // A short body with a 200 is the failure this project has actually hit on a third-party mirror
  // (Statically truncated a 262,144-byte probe). Only check it when the read was not deliberately
  // capped — a capped read is shorter than `content-length` by design.
  if (!capped && declared > 0 && byteLength !== declared) throw new Error(`${mirror.id}: truncated ${byteLength}/${declared}`);
  if (byteLength === 0) throw new Error(`${mirror.id}: empty body`);

  const bodyMs = Math.max(0.001, (totalMs - ttfbMs) / 1000);
  return { ms: totalMs, ttfbMs, bytes: byteLength, bytesPerSec: Math.round(byteLength / bodyMs), capped, path: probePath };
}

/** Rank by throughput, then by time-to-first-byte: a fast start on a slow link is not "fast". */
export function rankSamples(list) {
  return [...list].sort(
    (a, b) => (b.bytesPerSec || 0) - (a.bytesPerSec || 0) || (a.ttfbMs ?? 1e9) - (b.ttfbMs ?? 1e9) || (a.ms || 0) - (b.ms || 0),
  );
}

/**
 * Measure one mirror with its declared probe, retrying so a single transient failure is not the
 * verdict. (The earlier version threw out of the attempt loop, so attempt 0's failure killed the
 * mirror even though attempt 1 would have succeeded.)
 */
export async function measureMirror(mirror, { path = DEFAULT_PROBE, attempts = 2, timeoutMs = 6000, fetchImpl = fetch } = {}) {
  let best = null;
  let lastError = null;
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      const sample = await measureOnce(mirror, { path, timeoutMs, fetchImpl });
      if (!best || rankSamples([best, sample])[0] === sample) best = sample;
    } catch (error) { lastError = error; }
  }
  if (!best) throw lastError || new Error(`${mirror.id}: no attempt succeeded`);
  return { ...mirror, ...best };
}

/**
 * Race every eligible mirror and return the fastest, with the full ranking.
 *
 * Each mirror is probed on the path IT declares (a git mount answers 502 on `/cdn/v1/probe.bin` and
 * 404 on `/robots.txt`, but 200 on `/probe/cdn-probe.bin`), and only sources that can serve the
 * assets are raced at all.
 */
export async function pickFastest(mirrors, { path = DEFAULT_PROBE, attempts = 2, timeoutMs = 6000, fetchImpl = fetch, requireAssets = true, allowRelay = false } = {}) {
  const candidates = eligibleMirrors(mirrors, { requireAssets, allowRelay });
  const settled = await Promise.allSettled(candidates.map((mirror) => measureMirror(mirror, { path, attempts, timeoutMs, fetchImpl })));
  const ok = rankSamples(settled.filter((e) => e.status === 'fulfilled').map((e) => e.value));
  if (!ok.length) throw new Error('no mirror answered');
  return { best: ok[0], ranked: ok };
}

/** Measure every eligible mirror without short-circuiting — for a UI that wants to show the numbers. */
export async function measureMirrors(mirrors, options) {
  const { ranked } = await pickFastest(mirrors, options);
  return ranked;
}

/**
 * Staged pick: a cheap first round over many sources, then a careful second round over the top few.
 *
 * A phone should not download a full-size probe from every mirror on every launch. The first round
 * caps each read (the caller cancels the stream after `stage1Bytes`, so no Range support is needed),
 * the second round spends more bytes on the two that look best. Both rounds share one deadline.
 *
 * @returns {{best:object|null, ranked:object[], bytes:number, stages:{first:number,second:number}}}
 */
export async function pickStaged(mirrors, {
  shortlist = 5, finalists = 2, stage1Bytes = 32 * 1024, stage2Bytes = 64 * 1024,
  attempts = 1, finalAttempts = 2, timeoutMs = 6000, deadlineMs = 20000,
  fetchImpl = fetch, requireAssets = true, allowRelay = false, now = () => Date.now(),
} = {}) {
  void attempts;
  const started = now();
  const budgetLeft = () => deadlineMs - (now() - started);

  // Prefer distinct fault domains: two custom domains on one R2 bucket are one backend, so taking
  // both would spend the shortlist on a single failure domain.
  const seen = new Set();
  const candidates = [];
  for (const m of eligibleMirrors(mirrors, { requireAssets, allowRelay })) {
    const domain = m.faultDomain || String(m.root || '').replace(/^https?:\/\//, '').split('/')[0];
    if (seen.has(domain)) continue;
    seen.add(domain);
    candidates.push(m);
    if (candidates.length >= shortlist) break;
  }

  let bytes = 0;
  const first = [];
  await Promise.all(candidates.map(async (mirror) => {
    if (budgetLeft() <= 0) return;
    try {
      const sample = await measureOnce(mirror, { timeoutMs: Math.min(timeoutMs, Math.max(1000, budgetLeft())), maxBytes: stage1Bytes, fetchImpl });
      bytes += sample.bytes;
      first.push({ ...mirror, ...sample });
    } catch { /* a source that fails round 1 simply is not a finalist */ }
  }));

  const rankedFirst = rankSamples(first);
  if (!rankedFirst.length) return { best: null, ranked: [], bytes, stages: { first: 0, second: 0 } };

  const second = [];
  await Promise.all(rankedFirst.slice(0, finalists).map(async (mirror) => {
    if (budgetLeft() <= 0) return;
    let best = null;
    for (let i = 0; i < finalAttempts; i++) {
      if (budgetLeft() <= 0) break;
      try {
        const sample = await measureOnce(mirror, { timeoutMs: Math.min(timeoutMs, Math.max(1000, budgetLeft())), maxBytes: stage2Bytes, fetchImpl });
        bytes += sample.bytes;
        if (!best || rankSamples([best, sample])[0] === sample) best = sample;
      } catch { /* keep the best attempt that did answer */ }
    }
    if (best) second.push({ ...mirror, ...best });
  }));

  // If the careful round produced nothing (all finalists failed), fall back to round 1's ranking.
  const ranked = second.length ? rankSamples(second) : rankedFirst;
  return { best: ranked[0] || null, ranked, bytes, stages: { first: rankedFirst.length, second: second.length } };
}

/**
 * Keep the current source unless the leader is meaningfully better — avoids flapping when two
 * sources are within `tolerance` of each other.
 */
export function chooseWithHysteresis(ranked, { current = null, tolerance = 0.15 } = {}) {
  if (!ranked?.length) return null;
  if (!current) return ranked[0];
  const held = ranked.find((m) => m.id === current);
  if (!held) return ranked[0];
  const leader = ranked[0];
  if (leader.id === current) return leader;
  const rate = (m) => m.bytesPerSec || 0;
  return rate(held) > 0 && rate(leader) < rate(held) * (1 + tolerance) ? held : leader;
}

// ---- cache (storage-agnostic: pass localStorage, a Map-like, or nothing) -------------------------

export const PICK_CACHE_KEY = 'sp.mirror.pick';
export const PICK_TTL_MS = 6 * 60 * 60 * 1000;

/** A stored pick is reusable while it is fresh and still names a source present in the list. */
export function isFresh(record, { ttlMs = PICK_TTL_MS, now = Date.now() } = {}) {
  return !!record && typeof record.at === 'number' && typeof record.id === 'string' && now - record.at >= 0 && now - record.at < ttlMs;
}

export function readPick(storage, { key = PICK_CACHE_KEY, ttlMs = PICK_TTL_MS, now = Date.now() } = {}) {
  try {
    const record = JSON.parse(storage?.getItem(key) || 'null');
    return isFresh(record, { ttlMs, now }) ? record : null;
  } catch {
    return null;
  }
}

export function writePick(storage, { id, ranked = [] }, { key = PICK_CACHE_KEY, now = Date.now } = {}) {
  const record = { id, at: now(), ranked: ranked.map((m) => ({ id: m.id, bytesPerSec: m.bytesPerSec, ttfbMs: m.ttfbMs })) };
  try { storage?.setItem(key, JSON.stringify(record)); } catch { /* private mode / quota: caching is optional */ }
  return record;
}

/** The source to actually use: a fresh cached pick if it is still in the list, else `pickStaged`. */
export async function resolveSource(mirrors, { storage = null, requireAssets = true, allowRelay = false, ...opts } = {}) {
  const cached = readPick(storage);
  const usable = eligibleMirrors(mirrors, { requireAssets, allowRelay });
  if (cached) {
    const hit = usable.find((m) => m.id === cached.id);
    if (hit) return { best: hit, ranked: usable, fromCache: true, bytes: 0 };
  }
  const picked = await pickStaged(mirrors, { requireAssets, allowRelay, ...opts });
  if (picked.best && storage) writePick(storage, picked);
  return { ...picked, fromCache: false };
}

/**
 * Rewrite a manifest's asset URLs to the chosen mirror. The published manifests point at the
 * primary origin; a consumer that picked another one only needs to swap the base.
 */
export function rebaseManifest(text, { from, to }) {
  const source = String(from).replace(/\/+$/, '');
  const target = String(to).replace(/\/+$/, '');
  return text.split(source).join(target);
}
