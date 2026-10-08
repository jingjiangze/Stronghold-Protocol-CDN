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
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
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
  return target;
}

/** Extract the art tree and the manifest. The package's top folder name is not assumed. */
export function extractSourceTree({ source, zipPath, stage, log = console.log }) {
  const root = path.join(stage, source.id);
  const marker = path.join(root, '.extracted');
  if (fs.existsSync(marker)) return root;
  fs.mkdirSync(root, { recursive: true });
  log(`source ${source.id}: extracting ${SOURCE_ASSETS_DIR} …`);
  const res = spawnSync(
    'unzip',
    ['-q', '-o', zipPath, `*/${SOURCE_ASSETS_DIR}/*`, `*/${source.manifest}`, '-d', root],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) throw new Error(`source ${source.id}: unzip failed (${res.status})`);
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  return root;
}

/** Locate `<root>/<top>/public/assets` and `<root>/<top>/data/assets.json` after extraction. */
export function findSourceLayout(root, manifest = 'data/assets.json') {
  const tops = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : [];
  for (const entry of tops) {
    if (!entry.isDirectory()) continue;
    const base = path.join(root, entry.name);
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
  if (!layout) throw new Error(`source ${source.id}: no ${SOURCE_ASSETS_DIR} inside the package`);
  const index = await buildIndex([{ abs: layout.assets, prefix: 'assets/' }]);
  let manifestText = '';
  try {
    manifestText = await fsp.readFile(layout.manifest, 'utf8');
  } catch {
    log(`source ${source.id}: no ${source.manifest} in the package — the completeness gate will skip it`);
  }
  return { layout, index, manifestText };
}
