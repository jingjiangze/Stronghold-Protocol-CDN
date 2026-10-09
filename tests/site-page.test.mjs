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

// The manifest block exists to answer "does this git mount have the assets". It must read "是"
// now that the tree is committed, and the explanation has to say why it used to read "否" —
// otherwise the page still tells readers the opposite of the truth about the same sources.
test('the manifest block explains partial coverage instead of just labelling it', () => {
  const script = fs.readFileSync(path.join(ROOT, 'site', 'js', 'cdn.js'), 'utf8');

  assert.ok(/id="manifest"/.test(html), 'the manifest block is missing from the page');
  assert.ok(/function renderManifest/.test(script), 'renderManifest is missing');
  assert.ok(/renderManifest\(/.test(script), 'renderManifest is never called');

  // The git-mount column must be generated, not typed per row: a hand-written row would survive
  // a future directory being added, and then quietly say the wrong thing about it.
  const render = script.slice(script.indexOf('function renderManifest'));
  const table = render.slice(0, render.indexOf('const tag ='));
  assert.match(table, /<td class="num">是<\/td>/, 'the git-mount column must render 是 for every row');

  // The explanation must not hide behind setText (which renders <b> as literal text), and must
  // name the branch the assets now live on, since that is the whole answer.
  assert.match(render, /innerHTML/, 'the lead uses innerHTML so its emphasis actually renders');
  assert.match(render, /assets-raw/, 'the lead names the branch that now carries the asset tree');
});

// The page offers two downloads and the reader has to know which one is theirs. The distinguishing
// fact is whether they already run a deployment, so both labels and both button sets must exist --
// a single merged button would be wrong for one of the two audiences either way.
test('the page offers both downloads with the choice spelled out', () => {
  for (const id of ['dropin', 'official']) {
    assert.ok(new RegExp(`id="${id}-download"`).test(html), `missing the ${id} download button`);
    assert.ok(new RegExp(`id="${id}-name"`).test(html), `missing the ${id} file name`);
    assert.ok(new RegExp(`id="${id}-meta"`).test(html), `missing the ${id} size line`);
    assert.ok(new RegExp(`id="${id}-mirror"`).test(html), `missing the ${id} mirror link`);
  }
  // The two labels must state the situation, not just "A" and "B".
  assert.match(html, /已经有能跑的游戏服/, 'the first option must say who it is for');
  assert.match(html, /还没有游戏服/, 'the second option must say who it is for');

  // Both variants share one renderer, driven by a table whose patterns must stay disjoint: a single
  // pattern would let one button pick up the other's zip.
  const script = fs.readFileSync(path.join(ROOT, 'site', 'js', 'cdn.js'), 'utf8');
  assert.match(script, /const DOWNLOADS = \[/, 'the variants must be driven by one table');
  assert.match(script, /stronghold-official-cdn/, 'the variant pattern must be present');
  assert.match(script, /function renderDownloads\(/, 'both must render through one function');
  assert.match(script, /renderDownloads\(snapshot\)/, 'renderDownloads must be called');
});
