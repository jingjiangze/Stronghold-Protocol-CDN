import test from 'node:test';
import assert from 'node:assert/strict';

import {
  servesAssets, eligibleMirrors, pickFastest, pickStaged, rankSamples,
  chooseWithHysteresis, isFresh, readPick, writePick, resolveSource, PICK_CACHE_KEY,
} from '../src/pick.js';

const ok = (body = '{}') => new Response(body, { status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) } });
const mapStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };

// --- eligibility: the defect that made a 404-everything source look like the winner -----------------

test('a @main git mount is not an asset source, by field or by legacy coverage', () => {
  assert.equal(servesAssets({ coverage: 'partial' }), false, 'coverage:partial disqualifies');
  assert.equal(servesAssets({ assetEligible: false }), false, 'the published field disqualifies');
  assert.equal(servesAssets({ coverage: 'full', assetEligible: true }), true);
  // A flat origin carries neither field; it must stay eligible (backward compatible).
  assert.equal(servesAssets({ id: 'r2', root: 'https://weishucdn.example' }), true);
});

test('eligibleMirrors drops disabled, relay and non-asset sources', () => {
  const list = [
    { id: 'r2', root: 'https://r2.test' },
    { id: 'partial', root: 'https://p.test', coverage: 'partial' },
    { id: 'relay', root: 'https://relay.test', proxied: true },
    { id: 'off', root: 'https://off.test', enabled: false },
    { id: 'nohost' },
  ];
  assert.deepEqual(eligibleMirrors(list).map((m) => m.id), ['r2']);
  // Opting into relays is explicit, and never resurrects a partial or a disabled source.
  assert.deepEqual(eligibleMirrors(list, { allowRelay: true }).map((m) => m.id), ['r2', 'relay']);
  // A caller that is not picking an asset base may keep partial sources.
  assert.deepEqual(eligibleMirrors(list, { requireAssets: false }).map((m) => m.id), ['r2', 'partial']);
});

test('the fastest mirror that cannot serve assets is never the winner', async () => {
  const fetchImpl = async (url) => {
    const host = new URL(url).host;
    if (host === 'main.test') await new Promise((r) => setTimeout(r, 0)); // the "fast" 404 source
    return ok();
  };
  const { best, ranked } = await pickFastest(
    [
      { id: 'main', root: 'https://main.test', coverage: 'partial' },
      { id: 'assets', root: 'https://assets.test', coverage: 'full' },
    ],
    { fetchImpl, attempts: 1 },
  );
  assert.equal(best.id, 'assets');
  assert.deepEqual(ranked.map((m) => m.id), ['assets'], 'the partial source must not even be raced');
});

// --- failure isolation: one attempt failing must not kill the mirror --------------------------------

test('a transient first-attempt failure does not discard the mirror (retry)', async () => {
  const calls = {};
  const fetchImpl = async (url) => {
    const host = new URL(url).host;
    calls[host] = (calls[host] || 0) + 1;
    if (host === 'flaky.test' && calls[host] === 1) throw new Error('ECONNRESET');
    return ok();
  };
  const { ranked } = await pickFastest(
    [{ id: 'flaky', root: 'https://flaky.test' }, { id: 'solid', root: 'https://solid.test' }],
    { fetchImpl, attempts: 2 },
  );
  assert.deepEqual(ranked.map((m) => m.id).sort(), ['flaky', 'solid'], 'the flaky mirror must survive attempt 0');
  assert.equal(calls['flaky.test'], 2, 'it was retried');
});

test('one dead mirror does not stop the others', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('dead.test')) throw new Error('ECONNREFUSED');
    return ok();
  };
  const { ranked } = await pickFastest(
    [{ id: 'dead', root: 'https://dead.test' }, { id: 'alive', root: 'https://alive.test' }],
    { fetchImpl, attempts: 1 },
  );
  assert.deepEqual(ranked.map((m) => m.id), ['alive']);
});

test('ranking prefers throughput over a merely-fast first byte', () => {
  const ranked = rankSamples([
    { id: 'quick-slow', ttfbMs: 10, bytesPerSec: 1000 },
    { id: 'slow-fast', ttfbMs: 300, bytesPerSec: 9000 },
  ]);
  assert.equal(ranked[0].id, 'slow-fast');
});

// --- staged probing: bounded bytes ---------------------------------------------------------------

