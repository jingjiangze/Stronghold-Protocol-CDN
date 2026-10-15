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
 * ⚠ 2026-10-15 三次校准，别再把 diff 字节当预算。旧注释写的是「232 MiB 能过、641 MiB 413」，
 * 那个口径是 diff 字节，而一次 push 的真实成本是 pack 体积，含所有缺失祖先 blob 与沿途全部
 * tree 对象 —— 实测低估 8–30 倍（60.8 MiB diff → 566 MB pack → 413）。「232 MiB 能过」从来
 * 不是真的能过。
 *
 * 新口径下增量同步的实测：300 个文件 / 3.1 MiB pack，稳定两个数量级的安全余量。
 *
 * 为什么停在 20 而不是更大，**以及为什么这里原先的「强非线性惩罚」说法是错的**：
 * ⚠ 2026-10-15 深度审计推翻了这个归因。原注释写的「60 MiB/片 ≈ 1.40 s/文件，贵 7 倍」是拿
 * 本地 bare repo 的计时去外推 runner↔OpenI 链路 —— 但 run 38707181417 里**同一片 20 MiB**，
 * 每文件成本从 0.27 s 一路到 554 s，差 2,000 倍。成本不是体积的函数，是**那一次连接的健康度**
 * 的函数。真正的杀手是两个自己制造的问题：
 *   ① 客户端 300 s 超时一杀，`git-remote-https` 孤儿仍握着 TCP 连接（Actions 日志里有
 *      `Terminate orphan process: pid (4528) (git-remote-https)` 实证），占着服务端 receive-pack
 *      槽位和下一次 push 抢同一个 ref ⇒ 正反馈。
 *   ② 重试退避 10 s×i 不设上限，累计能到 420 s，于是失败间隔永远是 ≈300 s + 退避，
 *      看起来就像「每 5 分钟挂一次」，其实那是我们自己的时钟。
 * 现在这两条都修了（`run` 用进程组杀、`pushSlice` 退避封顶 40 s 且设总时长上限），
 * 20 MiB 保留的理由回归朴素：它是实测增量 pack 的安全量级，且**单片大文件已经由
 * BIG_FILE_BYTES 单独拆走**（大文件才是慢的真来源，不是预算本身）。
 *
 * 20 MiB 仍推不完 20,000 份（约 2.3 小时 > 90 分钟 timeout），但 `syncByFiles` 幂等、
 * 每次从远端当前树续算差集，所以多轮触发会收敛 —— 这正是它该有的形状。
 */
export const DEFAULT_BUDGET_MIB = Number(process.env.OPENI_BUDGET_MIB) || 20;

/**
 * 从一次失败的 child process 里挑出真正有信息的那几行。
 *
 * 为什么不能 `String(e.message).split('\n').pop().slice(0, 120)`：git 的 fatal 行后面往往还跟着
 * 空行或 "hint: ..." 提示，pop() 取到最后一行等于把真因丢掉 —— run 38707181417 的 push 重试日志
 * 就是这么全军覆没的（十条失败记录里九条只剩 `git push --quiet https://...` 的命令名前 120 字符）。
 * 这里优先抓 `fatal:`/`error:`，退化到 stderr 尾部，再退化到 message 尾部。
 */
export function failTail(e, keep = 200) {
  const msg = String(e?.message ?? e ?? '');
  const errText = String(e?.stderr ?? '');
  const pool = [errText, msg];
  for (const text of pool) {
    if (!text) continue;
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const hit = lines.filter((l) => /^(fatal|error|remote:)/.test(l));
    if (hit.length) return hit.join(' | ').slice(-keep);
    if (lines.length) return lines.join(' | ').slice(-keep);
  }
  return msg.slice(-keep);
}

/**
 * Promise wrapper around a child process that fails loudly, with the tool's own stderr.
 *
 * `detached: true` 是超时杀进程树的前提：git 会把真正的 HTTP 传输甩给 `git-remote-https`
 * 子进程，只 `child.kill()` 杀 git 父进程会留下一个**仍握着 TCP 连接到 OpenI 的孤儿**。
 * run 38707181417 的 Actions 日志里那条 `Terminate orphan process: pid (4528) (git-remote-https)`
 * 就是证据。孤儿会占着服务端的 receive-pack 槽位，与下一次 push 并发写同一个 ref ⇒ 越超时越容易
 * 再超时，是个正反馈。用 `-child.pid` 打整个进程组才杀得干净。
 */
