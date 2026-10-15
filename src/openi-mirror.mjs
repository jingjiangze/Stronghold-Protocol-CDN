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
// ⚠ `execFileSync` 必须静态导入：`syncByFiles` 在主流程里同步调它几十次（read-tree /
// update-index / write-tree / commit-tree / update-ref），动态 import 在这里只会多一次等待，
// 而且曾经因为只写了 `spawn` 而在 CI 上抛 "execFileSync is not defined" —— 纯函数测试 import
// 不到这条路径，抓不出来。改这个文件时先看一眼 `node --test tests/openi-mirror.test.mjs` 之外
// 还跑不跑 `node src/openi-mirror.mjs` 干跑。
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The branch holding the art tree in this repository. */
export const ASSETS_REF = process.env.OPENI_ASSETS_REF || 'assets-raw';

/** Refuse to mirror anything this large: a guard against pushing the wrong ref by mistake. */
export const MAX_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Ceiling for one push, in MiB, measured as the slice's **blob bytes**.
 *
 * ⚠ 2026-10-15 重新校准。旧注释写的是「232 MiB 能过、641 MiB 413」，那个口径是 diff 字节，
 * 而一次 push 的真实成本是 pack 体积，含所有缺失祖先 blob 与沿途全部 tree 对象 —— 实测低估
 * 8–30 倍（60.8 MiB diff → 566 MB pack → 413）。所以「232 MiB 能过」从来不是真的能过。
 *
 * 新口径下增量同步的实测：300 个文件 / 3.1 MiB pack，稳定两个数量级的安全余量。
 *
 * 60 MiB 是 run 38683553998 之后的取值：20 MiB/片在 OpenI 上实测 41s/片（几乎全是 RTT，
 * 本地同一步只要 0.5s），20,000 份的差集要跑 3.8 小时，超过 workflow 的 90 分钟 timeout。
 * 而 60 MiB 的增量 pack 仍比 413 边界低一个数量级，round trip 数降到 1/3。
 */
export const DEFAULT_BUDGET_MIB = Number(process.env.OPENI_BUDGET_MIB) || 60;

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
 * Files the remote is missing, in `ls-tree -l` row shape.
 *
 * Pure, so the diff that decides what gets pushed is testable without a network: the set algebra
 * here is the whole sync, and a bug in it either re-uploads 20,000 files or silently skips them.
 *
 * @param {string} remoteTree `ls-tree -r --name-only` output of the remote's tree
 * @param {string} targetTree `ls-tree -r -l` output of the tree we want the remote to hold
 */
export function missingFiles(remoteTree, targetTree) {
  const have = new Set(String(remoteTree || '').split('\n').filter(Boolean));
  const todo = [];
  for (const line of String(targetTree || '').split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab).trim().split(/\s+/);
    const p = line.slice(tab + 1);
    if (meta[1] !== 'blob' || have.has(p)) continue;
    todo.push({ mode: meta[0], sha: meta[2], size: Number(meta[3]) || 0, p });
  }
  return todo;
}

/**
 * Group files into slices, greedy on accumulated blob bytes.
 *
 * A slice grows until it *reaches* `budgetBytes` and then closes, so a slice's size is bounded by
 * `budgetBytes + (largest single file)`. That overhang is unavoidable and harmless: a single file
 * cannot be split, and the tree's largest blob is far below the 413 boundary on its own. What this
 * replaces is a budget measured in *diff* bytes, which under-reported a real push by 8–30x — see
 * the table on `syncByFiles`.
 */
export function planSlices(todo, budgetBytes) {
  const slices = [];
  let cur = [];
  let curBytes = 0;
  for (const r of todo) {
    cur.push(r);
    curBytes += r.size;
    if (curBytes >= budgetBytes) {
      slices.push(cur);
      cur = [];
      curBytes = 0;
    }
  }
  if (cur.length) slices.push(cur);
  return slices;
}

/**
 * Push one slice, retrying a stalled connection instead of losing the whole run to it.
 *
 * Why: run 38683553998 pushed 46 of ~200 slices successfully, then died on
 * `Failed to connect to openi.pcl.ac.cn port 443 after 300019 ms`. The pack size was never the
 * problem — the host simply stopped accepting from GitHub's runner IP for five minutes. Since each
 * push is idempotent (the ref is created before it is sent, and re-sending the same ref is a
 * no-op), a retry costs nothing and turns a five-minute network blip into a 30-second one.
 *
 * A 300 s default matches what the transport itself gives up on; anything shorter would kill a
 * large slice mid-flight and make the retry re-send it.
 */
