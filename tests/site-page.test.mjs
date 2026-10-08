import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8');

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

// A duplicate id is not a style nit: getElementById returns the first match, so the page script
// can end up rewriting the wrong element — which is exactly how the section anchor "mirrors"
// collided with the cards container and made the script wipe the section it lived in.
test('no duplicate element ids in the site page', () => {
  const seen = new Set();
  const duplicates = [];
  for (const id of ids) {
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  }
  assert.deepEqual(duplicates, [], `duplicate ids: ${duplicates.join(', ')}`);
});

test('every id the page script looks up exists in the page', () => {
  const script = fs.readFileSync(path.join(ROOT, 'site', 'js', 'cdn.js'), 'utf8');
  const looked = [...script.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(looked)].filter((id) => !ids.includes(id));
  assert.deepEqual(missing, [], `the script looks up ids that are not in the page: ${missing.join(', ')}`);
});

test('every anchor in the navigation points at a section that exists', () => {
  const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(anchors.length >= 5, 'expected the section navigation to be present');
  for (const anchor of anchors) {
    assert.ok(ids.includes(anchor), `#${anchor} has no matching id`);
  }
});
