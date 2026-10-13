import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { readSources, findSourceLayout, sourceReleaseUrl, readOverrides, readPinnedBytes, applyOverrides } from '../src/sources.mjs';

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

// An override pins a path where this repository deliberately serves bytes upstream does not ship.
// The entry has to survive the reader (a field it does not know is dropped silently, and a dropped
// override looks exactly like no override) and be validated before anything is uploaded.
function overrideFixture(overrides, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ovr-'));
  fs.writeFileSync(path.join(root, 'sources.json'), JSON.stringify({ sources: [], overrides }));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, 'pin', rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

test('readOverrides parses pins and defaults to none', () => {
  const root = overrideFixture([{ path: 'assets/x.png', size: 12, sha256: 'A'.repeat(64), why: 'w' }]);
  assert.deepEqual(readOverrides(root), [{ path: 'assets/x.png', size: 12, sha256: 'a'.repeat(64), why: 'w' }]);
  assert.deepEqual(readOverrides(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-none-'))), [], 'no sources.json reads as no overrides');
});

test('a malformed override is refused at config time, not after an upload', () => {
  const bad = (overrides) => () => readOverrides(overrideFixture(overrides));
  assert.throws(bad([{ path: '/abs.png', size: 1, sha256: 'a'.repeat(64) }]), /repo-relative/);
  assert.throws(bad([{ path: 'a/../b.png', size: 1, sha256: 'a'.repeat(64) }]), /repo-relative/);
  assert.throws(bad([{ path: 'a.png', size: 0, sha256: 'a'.repeat(64) }]), /positive integer/);
  assert.throws(bad([{ path: 'a.png', size: 1, sha256: 'nope' }]), /64 hex/);
  assert.throws(bad(['assets/x.png']), /must be an object/);
});

// The bytes live in the repository and the hash check is what makes a pin a promise about bytes
// rather than a hope: a missing file or a mismatch stops the run instead of publishing something else.
test('readPinnedBytes reads pin/<path> and refuses anything else', () => {
  const body = Buffer.from('hello pinned bytes');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const pin = { path: 'assets/x.bin', size: body.length, sha256 };
  const root = overrideFixture([], { 'assets/x.bin': body });
  assert.deepEqual(readPinnedBytes(root, pin), body);
  assert.throws(() => readPinnedBytes(root, { ...pin, size: pin.size + 1 }), /the pin says/);
  assert.throws(() => readPinnedBytes(root, { ...pin, sha256: 'b'.repeat(64) }), /hashes to/);
  assert.throws(() => readPinnedBytes(root, { ...pin, path: 'assets/missing.bin' }), /cannot read/);
});

// The override is written into the index before it is serialized and hashed, so everything downstream
// — the cache token, the acceptance gate's expectations, tree.json, the byte sample — describes the
// bytes actually served. Pinning a path upstream does not ship is an error, not a silent addition.
test('applyOverrides rewrites the index entry and reports both sides', () => {
  const index = { files: { 'assets/x.png': { size: 10, sha256: 'c'.repeat(64) } }, count: 1, bytes: 10 };
  const pin = { path: 'assets/x.png', size: 12, sha256: 'a'.repeat(64), why: 'hi-res' };
  const applied = applyOverrides(index, [pin]);
  assert.equal(index.files['assets/x.png'].size, 12);
  assert.equal(index.bytes, 12, 'the byte total follows the served bytes');
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].from, { size: 10, sha256: 'c'.repeat(64) });
  assert.equal(applied[0].to.size, 12);
  assert.equal(applied[0].why, 'hi-res');
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