export function run(cmd, args, opts = {}) {
  const { timeoutMs = 0, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...spawnOpts,
    });
    let out = '';
    let err = '';
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done(reject, e));
    // 可选超时：remoteHead 用它划清「分支不存在」与「探测卡死」。默认 0 = 不设（push
    // 本身可能 legitimately 跑几十分钟，不能一刀切）。
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 进程组已退出 */ }
        done(reject, new Error(`${cmd} ${args.join(' ')} → 超时 ${timeoutMs}ms 未返回`));
      }, timeoutMs);
      timer.unref();
    }
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      code === 0
        ? done(resolve, out)
        : done(reject, new Error(`${cmd} ${args.join(' ')} → exit ${code}\n${(err || out).trim().slice(0, 2000)}`));
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
 *
 * ⚠ 但单次超时即抛同样毁掉整轮作业 —— run 38704949047 就是这样死的：ls-remote 在 runner 上
 * 卡了 120s（同一时刻本机探测只要 0.3–0.55s，OpenI 本身健康），作业 exit 1，一个字节都没推。
 * 一次网络抖动不该让 90 分钟的预算作废，所以这里和 push 一样重试；单次超时同时放宽到 3 分钟，
 * 因为 push 侧实测「连接被挂」可以持续 5 分钟以上，探测给少了只会提前误判。
 */
export async function remoteHead(remote, branch, { timeoutMs = 180000, attempts = 5 } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const out = await run('git', ['ls-remote', remote, `refs/heads/${branch}`], { timeoutMs });
      const m = out.trim().split(/\s+/)[0];
      return m || null;
    } catch (e) {
      last = e;
      const backoff = Math.min(15000 * i, 60000);
          process.stderr.write(`[openi] ls-remote 第 ${i}/${attempts} 次失败（${failTail(e, 160)}），${backoff / 1000}s 后重试\n`);
      if (i < attempts) await new Promise((s) => setTimeout(s, backoff));
    }
  }
  throw last;
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
 *
 * 2026-10-15 两个新约束，都是被实测逼出来的：
 *
 * ① **大文件单独成片。** `assets/packs/*.zip` 单份 16–64 MiB，`packs/sp-forge-*` 单份最大 29.8 MiB。
 *    它们和 30 KiB 的小文件混在同一个 20 MiB 预算里时，一片可能是「2 份 / 75 MiB」——run
 *    38707181417 的最后 60 分钟只推进了 7 份，全部耗在这种片上（实测 493–554 s/份，且几乎必然再次
 *    触发客户端超时 ⇒ 5 次全废 ⇒ 整片作废）。超过 `bigFileBytes` 的文件各自独占一片，小文件的
 *    round trip 数不受影响，大文件也不必和小文件一起陪葬。
 *
 * ② **单片文件数上限。** round trip 数 = 片数，171 片 vs 200 份/片的 45 片是个 3.8 倍差距。
 *    只按字节切时 `assets/audio` 那种平均 30.5 KiB 的目录能一片塞 1,446 份，服务端处理长尾全压在
 *    一片里。加上份数上限后单片工作量有界。
 *
 * 另按 size 降序排：字典序下 `assets/packs` 恰好排在最后，run 38707181417 就这么死在大 zip 区；
 * 而降序让小文件先走完（小文件段实测效率是大文件段的 ~300 倍）。⚠ 这一条只是让形状稳定，
 * 真正的保证来自 ①。
 */
export const BIG_FILE_BYTES = 8 * 1024 * 1024;   // 超过它单独成片
export const MAX_FILES_PER_SLICE = 200;          // 单片文件数上限

