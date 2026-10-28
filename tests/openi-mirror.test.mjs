import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLsTree, listTree, totalBytes, remoteHead, localHead, MAX_BYTES,
  planBatches, DEFAULT_BUDGET_MIB, missingFiles, planSlices, failTail,
  BIG_FILE_BYTES, MAX_FILES_PER_SLICE,
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
  // ⚠ 三份都必须 < BIG_FILE_BYTES(8 MiB)，否则 2026-10-15 加的「大文件单独成片」会把它们
  // 各自拆开，这条贪心断言就不成立了 —— 曾用 15 MiB × 3，得到 [[a],[b],[c]]，一度误判为 bug。
  // 用 5 MiB × 3 + 10 MiB 预算：'a'+'b' = 10 MiB 达到预算即收片，'c' 单独一片。
  const todo = [
    { p: 'a', size: 5 * MB },
    { p: 'b', size: 5 * MB },
    { p: 'c', size: 5 * MB },
  ];
  const slices = planSlices(todo, 10 * MB);
  assert.deepEqual(slices.map((s) => s.map((r) => r.p).sort()), [['a', 'b'], ['c']]);
  for (const s of slices) {
    const sum = s.reduce((t, r) => t + r.size, 0);
    assert.ok(sum <= 10 * MB + 5 * MB, `slice of ${sum / MB} MiB is far above the ${10} MiB budget`);
  }
});

test('planSlices groups small files instead of pushing one at a time', () => {
  const todo = Array.from({ length: 300 }, (_, i) => ({ p: `f${i}`, size: 10 * 1024 }));
  // 300 files / 3.1 MiB is the measured shape of one push; it must stay one slice.
  // ⚠ 2026-10-15 加了 MAX_FILES_PER_SLICE=200，300 份现在切成 200+100 两片。断言改为
  // 「不超过两片、且总量不丢」——份数上限是有意为之，不是回归。
  const slices = planSlices(todo, 20 * MB);
  assert.ok(slices.length <= 2, `300 tiny files became ${slices.length} slices`);
  assert.equal(slices.flat().length, 300);
});

test('planSlices loses no file and keeps order across slice boundaries', () => {
  const todo = Array.from({ length: 500 }, (_, i) => ({ p: `f${i}`, size: 100 * 1024 }));
  const flat = planSlices(todo, 5 * MB).flat();
  assert.equal(flat.length, 500);
  assert.deepEqual(flat.map((r) => r.p).sort(), todo.map((r) => r.p).sort());
});

// ─── 2026-10-15 三个新约束 ────────────────────────────────────────────────────
// 病象来自 run 38707181417：最后 60 分钟只推进 7 份，全部耗在「2 份 / 75 MiB」这种片上
// （实测 493–554 s/份，且几乎必然再触发客户端超时 ⇒ 5 次全废 ⇒ 整片作废）。
test('a file at or above BIG_FILE_BYTES gets its own slice, never mixed with small ones', () => {
  const big = BIG_FILE_BYTES;
  const todo = [
    { p: 'small-1', size: 1024 },
    { p: 'huge.zip', size: 64 * MB },
    { p: 'small-2', size: 2048 },
  ];
  const slices = planSlices(todo, 20 * MB);
  // 大文件单独成片，两个小文件另成一片 —— 绝不能出现 [small-1, huge.zip, small-2] 这种混片
  const bigSlices = slices.filter((s) => s.some((r) => r.size >= big));
  assert.equal(bigSlices.length, 1);
  assert.deepEqual(bigSlices[0].map((r) => r.p), ['huge.zip']);
  const small = slices.filter((s) => !s.some((r) => r.size >= big)).flat();
  assert.deepEqual(small.map((r) => r.p).sort(), ['small-1', 'small-2']);
});

test('no slice holds more than MAX_FILES_PER_SLICE files', () => {
  // 800 份 1 KiB 的文件按字节只要 0.8 MiB，旧实现会全塞进一片；服务端处理长尾全压在
  // 一片里。份数上限把 round trip 数从 171 压到 45。
  const todo = Array.from({ length: 800 }, (_, i) => ({ p: `f${i}`, size: 1024 }));
  const slices = planSlices(todo, 20 * MB);
  for (const s of slices) assert.ok(s.length <= MAX_FILES_PER_SLICE, `slice of ${s.length} files`);
  assert.ok(slices.length > 1, '800 tiny files must be split by the file-count cap');
  assert.equal(slices.flat().length, 800);
});

