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

// ---------------------------------------------------------------------------
// The upload channel, and why overlap is not fatal
//
// CI caught this on 2026-10-18: the fast path merges the upload channel's keys
// (published as cdn/v1/hosted-index.json) through `extraHosted`, and the first run of the new
// workflow failed because I had escalated the pre-existing overlap *warning* into a hard failure.
// The merge is what makes the upload channel visible at all — before it, the tree listed 1,856 skin
// files while the bucket served 2,477 — and a large share of those keys are files upstream later
// absorbed. Measured on the live bucket that day: 5,082 of the 15,007 uploaded keys are also
// upstream's, and hosted.json itself carries 4,724 such entries. Neither number is an anomaly.
//
// So the invariant this test pins is narrower than "no overlap": merging uploaded keys must not
// change what the index↔tree consistency check concludes. The tree still has to satisfy all three
// assertions, and the overlap count is reported, not thrown.
import { readTree } from '../src/tree-index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SYNC_SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sync.mjs'), 'utf8');

test('merging uploaded keys keeps the tree consistent, even when they overlap upstream', () => {
  const files = idx(UPSTREAM);
  const indexBytes = Buffer.from(JSON.stringify({ schema: 1, tag: 'v0.3.1', count: UPSTREAM.length, bytes: 0, files }), 'utf8');
  const index = JSON.parse(indexBytes.toString('utf8'));
  const token = expectedToken(indexBytes, 'v0.3.1');

  // The upload channel: keys the curated hosted.json never listed, some of them new and some of
  // them files upstream has since absorbed. readTree is what the fast path calls, with the same
  // repo root, so this exercises the real code path rather than a re-implementation of it. The repo
  // root also brings in the real hosted.json (14k keys), so every assertion below is a delta
  // against the same call without the merge — absolute counts would just restate hosted.json.
  const uploaded = new Map([
    ['assets/char/skin/upload_only.png', 4242],   // upload channel only — the reason the merge exists
    ['assets/audio/bgm/a.mp3', 854143],           // upstream's — absorbed
    ['assets/spine/op/a/front/a.skel', 100],      // upstream's — absorbed
  ]);
  const before = readTree(process.cwd(), index.files, { token });
  const built = readTree(process.cwd(), index.files, { token, extraHosted: uploaded });

  // The consistency check has to pass with those keys in the tree. Merging the channel must not be
  // what makes the tree "wrong" — before the merge the same tree was published for weeks.
  assert.equal(built.overlap.length - before.overlap.length, 2, 'the two absorbed keys are reported');
  const { ok, failures } = verifyTreeAndIndex({ indexBytes, index, tree: built.doc });
  assert.deepEqual(failures, []);
  assert.equal(ok, true);

  // And the merge must actually be visible: a tree that dropped the upload channel would also pass
  // the consistency check, because the check is one-way. That is the whole reason the channel was
  // merged in, so pin it or a future refactor can silently undo it.
  const { sizes, hosted } = flattenTree(built.doc);
  assert.equal(sizes.has('assets/char/skin/upload_only.png'), true, 'the upload channel is browsable');
  assert.equal(built.doc.totals.hosted, before.doc.totals.hosted + 1, 'mod=1 counts the upload-only key, not the absorbed ones');
  assert.equal([...hosted].includes('assets/audio/bgm/a.mp3'), false, 'an absorbed key is not flagged as hosted on purpose');

  // The part that actually broke in CI, and why this assertion reads the source: overlap is a plain
  // return value from tree-index.mjs — that module throws on malformed keys and nothing else — so
  // whether it is fatal is decided entirely by how sync.mjs handles it. A test on readTree alone
  // would stay green through exactly the regression I shipped (verified: reinstate the throw and
  // this file is still 12/12). The steady state of this bucket is thousands of overlaps, so the
  // handling must be a log line; `throw` next to an overlap check is what reds the run every time.
  //
  // The body is cut at the next statement that starts at the same indent as the `if`, rather than by
  // matching to a closing brace: a non-greedy `[\s\S]*?}` stops at the first `}` it sees, which in a
  // body containing a comment with a brace would truncate the check and let a real throw through.
  // Both spellings are matched — the fast path reads `built.overlap`, publishCore destructures it to
  // a bare `overlap` — because a check that only knows one form is a check that can be evaded by
  // renaming the binding.
  const overlapSites = [];
  const re = /\n( +)if \(((?:\w+\.)?overlap)\.length\) \{\n([\s\S]*?)(?=\n\1\S|\n\1\}$)/g;
  let m;
  while ((m = re.exec(SYNC_SRC)) !== null) overlapSites.push({ variable: m[2], body: m[3] });
  assert.ok(overlapSites.length >= 2, `expected both publish points to check overlap, found ${overlapSites.length}: ${overlapSites.map((s) => s.variable).join(', ')}`);
  for (const [i, site] of overlapSites.entries()) {
    assert.doesNotMatch(site.body, /\bthrow\b/, `overlap site ${i} (${site.variable}) treats a steady-state condition as fatal`);
    assert.match(site.body, /\blog\(/, `overlap site ${i} (${site.variable}) must still report it, not stay silent`);
  }
});
