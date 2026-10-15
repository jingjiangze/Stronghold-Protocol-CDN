import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLsTree, listTree, totalBytes, remoteHead, localHead, MAX_BYTES,
  planBatches, DEFAULT_BUDGET_MIB, missingFiles, planSlices, failTail,
} from '../src/openi-mirror.mjs';

// `git ls-tree -l` puts the size in a SPACE-separated column and introduces only the path with a
// tab. Splitting the whole line on tabs therefore yields size 0 for every file — a mirror whose
// payload looks empty and whose guard against pushing the wrong ref never fires. These cases pin
// the real format down.
const LS_TREE = [
  '100644 blob 5a8a6cb124807e45611799d63383372eac491824 609\t.gitattributes',
  '100644 blob 70cbdc05635c6b79661f36f04cfd91b49c9f1df8 3289397\tassets/local/map/autochess/TX_autochessi_D.png',
  '100644 blob e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0\tassets/empty.bin',
  '',
].join('\n');

test('ls-tree -l rows are parsed into mode/type/sha/size/path', () => {
  const rows = parseLsTree(LS_TREE);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    mode: '100644',
    type: 'blob',
    sha: '5a8a6cb124807e45611799d63383372eac491824',
    size: 609,
    path: '.gitattributes',
  });
  // A big file is the one a size-0 bug would hide, and the one MAX_BYTES exists for.
  assert.equal(rows[1].size, 3289397);
  assert.equal(rows[1].path, 'assets/local/map/autochess/TX_autochessi_D.png');
});

test('a zero-byte file is kept with size 0 rather than dropped', () => {
  const empty = parseLsTree(LS_TREE).find((r) => r.path === 'assets/empty.bin');
  assert.ok(empty);
  assert.equal(empty.size, 0);
});

test('a path containing a space survives parsing', () => {
  const rows = parseLsTree('100644 blob abcdef 42\tsome dir/a file.png\n');
  assert.equal(rows[0].path, 'some dir/a file.png');
  assert.equal(rows[0].size, 42);
});

test('totalBytes sums blob sizes', () => {
  assert.equal(totalBytes(parseLsTree(LS_TREE)), 609 + 3289397 + 0);
});

test('the size guard has a ceiling that a normal art tree fits under', () => {
  // 914.6 MiB today; the guard exists to catch a wrong --assets-ref, not to be tight.
  assert.ok(MAX_BYTES > 915 * 1024 * 1024);
});

// These talk to git, but only to this repository or to a remote name that does not exist; neither
// needs the network.
test('localHead resolves a ref that exists', async () => {
  const sha = await localHead(process.cwd(), 'HEAD');
  assert.match(sha, /^[0-9a-f]{40}$/);
});

test('listTree on this repo returns rows with a real size', async () => {
  const rows = await listTree(process.cwd(), 'HEAD');
  assert.ok(rows.length > 0);
  assert.ok(rows.some((r) => r.size > 0), 'expected at least one non-empty file');
});

// ⚠ 2026-10-15 改判据（run 38633412096）：这条测试原本断言「远端不可用时返回 null」，
// 而那正是事故的形状 —— 一次慢到 300 秒的 ls-remote 被 catch 成 null，下游把「没探到」
// 当成「分支不存在」，于是零推送、却打印 "advanced to …, 0 commit(s) left"。
// 现在 null 只表示「ls-remote 成功、但远端确实没有这个分支」；探测失败必须抛错。
test('remoteHead throws when the remote cannot be reached, instead of reporting an absent branch', async () => {
  await assert.rejects(() => remoteHead('definitely-not-a-remote', 'master'));
});

test('remoteHead returns null only when the branch genuinely is not there', async () => {
  assert.equal(await remoteHead(process.cwd(), 'no-such-branch-here'), null);
});

// The 413 that forced the rewrite: `git push` is one POST, so the only lever is how many bytes
// that POST carries. These pin the arithmetic, because a batching bug is invisible until a run
// 413s — which is exactly the failure that costs an hour to find out about.
const MB = 1048576;

// `planBatches` / `commitAddedBytes` / `commitsSince` are the *old* commit-level replay, kept
// because they are pure and still exercised; `syncByFiles` replaced them in the live path
// (2026-10-15, run 38671002854 413'd on its first batch after 57 minutes).

