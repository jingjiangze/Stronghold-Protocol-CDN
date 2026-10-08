import test from 'node:test';
import assert from 'node:assert/strict';

import { assertOwnedKey, r2Config, mimeFor } from '../src/r2.mjs';

// The bucket is shared with other product lines, so a write outside our own keys is a bug and
// must fail loudly rather than quietly clobber someone else's object.
test('accepts the prefixes this repository owns', () => {
  for (const key of ['assets/a.png', 'fonts/f.woff2', 'data/assets.json', 'cdn/v1/art.json', 'packs/assets-v0.2.1/a.zip']) {
    assert.doesNotThrow(() => assertOwnedKey(key), key);
  }
});

test('accepts robots.txt, which has to live at the root', () => {
  assert.doesNotThrow(() => assertOwnedKey('robots.txt'));
});

test('refuses the prefixes other product lines use', () => {
  for (const key of ['apk/latest.json', 'assets-re/char/a.webp', 'site/manifest.json', 'upstream/x.zip', 'scout/x.json', 'index.html']) {
    assert.throws(() => assertOwnedKey(key), /refusing to write outside/, key);
  }
});

test('a prefix match must not be a substring match', () => {
  assert.throws(() => assertOwnedKey('assets-re/x'), /refusing/);
  assert.throws(() => assertOwnedKey('datax/x'), /refusing/);
});

test('credentials come from the environment, and a missing one is named', () => {
  assert.throws(() => r2Config({}), /R2_ENDPOINT/);
  const config = r2Config({
    R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID: 'id',
    R2_SECRET_ACCESS_KEY: 'secret',
  });
  assert.equal(config.bucket, 'stronghold-assets');
  assert.equal(config.host, 'example.r2.cloudflarestorage.com');
});

test('mime types cover the tree and default to octet-stream', () => {
  assert.equal(mimeFor('assets/a.png'), 'image/png');
  assert.equal(mimeFor('assets/a.mp3'), 'audio/mpeg');
  assert.equal(mimeFor('assets/a.skel'), 'application/octet-stream');
  assert.equal(mimeFor('assets/no-extension'), 'application/octet-stream');
});
