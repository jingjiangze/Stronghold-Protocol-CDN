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
  ZIP_PACKS_DIR,
  zipIncludePatterns,
} from './names.mjs';
import { buildIndex, serializeIndex, sha256File } from './index-tree.mjs';
import { rewriteManifestText, collectManifestPaths, manifestUrls } from './rewrite-manifest.mjs';
import { diffIndex, uploadBytes } from './diff.mjs';
import { verifyUrls, summarizeVerification, passes } from './verify-remote.mjs';
import { r2Config, putObject, deleteObject, headObject, mimeFor, IMMUTABLE, SHORT } from './r2.mjs';
import { preparePagesDist, deployPages, PAGES_PROJECT } from './pages.mjs';
import { planPacks, publishPacks, ensureRelease, readMirrorPrefixes } from './packs.mjs';
import { buildDropin } from './dropin.mjs';
import { PICK_SOURCE } from './pick-source.mjs';
import { makeProbeBuffer, PROBE_KEY, PROBE_BYTES } from './probe-file.mjs';
import { readExtraOrigins, readGitOrigins } from './origins.mjs';
import { readSources, fetchSourcePackage, extractSourceTree, readSource } from './sources.mjs';
import { verifyByteSample, sampleKeys, urlsForKeys, DEFAULT_SAMPLE } from './verify-bytes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE = process.env.SP_CDN_BASE || 'https://weishucdn.jiangjiangze.icu';
const DEFAULT_PAGES_BASE = process.env.SP_PAGES_BASE || 'https://spages.jiangjiangze.icu';
const DEFAULT_REPO = process.env.GITHUB_REPOSITORY || 'jingjiangze/Stronghold-Protocol-CDN';

/**
 * Bumped whenever the published interface gains or changes a field.
 *
 * The watermark short-circuit compares the upstream tag, so it cannot see that the interface
 * itself moved — that is how a run that should have published the speed-test probe reported
 * "nothing to do" and left it 404. Requiring the published schema to match the running code makes
 * every interface change cost exactly one re-publish, which is the point.
 */
export const ART_SCHEMA = 3;

/** The manifests the client reads, and the ones the game server rewrites. */
const MANIFEST_NAMES = ['assets.json', 'local-assets.json', 'emotes.json'];

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
    // --report-only when the point is just to read the numbers.
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
    else if (arg.startsWith('--pages-base=')) opts.pagesBase = arg.slice('--pages-base='.length);
    else if (arg.startsWith('--sample=')) opts.sample = Number(arg.slice('--sample='.length)) || DEFAULT_SAMPLE;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.prune && !opts.write) throw new Error('--prune only makes sense together with --write');
  if ((opts.pages || opts.packs) && !opts.write) throw new Error('--pages/--packs publish, so they need --write');
  if (opts.dropinOnly && !opts.write) throw new Error('--dropin-only publishes, so it needs --write');
  if (opts.interfaceOnly && !opts.write) throw new Error('--interface-only publishes, so it needs --write');
  opts.base = String(opts.base).replace(/\/+$/, '');
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

