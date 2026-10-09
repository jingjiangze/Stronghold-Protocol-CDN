import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregate, pickDropinAsset, pickOfficialCdnAsset } from '../src/site-data.mjs';

test('aggregates the flat index into directories, biggest first', () => {
  const dirs = aggregate({
    'assets/char/a.png': { size: 100 },
    'assets/char/b.png': { size: 50 },
    'assets/audio/x.mp3': { size: 10 },
    'fonts/f.woff2': { size: 5 },
  });
  assert.deepEqual(dirs.map((d) => d.prefix), ['assets/char/', 'assets/audio/', 'fonts/']);
  assert.deepEqual(dirs[0], { prefix: 'assets/char/', files: 2, bytes: 150 });
  assert.deepEqual(dirs[2], { prefix: 'fonts/', files: 1, bytes: 5 });
});

test('an empty index aggregates to nothing rather than throwing', () => {
  assert.deepEqual(aggregate({}), []);
  assert.deepEqual(aggregate(undefined), []);
});

test('entries without a size still count', () => {
  const dirs = aggregate({ 'assets/ui/a.png': {} });
  assert.deepEqual(dirs, [{ prefix: 'assets/ui/', files: 1, bytes: 0 }]);
});

// ---- the drop-in download link -------------------------------------------------------------

const release = (tag, published, names) => ({
  tag_name: tag,
  published_at: published,
  assets: names.map((name) => ({ name, size: 13344, browser_download_url: `https://github.com/o/r/releases/download/${tag}/${name}` })),
});

test('picks the newest release that carries a drop-in zip', () => {
  const picked = pickDropinAsset([
    release('assets-v0.2.0', '2026-10-01T00:00:00Z', ['stronghold-cdn-dropin-v0.2.0.zip']),
    release('assets-v0.2.1', '2026-10-08T13:29:06Z', ['assets-audio-1.zip', 'stronghold-cdn-dropin-v0.2.1.zip']),
  ]);
  assert.equal(picked.name, 'stronghold-cdn-dropin-v0.2.1.zip');
  assert.equal(picked.release, 'assets-v0.2.1');
});

test('pack assets are never mistaken for the drop-in zip', () => {
  const picked = pickDropinAsset([
    release('assets-v0.2.1', '2026-10-08T13:29:06Z', ['assets-audio-1.zip', 'assets-spine-1.zip', 'fonts-1.zip']),
  ]);
  assert.equal(picked, null);
});

test('no releases, or none with a matching asset, resolves to null', () => {
  assert.equal(pickDropinAsset([]), null);
  assert.equal(pickDropinAsset(undefined), null);
  assert.equal(pickDropinAsset([release('x', '2026-01-01T00:00:00Z', ['notes.txt'])]), null);
});

test('a release whose published_at is missing still counts', () => {
  const picked = pickDropinAsset([{ tag_name: 'assets-v9', assets: [{ name: 'stronghold-cdn-dropin-v9.zip', size: 1, browser_download_url: 'u' }] }]);
  assert.equal(picked.release, 'assets-v9');
});

// ---- the second variant: the upstream lite package with our CDN ---------------------------------

// The two buttons sit next to each other, so the one thing that must never happen is a button
// resolving the other variant's zip. "stronghold-official-cdn-…" does not contain the drop-in's
// "stronghold-cdn" (the substring is "official-cdn"), which is what keeps the patterns disjoint.
test('the two download patterns never pick up each other asset', () => {
  const releases = [
    release('assets-v0.2.2', '2026-10-08T19:32:00Z', [
      'assets-audio-1.zip',
      'stronghold-cdn-dropin-v0.2.2.zip',
      'stronghold-official-cdn-v0.2.2.zip',
    ]),
  ];
  assert.equal(pickDropinAsset(releases).name, 'stronghold-cdn-dropin-v0.2.2.zip');
  assert.equal(pickOfficialCdnAsset(releases).name, 'stronghold-official-cdn-v0.2.2.zip');
});

test('the variant resolves to the newest release that carries one', () => {
  const picked = pickOfficialCdnAsset([
    release('assets-v0.2.1', '2026-10-07T00:00:00Z', ['stronghold-official-cdn-v0.2.1.zip']),
    release('assets-v0.2.2', '2026-10-08T19:32:00Z', ['stronghold-cdn-dropin-v0.2.2.zip', 'stronghold-official-cdn-v0.2.2.zip']),
  ]);
  assert.equal(picked.name, 'stronghold-official-cdn-v0.2.2.zip');
  assert.equal(picked.release, 'assets-v0.2.2');
});

// A release built before the variant existed has only the drop-in: the second button must degrade
// to the Releases page, not silently point at the drop-in zip.
test('a release with only a drop-in zip yields no variant', () => {
  const releases = [release('assets-v0.2.1', '2026-10-07T00:00:00Z', ['stronghold-cdn-dropin-v0.2.1.zip'])];
  assert.equal(pickOfficialCdnAsset(releases), null);
  assert.ok(pickDropinAsset(releases));
});

test('pack assets are never mistaken for the variant', () => {
  assert.equal(pickOfficialCdnAsset([release('assets-v0.2.2', '2026-10-08T19:32:00Z', ['assets-audio-1.zip', 'fonts-1.zip'])]), null);
});
