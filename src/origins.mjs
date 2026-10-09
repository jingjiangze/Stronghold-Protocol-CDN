// Extra read-only mirrors, from `origins.json`.
//
// The r2 and Pages origins are deployment targets, so the sync knows about them structurally. A
// third origin — CloudFront, an object-storage CDN, a mirror on a VPS — is not something this
// repository deploys to; it is something that sits in front of the same bucket. Keeping that list
// in a JSON file means pointing a new CDN at the bucket is one entry: it flows into art.json,
// mirrors.json and the site's speed test with no code change.
import fs from 'node:fs';
import path from 'node:path';

import { assertPublicHttpsUrl } from './upstream.mjs';

/**
 * @returns {{id:string, kind:string, root:string, base:string, note?:string}[]}
 */
export function readExtraOrigins(root) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(root, 'origins.json'), 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(cfg?.extraOrigins) ? cfg.extraOrigins : [];
  const out = [];
  for (const entry of list) {
    if (!entry?.id || !entry?.root) continue;
    try {
      // Same rule as everywhere else: https only, and never a loopback/private/reserved host.
      const url = assertPublicHttpsUrl(entry.root);
      const root_ = url.href.replace(/\/+$/, '');
      out.push({
        id: String(entry.id),
        kind: String(entry.kind || 'cdn'),
        root: root_,
        base: `${root_}/assets/`,
        ...(entry.note ? { note: String(entry.note) } : {}),
      });
    } catch {
      // A malformed entry must not take the whole sync down; it simply is not published.
    }
  }
  return out;
}

/**
 * Origins that mount files out of a **git repository** through a public mirror chain
 * (jsDelivr / ghfast→raw).
 *
 * These are a different animal from the flat origins and must not be presented as equivalent:
 * a git mount can only serve files that are **committed to git**. The asset tree used to be
 * outside git — derived from the upstream release package — which made every git origin partial
 * by construction: it carried the interface files and the probe, not `assets/**`.
 *
 * That changed on 2026-10-09: the asset tree is now committed on the orphan branch `assets-raw`
 * (12,261 files / 618.4 MiB, sampled 40 paths × 3 sources byte-identical). Git origins can
 * therefore be full. `coverage` still exists so the UI can say which is which out loud instead of
 * implying a full mirror — an entry rooted at `@main` really is still partial, because the art
 * lives on the other branch.
 */
export const GIT_PROBE_PATH = '/probe/cdn-probe.bin';

export function readGitOrigins(root) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(root, 'origins.json'), 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(cfg?.gitOrigins) ? cfg.gitOrigins : [];
  const out = [];
  for (const entry of list) {
    if (!entry?.id || !entry?.root) continue;
    try {
      const url = assertPublicHttpsUrl(entry.root);
      const root_ = url.href.replace(/\/+$/, '');
      out.push({
        id: String(entry.id),
        kind: String(entry.kind || 'git'),
        root: root_,
        // Same shape as a flat origin so one parser reads both; `coverage` says what it really holds.
        base: `${root_}/`,
        probe: String(entry.probe || GIT_PROBE_PATH),
        coverage: String(entry.coverage || 'partial'),
        ...(entry.note ? { note: String(entry.note) } : {}),
      });
    } catch {
      // A malformed entry must not take the whole sync down; it simply is not published.
    }
  }
  return out;
}
