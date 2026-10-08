// Build the content index of an extracted tree: relative path -> { size, sha256 }.
//
// The index is both the interface the CDN publishes and the thing the next run diffs against,
// so it has to be deterministic: keys sorted, sha256 over the final bytes, and no timestamps or
// machine-specific values anywhere in it. Two runs on the same upstream package must produce
// byte-identical JSON.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Every file under `root`, as posix-style relative paths, sorted. */
export function walkFiles(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: nothing to index
    }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) out.push(child);
    }
  }
  return out.sort();
}

export function sha256File(abs) {
  const hash = createHash('sha256');
  return new Promise((resolve, reject) => {
    fs.createReadStream(abs)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/**
 * Index several subtrees into one map keyed by their published path.
 *
 * @param {{abs:string, prefix:string}[]} trees e.g. `{ abs: '<stage>/public/assets', prefix: 'assets/' }`
 * @param {{concurrency?:number, onProgress?:(done:number,total:number)=>void}} [options]
 * @returns {Promise<{files:Record<string,{size:number,sha256:string}>, count:number, bytes:number}>}
 */
export async function buildIndex(trees, { concurrency = 8, onProgress } = {}) {
  const jobs = [];
  for (const { abs, prefix } of trees) {
    for (const rel of walkFiles(abs)) jobs.push({ abs: path.join(abs, rel), key: prefix + rel });
  }
  jobs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const files = new Map();
  let bytes = 0;
  let done = 0;
  const queue = jobs.slice();

  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const stat = await fsp.stat(job.abs);
      const sha256 = await sha256File(job.abs);
      files.set(job.key, { size: stat.size, sha256 });
      bytes += stat.size;
      done++;
      if (onProgress && done % 500 === 0) onProgress(done, jobs.length);
    }
  };
  const workers = Math.max(1, Math.min(concurrency, jobs.length));
  await Promise.all(Array.from({ length: workers }, worker));

  const sorted = {};
  for (const key of [...files.keys()].sort()) sorted[key] = files.get(key);
  return { files: sorted, count: jobs.length, bytes };
}

/** Canonical serialization of an index (sorted keys, no whitespace) — safe to hash and compare. */
export function serializeIndex(files) {
  return JSON.stringify(files);
}
