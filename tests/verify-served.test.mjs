import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTree } from '../src/tree-index.mjs';
import { expectedToken, verifyTreeAndIndex } from '../src/tree-verify.mjs';
import { INDEX_KEY, TREE_KEY, verifyServedTree } from '../src/verify-served.mjs';

// Why this file exists: the workflow step that calls verifyServedTree was originally an inline
// `node -e` script, and it failed on its first run with "await isn't allowed in non-async function"
// — `node -e` evaluates as CommonJS, so the top-level await inside the callback was a syntax error
// before any credential was used. That class of bug is invisible locally (no R2 credentials) and
// only surfaces in CI, which is the expensive place to find a typo. Extracting the logic into an
// importable module makes the failure mode testable here instead.
const idx = (pairs) => Object.fromEntries(pairs.map(([k, s]) => [k, { size: s }]));

const UPSTREAM = [['assets/a.png', 10], ['assets/b/c.mp3', 20]];
const HOSTED = new Map([['assets/skin/mod.png', 30]]);

/** A served bucket stub: the two keys, plus nothing else, so a wrong key is a hard miss. */
function stubBucket({ tree } = {}) {
  const files = idx(UPSTREAM);
  const indexBytes = Buffer.from(JSON.stringify({ schema: 1, tag: 'v9.9.9', count: 2, bytes: 30, files }), 'utf8');
  const built = tree || buildTree(files, { hosted: HOSTED, token: expectedToken(indexBytes, 'v9.9.9') }).doc;
  const store = new Map([
    [INDEX_KEY, indexBytes],
    [TREE_KEY, Buffer.from(JSON.stringify(built), 'utf8')],
  ]);
  return { store, indexBytes };
}

test('the served pair passes, and the keys it reads are the published ones', async () => {
  const { store } = stubBucket();
  const seen = [];
  const result = await verifyServedTree({
    config: {},
    getObject: async (_config, key) => {
      seen.push(key);
      const value = store.get(key);
      if (!value) throw new Error(`unexpected key requested: ${key}`);
      return value;
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.tag, 'v9.9.9');
  assert.equal(result.token, expectedToken(store.get(INDEX_KEY), 'v9.9.9'));
  assert.deepEqual(seen.sort(), [INDEX_KEY, TREE_KEY].sort());
});

// The whole reason the step exists: a tree that no longer matches the index must fail, not pass
// because the bytes parsed. This is the drift that was invisible for 620 skin paths.
test('a stale served tree is rejected', async () => {
  const { store } = stubBucket();
  const stale = JSON.parse(store.get(TREE_KEY).toString('utf8'));
  stale.token = 'v0.0.0-deadbeef';
  store.set(TREE_KEY, Buffer.from(JSON.stringify(stale), 'utf8'));
  const result = await verifyServedTree({ config: {}, getObject: async (_c, k) => store.get(k) });
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /tree\.token is/);
});

// A missing object is a different failure from a mismatched one, and conflating them would report
// "the tree is stale" when the truth is "the tree is not there at all".
test('a missing object is reported as missing, not as a mismatch', async () => {
  const { store } = stubBucket();
  store.delete(TREE_KEY);
  await assert.rejects(
    // An explicit config, so the default is never built: r2Config() throws without credentials, and
    // that error would satisfy `rejects` while proving nothing about the missing-object path.
    () => verifyServedTree({ config: {}, config: {}, getObject: async (_c, k) => store.get(k) }),
    /桶里没有 cdn\/v1\/tree\.json/,
  );
});

// The guard: the module must not run its checks merely by being imported. If it did, every test file
// that imports it — and the workflow's own unit-test step — would try to reach R2 and fail.
test('importing the module runs nothing', async () => {
  const module = await import(`../src/verify-served.mjs?reload=${Date.now()}`);
  assert.equal(typeof module.verifyServedTree, 'function');
  // Nothing thrown, no output, no exit: reaching this line is the assertion.
});

// The guard in the other direction. It exits 0 having verified nothing if it never fires, which is
// the one outcome a verification step must not have — so pin the comparison itself.
test('the direct-run guard is a real path comparison, not a string prefix', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'verify-served.mjs'), 'utf8');
  // Only the guard line is matched and reported: asserting on the whole file string would print the
  // entire module into the test output on failure, which buries the one line that changed.
  const guard = source.split('\n').find((line) => line.includes('process.argv[1]') && line.includes('import.meta.url'));
  assert.ok(guard, 'no direct-run guard found');
  assert.match(guard, /pathToFileURL\(path\.resolve\(process\.argv\[1\]\)\)\.href === import\.meta\.url/,
    'a hand-built file:// URL breaks on Windows paths with spaces, and fails silently');
  assert.doesNotMatch(guard, /import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]/,
    'the hand-built comparison this module was first written with');
});

// The verifier the step depends on must be the same one the publisher uses, or the step could pass
// on a tree the publisher would have rejected.
test('the served-tree check uses the same verifier as the publisher', () => {
  const { store } = stubBucket();
  const indexBytes = store.get(INDEX_KEY);
  const tree = JSON.parse(store.get(TREE_KEY).toString('utf8'));
  const direct = verifyTreeAndIndex({ indexBytes, index: JSON.parse(indexBytes.toString('utf8')), tree });
  assert.equal(direct.ok, true);
  assert.equal(createHash('sha256').update(indexBytes).digest('hex').slice(0, 8), tree.token.split('-')[1]);
});
