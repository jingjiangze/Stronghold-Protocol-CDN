import test from 'node:test';
import assert from 'node:assert/strict';

import { diffIndex, uploadBytes } from '../src/diff.mjs';

const local = {
  files: {
    'assets/a.png': { size: 10, sha256: 'aa' },
    'assets/b.png': { size: 20, sha256: 'bb' },
    'assets/new.png': { size: 30, sha256: 'cc' },
  },
};
const remote = {
  files: {
    'assets/a.png': { size: 10, sha256: 'aa' }, // identical
    'assets/b.png': { size: 99, sha256: 'zz' }, // changed
    'assets/old.png': { size: 40, sha256: 'dd' }, // upstream no longer lists it
  },
};

test('classifies adds, changes, unchanged keys and extras', () => {
  const diff = diffIndex(local, remote);
  assert.deepEqual(diff.add, ['assets/new.png']);
  assert.deepEqual(diff.change, ['assets/b.png']);
  assert.equal(diff.same, 1);
  assert.deepEqual(diff.remove, ['assets/old.png']);
});

test('a same-size file with a different hash still counts as changed', () => {
  const diff = diffIndex(
    { files: { 'assets/x.png': { size: 5, sha256: 'one' } } },
    { files: { 'assets/x.png': { size: 5, sha256: 'two' } } },
  );
  assert.deepEqual(diff.change, ['assets/x.png']);
});

test('an empty remote index means everything is an add (first sync)', () => {
  const diff = diffIndex(local, { files: {} });
  assert.equal(diff.add.length, 3);
  assert.equal(diff.change.length, 0);
  assert.equal(diff.same, 0);
  assert.deepEqual(diff.remove, []);
});

test('accepts a bare files map as well as the published wrapper', () => {
  const diff = diffIndex(local.files, remote.files);
  assert.equal(diff.add.length, 1);
  assert.equal(diff.change.length, 1);
});

test('uploadBytes counts only what would actually be transferred', () => {
  const diff = diffIndex(local, remote);
  assert.equal(uploadBytes(diff, local.files), 30 + 20);
});
