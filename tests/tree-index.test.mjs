import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTree, TREE_SCHEMA } from '../src/tree-index.mjs';

const idx = (pairs) => Object.fromEntries(pairs.map(([k, s]) => [k, { size: s }]));

test('files are grouped by directory, with per-directory totals', () => {
  const { doc } = buildTree(idx([
    ['assets/spine/op/a/front/a.skel', 100],
    ['assets/spine/op/a/front/a.atlas', 20],
    ['assets/char/avatar/b.png', 5],
  ]));
  assert.equal(doc.schema, TREE_SCHEMA);
  assert.deepEqual(doc.dirs['assets/spine/op/a/front'], { bytes: 120, files: [['a.atlas', 20], ['a.skel', 100]] });
  assert.deepEqual(doc.dirs['assets/char/avatar'], { bytes: 5, files: [['b.png', 5]] });
  assert.equal(doc.totals.files, 3);
  assert.equal(doc.totals.bytes, 125);
  assert.equal(doc.totals.dirs, 2);
});

// A file at the root of the tree has no directory; it must still appear rather than be dropped.
test('a key with no directory lands in the empty-string group', () => {
  const { doc } = buildTree(idx([['robots.txt', 26]]));
  assert.deepEqual(doc.dirs[''].files, [['robots.txt', 26]]);
});

// Names are sorted so the published bytes are deterministic: a re-run with the same input must
// produce the same file, otherwise every sync would look like a change.
test('the output is deterministic regardless of input order', () => {
  const a = buildTree(idx([['d/x.png', 1], ['d/a.png', 2], ['c/y.png', 3]])).json;
  const b = buildTree(idx([['c/y.png', 3], ['d/a.png', 2], ['d/x.png', 1]])).json;
  assert.equal(a, b);
  const parsed = JSON.parse(a);
  assert.deepEqual(Object.keys(parsed.dirs), ['c', 'd']);
  assert.deepEqual(parsed.dirs.d.files.map((f) => f[0]), ['a.png', 'x.png']);
});

// Hosted content is not upstream's, so it is merged into the view rather than into the published
// index -- the index is what the sync diffs against. It carries the mod flag so a reader can tell
// the two apart.
test('hosted files are merged in and flagged, without touching the index totals of upstream', () => {
  const hosted = new Map([['assets/char/skin/mod_1.png', 999]]);
  const { doc } = buildTree(idx([['assets/char/avatar/a.png', 10]]), { hosted });
  assert.deepEqual(doc.dirs['assets/char/skin'].files, [['mod_1.png', 999, 1]]);
  assert.deepEqual(doc.dirs['assets/char/avatar'].files, [['a.png', 10]]);
  assert.equal(doc.totals.files, 2);
  assert.equal(doc.totals.hosted, 1);
  assert.equal(doc.totals.bytes, 1009);
});

// If a hosted key is also upstream's, the upstream entry wins and it is not double counted; the
// flag is dropped because the file is upstream content after all.
test('a hosted key that upstream also ships is counted once and not flagged', () => {
  const hosted = new Map([['assets/char/avatar/a.png', 999]]);
  const { doc } = buildTree(idx([['assets/char/avatar/a.png', 10]]), { hosted });
  assert.deepEqual(doc.dirs['assets/char/avatar'].files, [['a.png', 10]]);
  assert.equal(doc.totals.files, 1);
  assert.equal(doc.totals.hosted, 0);
});

test('an empty index produces an empty tree rather than throwing', () => {
  const { doc } = buildTree({});
  assert.deepEqual(doc.dirs, {});
  assert.equal(doc.totals.files, 0);
  assert.equal(doc.totals.bytes, 0);
});
