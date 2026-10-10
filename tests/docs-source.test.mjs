import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDocsDoc, DOCS_SOURCE_PATH, UPSTREAM_DOCS_PREFIX } from '../src/docs-source.mjs';

const files = {
  'assets/spine/op/char_1016_agoat2/front/x.skel': { size: 100, sha256: 'aa' },
  'docs/PLAYING.md': { size: 78901, sha256: 'bb' },
  'docs/DEPLOY.md': { size: 33000, sha256: 'cc' },
  'docs/research/03-operators.json': { size: 1500000, sha256: 'dd' },
  'fonts/bender.woff2': { size: 20000, sha256: 'ee' },
};

test('the docs index is a filtered view of the release index', () => {
  const doc = buildDocsDoc({ files, token: 'v0.2.3-abc', upstream: { repo: 'sganggs/Stronghold-Protocol', tag: 'v0.2.3' } });
  assert.equal(doc.count, 3, 'only docs/ entries');
  assert.deepEqual(doc.docs.map((d) => d.path), ['docs/DEPLOY.md', 'docs/PLAYING.md', 'docs/research/03-operators.json'], 'sorted, path-stable');
  assert.equal(doc.bytes, 33000 + 78901 + 1500000);
  assert.equal(doc.token, 'v0.2.3-abc', 'the token is what tells one release from the next');
  assert.equal(doc.upstream.tag, 'v0.2.3');
  // Every entry carries what a reader needs to verify the bytes it fetches.
  for (const d of doc.docs) {
    assert.ok(d.sha256, `${d.path} needs a sha256`);
    assert.ok(d.size > 0, `${d.path} needs a size`);
  }
});

test('an entry with no sha256 or size degrades to empty rather than undefined', () => {
  const doc = buildDocsDoc({ files: { 'docs/x.md': {} }, token: 't' });
  assert.equal(doc.docs[0].sha256, '');
  assert.equal(doc.docs[0].size, 0);
});

test('a release with no docs produces an empty index, not a missing one', () => {
  const doc = buildDocsDoc({ files: { 'assets/a.png': { size: 1, sha256: 'x' } }, token: 't' });
  assert.equal(doc.count, 0);
  assert.deepEqual(doc.docs, []);
  assert.equal(doc.bytes, 0, 'a sum over nothing is 0, not NaN');
});

test('no input at all is still a valid document', () => {
  const doc = buildDocsDoc();
  assert.equal(doc.schema, 1);
  assert.deepEqual(doc.docs, []);
  assert.equal(doc.token, '');
});

test('the note says how to get the CURRENT copy, because that is the whole point', () => {
  const doc = buildDocsDoc({ files });
  // The two facts a reader must not have to re-derive: the token rule, and that only R2/Pages has it.
  assert.match(doc.note, /\?v=<token>/);
  assert.match(doc.note, /R2 \/ Pages/);
});

test('the published path and prefix are the ones the rest of the interface uses', () => {
  assert.equal(DOCS_SOURCE_PATH, 'cdn/v1/docs.json');
  assert.equal(UPSTREAM_DOCS_PREFIX, 'docs/');
});
