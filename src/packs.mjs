// Pack the tree into zips and publish them where the community mirror chain can accelerate them.
//
// A flat tree of ~9.5k small files is latency-bound for a client that fetches one at a time
// (measured: minutes of sequential ~15 KB requests). Packs turn the same bytes into a handful of
// ~100 MB downloads that the gh-proxy mirror chain serves at line speed. The flat tree stays the
// per-file source of truth; packs are a bulk channel over the very same content.
//
// **Packs are GitHub-only (2026-10-14 用户指令)。** 字节只落到 GitHub Release，由镜像链加速；
// R2 与其他镜像都不存 packs。此前 R2 是主存（这里 putObject 一份、GitHub 一份），
// 结果是同一个 ~100MB 的包在两边各存一份，而 R2 那一份既不是权威也不比 GitHub 快。
// 现在 GitHub Release 是唯一权威源，URL 列表不再含自有域那条。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { sha256File } from './index-tree.mjs';
import { DOCS_PREFIX } from './names.mjs';

export const DEFAULT_PACK_BYTES = 96 * 1024 * 1024;

/**
 * Prefixes that stay out of the pack channel.
 *
 * Packs exist because the art tree is ~9.5k small files and a client fetching them one at a time is
 * latency-bound. The docs are the opposite: a handful of files, a few MB in total, usually wanted
 * individually and readable straight from the CDN. Packing them would add a ~3 MB zip nobody needs
 * and a "docs" group that means nothing.
 */
export const PACK_EXCLUDED_PREFIXES = [DOCS_PREFIX];

/** Mirror prefixes applied to github.com URLs. The list is data (mirrors.json), not code. */
export function readMirrorPrefixes(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'mirrors.json'), 'utf8'));
    return Array.isArray(cfg.github) ? cfg.github : [];
  } catch {
    return [];
  }
}

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
    if (PACK_EXCLUDED_PREFIXES.some((p) => key.startsWith(p))) continue;
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
  // spawnSync reports a missing cwd as ENOENT on the binary, which reads like "zip is not
  // installed" — say what is actually wrong.
  if (!fs.existsSync(root)) throw new Error(`buildPack: no tree at ${root}`);
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
 *
 * 2026-10-14：去掉 `ownUrl`（R2 自有域那条）。packs 不再落 R2，那条 URL 会 404，
 * 留着就是给客户端一条死链。GitHub 排在首位即权威源，其余是镜像链加速副本；
 * 消费者按 URL 形态分类，不按位置。
 */
export function mirrorUrls(githubUrl, prefixes, ownUrl) {
  // `ownUrl` 已停用：签名保留是为了不破坏调用方，但一律忽略。
  void ownUrl;
  return [githubUrl, ...prefixes.map((p) => `${String(p).replace(/\/+$/, '')}/${githubUrl.replace(/^https:\/\//, '')}`)];
}

/**
 * Publish the packs to this repository's GitHub release `assets-<tag>` — the one thing the mirror
 * chain accelerates. **R2 no longer receives packs** (2026-10-14): the bucket is the per-file art
 * source, the bulk channel is GitHub, and storing both was two copies of the same ~100 MB zip
 * where only one of them was authoritative.
 */
export async function publishPacks({ config, root, packs, tag, repo, workDir, mirrorPrefixes, ownBase }) {
  // `config` / `ownBase` 保留在签名里以免破坏调用方，但不再用于写 R2。
  void config;
  void ownBase;
  const releaseTag = `assets-${tag}`;
  const published = [];
  for (const pack of packs) {
    const name = `${pack.id}.zip`;
    const file = path.join(workDir, name);
    const size = buildPack(root, pack.keys, file);
    const sha256 = await sha256File(file);

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
      urls: mirrorUrls(
        `https://github.com/${repo}/releases/download/${releaseTag}/${name}`,
        mirrorPrefixes,
      ),
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
