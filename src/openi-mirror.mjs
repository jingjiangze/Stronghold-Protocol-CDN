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
 * Ceiling for a single push, in MiB. Measured against the real remote, not guessed:
 *   - 1 commit (51.8 MiB) of delta: OK
 *   - 4 commits (232 MiB) of delta: OK
 *   - 10 commits (640.9 MiB) of delta: HTTP 413
 * so the boundary sits somewhere between 232 and 641 MiB. We stay well under the size known to work
 * (200 < 232) rather than probing the boundary by failing a 16-minute run.
 */
export const DEFAULT_BUDGET_MIB = Number(process.env.OPENI_BUDGET_MIB) || 200;

/** Promise wrapper around a child process that fails loudly, with the tool's own stderr. */
export function run(cmd, args, opts = {}) {
  const { timeoutMs = 0, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOpts });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    // 可选超时：remoteHead 用它划清「分支不存在」与「探测卡死」。默认 0 = 不设（push
    // 本身可能 legitimately 跑几十分钟，不能一刀切）。
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${cmd} ${args.join(' ')} → 超时 ${timeoutMs}ms 未返回`));
      }, timeoutMs);
      timer.unref();
    }
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      code === 0
        ? resolve(out)
        : reject(new Error(`${cmd} ${args.join(' ')} → exit ${code}\n${(err || out).trim().slice(0, 2000)}`));
    });
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

/**
 * The remote's current commit for `branch`.
 *
 * ⚠ 2026-10-15 实测（run 38633412096）：这里的 `catch → null` 曾经把一个**已经存在的分支**
 * 报成 `(absent)` —— 那次 `ls-remote` 第一次耗时 300 秒（20:37:47→20:42:47）才返回，
 * 而紧接着的第二次调用 2 秒就拿到了 `1950626623`。也就是说远端明明在，只是第一次慢。
 * 而下层 `main()` 把 `before === null` 当作「全新分支」，于是 replay 列表为空、
 * 一条都没推，却打印 "advanced to …, 0 commit(s) left" —— 一次彻底的假成功。
 *
 * 所以现在区分两种「拿不到」：
 *   - 分支确实不存在 → `null`（`ls-remote` 成功但输出为空）
 *   - 命令本身失败 / 超时 → 抛错，绝不退化成 null
 * 宁可让作业红一次，也不要把「没探到」伪装成「不用推」。
 *
 * 超时是这里的关键：默认无超时时 git 会挂到 runner 的 90 分钟上限，
 * 而这段等待既推不动任何字节，还会把「分支不存在」的错误结论带给后面所有逻辑。
 */
export async function remoteHead(remote, branch, { timeoutMs = 120000 } = {}) {
  const out = await run('git', ['ls-remote', remote, `refs/heads/${branch}`], { timeoutMs });
  const m = out.trim().split(/\s+/)[0];
  return m || null;
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

/**
 * Push one commit's tree in file-level slices, each under `budgetBytes`.
 *
 * Needed because the commit-level batching in `planBatches` cannot help when a *single* commit is
 * already over the budget: 2026-10-15 measured the union-merge commit on `assets-raw` at 600 MiB
 * against a remote that 413s somewhere between 232 and 641 MiB. `planBatches` only compares the
 * budget when the current batch is non-empty, so an empty batch swallows that commit whole.
 *
 * Strategy: replay the commit's own tree into a throwaway clone of the remote branch, adding files
 * a slice at a time and pushing after each slice. Every push after the first is a delta against
 * what the remote just accepted, so the wire stays small — the same trick `planBatches` uses, just
 * inside one commit. Objects are read out of `cwd`'s object store, never re-hashed from the network.
 *
 * The throwaway clone uses `--no-checkout`: there is no working tree to write into, and `git add`
 * would fail with "not in the current sparse checkout". Everything happens on the index plane.
 */
export async function pushCommitInSlices(cwd, remote, branch, commit, budgetBytes) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const { execFileSync } = await import('node:child_process');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openi-slice-'));
  const g = (...a) => execFileSync('git', a, { cwd: tmp, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
  try {
    const url = (await run('git', ['remote', 'get-url', remote], { cwd })).trim();
    // `--branch` 在远端还没有这个分支时会直接失败，而「分支不存在」正是现在要支持的入口
    // （整树首推）。所以先不带 --branch 克隆（拿远端默认分支或空仓），再在克隆里按需建分支。
    execFileSync('git', ['clone', '--depth', '1', '--no-checkout', '--quiet', url, 'w'],
      { cwd: tmp, stdio: ['ignore', 'ignore', 'pipe'] });
    const w = path.join(tmp, 'w');
    const gw = (...a) => execFileSync('git', a, { cwd: w, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
    // 远端若已有该分支，切到它并把 index 灌满（不灌的话第一个 commit 会把远端内容全删掉）；
    // 没有就从零开始 —— `update-ref` 会在首次 flush 时把分支建出来。
    const hasBranch = gw('ls-remote', '--heads', 'origin', branch).trim().length > 0;
    if (hasBranch) {
      gw('fetch', '--depth', '1', 'origin', `${branch}:refs/heads/${branch}`);
      gw('symbolic-ref', 'HEAD', `refs/heads/${branch}`);
      gw('read-tree', 'HEAD');
    }

    // 该 commit 相对当前远端 HEAD 新增/变更的文件（字节从 cwd 的对象库读，不经网络）
    const diff = execFileSync('git', ['diff-tree', '-r', '--no-commit-id', '--root', '--diff-filter=ACM', commit],
      { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
    const rows = [];
    for (const line of diff.split('\n')) {
      const m = line.match(/^:(\d{6})\s+\d{6}\s+[0-9a-f]+\s+([0-9a-f]{40})\s+[ACM]\t(.*)$/);
      if (m) rows.push({ mode: m[1], sha: m[2], p: m[3] });
    }
    // 远端已经有的就跳过（幂等：重跑不会重复传）
    const have = new Set(gw('ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean));
    const todo = rows.filter((r) => !have.has(r.p));
    const sizes = new Map();
    const check = execFileSync('git', ['cat-file', '--batch-check'], {
      cwd, encoding: 'utf8', maxBuffer: 1 << 28, input: todo.map((r) => r.sha).join('\n') + '\n',
    });
    const lines = check.trim().split('\n');
    for (let i = 0; i < todo.length; i++) {
      const m = lines[i] && lines[i].match(/^[0-9a-f]{40}\s+blob\s+(\d+)$/);
      sizes.set(todo[i].sha, m ? Number(m[1]) : 0);
    }
    console.log(`[openi]   文件级分批：${todo.length} 份待补 / ${([...sizes.values()].reduce((a, b) => a + b, 0) / 1048576).toFixed(1)} MiB`);

    let sliceBytes = 0;
    let slice = [];
    let pushed = 0;
    const flush = async () => {
      if (!slice.length) return;
      for (let i = 0; i < slice.length; i += 2000) {
        execFileSync('git', ['update-index', '--add', '--index-info'], {
          cwd: w, encoding: 'utf8',
          input: slice.slice(i, i + 2000).map((r) => `${r.mode} ${r.sha}\t${r.p}`).join('\n') + '\n',
        });
      }
      const tree = gw('write-tree');
      // 远端没有该分支时 HEAD 是无提交的空 ref，`rev-parse HEAD` 会直接报错 —— 首推没有父提交。
      const parent = hasBranch ? gw('rev-parse', 'HEAD') : null;
      if (hasBranch && tree === gw('rev-parse', 'HEAD^{tree}')) { slice = []; sliceBytes = 0; return; }
      const c = gw('-c', 'user.name=cdn-bot', '-c', 'user.email=cdn-bot@users.noreply.github.com',
        '-c', 'commit.gpgsign=false', 'commit-tree', tree,
        ...(parent ? ['-p', parent] : []),
        '-m', `assets: 补入素材树（${slice.length} 份，${(sliceBytes / 1048576).toFixed(1)} MiB）`);
      gw('update-ref', 'refs/heads/' + branch, c);
      if (!hasBranch) gw('symbolic-ref', 'HEAD', `refs/heads/${branch}`);
      await run('git', ['push', '--quiet', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { cwd: w });
      pushed += slice.length;
      console.log(`[openi]   已推 ${pushed}/${todo.length} 份（${(sliceBytes / 1048576).toFixed(1)} MiB）`);
      slice = [];
      sliceBytes = 0;
    };
    for (const r of todo) {
      const s = sizes.get(r.sha) || 0;
      if (slice.length && sliceBytes + s > budgetBytes) await flush();
      slice.push(r);
      sliceBytes += s;
    }
    await flush();
    console.log(`[openi]   文件级分批完成：${pushed} 份`);
    return pushed;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
  // ⚠ 2026-10-15 实测（run 38633412096）：`before` 为 null 时 `commitsSince` 返回空数组
  // ⇒ 循环一次都不跑、一个字节都没推，却一路走到下面的 "advanced to …" 分支打印成功。
  // 那次 null 还是假的（ls-remote 只是慢），但即便分支真不存在，也必须先**真的推一次**：
  // 「远端没有该分支」恰恰意味着要推整棵树，而不是什么都不做。
  // 所以这里显式分流，且空 replay 只在「远端已经就是这个 commit」时才算完成。
  if (!before) {
    console.log(`[openi] 远端无 ${branch} —— 走整树（文件级分批，每次 ≤ ${budgetBytes / 1048576} MiB）`);
    const pushed = await pushCommitInSlices(cwd, remote, branch, commit, budgetBytes);
    const afterFresh = await remoteHead(remote, branch);
    if (afterFresh === commit) {
      console.log(`[openi] pushed → ${branch} @ ${commit.slice(0, 10)}`);
      return { commit, files, bytes, pushed: true, skipped: false, partial: false, filesPushed: pushed };
    }
    console.log(`[openi] 推进到 ${String(afterFresh).slice(0, 10)}，未追平 ${commit.slice(0, 10)} —— 下次运行继续`);
    return { commit, files, bytes, pushed: true, skipped: false, partial: true, at: afterFresh, filesPushed: pushed };
  }

  const sizes = {};
  for (const c of pending) sizes[c] = await commitAddedBytes(cwd, c);
  const batches = planBatches(pending, sizes, budgetBytes);

  if (dryRun) {
    const total = Object.values(sizes).reduce((a, b) => a + b, 0);
    console.log(`[openi] dry-run: ${pending.length} commit(s), ${(total / 1048576).toFixed(1)} MiB in ${batches.length} batch(es) — nothing pushed (pass --write)`);
    return { commit, files, bytes, pushed: false, skipped: false, pending: pending.length, batches: batches.length };
  }

  // ⚠ 单 commit 也可能超预算（2026-10-15 实测）：把远端与本地 assets-raw 并集合并后，
  // 一个 commit 的 delta 就有 600 MiB，而 OpenI 的 413 边界在 232–641 MiB 之间。
  // planBatches 只在 `cur.length` 非空时才比预算，空 batch 会整个吞下这个超预算 commit
  // ⇒ 一次 POST 600 MiB → HTTP 413（实测 38621866532）。commit 级分批在这棵树上结构性无效。
  // 兜底：这些 commit 走文件级分批（多次小 push，每次 ≤ budget）。
  const oversize = batches.flatMap((b) =>
    (b.length === 1 && (sizes[b[0]] || 0) > budgetBytes) ? [b[0]] : []);

  if (oversize.length) {
    const normal = batches.filter((b) => !(b.length === 1 && oversize.includes(b[0])));
    for (const [i, batch] of normal.entries()) {
      const head = batch[batch.length - 1];
      const batchBytes = batch.reduce((s, c) => s + (sizes[c] || 0), 0);
      console.log(`[openi] batch ${i + 1}/${normal.length}: ${batch.length} commit(s), ${(batchBytes / 1048576).toFixed(1)} MiB → ${head.slice(0, 10)}`);
      await run('git', ['push', '--quiet', remote, `${head}:refs/heads/${branch}`]);
    }
    for (const c of oversize) {
      console.log(`[openi] commit ${c.slice(0, 10)} 自身 ${(sizes[c] / 1048576).toFixed(1)} MiB > ${budgetBytes / 1048576} MiB —— 改文件级分批`);
      await pushCommitInSlices(cwd, remote, branch, c, budgetBytes);
    }
    const afterAll = await remoteHead(remote, branch);
    if (afterAll === commit) {
      console.log(`[openi] pushed → ${branch} @ ${commit.slice(0, 10)}`);
      return { commit, files, bytes, pushed: true, skipped: false, partial: false };
    }
    console.log(`[openi] 推进到 ${String(afterAll).slice(0, 10)}，未追平 ${commit.slice(0, 10)} —— 下次运行继续`);
    return { commit, files, bytes, pushed: true, skipped: false, partial: true, at: afterAll };
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
