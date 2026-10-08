import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyUrls, passes, summarizeVerification } from '../src/verify-remote.mjs';

/** A fetch stand-in: `routes` maps url -> { status, length, contentRange } | Error. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method, range: init.headers?.range });
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (!route) return new Response(null, { status: 404 });
    const headers = {};
    if (route.length != null) headers['content-length'] = String(route.length);
    if (route.contentRange) headers['content-range'] = route.contentRange;
    return new Response(init.method === 'GET' ? 'x' : null, { status: route.status ?? 200, headers });
  };
  impl.calls = calls;
  return impl;
}

test('a matching size passes', async () => {
  const fetchImpl = fakeFetch({ 'https://cdn.test/a.png': { length: 10 } });
  const result = await verifyUrls(['https://cdn.test/a.png'], { expected: { 'https://cdn.test/a.png': 10 }, fetchImpl });
  assert.equal(result.ok, 1);
  assert.ok(passes(result));
});

test('a 404 is missing, not a mismatch', async () => {
  const fetchImpl = fakeFetch({});
  const result = await verifyUrls(['https://cdn.test/gone.png'], { fetchImpl });
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].status, 404);
  assert.ok(!passes(result));
});

test('a different size is a mismatch', async () => {
  const url = 'https://cdn.test/stale.png';
  const fetchImpl = fakeFetch({ [url]: { length: 99 } });
  const result = await verifyUrls([url], { expected: { [url]: 10 }, fetchImpl });
  assert.deepEqual(result.mismatch, [{ url, expected: 10, got: 99 }]);
  assert.ok(!passes(result));
});

// The edge quirk that produced false mismatches on the first dry run: HEAD answers 200 with no
// usable length, so the real size has to come from a ranged GET.
test('a HEAD without a usable length falls back to a ranged GET', async () => {
  const url = 'https://cdn.test/fonts.css';
  const fetchImpl = fakeFetch({
    [url]: { length: 0, contentRange: 'bytes 0-0/1046' },
  });
  const result = await verifyUrls([url], { expected: { [url]: 1046 }, fetchImpl });
  assert.equal(result.ok, 1);
  assert.equal(result.mismatch.length, 0);
  assert.deepEqual(
    fetchImpl.calls.map((c) => c.method),
    ['HEAD', 'GET'],
  );
  assert.equal(fetchImpl.calls[1].range, 'bytes=0-0');
});

test('when neither response yields a size the URL is unresolved, not failed', async () => {
  const url = 'https://cdn.test/mystery.bin';
  const fetchImpl = fakeFetch({ [url]: { length: 0 } });
  const result = await verifyUrls([url], { fetchImpl });
  assert.deepEqual(result.unresolved, [{ url }]);
  assert.equal(result.mismatch.length, 0);
  assert.ok(passes(result));
});

test('a transient error is retried and then recorded as unreachable', async () => {
  const url = 'https://cdn.test/flaky.png';
  const fetchImpl = fakeFetch({ [url]: new Error('socket hang up') });
  const result = await verifyUrls([url], { fetchImpl, attempts: 2, retryConcurrency: 1 });
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /socket hang up/);
  assert.ok(!passes(result));
});

// A single runner asking for thousands of URLs at once is what a CDN throttles; a connection
// error is not evidence the object is missing, so leftovers get one slow second pass.
test('a URL that only fails under load is recovered by the quiet second pass', async () => {
  const url = 'https://cdn.test/throttled.png';
  let calls = 0;
  const fetchImpl = async (u, init = {}) => {
    calls++;
    if (calls <= 2) throw new Error('ECONNRESET'); // both attempts of the first pass
    return new Response(init.method === 'GET' ? 'x' : null, {
      status: 200,
      headers: { 'content-length': '42' },
    });
  };
  const result = await verifyUrls([url], { fetchImpl, attempts: 2, expected: { [url]: 42 }, retryConcurrency: 1 });
  assert.equal(result.failed.length, 0);
  assert.equal(result.ok, 1);
  assert.ok(passes(result));
  assert.equal(calls, 3);
});

test('the summary reports every bucket', () => {
  const text = summarizeVerification({
    probed: 3,
    ok: 1,
    missing: [{ url: 'https://cdn.test/m', status: 404 }],
    mismatch: [{ url: 'https://cdn.test/x', expected: 1, got: 2 }],
    failed: [],
    unresolved: [{ url: 'https://cdn.test/u' }],
  });
  assert.match(text, /probed 3 URLs/);
  assert.match(text, /size-unresolved 1/);
  assert.match(text, /404 https:\/\/cdn\.test\/m/);
});
