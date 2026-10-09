import test from 'node:test';
import assert from 'node:assert/strict';

import { planPacks, groupOf, mirrorUrls } from '../src/packs.mjs';

const filesOf = (entries) => Object.fromEntries(entries.map(([k, size]) => [k, { size, sha256: k }]));

test('groups by the first two path segments, fonts by their own', () => {
  assert.equal(groupOf('assets/audio/bgm/x.mp3'), 'assets/audio');
  assert.equal(groupOf('assets/spine/op/a/b.skel'), 'assets/spine');
  assert.equal(groupOf('fonts/bender.woff2'), 'fonts');
});

test('keeps a group together when it fits, and orders packs by group', () => {
  const files = filesOf([
    ['assets/char/avatar/a.png', 10],
    ['assets/audio/bgm/x.mp3', 20],
    ['fonts/f.woff2', 5],
  ]);
  const packs = planPacks(files, { maxBytes: 1000 });
  assert.deepEqual(packs.map((p) => p.id), ['assets-audio-1', 'assets-char-1', 'fonts-1']);
  assert.deepEqual(packs[0].keys, ['assets/audio/bgm/x.mp3']);
  assert.equal(packs[2].bytes, 5);
});

test('chunks a group bigger than the cap, in manifest order', () => {
  const files = filesOf([
    ['assets/spine/a.skel', 60],
    ['assets/spine/b.skel', 60],
    ['assets/spine/c.skel', 60],
  ]);
  const packs = planPacks(files, { maxBytes: 100 });
  assert.deepEqual(packs.map((p) => p.id), ['assets-spine-1', 'assets-spine-2', 'assets-spine-3']);
  assert.deepEqual(packs.map((p) => p.keys.length), [1, 1, 1]);
  assert.deepEqual(packs.map((p) => p.bytes), [60, 60, 60]);
});

test('every key lands in exactly one pack, and nothing is dropped', () => {
  const files = filesOf([
    ['assets/audio/a.mp3', 40],
    ['assets/audio/b.mp3', 40],
    ['assets/audio/c.mp3', 40],
    ['assets/char/d.png', 40],
  ]);
  const packs = planPacks(files, { maxBytes: 100 });
  const seen = packs.flatMap((p) => p.keys).sort();
  assert.deepEqual(seen, Object.keys(files).sort());
  assert.equal(new Set(seen).size, seen.length);
});

test('a single file larger than the cap still gets its own pack', () => {
  const packs = planPacks(filesOf([['assets/audio/huge.mp3', 500]]), { maxBytes: 100 });
  assert.deepEqual(packs.map((p) => p.keys), [['assets/audio/huge.mp3']]);
});

test('mirror urls put the canonical github url first', () => {
  const urls = mirrorUrls('https://github.com/o/r/releases/download/t/p.zip', ['https://ghfast.top/', 'https://gh-proxy.com']);
  assert.deepEqual(urls, [
    'https://github.com/o/r/releases/download/t/p.zip',
    'https://ghfast.top/github.com/o/r/releases/download/t/p.zip',
    'https://gh-proxy.com/github.com/o/r/releases/download/t/p.zip',
  ]);
});

// The pack URL list used to be github plus third-party mirrors only, so no pack could be fetched
// through our own domain even though R2 already holds every one of them. "Download through my
// domain" was simply impossible for the 481 MB of packs.
test('the own-domain copy is offered alongside github and the mirrors', () => {
  const github = 'https://github.com/o/r/releases/download/assets-v0.2.2/a.zip';
  const urls = mirrorUrls(github, ['https://ghfast.top'], 'https://cdn.example/packs/assets-v0.2.2/a.zip');
  assert.equal(urls[0], 'https://cdn.example/packs/assets-v0.2.2/a.zip');
  assert.ok(urls.includes(github), 'github must stay in the list as the canonical source');
  assert.ok(urls.some((u) => u.startsWith('https://ghfast.top/')), 'mirrors must stay');
  assert.equal(urls.length, 3);
});

test('without an own base the list is unchanged', () => {
  const github = 'https://github.com/o/r/releases/download/assets-v0.2.2/a.zip';
  assert.deepEqual(mirrorUrls(github, ['https://ghfast.top']), [github, 'https://ghfast.top/github.com/o/r/releases/download/assets-v0.2.2/a.zip']);
  assert.deepEqual(mirrorUrls(github, []), [github]);
});
