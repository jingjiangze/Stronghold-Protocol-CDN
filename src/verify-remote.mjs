// The acceptance gate: every URL the manifests reference must resolve on the CDN.
//
// This is the check that turns "is the CDN complete?" into a boolean. It runs against the public
// CDN (no credentials), so it also catches what the bucket itself cannot show: a missing object,
// a stale edge copy, or a size that differs from the authoritative package.
//
// Sizing needs care. A plain HEAD is not reliable through an edge cache: on a cache miss
// Cloudflare can answer 200 with `content-length: 0` (observed for several small files during the
// first dry run). Taking that at face value produces false mismatches, so a zero/absent length is
// resolved with a one-byte ranged GET and read out of `content-range`. Only if that also fails do
// we record the URL as `unresolved` — reported, but not counted as a failure.

export const DEFAULT_CONCURRENCY = 24;

/** Real byte size of a 200 response, or null when the edge refuses to say. */
async function resolveSize(fetchImpl, url, timeoutMs) {
  const head = await fetchImpl(url, {
    method: 'HEAD',
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!head.ok) return { status: head.status, size: null };

  const headLength = Number(head.headers.get('content-length'));
  if (Number.isFinite(headLength) && headLength > 0) return { status: 200, size: headLength };

  const ranged = await fetchImpl(url, {
    method: 'GET',
    headers: { range: 'bytes=0-0' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!ranged.ok && ranged.status !== 206) return { status: ranged.status, size: null };

  let size = null;
  const contentRange = ranged.headers.get('content-range');
  const total = contentRange && /\/(\d+)\s*$/.exec(contentRange);
  if (total) size = Number(total[1]);
  if (size == null) {
    const length = Number(ranged.headers.get('content-length'));
    if (Number.isFinite(length) && length > 0) size = length;
  }
  // Drain the (one byte of) body so the connection can be reused.
  try {
    await ranged.arrayBuffer?.();
  } catch {
    /* the size is what we came for */
  }
  return { status: 200, size };
}

/** @returns {Promise<{probed:number, ok:number, missing:Array, mismatch:Array, failed:Array, unresolved:Array}>} */
export async function verifyUrls(urls, options = {}) {
  const {
    concurrency = DEFAULT_CONCURRENCY,
    timeoutMs = 20_000,
    attempts = 3,
    expected = null, // optional map url -> authoritative byte size
    fetchImpl = fetch,
  } = options;

  const missing = [];
  const mismatch = [];
  const failed = [];
  const unresolved = [];
  let ok = 0;
  let done = 0;
  const queue = [...urls];

  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      let lastError = null;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const { status, size } = await resolveSize(fetchImpl, url, timeoutMs);
          if (status !== 200) {
            missing.push({ url, status });
          } else if (size == null) {
            unresolved.push({ url });
          } else {
            const want = expected?.[url];
            if (want != null && size !== want) mismatch.push({ url, expected: want, got: size });
            else ok++;
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

  return { probed: urls.length, ok, missing, mismatch, failed, unresolved };
}

/** A result passes when nothing is absent, wrong-sized or unreachable. */
export function passes(result) {
  return result.missing.length === 0 && result.mismatch.length === 0 && result.failed.length === 0;
}

/** Compact markdown summary for the workflow step summary. */
export function summarizeVerification(result, { sample = 10 } = {}) {
  const lines = [
    `probed ${result.probed} URLs → ok ${result.ok}, missing ${result.missing.length}, ` +
      `mismatch ${result.mismatch.length}, unreachable ${result.failed.length}, ` +
      `size-unresolved ${result.unresolved?.length ?? 0}`,
  ];
  const show = (label, list, render) => {
    if (!list?.length) return;
    lines.push('', `**${label}** (first ${Math.min(sample, list.length)} of ${list.length})`);
    for (const item of list.slice(0, sample)) lines.push(`- ${render(item)}`);
  };
  show('missing', result.missing, (m) => `${m.status} ${m.url}`);
  show('mismatch', result.mismatch, (m) => `${m.url} — expected ${m.expected} bytes, got ${m.got}`);
  show('unreachable', result.failed, (m) => `${m.url} — ${m.error}`);
  show('size-unresolved', result.unresolved, (m) => m.url);
  return lines.join('\n');
}
