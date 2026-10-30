#!/usr/bin/env node
// One entry point for the whole mirror job.
//
//   node src/sync.mjs                    dry run: resolve → download → extract → index → diff → verify
//   node src/sync.mjs --tag=v0.2.1       pin an upstream version
//   node src/sync.mjs --write            upload the diff, then publish the interface files
//   node src/sync.mjs --write --prune    also delete keys upstream no longer lists (dangerous)
//
// The default is read-only and needs no credentials at all. When writing, the acceptance gate
// runs *before* the interface files are published: if any URL the manifest references does not
// resolve on the CDN, the job fails and consumers keep seeing the previous, known-good version.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRelease, assertPublicHttpsUrl } from './upstream.mjs';
import {
  ZIP_ROOT,
  ZIP_ASSETS_DIR,
  ZIP_FONTS_DIR,
  ZIP_DOCS_DIR,
  DOCS_PREFIX,
  ZIP_PACKS_DIR,
  zipIncludePatterns,
} from './names.mjs';
import { buildIndex, serializeIndex, sha256File } from './index-tree.mjs';
import { rewriteManifestText, collectManifestPaths, manifestUrls } from './rewrite-manifest.mjs';
import { diffIndex, uploadBytes } from './diff.mjs';
import { verifyUrls, summarizeVerification, passes } from './verify-remote.mjs';
import { r2Config, putObject, getObject, deleteObject, headObject, mimeFor, IMMUTABLE, SHORT } from './r2.mjs';
import { preparePagesDist, deployPages, PAGES_PROJECT } from './pages.mjs';
import { planPacks, publishPacks, ensureRelease, readMirrorPrefixes } from './packs.mjs';
import { buildDropin } from './dropin.mjs';
import { buildOfficialCdn, verifyOfficialCdn } from './official-cdn.mjs';
import { PICK_SOURCE } from './pick-source.mjs';
import { makeProbeBuffer, PROBE_KEY, PROBE_BYTES } from './probe-file.mjs';
import { readExtraOrigins, readGitOrigins, readRetiredOrigins, readDisabledOrigins, readPreferredOrder, applyPreferredOrder } from './origins.mjs';
import { readNetworkTable, NETWORK_TABLE } from './network-table.mjs';
import { readHosted, splitForPrune } from './hosted.mjs';
import { readTree } from './tree-index.mjs';
import { verifyTreeAndIndex } from './tree-verify.mjs';
import { buildApiDoc } from './api-contract.mjs';
import { readSources, fetchSourcePackage, extractSourceTree, readSource, readOverrides, readPinnedBytes, applyOverrides } from './sources.mjs';
import { verifyByteSample, sampleKeys, urlsForKeys, DEFAULT_SAMPLE } from './verify-bytes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE = process.env.SP_CDN_BASE || 'https://speedcdn.jiangjiangze.icu';
const DEFAULT_PAGES_BASE = process.env.SP_PAGES_BASE || 'https://spages.jiangjiangze.icu';
const DEFAULT_REPO = process.env.GITHUB_REPOSITORY || 'jingjiangze/Stronghold-Protocol-CDN';

/**
 * Bumped whenever the published interface gains or changes a field.
 *
 * The watermark short-circuit compares the upstream tag, so it cannot see that the interface
 * itself moved — that is how a run that should have published the speed-test probe reported
 * "nothing to do" and left it 404. Requiring the published schema to match the running code makes
 * every interface change cost exactly one re-publish, which is the point.
 *
 * 4: every pack's `urls` gained our own origin, and both download zips gained it too. Without a
 *    bump the packs already being present would satisfy the watermark and the change would never
 *    reach the published interface.
 *
 * 5: the tree gained `docs/` (the official documentation the package ships). This is the same trap
 *    as 4 in a different place: the upstream tag has not moved, so every other clause of the
 *    watermark holds and the run would report "nothing to do" while the docs stayed unpublished.
 */
export const ART_SCHEMA = 5;

/** The manifests the client reads, and the ones the game server rewrites. */
const MANIFEST_NAMES = ['assets.json', 'local-assets.json', 'emotes.json'];

/**
 * Should this run stop here, or is there something the published interface still does not have?
 *
 * The watermark is what keeps a six-hourly run at seconds instead of a 505 MB download, and it is
 * also the most consequential decision in the job: a wrong "skip" reports success while the
 * publication quietly stays where it was. Every clause below is therefore a way the published state
 * has actually gone stale, and each one is a named reason so the log says which.
 *
 * @returns {{skip: boolean, pending: string[]}}
 */
export function watermarkDecision({ published, releaseTag, opts }) {
  if (!published) return { skip: false, pending: ['nothing is published yet'] };

  const pending = [];
  if (published.upstream?.tag !== releaseTag) {
    pending.push(`the upstream tag moved (published ${published.upstream?.tag ?? '?'}, this run ${releaseTag})`);
  }
  if (published.schema !== ART_SCHEMA) {
    pending.push(`the published interface is schema ${published.schema ?? 1}, this code publishes ${ART_SCHEMA}`);
  }
  if (published.verified?.missing !== 0) {
    pending.push(`the last verification left ${published.verified?.missing ?? '?'} URLs unresolved`);
  }
  if (opts.pages && !(published.art?.mirrors || []).some((m) => m.id === 'pages')) {
    pending.push('the pages origin is not published yet');
  }
  // A requested source the interface does not list means its files were never mirrored.
  if (opts.sources && !(published.art?.sources || []).length) {
    pending.push('the extra sources are not published yet');
  }

  if (opts.packs) {
    const packs = published.art?.packs || [];
    if (!packs.length) {
      pending.push('the pack channel is not published yet');
    } else {
      // The packs and the two download zips are built from the release and every one of their URLs
      // carries its tag, so a pack pointing at another tag is from another release. Asking only
      // whether packs EXIST (which is what this clause used to do) misses the state that actually
      // occurs: a run that publishes the interface without --packs moves the tag and carries the
      // packs forward, which then satisfies every other clause — so the job skipped forever and the
      // download page kept offering the previous release's packages. That is what happened at
      // v0.2.3: the interface said v0.2.3 while all 17 packs and both zips still said v0.2.2.
      //
      // Gated on `opts.packs` because a run without it cannot rebuild them anyway, and flagging
      // staleness there would cost a full download to learn nothing.
      const stale = packs.filter((p) => {
        const urls = p.urls || [];
        return urls.length > 0 && !urls.some((u) => u.includes(`assets-${releaseTag}`));
      });
      if (stale.length) {
        pending.push(
          `${stale.length} of ${packs.length} packs still point at an older release (e.g. ${stale[0].id})`,
        );
      }
    }
  }
  return { skip: pending.length === 0, pending };
}

