import test from 'node:test';
import assert from 'node:assert/strict';

import { pickFastest } from '../src/pick.js';

// A fake fetch whose latency is set per host, so a test can make a parked mirror the fastest and
// still assert it is not chosen. `body` defaults to a non-empty buffer; content-length is declared
// to match so the truncation guard in pick.js does not reject it.
function fakeFetch(latencyByHost, { status = 200 } = {}) {
  const body = new TextEncoder().encode('ok').buffer;
  return async (url) => {
    const host = new URL(url).host;
    const ms = latencyByHost[host] ?? 1000;
    await new Promise((r) => setTimeout(r, ms));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(body.byteLength) : null) },
      arrayBuffer: async () => body,
    };
  };
}

test('a parked origin (enabled:false) is never measured or chosen, even when it is the fastest', async () => {
  const mirrors = [
    { id: 'parked', root: 'https://fast.example', probe: '/p.bin', enabled: false },
    { id: 'live', root: 'https://slow.example', probe: '/p.bin' },
  ];
  const { best, ranked } = await pickFastest(mirrors, { attempts: 1, fetchImpl: fakeFetch({ 'fast.example': 1, 'slow.example': 40 }) });
  assert.equal(best.id, 'live', 'the parked mirror must not win even though it is faster');
  assert.deepEqual(ranked.map((m) => m.id), ['live'], 'a parked mirror must not appear in the ranking at all');
});

test('requireEnabled:false measures every mirror, parked included', async () => {
  const mirrors = [
    { id: 'parked', root: 'https://fast.example', probe: '/p.bin', enabled: false },
    { id: 'live', root: 'https://slow.example', probe: '/p.bin' },
  ];
  const { best, ranked } = await pickFastest(mirrors, { attempts: 1, requireEnabled: false, fetchImpl: fakeFetch({ 'fast.example': 1, 'slow.example': 40 }) });
  assert.equal(best.id, 'parked');
  assert.equal(ranked.length, 2);
});

test('enabled:true and an absent flag are both selectable; only false is parked', async () => {
  const mirrors = [
    { id: 'on', root: 'https://on.example', probe: '/p.bin', enabled: true },
    { id: 'unset', root: 'https://unset.example', probe: '/p.bin' },
  ];
  const { ranked } = await pickFastest(mirrors, { attempts: 1, fetchImpl: fakeFetch({ 'on.example': 5, 'unset.example': 10 }) });
  assert.deepEqual(ranked.map((m) => m.id).sort(), ['on', 'unset']);
});

test('every mirror parked is a hard error, not a silent empty pick', async () => {
  const mirrors = [{ id: 'a', root: 'https://a.example', probe: '/p.bin', enabled: false }];
  await assert.rejects(() => pickFastest(mirrors, { attempts: 1, fetchImpl: fakeFetch({ 'a.example': 1 }) }), /no enabled mirror/);
});
