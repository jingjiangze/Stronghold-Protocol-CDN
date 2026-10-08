// Build the site's deploy-time snapshot from the live interface.
//
// The page reads art.json and mirrors.json live, but the directory table needs the full index
// (1.3 MB) — too much to pull on every visit for a table that only changes when upstream releases.
// So it is aggregated here, at deploy time, and shipped with the site.
//
// Every URL is checked before it is requested: https only, and never a loopback/private/reserved
// host, so a tampered base cannot turn the build into a request forger.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertPublicHttpsUrl } from './upstream.mjs';
import { groupOf } from './packs.mjs';

async function getJson(url) {
  assertPublicHttpsUrl(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** Aggregate the flat index into per-directory totals, biggest first. */
export function aggregate(files) {
  const groups = new Map();
  for (const [key, entry] of Object.entries(files || {})) {
    const group = groupOf(key);
    const current = groups.get(group) || { prefix: `${group}/`, files: 0, bytes: 0 };
    current.files++;
    current.bytes += entry.size || 0;
    groups.set(group, current);
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes);
}

export async function buildSnapshot({ base, out, log = console.log }) {
  const root = String(base).replace(/\/+$/, '');
  const [art, mirrors, index] = await Promise.all([
    getJson(`${root}/cdn/v1/art.json`),
    getJson(`${root}/cdn/v1/mirrors.json`),
    getJson(`${root}/cdn/v1/index.json`),
  ]);

  const dirs = aggregate(index.files);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    cdnBase: root,
    art,
    mirrors,
    dirs,
    totals: { files: index.count ?? dirs.reduce((n, d) => n + d.files, 0), bytes: index.bytes ?? 0 },
  };

  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  log(`site snapshot: ${snapshot.totals.files} files, ${dirs.length} directories → ${out}`);
  return snapshot;
}

// CLI: node src/site-data.mjs [--base=https://…] [--out=site/data/snapshot.json]
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const base = arg('base', process.env.SP_CDN_BASE || 'https://weishucdn.jiangjiangze.icu');
  const out = path.resolve(arg('out', 'site/data/snapshot.json'));
  buildSnapshot({ base, out }).catch((error) => {
    console.error(`site-data: ${error.message}`);
    process.exit(1);
  });
}
