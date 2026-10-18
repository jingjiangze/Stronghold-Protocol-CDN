// The tree and the index are two views of the same bucket, and nothing in the chain checked that
// they still agree. The drift was real and silent: a tree published 620 skin paths behind the bucket
// (2026-10-13) looked exactly like a tree that was current, because both are valid JSON with a
// plausible `totals` block. A consumer reading "the CDN does not list this asset" had no way to tell
// that from "this listing is older than the bucket".
//
// These three checks are the difference. Each one is a statement that must hold for any honest pair,
// each fails loudly with the offending keys, and none of them needs a credential: the two files are
// both public. That is what makes them runnable as a gate on every rebuild rather than as a manual
// audit nobody schedules.
//
//   index ⊆ tree        every upstream key the sync published must be browsable
//   hosted == mod count  `totals.hosted` must equal the number of entries actually flagged mod=1
//   token == tag + sha8  the tree must name the index it was built from
import { createHash } from 'node:crypto';

/**
 * Flatten a published tree into a key → size map plus the set of keys flagged as hosted.
 *
 * `dirs` is an object keyed by directory (the empty string is the root), and each value is
 * `{bytes, files}` where a file entry is `[name, size]` or `[name, size, 1]` — the trailing 1 is
 * what marks a key this repository hosts on purpose.
 *
 * @param {{dirs?: Record<string, {files?: Array}>}} tree
 * @returns {{sizes: Map<string, number>, hosted: Set<string>, files: number}}
 */
export function flattenTree(tree) {
  const dirs = (tree && tree.dirs) || {};
  const sizes = new Map();
  const hosted = new Set();
  let files = 0;
  for (const [dir, value] of Object.entries(dirs)) {
    for (const entry of (value && value.files) || []) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
        throw new Error(`tree: malformed file entry in "${dir}": ${JSON.stringify(entry)}`);
      }
      const key = dir ? `${dir}/${entry[0]}` : entry[0];
      if (sizes.has(key)) throw new Error(`tree: duplicate key ${key}`);
      sizes.set(key, Number(entry[1]) || 0);
      if (entry[2] === 1) hosted.add(key);
      files++;
    }
  }
  return { sizes, hosted, files };
}

/** The token the tree must carry for a given index document: its tag plus 8 hex of its sha256. */
export function expectedToken(indexBytes, tag) {
  if (typeof indexBytes !== 'string' && !Buffer.isBuffer(indexBytes)) {
    throw new Error('expectedToken needs the raw index bytes, not the parsed object');
  }
  if (!tag) throw new Error('expectedToken needs the index tag');
  return `${tag}-${createHash('sha256').update(indexBytes).digest('hex').slice(0, 8)}`;
}

/**
 * @param {object} opts
 * @param {Buffer|string} opts.indexBytes the exact bytes of index.json as published
 * @param {object} opts.index the parsed index document ({tag, files})
 * @param {object} opts.tree the parsed tree document
 * @returns {{ok: boolean, failures: string[]}}
 */
export function verifyTreeAndIndex({ indexBytes, index, tree }) {
  const failures = [];
  const indexFiles = (index && index.files) || {};
  const { sizes, hosted, files } = flattenTree(tree);

  // 1. Every key the sync published must be browsable. A key that is in the index but not in the
  //    tree is the exact failure this file exists for: the asset is on the CDN and verified, but no
  //    reader can discover it through the browsable view.
  const missing = Object.keys(indexFiles).filter((key) => !sizes.has(key));
  if (missing.length) {
    failures.push(`index has ${missing.length} key(s) the tree does not list (e.g. ${missing.slice(0, 5).join(', ')})`);
  }

  // 2. `totals.hosted` must equal the number of entries actually flagged. The totals block is what a
  //    reader trusts without re-deriving, so a number that disagrees with the payload is a lie even
  //    when the payload is fine.
  const declared = Number(tree?.totals?.hosted);
  if (!Number.isFinite(declared)) {
    failures.push('tree.totals.hosted is missing or not a number');
  } else if (declared !== hosted.size) {
    failures.push(`tree.totals.hosted says ${declared} but ${hosted.size} entries are flagged mod=1`);
  }

  // The same for the other two totals, for the same reason: they are cheap and they are the summary
  // a collapsed UI row renders without summing anything.
  const declaredFiles = Number(tree?.totals?.files);
  if (!Number.isFinite(declaredFiles)) {
    failures.push('tree.totals.files is missing or not a number');
  } else if (declaredFiles !== files) {
    failures.push(`tree.totals.files says ${declaredFiles} but the payload holds ${files} entries`);
  }
  const sum = [...sizes.values()].reduce((a, b) => a + b, 0);
  const declaredBytes = Number(tree?.totals?.bytes);
  if (!Number.isFinite(declaredBytes)) {
    failures.push('tree.totals.bytes is missing or not a number');
  } else if (declaredBytes !== sum) {
    failures.push(`tree.totals.bytes says ${declaredBytes} but the entries sum to ${sum}`);
  }

  // 3. The token is how a reader tells a fresh tree from a stale one, and it is derived from the
  //    index the tree was built from. A mismatch means the two files came from different runs —
  //    which is precisely the state that cannot be distinguished from drift by looking at either
  //    file alone.
  const want = expectedToken(indexBytes, index && index.tag);
  if (tree?.token !== want) {
    failures.push(`tree.token is ${JSON.stringify(tree?.token)} but this index implies ${want}`);
  }

  return { ok: failures.length === 0, failures };
}
