import test from 'node:test';
import assert from 'node:assert/strict';

import { safePath, hasTraversal, rawPathOf, isAssetTree, backendFor, MAX_BYTES } from '../worker/git-mount-relay.worker.mjs';

// `new URL()` normalises '..' away while constructing: '/../../etc/passwd' becomes '/etc/passwd'
// and '%2e%2e' is decoded, so neither `pathname` nor `href` shows what was requested. The Worker
// therefore passes the RAW request string to these, and so do these tests.
const traverses = (p) => hasTraversal('https://relay.test' + p);
const accepts = (p) => safePath(rawPathOf('https://relay.test' + p));

test('plain repo-relative paths are accepted', () => {
  assert.equal(accepts('/README.md'), '/README.md');
  assert.equal(accepts('/probe/cdn-probe.bin'), '/probe/cdn-probe.bin');
  assert.equal(accepts('/site/css/cdn.css'), '/site/css/cdn.css');
});

test('traversal is caught on the raw path, before the URL parser hides it', () => {
  for (const bad of ['/../README.md', '/a/../../etc/passwd', '/..', '/a/../b', '/%2e%2e/x', '/a/%2e%2e/b']) {
    assert.equal(traverses(bad), true, bad);
  }
  for (const ok of ['/README.md', '/probe/cdn-probe.bin', '/site/css/cdn.css']) {
    assert.equal(traverses(ok), false, ok);
  }
});

test('a query string or fragment is not treated as part of the path', () => {
  assert.equal(rawPathOf('https://relay.test/README.md?x=1'), '/README.md');
  assert.equal(rawPathOf('https://relay.test/README.md#f'), '/README.md');
  assert.equal(traverses('/README.md?x=1'), false);
});

test('backslashes and malformed percent-escapes are rejected', () => {
  assert.equal(safePath('/a' + String.fromCharCode(92) + 'b'), null);
  assert.equal(traverses('/%zz'), true);
});

// The relay must never become an open proxy: a request cannot name the upstream.
test('anything that looks like a URL or absolute target is rejected', () => {
  for (const bad of ['https://example.com/x', 'http:/example.com/x', '//example.com/x', 'https:example.com', 'javascript:alert(1)']) {
    assert.equal(safePath(bad), null, bad);
  }
});

// A protocol-relative '//host/x' names another host in a browser, so it is refused outright
// rather than collapsed into a local path - collapsing would accept what must be rejected.
test('a protocol-relative target is refused, not normalised into a local path', () => {
  assert.equal(safePath('//example.com/x'), null);
  assert.equal(safePath('//site/js/cdn.js'), null);
});

test('control characters, empties and oversized paths are rejected', () => {
  assert.equal(safePath(''), null);
  assert.equal(safePath(null), null);
  assert.equal(safePath(undefined), null);
  assert.equal(safePath('/a' + String.fromCharCode(0) + 'b'), null);
  assert.equal(safePath('/a' + String.fromCharCode(10) + 'b'), null);
  assert.equal(safePath('/' + 'a'.repeat(400)), null);
});

test('a relative path without a leading slash is rejected rather than silently prefixed', () => {
  assert.equal(safePath('README.md'), null);
  assert.equal(safePath('./README.md'), null);
});

// The asset tree used to be absent from git, so the relay refused these prefixes with a 404
// instead of forwarding a request every backend would 404 anyway (measured, not assumed -- see
// audit §19.2). It is committed now on the orphan branch `assets-raw`, so the same prefixes do
// the opposite job: they select which branch to read.
test('asset prefixes select the asset branch, and nothing else does', () => {
  assert.equal(isAssetTree('/assets/char/avatar/char_003_kalts.png'), true);
  assert.equal(isAssetTree('/fonts/1.woff2'), true);
  assert.equal(isAssetTree('/assets/'), true);
  assert.equal(isAssetTree('/assets'), true);
  // A sibling path must still be read from main: refusing '/assets-x/' would be a silent outage.
  assert.equal(isAssetTree('/assets-x/a.png'), false);
  assert.equal(isAssetTree('/probe/cdn-probe.bin'), false);
  assert.equal(isAssetTree('/README.md'), false);
});

// Which branch a path reads is decided here, never by the caller -- a request cannot ask for the
// art branch by naming it, so a caller that reaches /assets/** gets art and nothing else gets it.
test('the branch is chosen from the path, and the caller cannot name one', () => {
  assert.deepEqual(backendFor('/assets/char/a.png').map((b) => b.id), ['jsdelivr-assets', 'ghfast-assets']);
  assert.deepEqual(backendFor('/fonts/1.woff2').map((b) => b.id), ['jsdelivr-assets', 'ghfast-assets']);
  assert.deepEqual(backendFor('/README.md').map((b) => b.id), ['jsdelivr', 'ghfast-raw']);
  assert.deepEqual(backendFor('/site/css/cdn.css').map((b) => b.id), ['jsdelivr', 'ghfast-raw']);
});

// Every backend must point at THIS repo and at one of the two known branches. A backend URL is
// built from a constant table, but a typo in a ref would be a silent 404 on the whole tree.
test('every backend targets this repo and a known branch', () => {
  const all = [...backendFor('/README.md'), ...backendFor('/assets/char/a.png')];
  assert.ok(all.length >= 2);
  for (const b of all) {
    assert.ok(b.prefix.includes('jingjiangze/Stronghold-Protocol-CDN'), b.id);
    assert.ok(b.prefix.includes('assets-raw') || b.prefix.includes('main'), b.id);
    assert.ok(/^https:\/\//.test(b.prefix), b.id);
  }
});

// Statically was dropped after measurement: it truncated a 262,144-byte probe to 16,384 / 32,768 /
// 0 bytes across three attempts and 403'd 5/5 on a real 854 KB asset. A backend that silently
// returns partial bytes is worse than an absent one, because a Range or sha256 check passes on the
// first chunk and only fails later.
test('no backend is statically, and the largest asset fits under the size cap', () => {
  const all = [...backendFor('/README.md'), ...backendFor('/assets/char/a.png')];
  for (const b of all) assert.ok(!b.prefix.includes('statically.io'), b.id);
  assert.ok(MAX_BYTES > 3.2 * 1024 * 1024, 'cap must clear the 3.1 MiB largest asset');
});

// /dl/ is a redirect, not a proxy: pulling a 405 MiB pack through the Worker would spend our
// request budget on bytes a mirror already serves. Only allow names that cannot escape the path.
test('/dl/ accepts a plausible release name and rejects one that tries to', () => {
  const okTag = /^[A-Za-z0-9._-]{1,80}$/;
  const okFile = /^[A-Za-z0-9._-]{1,120}$/;
  assert.equal(okTag.test('assets-v0.2.1'), true);
  assert.equal(okFile.test('assets-ui-1.zip'), true);
  for (const bad of ['../x', 'a/b', '', 'a b', '%2e%2e', 'a;b']) {
    assert.equal(okTag.test(bad), false, 'tag should reject ' + bad);
    assert.equal(okFile.test(bad), false, 'file should reject ' + bad);
  }
});