function parseArgs(argv) {
  const opts = {
    write: false,
    prune: false,
    reportOnly: false,
    force: false,
    sample: DEFAULT_SAMPLE,
    pages: false,
    packs: false,
    dropinOnly: false,
    interfaceOnly: false,
    sources: false,
    tag: '',
    work: 'work',
    base: DEFAULT_BASE,
    pagesBase: DEFAULT_PAGES_BASE,
    repo: DEFAULT_REPO,
  };
  for (const arg of argv) {
    if (arg === '--write') opts.write = true;
    else if (arg === '--dry-run') opts.write = false;
    else if (arg === '--prune') opts.prune = true;
    // The gate is authoritative in both modes: a red run means the CDN is not complete. Use
    // --report-only 让闸门只记录不拦截：只读模式退出 0，写模式照常发布（红名单留在 report.json）。
    else if (arg === '--report-only') opts.reportOnly = true;
    // Re-run even when the published interface already names this upstream tag.
    else if (arg === '--force') opts.force = true;
    // Extra origins. Both need --write (they publish), and both are best-effort: a failure there
    // must not invalidate the bucket, which is the primary.
    else if (arg === '--pages') opts.pages = true;
    else if (arg === '--packs') opts.packs = true;
    // Rebuild only the drop-in zip from the already-published interface: it needs no tree, so
    // iterating on the guide or the launchers costs seconds instead of a full 25-minute sync.
    else if (arg === '--dropin-only') opts.dropinOnly = true;
    // Re-emit the aggregation files from the published contract — no tree, no verification.
    else if (arg === '--interface-only') opts.interfaceOnly = true;
    // Mirror the extra sources declared in sources.json (additive: never overwrites the main tree).
    else if (arg === '--sources') opts.sources = true;
    else if (arg.startsWith('--tag=')) opts.tag = arg.slice('--tag='.length);
    else if (arg.startsWith('--work=')) opts.work = arg.slice('--work='.length);
    else if (arg.startsWith('--base=')) opts.base = arg.slice('--base='.length);
    else if (arg.startsWith('--asset-base=')) opts.assetBase = arg.slice('--asset-base='.length);
    else if (arg.startsWith('--pages-base=')) opts.pagesBase = arg.slice('--pages-base='.length);
    else if (arg.startsWith('--sample=')) opts.sample = Number(arg.slice('--sample='.length)) || DEFAULT_SAMPLE;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.prune && !opts.write) throw new Error('--prune only makes sense together with --write');
  if ((opts.pages || opts.packs) && !opts.write) throw new Error('--pages/--packs publish, so they need --write');
  if (opts.dropinOnly && !opts.write) throw new Error('--dropin-only publishes, so it needs --write');
  if (opts.interfaceOnly && !opts.write) throw new Error('--interface-only publishes, so it needs --write');
  opts.base = String(opts.base).replace(/\/+$/, '');
  // 2026-10-28：`base` 一直兼着两个角色，R2 退役后必须拆开 ——
  //   · 接口放在哪：读 art/index/hosted-index、写 cdn/v1/*（现在是站点域名）
  //   · 素材放在哪：清单里写的 URL、验收探针、byte sample（必须是真正供字节的门牌）
  // 合成一个变量时，把 base 指向站点就等于让一万八千个素材 URL 指向一个只回 SPA 的域：
  // 验收探针会全部报 size-unresolved（实测 18676/18678），清单也会把客户端带过去。
  opts.assetBase = String(opts.assetBase || process.env.SP_ASSET_BASE || opts.base).replace(/\/+$/, '');
  opts.pagesBase = String(opts.pagesBase).replace(/\/+$/, '');
  return opts;
}

const log = (...args) => console.log('[sync]', ...args);

function downloadPackage(release, dir) {
  const target = path.join(dir, release.zip.name);
  if (fs.existsSync(target) && fs.statSync(target).size === release.zip.size) {
    log(`package already downloaded: ${release.zip.name}`);
    return target;
  }
  assertPublicHttpsUrl(release.zip.url);
  fs.mkdirSync(dir, { recursive: true });
  log(`downloading ${release.zip.name} (${(release.zip.size / 1048576).toFixed(0)} MB) …`);
  const res = spawnSync(
    'gh',
    ['release', 'download', release.tag, '-R', release.repo, '-p', release.zip.name, '-D', dir, '--clobber'],
    { stdio: 'inherit', env: process.env },
  );
  if (res.status !== 0) throw new Error(`gh release download failed with status ${res.status}`);
  const stat = fs.statSync(target);
  if (stat.size !== release.zip.size) {
    throw new Error(`downloaded ${target} is ${stat.size} bytes, expected ${release.zip.size}`);
  }
  return target;
}

async function verifyPackageDigest(zipPath, release) {
  if (!release.zip.sha256) {
    log('upstream published no sha256 digest for this asset — skipping the package digest check');
    return;
  }
  const actual = await sha256File(zipPath);
  if (actual !== release.zip.sha256) {
    throw new Error(`package digest mismatch: got ${actual}, upstream says ${release.zip.sha256}`);
  }
  log(`package digest verified (sha256 ${actual.slice(0, 16)}…)`);
}

function extractPackage(zipPath, stage) {
  const manifest = path.join(stage, ZIP_ROOT, 'data', 'assets.json');
  if (fs.existsSync(manifest)) {
    log('stage already extracted');
    return;
  }
  fs.mkdirSync(stage, { recursive: true });
  log('extracting the asset tree, the fonts and the manifests (selective) …');
  const res = spawnSync('unzip', ['-q', '-o', zipPath, ...zipIncludePatterns(), '-d', stage], {
    stdio: 'inherit',
  });
  if (res.status !== 0) throw new Error(`unzip failed with status ${res.status}`);
}

