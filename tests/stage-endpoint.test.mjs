// The staging-only endpoint behind /stage.
//
// It exists to answer one question cheaply ("what bytes are waiting?"), where /api/cdn/upload/status
// answers three and charges for all of them: every claim.json fetched, the publish log, the removal
// queue. The assertions below pin both halves — that it answers the question, and that it does not
// quietly grow the extra payload back, because the whole point is that an agent can poll it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onRequestGet } from '../functions/api/cdn/upload/stage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://downcdn.example.test';
const KEY = 'k'.repeat(32);

// What the staging listing looks like: one group with a claim, one that only uploaded bytes.
const LISTING = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Contents><Key>cdn/incoming/aaaaaaaaaaaaaaaa/packs/sp-four/a.skel</Key><Size>2048</Size></Contents>
  <Contents><Key>cdn/incoming/aaaaaaaaaaaaaaaa/claim.json</Key><Size>300</Size></Contents>
  <Contents><Key>cdn/incoming/bbbbbbbbbbbbbbbb/packs/sp-four/b.skel</Key><Size>64</Size></Contents>
</ListBucketResult>`;

const CLAIM = {
  schema: 1,
  key: 'packs/sp-four/a.skel',
  size: 2048,
  sha256: 'f'.repeat(64),
  source: 'sp-four',
  what: '四号竞技场骨骼动画补件',
  state: 'verified-at-edge',
  claimedAt: '2026-10-15T10:00:00.000Z',
};

const calls = [];
const s3 = (url, init) => {
  calls.push({ url: String(url), method: init && init.method });
  const u = String(url);
  if (init && init.method === 'GET' && u.includes('list-type=2')) {
    return Promise.resolve(new Response(LISTING, { status: 200 }));
  }
  if (u.endsWith('/cdn/incoming/aaaaaaaaaaaaaaaa/claim.json')) {
    return Promise.resolve(new Response(JSON.stringify(CLAIM), { status: 200 }));
  }
  return Promise.resolve(new Response('not found', { status: 404 }));
};

const env = {
  ADMIN_UPLOAD_KEY: KEY,
  R2_ENDPOINT: 'https://r2.example.test',
  R2_ACCESS_KEY_ID: 'id',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'bucket',
};

const call = ({ key = KEY, origin = ORIGIN, headers = {} } = {}) => {
  calls.length = 0;
  globalThis.fetch = s3;
  return onRequestGet({
    request: new Request(`${ORIGIN}/api/cdn/upload/stage`, {
      headers: { ...(origin ? { origin } : {}), ...(key ? { 'x-admin-key': key } : {}), ...headers },
    }),
    env,
  });
};

test('it lists every staging group with the state that decides its fate', async () => {
  const res = await call();
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.equal(doc.ok, true);

  const claimed = doc.staging.find((i) => i.id === 'aaaaaaaaaaaaaaaa');
  assert.equal(claimed.state, 'verified-at-edge');
  assert.equal(claimed.key, 'packs/sp-four/a.skel', 'the target key is what a reader has to see');
  assert.equal(claimed.sha256, 'f'.repeat(64));
  assert.equal(claimed.source, 'sp-four');

  // The byte-only group is not silently dropped: "uploaded but never committed" is exactly the
  // state that looks like a stuck upload, so it must appear with a reason and no key.
  const bare = doc.staging.find((i) => i.id === 'bbbbbbbbbbbbbbbb');
  assert.equal(bare.state, 'awaiting-commit');
  // undefined as well as null: this field must simply not carry a key, and JSON drops undefined.
  assert.ok(bare.key == null, 'a group without a claim must not carry a target key');
  assert.match(bare.reason, /claim/);

  assert.equal(doc.pending, 1);
  assert.equal(doc.awaitingCommit, 1);
  assert.equal(doc.bytes, 2048 + 64);
});

test('it does not fetch the publish log or the removal queue', async () => {
  await call();
  const urls = calls.map((c) => c.url);
  // The whole reason this endpoint exists: status answers these, stage must not.
  assert.ok(
    !urls.some((u) => u.includes('cdn/v1/upload-log.json')),
    'the staging view must not read the publish log',
  );
  assert.ok(
    !urls.some((u) => u.includes('cdn/removals/')),
    'the staging view must not read the removal queue',
  );
  // One listing plus the claims that exist — no more.
  assert.equal(calls.length, 2, `unexpected calls: ${urls.join(', ')}`);
});

test('without a valid key nothing is handed out', async () => {
  const missing = await call({ key: '' });
  assert.equal(missing.status, 401);
  assert.match((await missing.json()).error, /缺少 x-admin-key/);

  const wrong = await call({ headers: { 'x-admin-key': 'x'.repeat(32) } });
  assert.equal(wrong.status, 401);
  assert.match((await wrong.json()).error, /口令不对/);
});

test('a cross-origin caller is refused before any bucket access', async () => {
  const res = await call({ origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /同源/);
  // Nothing was asked of the bucket: the refusal has to happen before the work, not after it.
  assert.equal(calls.length, 0);
});

// The key can read uploader key names and sources, so the response must never be cached by a
// shared cache, and must not be reachable by a crawler that finds the URL.
test('the response is private and unindexed', async () => {
  const res = await call();
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  assert.match(res.headers.get('x-robots-tag') || '', /noindex/i);
});

// A misconfigured deploy has to say so in words, not return an empty list that reads as "empty
// staging" — that is the difference between "nothing is waiting" and "we cannot see".
test('a missing R2 configuration is reported as an error, not as an empty staging', async () => {
  calls.length = 0;
  globalThis.fetch = s3;
  const res = await onRequestGet({
    request: new Request(`${ORIGIN}/api/cdn/upload/stage`, { headers: { origin: ORIGIN, 'x-admin-key': KEY } }),
    env: { ADMIN_UPLOAD_KEY: KEY },
  });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /R2/);
  // It must not have touched the bucket on the way to failing: an empty list would read as
  // "nothing is waiting", which is a different and much more dangerous answer.
  assert.equal(calls.length, 0);
});

test('the endpoint file lives under the routed upload prefix', () => {
  const routes = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', '_routes.json'), 'utf8'));
  assert.ok(
    (routes.include || []).some((p) => '/api/cdn/upload/stage'.startsWith(p.replace('*', ''))),
    'the endpoint path must be covered by _routes.json, or Pages answers 404 before the Function runs',
  );
});
