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
import { verifyUrls, summarizeVerification } from './verify-remote.mjs';
import { r2Config, putObject, deleteObject, mimeFor, IMMUTABLE, SHORT } from './r2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE = process.env.SP_CDN_BASE || 'https://weishucdn.jiangjiangze.icu';

function parseArgs(argv) {
  const opts = { write: false, prune: false, strict: false, tag: '', work: 'work', base: DEFAULT_BASE };
  for (const arg of argv) {
    if (arg === '--write') opts.write = true;
    else if (arg === '--dry-run') opts.write = false;
    else if (arg === '--prune') opts.prune = true;
    else if (arg === '--strict') opts.strict = true;
    else if (arg.startsWith('--tag=')) opts.tag = arg.slice('--tag='.length);
    else if (arg.startsWith('--work=')) opts.work = arg.slice('--work='.length);
    else if (arg.startsWith('--base=')) opts.base = arg.slice('--base='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.prune && !opts.write) throw new Error('--prune only makes sense together with --write');
  opts.base = String(opts.base).replace(/\/+$/, '');
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  log(`mode: ${opts.write ? 'WRITE' : 'dry-run'}${opts.prune ? ' +prune' : ''}, base ${opts.base}`);

  const release = await resolveRelease(opts.tag);
  log(`upstream ${release.repo} → ${release.tag} (published ${release.publishedAt})`);

  const workDir = path.resolve(ROOT, opts.work, release.tag);
  const stage = path.join(workDir, 'stage');
  const zipPath = downloadPackage(release, workDir);
  await verifyPackageDigest(zipPath, release);
  extractPackage(zipPath, stage);

  const manifestPath = path.join(stage, ZIP_ROOT, 'data', 'assets.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`the package has no ${ZIP_ROOT}/data/assets.json — layout changed?`);
  }
  const manifestText = await fsp.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  const manifestFiles = manifest?.stats?.files;
  if (!manifestFiles) {
    throw new Error('the manifest has no stats.files — refusing to mirror an empty asset set');
  }
  const refs = collectManifestPaths(manifestText);
  log(`manifest: ${manifestFiles} files, hash ${manifest.hash}, ${refs.length} asset refs`);

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

  const urls = manifestUrls(manifestText, { base: opts.base, version: release.tag });
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
    manifest: { files: manifestFiles, hash: manifest.hash, refs: refs.length },
    tree: { files: index.count, bytes: index.bytes },
    diff: { add: diff.add.length, change: diff.change.length, same: diff.same, remove: diff.remove.length, uploadBytes: uploadSize },
    removedSample: diff.remove.slice(0, 50),
    uploaded: null,
    verification: null,
    ok: false,
  };

  if (!opts.write) {
    // Diagnosis mode: report the gap without touching anything, and only fail when asked to.
    const probe = await verifyUrls(urls, { expected, onProgress: (done, total) => log(`probed ${done}/${total}`) });
    report.verification = probe;
    report.ok = probe.missing.length === 0 && probe.mismatch.length === 0 && probe.failed.length === 0;
    log(`gate (read-only): ${summarizeVerification(probe).split('\n')[0]}`);
    await writeReports(ROOT, report);
    process.exit(report.ok || !opts.strict ? 0 : 1);
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

  const probe = await verifyUrls(urls, { expected, onProgress: (done, total) => log(`probed ${done}/${total}`) });
  report.verification = probe;
  report.ok = probe.missing.length === 0 && probe.mismatch.length === 0 && probe.failed.length === 0;
  log(`gate: ${summarizeVerification(probe).split('\n')[0]}`);
  if (!report.ok) {
    await writeReports(ROOT, report);
    throw new Error('acceptance gate failed — the interface files were NOT published');
  }

  await publishInterface(config, { opts, release, manifest, manifestText, index, probe });
  await writeReports(ROOT, report);
  log('done.');
}

async function publishInterface(config, { opts, release, manifest, manifestText, index, probe }) {
  const rewritten = rewriteManifestText(manifestText, { base: opts.base, version: release.tag });
  const indexJson = JSON.stringify({
    schema: 1,
    tag: release.tag,
    count: index.count,
    bytes: index.bytes,
    files: index.files,
  });

  const art = {
    schema: 1,
    upstream: {
      repo: release.repo,
      tag: release.tag,
      publishedAt: release.publishedAt,
      zip: release.zip.name,
      zipSha256: release.zip.sha256,
    },
    art: { base: `${opts.base}/assets/`, version: 1, format: 1, mirrors: [], packs: [] },
    manifest: { url: '/data/assets.json', hash: manifest.hash, refs: collectManifestPaths(manifestText).length },
    tree: { files: index.count, bytes: index.bytes, index: '/cdn/v1/index.json' },
    syncedAt: new Date().toISOString(),
    verified: { at: new Date().toISOString(), missing: 0, mismatch: 0, probed: probe.probed },
  };

  const objects = [
    ['data/assets.json', Buffer.from(rewritten.text, 'utf8'), 'application/json', SHORT],
    ['cdn/v1/index.json', Buffer.from(indexJson, 'utf8'), 'application/json', SHORT],
    [`cdn/v1/index-${release.tag}.json`, Buffer.from(indexJson, 'utf8'), 'application/json', IMMUTABLE],
    ['cdn/v1/art.json', Buffer.from(`${JSON.stringify(art, null, 2)}\n`, 'utf8'), 'application/json', SHORT],
    ['robots.txt', Buffer.from('User-agent: *\nDisallow: /\n', 'utf8'), 'text/plain', SHORT],
  ];
  for (const [key, body, contentType, cacheControl] of objects) {
    await putObject(config, key, body, { contentType, cacheControl });
    log(`published ${key} (${body.length} bytes)`);
  }
  log(`rewrote ${rewritten.count} manifest URLs → ${opts.base}/assets/…?v=${release.tag}`);
}

async function writeReports(root, report) {
  await fsp.writeFile(path.join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

  const v = report.verification;
  const lines = [
    `## Stronghold-Protocol-CDN sync — ${report.mode}`,
    '',
    `- upstream: **${report.upstream.tag}** (published ${report.upstream.publishedAt})`,
    `- source package: \`${report.upstream.zip.name}\` (${(report.upstream.zip.size / 1048576).toFixed(0)} MB)`,
    `- manifest: ${report.manifest.files} files, hash \`${report.manifest.hash}\`, ${report.manifest.refs} asset refs`,
    `- tree: ${report.tree.files} files, ${(report.tree.bytes / 1048576).toFixed(1)} MB`,
    `- diff: add ${report.diff.add}, change ${report.diff.change}, same ${report.diff.same}, extra-on-CDN ${report.diff.remove} (${(report.diff.uploadBytes / 1048576).toFixed(1)} MB to upload)`,
    ...(report.uploaded ? [`- uploaded: ${report.uploaded.done} (${report.uploaded.failed} failed)`] : []),
    '',
    v ? summarizeVerification(v) : '_no verification ran_',
    '',
    `**gate: ${report.ok ? 'PASS' : 'FAIL'}**`,
  ];
  await fsp.writeFile(path.join(root, 'report.md'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}

main().catch(async (error) => {
  console.error(`[sync] ERROR ${error.stack || error.message}`);
  process.exitCode = 1;
});
