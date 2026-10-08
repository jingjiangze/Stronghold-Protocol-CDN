// Pack the tree into zips and publish them where the community mirror chain can accelerate them.
//
// A flat tree of ~9.5k small files is latency-bound for a client that fetches one at a time
// (measured: minutes of sequential ~15 KB requests). Packs turn the same bytes into a handful of
// ~100 MB downloads that the gh-proxy mirror chain serves at line speed. The flat tree stays the
// per-file source of truth; packs are a bulk channel over the very same content.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { putObject, IMMUTABLE } from './r2.mjs';
import { sha256File } from './index-tree.mjs';

export const DEFAULT_PACK_BYTES = 96 * 1024 * 1024;

/** Group key: `assets/<group>` for the art tree, else the top-level segment (`fonts`). */
export function groupOf(key) {
  const parts = key.split('/');
  if (parts[0] === 'assets' && parts.length >= 2) return `assets/${parts[1]}`;
  return parts[0];
}

const slug = (group, index) => `${group}-${index}`.replace(/[^a-z0-9-]+/gi, '-').replace(/-+/g, '-');

/**
 * Split the tree into packs: files stay together per group, a group bigger than `maxBytes` is
 * chunked in manifest order. Deterministic — the same index always plans the same packs.
 *
 * @returns {{id:string, group:string, keys:string[], bytes:number}[]}
 */
export function planPacks(files, { maxBytes = DEFAULT_PACK_BYTES } = {}) {
  const groups = new Map();
  for (const key of Object.keys(files).sort()) {
    const group = groupOf(key);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(key);
  }

  const packs = [];
  for (const [group, keys] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let current = [];
    let bytes = 0;
    const flush = () => {
      if (!current.length) return;
      packs.push({ id: slug(group, packs.filter((p) => p.group === group).length + 1), group, keys: current, bytes });
      current = [];
      bytes = 0;
    };
    for (const key of keys) {
      const size = files[key].size;
      // one file bigger than the cap still gets its own pack rather than being dropped
      if (bytes && bytes + size > maxBytes) flush();
      current.push(key);
      bytes += size;
    }
    flush();
  }
  return packs;
}

/** Build one zip deterministically: sorted entries, `-X` (no uid/gid/extra fields), the tree's own mtimes. */
export function buildPack(root, keys, outFile) {
  const res = spawnSync('zip', ['-X', '-q', outFile, '-@'], {
    input: keys.join('\n') + '\n',
    cwd: root,
    stdio: ['pipe', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  if (res.error) {
    throw new Error(`zip could not be started (${res.error.message}) — is the zip package installed?`);
  }
  if (res.status !== 0) throw new Error(`zip failed (${res.status}): ${(res.stderr || '').slice(0, 300)}`);
  return fs.statSync(outFile).size;
}

export { sha256File } from './index-tree.mjs';

/**
 * Mirror prefixes applied to a github.com URL. The list is data (`mirrors.json`), not code, so
 * adding a mirror is an edit to a JSON file.
 */
export function mirrorUrls(githubUrl, prefixes) {
  return [githubUrl, ...prefixes.map((p) => `${String(p).replace(/\/+$/, '')}/${githubUrl.replace(/^https:\/\//, '')}`)];
}

/**
 * Upload the packs to R2 and attach them to this repository's GitHub release
 * `assets-<tag>`, which is what the mirror chain accelerates.
 */
export async function publishPacks({ config, root, packs, tag, repo, workDir, mirrorPrefixes }) {
  const releaseTag = `assets-${tag}`;
  const published = [];
  for (const pack of packs) {
    const name = `${pack.id}.zip`;
    const file = path.join(workDir, name);
    const size = buildPack(root, pack.keys, file);
    const sha256 = await sha256File(file);

    const key = `packs/${releaseTag}/${name}`;
    await putObject(config, key, fs.readFileSync(file), { contentType: 'application/zip', cacheControl: IMMUTABLE });

    const gh = spawnSync('gh', ['release', 'upload', releaseTag, file, '--clobber', '-R', repo], {
      encoding: 'utf8',
    });
    if (gh.status !== 0) throw new Error(`gh release upload ${name} failed: ${gh.stderr?.slice(0, 300)}`);

    published.push({
      id: pack.id,
      group: pack.group,
      files: pack.keys.length,
      bytes: size,
      sha256,
      key,
      urls: mirrorUrls(`https://github.com/${repo}/releases/download/${releaseTag}/${name}`, mirrorPrefixes),
    });
  }
  return published;
}

/** Create the release that the packs attach to (idempotent; ignored when it already exists). */
export function ensureRelease({ tag, repo, body }) {
  const releaseTag = `assets-${tag}`;
  const res = spawnSync(
    'gh',
    ['release', 'create', releaseTag, '--title', `assets ${tag}`, '--notes', body || '', '--target', 'main', '-R', repo],
    { encoding: 'utf8' },
  );
  // "already_exists" is the expected second run; anything else is a real failure.
  if (res.status !== 0 && !/already.?exists/i.test(res.stderr || '')) {
    throw new Error(`gh release create failed: ${(res.stderr || '').slice(0, 300)}`);
  }
  return releaseTag;
}
