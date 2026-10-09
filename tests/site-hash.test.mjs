import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hashReferences } from '../src/site-hash.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-site-'));
  fs.mkdirSync(path.join(dir, 'js'));
  fs.mkdirSync(path.join(dir, 'css'));
  fs.writeFileSync(path.join(dir, 'js', 'app.js'), 'console.log(1);');
  fs.writeFileSync(path.join(dir, 'css', 'app.css'), 'body{}');
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<link rel="stylesheet" href="./css/app.css?v=3" /><script src="./js/app.js?v=7"></script>',
  );
  return dir;
}

test('rewrites references to content-hashed filenames and renames the files', () => {
  const dir = fixture();
  const renamed = hashReferences(dir, { log: () => {} });
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

  assert.equal(renamed.length, 2);
  assert.match(html, /\.\/css\/app\.[0-9a-f]{8}\.css/);
  assert.match(html, /\.\/js\/app\.[0-9a-f]{8}\.js/);
  // the old paths are gone, so nothing can serve a stale copy under them
  assert.ok(!fs.existsSync(path.join(dir, 'js', 'app.js')));
  assert.ok(!fs.existsSync(path.join(dir, 'css', 'app.css')));
  for (const match of html.matchAll(/\.\/(?:js|css)\/([A-Za-z0-9_.-]+)/g)) {
    assert.ok(fs.existsSync(path.join(dir, match[0].slice(2))), match[0]);
  }
});

test('the hash is stable for unchanged content and moves when it changes', () => {
  const nameOf = (dir) => fs.readdirSync(path.join(dir, 'js'))[0];

  const first = fixture();
  hashReferences(first, { log: () => {} });
  const before = nameOf(first);

  // Same bytes in a fresh tree must produce the same name, so a redeploy of unchanged files
  // keeps serving the same URLs.
  const same = fixture();
  hashReferences(same, { log: () => {} });
  assert.equal(nameOf(same), before);

  // Different bytes must produce a different name — that is the whole point, since this zone
  // ignores the query string when caching /js/*.
  const changed = fixture();
  fs.writeFileSync(path.join(changed, 'js', 'app.js'), 'console.log(2);');
  hashReferences(changed, { log: () => {} });
  assert.notEqual(nameOf(changed), before);
});

test('rewrites every page, not just index.html', () => {
  const dir = fixture();
  // A second page with its own link to the same stylesheet: this is the case that broke
  // /bandwidth, which kept href="./css/cdn.css" and was served the SPA fallback as CSS.
  fs.writeFileSync(path.join(dir, 'guide.html'), '<link rel="stylesheet" href="./css/app.css" />');

  hashReferences(dir, { log: () => {} });

  const guide = fs.readFileSync(path.join(dir, 'guide.html'), 'utf8');
  assert.match(guide, /\.\/css\/app\.[0-9a-f]{8}\.css/);
  assert.doesNotMatch(guide, /href="\.\/css\/app\.css"/);

  // the rewritten name must actually exist, or Pages falls back to HTML for it
  for (const page of ['index.html', 'guide.html']) {
    const html = fs.readFileSync(path.join(dir, page), 'utf8');
    for (const match of html.matchAll(/\.\/(?:js|css)\/([A-Za-z0-9_.-]+)/g)) {
      assert.ok(fs.existsSync(path.join(dir, match[0].slice(2))), `${page}: ${match[0]}`);
    }
    assert.equal(fs.readdirSync(path.join(dir, 'css')).length, 1, `${page}: unhashed copy left behind`);
  }
});

test('two pages sharing one asset both get the hashed name', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'a.html'), '<link rel="stylesheet" href="./css/app.css" />');
  fs.writeFileSync(path.join(dir, 'b.html'), '<link rel="stylesheet" href="./css/app.css" />');

  hashReferences(dir, { log: () => {} });

  const name = (p) => fs.readFileSync(path.join(dir, p), 'utf8').match(/\.\/css\/([A-Za-z0-9_.-]+\.css)/)[1];
  assert.equal(name('a.html'), name('b.html'));
  assert.match(name('a.html'), /^app\.[0-9a-f]{8}\.css$/);
  // the shared rename must not leave either page pointing at a deleted file
  assert.ok(fs.existsSync(path.join(dir, 'css', name('a.html'))));
  assert.ok(fs.existsSync(path.join(dir, 'css', name('b.html'))));
});

test('leaves references to files that are not there alone', () => {
  const dir = fixture();
  hashReferences(dir, { log: () => {} });
  const after = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.deepEqual(hashReferences(dir, { log: () => {} }), []);
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), after);
});

test('leaves references to files that are not there alone', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'index.html'), '<script src="./js/missing.js?v=1"></script>');
  assert.deepEqual(hashReferences(dir, { log: () => {} }), []);
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<script src="./js/missing.js?v=1"></script>');
});
