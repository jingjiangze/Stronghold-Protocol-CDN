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

// The manifest block exists to answer "does this git mount have the assets". If the column ever
// reads "是" for a member of the asset tree, the page is telling readers the opposite of the
// truth — the asset tree is not in git, so every git mount 404s on it.
test('the manifest block explains partial coverage instead of just labelling it', () => {
  const script = fs.readFileSync(path.join(ROOT, 'site', 'js', 'cdn.js'), 'utf8');

  assert.ok(/id="manifest"/.test(html), 'the manifest block is missing from the page');
  assert.ok(/function renderManifest/.test(script), 'renderManifest is missing');
  assert.ok(/renderManifest\(/.test(script), 'renderManifest is never called');

  // The git-mount column must be generated, not typed per row: a hand-written row would survive
  // a future directory being added, and then quietly say the wrong thing about it.
  const render = script.slice(script.indexOf('function renderManifest'));
  const table = render.slice(0, render.indexOf('const gitB'));
  assert.match(table, /<td class="num">否<\/td>/, 'the git-mount column must render 否 for every row');

  // The explanation must quantify the gap, not just assert it, and must not hide it behind
  // setText (which would render the <b> tags as literal text).
  assert.match(render, /innerHTML/, 'the lead uses innerHTML so its emphasis actually renders');
  assert.match(render, /pct\.toFixed\(2\)/, 'the lead states what share of the bytes a git mount holds');
  assert.match(render, /不存在/, "the lead says the bytes are absent, not merely 'not yet synced'");
});
