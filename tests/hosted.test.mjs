import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readHosted, splitForPrune, HOSTED_FILE } from '../src/hosted.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

test('the shipped hosted list parses and every entry explains itself', () => {
  const { keys, entries } = readHosted(ROOT);
  assert.ok(fs.existsSync(path.join(ROOT, HOSTED_FILE)), `${HOSTED_FILE} should exist`);
  assert.ok(entries.length >= 1);
  assert.ok(keys.size >= 1);
  for (const e of entries) assert.ok(e.what.length >= 10, `${e.id} needs a real description`);
});

// A prune pass deletes keys upstream no longer lists. Hosted content is by definition not upstream's,
// so without this split a routine cleanup would delete someone else's art.
test('prune spares hosted keys and reports how many, instead of deleting them', () => {
  const hosted = new Set(['assets/char/skin/mod_a.png', 'assets/band/mod_b.png']);
  const remove = ['assets/old/leftover.png', 'assets/char/skin/mod_a.png', 'assets/stale/x.png', 'assets/band/mod_b.png'];
  const { prune, spared } = splitForPrune(remove, hosted);
  assert.deepEqual(prune, ['assets/old/leftover.png', 'assets/stale/x.png']);
  assert.deepEqual(spared, ['assets/char/skin/mod_a.png', 'assets/band/mod_b.png']);
});

test('with nothing hosted, prune behaves exactly as before', () => {
  const { prune, spared } = splitForPrune(['a', 'b'], new Set());
  assert.deepEqual(prune, ['a', 'b']);
  assert.deepEqual(spared, []);
});

test('a malformed entry is rejected rather than silently protecting nothing', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'hosted-'));
  const write = (doc) => fs.writeFileSync(path.join(dir, HOSTED_FILE), JSON.stringify(doc));
  write({ hosted: [{ id: 'x', what: 'short', keys: ['a'] }] });
  assert.throws(() => readHosted(dir), /needs a description/);
  write({ hosted: [{ id: 'x', what: 'a real description here', keys: [] }] });
  assert.throws(() => readHosted(dir), /lists no keys/);
  write({ hosted: [{ id: 'x', what: 'a real description here', keys: ['/leading/slash'] }] });
  assert.throws(() => readHosted(dir), /invalid key/);
  fs.rmSync(dir, { recursive: true, force: true });
});