test('planBatches keeps every batch under the budget', () => {
  const commits = ['a', 'b', 'c', 'd'];
  const sizes = { a: 400 * MB, b: 400 * MB, c: 400 * MB, d: 400 * MB };
  const batches = planBatches(commits, sizes, 700 * MB);
  assert.equal(batches.length, 4, 'each 400 MiB commit needs its own push under a 700 MiB budget');
  for (const b of batches) {
    const sum = b.reduce((s, c) => s + sizes[c], 0);
    assert.ok(sum <= 700 * MB, `batch of ${sum / MB} MiB exceeds budget`);
  }
});

test('planBatches packs small commits together rather than pushing one at a time', () => {
  const commits = ['a', 'b', 'c', 'd'];
  const sizes = { a: 100 * MB, b: 100 * MB, c: 100 * MB, d: 100 * MB };
  const batches = planBatches(commits, sizes, 700 * MB);
  // Four small commits in one batch: batching is about the ceiling, not about being timid.
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], commits);
});

test('planBatches preserves commit order across batch boundaries', () => {
  const commits = ['a', 'b', 'c', 'd', 'e'];
  const sizes = { a: 300 * MB, b: 300 * MB, c: 300 * MB, d: 300 * MB, e: 300 * MB };
  const flat = planBatches(commits, sizes, 700 * MB).flat();
  // Order is the whole point: replaying out of order would push a tip whose ancestors are missing.
  assert.deepEqual(flat, commits);
});

test('a commit larger than the budget still gets its own batch', () => {
  const commits = ['small', 'huge'];
  const sizes = { small: 10 * MB, huge: 900 * MB };
  const batches = planBatches(commits, sizes, 700 * MB);
  assert.deepEqual(batches, [['small'], ['huge']]);
});

test('a commit with no recorded size is treated as zero, not as a reason to stop', () => {
  const commits = ['known', 'unknown'];
  const sizes = { known: 500 * MB };
  const batches = planBatches(commits, sizes, 700 * MB);
  assert.deepEqual(batches, [['known', 'unknown']]);
});

test('planBatches on an empty replay pushes nothing', () => {
  assert.deepEqual(planBatches([], {}, 700 * MB), []);
});

// --- the live path: file-level incremental sync -------------------------------
//
// `missingFiles` decides what gets pushed. Getting it wrong in one direction re-uploads the whole
// 3.8 GiB tree; in the other it silently skips files and the mirror never catches up. Both
// failures look like a successful run, so they need tests rather than trust.

const REMOTE = [
  '.gitattributes',
  'README.md',
  'assets/local/map/a.png',
  'assets/local/map/b.png',
].join('\n');

const TARGET = [
  '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 609\t.gitattributes',
  '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 3289397\tassets/local/map/a.png',
  '100644 blob cccccccccccccccccccccccccccccccccccccccc 1024\tassets/local/map/new.png',
  '100644 blob dddddddddddddddddddddddddddddddddddddddd 2048\tassets/voice/x.mp3',
  '040000 tree eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\tassets/local',
].join('\n');

test('missingFiles keeps only the files the remote does not already have', () => {
  const todo = missingFiles(REMOTE, TARGET);
  assert.deepEqual(todo.map((r) => r.p), ['assets/local/map/new.png', 'assets/voice/x.mp3']);
});

test('missingFiles carries the blob size, which is what the push budget is measured against', () => {
  const todo = missingFiles(REMOTE, TARGET);
  assert.equal(todo[0].size, 1024);
  assert.equal(todo[1].size, 2048);
});

test('missingFiles drops trees: a directory entry is not a file to upload', () => {
  const todo = missingFiles(REMOTE, TARGET);
  assert.ok(!todo.some((r) => r.p === 'assets/local'));
  assert.ok(todo.every((r) => r.mode === '100644'));
});

test('missingFiles on a remote that has nothing returns the whole tree', () => {
  const todo = missingFiles('', TARGET);
  assert.equal(todo.length, 4);
});

test('missingFiles on a remote that already has everything returns nothing', () => {
  // The remote arg is name-only; every path in TARGET is named, so nothing to do. This is the
  // idempotence that makes a re-run free: it must not re-upload 20,000 files.
  const names = TARGET.split('\n').map((l) => l.slice(l.indexOf('\t') + 1));
  assert.equal(missingFiles(names.join('\n'), TARGET).length, 0);
});

