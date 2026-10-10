// The endpoint that hands out the integration instructions with the key in them.
//
// This is the path where a silent failure costs the most: a copy that looks complete but carries an
// empty key makes an agent fail somewhere else, with an error that never mentions the copy. So the
// test drives the real handler with a fake asset binding and a fake request rather than asserting on
// source text.
import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet } from '../functions/api/cdn/upload/agent-doc.js';

const ORIGIN = 'https://downcdn.example.test';
const KEY = 'k'.repeat(32);

const INDEX = {
  schema: 1,
  generatedAt: '2026-10-10T10:00:00.000Z',
  docs: [
    { path: 'docs/bandwidth.md', updatedAt: '2026-10-10T18:00:00Z', agent: false },
    { path: 'docs/agent-upload.md', updatedAt: '2026-10-10T02:00:00Z', agent: true },
  ],
  agentDoc: 'docs/agent-upload.md',
  agentDocWhy: '所有文档里提到 /api/cdn/upload/ 的最新一份',
};

const DOC_TEXT = '# agent 接入\n\n接口鉴权   请求头 x-admin-key: <直连后台密钥>\n';

/** Minimal stand-in for the Pages static-assets binding. */
const assetsFor = (files) => ({
  fetch: async (req) => {
    const p = new URL(typeof req === 'string' ? req : req.url).pathname;
    if (!(p in files)) return new Response('not found', { status: 404 });
    return new Response(files[p], { status: 200, headers: { 'content-type': 'text/plain' } });
  },
});

const files = {
  '/data/docs.json': JSON.stringify(INDEX),
  '/docs/agent-upload.md': DOC_TEXT,
};

const call = ({ key = KEY, origin = ORIGIN, headers = {}, env = {} } = {}) =>
  onRequestGet({
    request: new Request(`${ORIGIN}/api/cdn/upload/agent-doc`, {
      headers: {
        ...(origin ? { origin } : {}),
        ...(key ? { 'x-admin-key': key } : {}),
        ...headers,
      },
    }),
    env: { ADMIN_UPLOAD_KEY: KEY, ASSETS: assetsFor(files), ...env },
  });

test('it returns the newest integration document with the key substituted', async () => {
  const res = await call();
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.equal(doc.ok, true);
  assert.equal(doc.path, 'docs/agent-upload.md', 'must not pick the newer non-integration doc');
  assert.equal(doc.injected, true);
  assert.match(doc.text, new RegExp(`x-admin-key: ${KEY}`));
  assert.ok(!doc.text.includes('<直连后台密钥>'), 'the placeholder must not survive');
  assert.match(doc.why, /最新/);
  // The response carries the key, so it must never be cached.
  assert.match(res.headers.get('cache-control') || '', /no-store/);
});

test('the key it injects is the one this caller presented', async () => {
  const other = 'z'.repeat(32);
  const res = await onRequestGet({
    request: new Request(`${ORIGIN}/api/cdn/upload/agent-doc`, { headers: { origin: ORIGIN, 'x-admin-key': other } }),
    env: { ADMIN_UPLOAD_KEY: other, ASSETS: assetsFor(files) },
  });
  const doc = await res.json();
  assert.match(doc.text, new RegExp(other));
  assert.ok(!doc.text.includes(KEY));
});

test('without a valid key nothing is handed out', async () => {
  const missing = await call({ key: '' });
  assert.equal(missing.status, 401);
  assert.match((await missing.json()).error, /缺少 x-admin-key/);

  const wrong = await call({ key: 'x'.repeat(32) });
  assert.equal(wrong.status, 401);
  assert.match((await wrong.json()).error, /口令不对/);

  const unconfigured = await call({ env: { ADMIN_UPLOAD_KEY: '' } });
  assert.equal(unconfigured.status, 401);
});

test('a cross-origin caller is refused before any work happens', async () => {
  const res = await call({ origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /同源/);
});

test('a missing index or document is reported, not papered over', async () => {
  const noIndex = await call({ env: { ASSETS: assetsFor({ '/docs/agent-upload.md': DOC_TEXT }) } });
  assert.equal(noIndex.status, 502);
  assert.match((await noIndex.json()).error, /site-data\.mjs/);

  const noDoc = await call({ env: { ASSETS: assetsFor({ '/data/docs.json': JSON.stringify(INDEX) }) } });
  assert.equal(noDoc.status, 502);
  assert.match((await noDoc.json()).error, /agent-upload\.md/);
});

// If the index has no picked document (hand-edited, or an older deploy), the rule is applied from
// the list rather than the field — the endpoint should still answer correctly.
test('a hand-edited index still resolves the integration document', async () => {
  const res = await call({
    env: { ASSETS: assetsFor({ ...files, '/data/docs.json': JSON.stringify({ ...INDEX, agentDoc: '', agentDocWhy: '' }) }) },
  });
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.equal(doc.path, 'docs/agent-upload.md');
});
