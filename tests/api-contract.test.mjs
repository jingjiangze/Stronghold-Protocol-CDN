import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { API_ENDPOINTS, API_SCHEMA, buildApiDoc } from '../src/api-contract.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

test('the document is valid JSON and stamps the base and token', () => {
  const doc = JSON.parse(buildApiDoc({ base: 'https://cdn.test/', token: 'v1-abcdef12' }));
  assert.equal(doc.schema, API_SCHEMA);
  assert.equal(doc.base, 'https://cdn.test', 'a trailing slash must be trimmed');
  assert.equal(doc.token, 'v1-abcdef12');
  assert.ok(doc.endpoints.length >= 8);
  // Every endpoint carries a resolvable absolute url, so a consumer never has to join strings.
  for (const e of doc.endpoints) {
    assert.ok(e.url.startsWith('https://cdn.test/'), e.path);
    assert.ok(e.what && e.what.length > 5, `${e.path} needs a description`);
    assert.ok(e.contentType && e.cache, `${e.path} needs a type and a cache policy`);
  }
});

// The table is authored (it is the contract), so it can drift from what the sync writes. This is the
// check that keeps the promise honest: every interface key the sync publishes must be listed.
test('every key the sync publishes is described', () => {
  const sync = fs.readFileSync(path.join(ROOT, 'src', 'sync.mjs'), 'utf8');
  const listed = new Set(API_ENDPOINTS.map((e) => e.path));
  const published = [...sync.matchAll(/putObject\(\s*config,\s*'([^']+)'/g)].map((m) => m[1]);
  const missing = [...new Set(published)].filter((k) => !listed.has('/' + k) && !listed.has('/' + k.replace(/-(?:\$\{[^}]+\}|<[^>]+>)/, '-<token>')));
  assert.deepEqual(missing, [], `the contract does not describe: ${missing.join(', ')}`);
});

// The base is described as the one API domain, and the mirrors are explicitly not it.
test('the document states that the interface has a single domain', () => {
  const doc = JSON.parse(buildApiDoc({ base: 'https://cdn.test', token: 't' }));
  assert.match(doc._how, /只有一个域名/, 'the single-domain rule must be stated, not implied');
  assert.match(doc._how, /素材镜像/, 'and the mirrors must be distinguished from it');
});
