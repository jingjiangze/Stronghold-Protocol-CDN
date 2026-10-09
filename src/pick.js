// The aggregation endpoint's client half: given the published mirror list, measure the mirrors and
// hand back the fastest one. This is the piece that makes "which mirror" a runtime decision rather
// than a hard-coded host — a deployment in one network and a player in another do not agree.
//
// It is served from the CDN itself (cdn/v1/pick.js) and is dependency-free ES module code, so a
// consumer can either import it or paste the probe into their own loader.

/**
 * Race every mirror and return the fastest, with the full ranking.
 *
 * The probe path has to exist on EVERY origin, and no single path does: the R2/Pages origins carry
 * the `/cdn/v1/` interface, while a git-mount origin serves the repository and therefore answers
 * 502 on `/cdn/v1/probe.bin` and 404 on `/robots.txt` (measured: ghfast/gitcdn give 502 for
 * `/robots.txt` but 200 for `/probe/cdn-probe.bin`). So each mirror's own published `probe` wins
 * over the caller's default -- without that, every git mirror is thrown out as broken, which is
 * exactly the bug this used to have: the site's own speed test read `mirror.probe`, this did not.
 *
 * Two attempts per mirror, best time wins, so a cold connection is not the verdict.
 */
export async function pickFastest(mirrors, { path = '/robots.txt', attempts = 2, timeoutMs = 6000, fetchImpl = fetch } = {}) {
  const measure = async (mirror) => {
    // `root` is the origin; `base` is its /assets/ subtree. Probing the subtree would 404.
    const origin = String(mirror.root || mirror.base || '').replace(/\/+$/, '');
    const probePath = mirror.probe || path;
    let best = null;
    for (let i = 0; i < attempts; i++) {
      const started = Date.now();
      const res = await fetchImpl(`${origin}${probePath}?probe=${Date.now()}-${i}`, {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`${mirror.id}: HTTP ${res.status}`);
      const body = await res.arrayBuffer();
      // 200 is not enough on its own. A mirror that answers with a short body but no error has been
      // observed in this project, and it is the worst kind of failure: the status looks fine, the
      // first chunk is fine, and the caller only finds out much later. So compare what arrived
      // against what was declared, and treat a short read as a broken mirror.
      // ArrayBuffer, not Buffer: this module is served to browsers as well as imported by Node.
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared > 0 && body.byteLength !== declared) {
        throw new Error(`${mirror.id}: truncated ${body.byteLength}/${declared}`);
      }
      if (body.byteLength === 0) throw new Error(`${mirror.id}: empty body`);
      const ms = Date.now() - started;
      if (best == null || ms < best) best = ms;
    }
    return { ...mirror, ms: best };
  };

  const settled = await Promise.allSettled(mirrors.map(measure));
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
