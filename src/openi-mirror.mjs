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

/**
 * Ceiling for a single push, in MiB. Measured: the whole tree at 1,807 MiB was answered with
 * `HTTP 413` after 16 minutes, while 915 MiB had gone through. The limit belongs to the remote, so
 * we stay under the size known to work instead of discovering the boundary by failing a real run.
 */
export const DEFAULT_BUDGET_MIB = Number(process.env.OPENI_BUDGET_MIB) || 700;

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

/**
 * The commits to replay onto a remote sitting at `from`, oldest first.
 *
 * `git rev-list --reverse A..B` lists B's ancestors A does not have, in the order they were made —
 * which is also the order that transfers the least, because each push then sends only the objects
 * the previous one did not. Empty when `from` already has everything; empty when `from` is null,
 * because an absent branch is a fresh push, not a replay.
 */
export async function commitsSince(cwd, from, to) {
  if (!from) return [];
  const out = await run('git', ['rev-list', '--reverse', `${from}..${to}`], { cwd });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Split a replay into pushes that each stay under `budgetBytes`.
 *
 * Measured, not guessed: one `git push` of the whole 1,807 MiB tree died with
 * `error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413` after 16 minutes.
 * The remote's front door caps a single request body, and a git push is exactly one POST — so no
 * amount of `http.postBuffer` or `pack.packSizeLimit` helps; neither splits that POST.
 * The tree had also grown past the 915 MiB that used to fit, so "it fit once" is not a property
 * of the host we can lean on.
 *
 * Replaying the commits instead fixes it, and not by being smaller overall: each push after the
 * first is a *delta* against what the remote just accepted, so the wire carries many small packs
 * rather than one 1.8 GiB one. The budget bounds a single batch, so a run stops at the last commit
 * that fits and leaves the rest for the next scheduled run — advancing part way is strictly better
 * than a 413 that leaves the remote a gigabyte behind and retries the same impossible POST all day.
 *
 * Pure: given per-commit sizes the answer is arithmetic, so the boundary is testable without a
 * repository or a network.
 */
export function planBatches(commits, sizes, budgetBytes) {
  const batches = [];
  let cur = [];
  let curBytes = 0;
  for (const c of commits) {
    const size = Number(sizes[c]) || 0;
    if (cur.length && curBytes + size > budgetBytes) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(c);
    curBytes += size;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * Bytes a commit's push would carry: the size of the blobs it added or changed.
 *
 * `git diff-tree` reports the blob sha but never the size — the `-l` that adds a size column
 * belongs to `ls-tree`, and in `diff-tree` it is a rename limit that errors with
 * "switch `l' expects an integer value". So the size comes from `cat-file --batch-check`, fed the
 * new blob sha of every added/modified path in one call: one process per commit, not per file.
 */
export async function commitAddedBytes(cwd, commit) {
  let out;
  try {
    // `--root` so the branch's first commit reports its files too; without it that commit looks
    // empty and its whole payload silently escapes the budget.
    out = await run('git', ['diff-tree', '-r', '--no-commit-id', '--root', '--diff-filter=ACM', commit], { cwd });
  } catch {
    return 0;
  }
  const shas = [];
  for (const line of out.split('\n')) {
    // `:100644 100644 <src-sha> <dst-sha> A\t<path>` — the size is not in here, the dst sha is.
    const m = line.match(/^:\d{6}\s+\d{6}\s+[0-9a-f]+\s+([0-9a-f]{40})\s+[ACM]/);
    if (m) shas.push(m[1]);
  }
  if (!shas.length) return 0;
  const unique = [...new Set(shas)];
  const input = `${unique.join('\n')}\n`;
  const child = spawn('git', ['cat-file', '--batch-check'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let sum = 0;
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  // Writing before reading deadlocks once the pipe buffer fills, which it does at ~14k shas.
  child.stdin.end(input);
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  for (const line of buf.split('\n')) {
    // `<sha> blob <size>`
    const m = line.match(/^[0-9a-f]{40}\s+blob\s+(\d+)$/);
    if (m) sum += Number(m[1]);
  }
  return sum;
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
  // Per-push ceiling. 915 MiB went through; 1,807 MiB got a 413. The cap is the remote's, not
  // ours, so stay under the size that is known to work rather than probing it in production.
  const budgetBytes = Number(arg('budget-mib', DEFAULT_BUDGET_MIB)) * 1048576;

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

  // Replay rather than shove. A single push of the whole tree 413s (see planBatches); walking the
  // commits keeps every POST small, and each one after the first is a delta against what the
  // remote just received.
  const pending = await commitsSince(cwd, before, commit);
  const sizes = {};
  for (const c of pending) sizes[c] = await commitAddedBytes(cwd, c);
  const batches = planBatches(pending, sizes, budgetBytes);

  if (dryRun) {
    const total = Object.values(sizes).reduce((a, b) => a + b, 0);
    console.log(`[openi] dry-run: ${pending.length} commit(s), ${(total / 1048576).toFixed(1)} MiB in ${batches.length} batch(es) — nothing pushed (pass --write)`);
    return { commit, files, bytes, pushed: false, skipped: false, pending: pending.length, batches: batches.length };
  }

  let done = 0;
  for (const [i, batch] of batches.entries()) {
    const head = batch[batch.length - 1];
    const batchBytes = batch.reduce((s, c) => s + (sizes[c] || 0), 0);
    console.log(`[openi] batch ${i + 1}/${batches.length}: ${batch.length} commit(s), ${(batchBytes / 1048576).toFixed(1)} MiB → ${head.slice(0, 10)}`);
    // Each push advances the real branch, so an interruption leaves the remote at a commit it can
    // serve and the next run resumes from there. Pushing a batch's tip carries its ancestors.
    await run('git', ['push', '--quiet', remote, `${head}:refs/heads/${branch}`]);
    done += batch.length;
  }

  const after = await remoteHead(remote, branch);
  if (after !== commit) {
    // Not an error: the budget stopped us part way, and the next scheduled run continues. Saying
    // so out loud is the difference between "slowly catching up" and "silently stale".
    console.log(`[openi] advanced to ${String(after).slice(0, 10)}, ${pending.length - done} commit(s) left for the next run`);
    return { commit, files, bytes, pushed: true, skipped: false, partial: true, at: after };
  }

  console.log(`[openi] pushed → ${branch} @ ${commit.slice(0, 10)}`);
  return { commit, files, bytes, pushed: true, skipped: false, partial: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(String(e && e.message ? e.message : e));
    process.exit(1);
  });
}
