import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildTree } from '../src/tree-index.mjs';
import { verifyTreeAndIndex, flattenTree, expectedToken } from '../src/tree-verify.mjs';

// The fixture is built by the same code the sync uses, so a passing case is not "the verifier agrees
// with a hand-written tree" -- it is "the verifier agrees with what the publisher would emit". A
// hand-written fixture would pass even if the real tree shape were wrong.
const idx = (pairs) => Object.fromEntries(pairs.map(([k, s]) => [k, { size: s }]));

const UPSTREAM = [
  ['assets/audio/bgm/a.mp3', 854143],
  ['assets/audio/bgm/b.mp3', 2700687],
  ['assets/spine/op/a/front/a.skel', 100],
  ['assets/char/avatar/b.png', 5],
  ['robots.txt', 26],
];
const HOSTED = new Map([
  ['assets/char/skin/mod_1.png', 999],
  ['assets/audio/sfx/custom/x.mp3', 36565],
]);

/** Build the pair the way publishCore does, and return the exact bytes index.json would carry. */
function pair({ token } = {}) {
  const files = idx(UPSTREAM);
  const indexBytes = Buffer.from(JSON.stringify({ schema: 1, tag: 'v0.3.1', count: UPSTREAM.length, bytes: 0, files }), 'utf8');
  // The token is derived, not authored: a literal here would let the happy path pass while the
  // derivation itself was broken, and would leak a wrong token into every control below.
  const { doc } = buildTree(files, { hosted: HOSTED, token: token || expectedToken(indexBytes, 'v0.3.1') });
  return { indexBytes, index: JSON.parse(indexBytes.toString('utf8')), tree: doc };
}

test('the pair the publisher would emit passes', () => {
  const { indexBytes, index, tree } = pair();
  const { ok, failures } = verifyTreeAndIndex({ indexBytes, index, tree });
  assert.deepEqual(failures, []);
  assert.equal(ok, true);
});

// flattenTree is what every check reads, so its own contract matters: a duplicate key means two
// directories claim the same path, which no honest tree contains. Without this the subset check
// would silently keep the last copy and report success.
test('flattenTree rejects a tree that lists the same key twice', () => {
  assert.throws(
    () => flattenTree({ dirs: { d: { files: [['a.png', 1], ['a.png', 2]] } } }),
    /duplicate key d\/a\.png/,
  );
  // A malformed entry is the same class of problem: the payload is not the shape it claims to be.
  assert.throws(() => flattenTree({ dirs: { d: { files: [[42, 1]] } } }), /malformed/);
  assert.throws(() => flattenTree({ dirs: { d: { files: ['a.png'] } } }), /malformed/);
});

// ─── The controls ──────────────────────────────────────────────────────────────────
//
// A verifier that reports success for everything is worse than no verifier, because it turns a red
// signal into a green one. Each control below is a deliberately broken pair that MUST be rejected.
// If any of these starts passing, the checks above it have stopped meaning anything.

test('CONTROL: a tree missing a key the index lists is rejected', () => {
  const { indexBytes, index, tree } = pair();
  // Drop the directory *and* keep the totals consistent with what is left, so this control fails for
  // exactly one reason. If the totals were left stale it would trip the files/bytes checks too, and
  // a control that fails for several reasons proves only that at least one check works.
  const dropped = tree.dirs['assets/spine/op/a/front'];
  delete tree.dirs['assets/spine/op/a/front'];
  tree.totals.files -= dropped.files.length;
  tree.totals.bytes -= dropped.bytes;
  const { ok, failures } = verifyTreeAndIndex({ indexBytes, index, tree });
  assert.equal(ok, false);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /the tree does not list/);
  // The message must name the key, or nobody can act on it.
  assert.match(failures[0], /a\.skel/);
});

test('CONTROL: a stale token — the drift that was invisible for 620 skin paths — is rejected', () => {
  const { indexBytes, index, tree } = pair();
  tree.token = 'v0.3.0-deadbeef';
  const { ok, failures } = verifyTreeAndIndex({ indexBytes, index, tree });
  assert.equal(ok, false);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /tree\.token is/);
  // ...and it must say what the right token is, so the fix is not a guess.
  assert.match(failures[0], new RegExp(expectedToken(indexBytes, 'v0.3.1').replace(/[.]/g, '\\.')));
});

