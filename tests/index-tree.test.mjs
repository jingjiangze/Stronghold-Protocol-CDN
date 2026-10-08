import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildIndex, walkFiles, sha256File, serializeIndex } from '../src/index-tree.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cdn-'));
  fs.mkdirSync(path.join(root, 'public', 'assets', 'char'), { recursive: true });
  fs.mkdirSync(path.join(root, 'public', 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'assets', 'char', 'a.png'), 'alpha');
  fs.writeFileSync(path.join(root, 'public', 'assets', 'b.mp3'), 'beta');
  fs.writeFileSync(path.join(root, 'public', 'fonts', 'f.woff2'), 'gamma');
  return root;
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

test('walks files as sorted posix-relative paths', () => {
  const root = fixture();
  assert.deepEqual(walkFiles(path.join(root, 'public', 'assets')), ['b.mp3', 'char/a.png']);
});

test('indexes subtrees under their published prefixes', async () => {
  const root = fixture();
  const index = await buildIndex([
    { abs: path.join(root, 'public', 'assets'), prefix: 'assets/' },
    { abs: path.join(root, 'public', 'fonts'), prefix: 'fonts/' },
  ]);

  assert.deepEqual(Object.keys(index.files), ['assets/b.mp3', 'assets/char/a.png', 'fonts/f.woff2']);
  assert.equal(index.count, 3);
  assert.equal(index.bytes, 5 + 4 + 5);
  assert.deepEqual(index.files['assets/char/a.png'], { size: 5, sha256: sha('alpha') });
});

test('two runs over the same tree serialize identically (deterministic interface)', async () => {
  const root = fixture();
  const trees = [
    { abs: path.join(root, 'public', 'assets'), prefix: 'assets/' },
    { abs: path.join(root, 'public', 'fonts'), prefix: 'fonts/' },
  ];
  const first = await buildIndex(trees, { concurrency: 1 });
  const second = await buildIndex(trees, { concurrency: 4 });
  assert.equal(serializeIndex(first.files), serializeIndex(second.files));
});

test('a missing subtree indexes as empty instead of throwing', async () => {
  const root = fixture();
  const index = await buildIndex([{ abs: path.join(root, 'public', 'nope'), prefix: 'nope/' }]);
  assert.equal(index.count, 0);
  assert.deepEqual(index.files, {});
});

test('sha256File hashes the bytes on disk', async () => {
  const root = fixture();
  assert.equal(await sha256File(path.join(root, 'public', 'assets', 'b.mp3')), sha('beta'));
});
