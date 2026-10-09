// Objects hosted on purpose, outside the upstream asset tree.
//
// The sync mirrors upstream. Anything else in the bucket is, from its point of view, a leftover --
// which is exactly what `--prune` is for. But some of those objects are deliberately there: art we
// host on behalf of a mod, which upstream will never list. A prune pass that removed them would
// destroy someone else's content as a side effect of a routine cleanup.
//
// So the list lives in a file the prune reads, not in a comment. It is validated here rather than
// trusted: an entry with no reason, or a key that overlaps the upstream tree, is a mistake that
// should stop the run instead of silently protecting (or failing to protect) the wrong thing.
import fs from 'node:fs';
import path from 'node:path';

export const HOSTED_FILE = 'hosted.json';

/** @returns {{keys:Set<string>, entries:Array}} */
export function readHosted(root) {
  const file = path.join(root, HOSTED_FILE);
  if (!fs.existsSync(file)) return { keys: new Set(), entries: [] };
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = Array.isArray(doc.hosted) ? doc.hosted : [];
  const keys = new Set();
  for (const e of entries) {
    if (!e || typeof e.id !== 'string' || !e.id) throw new Error(`${HOSTED_FILE}: every entry needs an id`);
    // A reason is the point of the file; without one nobody can tell deliberate hosting from debris.
    if (typeof e.what !== 'string' || e.what.length < 10) throw new Error(`${HOSTED_FILE}: ${e.id} needs a description`);
    if (!Array.isArray(e.keys) || !e.keys.length) throw new Error(`${HOSTED_FILE}: ${e.id} lists no keys`);
    for (const k of e.keys) {
      if (typeof k !== 'string' || k.startsWith('/') || k.includes('..')) throw new Error(`${HOSTED_FILE}: ${e.id} has an invalid key: ${k}`);
      keys.add(k);
    }
  }
  return { keys, entries };
}

/**
 * Split a prune list into what may be deleted and what is deliberately kept.
 *
 * Kept keys are reported rather than silently dropped: "pruned 120, spared 64" is a fact the
 * operator should see, because a growing spared count means hosted content is accumulating.
 */
export function splitForPrune(removeKeys, hostedKeys) {
  const prune = [];
  const spared = [];
  for (const key of removeKeys) (hostedKeys.has(key) ? spared : prune).push(key);
  return { prune, spared };
}
