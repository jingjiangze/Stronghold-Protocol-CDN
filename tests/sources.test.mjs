import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readSources, findSourceLayout, sourceReleaseUrl, pinSatisfied, applyOverrides } from '../src/sources.mjs';

function fixture(sources) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-src-'));
  fs.writeFileSync(path.join(root, 'sources.json'), JSON.stringify({ sources }));
  return root;
}

test('reads the declared sources and drops entries that cannot work', () => {
  const root = fixture([
    { id: 'fusion', repo: 'Paper-Yuan/Stronghold-Protocol', ref: 'feature/x', release: 'v1', package: 'a.zip', note: 'n' },
    { id: '', repo: 'x/y', package: 'a.zip' },
    { id: 'no-package', repo: 'x/y' },
    { id: 'no-repo', package: 'a.zip' },
  ]);
  const sources = readSources(root);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, 'fusion');
  assert.equal(sources[0].manifest, 'data/assets.json', 'a missing manifest falls back to the default');
});

test('a missing or broken sources.json reads as no sources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-src-'));
  assert.deepEqual(readSources(root), []);
  fs.writeFileSync(path.join(root, 'sources.json'), '{ not json');
  assert.deepEqual(readSources(root), []);
});

// `force` pins the paths where a source's bytes must win over the main tree's — the one deliberate
// divergence from upstream this pipeline allows. It has to survive readSources (the reader copies
// named fields, so a field it does not know is dropped silently, and a dropped pin list looks exactly
// like an empty one) and it has to be validated: a bad hash would otherwise surface only after an
// upload, and a pin its source cannot supply stops every run.
test('readSources parses force pins and defaults them to empty', () => {
  const root = fixture([
    { id: 'a', repo: 'x/y', package: 'a.zip', force: [{ path: 'assets/x.png', size: 12, sha256: 'A'.repeat(64), why: 'w' }] },
    { id: 'b', repo: 'x/y', package: 'b.zip' },
    { id: 'c', repo: 'x/y', package: 'c.zip', force: 'not-an-array' },
  ]);
  const byId = Object.fromEntries(readSources(root).map((s) => [s.id, s]));
  assert.deepEqual(byId.a.force, [{ path: 'assets/x.png', size: 12, sha256: 'a'.repeat(64), source: 'a', why: 'w' }]);
  assert.deepEqual(byId.b.force, []);
  assert.deepEqual(byId.c.force, []);
});

test('a malformed pin is refused at config time, not after an upload', () => {
  const bad = (force) => () => readSources(fixture([{ id: 'a', repo: 'x/y', package: 'a.zip', force }]));
  assert.throws(bad([{ path: '/abs.png', size: 1, sha256: 'a'.repeat(64) }]), /repo-relative/);
  assert.throws(bad([{ path: 'a/../b.png', size: 1, sha256: 'a'.repeat(64) }]), /repo-relative/);
  assert.throws(bad([{ path: 'a.png', size: 0, sha256: 'a'.repeat(64) }]), /positive integer/);
  assert.throws(bad([{ path: 'a.png', size: 1, sha256: 'nope' }]), /64 hex/);
  assert.throws(bad(['assets/x.png']), /must be an object/);
});

test('pinSatisfied demands exactly the pinned bytes', () => {
  const pin = { path: 'assets/x.png', size: 12, sha256: 'a'.repeat(64) };
  assert.equal(pinSatisfied(pin, { 'assets/x.png': { size: 12, sha256: 'a'.repeat(64) } }), true);
  assert.equal(pinSatisfied(pin, { 'assets/x.png': { size: 13, sha256: 'a'.repeat(64) } }), false, 'size is part of the identity');
  assert.equal(pinSatisfied(pin, { 'assets/x.png': { size: 12, sha256: 'b'.repeat(64) } }), false);
  assert.equal(pinSatisfied(pin, {}), false);
  assert.equal(pinSatisfied(pin, undefined), false);
});

// The override is written into the index before it is serialized and hashed, so everything downstream
// — the cache token, the acceptance gate's expectations, tree.json, the byte sample — describes the
// bytes actually served. Pinning a path upstream does not ship is an error, not a silent addition.
test('applyOverrides rewrites the index entry and reports both sides', () => {
  const index = { files: { 'assets/x.png': { size: 10, sha256: 'c'.repeat(64) } }, count: 1, bytes: 10 };
  const pin = { path: 'assets/x.png', size: 12, sha256: 'a'.repeat(64), source: 'fusion', why: 'hi-res' };
  const applied = applyOverrides(index, [pin]);
  assert.equal(index.files['assets/x.png'].size, 12);
  assert.equal(index.bytes, 12, 'the byte total follows the served bytes');
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].from, { size: 10, sha256: 'c'.repeat(64) });
  assert.equal(applied[0].to.size, 12);
  assert.equal(applied[0].source, 'fusion');
  // already serving exactly those bytes: nothing to report, nothing rewritten
  assert.deepEqual(applyOverrides(index, [pin]), []);
  // a path upstream does not ship is not an override — the additive path covers additions
  assert.throws(() => applyOverrides(index, [{ ...pin, path: 'assets/new.png' }]), /does not ship this path/);
});

test('the release url is built and validated', () => {
  assert.equal(
    sourceReleaseUrl({ repo: 'a/b', release: 'v1' }),
    'https://github.com/a/b/releases/tag/v1',
  );
});

test('finds the package layout without assuming the top folder name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-src-'));
  const top = path.join(root, 'Stronghold-Protocol-whatever');
  fs.mkdirSync(path.join(top, 'public', 'assets', 'char'), { recursive: true });
  fs.mkdirSync(path.join(top, 'data'), { recursive: true });
  fs.writeFileSync(path.join(top, 'data', 'assets.json'), '{}');
  const layout = findSourceLayout(root);
  assert.equal(layout.top, top);
  assert.ok(layout.assets.endsWith(path.join('public', 'assets')));
  assert.ok(layout.manifest.endsWith(path.join('data', 'assets.json')));
});

test('no assets directory means no layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-src-'));
  fs.mkdirSync(path.join(root, 'Stronghold-Protocol', 'server'), { recursive: true });
  assert.equal(findSourceLayout(root), null);
});