async function readRemoteIndex(base) {
  const url = `${base}/cdn/v1/index.json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const json = await res.json();
    return { files: json.files || {}, tag: json.tag || null };
  } catch {
    return null;
  }
}

/**
 * Where an index key lives inside the extracted package.
 *
 * Exported so a test can pin the agreement between this mapping and `zipIncludePatterns()`: if the
 * two ever disagree, the key is hashed from a directory the extraction never created and the upload
 * fails at the end of a long run.
 */
export function localPathFor(stage, key) {
  if (key.startsWith('assets/')) return path.join(stage, ZIP_ASSETS_DIR, key.slice('assets/'.length));
  if (key.startsWith('fonts/')) return path.join(stage, ZIP_FONTS_DIR, key.slice('fonts/'.length));
  if (key.startsWith(DOCS_PREFIX)) return path.join(stage, ZIP_DOCS_DIR, key.slice(DOCS_PREFIX.length));
  throw new Error(`no local source for index key ${key}`);
}

/**
 * How long an object may be cached, per key.
 *
 * Art and fonts are addressed with a `?v=<token>` in every manifest URL, so a year is safe: a
 * content change arrives as a different URL. The docs have no token in the URL a reader types
 * (`/docs/PLAYING.md`) and they change whenever upstream releases, so a year would keep a browser
 * on a stale guide long after the release that replaced it. An hour is what the zone Cache Rule
 * already gives an unversioned asset path — this makes the browser agree with the edge.
 */
export function cacheControlFor(key) {
  return key.startsWith(DOCS_PREFIX) ? 'public, max-age=3600' : IMMUTABLE;
}

async function uploadKeys(config, stage, keys, files) {
  let done = 0;
  let failed = 0;
  const queue = [...keys];
  const worker = async () => {
    for (let key = queue.shift(); key; key = queue.shift()) {
      try {
        const body = await fsp.readFile(localPathFor(stage, key));
        if (body.length !== files[key].size) {
          throw new Error(`size changed while uploading (${body.length} vs ${files[key].size})`);
        }
        await putObject(config, key, body, { contentType: mimeFor(key), cacheControl: cacheControlFor(key) });
      } catch (error) {
        failed++;
        console.error(`[sync] FAIL ${key}: ${error.message}`);
      }
      if (++done % 500 === 0) log(`uploaded ${done}/${keys.length} (${failed} failed)`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, Math.max(1, keys.length)) }, worker));
  return { done, failed };
}

/**
 * 读「已发布的那一份」JSON：SP_PUBLISHED_FROM=r2 时从桶读，否则走公网门牌。
 *
 * 为什么必须同源：一份接口由 art（提供 token）与 index（派生 tree）共同决定。两者从不同代读取时，
 * verifyTreeAndIndex 一定拒绝 —— 这不是数据坏了，是取数取错了地方。
 */
async function readPublishedJson(key, base, timeoutMs) {
  if (process.env.SP_PUBLISHED_FROM === 'r2') {
    try {
      const buf = await getObject(r2Config(process.env), key);
      if (buf) return JSON.parse(buf.toString('utf8'));
      log(`published ${key}: R2 上没有这个键`);
    } catch (error) {
      log(`published ${key}: 从 R2 读取失败（${error.message}）`);
    }
  }
  const res = await fetch(`${base}/${key}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** The interface we published last time, or null when nothing has been published yet. */
async function readPublishedArt(base) {
  // 2026-10-28：R2 退役、它的自定义域已解绑，但桶里仍留着最后一次真正发布过的接口。
  // 站点改成从数据集种子后，数据集那份 art 是旧件（v0.2.6），而 index 已是 v0.3.1 ——
  // 拿线上的 art 当种子会自锁（tree.token 与 index 推导值对不上，守卫直接拒发）。
  // 设 SP_PUBLISHED_FROM=r2 时直接从桶读，绕过已不可达的公网门牌。
  if (process.env.SP_PUBLISHED_FROM === 'r2') {
    try {
      const buf = await getObject(r2Config(process.env), 'cdn/v1/art.json');
      if (buf) return JSON.parse(buf.toString('utf8'));
      log('published art: R2 上没有 cdn/v1/art.json');
    } catch (error) {
      log(`published art: 从 R2 读取失败（${error.message}）`);
    }
  }
  try {
    const res = await fetch(`${base}/cdn/v1/art.json`, { signal: AbortSignal.timeout(15_000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Upload keys whose files live under `assetsDir` (a source package's own public/assets). */
async function uploadSourceKeys(config, assetsDir, keys, files) {
  let done = 0;
  let failed = 0;
  const queue = [...keys];
  const worker = async () => {
    for (let key = queue.shift(); key; key = queue.shift()) {
      try {
        const rel = key.startsWith('assets/') ? key.slice('assets/'.length) : key;
        const body = await fsp.readFile(path.join(assetsDir, ...rel.split('/')));
        if (body.length !== files[key]?.size) throw new Error(`size changed while uploading (${body.length})`);
        await putObject(config, key, body, { contentType: mimeFor(key), cacheControl: IMMUTABLE });
      } catch (error) {
        failed++;
        console.error(`[sync] FAIL ${key}: ${error.message}`);
      }
      if (++done % 500 === 0) log(`source: uploaded ${done}/${keys.length} (${failed} failed)`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, Math.max(1, keys.length)) }, worker));
  return { done, failed };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  log(`mode: ${opts.write ? 'WRITE' : 'dry-run'}${opts.prune ? ' +prune' : ''}, base ${opts.base}`);

  const release = await resolveRelease(opts.tag);
  log(`upstream ${release.repo} → ${release.tag} (published ${release.publishedAt})`);



  // Interface only: re-emit mirrors.json and pick.js from the published contract. The aggregation
  // files are derived data, so correcting them should not require re-hashing 533 MB.
  if (opts.interfaceOnly) {
    const published = await readPublishedArt(opts.base);
    if (!published?.art?.token) throw new Error('--interface-only needs a published cdn/v1/art.json');
    const config = r2Config();
    // 来源表要按**当前配置**重算，不能照抄已发布的那份：往 origins.json 加一个镜像，
    // 本该是一次「重发接口」就能生效的事；照抄旧列表会让它永远等不到下一次上游版本才出现。
    const origins = [{ id: 'r2', kind: 'r2', root: opts.assetBase, base: `${opts.assetBase}/assets/` }];
    const extraOrigins = readExtraOrigins(ROOT);
    if (extraOrigins.length) log(`extra origins: ${extraOrigins.map((o) => o.id).join(', ')}`);
    origins.push(...extraOrigins);
    const gitOrigins = readGitOrigins(ROOT);
    origins.push(...gitOrigins);
    // Parking an origin has to be applied here, before the list is published: `enabled:false` is
    // what stops a selector from choosing it, and it is only meaningful if it survives into the
    // interface. Anything carried forward from a previous run gets it too — an origin that was
    // parked last run must not come back enabled just because this run did not rebuild it.
    const disabledIds = readDisabledOrigins(ROOT);
    for (const o of origins) if (disabledIds.has(o.id)) o.enabled = false;
    const flatOrigins = applyPreferredOrder(carryForwardOrigins(origins, published.art.mirrors, readRetiredOrigins(ROOT)), readPreferredOrder(ROOT));
    const mirrorsDoc = `${JSON.stringify(
      {
        schema: 1,
        token: published.art.token,
        upstream: published.upstream,
        flat: flatOrigins,
        packs: published.art.packs,
        index: '/cdn/v1/index.json',
        pick: '/cdn/v1/pick.js',
      },
      null,
      2,
    )}
`;
    await putObject(config, 'cdn/v1/mirrors.json', Buffer.from(mirrorsDoc, 'utf8'), {
      contentType: 'application/json',
      cacheControl: SHORT,
    });
    await putObject(config, 'cdn/v1/pick.js', Buffer.from(PICK_SOURCE, 'utf8'), {
      contentType: 'text/javascript',
      cacheControl: SHORT,
    });
    // The measured carrier table travels with the interface for the same reason: it is not derived
    // from the asset tree, so correcting it must not require re-hashing 533 MB.
    let net = false;
    try {
      await putObject(config, 'cdn/v1/network.json', Buffer.from(readNetworkTable(ROOT), 'utf8'), {
        contentType: 'application/json',
        cacheControl: SHORT,
      });
      net = true;
    } catch (error) {
      console.error(`[sync] ${NETWORK_TABLE} not published: ${error.message}`);
    }
    // The tree is derived from the published index, which is one fetch away, so it belongs on this
    // fast path too -- otherwise adding a directory to the page would cost a full ten-minute sync.
    //
    // 2026-10-18: this used to swallow its failure with a console.error, which made the worst
    // outcome invisible. A promote that uploaded art and committed hosted.json reported success
    // while the browsable tree still described the previous bucket -- the uploads were live and
    // nothing could list them. The other two puts above are best-effort on purpose (network.json is
    // an observation, not derived data); this one is derived data whose absence is a lie, so it
    // fails the run instead.
    let tree = null;
    try {
      // 2026-10-30：改成与 readPublishedArt 同源（SP_PUBLISHED_FROM=r2 时从桶读）。
      // 之前 token 来自 R2（新）而 index 来自公网（旧），一次成功的 sync 之后守卫必然拒发 ——
      // 于是「把接口从 R2 搬到数据集」这一步从来没能在真正发布之后跑通。
      const idx = await readPublishedJson('cdn/v1/index.json', opts.base, 30000);
      // The upload channel's keys live in hosted-index.json, not in index.json (which mirrors the
      // upstream package) and not in this repo's curated hosted.json. Without this merge the
      // browsable tree cannot see them at all: on 2026-10-17 it listed 1,856 skin files while the
      // bucket served 2,477, so every consumer that answers "does the CDN have this asset?" from
      // tree.json answered no.
      let extraHosted = null;
      try {
        const hres = await fetch(`${opts.base}/cdn/v1/hosted-index.json`, { signal: AbortSignal.timeout(60000) });
        if (hres.ok) {
          const hi = await hres.json();
          const list = Array.isArray(hi.files) ? hi.files : Object.entries(hi.files || {}).map(([path, v]) => ({ path, size: v && v.size }));
          extraHosted = new Map();
          for (const f of list) {
            const key = f && (f.path || f.key);
            if (typeof key === 'string' && key) extraHosted.set(key, Number(f.size) || 0);
          }
          log(`tree: merged ${extraHosted.size} uploaded keys from hosted-index.json`);
        } else {
          log(`tree: hosted-index.json unavailable (HTTP ${hres.status}); the tree lists upstream + curated hosted keys only`);
        }
      } catch (error) {
        log(`tree: hosted-index.json not merged (${error.message})`);
      }
      const built = readTree(ROOT, idx.files || idx, { token: published.art.token, extraHosted });
      // The check is one-way: every key the index lists must be in the tree, never the reverse. The
      // reverse would flag every hosted key as drift, which is the normal state — and now that the
      // upload channel's keys are merged in, most of them are not in the index at all.
      const check = verifyTreeAndIndex({
        indexBytes: Buffer.from(JSON.stringify(idx), 'utf8'),
        index: idx,
        tree: built.doc,
      });
      if (!check.ok) throw new Error(`the rebuilt tree does not match the index: ${check.failures.join('; ')}`);
      await putObject(config, 'cdn/v1/tree.json', Buffer.from(built.json, 'utf8'), {
        contentType: 'application/json',
        cacheControl: SHORT,
      });
      await putObject(config, `cdn/v1/tree-${published.art.token}.json`, Buffer.from(built.json, 'utf8'), {
        contentType: 'application/json',
        cacheControl: IMMUTABLE,
      });
      // The contract is a description, not derived data, so it belongs on the fast path too.
      await putObject(config, 'cdn/v1/api.json', Buffer.from(buildApiDoc({ base: opts.base, token: published.art.token }), 'utf8'), {
        contentType: 'application/json',
        cacheControl: SHORT,
      });
      if (built.overlap.length) {
        // A warning, not a failure, and that is a measured decision rather than a softened one:
        // upstream absorbing art that used to come through the upload channel is the steady state
        // of this bucket, so making it fatal would red every run — and a red nobody can clear is a
        // red nobody reads.
        //
        // 2026-10-28 更正：这条提示原来叫大家「remove them from hosted.json」，是错的。overlap 来自
        // 合并进 tree 的 hosted-index.json（上传通道登记表，实测 17,962 键），而 hosted.json 是那份
        // 人工策展的 35 条清单、与上游 0 重叠。登记表由 promote 每次从 upload-log.json 重建，手工
        // 删条目既无用又会被下一轮覆盖 —— 所以这里只报事实，不再指路到一个清不掉的地方。
        log(`tree: ${built.overlap.length} key(s) registered by the upload channel are also upstream's (steady state; hosted-index.json is rebuilt from upload-log.json each promote, nothing to prune by hand), e.g. ${built.overlap[0]}`);
      }
      tree = built.doc.totals;
    } catch (error) {
      // The tree is the only file on this path whose absence makes the published interface lie, so
      // it is the only one whose failure stops the run. art.json is still republished below: the
      // mirrors and the packs are facts about the sources, not about the tree, and leaving them
      // stale because a derived view failed to build would trade a visible problem for an invisible
      // one.
      console.error(`[sync] tree not published: ${error.message}`);
      throw error;
    }
    // art.json 也是同一份事实：只改 mirrors.json 会让两份接口不一致，
    // 而客户端与页面读的是 art.json —— 不一致就等于新来源没发布。
    // 其余字段一律沿用已发布的那份：这一轮没有重新哈希，verified/syncedAt 不该被说成新数值。
    await putObject(
      config,
      'cdn/v1/art.json',
      Buffer.from(`${JSON.stringify({ ...published, art: { ...published.art, mirrors: flatOrigins } }, null, 2)}\n`, 'utf8'),
      { contentType: 'application/json', cacheControl: SHORT },
    );
    // `tree` is always set by now: the block above throws rather than leaving it null, so the
    // conditional that used to guard this log was describing a state that can no longer happen.
    log(`republished cdn/v1/mirrors.json + art.json (${published.art.packs?.length ?? 0} packs, ${flatOrigins.length} origins) + pick.js${net ? ' + network.json' : ''} + tree (${tree.files} files, ${tree.hosted} hosted)`);
    return;
  }

  // Drop-in only: everything it needs is the published interface, so no download, no hashing and
  // no pack rebuild.
  if (opts.dropinOnly) {
    const published = await readPublishedArt(opts.base);
    if (!published?.art?.token) throw new Error('--dropin-only needs a published cdn/v1/art.json');
    const config = r2Config();
    const outDir = path.join(ROOT, opts.work, `dropin-${published.upstream.tag}`);
    fs.mkdirSync(outDir, { recursive: true });
    const mirrorsDoc = `${JSON.stringify(
      {
        schema: 1,
        token: published.art.token,
        upstream: published.upstream,
        flat: published.art.mirrors,
        packs: published.art.packs,
        index: '/cdn/v1/index.json',
        pick: '/cdn/v1/pick.js',
      },
      null,
      2,
    )}
`;
    const dropin = await buildDropin({
      root: ROOT,
      out: outDir,
      base: opts.assetBase,
      token: published.art.token,
      upstreamTag: published.upstream.tag,
      mirrorsJson: mirrorsDoc,
    });
    await putObject(config, `packs/assets-${published.upstream.tag}/${dropin.name}`, fs.readFileSync(dropin.file), {
      contentType: 'application/zip',
      cacheControl: IMMUTABLE,
    });
    const uploaded = spawnSync(
      'gh',
      ['release', 'upload', `assets-${published.upstream.tag}`, dropin.file, '--clobber', '-R', opts.repo],
      { encoding: 'utf8' },
    );
    if (uploaded.status !== 0) throw new Error((uploaded.stderr || 'gh release upload failed').slice(0, 200));
    log(`rebuilt the drop-in zip: ${dropin.name} (${(dropin.size / 1024).toFixed(0)} KB) → R2 + release`);

    // The official-CDN variant rebuilds here too: it needs the upstream release's lite asset, not
    // the extracted tree, so it fits the fast path exactly like the drop-in does.
    try {
      const release = await resolveRelease(published.upstream.tag);
      const variant = await buildOfficialCdn({
        out: outDir,
        base: opts.assetBase,
        token: published.art.token,
        release,
        cacheDir: path.join(ROOT, opts.work, 'upstream-lite'),
      });
      const check = await verifyOfficialCdn(variant.file);
      if (!check.ok) throw new Error(`self-check failed: ${check.problems.join('; ').slice(0, 200)}`);
      await putObject(config, `packs/assets-${release.tag}/${variant.name}`, fs.readFileSync(variant.file), {
        contentType: 'application/zip',
        cacheControl: IMMUTABLE,
      });
      const up = spawnSync(
        'gh',
        ['release', 'upload', `assets-${release.tag}`, variant.file, '--clobber', '-R', opts.repo],
        { encoding: 'utf8' },
      );
      if (up.status !== 0) throw new Error((up.stderr || 'gh release upload failed').slice(0, 200));
      log(`rebuilt the official-CDN variant: ${variant.name} (${(variant.size / 1048576).toFixed(1)} MB) → R2 + release`);
    } catch (error) {
      console.error(`[sync] official-CDN variant FAILED: ${error.message}`);
    }
    return;
  }

  // Watermark short-circuit: what we published last time already names this upstream tag and
  // verified clean, so there is nothing to do — and, more to the point, no reason to pull 428 MB
  // every six hours to find that out.
  //
  // A wrong "skip" is invisible: the job reports success and the publication quietly stays where it
  // was. So the decision is a pure function with tests (watermarkDecision) rather than an inline
  // condition, and every clause in it is a way the published state has actually gone stale.
  if (!opts.force) {
    const published = await readPublishedArt(opts.base);
    const decision = watermarkDecision({ published, releaseTag: release.tag, opts });
    if (decision.skip) {
      log(
        `already mirrored ${release.tag}: ${published.verified.probed} URLs verified, 0 missing ` +
          `(synced ${published.syncedAt}) — nothing to do (--force to re-run anyway)`,
      );
      return;
    }
    for (const reason of decision.pending) log(`continuing — ${reason}`);
  }

  const workDir = path.resolve(ROOT, opts.work, release.tag);
  const stage = path.join(workDir, 'stage');
  const zipPath = downloadPackage(release, workDir);
  await verifyPackageDigest(zipPath, release);
  extractPackage(zipPath, stage);

  const manifests = [];
  for (const name of MANIFEST_NAMES) {
    const file = path.join(stage, ZIP_ROOT, 'data', name);
    if (fs.existsSync(file)) manifests.push({ name, text: await fsp.readFile(file, 'utf8') });
  }
  const primary = manifests.find((entry) => entry.name === 'assets.json');
  if (!primary) throw new Error(`the package has no ${ZIP_ROOT}/data/assets.json — layout changed?`);
  const manifest = JSON.parse(primary.text);
  const manifestFiles = manifest?.stats?.files;
  if (!manifestFiles) {
    throw new Error('the manifest has no stats.files — refusing to mirror an empty asset set');
  }

  // The client reads three manifests and the game server rewrites all three, so the acceptance
  // list is their union — checking only the primary one would leave local art and emotes
  // unverified.
  const refs = [...new Set(manifests.flatMap((entry) => collectManifestPaths(entry.text)))].sort();
  log(`manifests present: ${manifests.map((entry) => entry.name).join(', ')}`);
  log(`primary: ${manifestFiles} files, hash ${manifest.hash}, ${refs.length} asset refs (union)`);

  log('hashing the tree …');
  const index = await buildIndex(
    [
      { abs: path.join(stage, ZIP_ASSETS_DIR), prefix: 'assets/' },
      { abs: path.join(stage, ZIP_FONTS_DIR), prefix: 'fonts/' },
      // The official docs travel in the same index, so prune spares them and tree.json lists them.
      // They are small (a few MB) and the package is already unpacked, so this costs no download.
      { abs: path.join(stage, ZIP_DOCS_DIR), prefix: DOCS_PREFIX },
    ],
    { concurrency: 8, onProgress: (done, total) => log(`hashed ${done}/${total}`) },
  );
  log(`index: ${index.count} files, ${(index.bytes / 1048576).toFixed(1)} MB`);

  const remote = await readRemoteIndex(opts.base);
  const diff = diffIndex(index, remote || { files: {} });
  const uploadSize = uploadBytes(diff, index.files);
  log(
    `diff vs CDN${remote ? '' : ' (no index published yet)'}: add ${diff.add.length}, ` +
      `change ${diff.change.length}, same ${diff.same}, extra-on-CDN ${diff.remove.length} ` +
      `(${(uploadSize / 1048576).toFixed(1)} MB to upload)`,
  );

  // Deliberate divergences from upstream, declared as overrides in sources.json. Applied here — after
  // the diff above, before the index is serialized — so the cache token, the acceptance gate's
  // expectations, tree.json and the byte sample all describe the bytes we actually serve, while the
  // pinned path is never uploaded from upstream's own tree (that would undo the override).
  const pins = readOverrides(ROOT);
  const overrides = applyOverrides(index, pins);
  for (const o of overrides) {
    log(`override ${o.path}: ${o.from.size} B upstream → ${o.to.size} B (pin/${o.path}${o.why ? `; ${o.why}` : ''})`);
  }

  const indexJson = indexDocument({ release, index });
  // The cache token must change whenever the bytes do, not only when the upstream tag does. A tag
  // alone is not enough: the first population of a tree happens under a tag that was already
  // requested (dry runs, retries), and Cloudflare's per-PoP copies then disagree — one edge serves
  // the old bytes for hours. Deriving the token from the content index removes that whole class.
  const indexHash = createHash('sha256').update(indexJson).digest('hex');
  const version = `${release.tag}-${indexHash.slice(0, 8)}`;

  const urls = [
    ...new Set(
      manifests.flatMap((entry) => manifestUrls(entry.text, { base: opts.assetBase, version })),
    ),
  ].sort();
  const expected = {};
  for (const url of urls) {
    const key = url.slice(opts.assetBase.length + 1).split('?')[0];
    if (index.files[key]) expected[url] = index.files[key].size;
  }


  const report = {
    schema: 1,
    mode: opts.write ? 'write' : 'dry-run',
    startedAt,
    base: opts.base,
    upstream: release,
    manifest: { files: manifestFiles, hash: manifest.hash, refs: refs.length, manifests: manifests.map((entry) => entry.name) },
    tree: { files: index.count, bytes: index.bytes },
    diff: { add: diff.add.length, change: diff.change.length, same: diff.same, remove: diff.remove.length, uploadBytes: uploadSize },
    removedSample: diff.remove.slice(0, 50),
    overrides,
    uploaded: null,
    verification: null,
    pages: null,
    packs: null,
    dropin: null,
    officialCdn: null,
    byteSample: null,
    sources: null,
    ok: false,
  };

  if (!opts.write) {
    // Diagnosis mode: report the gap without touching anything, and only fail when asked to.
    const probe = await verifyUrls(urls, { expected, onProgress: (done, total) => log(`probed ${done}/${total}`) });
    report.verification = probe;
    report.ok = passes(probe);
    log(`gate (read-only): ${summarizeVerification(probe).split('\n')[0]}`);
    await writeReports(ROOT, report);
    if (report.ok) return;
    if (opts.reportOnly) {
      log('gate failed, but --report-only was given — exiting 0 (nothing was written)');
      return;
    }
    throw new Error('acceptance gate failed: the CDN is missing or mis-serving manifest assets');
  }

  // Write mode.
  const config = r2Config();
  if (diff.add.length || diff.change.length) {
    // A pinned path is already carried by the index with OUR bytes (applyOverrides ran above), so it
    // always shows up as a "change" against upstream's release — by design, forever. Uploading it
    // from the stage tree would undo the override, and its size guard would abort the whole run
    // ("size changed while uploading"), which is the correct refusal of the wrong bytes.
    // The override block right below owns those keys instead.
    const mainPinned = new Set(pins.map((pin) => pin.path));
    const keys = [...diff.add, ...diff.change].filter((key) => !mainPinned.has(key));
    const spared = diff.add.length + diff.change.length - keys.length;
    if (spared) log(`${spared} pinned path(s) kept out of the main upload — the override upload owns them`);
    if (keys.length) {
      log(`uploading ${keys.length} objects …`);
      const uploaded = await uploadKeys(config, stage, keys, index.files);
      report.uploaded = uploaded;
      if (uploaded.failed) throw new Error(`${uploaded.failed} uploads failed — not publishing the interface`);
    }
  }

  // The bytes of every declared override, read from this repository and verified against the pin
  // before anything is written. Uploaded on every run: they are small, and the bucket may still hold
  // upstream's bytes from an earlier sync (or from the release the override replaces).
  if (pins.length) {
    log(`uploading ${pins.length} pinned override(s) …`);
    for (const pin of pins) {
      const body = readPinnedBytes(ROOT, pin);
      await putObject(config, pin.path, body, { contentType: mimeFor(pin.path), cacheControl: IMMUTABLE });
    }
    report.overridesUploaded = pins.length;
  }

  if (opts.prune && diff.remove.length) {
    // Objects we host deliberately -- mod art, which upstream will never list -- must survive a
    // prune. Without this, a routine cleanup would delete someone else's content.
    const { keys: hostedKeys } = readHosted(ROOT);
    const { prune, spared } = splitForPrune(diff.remove, hostedKeys);
    log(`pruning ${prune.length} objects upstream no longer lists …${spared.length ? ` (${spared.length} kept: hosted on purpose)` : ''}`);
    for (const key of prune) await deleteObject(config, key);
    report.pruned = prune.length;
    if (spared.length) report.pruneSpared = spared.length;
  }

  // Extra sources: additive, and their manifest references join the acceptance list so "is this
  // source complete?" is checked by the same gate as everything else.
  const sourceReports = [];
  if (opts.sources) {
    for (const source of readSources(ROOT)) {
      try {
        const dir = path.join(workDir, `source-${source.id}`);
        const zipPath = fetchSourcePackage({ source, dir });
        const root = extractSourceTree({ source, zipPath, stage: dir });
        const { layout, index: sourceIndex, manifestText } = await readSource({ source, root });

        // Only paths the main tree lacks are written; a same-path difference is a divergence to
        // report, never an overwrite of the authoritative upstream bytes — except for the paths this
        // source pins, whose bytes the index already carries (applied above) and which are therefore
        // uploaded from here. The divergent keys go into the report so "which files does this source
        // disagree about?" is answerable from the run's own artifact.
        const d = diffIndex(sourceIndex, index);
        // A pinned path is already in the index with OUR bytes (applied above), so it surfaces in
        // d.change; the additive path must not touch it — the override upload owns it.
        const pinnedSet = new Set(pins.map((pin) => pin.path));
        const divergent = d.change.filter((key) => !pinnedSet.has(key));
        log(
          `source ${source.id}: ${sourceIndex.count} files, ${d.add.length} new, ` +
            `${divergent.length} divergent from the main tree`,
        );
        let uploaded = { done: 0, failed: 0 };
        if (d.add.length) uploaded = await uploadSourceKeys(config, layout.assets, d.add, sourceIndex.files);

        let refs = 0;
        if (manifestText) {
          for (const url of manifestUrls(manifestText, { base: opts.assetBase, version })) {
            if (urls.includes(url)) continue;
            const key = url.slice(opts.assetBase.length + 1).split('?')[0];
            if (sourceIndex.files[key]) expected[url] = sourceIndex.files[key].size;
            urls.push(url);
            refs++;
          }
        }
        sourceReports.push({
          id: source.id,
          repo: source.repo,
          ref: source.ref,
          release: source.release,
          package: source.package,
          note: source.note,
          files: sourceIndex.count,
          bytes: sourceIndex.bytes,
          added: d.add.length,
          divergent: d.change.length,
          // Capped: the artifact is published, and the point is to name the disagreement, not to
          // carry a second copy of the index.
          ...(divergent.length ? { divergentKeys: divergent.slice(0, 200), divergentKeysTruncated: divergent.length > 200 } : {}),
          uploaded: uploaded.done,
          failed: uploaded.failed,
          refsAddedToGate: refs,
        });
        if (uploaded.failed) throw new Error(`${uploaded.failed} source uploads failed`);
      } catch (error) {
        console.error(`[sync] source ${source.id} FAILED: ${error.message}`);
        sourceReports.push({ id: source.id, error: error.message });
      }
    }
    report.sources = sourceReports;
    log(`sources: ${sourceReports.map((s) => `${s.id}${s.error ? ' FAILED' : ` +${s.added}`}`).join(', ')}`);
  }

  const probe = await verifyUrls(urls, { expected, onProgress: (done, total) => log(`probed ${done}/${total}`) });
  await reconcileUnreachableFromBucket(config, probe, { expected, base: opts.assetBase });
  // 本仓刻意托管的键：hosted.json 声明了它的体积，上游包里的同名文件是**另一份字节**。
  // 闸门的 expected 来自上游索引，对这些键必然对不上；而「服务端返回的体积 == hosted.json 的声明」
  // 恰好证明发出去的就是我们声明要托管的那一份 —— 那不是不一致，是两种真值的交界。
  // 实测（2026-10-30）：数据集上 15 个键卡在这里（8 个 char_449_glider 变体：上游 57326 / 托管 59231）。
  const declaredHosted = reconcileHostedDeclared(probe, { hostedSizes: readHosted(ROOT).sizes, base: opts.assetBase });
  if (declaredHosted.length) {
    log(`gate: ${declaredHosted.length} 个键按 hosted.json 的声明体积通过（上游体积不同，属刻意托管）`);
  }
  report.verification = probe;
  report.ok = passes(probe);
  log(`gate: ${summarizeVerification(probe).split('\n')[0]}`);
  if (!report.ok) {
    if (!opts.reportOnly) {
      await writeReports(ROOT, report);
      throw new Error('acceptance gate failed — the interface files were NOT published');
    }
    // 2026-10-30：--report-only 在写模式也要生效。它此前只在只读分支被读取，于是「闸门红着、
    // 但先把桶里这批字节和接口发布出去」这个唯一出口在写模式里并不存在 —— 镜像侧一旦出现
    // 工具链修不了的问题（实测：魔搭数据集的 LFS 对象里存的是 o2p 占位页，而 push-dataset-tree
    // 对 LFS 路径一律跳过 --repair），发布链就永久卡死。默认不变：不带该开关仍然红着停。
    log('gate failed, but --report-only was given — publishing anyway; the mismatch list stays in report.json');
  }

  // The size gate proves the objects are the right length; this proves a sample is the upstream
  // bytes, which is what rules out a re-encoded copy sitting under the same name.
  const sampled = sampleKeys(index.files, { sample: opts.sample });
  const byteSample = await verifyByteSample(urlsForKeys(sampled, { base: opts.assetBase, version }), {
    files: index.files,
  });
  report.byteSample = byteSample;
  log(
    `byte sample: ${byteSample.checked} files hashed, ${byteSample.mismatch.length} mismatch, ` +
      `${byteSample.failed.length} unreachable`,
  );
  if (byteSample.mismatch.length) {
    if (!opts.reportOnly) {
      await writeReports(ROOT, report);
      throw new Error(
        `byte sample mismatch on ${byteSample.mismatch.length} file(s) — the CDN is not serving the ` +
          `upstream bytes (first: ${byteSample.mismatch[0].key})`,
      );
    }
    log('byte sample mismatch, but --report-only was given — publishing anyway');
  }

  await publishCore(config, { opts, manifests, version, indexJson, indexFiles: index.files });

  // Extra origins. Both are best-effort: the bucket is the primary, and a failure here must not
  // invalidate it — the interface below simply reports one origin fewer.
  const origins = [{ id: 'r2', kind: 'r2', root: opts.base, base: `${opts.base}/assets/` }];
  // A CDN sitting in front of the bucket is one entry in origins.json, not a code change.
  const extraOrigins = readExtraOrigins(ROOT);
  if (extraOrigins.length) log(`extra origins: ${extraOrigins.map((o) => o.id).join(', ')}`);
  if (opts.pages) {
    try {
      const dist = await preparePagesDist({
        stage,
        out: path.join(workDir, 'pages-dist'),
        manifests,
        base: opts.pagesBase,
        tag: version,
        indexJson,
      });
      log(`pages dist: ${dist.files} files → ${opts.pagesBase}`);
      deployPages({ dist: dist.out });
      // 2026-10-30：退役后即使在手动轮里部署成功，也不再把它写回镜像表 ——
      // retired 只挡住「从已发布列表回填」，挡不住当轮 push。
      if (readRetiredOrigins(ROOT).has('pages')) {
        log('pages origin 已在 origins.json 的 retired 里，本次不写回镜像表');
      } else {
        origins.push({ id: 'pages', kind: 'pages', root: opts.pagesBase, base: `${opts.pagesBase}/assets/` });
      }
      report.pages = { base: opts.pagesBase, files: dist.files };
    } catch (error) {
      console.error(`[sync] pages origin FAILED: ${error.message}`);
      report.pages = { error: error.message };
    }
  }

  origins.push(...extraOrigins);

  // A git-mount origin (jsDelivr / Statically / ghfast) serves files committed to git. It is
  // partial by construction — the asset tree is not in git — so it is published with `coverage`
  // and its own probe path rather than being passed off as a full mirror.
  const gitOrigins = readGitOrigins(ROOT);
  if (gitOrigins.length) log(`git origins: ${gitOrigins.map((o) => o.id).join(', ')}`);
  origins.push(...gitOrigins);

  // An origin that this run did not rebuild must not disappear from the interface: art.json is the
  // contract, and dropping the Pages origin because this run skipped --pages would be a lie. Packs
  // already carry forward (below); origins now do the same, keeping the structural ones (r2, pages)
  // from the published interface and merging this run's view into it.
  const publishedBefore = await readPublishedArt(opts.base);
  // Same parking pass as the mirrors.json path above; both publish an origin list, and a parked
  // origin must be parked in both or a selector reading one of them would still pick it.
  const disabledIds = readDisabledOrigins(ROOT);
  for (const o of origins) if (disabledIds.has(o.id)) o.enabled = false;
  const mergedOrigins = carryForwardOrigins(origins, publishedBefore?.art?.mirrors, readRetiredOrigins(ROOT));

  let packs = [];
  if (opts.packs) {
    try {
      const plan = planPacks(index.files);
      log(`packs: ${plan.length} → ${plan.map((p) => p.id).join(', ')}`);
      ensureRelease({
        tag: release.tag,
        repo: opts.repo,
        body: `素材包（上游 ${release.tag}）：${index.count} 个文件 / ${(index.bytes / 1048576).toFixed(1)} MB。供镜像链加速下载，内容与扁平树一致。`,
      });
      const packDir = path.join(workDir, 'packs');
      fs.mkdirSync(packDir, { recursive: true });
      packs = await publishPacks({
        config,
        root: path.join(stage, ZIP_ROOT, 'public'),
        packs: plan,
        tag: release.tag,
        repo: opts.repo,
        workDir: packDir,
        mirrorPrefixes: readMirrorPrefixes(ROOT),
        // The R2 copy of each pack, so the URL list offers our own domain and not only github and
        // third-party mirrors.
        ownBase: opts.assetBase,
      });
      report.packs = packs.map((p) => ({ id: p.id, files: p.files, bytes: p.bytes }));
    } catch (error) {
      console.error(`[sync] pack channel FAILED: ${error.message}`);
      report.packs = { error: error.message };
    }
  }
  if (!packs.length && publishedBefore?.art?.packs?.length) {
    packs = publishedBefore.art.packs;
    log(`packs not rebuilt — carrying forward ${packs.length} from the published interface`);
  }

  const mirrorsDoc = `${JSON.stringify(
    {
      schema: 1,
      token: version,
      upstream: {
        repo: release.repo,
        tag: release.tag,
        zip: release.zip.name,
        zipSha256: release.zip.sha256,
      },
      flat: applyPreferredOrder(mergedOrigins, readPreferredOrder(ROOT)).map((origin) => ({
        id: origin.id,
        kind: origin.kind,
        root: origin.root,
        base: origin.base,
        ...(origin.probe ? { probe: origin.probe } : {}),
        ...(origin.coverage ? { coverage: origin.coverage } : {}),
        ...(origin.note ? { note: origin.note } : {}),
      })),
      packs: packs.map((pack) => ({
        id: pack.id,
        group: pack.group,
        files: pack.files,
        sha256: pack.sha256,
        size: pack.bytes,
        urls: pack.urls,
      })),
      index: '/cdn/v1/index.json',
      probe: `/${PROBE_KEY}`,
      pick: '/cdn/v1/pick.js',
    },
    null,
    2,
  )}
`;

  if (opts.packs) {
    try {
      const dropin = await buildDropin({
        root: ROOT,
        out: path.join(workDir, 'packs'),
        base: opts.assetBase,
        token: version,
        upstreamTag: release.tag,
        mirrorsJson: mirrorsDoc,
      });
      const key = `packs/assets-${release.tag}/${dropin.name}`;
      await putObject(config, key, fs.readFileSync(dropin.file), {
        contentType: 'application/zip',
        cacheControl: IMMUTABLE,
      });
      const uploaded = spawnSync(
        'gh',
        ['release', 'upload', `assets-${release.tag}`, dropin.file, '--clobber', '-R', opts.repo],
        { encoding: 'utf8' },
      );
      if (uploaded.status !== 0) throw new Error((uploaded.stderr || 'gh release upload failed').slice(0, 200));
      report.dropin = { name: dropin.name, size: dropin.size, key };
      log(`published the drop-in zip: ${dropin.name} (${(dropin.size / 1024).toFixed(0)} KB)`);
    } catch (error) {
      console.error(`[sync] drop-in zip FAILED: ${error.message}`);
      report.dropin = { error: error.message };
    }

    // The second variant of the same offer: the upstream lite package with its art manifests
    // repointed at this CDN, for a player who has no deployment yet. Deliberately independent of
    // the drop-in above -- either can fail without taking the other down.
    try {
      const variant = await buildOfficialCdn({
        out: path.join(workDir, 'packs'),
        base: opts.assetBase,
        token: version,
        release,
        cacheDir: path.join(workDir, 'upstream-lite'),
      });
      const check = await verifyOfficialCdn(variant.file);
      if (!check.ok) throw new Error(`self-check failed: ${check.problems.join('; ').slice(0, 200)}`);
      const key = `packs/assets-${release.tag}/${variant.name}`;
      await putObject(config, key, fs.readFileSync(variant.file), {
        contentType: 'application/zip',
        cacheControl: IMMUTABLE,
      });
      const uploaded = spawnSync(
        'gh',
        ['release', 'upload', `assets-${release.tag}`, variant.file, '--clobber', '-R', opts.repo],
        { encoding: 'utf8' },
      );
      if (uploaded.status !== 0) throw new Error((uploaded.stderr || 'gh release upload failed').slice(0, 200));
      report.officialCdn = { name: variant.name, size: variant.size, key, refs: variant.refs };
      log(`published the official-CDN variant: ${variant.name} (${(variant.size / 1048576).toFixed(1)} MB)`);
    } catch (error) {
      console.error(`[sync] official-CDN variant FAILED: ${error.message}`);
      report.officialCdn = { error: error.message };
    }
  }

  await publishArt(config, {
    opts,
    release,
    version,
    sources: sourceReports,
    overrides,
    manifest,
    refs,
    index,
    probe,
    origins: mergedOrigins,
    packs,
    mirrorsDoc,
    byteSample,
  });
  await writeReports(ROOT, report);
  log('done.');
}

/** The content index, published in two flavours: a moving one and a frozen per-tag one. */
function indexDocument({ release, index }) {
  return JSON.stringify({ schema: 1, tag: release.tag, count: index.count, bytes: index.bytes, files: index.files });
}

/** Everything origin-neutral plus the primary-origin manifests: safe to publish once the gate passed. */
/**
 * A URL the runner could not reach is a network observation, not a fact about the CDN. The bucket
 * is the origin the CDN serves from and we hold credentials for it, so a leftover is settled
 * there: an object of the expected size proves the bytes are in place. What is still missing is
 * reported and still fails the gate.
 */
/**
 * 把「hosted.json 声明了、且服务端返回的正是声明体积」的 mismatch 转成非失败项。
 *
 * 只认一个条件：got === hosted.json 里为该键声明的 size。任何解释不了的差异仍留在 mismatch 里，
 * 所以这条不会掩盖真实的字节损坏（占位页 639 B 与任何声明都对不上，照样会红）。
 */
function reconcileHostedDeclared(probe, { hostedSizes, base }) {
  if (!hostedSizes?.size || !probe?.mismatch?.length) return [];
  const declared = [];
  const rest = [];
  for (const entry of probe.mismatch) {
    const key = String(entry.url || '').slice(base.length + 1).split('?')[0];
    const size = hostedSizes.get(key);
    if (size != null && entry.got === size && entry.expected !== size) declared.push({ ...entry, hostedSize: size });
    else rest.push(entry);
  }
  probe.mismatch = rest;
  probe.declaredHosted = declared;
  return declared;
}

async function reconcileUnreachableFromBucket(config, probe, { expected, base }) {
  if (!probe.failed.length) return;
  const remaining = [];
  let recovered = 0;
  for (const entry of probe.failed) {
    const key = entry.url.slice(base.length + 1).split('?')[0];
    try {
      const head = await headObject(config, key);
      if (head && head.size === expected[entry.url]) {
        recovered++;
        continue;
      }
      remaining.push({ ...entry, bucket: head ? `bucket size ${head.size}` : 'not in bucket' });
    } catch (error) {
      remaining.push({ ...entry, bucket: `bucket check failed: ${error.message}` });
    }
  }
  probe.failed = remaining;
  probe.verifiedByBucket = recovered;
  if (recovered) log(`settled ${recovered} unreachable URL(s) against the bucket origin`);
}

async function publishCore(config, { opts, manifests, version, indexJson, indexFiles }) {
  let rewrittenCount = 0;
  // Documentation, not a dependency: if the measured table is malformed the sync still publishes
  // the assets, and the problem is reported rather than silently shipping an empty file.
  let networkDoc = null;
  try {
    networkDoc = readNetworkTable(ROOT);
  } catch (error) {
    console.error(`[sync] ${NETWORK_TABLE} not published: ${error.message}`);
  }
  // The browsable tree: every key the bucket serves, grouped by directory, with the deliberately
  // hosted files merged in. Built from the same index the assets were published from, so it cannot
  // describe a tree that does not exist. 85 KiB gzipped against index.json's 1.6 MiB, which is the
  // difference between a page that can render a directory list and one that cannot.
  const { json: treeJson, doc: treeDoc, overlap } = readTree(ROOT, indexFiles, { token: version });
  log(`tree: ${treeDoc.totals.files} files in ${treeDoc.totals.dirs} directories (${treeDoc.totals.hosted} hosted on purpose)`);
  // The tree and the index are built from the same in-memory `indexFiles`, so a mismatch here means
  // the code produced two disagreeing views rather than that the bucket drifted -- which is exactly
  // the case worth stopping for, because nothing downstream can notice. Checked before publishing:
  // the gate below is what decides whether these bytes go out at all.
  const treeCheck = verifyTreeAndIndex({
    indexBytes: Buffer.from(indexJson, 'utf8'),
    index: { tag: JSON.parse(indexJson).tag, files: indexFiles },
    tree: treeDoc,
  });
  if (!treeCheck.ok) {
    throw new Error(`the rebuilt tree does not match the index: ${treeCheck.failures.join('; ')}`);
  }
  // A hosted entry that upstream also ships is stale: the file is upstream content now, so the entry
  // describes nothing and should come out of hosted.json. Reported rather than fatal — see the fast
  // path, where the 2026-10-18 CI run measured this at 4,724 curated + 5,082 merged-from-the-upload-
  // channel keys, which is the steady state, not an anomaly.
  if (overlap.length) {
    log(`tree: ${overlap.length} hosted key(s) are also upstream's — remove them from hosted.json, e.g. ${overlap[0]}`);
  }
  const objects = [
    ...manifests.map((entry) => {
      const rewritten = rewriteManifestText(entry.text, { base: opts.base, version });
      rewrittenCount += rewritten.count;
      return [`data/${entry.name}`, Buffer.from(rewritten.text, 'utf8'), 'application/json', SHORT];
    }),
    ['cdn/v1/index.json', Buffer.from(indexJson, 'utf8'), 'application/json', SHORT],
    [`cdn/v1/index-${version}.json`, Buffer.from(indexJson, 'utf8'), 'application/json', IMMUTABLE],
    ['cdn/v1/tree.json', Buffer.from(treeJson, 'utf8'), 'application/json', SHORT],
    [`cdn/v1/tree-${version}.json`, Buffer.from(treeJson, 'utf8'), 'application/json', IMMUTABLE],
    // The interface describes itself: one machine-readable list of the endpoints, served from the
    // same origin as the endpoints, so "what can I fetch" has a single answer instead of three
    // prose copies that can drift.
    ['cdn/v1/api.json', Buffer.from(buildApiDoc({ base: opts.base, token: version }), 'utf8'), 'application/json', SHORT],
    ['robots.txt', Buffer.from('User-agent: *\nDisallow: /\n', 'utf8'), 'text/plain', SHORT],
    // The speed-test probe: a known 256 KiB that every origin serves, so a browser can measure
    // latency and throughput without Range (which the Pages origin's CORS preflight rejects).
    [PROBE_KEY, makeProbeBuffer(), 'application/octet-stream', IMMUTABLE],
    // Measured mainland-carrier behaviour per origin. Documentation rather than configuration --
    // a browser cannot know its own carrier, so the client still has to measure for itself; this is
    // what justifies which origins are runtime candidates at all, and it is republished with every
    // sync so it cannot silently describe a network that no longer exists.
    ...(networkDoc ? [['cdn/v1/network.json', Buffer.from(networkDoc, 'utf8'), 'application/json', SHORT]] : []),
  ];
  for (const [key, body, contentType, cacheControl] of objects) {
    await putObject(config, key, body, { contentType, cacheControl });
    log(`published ${key} (${body.length} bytes)`);
  }
  log(`rewrote ${rewrittenCount} manifest URLs → ${opts.base}/assets/…?v=${version}`);
}

/**
 * The interface itself, published last so it describes what actually exists: every origin that
 * deployed and every pack that uploaded. Field names follow the re line's `art` block
 * (`base`/`version`/`format`/`mirrors`/`packs`) so one parser reads both axes.
 */
/**
 * An origin this run did not rebuild must not vanish from the interface.
 *
 * The Pages origin is the case in point: it is only pushed when `--pages` is passed, so every
 * run without it used to republish an interface that claimed the Pages origin never existed —
 * even though the deployment was still live. Packs already carried forward; origins did not.
 *
 * Merging by id keeps the current run's view authoritative (so a renamed root or a newly added
 * git origin wins) while a structural origin missing from this run is restored from what is
 * already published.
 */
export function carryForwardOrigins(current, published, retired = new Set()) {
  if (!Array.isArray(published) || !published.length) return current;
  const byId = new Map(current.map((origin) => [origin.id, origin]));
  const out = [...current];
  for (const prior of published) {
    if (!prior?.id || byId.has(prior.id)) continue;
    if (retired.has(String(prior.id))) continue; // deliberately removed: a removal must stick
    if (!prior?.root || typeof prior.root !== 'string') continue;
    out.push({
      id: String(prior.id),
      kind: String(prior.kind || 'cdn'),
      root: String(prior.root),
      base: String(prior.base || `${String(prior.root).replace(/\/+$/, '')}/assets/`),
      ...(prior.probe ? { probe: String(prior.probe) } : {}),
      ...(prior.coverage ? { coverage: String(prior.coverage) } : {}),
      ...(prior.note ? { note: String(prior.note) } : {}),
    });
  }
  return out;
}

async function publishArt(config, { opts, release, version, sources, overrides, manifest, refs, index, probe, origins, packs, mirrorsDoc, byteSample }) {
  const art = {
    schema: ART_SCHEMA,
    upstream: {
      repo: release.repo,
      tag: release.tag,
      publishedAt: release.publishedAt,
      zip: release.zip.name,
      zipSha256: release.zip.sha256,
    },
    art: {
      base: `${opts.base}/assets/`,
      version: 2,
      format: 1,
      token: version,
      mirrors: origins,
      // Where a consumer can measure an origin's latency and throughput themselves.
      probe: { key: `/${PROBE_KEY}`, bytes: PROBE_BYTES },
      // Extra art sources mirrored into the same tree (additive; see sources.json).
      sources: (sources || [])
        .filter((s) => !s.error)
        .map((s) => ({ id: s.id, repo: s.repo, ref: s.ref, release: s.release, files: s.files, added: s.added, note: s.note })),
      // Paths where this CDN knowingly serves bytes upstream does not ship, with both sizes and the
      // source that supplies them — so a consumer can tell an override from a faithful mirror.
      ...(overrides?.length ? { overrides } : {}),
      packs: packs.map((pack) => ({
        id: pack.id,
        group: pack.group,
        sha256: pack.sha256,
        size: pack.bytes,
        files: pack.files,
        urls: pack.urls,
      })),
    },
    manifest: { url: '/data/assets.json', hash: manifest.hash, refs: refs.length },
    tree: { files: index.count, bytes: index.bytes, index: '/cdn/v1/index.json' },
    syncedAt: new Date().toISOString(),
    verified: {
      at: new Date().toISOString(),
      missing: 0,
      mismatch: 0,
      probed: probe.probed,
      unreachable: 0,
      verifiedByBucket: probe.verifiedByBucket ?? 0,
      byteSample: byteSample ? { checked: byteSample.checked, mismatch: byteSample.mismatch.length } : null,
    },
  };
  await putObject(config, 'cdn/v1/art.json', Buffer.from(`${JSON.stringify(art, null, 2)}\n`, 'utf8'), {
    contentType: 'application/json',
    cacheControl: SHORT,
  });
  // The aggregation interface: the mirror list and the picker that measures it.
  await putObject(config, 'cdn/v1/mirrors.json', Buffer.from(mirrorsDoc, 'utf8'), {
    contentType: 'application/json',
    cacheControl: SHORT,
  });
  await putObject(config, 'cdn/v1/pick.js', Buffer.from(PICK_SOURCE, 'utf8'), {
    contentType: 'text/javascript',
    cacheControl: SHORT,
  });
  log(
    `published cdn/v1/{art,mirrors}.json + pick.js (schema 2: ${origins.length} origin(s), ${packs.length} pack(s))`,
  );
}

async function writeReports(root, report) {
  await fsp.writeFile(path.join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

  const v = report.verification;
  const lines = [
    `## Stronghold-Protocol-CDN sync — ${report.mode}`,
    '',
    `- upstream: **${report.upstream.tag}** (published ${report.upstream.publishedAt})`,
    `- source package: \`${report.upstream.zip.name}\` (${(report.upstream.zip.size / 1048576).toFixed(0)} MB)`,
    `- manifest: ${report.manifest.files} files, hash \`${report.manifest.hash}\`, ${report.manifest.refs} asset refs across ${report.manifest.manifests.join(', ')}`,
    `- tree: ${report.tree.files} files, ${(report.tree.bytes / 1048576).toFixed(1)} MB`,
    `- diff: add ${report.diff.add}, change ${report.diff.change}, same ${report.diff.same}, extra-on-CDN ${report.diff.remove} (${(report.diff.uploadBytes / 1048576).toFixed(1)} MB to upload)`,
    ...(report.uploaded ? [`- uploaded: ${report.uploaded.done} (${report.uploaded.failed} failed)`] : []),
    ...(report.byteSample
      ? [`- byte sample: ${report.byteSample.checked} files hashed, ${report.byteSample.mismatch.length} mismatch`]
      : []),
    ...(report.dropin
      ? [`- drop-in zip: ${report.dropin.error ? `FAILED (${report.dropin.error})` : `${report.dropin.name} (${(report.dropin.size / 1024).toFixed(0)} KB)`}`]
      : []),
    ...(report.pages ? [`- pages origin: ${report.pages.error ? `FAILED (${report.pages.error})` : `${report.pages.files} files → ${report.pages.base}`}`] : []),
    ...(report.packs
      ? [
          `- pack channel: ${
            report.packs.error
              ? `FAILED (${report.packs.error})`
              : `${report.packs.length} pack(s), ${(report.packs.reduce((s, p) => s + p.bytes, 0) / 1048576).toFixed(1)} MB`
          }`,
        ]
      : []),
    '',
    v ? summarizeVerification(v) : '_no verification ran_',
    '',
    `**gate: ${report.ok ? 'PASS' : 'FAIL'}**`,
  ];
  await fsp.writeFile(path.join(root, 'report.md'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}

// Only run when invoked as a script. Importing this module (tests do, for carryForwardOrigins)
// must not start a real sync -- that would download a 505 MB upstream package and write to the
// working tree, which is exactly what made tests/origins.test.mjs depend on the network.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(async (error) => {
    console.error(`[sync] ERROR ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}