async function pushSlice(url, branch, { cwd, timeoutMs = 300000, attempts = 5 } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      await run('git', ['push', '--quiet', url, `refs/heads/_openi_sync:refs/heads/${branch}`],
        { cwd, timeoutMs });
      return;
    } catch (e) {
      last = e;
      // 退避：对端是限流/连接被挂，立刻重试只会再撞一次。30s 起，最长 2 分钟。
      const backoff = Math.min(30000 * i, 120000);
      process.stderr.write(`[openi] push 第 ${i}/${attempts} 次失败（${String(e.message).split('\n').pop().slice(0, 120)}），${backoff / 1000}s 后重试\n`);
      if (i < attempts) await new Promise((s) => setTimeout(s, backoff));
    }
  }
  throw last;
}

export async function syncByFiles(cwd, remote, branch, targetRef, budgetBytes, { onProgress } = {}) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const scratch = path.join(os.tmpdir(), `openi-sync-${process.pid}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: scratch };
  const g = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
  // `gi` 与 `g` 同参数，但走 scratch index。最后一个参数可以是 `{ input }` —— update-index 的
  // --index-info 只能从 stdin 读，没法用命令行传 2000 行。
  // ⚠ 签名与 `g` 保持一致（spread，字符串参数直接摊开）曾经是坑：写成 `(args, opts)` 数组形式后，
  // `gi('read-tree', remoteRef)` 这种字符串调用会抛 ERR_INVALID_ARG_TYPE —— 离线集成测试才抓到。
  const gi = (...a) => execFileSync('git', a, {
    cwd, env, encoding: 'utf8', maxBuffer: 1 << 28,
  }).trim();
  // update-index 的 stdin 变体：args 同上，`input` 是喂进去的 index-info 文本。
  const giIn = (input, ...a) => execFileSync('git', a, {
    cwd, env, encoding: 'utf8', maxBuffer: 1 << 28, input,
  }).trim();
  const url = (await run('git', ['remote', 'get-url', remote], { cwd })).trim();

  // 远端的树。fetch 的是浅 ref：只需要树的形状来算出差集，不需要它的 blob —— 那些字节
  // 已经在 cwd 的对象库里（这棵树就是从这里推出去的），用 ls-tree 的 sha 直接引用即可。
  await g('fetch', '--quiet', '--depth', '1', '--no-tags', url, `+refs/heads/${branch}:refs/remotes/_openi_mirror/${branch}`);
  const remoteRef = `refs/remotes/_openi_mirror/${branch}`;
  let parent;
  try {
    parent = await g('rev-parse', '--verify', remoteRef);
  } catch {
    parent = null;   // 远端还没有这个分支：从零开始，第一个 commit 没有父提交
  }

  // 远端已有的路径集合（幂等：重跑不会重传）
  const remoteTree = parent
    ? await g('ls-tree', '-r', '--name-only', remoteRef)
    : '';

  const target = await g('ls-tree', '-r', '-l', targetRef);
  const todo = missingFiles(remoteTree, target);

  const totalBytes = todo.reduce((s, r) => s + r.size, 0);
  const remoteCount = remoteTree.split('\n').filter(Boolean).length;
  process.stderr.write(`[openi] 文件级同步：远端有 ${remoteCount} 份，待补 ${todo.length} 份 / ${(totalBytes / 1048576).toFixed(1)} MiB\n`);

  if (!todo.length) {
    if (parent) {
      // 远端文件齐了，但它的 HEAD 可能还停在旧的 commit。把本地 HEAD 的树推成一次空提交，
      // 让 sha 对齐 —— 否则下次运行又会重算一遍差集。
      await gi('read-tree', targetRef);
      const tree = await gi('write-tree');
      if (tree !== (await g('rev-parse', '--verify', `${remoteRef}^{tree}`))) {
        const c = await g('-c', 'user.name=cdn-bot', '-c', 'user.email=cdn-bot@users.noreply.github.com',
          '-c', 'commit.gpgsign=false', 'commit-tree', tree,
          ...(parent ? ['-p', parent] : []), '-m', 'assets: 对齐素材树');
        await g('update-ref', 'refs/heads/_openi_sync', c);
        // ⚠ `cwd` 必须传：漏了它 push 就在进程自己的工作目录里跑，报
        // "src refspec refs/heads/_openi_sync does not match any"。CI 上恰好看不出来
        // （checkout 的 cwd 就是仓库根），是离线集成测试才把它照出来的。
        await pushSlice(url, branch, { cwd });
        parent = c;
      }
    }
    await g('update-ref', '-d', remoteRef);
    fs.rmSync(scratch, { force: true });
    return { pushed: 0, total: 0, partial: false, at: parent };
  }

  // 把远端的树灌进 scratch index：不灌的话第一个 commit 会把远端已有内容全删掉。
  if (parent) {
    await gi('read-tree', remoteRef);
  } else {
    await gi('read-tree', '--empty');
  }

  let pushed = 0;
  let partial = false;
  try {
    for (const slice of planSlices(todo, budgetBytes)) {
      const sliceBytes = slice.reduce((s, r) => s + r.size, 0);
      for (let k = 0; k < slice.length; k += 2000) {
        await giIn(
          slice.slice(k, k + 2000).map((r) => `${r.mode} ${r.sha}\t${r.p}`).join('\n') + '\n',
          'update-index', '--add', '--index-info',
        );
      }
      const tree = await gi('write-tree');
      const headTree = parent ? await g('rev-parse', '--verify', `${parent}^{tree}`) : null;
      if (tree !== headTree) {
        const c = await g('-c', 'user.name=cdn-bot', '-c', 'user.email=cdn-bot@users.noreply.github.com',
          '-c', 'commit.gpgsign=false', 'commit-tree', tree,
          ...(parent ? ['-p', parent] : []),
          '-m', `assets: 补入素材树（${slice.length} 份，${(sliceBytes / 1048576).toFixed(1)} MiB）`);
        await g('update-ref', 'refs/heads/_openi_sync', c);
        await pushSlice(url, branch, { cwd });
        parent = c;
        pushed += slice.length;
        if (onProgress) onProgress(pushed, todo.length, sliceBytes);
        // stderr：GitHub Actions 实时转发 stderr，stdout 会被 logdriver 聚合缓冲 —— 一次 3 小时的
        // 同步里，缓冲让进度日志看起来像「卡在某一帧不动」，无法判断是死了还是在跑。
        process.stderr.write(`[openi] 已推 ${pushed}/${todo.length} 份（本片 ${(sliceBytes / 1048576).toFixed(1)} MiB）\n`);
      } else {
        // 树没变（这组文件 sha 与远端相同，只是路径集合的差集计算偏差）——不制造空提交。
        pushed += slice.length;
        process.stderr.write(`[openi] 跳过 ${slice.length} 份（远端已有相同内容）\n`);
      }
    }
  } catch (e) {
    // 推失败：保留已推进的 parent，下一次运行从那里继续。不谎报完成。
    partial = true;
    await g('update-ref', '-d', remoteRef);
    fs.rmSync(scratch, { force: true });
    throw e;
  }

  await g('update-ref', '-d', remoteRef);
  fs.rmSync(scratch, { force: true });
  return { pushed, total: todo.length, partial, at: parent };
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
  // Per-push ceiling, in **blob bytes of one slice**. `syncByFiles` measures its slices against
  // this; see the note there for why diff bytes (the old metric) under-reported a real push 8-30x.
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

  // Sync by file, from the remote's own tree outward — not by replaying the commits.
  //
  // ⚠ 2026-10-15 换方案（run 38671002854 在第一个 batch 上 413、白跑 57 分钟）：
  // 旧的 commit 级 replay 用 diff 字节做预算，而一次 push 的真实成本是它的 **pack** 体积，
  // 里面还含所有缺失祖先 blob 和沿途全部 tree 对象。实测低估 8–30 倍：
  //   60.8 MiB diff → 566 MB pack（413）
  //   196.3 MiB diff → 603 MB pack（413）
  //   255.7 MiB diff → 829 MB pack（413）
  // 这个比值逐 commit 变化，没有哪个按 diff 字节定的预算能救。改成从远端已有的树出发按文件
  // 增量补：远端已持有祖先对象，每次 push 是真增量（实测 300 份 → 3.1 MiB）。
  const result = await syncByFiles(cwd, remote, branch, assetsRef, budgetBytes);
  const after = await remoteHead(remote, branch);
  const caught = after === commit;
  if (caught) {
    console.log(`[openi] pushed → ${branch} @ ${commit.slice(0, 10)}（本次补入 ${result.pushed} 份）`);
    return { commit, files, bytes, pushed: true, skipped: false, partial: false, filesPushed: result.pushed };
  }
  // 追平有两种含义：文件全补齐了但 HEAD 还停在别的 commit（树内容一致，只是 ref 没对齐），
  // 和真的还有文件没推。分开说，别把前者说成失败。
  const allFiles = result.pushed >= result.total;
  console.log(`[openi] ${allFiles ? '文件已补齐' : '已推进'}：本次 ${result.pushed}/${result.total} 份；远端 ${String(after).slice(0, 10)}，目标 ${commit.slice(0, 10)}`);
  return { commit, files, bytes, pushed: true, skipped: false, partial: !allFiles, at: after, filesPushed: result.pushed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(String(e && e.message ? e.message : e));
    process.exit(1);
  });
}
