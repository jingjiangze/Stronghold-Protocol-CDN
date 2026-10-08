// Byte-level spot check: the size gate proves the CDN serves objects of the right length, but
// "right length" is not "the upstream bytes". This downloads a deterministic sample and compares
// sha256 against the index built from the release package, which is what rules out a re-encoded
// (lossy) copy having taken a file's place under the same name.
//
// The sample is deterministic so two runs check the same files, and it always includes the
// largest entries — the ones a transcode would shrink most.
import { createHash } from 'node:crypto';

export const DEFAULT_SAMPLE = 120;

/** Deterministic sample: the biggest files plus an even stride through the rest. */
export function sampleKeys(files, { sample = DEFAULT_SAMPLE } = {}) {
  const keys = Object.keys(files).sort();
  if (keys.length <= sample) return keys;
  const bySize = [...keys].sort((a, b) => files[b].size - files[a].size);
  const picked = new Set(bySize.slice(0, Math.floor(sample / 3)));
  const step = keys.length / sample;
  for (let n = 0; picked.size < sample && n <= keys.length; n++) {
    picked.add(keys[Math.min(keys.length - 1, Math.floor(n * step))]);
  }
  return [...picked].sort();
}

/**
 * @returns {Promise<{checked:number, mismatch:Array<{key,url,expected,got}>, failed:Array}>}
 */
export async function verifyByteSample(urls, { files, sample = DEFAULT_SAMPLE, fetchImpl = fetch } = {}) {
  const mismatch = [];
  const failed = [];
  let checked = 0;

  for (const url of urls) {
    const key = new URL(url).pathname.replace(/^\//, '');
    const want = files[key];
    if (!want) continue;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        failed.push({ key, url, status: res.status });
        continue;
      }
      const digest = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
      checked++;
      if (digest !== want.sha256) mismatch.push({ key, url, expected: want.sha256, got: digest });
    } catch (error) {
      failed.push({ key, url, error: String(error.message || error) });
    }
  }
  return { checked, mismatch, failed };
}

/** Absolute URLs for a set of index keys. */
export function urlsForKeys(keys, { base, version }) {
  const trimmed = String(base).replace(/\/+$/, '');
  const token = version ? `?v=${encodeURIComponent(version)}` : '';
  return keys.map((key) => `${trimmed}/${key}${token}`);
}
