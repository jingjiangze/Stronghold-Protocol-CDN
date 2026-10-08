import test from 'node:test';
import assert from 'node:assert/strict';

import { safePath, hasTraversal, rawPathOf, isAssetTree } from '../worker/git-mount-relay.worker.mjs';

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

// The asset tree is not in git, so the relay must refuse it outright instead of forwarding a
// request that every backend will 404 -- measured, not assumed (see audit §19.2).
test('the asset tree is refused with an explanation, not forwarded', () => {
  assert.equal(isAssetTree('/assets/char/avatar/char_003_kalts.png'), true);
  assert.equal(isAssetTree('/fonts/1.woff2'), true);
  assert.equal(isAssetTree('/assets/'), true);
  assert.equal(isAssetTree('/assets'), true);
  // A sibling path must still be served: refusing '/assets-x/' would be a silent outage.
  assert.equal(isAssetTree('/assets-x/a.png'), false);
  assert.equal(isAssetTree('/probe/cdn-probe.bin'), false);
  assert.equal(isAssetTree('/README.md'), false);
});
