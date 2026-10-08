// The acceptance gate: every URL the manifest references must resolve on the CDN.
//
// This is the check that turns "is the CDN complete?" into a boolean. It runs against the public
// CDN (no credentials), so it also catches problems the bucket itself cannot show: a missing
// object, a stale edge copy, a wrong content-length, or a redirect to somewhere unexpected.
//
// HEAD, not GET: we only need status and length, and HEAD keeps the edge cache warm anyway.

export const DEFAULT_CONCURRENCY = 24;

/** @returns {Promise<{probed:number, ok:number, missing:Array, mismatch:Array, failed:Array}>} */
export async function verifyUrls(urls, options = {}) {
  const {
    concurrency = DEFAULT_CONCURRENCY,
    timeoutMs = 20_000,
    attempts = 3,
    expected = null, // optional map url -> byte size
    fetchImpl = fetch,
  } = options;

  const missing = [];
  const mismatch = [];
  const failed = [];
  let ok = 0;
  let done = 0;
  const queue = [...urls];

  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      let lastError = null;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const res = await fetchImpl(url, {
            method: 'HEAD',
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) {
            missing.push({ url, status: res.status });
            lastError = null;
            break;
          }
          const size = Number(res.headers.get('content-length'));
          const want = expected?.[url];
          if (want != null && Number.isFinite(size) && size !== want) {
            mismatch.push({ url, expected: want, got: size });
          } else {
            ok++;
          }
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < attempts) await new Promise((r) => setTimeout(r, 300 * attempt));
        }
      }
      if (lastError) failed.push({ url, error: String(lastError.message || lastError) });
      if (++done % 500 === 0) options.onProgress?.(done, urls.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, urls.length)) }, worker),
  );

  return { probed: urls.length, ok, missing, mismatch, failed };
}

/** Compact markdown summary for the workflow step summary. */
export function summarizeVerification(result, { sample = 10 } = {}) {
  const lines = [
    `probed ${result.probed} URLs → ok ${result.ok}, missing ${result.missing.length}, mismatch ${result.mismatch.length}, unreachable ${result.failed.length}`,
  ];
  const show = (label, list, render) => {
    if (!list.length) return;
    lines.push('', `**${label}** (first ${Math.min(sample, list.length)} of ${list.length})`);
    for (const item of list.slice(0, sample)) lines.push(`- ${render(item)}`);
  };
  show('missing', result.missing, (m) => `${m.status} ${m.url}`);
  show('mismatch', result.mismatch, (m) => `${m.url} — expected ${m.expected} bytes, got ${m.got}`);
  show('unreachable', result.failed, (m) => `${m.url} — ${m.error}`);
  return lines.join('\n');
}
