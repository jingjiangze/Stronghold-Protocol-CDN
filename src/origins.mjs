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

/**
 * Origin ids that have been deliberately removed and must not come back.
 *
 * `carryForwardOrigins` restores any previously-published origin the current run does not produce.
 * That is correct for an origin that is only published when a flag is passed (Pages needs --pages),
 * but it also means deleting an entry from this file has no effect: the published list still names
 * it, so it is restored on every run. Statically sat in the live list that way -- measured at 2958 ms
 * and observed truncating payloads -- long after it was removed here.
 *
 * Naming a retired id is what makes a removal stick, and it is explicit rather than inferred from
 * absence, because "absent because deleted" and "absent because this run failed to build it" look
 * identical from the outside.
 */
export function readRetiredOrigins(root) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(root, 'origins.json'), 'utf8'));
  } catch {
    return new Set();
  }
  const list = Array.isArray(cfg?.retired) ? cfg.retired : [];
  return new Set(list.filter((id) => typeof id === 'string' && id));
}

/**
 * Origin ids that are parked: still built, still described, but `enabled:false`.
 *
 * "Retired" and "disabled" are different operations and must not be conflated. Retiring an id
 * removes it — `carryForwardOrigins` will not restore it, and it disappears from the interface.
 * Disabling keeps the entry in the file and in the interface but stops a selector from choosing it,
 * which is what you want while a backend is degraded: the operator's intent (this origin exists and
 * is meant to come back) survives, and so does its historical speed data.
 *
 * The setter must run before the list is published, on both paths that publish one (mirrors.json and
 * art.json). A park applied to only one of them is worse than none: a selector reading the other
 * would still pick the parked origin, and the failure would look like a fast origin that is down
 * rather than an origin that was deliberately taken out.
 */
export function readDisabledOrigins(root) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(root, 'origins.json'), 'utf8'));
  } catch {
    return new Set();
  }
  const list = Array.isArray(cfg?.disabled) ? cfg.disabled : [];
  return new Set(list.filter((id) => typeof id === 'string' && id));
}

/**
 * The order origins are presented in, by id. Unknown ids are ignored and unlisted origins keep
 * their built order, appended after the listed ones — so adding a new origin cannot silently
 * displace the ranking of the ones already here.
 *
 * @returns {string[]} origin ids, in the order they should be presented
 */
export function readPreferredOrder(root) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(root, 'origins.json'), 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(cfg?.preferredOrder) ? cfg.preferredOrder : [];
  return list.filter((id) => typeof id === 'string' && id);
}

/**
 * Apply {@link readPreferredOrder} to a list of origins.
 *
 * This only reorders presentation. It is not a ranking: the measured speed table is what a client
 * uses to choose, and it is built elsewhere from real probes. Putting an order in a file is for the
 * case where measurement is not the right answer — a backend that is objectively slower but does
 * not cost request quota, say — and saying so out loud is why the field is named `preferredOrder`
 * rather than `priority`.
 *
 * @template {{id: string}} T
 * @param {T[]} origins
 * @param {string[]} order
 * @returns {T[]} a new array
 */
export function applyPreferredOrder(origins, order) {
  const list = Array.isArray(origins) ? origins : [];
  const wanted = (Array.isArray(order) ? order : []).filter((id) => typeof id === 'string' && id);
  if (!wanted.length) return list.slice();
  const byId = new Map(list.map((o) => [o?.id, o]));
  const out = [];
  for (const id of wanted) {
    const hit = byId.get(id);
    if (!hit) continue;
    out.push(hit);
    byId.delete(id);
  }
  // Everything not named keeps its built order, after the named ones.
  for (const o of list) if (byId.has(o?.id)) out.push(o);
  return out;
}