function localPathFor(stage, key) {
  if (key.startsWith('assets/')) return path.join(stage, ZIP_ASSETS_DIR, key.slice('assets/'.length));
  if (key.startsWith('fonts/')) return path.join(stage, ZIP_FONTS_DIR, key.slice('fonts/'.length));
  throw new Error(`no local source for index key ${key}`);
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
        await putObject(config, key, body, { contentType: mimeFor(key), cacheControl: IMMUTABLE });
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

/** The interface we published last time, or null when nothing has been published yet. */
async function readPublishedArt(base) {
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
    await putObject(config, 'cdn/v1/mirrors.json', Buffer.from(mirrorsDoc, 'utf8'), {
      contentType: 'application/json',
      cacheControl: SHORT,
    });
    await putObject(config, 'cdn/v1/pick.js', Buffer.from(PICK_SOURCE, 'utf8'), {
      contentType: 'text/javascript',
      cacheControl: SHORT,
    });
    log(`republished cdn/v1/mirrors.json (${published.art.packs?.length ?? 0} packs) + pick.js`);
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
      base: opts.base,
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
    return;
  }

  // Watermark short-circuit: what we published last time already names this upstream tag and
  // verified clean, so there is nothing to do — and, more to the point, no reason to pull 428 MB
  // every six hours to find that out.
  //
  // The extras are part of "done": if Pages or the packs failed in the run that published the
  // interface, art.json names the tag anyway, so a plain tag comparison would skip them forever.
  if (!opts.force) {
    const published = await readPublishedArt(opts.base);
    const missingPages = opts.pages && !(published?.art?.mirrors || []).some((m) => m.id === 'pages');
    const missingPacks = opts.packs && !(published?.art?.packs || []).length;
    // A requested source that the interface does not list yet means its files are not mirrored.
    const missingSources = opts.sources && !(published?.art?.sources || []).length;
    if (
      published?.upstream?.tag === release.tag &&
      published?.schema === ART_SCHEMA &&
      published?.verified?.missing === 0 &&
      !missingPages &&
      !missingPacks &&
      !missingSources
    ) {
      log(
        `already mirrored ${release.tag}: ${published.verified.probed} URLs verified, 0 missing ` +
          `(synced ${published.syncedAt}) — nothing to do (--force to re-run anyway)`,
      );
      return;
    }
    if (published && published.schema !== ART_SCHEMA) {
      log(`the published interface is schema ${published.schema ?? 1}, this code publishes ${ART_SCHEMA} — continuing`);
    }
    const pending = [
      missingPages && 'the pages origin',
      missingPacks && 'the packs',
      missingSources && 'the extra sources',
    ].filter(Boolean);
    if (published?.upstream?.tag === release.tag && pending.length) {
      log(`already mirrored ${release.tag}, but ${pending.join(' and ')} are not published yet — continuing`);
    }
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

  const indexJson = indexDocument({ release, index });
  // The cache token must change whenever the bytes do, not only when the upstream tag does. A tag
  // alone is not enough: the first population of a tree happens under a tag that was already
  // requested (dry runs, retries), and Cloudflare's per-PoP copies then disagree — one edge serves
  // the old bytes for hours. Deriving the token from the content index removes that whole class.
  const indexHash = createHash('sha256').update(indexJson).digest('hex');
  const version = `${release.tag}-${indexHash.slice(0, 8)}`;

  const urls = [
    ...new Set(
      manifests.flatMap((entry) => manifestUrls(entry.text, { base: opts.base, version })),
    ),
  ].sort();
  const expected = {};
  for (const url of urls) {
    const key = url.slice(opts.base.length + 1).split('?')[0];
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
    uploaded: null,
    verification: null,
    pages: null,
    packs: null,
    dropin: null,
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
    const keys = [...diff.add, ...diff.change];
    log(`uploading ${keys.length} objects …`);
    const uploaded = await uploadKeys(config, stage, keys, index.files);
    report.uploaded = uploaded;
    if (uploaded.failed) throw new Error(`${uploaded.failed} uploads failed — not publishing the interface`);
  }

  if (opts.prune && diff.remove.length) {
    log(`pruning ${diff.remove.length} objects upstream no longer lists …`);
    for (const key of diff.remove) await deleteObject(config, key);
    report.pruned = diff.remove.length;
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
        // report, never an overwrite of the authoritative upstream bytes.
        const d = diffIndex(sourceIndex, index);
        log(
          `source ${source.id}: ${sourceIndex.count} files, ${d.add.length} new, ` +
            `${d.change.length} divergent from the main tree`,
        );
        let uploaded = { done: 0, failed: 0 };
        if (d.add.length) uploaded = await uploadSourceKeys(config, layout.assets, d.add, sourceIndex.files);

        let refs = 0;
        if (manifestText) {
          for (const url of manifestUrls(manifestText, { base: opts.base, version })) {
            if (urls.includes(url)) continue;
            const key = url.slice(opts.base.length + 1).split('?')[0];
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
  await reconcileUnreachableFromBucket(config, probe, { expected, base: opts.base });
  report.verification = probe;
  report.ok = passes(probe);
  log(`gate: ${summarizeVerification(probe).split('\n')[0]}`);
  if (!report.ok) {
    await writeReports(ROOT, report);
    throw new Error('acceptance gate failed — the interface files were NOT published');
  }

  // The size gate proves the objects are the right length; this proves a sample is the upstream
  // bytes, which is what rules out a re-encoded copy sitting under the same name.
  const sampled = sampleKeys(index.files, { sample: opts.sample });
  const byteSample = await verifyByteSample(urlsForKeys(sampled, { base: opts.base, version }), {
    files: index.files,
  });
  report.byteSample = byteSample;
  log(
    `byte sample: ${byteSample.checked} files hashed, ${byteSample.mismatch.length} mismatch, ` +
      `${byteSample.failed.length} unreachable`,
  );
  if (byteSample.mismatch.length) {
    await writeReports(ROOT, report);
    throw new Error(
      `byte sample mismatch on ${byteSample.mismatch.length} file(s) — the CDN is not serving the ` +
        `upstream bytes (first: ${byteSample.mismatch[0].key})`,
    );
  }

  await publishCore(config, { opts, manifests, version, indexJson });

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
      origins.push({ id: 'pages', kind: 'pages', root: opts.pagesBase, base: `${opts.pagesBase}/assets/` });
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
  const mergedOrigins = carryForwardOrigins(origins, publishedBefore?.art?.mirrors);

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
      flat: mergedOrigins.map((origin) => ({
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
        base: opts.base,
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
  }

  await publishArt(config, {
    opts,
    release,
    version,
    sources: sourceReports,
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

async function publishCore(config, { opts, manifests, version, indexJson }) {
  let rewrittenCount = 0;
  const objects = [
    ...manifests.map((entry) => {
      const rewritten = rewriteManifestText(entry.text, { base: opts.base, version });
      rewrittenCount += rewritten.count;
      return [`data/${entry.name}`, Buffer.from(rewritten.text, 'utf8'), 'application/json', SHORT];
    }),
    ['cdn/v1/index.json', Buffer.from(indexJson, 'utf8'), 'application/json', SHORT],
    [`cdn/v1/index-${version}.json`, Buffer.from(indexJson, 'utf8'), 'application/json', IMMUTABLE],
    ['robots.txt', Buffer.from('User-agent: *\nDisallow: /\n', 'utf8'), 'text/plain', SHORT],
    // The speed-test probe: a known 256 KiB that every origin serves, so a browser can measure
    // latency and throughput without Range (which the Pages origin's CORS preflight rejects).
    [PROBE_KEY, makeProbeBuffer(), 'application/octet-stream', IMMUTABLE],
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
export function carryForwardOrigins(current, published) {
  if (!Array.isArray(published) || !published.length) return current;
  const byId = new Map(current.map((origin) => [origin.id, origin]));
  const out = [...current];
  for (const prior of published) {
    if (!prior?.id || byId.has(prior.id)) continue;
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

async function publishArt(config, { opts, release, version, sources, manifest, refs, index, probe, origins, packs, mirrorsDoc, byteSample }) {
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