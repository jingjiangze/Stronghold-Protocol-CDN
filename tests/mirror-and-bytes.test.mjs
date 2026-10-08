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
      { id: 'slow', base: 'https://slow.test' },
      { id: 'fast', base: 'https://fast.test' },
      { id: 'dead', base: 'https://dead.test' },
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
  await assert.rejects(() => pickFastest([{ id: 'x', base: 'https://x.test' }], { fetchImpl }), /no mirror answered/);
});

test('rebaseManifest swaps the origin without touching anything else', () => {
  const text = '{"a":"https://a.test/assets/x.png?v=1","b":"https://b.test/keep"}';
  const out = rebaseManifest(text, { from: 'https://a.test', to: 'https://c.test' });
  assert.equal(out, '{"a":"https://c.test/assets/x.png?v=1","b":"https://b.test/keep"}');
});
