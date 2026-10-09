// A compact, queryable index of everything the CDN hosts.
//
// Why not just use cdn/v1/index.json: it is 1.64 MiB of {path: {size, sha256}} and answers "what is
// the hash of this file" well and "what is in this directory" badly -- a reader has to pull the
// whole table and filter it. This file is the other half: grouped by directory, names and sizes
// only, so one small fetch renders a browsable tree and answers directory questions directly.
//
// sha256 stays out of here on purpose. It is the expensive part of the payload and it is already
// published in index.json, so duplicating it would double the size of the file people fetch to
// browse. Verification points at index.json; browsing points here.
//
// Files we host on purpose (a mod's art, see hosted.json) are included and flagged, because "which
// directories are hosted" is only a truthful answer if it covers everything in the bucket and not
// just what upstream ships.
import fs from 'node:fs';
import path from 'node:path';

import { readHosted } from './hosted.mjs';

export const TREE_SCHEMA = 1;

/**
 * @param {Record<string, {size:number}>} files the flat index, keyed by repo-relative path
 * @param {{sizes?: Map<string, number>}} [hosted] keys hosted on purpose, with their sizes
 * @returns {{doc: object, json: string, overlap: string[]}}
 */
export function buildTree(files, { hosted = new Map() } = {}) {
  const dirs = {};
  let totalFiles = 0;
  let totalBytes = 0;
  let hostedFiles = 0;

  // Hosted content is merged in rather than added to the published index: the index is what the
  // sync diffs against, so keeping it equal to upstream's tree is what makes "is the CDN complete?"
  // a meaningful question. The tree is the view that should show everything in the bucket.
  const upstream = new Set(Object.keys(files));
  const merged = { ...files };
  const overlap = [];
  for (const [key, size] of hosted) {
    if (upstream.has(key)) {
      // Both upstream's and listed as hosted. The file IS upstream content, so flagging it as
      // "hosted on purpose" would misdescribe it -- and it means hosted.json names something it no
      // longer needs to. Reported so the stale entry can be removed.
      overlap.push(key);
      continue;
    }
    merged[key] = { size };
  }

  for (const key of Object.keys(merged).sort()) {
    const cut = key.lastIndexOf('/');
    const dir = cut < 0 ? '' : key.slice(0, cut);
    const name = cut < 0 ? key : key.slice(cut + 1);
    const size = Number(merged[key]?.size) || 0;
    const isHosted = hosted.has(key) && !upstream.has(key);
    (dirs[dir] = dirs[dir] || []).push(isHosted ? [name, size, 1] : [name, size]);
    totalFiles++;
    totalBytes += size;
    if (isHosted) hostedFiles++;
  }

  // Per-directory totals are precomputed so a reader does not have to sum an array to render a
  // collapsed row, which is the common case.
  const out = {};
  for (const dir of Object.keys(dirs).sort()) {
    const list = dirs[dir].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    out[dir] = { bytes: list.reduce((s, f) => s + f[1], 0), files: list };
  }

  const doc = {
    schema: TREE_SCHEMA,
    _how: 'dirs[<directory>].files is [[name, size, mod?], …]; mod=1 means this repository hosts it on purpose (not upstream content). sha256 lives in /cdn/v1/index.json. Existence and size for a single path: HEAD its URL.',
    totals: { files: totalFiles, bytes: totalBytes, dirs: Object.keys(out).length, hosted: hostedFiles },
    dirs: out,
  };
  return { doc, json: JSON.stringify(doc), overlap };
}

/** Read the flat index and hosted list from a repo root, then build the tree. */
export function readTree(root, indexFiles) {
  const { sizes } = readHosted(root);
  return buildTree(indexFiles, { hosted: sizes });
}