test('a path with a space survives the diff', () => {
  const todo = missingFiles('', '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 42\tsome dir/a file.png');
  assert.deepEqual(todo, [{ mode: '100644', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', size: 42, p: 'some dir/a file.png' }]);
});

test('planSlices cuts the work into pieces each under the budget', () => {
  const todo = [
    { p: 'a', size: 15 * MB },
    { p: 'b', size: 15 * MB },
    { p: 'c', size: 15 * MB },
  ];
  // Greedy: a slice grows until it *reaches* the budget, then closes. 15 MiB alone is under 20, so
  // 'a' stays open, 'b' pushes it to 30 (>= 20) and closes it, and 'c' opens the last slice.
  const slices = planSlices(todo, 20 * MB);
  assert.deepEqual(slices.map((s) => s.map((r) => r.p)), [['a', 'b'], ['c']]);
  for (const s of slices) {
    const sum = s.reduce((t, r) => t + r.size, 0);
    assert.ok(sum <= 20 * MB + 15 * MB, `slice of ${sum / MB} MiB is far above the ${20} MiB budget`);
  }
});

test('planSlices groups small files instead of pushing one at a time', () => {
  const todo = Array.from({ length: 300 }, (_, i) => ({ p: `f${i}`, size: 10 * 1024 }));
  // 300 files / 3.1 MiB is the measured shape of one push; it must stay one slice.
  const slices = planSlices(todo, 20 * MB);
  assert.equal(slices.length, 1);
  assert.equal(slices[0].length, 300);
});

test('planSlices loses no file and keeps order across slice boundaries', () => {
  const todo = Array.from({ length: 500 }, (_, i) => ({ p: `f${i}`, size: 100 * 1024 }));
  const flat = planSlices(todo, 5 * MB).flat();
  assert.equal(flat.length, 500);
  assert.deepEqual(flat.map((r) => r.p), todo.map((r) => r.p));
});

test('planSlices on nothing pushes nothing', () => {
  assert.deepEqual(planSlices([], 20 * MB), []);
});

// ─── failTail：重试日志必须真的能失败 ─────────────────────────────────────────
// 原来的写法是 `String(e.message).split('\n').pop().slice(0, 120)`，取的是最后一行。
// git 的 fatal 行后面常跟着空行 / "hint:" 提示，于是 run 38707181417 的十条 push 失败记录里
// 九条只剩 `git push --quiet https://openi...` 的命令名前 120 字符，真因全部丢失。
// 这三条既是用例也是对照：第一条若也 FAIL，说明 failTail 本身退化了。
test('failTail picks the fatal line out of a git error, not the trailing blank', () => {
  // run 38707181417 真实抓到过一次的形状：fatal 在中间，尾部是空行
  const e = Object.assign(
    new Error("git push --quiet https://openi.pcl.ac.cn/jingjiangze/Stronghold-Protocol.git refs/heads/_openi_sync:refs/heads/assets-raw → exit 128\nfatal: unable to access 'https://openi.pcl.ac.cn/...': Recv failure: Connection reset by peer\n"),
    { stderr: "remote: \nfatal: unable to access 'https://openi.pcl.ac.cn/...': Recv failure: Connection reset by peer\n\n" },
  );
  const tail = failTail(e, 160);
  assert.match(tail, /Recv failure: Connection reset by peer/);
  assert.doesNotMatch(tail, /^git push --quiet/); // 不能退化回「只剩命令名」
});

test('failTail keeps the remote: rejection line, which is what a 413 looks like', () => {
  const e = Object.assign(new Error('push → exit 1'), {
    stderr: 'remote: Resolving deltas: 100% (12/12)\nremote: error: pack exceeds maximum allowed size\n',
  });
  assert.match(failTail(e), /pack exceeds maximum allowed size/);
});

test('failTail still says something when there is no fatal/error line at all', () => {
  // 退化路径：全部行都没有 fatal/error/remote: 前缀时，必须仍返回非空内容而不是空串
  assert.ok(failTail(new Error('something odd happened')).length > 0);
  assert.equal(failTail(new Error('')), '');
});

test('the default budget is sized for the measured incremental pack, not the old diff bytes', () => {
  // 300 files measured 3.1 MiB of pack. The old default of 200 MiB was calibrated on diff bytes,
  // which under-report a push by 8–30x — that miscalibration is what 413'd run 38671002854.
  //
  // The upper bound is the interesting part. Bigger is NOT better on this link: locally a 60 MiB
  // slice pushes faster than twelve 5 MiB ones, but OpenI charges per-file ~7x more when the
  // slice is 60 MiB (1.40 s/file) than 20 MiB (0.20 s/file) — run 38687681729 spent its whole
  // 90-minute budget on ~5 slices and got cancelled. So the budget has to stay near the small end
  // where RTT dominates and the server-side per-byte penalty is still flat; 32 MiB is the line.
  assert.ok(DEFAULT_BUDGET_MIB > 0);
  assert.ok(DEFAULT_BUDGET_MIB <= 32,
    `budget ${DEFAULT_BUDGET_MIB} MiB is far above the measured 3.1 MiB slice and into OpenI's per-byte penalty`);
});

// ─── syncByFiles 离线集成 ────────────────────────────────────────────────────────
// 纯函数测试 import 不到 syncByFiles 内部的任何代码路径 —— 它漏掉过一次真实的 CI 事故：
// 删 pushCommitInSlices 时把唯一的 `import { execFileSync }` 一起删了，函数体还在用它，
// 结果 CI 上抛 "execFileSync is not defined"，26/26 单元测试全绿、干跑也绿，因为两者都不
// 会执行到这里。这里用一个本地 bare repo 当假远端，把整条路径跑一遍。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncByFiles } from '../src/openi-mirror.mjs';

/** 建一对本地仓：src 带一棵目标树，bare 当远端。返回可传给 syncByFiles 的 cwd 与 remote 名。 */
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'openi-sync-test-'));
  const src = path.join(base, 'src');
  const bare = path.join(base, 'bare.git');
  const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const commit = (msg) => {
    g(['add', '-A'], src);
    return g(['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg], src);
  };

  execFileSync('git', ['init', '-q', src], { encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '--bare', bare], { encoding: 'utf8' });
  g(['remote', 'add', 'origin', bare], src);
  g(['config', 'user.name', 't'], src);
  g(['config', 'user.email', 't@t'], src);

  fs.writeFileSync(path.join(src, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(src, 'b.txt'), 'b\n');
  commit('first');
  g(['push', '-q', 'origin', 'HEAD:refs/heads/art'], src);

  // 目标树：在 first 之上再加两个文件，其中一个是远端还没有的。
  fs.writeFileSync(path.join(src, 'c.txt'), 'c\n');
  fs.mkdirSync(path.join(src, 'd'));
  fs.writeFileSync(path.join(src, 'd', 'e.txt'), 'e\n');
  commit('second');
  return { base, src, bare };
}

test('syncByFiles pushes only the missing files and leaves what the remote has alone', async () => {
  const { base, src, bare } = fixture();
  try {
    const target = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src, encoding: 'utf8' }).trim();
    const remote = 'origin';
    const branch = 'art';

    const r = await syncByFiles(src, remote, branch, target, 20 * 1024 * 1024);
    assert.equal(r.total, 2, 'only c.txt and d/e.txt are new');
    assert.equal(r.pushed, 2);
    assert.equal(r.partial, false);

    const onRemote = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], {
      cwd: bare, encoding: 'utf8',
    }).trim().split('\n').sort();
    assert.deepEqual(onRemote, ['a.txt', 'b.txt', 'c.txt', 'd/e.txt']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('syncByFiles is idempotent: a second run finds nothing to do', async () => {
  const { base, src } = fixture();
  try {
    const target = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src, encoding: 'utf8' }).trim();
    await syncByFiles(src, 'origin', 'art', target, 20 * 1024 * 1024);
    const again = await syncByFiles(src, 'origin', 'art', target, 20 * 1024 * 1024);
    assert.equal(again.total, 0);
    assert.equal(again.pushed, 0);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('syncByFiles splits work when the budget forces more than one push', async () => {
  const { base, src, bare } = fixture();
  try {
    const target = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src, encoding: 'utf8' }).trim();
    // 2 MiB budget over 4-byte files still pushes everything, just in more than one push.
    const seen = [];
    const r = await syncByFiles(src, 'origin', 'art', target, 2, {
      onProgress: (pushed, total) => seen.push([pushed, total]),
    });
    assert.equal(r.pushed, 2);
    assert.ok(seen.length >= 2, `progress fired ${seen.length} time(s); expected one push per slice`);
    const onRemote = execFileSync('git', ['ls-tree', '-r', '--name-only', 'art'], {
      cwd: bare, encoding: 'utf8',
    }).trim().split('\n').sort();
    assert.deepEqual(onRemote, ['a.txt', 'b.txt', 'c.txt', 'd/e.txt']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
