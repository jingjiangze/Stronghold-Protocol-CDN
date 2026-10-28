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
import { buildDocsIndex } from './docs-index-build.mjs';

/** This file lives in `src/`, so the checkout root is one level up. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function getJson(url) {
  assertPublicHttpsUrl(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function getText(url) {
  assertPublicHttpsUrl(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

/**
 * R2 is only upload staging now (2026-10-28 用户指令), so the interfaces can no longer be seeded
 * from an R2 custom domain: its hostnames are unbound and a rebuild would fail. Try the seeds in
 * order — the ModelScope dataset carries `cdn/v1/*` and `data/*` at its root, and the site's own
 * deployed copy is the last resort — and fail loudly only when every seed is exhausted.
 */
export const DEFAULT_SEEDS = [
  'https://modelscope.cn/datasets/jingjiangze/Stronghold-Protocol-Assets/resolve/master',
  'https://downcdn.jiangjiangze.icu',
];

async function fromSeeds(seeds, rel, read) {
  const errors = [];
  for (const seed of seeds) {
    const url = `${String(seed).replace(/\/+$/, '')}/${rel}`;
    try {
      return await read(url);
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`every seed failed for ${rel}: ${errors.join(' | ')}`);
}

/**
 * The published art.json / mirrors.json are written by `sync.mjs` and, since 2026-10-24, nobody has
 * been able to republish them (sync is red, and R2 has no live hostname to serve a new copy from).
 * The copies still in circulation therefore advertise R2 origins that no longer exist.
 *
 * Rather than ship that, the site applies the repository's own decision — origins.json's `retired`
 * / `disabled` lists and `order` — to whatever copy it seeds from. The transform is idempotent, so
 * a fresh seed and an old one converge on the same output.
 */
export function retireOrigins(doc, origins) {
  if (!doc || typeof doc !== 'object') return doc;
  const retired = new Set(origins.retired || []);
  const disabled = new Set(origins.disabled || []);
  const roots = new Map(
    [...(origins.extraOrigins || []), ...(origins.gitOrigins || [])].map((o) => [o.id, o.root]),
  );
  const lead = (origins.order || []).find((id) => roots.has(id));
  const leadRoot = lead ? String(roots.get(lead)).replace(/\/+$/, '') : null;

  const out = structuredClone(doc);
  const art = out.art && typeof out.art === 'object' ? out.art : out;
  const prune = (list) => list
    .filter((m) => m && !retired.has(m.id))
    .map((m) => (disabled.has(m.id) ? { ...m, enabled: false } : m));
  if (Array.isArray(art.mirrors)) art.mirrors = prune(art.mirrors);
  // mirrors.json 发布的是 `flat` 数组（同一批条目，另一个形状）。
  if (Array.isArray(out.flat)) out.flat = prune(out.flat);
  // `base` is the assets/ prefix clients actually fetch from; it must not name a dead host.
  if (leadRoot && typeof art.base === 'string') art.base = `${leadRoot}/assets/`;
  if (leadRoot && out.art && typeof out.art.base === 'string') out.art.base = `${leadRoot}/assets/`;
  // token 不再追加后缀：接口已由 publish-interface 重生成（v0.3.1-e471f46d），tree-refresh 的守卫
  // 要求 art.token 与 index 推导值严格相等，加后缀反而会把自己判成陈旧。
  return out;
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

/**
 * Attach the download URLs to a picked asset.
 *
 * Packs are GitHub-only (2026-10-14 用户指令): the bytes live in a GitHub Release and every URL here
 * is that one download, either direct or through a mirror prefix that accelerates it. `ownBase` is
 * accepted so callers keep working, but it is deliberately ignored: the R2 bucket no longer holds
 * packs, so pointing at our own domain would 404.
 */
export function withMirrors(picked, prefixes, ownBase) {
  void ownBase;
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
  ownBase = '',
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
} = {}) {
  const releases = await fetchReleases({ repo, token });
  return {
    dropin: withMirrors(pickDropinAsset(releases), prefixes, ownBase),
    officialCdn: withMirrors(pickOfficialCdnAsset(releases), prefixes, ownBase),
  };
}

/** Resolve the drop-in alone, with the mirror prefixes attached as extra download URLs. */
export async function resolveDropin({ repo = RELEASES_REPO, prefixes = [], ownBase = '', token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN } = {}) {
  return (await resolveReleaseAssets({ repo, prefixes, ownBase, token })).dropin;
}

export async function buildSnapshot({ base, out, seeds = DEFAULT_SEEDS, log = console.log }) {
  const root = String(base).replace(/\/+$/, '');
  // 顺序很重要：数据集是接口的 durable 家（publish-interface 每次重生成都推它），站点自身那份
  // 只是上一次部署的副本 —— 排在前面会让旧件永久自我传染（实测：art 卡在 v0.2.6、index 已是
  // v0.3.1，tree-refresh 的守卫因此一直拒发）。所以 seeds 优先，base 只作兜底。
  const tries = [
    ...seeds.map((s) => String(s).replace(/\/+$/, '')).filter((s, i, a) => s && a.indexOf(s) === i),
    root,
  ];
  const [artRaw, mirrorsRaw, index] = await Promise.all([
    fromSeeds(tries, 'cdn/v1/art.json', getJson),
    fromSeeds(tries, 'cdn/v1/mirrors.json', getJson),
    fromSeeds(tries, 'cdn/v1/index.json', getJson),
  ]);
  // 种子里的镜像表可能还在宣传已经退役的源（R2），按仓库自己的决定抹掉，见 retireOrigins。
  let originDoc = {};
  try {
    originDoc = JSON.parse(await fsp.readFile(path.join(ROOT, 'origins.json'), 'utf8'));
  } catch (error) {
    log(`site snapshot: origins.json 读不到（${error.message}），镜像表原样发布`);
  }
  const dropped = (artRaw.mirrors || artRaw.art?.mirrors || []).filter((m) => m && (originDoc.retired || []).includes(m.id));
  if (dropped.length) log(`site snapshot: 按 retired 抹掉镜像 ${dropped.map((m) => m.id).join(', ')}`);
  const art = retireOrigins(artRaw, originDoc);
  const mirrors = retireOrigins(mirrorsRaw, originDoc);

  // The download links are resolved here rather than in the page: api.github.com is unreliable from
  // the networks this site is for, and a visitor should never wait on it.
  let dropin = null;
  let officialCdn = null;
  try {
    ({ dropin, officialCdn } = await resolveReleaseAssets({ prefixes: readMirrorPrefixes(process.cwd()), ownBase: root }));
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

  // 2026-10-13：清单也随部署落进站点同源目录（cdn/v1/*.json）。站点从此优先读同源，不再每次回源
  // R2（R2 上这些 JSON 是 cf-cache-status: DYNAMIC，等于每访客每文件一次 R2 读）。R2 那份保留作接口兜底。
  const manifestDir = path.join(path.dirname(out), '..', 'cdn', 'v1');
  await fsp.mkdir(manifestDir, { recursive: true });
  const manifests = { 'art.json': art, 'mirrors.json': mirrors, 'index.json': index };
  // rank.json 与 upload-log.json 过去只活在 R2：后台页头/状态里直接链它们，站点不部署就是 200 的
  // SPA 兜底 HTML（实测 /cdn/v1/rank.json 返回 text/html）。一并搬进同源副本。
  for (const name of ['api.json', 'network.json', 'tree.json', 'rank.json', 'upload-log.json', 'hosted-index.json']) {
    try { manifests[name] = await fromSeeds(tries, `cdn/v1/${name}`, getJson); }
    catch (error) { log(`site manifest: ${name} 跳过（${error.message}）`); }
  }
  let copied = 0;
  for (const [name, value] of Object.entries(manifests)) {
    if (!value) continue;
    await fsp.writeFile(path.join(manifestDir, name), `${JSON.stringify(value)}\n`, 'utf8');
    copied += 1;
  }
  log(`site manifest: 同源清单 ${copied} 份 → ${path.relative(process.cwd(), manifestDir)}`);

  // pick.js 与 data/*.json 过去只写 R2：R2 一旦只做暂存，它们就没有第二个落点，客户端脚本与三张
  // 清单会在全网 404。这里把它们也搬进部署目录，站点自身成为它们的兜底副本。
  try {
    const pick = await fromSeeds(tries, 'cdn/v1/pick.js', getText);
    await fsp.writeFile(path.join(manifestDir, 'pick.js'), pick, 'utf8');
    log('site manifest: pick.js → cdn/v1/pick.js');
  } catch (error) {
    log(`site manifest: pick.js 跳过（${error.message}）`);
  }
  const dataDir = path.dirname(out);
  let dataCopied = 0;
  for (const name of ['assets.json', 'local-assets.json', 'emotes.json']) {
    try {
      const text = await fromSeeds(tries, `data/${name}`, getText);
      await fsp.writeFile(path.join(dataDir, name), text, 'utf8');
      dataCopied += 1;
    } catch (error) {
      log(`site manifest: data/${name} 跳过（${error.message}）`);
    }
  }
  log(`site manifest: 客户端清单 ${dataCopied} 份 → ${path.relative(process.cwd(), dataDir)}`);

  // The docs index is rebuilt on every deploy, which is what makes "the newest document" a fact
  // rather than a path somebody has to remember to update. It is written beside the snapshot so the
  // admin page (and any agent) can read it from the same origin without a key.
  const docs = await buildDocsIndex({ siteDir: path.join(ROOT, 'site'), repoRoot: ROOT, log });
  await fsp.writeFile(path.join(path.dirname(out), 'docs.json'), `${JSON.stringify(docs, null, 2)}\n`, 'utf8');
  return snapshot;
}

// CLI: node src/site-data.mjs [--base=https://…] [--out=site/data/snapshot.json]
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const base = arg('base', process.env.SP_CDN_BASE || 'https://downcdn.jiangjiangze.icu');
  const out = path.resolve(arg('out', 'site/data/snapshot.json'));
  const seeds = arg('seeds', process.env.SP_SITE_SEEDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  buildSnapshot({ base, out, seeds: seeds.length ? seeds : DEFAULT_SEEDS }).catch((error) => {
    console.error(`site-data: ${error.message}`);
    process.exit(1);
  });
}
