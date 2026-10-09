import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { buildOfficialCdn, verifyOfficialCdn } from '../src/official-cdn.mjs';
import { editZip, readZipEntry, listZipEntries } from '../src/zip-edit.mjs';

// A lite-shaped package written by Python's zipfile (an independent writer): a MANIFEST.json that
// lists data/emotes.json but NOT data/assets.json, the two art manifests, and no public/assets.
// That asymmetry is the whole reason the builder corrects one manifest entry and not the other.
const FIXTURE = Buffer.from(
  'UEsDBBQAAAAIAAdxSV3suo1qlAAAAAkBAAAhAAAAU3Ryb25naG9sZC1Qcm90b2NvbC9NQU5JRkVTVC5qc29upY5BDoNACEWvYlg36oBo7G0Yh0k1Wk3Hbmrm7sWu2nVhAz/8/zggro9FdrgW7lKAbJtN0JfWYHscZ02mHBBkl0qXdddUTmm9f8Q0vvR01mi36SbI7Wkn1L5jVg2eQ9f0XlGYRT1KcJ2LjbYNqhPSqOqJmAZ1DtvIFCkgQra47enncaimVNlThvwGYv3Dq/8syDm/AVBLAwQUAAAACAAHcUldDL28UkEAAABiAAAAJAAAAFN0cm9uZ2hvbGQtUHJvdG9jb2wvZGF0YS9hc3NldHMuanNvbqtWSs5ILCpWslKIVtJPLC5OLSnWB4noJ5YllgCpCr2CvHQlHQWskpVgyVigbFp+XgnUEDBTP02vPD8tzUgpthYAUEsDBBQAAAAIAAdxSV3H8ciZRgAAAGYAAAAkAAAAU3Ryb25naG9sZC1Qcm90b2NvbC9kYXRhL2Vtb3Rlcy5qc29uq1YqSy0qzszPU7JSMNRRUErNzS9JLQZyopX0E4uLU0uK9XPykxNz9EESmcn5efpJicWZyfqJegV56UpADXhVJYFVxdYCAFBLAwQUAAAACAAHcUlddEXiehUAAAATAAAAJAAAAFN0cm9uZ2hvbGQtUHJvdG9jb2wvcHVibGljL2pzL2FwcC5qc0utKMgvKlFIzs8rLlGoULBVMLQGAFBLAQIUABQAAAAIAAdxSV3suo1qlAAAAAkBAAAhAAAAAAAAAAAAAACAAQAAAABTdHJvbmdob2xkLVByb3RvY29sL01BTklGRVNULmpzb25QSwECFAAUAAAACAAHcUldDL28UkEAAABiAAAAJAAAAAAAAAAAAAAAgAHTAAAAU3Ryb25naG9sZC1Qcm90b2NvbC9kYXRhL2Fzc2V0cy5qc29uUEsBAhQAFAAAAAgAB3FJXcfxyJlGAAAAZgAAACQAAAAAAAAAAAAAAIABVgEAAFN0cm9uZ2hvbGQtUHJvdG9jb2wvZGF0YS9lbW90ZXMuanNvblBLAQIUABQAAAAIAAdxSV10ReJ6FQAAABMAAAAkAAAAAAAAAAAAAACAAd4BAABTdHJvbmdob2xkLVByb3RvY29sL3B1YmxpYy9qcy9hcHAuanNQSwUGAAAAAAQABABFAQAANQIAAAAA',
  'base64',
);

const TAG = 'v9.9.9';
const BASE = 'https://cdn.example.test';
const TOKEN = 'v9.9.9-abc12345';

async function workspace(withArt = false) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'official-cdn-'));
  const cacheDir = path.join(dir, 'cache');
  await fsp.mkdir(cacheDir, { recursive: true });
  const name = `Stronghold-Protocol-${TAG}-lite.zip`;
  // The builder reuses a cached zip whose size matches the release, so seeding the cache with the
  // fixture is what keeps this test off the network.
  const zip = withArt ? addArtEntry(FIXTURE) : FIXTURE;
  await fsp.writeFile(path.join(cacheDir, name), zip);
  return {
    dir,
    cacheDir,
    release: { repo: 'owner/repo', tag: TAG, lite: { name, size: zip.length } },
  };
}

/** The same package, but with one art file: what a full package (not a lite one) looks like. */
function addArtEntry(buf) {
  return editZip(buf, { add: { 'Stronghold-Protocol/public/assets/char/x.png': Buffer.from('png') } });
}

const quiet = () => {};

