// Mirror this repository's committed art tree into a second git host (OpenI), so the same paths
// are reachable from a China-domestic raw endpoint.
//
// ## Why the bytes come from git, not from the CDN
//
// The obvious design — read the CDN, write the mirror — makes the CDN the source of truth for a
// second copy of itself. That is backwards: a CDN glitch would be mirrored, and a partial outage
// would be published as content. The art tree is *already* committed in this repo, on the orphan
// branch `assets-raw`, and it is the very tree the CDN was published from. So the mirror is a git
// push of that commit, and no content ever comes from the network.
//
// ## Why it is a push and not a rebuild
//
// An earlier shape of this tool re-hashed every blob and rebuilt a commit by hand. That is slower,
// and it silently depends on getting the plumbing right: one wrong flag publishes a tree of empty
// blobs that still looks like a successful push. Git already knows how to transfer these objects.
// Pushing the existing commit moves the same bytes, with the pack protocol doing the compression
// and the object audit, and leaves nothing for this file to get wrong.
//
// ## Why it is cheap when nothing changed
//
// The identity of the mirror is the commit sha of `assets-raw`. If the art branch has not moved,
// `git ls-remote` shows the remote already has it and the job stops there — no pack is built, no
// bytes are sent. Re-uploading 915 MiB four times a day to prove it is unchanged would cost 3.6 GiB
// of egress a day and prove nothing.
//
// ## Why the art branch is pushed whole
//
// `assets-raw` is an orphan branch that holds nothing but the art tree (`assets/`, `fonts/`) plus a
// few KB of sibling metadata (README, .gitattributes, assets.summary.json). Filtering those few
// files out would add a code path and a way to get it wrong, to save nothing.
//
// Paths are identical on both hosts, so an origin entry is one line and a path is spelled the same
// everywhere.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The branch holding the art tree in this repository. */
export const ASSETS_REF = process.env.OPENI_ASSETS_REF || 'assets-raw';

/** Refuse to mirror anything this large: a guard against pushing the wrong ref by mistake. */
export const MAX_BYTES = 4 * 1024 * 1024 * 1024;

/** Promise wrapper around a child process that fails loudly, with the tool's own stderr. */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (
      code === 0
        ? resolve(out)
        : reject(new Error(`${cmd} ${args.join(' ')} → exit ${code}\n${(err || out).trim().slice(0, 2000)}`))
    ));
  });
}

/**
 * Parse `git ls-tree -r -l` output into `{ mode, type, sha, size, path }`.
 *
 * Exported and pure so the real output format can be tested without a repository. The format is
 * easy to get wrong in a way that fails silently: the size is a space-separated column and only
 * the path is introduced by a tab, so splitting the line on tabs yields size 0 for every file —
 * a tree that looks empty and defeats the guard against pushing the wrong ref.
 */
export function parseLsTree(out) {
  const rows = [];
  for (const line of String(out || '').split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    const meta = (tab >= 0 ? line.slice(0, tab) : line).trim().split(/\s+/);
    const file = tab >= 0 ? line.slice(tab + 1) : '';
    if (meta.length < 4 || !file) continue;
    const [mode, type, sha, sizeRaw] = meta;
    const size = Number(sizeRaw);
    rows.push({ mode, type, sha, size: Number.isFinite(size) ? size : 0, path: file });
  }
  return rows;
}

/** `git ls-tree` of a ref, as `{ mode, type, sha, size, path }`. */
export async function listTree(cwd, ref) {
  return parseLsTree(await run('git', ['ls-tree', '-r', '-l', ref], { cwd }));
}

/** Total payload of a tree listing, for the guard and for the log line. */
export function totalBytes(rows) {
  return rows.filter((r) => r.type === 'blob').reduce((s, r) => s + r.size, 0);
}

/** The remote's current commit for `branch`, or null when the branch does not exist. */
export async function remoteHead(remote, branch) {
  try {
    const out = await run('git', ['ls-remote', remote, `refs/heads/${branch}`]);
    const m = out.trim().split(/\s+/)[0];
    return m || null;
  } catch {
    return null;
  }
}

/** Resolve a ref in this repository to a commit sha. */
export async function localHead(cwd, ref) {
  return (await run('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd })).trim();
}

export async function main(argv = process.argv) {
  const arg = (name, dflt) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
  };
  const has = (name) => argv.includes(`--${name}`);
  const force = has('force');

  const cwd = path.resolve(ROOT, arg('cwd', '.'));
  const remote = arg('remote', 'openi');
  // `assets-raw`, not `master`. The remote's default branch is expected to keep a human-readable
  // README, and the art tree is 915 MiB of binaries with no relation to it — overwriting that
  // branch would also make the repo impossible to browse. Same ref name as locally, so the raw
  // URL reads the same in both places.
  const branch = arg('branch', 'assets-raw');
  const assetsRef = arg('assets-ref', ASSETS_REF);
  const dryRun = !has('write');

  const commit = await localHead(cwd, assetsRef);
  const rows = await listTree(cwd, assetsRef);
  const bytes = totalBytes(rows);
  const files = rows.filter((r) => r.type === 'blob').length;

  console.log(`[openi] ${assetsRef} @ ${commit.slice(0, 10)}: ${files} files, ${(bytes / 1048576).toFixed(1)} MiB`);

  if (bytes > MAX_BYTES) {
    throw new Error(`refusing: ${(bytes / 1048576).toFixed(0)} MiB > ${MAX_BYTES / 1048576} MiB (wrong ref?)`);
  }

  const before = await remoteHead(remote, branch);
  console.log(`[openi] remote ${branch} = ${before ? before.slice(0, 10) : '(absent)'}`);

  if (dryRun) {
    console.log('[openi] dry-run: nothing pushed (pass --write)');
    return { commit, files, bytes, pushed: false, skipped: false };
  }

  // The whole point of the fast path: the remote already names this exact commit, so there is
  // nothing to transfer. Compared by sha, not by timestamp — a sha says the bytes are the same.
  if (!force && before === commit) {
    console.log('[openi] remote already at this tree — nothing to do');
    return { commit, files, bytes, pushed: false, skipped: true };
  }

  await run('git', ['push', '--quiet', remote, `${commit}:refs/heads/${branch}`]);
  console.log(`[openi] pushed → ${branch} @ ${commit.slice(0, 10)}`);
  return { commit, files, bytes, pushed: true, skipped: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(String(e && e.message ? e.message : e));
    process.exit(1);
  });
}
