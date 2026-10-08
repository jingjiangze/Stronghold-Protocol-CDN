import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readSources, findSourceLayout, sourceReleaseUrl } from '../src/sources.mjs';

function fixture(sources) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-src-'));
  fs.writeFileSync(path.join(root, 'sources.json'), JSON.stringify({ sources }));
  return root;
}

test('reads the declared sources and drops entries that cannot work', () => {
  const root = fixture([
    { id: 'fusion', repo: 'Paper-Yuan/Stronghold-Protocol', ref: 'feature/x', release: 'v1', package: 'a.zip', note: 'n' },
    { id: '', repo: 'x/y', package: 'a.zip' },
    { id: 'no-package', repo: 'x/y' },
    { id: 'no-repo', package: 'a.zip' },
  ]);
  const sources = readSources(root);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, 'fusion');
  assert.equal(sources[0].manifest, 'data/assets.json', 'a missing manifest falls back to the default');
});

test('a missing or broken sources.json reads as no sources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-src-'));
  assert.deepEqual(readSources(root), []);
  fs.writeFileSync(path.join(root, 'sources.json'), '{ not json');
  assert.deepEqual(readSources(root), []);
});

test('the release url is built and validated', () => {
  assert.equal(
    sourceReleaseUrl({ repo: 'a/b', release: 'v1' }),
    'https://github.com/a/b/releases/tag/v1',
  );
});

test('finds the package layout without assuming the top folder name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-src-'));
  const top = path.join(root, 'Stronghold-Protocol-whatever');
  fs.mkdirSync(path.join(top, 'public', 'assets', 'char'), { recursive: true });
  fs.mkdirSync(path.join(top, 'data'), { recursive: true });
  fs.writeFileSync(path.join(top, 'data', 'assets.json'), '{}');
  const layout = findSourceLayout(root);
  assert.equal(layout.top, top);
  assert.ok(layout.assets.endsWith(path.join('public', 'assets')));
  assert.ok(layout.manifest.endsWith(path.join('data', 'assets.json')));
});

test('no assets directory means no layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-src-'));
  fs.mkdirSync(path.join(root, 'Stronghold-Protocol', 'server'), { recursive: true });
  assert.equal(findSourceLayout(root), null);
});
