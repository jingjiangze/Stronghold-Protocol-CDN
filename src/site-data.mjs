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
import { groupOf, readMirrorPrefixes } from './packs.mjs';

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

export const RELEASES_REPO = process.env.GITHUB_REPOSITORY || 'jingjiangze/Stronghold-Protocol-CDN';

/**
 * The two name patterns the page resolves its downloads by, and they must stay disjoint.
 *
 * The page must not hard-code a version: each zip is rebuilt whenever the guide, the launchers or
 * the stamped token change, and a stale link is worse than no link. Matching is by name, which the
 * pack assets (assets-*.zip) never collide with.
 *
 * The variant's pattern is anchored to `stronghold-official-cdn` rather than reusing the drop-in's
 * `stronghold-cdn` prefix: "stronghold-official-cdn-…" does not contain "stronghold-cdn" (the
 * substring is "official-cdn"), so the two cannot pick up each other's asset and put the wrong
 * download behind the wrong button.
 */
const DROPIN_PATTERN = /stronghold-cdn[^/]*\.zip$/i;
const OFFICIAL_CDN_PATTERN = /^stronghold-official-cdn[^/]*\.zip$/i;

/** The newest release asset whose name matches `pattern`, with the release it came from. */
export function pickReleaseAsset(releases, pattern) {
  const candidates = (releases || [])
    .map((release) => ({
      release,
      asset: (release.assets || []).find((asset) => pattern.test(asset.name || '')),
    }))
    .filter((entry) => entry.asset);
  if (!candidates.length) return null;
  candidates.sort((a, b) =>
    String(b.release.published_at || '').localeCompare(String(a.release.published_at || '')),
  );
  const { release, asset } = candidates[0];
  return {
    tag: release.tag_name,
    release: release.tag_name,
    name: asset.name,
    size: asset.size,
    url: asset.browser_download_url,
    publishedAt: release.published_at,
  };
}

/** The newest release asset that is this project's drop-in package. */
export function pickDropinAsset(releases) {
  return pickReleaseAsset(releases, DROPIN_PATTERN);
}

/** The newest release asset that is the "upstream lite package, CDN swapped to ours" variant. */
export function pickOfficialCdnAsset(releases) {
  return pickReleaseAsset(releases, OFFICIAL_CDN_PATTERN);
}

/** Attach the mirror prefixes as extra download URLs to a picked asset. */
function withMirrors(picked, prefixes) {
  if (!picked) return null;
  const bare = picked.url.replace(/^https:\/\//, '');
  return { ...picked, urls: [picked.url, ...prefixes.map((prefix) => `${String(prefix).replace(/\/+$/, '')}/${bare}`)] };
}

async function fetchReleases({ repo, token }) {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=20`;
  assertPublicHttpsUrl(url);
  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'stronghold-protocol-cdn-site',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** Both downloads in one API call: the page offers them side by side. */
export async function resolveReleaseAssets({
  repo = RELEASES_REPO,
  prefixes = [],
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
} = {}) {
  const releases = await fetchReleases({ repo, token });
  return {
    dropin: withMirrors(pickDropinAsset(releases), prefixes),
    officialCdn: withMirrors(pickOfficialCdnAsset(releases), prefixes),
  };
}

/** Resolve the drop-in alone, with the mirror prefixes attached as extra download URLs. */
export async function resolveDropin({ repo = RELEASES_REPO, prefixes = [], token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN } = {}) {
  return (await resolveReleaseAssets({ repo, prefixes, token })).dropin;
}

export async function buildSnapshot({ base, out, log = console.log }) {
  const root = String(base).replace(/\/+$/, '');
  const [art, mirrors, index] = await Promise.all([
    getJson(`${root}/cdn/v1/art.json`),
    getJson(`${root}/cdn/v1/mirrors.json`),
    getJson(`${root}/cdn/v1/index.json`),
  ]);

  // The download links are resolved here rather than in the page: api.github.com is unreliable from
  // the networks this site is for, and a visitor should never wait on it.
  let dropin = null;
  let officialCdn = null;
  try {
    ({ dropin, officialCdn } = await resolveReleaseAssets({ prefixes: readMirrorPrefixes(process.cwd()) }));
  } catch (error) {
    log(`site snapshot: could not resolve the download assets (${error.message}) — the page will link to Releases`);
  }

  const dirs = aggregate(index.files);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    cdnBase: root,
    art,
    mirrors,
    dropin,
    officialCdn,
    dirs,
    totals: { files: index.count ?? dirs.reduce((n, d) => n + d.files, 0), bytes: index.bytes ?? 0 },
  };

  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  log(
    `site snapshot: ${snapshot.totals.files} files, ${dirs.length} directories, ` +
      `drop-in ${dropin ? dropin.name : 'unresolved'} → ${out}`,
  );
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
