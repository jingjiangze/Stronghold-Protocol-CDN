import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLsTree, listTree, totalBytes, remoteHead, localHead, MAX_BYTES, planBatches, DEFAULT_BUDGET_MIB } from '../src/openi-mirror.mjs';

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

test('remoteHead returns null instead of throwing when the remote is unusable', async () => {
  assert.equal(await remoteHead('definitely-not-a-remote', 'master'), null);
});

// The 413 that forced batching: one push of the whole 1,807 MiB tree was rejected outright. These
// pin the arithmetic that replaces it, because a batching bug is invisible until a run 413s —
// which is exactly the failure that costs 16 minutes to find out about.
const MB = 1048576;

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
  // Git moves whole objects, so an oversized commit cannot be split. Taking it alone gives it one
  // honest attempt instead of folding it into something even bigger.
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

test('the default budget stays under the size that was seen to 413', () => {
  // 915 MiB went through; 1,807 MiB got HTTP 413. Anything near the ceiling is a guess about
  // someone else's limit, so the default keeps real distance from both numbers.
  assert.ok(DEFAULT_BUDGET_MIB < 915, `budget ${DEFAULT_BUDGET_MIB} MiB is not safely under the 915 MiB that worked`);
  assert.ok(DEFAULT_BUDGET_MIB > 0);
});