test('the builder repoints both manifests and keeps the package install-check consistent', async () => {
  const ws = await workspace();
  const out = path.join(ws.dir, 'out');
  const built = await buildOfficialCdn({ out, base: BASE, token: TOKEN, release: ws.release, cacheDir: ws.cacheDir, log: quiet });

  assert.equal(built.name, `stronghold-official-cdn-${TAG}.zip`);
  const zip = await fsp.readFile(built.file);

  const assets = readZipEntry(zip, 'Stronghold-Protocol/data/assets.json').toString('utf8');
  assert.ok(assets.includes(`"${BASE}/assets/char/avatar/x.png?v=${TOKEN}"`), 'assets.json must be absolute and tokened');
  assert.ok(assets.includes(`"${BASE}/fonts/f.woff2?v=${TOKEN}"`), 'fonts must be repointed too');
  assert.equal((assets.match(/"\/assets\//g) || []).length, 0, 'no bare art path may survive');

  const emotes = readZipEntry(zip, 'Stronghold-Protocol/data/emotes.json').toString('utf8');
  assert.ok(emotes.includes(`${BASE}/assets/local/emoticon/basic/a.png?v=${TOKEN}`));

  // data/assets.json is setup-managed, so it must NOT appear in MANIFEST.json...
  const manifest = JSON.parse(readZipEntry(zip, 'Stronghold-Protocol/MANIFEST.json').toString('utf8'));
  assert.equal(manifest.files['data/assets.json'], undefined, 'a setup-managed manifest must stay out of MANIFEST.json');
  // ...while data/emotes.json is managed, so its entry must have been corrected to the new bytes.
  const shipped = readZipEntry(zip, 'Stronghold-Protocol/data/emotes.json');
  assert.equal(manifest.files['data/emotes.json'].size, shipped.length);
  assert.equal(manifest.files['data/emotes.json'].sha256, crypto.createHash('sha256').update(shipped).digest('hex'));
  // An entry for a file we did not touch must be left alone.
  assert.equal(manifest.files['public/js/app.js'].sha256, '0'.repeat(64));

  assert.ok(listZipEntries(zip).includes('Stronghold-Protocol/CDN-MIRROR-README.txt'), 'the note must ship');

  const check = await verifyOfficialCdn(built.file);
  assert.deepEqual(check.problems, []);
  assert.equal(check.ok, true);
  await fsp.rm(ws.dir, { recursive: true, force: true });
});

// The variant only makes sense for a lite package. Handed a full one, repointing would produce a
// package that is both large and pointing at a CDN, so the builder must refuse instead.
test('a package that still holds art is refused', async () => {
  const ws = await workspace(true);
  await assert.rejects(
    () => buildOfficialCdn({ out: path.join(ws.dir, 'out'), base: BASE, token: TOKEN, release: ws.release, cacheDir: ws.cacheDir, log: quiet }),
    /expected the lite package/,
  );
  await fsp.rm(ws.dir, { recursive: true, force: true });
});

test('a release without a lite zip is refused with a reason, not a crash', async () => {
  await assert.rejects(
    () => buildOfficialCdn({ out: os.tmpdir(), base: BASE, token: TOKEN, release: { tag: TAG, lite: null }, cacheDir: os.tmpdir(), log: quiet }),
    /ships no lite zip/,
  );
});

// A zip whose art manifests did not change means the layout moved; shipping it would point at
// nothing. Fail loudly instead.
test('a manifest that rewrites nothing is treated as a layout change', async () => {
  const ws = await workspace();
  const { editZip } = await import('../src/zip-edit.mjs');
  const stripped = editZip(FIXTURE, {
    replace: { 'Stronghold-Protocol/data/assets.json': Buffer.from('{"chars":["no art refs here"]}') },
  });
  await fsp.writeFile(path.join(ws.cacheDir, ws.release.lite.name), stripped);
  ws.release.lite.size = stripped.length;
  await assert.rejects(
    () => buildOfficialCdn({ out: path.join(ws.dir, 'out'), base: BASE, token: TOKEN, release: ws.release, cacheDir: ws.cacheDir, log: quiet }),
    /nothing was rewritten/,
  );
  await fsp.rm(ws.dir, { recursive: true, force: true });
});

test('verify reports a manifest entry that no longer matches the shipped bytes', async () => {
  const ws = await workspace();
  const out = path.join(ws.dir, 'out');
  const built = await buildOfficialCdn({ out, base: BASE, token: TOKEN, release: ws.release, cacheDir: ws.cacheDir, log: quiet });

  const { editZip } = await import('../src/zip-edit.mjs');
  const zip = await fsp.readFile(built.file);
  // Corrupt the manifest's digest for the file we rewrote: this is the failure mode the gate exists
  // to prevent, so verify must be able to see it.
  const doc = JSON.parse(readZipEntry(zip, 'Stronghold-Protocol/MANIFEST.json').toString('utf8'));
  doc.files['data/emotes.json'].sha256 = 'f'.repeat(64);
  const tampered = editZip(zip, { replace: { 'Stronghold-Protocol/MANIFEST.json': Buffer.from(JSON.stringify(doc)) } });
  const tamperedFile = path.join(out, 'tampered.zip');
  await fsp.writeFile(tamperedFile, tampered);

  const check = await verifyOfficialCdn(tamperedFile);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => /MANIFEST says/.test(p)), `expected a digest problem, got ${JSON.stringify(check.problems)}`);
  await fsp.rm(ws.dir, { recursive: true, force: true });
});
