import test from 'node:test';
import assert from 'node:assert/strict';

import { sampleKeys, urlsForKeys, verifyByteSample } from '../src/verify-bytes.mjs';
import { pickFastest, rebaseManifest } from '../src/pick.js';

const filesOf = (sizes) => Object.fromEntries(Object.entries(sizes).map(([k, size]) => [k, { size, sha256: k }]));

test('the byte sample is deterministic and always includes the largest files', () => {
  const files = filesOf(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`assets/f${i}.png`, i + 1])));
  const first = sampleKeys(files, { sample: 12 });
  const second = sampleKeys(files, { sample: 12 });
  assert.deepEqual(first, second);
  assert.equal(first.length, 12);
  // the four biggest must be in there — a transcode would shrink exactly those
  for (const key of ['assets/f49.png', 'assets/f48.png', 'assets/f47.png', 'assets/f46.png']) {
    assert.ok(first.includes(key), key);
  }
});

test('a tree smaller than the sample is taken whole', () => {
  const files = filesOf({ 'assets/a.png': 1, 'assets/b.png': 2 });
  assert.deepEqual(sampleKeys(files, { sample: 10 }), ['assets/a.png', 'assets/b.png']);
});

test('urlsForKeys builds versioned absolute urls', () => {
  assert.deepEqual(urlsForKeys(['assets/a.png'], { base: 'https://cdn.test/', version: 'v1' }), [
    'https://cdn.test/assets/a.png?v=v1',
  ]);
});

test('the byte sample reports a re-encoded file as a mismatch', async () => {
  const files = filesOf({ 'assets/a.png': 4 });
  files['assets/a.png'].sha256 = 'aaaa';
  const fetchImpl = async () => new Response(Buffer.from('other'));
  const result = await verifyByteSample(['https://cdn.test/assets/a.png'], { files, fetchImpl });
  assert.equal(result.checked, 1);
  assert.equal(result.mismatch.length, 1);
  assert.equal(result.mismatch[0].key, 'assets/a.png');
});

test('a matching file passes the byte sample', async () => {
  const { createHash } = await import('node:crypto');
  const body = Buffer.from('exact bytes');
  const files = filesOf({ 'assets/a.png': body.length });
  files['assets/a.png'].sha256 = createHash('sha256').update(body).digest('hex');
  const fetchImpl = async () => new Response(body);
  const result = await verifyByteSample(['https://cdn.test/assets/a.png'], { files, fetchImpl });
  assert.equal(result.checked, 1);
  assert.equal(result.mismatch.length, 0);
});

test('the picker returns the fastest mirror and ranks the rest', async () => {
  const fetchImpl = async (url) => {
    const id = url.split('/')[2];
    if (id === 'slow.test') await new Promise((r) => setTimeout(r, 30));
    if (id === 'dead.test') throw new Error('ECONNREFUSED');
    return new Response('{}');
  };
  const { best, ranked } = await pickFastest(
    [
      { id: 'slow', root: 'https://slow.test' },
      { id: 'fast', root: 'https://fast.test' },
      { id: 'dead', root: 'https://dead.test' },
    ],
    { fetchImpl },
  );
  assert.equal(best.id, 'fast');
  assert.deepEqual(ranked.map((m) => m.id), ['fast', 'slow']);
});

test('the picker fails loudly when nothing answers', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(() => pickFastest([{ id: 'x', root: 'https://x.test' }], { fetchImpl }), /no mirror answered/);
});

test('rebaseManifest swaps the origin without touching anything else', () => {
  const text = '{"a":"https://a.test/assets/x.png?v=1","b":"https://b.test/keep"}';
  const out = rebaseManifest(text, { from: 'https://a.test', to: 'https://c.test' });
  assert.equal(out, '{"a":"https://c.test/assets/x.png?v=1","b":"https://b.test/keep"}');
});

// A git-mount origin cannot serve the R2-only interface paths, so it publishes its own probe. If
// the picker ignores that, every git mirror is discarded as broken -- which is what it used to do,
// while the site's own speed test (which does read `probe`) ranked them fine. The two must agree.
test('the picker probes each mirror on the path that mirror declares', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    // The git mirror only answers its own probe path; the R2-only default 404s there.
    if (url.includes('git.test') && !url.includes('/probe/cdn-probe.bin')) return new Response('nope', { status: 404 });
    return new Response('{}');
  };
  const { best, ranked } = await pickFastest(
    [
      { id: 'r2', root: 'https://r2.test' },
      { id: 'git', root: 'https://git.test', probe: '/probe/cdn-probe.bin' },
    ],
    { fetchImpl, attempts: 1 },
  );

  assert.deepEqual(ranked.map((m) => m.id).sort(), ['git', 'r2'], 'the git mirror must survive the race');
  assert.ok(best, 'a winner is still chosen');
  // Each mirror was asked for its own path, and the git one was never asked for the default.
  assert.ok(asked.some((u) => u.startsWith('https://r2.test/robots.txt')), 'the R2 mirror keeps the default path');
  assert.ok(asked.some((u) => u.startsWith('https://git.test/probe/cdn-probe.bin')), 'the git mirror uses its declared probe');
  assert.ok(!asked.some((u) => u.startsWith('https://git.test/robots.txt')), 'the git mirror must not be probed on /robots.txt');
});

// Without a declared probe the caller's default still applies, so nothing changes for flat origins.
test('a mirror without a declared probe uses the default path', async () => {
  const asked = [];
  await pickFastest([{ id: 'x', root: 'https://x.test' }], {
    fetchImpl: async (url) => { asked.push(url); return new Response('{}'); },
    attempts: 1,
    path: '/custom.bin',
  });
  assert.ok(asked.every((u) => u.startsWith('https://x.test/custom.bin')), `unexpected probe: ${asked[0]}`);
});

// A short body with a 200 is the failure mode this project has actually hit on a third-party
// mirror. It must count as broken, not as "fastest".
test('a truncated 200 is treated as broken, not as the winner', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('liar.test')) {
      return new Response('12345', { status: 200, headers: { 'content-length': '100' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-length': '2' } });
  };
  const { best, ranked } = await pickFastest(
    [
      { id: 'liar', root: 'https://liar.test' },
      { id: 'honest', root: 'https://honest.test' },
    ],
    { fetchImpl, attempts: 1 },
  );
  assert.equal(best.id, 'honest');
  assert.deepEqual(ranked.map((m) => m.id), ['honest'], 'the truncating mirror must be dropped entirely');
});

test('an empty 200 is treated as broken', async () => {
  const fetchImpl = async () => new Response('', { status: 200, headers: { 'content-length': '0' } });
  await assert.rejects(() => pickFastest([{ id: 'x', root: 'https://x.test' }], { fetchImpl, attempts: 1 }), /no mirror answered/);
});
