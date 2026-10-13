// Extra art sources.
//
// The main tree comes from the upstream release. A second source is someone else's release package
// that ships art upstream does not have (skins, the jp voice set, complete operator spines). The
// two share the same relative layout (`assets/…`), which is what makes this work: the extra files
// slot in beside the main tree with no rewriting and no collision.
//
// Uploads are ADDITIVE. A path the main tree already has is never written from a source — the
// upstream bytes stay authoritative — and any same-path difference is reported instead, so a
// divergence is visible rather than silently resolved.
//
// A top-level `overrides` list pins paths where THIS repository deliberately serves bytes upstream does
// not ship (a higher-resolution texture upstream also ships at lower resolution). That is the one
// deliberate divergence from upstream in this pipeline, so it is not left to a diff at run time: each
// entry carries the bytes' identity (`size` + `sha256`), which lets the published index and the cache
// token be built before anything is fetched, and the bytes themselves live in this repository under
// `pin/<path>` — so CI already has them and no mirror has to be trusted as the source of truth.
// `applyOverrides` writes them into the index; the sync uploads them and refuses to publish if the
// pinned bytes are missing or do not hash to what the entry promises.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { assertPublicHttpsUrl } from './upstream.mjs';
import { buildIndex } from './index-tree.mjs';

export const SOURCE_ASSETS_DIR = 'public/assets';

export function readSources(root) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(root, 'sources.json'), 'utf8'));
  } catch {
    return [];
  }
  const out = [];
  for (const entry of Array.isArray(cfg?.sources) ? cfg.sources : []) {
    if (!entry?.id || !entry?.repo || !entry?.package) continue;
    out.push({
      id: String(entry.id),
      repo: String(entry.repo),
      ref: String(entry.ref || ''),
      release: String(entry.release || ''),
      package: String(entry.package),
      manifest: String(entry.manifest || 'data/assets.json'),
      ...(entry.note ? { note: String(entry.note) } : {}),
    });
  }
  return out;
}

/** Where the pinned bytes live inside this repository. */
export const PIN_DIR = 'pin';

/** A pin is `{ path, size, sha256, why? }`: the identity of the bytes we serve at an upstream path. */
function parseOverride(raw, index) {
  const where = `sources.json: overrides[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where} must be an object { path, size, sha256 }`);
  }
  const p = String(raw.path || '');
  if (!p || p.startsWith('/') || p.includes('..') || p.endsWith('/')) {
    throw new Error(`${where}.path must be a repo-relative file path (got ${JSON.stringify(raw.path)})`);
  }
  const size = Number(raw.size);
  if (!Number.isInteger(size) || size <= 0) throw new Error(`${where}.size must be a positive integer`);
  const sha256 = String(raw.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${where}.sha256 must be 64 hex characters`);
  return { path: p, size, sha256, ...(raw.why ? { why: String(raw.why) } : {}) };
}

/** The declared overrides, validated. A malformed entry is refused here rather than after an upload. */
export function readOverrides(root) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(root, 'sources.json'), 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(cfg?.overrides) ? cfg.overrides : [];
  return list.map((raw, i) => parseOverride(raw, i));
}

/**
 * The bytes a pin promises, read from `pin/<path>` in this repository and verified.
 *
 * The bytes live here on purpose: a source package would have to ship them (none does), and fetching
 * them from a mirror would make that mirror the source of truth for the CDN. Reading them from the
 * checkout keeps the declaration and the bytes in one versioned place, and the hash check means a
 * mismatch stops the run instead of publishing the wrong bytes.
 *
 * @param {string} root repository root
 * @param {{path:string, size:number, sha256:string}} pin
 * @returns {Buffer}
 */
export function readPinnedBytes(root, pin) {
  const abs = path.join(root, PIN_DIR, ...pin.path.split('/'));
  let body;
  try {
    body = fs.readFileSync(abs);
  } catch (error) {
    throw new Error(`override ${pin.path}: cannot read ${PIN_DIR}/${pin.path} (${error.code || error.message})`);
  }
  if (body.length !== pin.size) {
    throw new Error(`override ${pin.path}: ${PIN_DIR}/${pin.path} is ${body.length} B, the pin says ${pin.size} B`);
  }
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (sha256 !== pin.sha256) {
    throw new Error(
      `override ${pin.path}: ${PIN_DIR}/${pin.path} hashes to ${sha256.slice(0, 16)}…, the pin says ${pin.sha256.slice(0, 16)}…`,
    );
  }
  return body;
}

/**
 * Replace upstream's entry for every pinned path with the bytes we intend to serve.
 *
 * This is the one place the CDN knowingly diverges from upstream, so it is applied to the index
 * BEFORE it is serialized and hashed: the cache token, the acceptance gate's expectations, tree.json
 * and the byte sample then all describe what is actually served. It must run AFTER the main diff, or
 * the pinned path would be uploaded from upstream's own tree and the pin would be undone.
 *
 * @param {{files: Record<string, {size:number, sha256:string}>, bytes:number}} index mutated in place
 * @param {{path:string, size:number, sha256:string, source?:string, why?:string}[]} pins
 * @returns {{path:string, from:{size:number,sha256:string}, to:{size:number,sha256:string}, source?:string, why?:string}[]} what changed
 */
export function applyOverrides(index, pins = []) {
  const applied = [];
  for (const pin of pins) {
    const have = index.files?.[pin.path];
    if (!have) {
      throw new Error(
        `override ${pin.path}: upstream does not ship this path, so there is nothing to override — ` +
          'a path upstream lacks belongs in the source tree, which is additive',
      );
    }
    if (have.size === pin.size && have.sha256 === pin.sha256) continue; // already serving exactly this
    applied.push({
      path: pin.path,
      from: { size: have.size, sha256: have.sha256 },
      to: { size: pin.size, sha256: pin.sha256 },
      ...(pin.source ? { source: pin.source } : {}),
      ...(pin.why ? { why: pin.why } : {}),
    });
    index.bytes += pin.size - have.size;
    index.files[pin.path] = { size: pin.size, sha256: pin.sha256 };
  }
  return applied;
}

/** The GitHub release page for a source, validated like every other URL we touch. */
export function sourceReleaseUrl(source) {
  const tag = source.release || source.ref;
  const url = `https://github.com/${source.repo}/releases/tag/${encodeURIComponent(tag)}`;
  assertPublicHttpsUrl(url);
  return url;
}

