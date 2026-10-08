import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rewriteManifestText,
  collectManifestPaths,
  manifestUrls,
} from '../src/rewrite-manifest.mjs';

const BASE = 'https://cdn.example.test';

test('rewrites asset and font paths to absolute URLs and leaves everything else alone', () => {
  const input = JSON.stringify({
    version: 1,
    chars: { a: { avatar: '/assets/char/avatar/a.png', back: '/assets/spine/a/a.png' } },
    fonts: { css: '/fonts/fonts.css' },
    servers: 'https://example.test/keep-me',
    note: 'assets/char/avatar/a.png',
  });

  const { text, count } = rewriteManifestText(input, { base: BASE, version: 'v0.2.1' });
  const out = JSON.parse(text);

  assert.equal(count, 3);
  assert.equal(out.chars.a.avatar, `${BASE}/assets/char/avatar/a.png?v=v0.2.1`);
  assert.equal(out.fonts.css, `${BASE}/fonts/fonts.css?v=v0.2.1`);
  // untouched: a foreign absolute URL, a relative mention without the leading slash, and scalars
  assert.equal(out.servers, 'https://example.test/keep-me');
  assert.equal(out.note, 'assets/char/avatar/a.png');
  assert.equal(out.version, 1);
});

test('omits the version token when no version is given', () => {
  const { text } = rewriteManifestText('{"a":"/assets/x.png"}', { base: `${BASE}/` });
  assert.equal(JSON.parse(text).a, `${BASE}/assets/x.png`);
});

test('a trailing slash on the base does not double up', () => {
  const { text } = rewriteManifestText('{"a":"/assets/x.png"}', { base: `${BASE}///` });
  assert.equal(JSON.parse(text).a, `${BASE}/assets/x.png`);
});

test('formatting is preserved byte for byte outside the rewritten strings', () => {
  const input = '{\n  "a" : "/assets/x.png",\n  "b":   2\n}\n';
  const { text } = rewriteManifestText(input, { base: BASE });
  assert.equal(text, `{\n  "a" : "${BASE}/assets/x.png",\n  "b":   2\n}\n`);
});

test('collects the acceptance list, deduplicated and sorted', () => {
  const paths = collectManifestPaths(
    '{"a":"/assets/b.png","b":"/assets/a.png","c":"/assets/a.png","d":"/fonts/f.woff2","e":"/other/x"}',
  );
  assert.deepEqual(paths, ['/assets/a.png', '/assets/b.png', '/fonts/f.woff2']);
});

test('manifestUrls mirrors the collected paths in order', () => {
  const urls = manifestUrls('{"a":"/assets/b.png","b":"/fonts/f.woff2"}', {
    base: BASE,
    version: 'v1',
  });
  assert.deepEqual(urls, [`${BASE}/assets/b.png?v=v1`, `${BASE}/fonts/f.woff2?v=v1`]);
});

test('refuses to rewrite without a base', () => {
  assert.throws(() => rewriteManifestText('{}', {}), /base is required/);
});
