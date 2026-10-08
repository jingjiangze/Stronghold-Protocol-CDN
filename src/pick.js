// The aggregation endpoint's client half: given the published mirror list, measure the mirrors and
// hand back the fastest one. This is the piece that makes "which mirror" a runtime decision rather
// than a hard-coded host — a deployment in one network and a player in another do not agree.
//
// It is served from the CDN itself (cdn/v1/pick.js) and is dependency-free ES module code, so a
// consumer can either import it or paste the probe into their own loader.

/** Race one small request per mirror; the first to answer wins, ties go to the earlier entry. */
export async function pickFastest(mirrors, { path = '/cdn/v1/mirrors.json', timeoutMs = 4000, fetchImpl = fetch } = {}) {
  const attempts = mirrors.map(async (mirror) => {
    const started = Date.now();
    const res = await fetchImpl(`${mirror.base.replace(/\/+$/, '')}${path}`, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${mirror.id}: HTTP ${res.status}`);
    await res.arrayBuffer();
    return { ...mirror, ms: Date.now() - started };
  });

  const settled = await Promise.allSettled(attempts);
  const ok = settled
    .filter((entry) => entry.status === 'fulfilled')
    .map((entry) => entry.value)
    .sort((a, b) => a.ms - b.ms);
  if (!ok.length) throw new Error('no mirror answered');
  return { best: ok[0], ranked: ok };
}

/** Measure every mirror without short-circuiting — for a UI that wants to show the numbers. */
export async function measureMirrors(mirrors, options) {
  const { ranked } = await pickFastest(mirrors, options);
  return ranked;
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