/** `gh release download` the package into `dir`; a matching file already there is reused. */
export function fetchSourcePackage({ source, dir, log = console.log }) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, source.package);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    log(`source ${source.id}: package already downloaded`);
    return target;
  }
  const tag = source.release || source.ref;
  log(`source ${source.id}: downloading ${source.package} …`);
  const res = spawnSync(
    'gh',
    ['release', 'download', tag, '-R', source.repo, '-p', source.package, '-D', dir, '--clobber'],
    { stdio: 'inherit', env: process.env },
  );
  if (res.status !== 0) throw new Error(`source ${source.id}: gh release download failed (${res.status})`);
  if (!fs.existsSync(target)) throw new Error(`source ${source.id}: ${source.package} not found after download`);
  const size = fs.statSync(target).size;
  if (size < 1024 * 1024) {
    throw new Error(`source ${source.id}: ${source.package} is only ${size} bytes — the download did not complete`);
  }
  return target;
}


/**
 * Some packages wrap the tree one level deeper: this project's server release is a zip holding a
 * .tar.gz plus a manual (scripts/pack-server-zip.py), so a single unzip leaves nothing to find.
 * Unpack any archive found inside, wherever it is.
 */
function extractNestedArchives(root, log = console.log) {
  const archives = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.(tar\.gz|tgz|tar)$/i.test(entry.name)) archives.push(full);
    }
  }
  for (const archive of archives) {
    log(`source: unpacking nested ${path.basename(archive)} …`);
    const res = spawnSync('tar', ['-xf', archive, '-C', path.dirname(archive)], { stdio: 'inherit' });
    if (res.status !== 0) throw new Error(`tar failed (${res.status}) on ${path.basename(archive)}`);
  }
  return archives.length;
}

/** Extract the art tree and the manifest. The package's top folder name is not assumed. */
export function extractSourceTree({ source, zipPath, stage, log = console.log }) {
  const root = path.join(stage, source.id);
  const marker = path.join(root, '.extracted');
  if (fs.existsSync(marker)) return root;
  fs.mkdirSync(root, { recursive: true });
  // Extract the package whole, then locate the tree. Guessing the archive's internal layout from
  // include patterns is what failed the first time — unzip exited 11 because the patterns matched
  // nothing — and a source package is someone else's build, so assuming its layout is a bet that
  // does not need to be taken. (findSourceLayout accepts a wrapping folder or none.)
  log(`source ${source.id}: extracting ${source.package} …`);
  const res = spawnSync('unzip', ['-q', '-o', zipPath, '-d', root], { stdio: 'inherit' });
  if (res.status !== 0) {
    // Report what is actually in the package rather than only an exit code.
    const listing = spawnSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
    const lines = (listing.stdout || '').split('\n');
    const head = lines.filter((line) => line.trim()).slice(0, 10).join('\n');
    throw new Error(
      `source ${source.id}: unzip failed (${res.status}); package listing starts with:\n${head}`,
    );
  }
  // A package may wrap the tree one level deeper (this project's server release is a zip holding a
  // .tar.gz plus a manual), so unpack anything nested before looking for the tree.
  extractNestedArchives(root, log);
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  return root;
}

/** Locate `<root>/<top>/public/assets` and `<root>/<top>/data/assets.json` after extraction. */
export function findSourceLayout(root, manifest = 'data/assets.json') {
  // The tree may sit at the extraction root or inside a wrapping folder; accept either.
  const bases = [root];
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) bases.push(path.join(root, entry.name));
    }
  }
  for (const base of bases) {
    const assets = path.join(base, SOURCE_ASSETS_DIR);
    if (fs.existsSync(assets)) {
      return { top: base, assets, manifest: path.join(base, ...manifest.split('/')) };
    }
  }
  return null;
}

/** Index a source's art tree, and read the manifest it ships. */
export async function readSource({ source, root, log = console.log }) {
  const layout = findSourceLayout(root, source.manifest);
  if (!layout) {
    const listing = (fs.existsSync(root) ? fs.readdirSync(root) : [])
      .map((name) => (fs.statSync(path.join(root, name)).isDirectory() ? `${name}/` : name))
      .slice(0, 15)
      .join(', ');
    throw new Error(`source ${source.id}: no ${SOURCE_ASSETS_DIR} inside the package; it contains: ${listing}`);
  }
  const index = await buildIndex([{ abs: layout.assets, prefix: 'assets/' }]);
  let manifestText = '';
  try {
    manifestText = await fsp.readFile(layout.manifest, 'utf8');
  } catch {
    log(`source ${source.id}: no ${source.manifest} in the package — the completeness gate will skip it`);
  }
  return { layout, index, manifestText };
}
