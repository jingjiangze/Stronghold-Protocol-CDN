import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseNetworkTable, NETWORK_TABLE } from '../src/network-table.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const text = fs.readFileSync(path.join(ROOT, NETWORK_TABLE), 'utf8');

test('the shipped network table is valid', () => {
  const doc = parseNetworkTable(text);
  assert.ok(doc.sources.length >= 4, 'a table with almost nothing in it is not evidence');
  assert.match(doc.measuredAt, /^\d{4}-\d{2}-\d{2}$/);
});

// The table is the only place that says a source must not be used at runtime. If an exclusion named
// a source that is not listed (or vice versa) the page would show a mirror as available while the
// table says otherwise, so the two lists have to stay consistent with each other.
test('every exclusion names a listed source, and the default order avoids them', () => {
  const doc = parseNetworkTable(text);
  const excluded = new Set(doc.excluded.map((e) => e.id));
  for (const ex of doc.excluded) {
    assert.ok(doc.sources.some((s) => s.id === ex.id), `excluded ${ex.id} is not in sources`);
    assert.ok(ex.reason && ex.reason.length > 10, `excluded ${ex.id} needs a real reason`);
  }
  for (const id of doc.defaultOrderHint) assert.ok(!excluded.has(id), `default order must not start on excluded ${id}`);
});

// Every source must be measurable by a client, otherwise listing it is pointless.
test('every source carries a probe path a client can fetch', () => {
  const doc = parseNetworkTable(text);
  for (const s of doc.sources) {
    assert.ok(s.probe.startsWith('/'), `${s.id}: probe must be a path`);
    assert.ok(s.host && !s.host.includes('/'), `${s.id}: host must be a bare hostname`);
  }
});

test('a malformed table is rejected instead of being published', () => {
  assert.throws(() => parseNetworkTable('not json'), /not valid JSON/);
  assert.throws(() => parseNetworkTable('{}'), /measuredAt/);
  assert.throws(() => parseNetworkTable(JSON.stringify({ measuredAt: '2026-10-09', sources: [] })), /non-empty sources/);
  assert.throws(
    () => parseNetworkTable(JSON.stringify({ measuredAt: '2026-10-09', sources: [{ id: 'a', host: 'a.test', probe: 'nope' }] })),
    /probe path starting with/,
  );
  assert.throws(
    () => parseNetworkTable(JSON.stringify({ measuredAt: '2026-10-09', sources: [{ id: 'a', host: 'a.test', probe: '/x' }, { id: 'a', host: 'b.test', probe: '/x' }] })),
    /duplicate source id/,
  );
  // An exclusion for something not listed is a stale edit, not a valid state.
  assert.throws(
    () => parseNetworkTable(JSON.stringify({ measuredAt: '2026-10-09', sources: [{ id: 'a', host: 'a.test', probe: '/x' }], excluded: [{ id: 'ghost', reason: 'gone forever' }] })),
    /not one of the sources/,
  );
  // Seeding a client from an excluded source would contradict the same file.
  assert.throws(
    () => parseNetworkTable(JSON.stringify({ measuredAt: '2026-10-09', sources: [{ id: 'a', host: 'a.test', probe: '/x' }], excluded: [{ id: 'a', reason: 'fails 40% of the time' }], defaultOrderHint: ['a'] })),
    /names excluded source/,
  );
});
