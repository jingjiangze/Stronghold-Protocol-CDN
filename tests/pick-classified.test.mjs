import test from 'node:test';
import assert from 'node:assert/strict';

import { classOf, medianTtfb, rankByLatency, pickClassified } from '../src/pick.js';

const body = (n) => new Response(Buffer.alloc(n), { status: 200, headers: { 'content-length': String(n) } });

test('classOf splits the tree the way the measurement did', () => {
  // Throughput class: audio and the big map images.
  assert.equal(classOf('assets/audio/bgm/act1.mp3'), 'large');
  assert.equal(classOf('/assets/audio/voice/1.ogg'), 'large');
  assert.equal(classOf('assets/local/map/autochess/TX_autochessi_D.png'), 'large');
  assert.equal(classOf('/assets/x/whatever.m4a'), 'large');
  // Everything else is latency-dominated (one round trip per file, ~12k of them).
  assert.equal(classOf('assets/spine/op/char_1016_agoat2/front/char_1016_agoat2.skel'), 'small');
  assert.equal(classOf('assets/char/avatar/char_1016_agoat2.png'), 'small');
  assert.equal(classOf('fonts/bender-light.woff2'), 'small');
  assert.equal(classOf(''), 'small');
});

test('medianTtfb is a median, not a mean: one slow path cannot decide alone', () => {
  assert.equal(medianTtfb([{ ttfbMs: 10 }, { ttfbMs: 20 }, { ttfbMs: 900 }]), 20);
  assert.equal(medianTtfb([{ ttfbMs: 5 }, { ttfbMs: 7 }]), 7);
  assert.equal(medianTtfb([]), null);
  assert.equal(medianTtfb([{ bytes: 1 }]), null);
});

test('rankByLatency prefers the median TTFB and falls back to throughput on a tie', () => {
  const ranked = rankByLatency([
    { id: 'slow-start', medianTtfb: 400, bytesPerSec: 9999 },
    { id: 'quick', medianTtfb: 90, bytesPerSec: 10 },
    { id: 'same', medianTtfb: 90, bytesPerSec: 5000 },
  ]);
  assert.deepEqual(ranked.map((r) => r.id), ['same', 'quick', 'slow-start']);
});

// A source is measured on the REAL paths of the class, never on its declared probe.
test('pickClassified measures the real paths it is given', async () => {
  const asked = [];
  const fetchImpl = async (url) => { asked.push(url); return body(1000); };
  await pickClassified(
    [{ id: 'ghfast', root: 'https://gh.test' }],
    { smallPaths: ['assets/spine/a.skel', 'fonts/b.woff2'], originRoot: 'https://origin.test', fetchImpl, timeoutMs: 200 },
  );
  assert.ok(asked.some((u) => u.startsWith('https://gh.test/assets/spine/a.skel')), 'the real path is what gets fetched');
  assert.ok(asked.some((u) => u.startsWith('https://gh.test/fonts/b.woff2')));
  assert.ok(asked.some((u) => u.startsWith('https://origin.test/assets/spine/a.skel')), 'the origin is measured the same way');
  assert.ok(!asked.some((u) => u.includes('/probe/')), 'the declared probe must NOT be used for this decision');
});

test('a mirror wins a class only by the margin; a slim lead keeps the origin', async () => {
  // The mirror answers in ~0 ms, the origin after 120 ms — a lead far beyond 20%.
  const wins = await pickClassified(
    [{ id: 'fast', root: 'https://fast.test' }],
    { smallPaths: ['assets/a.skel'], originRoot: 'https://origin.test', fetchImpl: async (u) => { if (u.includes('origin.test')) await new Promise((r) => setTimeout(r, 120)); return body(500); }, timeoutMs: 2000 },
  );
  assert.equal(wins.small.winner, true, 'a 100x lead must take the class');
  assert.equal(wins.small.id, 'fast');

  // A ~10% lead is inside the margin: the origin keeps it, because being wrong about the origin is
  // the expensive direction (it holds the bytes natively).
  const held = await pickClassified(
    [{ id: 'marginal', root: 'https://marginal.test' }],
    { smallPaths: ['assets/a.skel'], originRoot: 'https://origin.test', fetchImpl: async (u) => { if (u.includes('marginal')) await new Promise((r) => setTimeout(r, 90)); return body(500); }, timeoutMs: 2000 },
  );
  assert.equal(held.small.winner, false, 'a lead inside the margin must not displace the origin');
  assert.equal(held.small.root, 'https://origin.test');
});

test('a source that fails one real path is dropped for that class (the jsDelivr case)', async () => {
  const res = await pickClassified(
    [{ id: 'flaky', root: 'https://flaky.test' }, { id: 'solid', root: 'https://solid.test' }],
    {
      smallPaths: ['assets/a.skel', 'assets/b.skel'],
      originRoot: 'https://origin.test',
      timeoutMs: 500,
      fetchImpl: async (u) => {
        if (u.includes('flaky') && u.includes('assets/b.skel')) throw new Error('timeout');
        if (u.includes('origin.test')) await new Promise((r) => setTimeout(r, 200));
        return body(500);
      },
    },
  );
  assert.ok(!res.small.ranked.some((r) => r.id === 'flaky'), 'a source with a failed path must not be ranked');
});

test('the two classes can come out as different sources', async () => {
  const res = await pickClassified(
    [{ id: 'latency-king', root: 'https://a.test' }, { id: 'throughput-king', root: 'https://b.test' }],
    {
      smallPaths: ['assets/spine/a.skel'],
      largePaths: ['assets/local/map/big.png'],
      originRoot: 'https://origin.test',
      timeoutMs: 3000,
      fetchImpl: async (u) => {
        // The LARGE path is where a source's link matters: a.test stalls on it, b.test does not.
        // (An in-memory Response is not slower for being bigger, so the difference has to be modelled
        // by the link — which is exactly what the picker is measuring in the field.)
        if (u.includes('big.png')) {
          if (u.includes('a.test')) await new Promise((r) => setTimeout(r, 250));
          if (u.includes('origin.test')) await new Promise((r) => setTimeout(r, 150));
          return body(3_000_000);
        }
        if (u.includes('origin.test')) await new Promise((r) => setTimeout(r, 150));
        return body(500);
      },
    },
  );
  assert.equal(res.small.id, 'latency-king');
  assert.equal(res.large.id, 'throughput-king');
});

test('with no sample paths a class is absent rather than guessed', async () => {
  const res = await pickClassified([{ id: 'x', root: 'https://x.test' }], { smallPaths: ['assets/a.skel'], originRoot: 'https://origin.test', fetchImpl: async () => body(10), timeoutMs: 500 });
  assert.equal(res.large, null);
  assert.ok(res.small);
});