test('staged pick stays inside its byte budget and returns a source', async () => {
  const BIG = Buffer.alloc(200 * 1024); // larger than any stage cap, so the cap is exercised
  const fetchImpl = async (url) => {
    const host = new URL(url).host;
    const body = host === 'a.test' ? BIG : Buffer.alloc(120 * 1024);
    return new Response(body, { status: 200 });
  };
  const res = await pickStaged(
    [
      { id: 'a', root: 'https://a.test', faultDomain: 'a' },
      { id: 'b', root: 'https://b.test', faultDomain: 'b' },
    ],
    { fetchImpl, shortlist: 5, finalists: 2, stage1Bytes: 32 * 1024, stage2Bytes: 64 * 1024, finalAttempts: 2 },
  );
  const cap = 5 * 32 * 1024 + 2 * 2 * 64 * 1024; // shortlist*stage1 + finalists*attempts*stage2
  assert.ok(res.bytes > 0 && res.bytes <= cap, `bytes ${res.bytes} must be within ${cap}`);
  assert.ok(res.best && ['a', 'b'].includes(res.best.id));
  assert.equal(res.stages.second, 2, 'both finalists were re-measured');
});

test('staged pick never spends the shortlist on two entrances to one backend', async () => {
  const fetchImpl = async () => new Response(Buffer.alloc(8 * 1024), { status: 200 });
  const res = await pickStaged(
    [
      { id: 'r2', root: 'https://weishucdn.test', faultDomain: 'r2-bucket' },
      { id: 'r2-alt', root: 'https://weishucdn2.test', faultDomain: 'r2-bucket' },
      { id: 'pages', root: 'https://spages.test', faultDomain: 'spages.test' },
    ],
    { fetchImpl, shortlist: 2 },
  );
  assert.deepEqual(res.ranked.map((m) => m.id).sort(), ['pages', 'r2']);
  assert.ok(!res.ranked.some((m) => m.id === 'r2-alt'), 'the second entrance to the same bucket must be skipped');
});

// --- hysteresis: do not flap between near-equal sources --------------------------------------------

test('a near-equal leader does not displace the current source', () => {
  const ranked = [{ id: 'b', bytesPerSec: 1050 }, { id: 'a', bytesPerSec: 1000 }];
  assert.equal(chooseWithHysteresis(ranked, { current: 'a' }).id, 'a', '5% better is inside the 15% tolerance');
  assert.equal(chooseWithHysteresis([{ id: 'b', bytesPerSec: 2000 }, { id: 'a', bytesPerSec: 1000 }], { current: 'a' }).id, 'b', '2x better displaces');
  assert.equal(chooseWithHysteresis(ranked, { current: 'gone' }).id, 'b', 'a vanished current falls through to the leader');
});

// --- cache ---------------------------------------------------------------------------------------

test('a stored pick is reusable only while fresh', () => {
  const store = mapStore();
  writePick(store, { id: 'r2', ranked: [{ id: 'r2', bytesPerSec: 1 }] }, { now: () => 1000 });
  const record = JSON.parse(store.getItem(PICK_CACHE_KEY));
  assert.equal(isFresh(record, { now: 1000 + 60_000 }), true);
  assert.equal(isFresh(record, { now: 1000 + 7 * 3600_000 }), false, 'older than 6h is stale');
  assert.equal(readPick(store, { now: 1000 + 60_000 }).id, 'r2');
  assert.equal(readPick(store, { now: 1000 + 7 * 3600_000 }), null);
});

test('resolveSource reuses a fresh cached pick when it is still in the list', async () => {
  const store = mapStore();
  writePick(store, { id: 'r2', ranked: [] });
  let fetched = 0;
  const res = await resolveSource(
    [{ id: 'r2', root: 'https://r2.test' }, { id: 'pages', root: 'https://pages.test' }],
    { storage: store, fetchImpl: async () => { fetched++; return ok(); } },
  );
  assert.equal(res.fromCache, true);
  assert.equal(res.best.id, 'r2');
  assert.equal(fetched, 0, 'a fresh cache must not trigger any probe');
});

test('resolveSource ignores a cached pick whose source is no longer offered', async () => {
  const store = mapStore();
  writePick(store, { id: 'retired', ranked: [] });
  const res = await resolveSource(
    [{ id: 'r2', root: 'https://r2.test', faultDomain: 'r2' }],
    { storage: store, fetchImpl: async () => new Response(Buffer.alloc(4096), { status: 200 }) },
  );
  assert.equal(res.fromCache, false);
  assert.equal(res.best.id, 'r2');
});