export function planSlices(todo, budgetBytes) {
  const big = BIG_FILE_BYTES;
  const maxFiles = MAX_FILES_PER_SLICE;
  // 降序：小文件先推完。稳定排序，同尺寸保持原字典序。
  const sorted = [...todo].sort((a, b) => b.size - a.size);

  const slices = [];
  let cur = [];
  let curBytes = 0;
  const flush = () => { if (cur.length) { slices.push(cur); cur = []; curBytes = 0; } };

  for (const r of sorted) {
    if (r.size >= big) { flush(); slices.push([r]); continue; }
    cur.push(r);
    curBytes += r.size;
    if (curBytes >= budgetBytes || cur.length >= maxFiles) flush();
  }
  flush();
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
 * ⚠ 2026-10-15 三次修订，前两次的判断都是错的：
 *
 * 1. `timeoutMs` 从 300 s 降到 120 s。原注释说「300s matches what the transport itself gives up on」，
 *    但实测 20 MiB 片的健康耗时只有 36–58 s，300 s 是给服务端 6–8 倍宽限。后果是 run 38707181417
 *    那条极稳定的「每 5 分钟挂一次」序列（`08:55:34 → 09:01:04 → 09:08:05 → …`）——失败间隔
 *    330/301/332/350 s，几乎全是 `300 s 超时 + 30/60 s 退避`。**那不是 OpenI 的限流周期，是
 *    我们自己在 SIGKILL 自己的连接。**（真因文本也只有过一次：`Recv failure: Connection reset by
 *    peer`，TCP 层 RST，不是 HTTP 4xx。）
 *
 * 2. `run()` 改为 `detached` + `process.kill(-pid)` 杀进程组。只杀 git 父进程会留下仍握着
 *    TCP 连接的孤儿 `git-remote-https`（Actions 日志里 `Terminate orphan process: pid (4528)
 *    (git-remote-https)` 是实证），孤儿占着服务端 receive-pack 槽位并与下一次 push 并发写同一
 *    ref ⇒ 越超时越容易再超时。
 *
 * 3. 退避从 `min(30000*i, 120000)`（5 次全败累计 420 s，等于白吃掉 7 分钟预算）改为
 *    `min(10000*i, 40000)`，并给整个 slice 的重试设总时长上限 `maxTotalMs`：超了就抛，
 *    让上层决定要不要继续，而不是把 90 分钟全耗在退避上。
 *
 * `bigFile` 的一片允许更长超时：64 MiB 的 blob 服务端要 index-pack，2 分钟不够。给它 5 分钟，
 * 并且不参与「总重试时长」的累计——大文件本来就该是少数几片。
 */
async function pushSlice(url, branch, {
  cwd, timeoutMs = 120000, attempts = 5, bigFile = false, maxTotalMs = 300000,
} = {}) {
  const perAttempt = bigFile ? 300000 : timeoutMs;
  const started = Date.now();
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      await run('git', ['push', '--quiet', url, `refs/heads/_openi_sync:refs/heads/${branch}`],
        { cwd, timeoutMs: perAttempt });
      return;
    } catch (e) {
      last = e;
      // 退避：对端是限流/连接被挂，立刻重试只会再撞一次。10s 起，最长 40s。
      const backoff = Math.min(10000 * i, 40000);
      const spent = Date.now() - started;
      const label = bigFile ? 'push(大文件)' : 'push';
      process.stderr.write(`[openi] ${label} 第 ${i}/${attempts} 次失败（已耗 ${(spent / 1000).toFixed(0)}s；${failTail(e, 160)}），${backoff / 1000}s 后重试\n`);
      if (i < attempts) {
        // 大文件片不累计：它本来就该是少数几片，且每次尝试 5 分钟，累计上限会把唯一的机会砍掉。
        if (!bigFile && Date.now() - started + backoff > maxTotalMs) {
          throw new Error(`[openi] ${label} 重试已耗 ${((Date.now() - started) / 1000).toFixed(0)}s 超过上限 ${maxTotalMs / 1000}s，放弃本片：${failTail(last, 200)}`);
        }
        await new Promise((s) => setTimeout(s, backoff));
      }
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
  //
  // ⚠ 这一步也重试：它是 `g()`（同步 execFileSync，没法在调用点退避）里唯一一次碰网络的命令，
  // 而 run 38704949047 证明 runner↔OpenI 的连接会整段挂掉几分钟。挂在这里同样让整轮作废，
  // 且比 ls-remote 更贵 —— 差集计算全压在这棵树身上。
  const fetchRemoteTree = async () => {
    for (let i = 1; i <= 5; i++) {
      try {
        await g('fetch', '--quiet', '--depth', '1', '--no-tags', url,
          `+refs/heads/${branch}:refs/remotes/_openi_mirror/${branch}`);
        return;
      } catch (e) {
        const backoff = Math.min(15000 * i, 60000);
          process.stderr.write(`[openi] fetch 远端树第 ${i}/5 次失败（${failTail(e, 160)}），${backoff / 1000}s 后重试\n`);
        if (i < 5) await new Promise((s) => setTimeout(s, backoff));
        else throw e;
      }
    }
  };
  await fetchRemoteTree();
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
        // 单文件 ≥ BIG_FILE_BYTES 的片是「大文件片」：给它 5 分钟/次而不是 2 分钟，且不参与
        // 重试总时长累计。判据用片内最大文件，而不是份数——一片 200 份小文件和一份 64 MiB
        // 需要完全不同的耐心。
        const biggest = Math.max(...slice.map((r) => r.size));
        await pushSlice(url, branch, { cwd, bigFile: biggest >= BIG_FILE_BYTES });
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
