// Diff the freshly built index against what the CDN already serves.
//
// Policy (deliberate, see the audit): the mirror is **additive**. It uploads what is missing and
// re-uploads what changed, but it never deletes — the bucket is shared with other product lines
// and an older client line still points at this tree, so files that dropped out of the upstream
// manifest must stay reachable. Removals are reported, and only acted on with an explicit
// `--prune`.

/** @returns {{add:string[], change:string[], same:number, remove:string[]}} */
export function diffIndex(local, remote) {
  const localFiles = local?.files ?? local ?? {};
  const remoteFiles = remote?.files ?? remote ?? {};

  const add = [];
  const change = [];
  let same = 0;

  for (const key of Object.keys(localFiles).sort()) {
    const mine = localFiles[key];
    const theirs = remoteFiles[key];
    if (!theirs) add.push(key);
    else if (theirs.size !== mine.size || theirs.sha256 !== mine.sha256) change.push(key);
    else same++;
  }

  const remove = Object.keys(remoteFiles)
    .filter((key) => !localFiles[key])
    .sort();

  return { add, change, same, remove };
}

/** Bytes a sync would upload, given the sizes of the affected keys. */
export function uploadBytes(diff, files) {
  let bytes = 0;
  for (const key of [...diff.add, ...diff.change]) bytes += files[key]?.size ?? 0;
  return bytes;
}