test('small files come first so the cheap bulk of the gap lands before the big zips', () => {
  // ⚠ 这条断言的方向曾写反过一次（`d4c575871`）：注释说「降序让小文件先走完」而代码真是
  // 降序 —— 自相矛盾还自我感觉良好。run 38733522903 用降序跑，第一片就是 63.4 MiB 单文件，
  // 40 分钟只推成 3 份大文件，缺口里 98.3% 的小文件一份没碰上。升序才是对的。
  const todo = [
    { p: 'assets/packs/audio.sfx-1.zip', size: 64 * MB },
    { p: 'assets/voice/a.mp3', size: 25 * 1024 },
    { p: 'assets/ui/b.png', size: 30 * 1024 },
  ];
  const slices = planSlices(todo, 20 * MB);
  // 25 KiB < 30 KiB < 64 MiB ⇒ a.mp3 第一片，b.png 与它同片（都远小于预算），大 zip 垫底单独一片
  assert.equal(slices[0][0].p, 'assets/voice/a.mp3', 'smallest file opens the run');
  assert.deepEqual(slices[0].map((r) => r.p), ['assets/voice/a.mp3', 'assets/ui/b.png'], 'both small files share the first slice');
  const last = slices[slices.length - 1];
  assert.deepEqual(last.map((r) => r.p), ['assets/packs/audio.sfx-1.zip'], 'big zip lands last, alone');
  // 大文件单独成片：绝不能和 25 KiB 的小文件混在一起陪葬
  for (const s of slices) {
    const hasBig = s.some((r) => r.size >= BIG_FILE_BYTES);
    if (hasBig) assert.equal(s.length, 1, 'a slice holding a big file holds nothing else');
  }
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

// ─── 单片推失败：跳过而不是带走整轮 ─────────────────────────────────────────────
// run 38741643487 的真实形状：升序排好、小文件一片片稳稳推过去（已推 4,400/8,543），第 22 片
// 连续 5 次 push 超时，`pushSlice` 一抛，**后面 60 片小文件一份都没推**，90 分钟只换回
// 26,264 → 30,664。修法是让一片失败只跳过自己 —— 而「跳过」有三条很容易只做两条的不变量：
//   ① **运行不中断**：后面的片照推（这才是本次事故真正的损失）
//   ② **index 回退**：这一片的路径必须从 scratch index 删掉，否则下一片的 write-tree 会把
//      它们一起打进去 —— 「跳过」就只是并进下一次推送，连日志都在撒谎
//   ③ **ref 回退**：`_openi_sync` 必须退回上一个真的推成了的 parent，否则下一片以没推成的
//      commit 为父，本地与远端分叉，而且**看不出来**
// ②③的失败模式都极安静，所以同一条断言同时盯远端文件列表（②）与 _openi_sync（③）。
/** 在 fixture 的 remote/baseline 之上加 n 个新文件，返回目标 ref。
 *  ⚠ 拿 ref 必须用 `rev-parse HEAD`，不能用 `commit` 的 stdout —— `-q` 会把它吞掉，
 *  于是 target 是空串，syncByFiles 的 `ls-tree -r -l ` 直接 fatal: Not a valid object name
 *  （第一版就这么挂的，报错位置在 src 里不在测试里，很容易误判成代码 bug）。 */
function fixtureWithNewFiles(names) {
  const { base, src, bare } = fixture();
  for (const n of names) fs.writeFileSync(path.join(src, n), `${n}\n`);
  const g = (args) => execFileSync('git', args, { cwd: src, encoding: 'utf8' }).trim();
  g(['add', '-A']);
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t',
    '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'more'], { cwd: src, encoding: 'utf8' });
  return { base, src, bare, target: g(['rev-parse', 'HEAD']) };
}

/** 给远端装 pre-receive hook：**凡是树里带 REJECT_MARK 的 push 一律拒收**，其它放行。
 *
 * ⚠ 为什么按内容判而不是按「第 N 次」判：`pushSlice` 每次失败要重试 5 次。按次数判的 hook
 * （前 N 次拒）在上一版实测里把预期打乱了 —— 前一片耗掉的 retry 次数会改变后一片的判定阈值，
 * 而且每片重试 5 次 × 退避 10/20/30/40s ≈ 100 s，3 条测试要跑 8 分钟。按内容判则**幂等**：
 * 同一个树无论推多少次都一样被拒，重试 5 次全落在同一片，一次退避（10s）就够观察到结果。
 *
 * ⚠ 它必须真的执行（真实文件 + chmod 755）：bare repo 的 hook 不执行就等于没注入，而「没注入」
 * 长得很像「代码没实现跳过」。所以下面每条测试都另配一条对照组，注入本身也要被断言。 */
function rejectTreesContaining(bare, marker) {
  const hook = path.join(bare, 'hooks', 'pre-receive');
  fs.writeFileSync(hook,
    `#!/bin/sh\n` +
    `while read old new ref; do\n` +
    `  if git ls-tree -r "$new" --name-only | grep -q '${marker}'; then\n` +
    `    echo "remote: rejecting a tree carrying ${marker}" >&2\n` +
    `    exit 1\n` +
    `  fi\n` +
    `done\n` +
    `exit 0\n`);
  fs.chmodSync(hook, 0o755);
}

const remoteFiles = (bare, ref) => execFileSync('git', ['ls-tree', '-r', '--name-only', ref], {
  cwd: bare, encoding: 'utf8',
}).trim().split('\n').filter(Boolean).sort();

test('a slice that fails to push is skipped, and the rest of the run still lands', async () => {
  // ⚠ 待补总数是 **5** 不是 3：`fixture()` 自己就带了 c.txt 与 d/e.txt 两个远端没有的文件
  // （第一版 assertion 写 3，`5 !== 3` 挂在测试里而非代码里，白查了一轮）。
  // 5 片按升序排：c.txt / d/e.txt / m1.txt / **m2-rejectme.txt** / m3.txt —— 被拒那片排在
  // 中间而不是最后，才能证明「它**后面**的片照推」：若跳过没实现，pushSlice 一抛整轮作废，
  // m3.txt 不会出现在远端，那正是 run 38741643487 损失后面 60 片的形状。
  const { base, src, bare, target } = fixtureWithNewFiles(['m1.txt', 'm2-rejectme.txt', 'm3.txt']);
  rejectTreesContaining(bare, 'm2-rejectme.txt');
  try {
    const r = await syncByFiles(src, 'origin', 'art', target, 1);
    assert.equal(r.total, 5, 'fixture 的 c/d/e 加上新加的 3 个，共 5 份待补');
    // ① 运行不中断：被拒那片之后，m3 照样推成。
    assert.equal(r.pushed, 4, `pushed=${r.pushed}；除 m2-rejectme.txt 外都应推成`);
    assert.equal(r.skipped, 1, `skipped=${r.skipped}；m2-rejectme.txt 那一片必须被记为跳过`);
    assert.equal(r.partial, true, '跳过过就必须报 partial，不能谎报完成');
    // ② index 回退：被拒文件没有悄悄混进已推成的树里。
    assert.deepEqual(remoteFiles(bare, 'art'),
      ['a.txt', 'b.txt', 'c.txt', 'd/e.txt', 'm1.txt', 'm3.txt'],
      'm2-rejectme.txt 不在远端才说明它真被从 index 里摘掉了');
    // ③ ref 回退：本地 _openi_sync 与远端 ref 一致，没有留在那个没推成的 commit 上。
    const localSync = execFileSync('git', ['rev-parse', '--verify', 'refs/heads/_openi_sync'], {
      cwd: src, encoding: 'utf8',
    }).trim();
    const remoteArt = execFileSync('git', ['rev-parse', 'art'], { cwd: bare, encoding: 'utf8' }).trim();
    assert.equal(localSync, remoteArt,
      `_openi_sync(${localSync.slice(0, 10)}) 必须等于远端 art(${remoteArt.slice(0, 10)})，否则已成分叉`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the failure injection actually fires — without it the skip test proves nothing', async () => {
  // 对照组：hook 不执行（路径错 / 没 chmod / sh 不在 PATH）时，上一条会 5 片全推成 ⇒
  // pushed=5、skipped=0、被拒文件出现在远端 ⇒ 断言失败。但那种失败长得像「代码没实现跳过」，
  // 分不清是注入坏还是逻辑坏，所以这里直接验证注入本身。同时钉住 5 次重试：重试是刻意行为
  // （push 幂等，重试把一次网络抖动从 90 分钟事故降级成 10 秒），别哪天被「优化」成 1 次。
  const { base, src, bare, target } = fixtureWithNewFiles(['rejectme.txt']);
  rejectTreesContaining(bare, 'rejectme.txt');
  const counter = path.join(base, 'hookruns');
  // ⚠ 计数器只数**拒收**，不数所有 push：前两片（c.txt / d/e.txt）是推成功的，它们也会触发 hook，
  // 于是「数所有 push」得到 7，看着像 pushSlice 重试了 7 次（我第一版就这么误判的）。数拒收才
  // 恰好等于 attempts，这才是要钉住的量。
  fs.writeFileSync(path.join(bare, 'hooks', 'pre-receive'),
    `#!/bin/sh\n` +
    `C='${counter.replace(/\\/g, '/')}'\n` +
    `while read old new ref; do\n` +
    `  if git ls-tree -r "$new" --name-only | grep -q 'rejectme.txt'; then\n` +
    `    n=$(cat "$C" 2>/dev/null || echo 0); echo $((n+1)) > "$C"\n` +
    `    echo "remote: rejecting a tree carrying rejectme.txt" >&2; exit 1\n` +
    `  fi\n` +
    `done\n` +
    `exit 0\n`);
  fs.chmodSync(path.join(bare, 'hooks', 'pre-receive'), 0o755);
  try {
    const r = await syncByFiles(src, 'origin', 'art', target, 1);
    // fixture 的 c.txt / d/e.txt 排在被拒文件之前 ⇒ 它们推成，只有 rejectme.txt 那片被跳过。
    assert.equal(r.total, 3, 'c.txt / d/e.txt / rejectme.txt 共 3 份待补');
    assert.equal(r.pushed, 2, '前两片推成');
    assert.equal(r.skipped, 1, '只有 rejectme.txt 那片被跳过');
    assert.equal(r.partial, true);
    assert.equal(fs.readFileSync(counter, 'utf8').trim(), '5',
      `hook 跑了 ${fs.readFileSync(counter, 'utf8').trim()} 次，预期 5 次（pushSlice 的 attempts）`);
    assert.deepEqual(remoteFiles(bare, 'art'), ['a.txt', 'b.txt', 'c.txt', 'd/e.txt'],
      'rejectme.txt 不在远端');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// 2026-10-28：assets-raw 把 5 个 >100 MB 的 spart 分包改成了 Git LFS 指针（每个约 130 B）。
// OpenI 侧没有 LFS 对象，推上去等于把指针当素材发出去；镜像必须跳过这几条，且不能因此少推别的。
test('missingFiles skips the LFS-only paths and keeps everything else', () => {
  const target = [
    '100644 blob aaa 130\tassets/local/sp-bundle/pack-01-of-05.spart',
    '100644 blob bbb 938\tassets/local/sp-bundle/bundle-parts.json',
    '100644 blob ccc 42\tassets/local/map/x.png',
  ].join('\n');
  const todo = missingFiles('', target);
  assert.deepEqual(todo.map((r) => r.p), [
    'assets/local/sp-bundle/bundle-parts.json',
    'assets/local/map/x.png',
  ]);
});

test('the LFS skip is a default, not a hardcode: a caller can pass null to opt out', () => {
  const target = '100644 blob aaa 130\tassets/local/sp-bundle/pack-01-of-05.spart';
  assert.deepEqual(missingFiles('', target, null).map((r) => r.p), [
    'assets/local/sp-bundle/pack-01-of-05.spart',
  ]);
});
