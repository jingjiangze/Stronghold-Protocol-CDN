import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateRawSync } from 'node:zlib';

import { editZip, readZipEntry, listZipEntries } from '../src/zip-edit.mjs';

// A real 754-byte zip, written by Python's zipfile -- an INDEPENDENT writer, so this does not
// test the editor against its own output. Four entries: two JSON manifests, a plain file and a
// file under a directory, all DEFLATE-compressed.
const FIXTURE = Buffer.from(
  'UEsDBBQAAAAIAPdwSV2v23uyEgAAABAAAAAcAAAAU3Ryb25naG9sZC1Qcm90b2NvbC9rZWVwLnR4dCvNS85IzEtPTVFIqixJLeYCAFBLAwQUAAAACAD3cEld0K4mUy4AAAAuAAAAJAAAAFN0cm9uZ2hvbGQtUHJvdG9jb2wvZGF0YS9hc3NldHMuanNvbqtWSs5ILCpWslKIVtJPLC5OLSnWT9QryEtX0lFQ0k/LzwPy0/TK89PSjJRiawFQSwMEFAAAAAgA93BJXQHl4ZtMAAAAlwAAACEAAABTdHJvbmdob2xkLVByb3RvY29sL01BTklGRVNULmpzb26rVkrLL8pNLFGyUjDUUVBKLCgAspQs9YBQCchPy8xJLQaKVCulJJYk6icWF6eWFOtlFefngQWLM6tSoTqLMxKNTM1Amg0oBEq1tbUAUEsDBBQAAAAIAPdwSV3zUcVlFgAAABQAAAAkAAAAU3Ryb25naG9sZC1Qcm90b2NvbC9wdWJsaWMvanMvYXBwLmpzS60oyC8qUUjOzysuUahQsFUwtOYCAFBLAQIUABQAAAAIAPdwSV2v23uyEgAAABAAAAAcAAAAAAAAAAAAAACAAQAAAABTdHJvbmdob2xkLVByb3RvY29sL2tlZXAudHh0UEsBAhQAFAAAAAgA93BJXdCuJlMuAAAALgAAACQAAAAAAAAAAAAAAIABTAAAAFN0cm9uZ2hvbGQtUHJvdG9jb2wvZGF0YS9hc3NldHMuanNvblBLAQIUABQAAAAIAPdwSV0B5eGbTAAAAJcAAAAhAAAAAAAAAAAAAACAAbwAAABTdHJvbmdob2xkLVByb3RvY29sL01BTklGRVNULmpzb25QSwECFAAUAAAACAD3cEld81HFZRYAAAAUAAAAJAAAAAAAAAAAAAAAgAFHAQAAU3Ryb25naG9sZC1Qcm90b2NvbC9wdWJsaWMvanMvYXBwLmpzUEsFBgAAAAAEAAQAPQEAAJ8BAAAAAA==',
  'base64',
);

/** Independently walk the archive and verify every entry's CRC, the way unzip does. */
function checkCrcs(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, 'no EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const wantCrc = buf.readUInt32LE(p + 16);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const localOffset = buf.readUInt32LE(p + 42);
    // The local header signature must actually be there: a stale offset is the failure mode that
    // produces a zip `unzip` extracts as garbage.
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, `${name}: bad local header offset`);
    const lnLen = buf.readUInt16LE(localOffset + 26);
    const lxLen = buf.readUInt16LE(localOffset + 28);
    const from = localOffset + 30 + lnLen + lxLen;
    const raw = buf.subarray(from, from + compSize);
    const data = method === 0 ? raw : inflateRawSync(raw);
    assert.equal(crc32(data) >>> 0, wantCrc, `${name}: CRC mismatch`);
    p += 46 + nameLen + extraLen + commentLen;
  }
}

test('the fixture is readable: names and bytes come back intact', () => {
  assert.deepEqual(listZipEntries(FIXTURE), [
    'Stronghold-Protocol/keep.txt',
    'Stronghold-Protocol/data/assets.json',
    'Stronghold-Protocol/MANIFEST.json',
    'Stronghold-Protocol/public/js/app.js',
  ]);
  assert.equal(readZipEntry(FIXTURE, 'Stronghold-Protocol/keep.txt').toString('utf8'), 'unchanged bytes\n');
  assert.equal(readZipEntry(FIXTURE, 'Stronghold-Protocol/public/js/app.js').toString('utf8'), 'export const x = 1;\n');
  assert.equal(readZipEntry(FIXTURE, 'Stronghold-Protocol/nope.txt'), null);
  checkCrcs(FIXTURE);
});

// The whole point of the editor: change two entries, leave the rest byte-identical. Offsets in the
// central directory must be rewritten for every entry that moved, which is the bug this test
// exists to catch -- a stale offset still "reads" but `unzip` reports a bad local header.
test('replacing an entry keeps every other entry intact and every offset valid', () => {
  const before = FIXTURE;
  const replacement = Buffer.from(JSON.stringify({ chars: ['https://cdn.example/assets/a.png?v=1'] }), 'utf8');
  const after = editZip(before, { replace: { 'Stronghold-Protocol/data/assets.json': replacement } });

  assert.equal(listZipEntries(after).length, listZipEntries(before).length);
  assert.equal(readZipEntry(after, 'Stronghold-Protocol/data/assets.json').toString('utf8'), replacement.toString('utf8'));
  // Untouched entries must come through byte for byte.
  for (const name of ['Stronghold-Protocol/keep.txt', 'Stronghold-Protocol/MANIFEST.json', 'Stronghold-Protocol/public/js/app.js']) {
    assert.deepEqual(readZipEntry(after, name), readZipEntry(before, name), name);
  }
  checkCrcs(after);
});

test('an added entry appears and does not disturb the others', () => {
  const after = editZip(FIXTURE, { add: { 'Stronghold-Protocol/NOTE.txt': 'hello\n' } });
  const names = listZipEntries(after);
  assert.equal(names.length, listZipEntries(FIXTURE).length + 1);
  assert.ok(names.includes('Stronghold-Protocol/NOTE.txt'));
  assert.equal(readZipEntry(after, 'Stronghold-Protocol/NOTE.txt').toString('utf8'), 'hello\n');
  assert.equal(readZipEntry(after, 'Stronghold-Protocol/keep.txt').toString('utf8'), 'unchanged bytes\n');
  checkCrcs(after);
});

// Rewriting an entry to a much larger one is what actually shifts the offsets, so it is the case
// that catches a stale-offset bug that a same-size replacement would hide.
test('a replacement that grows an entry still yields a valid archive', () => {
  const big = Buffer.from('x'.repeat(200000), 'utf8');
  const after = editZip(FIXTURE, { replace: { 'Stronghold-Protocol/data/assets.json': big } });
  assert.equal(readZipEntry(after, 'Stronghold-Protocol/data/assets.json').length, 200000);
  assert.equal(readZipEntry(after, 'Stronghold-Protocol/public/js/app.js').toString('utf8'), 'export const x = 1;\n');
  checkCrcs(after);
});

test('a name that is both replaced and added is refused rather than silently doing one', () => {
  assert.throws(
    () => editZip(FIXTURE, { replace: { 'a.txt': 'x' }, add: { 'a.txt': 'y' } }),
    /both replaced and added/,
  );
});

test('a corrupt archive is refused instead of producing a broken one', () => {
  assert.throws(() => editZip(Buffer.from('not a zip at all'), {}), /end-of-central-directory/);
  const truncated = FIXTURE.subarray(0, 40);
  assert.throws(() => editZip(truncated, {}), /end-of-central-directory/);
});
