// Replace or add entries inside an existing zip, in pure Node.
//
// Why not shell out to `zip`: this repository's other builders do (src/packs.mjs, src/dropin.mjs),
// but they CREATE archives, where the tool is a hard requirement already declared by the workflow.
// This module EDITS an upstream archive, and an edit that silently produced a malformed zip would
// ship a package that extracts to garbage — so the format is handled here, where it can be unit
// tested, and the whole variant builds with no external binary at all.
//
// Entries that are not being replaced are copied through as raw bytes: their compressed data is
// never decompressed or recompressed, so untouched files keep the exact bytes upstream shipped.
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;

/**
 * @param {Buffer} buf the source archive
 * @param {{replace?: Record<string, Buffer|string>, add?: Record<string, Buffer|string>}} edits
 * @returns {Buffer} a new archive
 */
export function editZip(buf, { replace = {}, add = {} } = {}) {
  const edits = new Map();
  for (const [name, data] of Object.entries(replace)) edits.set(name, toBuf(data));
  for (const [name, data] of Object.entries(add)) {
    if (edits.has(name)) throw new Error(`zip edit: ${name} is both replaced and added`);
    edits.set(name, toBuf(data));
  }

  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  // Zip64 would move every offset out of 32-bit range; refuse rather than write a broken archive.
  // The zip64 locator, when present, sits immediately before the EOCD -- scanning the whole file
  // for the signature would false-positive on four random bytes inside compressed data.
  const hasZip64Locator = eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_EOCD64_LOC;
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff || hasZip64Locator) {
    throw new Error('zip edit: zip64 archives are not supported');
  }

  const entries = readCentralDirectory(buf, eocd);

  const byName = new Map(entries.map((e) => [e.name, e]));
  const chunks = [];
  let offset = 0;
  const written = [];

  const push = (chunk) => {
    chunks.push(chunk);
    offset += chunk.length;
  };

  const writeNew = (entry, name, data) => {
    const crc = crc32(data) >>> 0;
    const deflated = deflateRawSync(data, { level: 6 });
    // Only worth deflating when it actually helps; stored entries are legal either way.
    const method = deflated.length < data.length ? 8 : 0;
    const body = method === 8 ? deflated : data;
    const useUtf8 = /[^\x20-\x7e]/.test(name);
    const flags = useUtf8 ? 0x0800 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(entry ? entry.time : 0, 10);
    local.writeUInt16LE(entry ? entry.date : 0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    const nameBuf = Buffer.from(name, 'utf8');
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localOffset = offset;
    push(local);
    push(nameBuf);
    push(body);
    written.push({ ...entry, name, method, flags, crc, compSize: body.length, rawSize: data.length, localOffset, time: entry ? entry.time : 0, date: entry ? entry.date : 0, centralExtra: Buffer.alloc(0) });
  };

  // Rewritten entries keep their original position so unrelated tooling that reads the archive in
  // order still sees the upstream layout; brand-new entries are appended.
  for (const entry of entries) {
    if (edits.has(entry.name)) {
      writeNew(entry, entry.name, edits.get(entry.name));
      continue;
    }
    const start = entry.localOffset;
    const nameLen = buf.readUInt16LE(start + 26);
    const extraLen = buf.readUInt16LE(start + 28);
    const end = start + 30 + nameLen + extraLen + entry.compSize;
    if (start + 30 > buf.length || end > buf.length) throw new Error(`zip edit: ${entry.name} points outside the archive`);
    // The offset in the central directory must address the copy's position in the NEW archive:
    // the source offsets stop being valid the moment any earlier entry changes length.
    const localOffset = offset;
    written.push({ ...entry, localOffset });
    push(buf.subarray(start, end));
  }
  for (const [name, data] of edits) {
    if (!byName.has(name)) writeNew(null, name, data);
  }

  const cdStart = offset;
  for (const e of written) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(e.flags, 8);
    central.writeUInt16LE(e.method, 10);
    central.writeUInt16LE(e.time, 12);
    central.writeUInt16LE(e.date, 14);
    central.writeUInt32LE(e.crc, 16);
    central.writeUInt32LE(e.compSize, 20);
    central.writeUInt32LE(e.rawSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(e.centralExtra.length, 30);
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(e.localOffset, 42);
    push(central);
    push(nameBuf);
    push(e.centralExtra);
  }
  const cdSizeNew = offset - cdStart;

  const out = Buffer.alloc(22);
  out.writeUInt32LE(SIG_EOCD, 0);
  out.writeUInt16LE(0, 4);
  out.writeUInt16LE(0, 6);
  out.writeUInt16LE(written.length, 8);
  out.writeUInt16LE(written.length, 10);
  out.writeUInt32LE(cdSizeNew, 12);
  out.writeUInt32LE(cdStart, 16);
  out.writeUInt16LE(0, 20);
  push(out);

  return Buffer.concat(chunks, offset);
}

const toBuf = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8'));

/** Central-directory records: name, sizes, method and where the local header starts. */
function readCentralDirectory(buf, eocd) {
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`zip edit: central directory is corrupt at entry ${i}`);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      central: p,
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      centralExtra: buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen),
      localOffset: buf.readUInt32LE(p + 42),
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      compSize: buf.readUInt32LE(p + 20),
      rawSize: buf.readUInt32LE(p + 24),
      flags: buf.readUInt16LE(p + 8),
      time: buf.readUInt16LE(p + 12),
      date: buf.readUInt16LE(p + 14),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Read one entry's bytes, or null when the archive has no such name.
 *
 * Exists so a build needs no `unzip` either: reading a single manifest out of a 23 MB package is
 * the only extraction this variant does, and it is cheaper and more portable to do it here than
 * to depend on a binary that Windows does not ship.
 */
export function readZipEntry(buf, name) {
  const eocd = findEocd(buf);
  const entry = readCentralDirectory(buf, eocd).find((e) => e.name === name);
  if (!entry) return null;
  const start = entry.localOffset;
  if (buf.readUInt32LE(start) !== SIG_LOCAL) throw new Error(`zip edit: ${name} has no local header`);
  const nameLen = buf.readUInt16LE(start + 26);
  const extraLen = buf.readUInt16LE(start + 28);
  const from = start + 30 + nameLen + extraLen;
  const raw = buf.subarray(from, from + entry.compSize);
  // Sizes come from the central directory, which is authoritative even when the local header
  // defers them to a data descriptor.
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`zip edit: ${name} uses unsupported compression method ${entry.method}`);
}

/** Every entry name in the archive. */
export function listZipEntries(buf) {
  return readCentralDirectory(buf, findEocd(buf)).map((e) => e.name);
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 66560); // EOCD + max comment
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error('zip edit: no end-of-central-directory record found');
}