test('CONTROL: totals.hosted disagreeing with the payload is rejected', () => {
  const { indexBytes, index, tree } = pair();
  tree.totals.hosted = tree.totals.hosted + 1;
  const { ok, failures } = verifyTreeAndIndex({ indexBytes, index, tree });
  assert.equal(ok, false);
  assert.match(failures.join('\n'), /totals\.hosted says/);
});

// The same for files and bytes: those are the numbers a collapsed UI row renders without summing
// anything, so a wrong one is a wrong page rather than a cosmetic bug.
test('CONTROL: totals.files and totals.bytes disagreeing with the payload are rejected', () => {
  const a = pair();
  a.tree.totals.files += 1;
  const b = pair();
  b.tree.totals.bytes += 1000;
  for (const [label, { indexBytes, index, tree }] of [['files', a], ['bytes', b]]) {
    const { ok, failures } = verifyTreeAndIndex({ indexBytes, index, tree });
    assert.equal(ok, false, `${label} should have been rejected`);
    assert.equal(failures.length, 1, `${label} should fail for exactly one reason, got: ${failures.join(' | ')}`);
    assert.match(failures[0], new RegExp(`totals\\.${label} says`));
  }
});

// ─── The checks themselves ─────────────────────────────────────────────────────────

// Hosted content is merged into the tree and flagged, and it is NOT in the index. So the subset
// check must run one way only: every index key in the tree, never the reverse. Asserting the reverse
// would flag every hosted file as drift, which is the normal state.
test('hosted keys are in the tree but not the index, and that is not drift', () => {
  const { indexBytes, index, tree } = pair();
  const { hosted } = flattenTree(tree);
  assert.deepEqual([...hosted].sort(), ['assets/audio/sfx/custom/x.mp3', 'assets/char/skin/mod_1.png']);
  assert.equal(Object.keys(index.files).some((k) => hosted.has(k)), false);
  assert.equal(verifyTreeAndIndex({ indexBytes, index, tree }).ok, true);
});

// The token is derived from the index bytes, not from the tag alone: two runs under the same tag
// with different content must produce different tokens, or the frozen tree-<token>.json copies would
// collide and a reader could be served the older one.
test('the token follows the index bytes, so the same tag with different content differs', () => {
  const a = Buffer.from(JSON.stringify({ tag: 'v0.3.1', files: { 'a.png': { size: 1 } } }), 'utf8');
  const b = Buffer.from(JSON.stringify({ tag: 'v0.3.1', files: { 'a.png': { size: 2 } } }), 'utf8');
  assert.notEqual(expectedToken(a, 'v0.3.1'), expectedToken(b, 'v0.3.1'));
  assert.equal(expectedToken(a, 'v0.3.1'), 'v0.3.1-' + createHash('sha256').update(a).digest('hex').slice(0, 8));
});

// An empty index is a legitimate state (a dry run against an empty bucket), not a failure.
test('an empty index and its empty tree pass', () => {
  const indexBytes = Buffer.from(JSON.stringify({ schema: 1, tag: 'v0.3.1', count: 0, bytes: 0, files: {} }), 'utf8');
  const { doc } = buildTree({}, { hosted: new Map(), token: expectedToken(indexBytes, 'v0.3.1') });
  assert.equal(verifyTreeAndIndex({ indexBytes, index: JSON.parse(indexBytes.toString('utf8')), tree: doc }).ok, true);
});

// A missing token field is drift, not an absent optional: without it a reader cannot tell which
// index this tree came from.
test('CONTROL: a tree with no token at all is rejected', () => {
  const { indexBytes, index, tree } = pair();
  delete tree.token;
  const { ok, failures } = verifyTreeAndIndex({ indexBytes, index, tree });
  assert.equal(ok, false);
  assert.match(failures.join('\n'), /tree\.token is undefined/);
});

// The bytes must be the published ones. Hashing the re-serialized object instead of the raw bytes
// would make the check agree with whatever the reader parsed — which is how a token computed over
// different formatting passes while describing different content.
test('CONTROL: the token is checked against the raw bytes, not a re-serialization', () => {
  const { index, tree } = pair();
  const reformatted = Buffer.from(JSON.stringify(index), 'utf8');
  assert.equal(expectedToken(reformatted, index.tag), expectedToken(pair().indexBytes, 'v0.3.1'));
  const { ok, failures } = verifyTreeAndIndex({
    indexBytes: Buffer.from(JSON.stringify({ ...index, files: index.files }, null, 2), 'utf8'),
    index,
    tree,
  });
  assert.equal(ok, false);
  assert.match(failures.join('\n'), /tree\.token is/);
});
