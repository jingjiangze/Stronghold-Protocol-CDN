// The official docs (`docs/**` from the release package) ride the same tree as the art.
//
// They are the game's own reference material — PLAYING.md, DEPLOY.md and the docs/research/*.json
// datasets — and they were reachable only from GitHub because the upstream server has no /docs/
// route. These tests pin the four things that make the mirror correct and easy to get wrong:
// the package extraction must actually include them, the bucket-ownership guard must allow them,
// the content type must make them render instead of download, and the pack channel must not grow a
// meaningless "docs" group.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  DOCS_PREFIX,
  OWNED_PREFIXES,
  ZIP_ASSETS_DIR,
  ZIP_DOCS_DIR,
  ZIP_FONTS_DIR,
  zipIncludePatterns,
} from '../src/names.mjs';
import { assertOwnedKey, mimeFor } from '../src/r2.mjs';
import { groupOf, planPacks } from '../src/packs.mjs';
import { localPathFor } from '../src/sync.mjs';

test('the selective extraction pulls the docs out of the package', () => {
  const patterns = zipIncludePatterns();
  assert.ok(
    patterns.includes(`${ZIP_DOCS_DIR}/*`),
    'the unzip include list must cover docs/, or the tree is hashed from a directory that is not there',
  );
  // They are read from the package, so the key prefix and the extraction path must agree.
  assert.equal(DOCS_PREFIX, 'docs/');
  assert.ok(ZIP_DOCS_DIR.endsWith('/docs'));
});

test('docs/ is a prefix this repository owns', () => {
  assert.ok(OWNED_PREFIXES.includes(DOCS_PREFIX));
  for (const key of ['docs/PLAYING.md', 'docs/research/03-operators.json']) {
    assert.doesNotThrow(() => assertOwnedKey(key), key);
  }
  // A near-miss must not sneak in: the guard is a prefix match, not a substring one.
  assert.throws(() => assertOwnedKey('docsx/PLAYING.md'), /refusing to write outside/);
});

// The whole point of mirroring the docs is that a phone can open them. `text/markdown` would be
// served with nosniff, which browsers treat as "not renderable" and download instead — a 200 that
// looks fine in a health check and is useless to a reader.
test('a markdown doc is served as renderable text, never as a download', () => {
  const type = mimeFor('docs/PLAYING.md');
  assert.equal(type, 'text/plain');
  assert.notEqual(type, 'text/markdown');
  assert.notEqual(type, 'application/octet-stream');
  assert.equal(mimeFor('docs/research/03-operators.json'), 'application/json');
});

test('the wiki datasets collapse into one docs directory row', () => {
  // The site's directory table is grouped by this, so the docs must land in exactly one row.
  assert.equal(groupOf('docs/PLAYING.md'), 'docs');
  assert.equal(groupOf('docs/research/03-operators.json'), 'docs');
});

// The mapping from an index key to a path in the extracted package has to agree with what the
// unzip actually created. A disagreement is invisible until the upload stage of a long run, where
// it shows up as a read error on a path nobody looks at.
test('every key maps to a path the extraction actually creates', () => {
  const stage = path.join('C:', 'stage');
  const patterns = zipIncludePatterns();
  for (const [key, dir] of [
    ['assets/char/avatar/a.png', ZIP_ASSETS_DIR],
    ['fonts/f.woff2', ZIP_FONTS_DIR],
    ['docs/PLAYING.md', ZIP_DOCS_DIR],
    ['docs/research/03-operators.json', ZIP_DOCS_DIR],
  ]) {
    const expected = path.join(stage, dir, key.slice(key.indexOf('/') + 1));
    assert.equal(localPathFor(stage, key), expected, key);
    assert.ok(patterns.includes(`${dir}/*`), `${dir} must be extracted, or ${key} is hashed from nothing`);
  }
  // An unknown prefix must fail loudly rather than resolve somewhere arbitrary.
  assert.throws(() => localPathFor(stage, 'server/index.js'), /no local source/);
});

test('the pack channel stays art-only', () => {
  const files = Object.fromEntries(
    [
      ['assets/char/avatar/a.png', 10],
      ['docs/PLAYING.md', 1000],
      ['docs/research/03-operators.json', 2000],
    ].map(([k, size]) => [k, { size, sha256: k }]),
  );
  const packs = planPacks(files, { maxBytes: 100000 });
  assert.deepEqual(packs.map((p) => p.id), ['assets-char-1']);
  assert.ok(
    !packs.some((p) => p.group === 'docs'),
    'docs must not get a pack group — they are a few files read individually, not a bulk channel',
  );
});
