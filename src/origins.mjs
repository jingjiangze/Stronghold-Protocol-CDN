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
 * Capability fields for one origin, DERIVED from its own config rather than hand-filled — so a new
 * entry cannot disagree with what it is, and a caller never has to guess from the id.
 *
 *   assetEligible / fontEligible  follow `coverage`: a `partial` mount carries the interface files
 *                                 and answers 404 for `assets/**`, so it must never be a candidate
 *                                 for a source that serves art or fonts.
 *   supportsRange                 the client's resumable/segmented path needs 206; measured true on
 *                                 every full source (see docs/audit/free-mirror-verification.json).
 *   direct / proxied              a relay (sp-git-mount-relay) fronts other backends, so its bytes
 *                                 travel through a Worker — fine to use, but it must not be a
 *                                 DEFAULT candidate under the free-plan request budget.
 *   faultDomain                   two custom domains on ONE R2 bucket are two entrances to one copy,
 *                                 not two independent failure domains (r2 + r2-alt -> 'r2-bucket').
 */
export function capabilitiesOf(origin) {
  const root = String(origin?.root || '');
  let host = '';
  try { host = new URL(root).host.toLowerCase(); } catch { /* an origin without a parseable host */ }
  const proxied = /中转|中继|relay/i.test(origin?.note || '');
  const full = origin?.coverage !== 'partial';
  const r2Bucket = /^weishucdn2?\.jiangjiangze\.icu$/.test(host);
  return {
    enabled: origin?.enabled !== false,
    assetEligible: full,
    fontEligible: full,
    supportsRange: origin?.supportsRange !== false,
    direct: !proxied,
    ...(proxied ? { proxied: true } : {}),
    faultDomain: r2Bucket ? 'r2-bucket' : host || 'unknown',
  };
}

/** An origin with its derived capability fields attached. */
export const withCapabilities = (origin) => ({ ...origin, ...capabilitiesOf(origin) });

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
      out.push(withCapabilities({
        id: String(entry.id),
        kind: String(entry.kind || 'cdn'),
        root: root_,
        base: `${root_}/assets/`,
        ...(entry.note ? { note: String(entry.note) } : {}),
      }));
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
      out.push(withCapabilities({
        id: String(entry.id),
        kind: String(entry.kind || 'git'),
        root: root_,
        // Same shape as a flat origin so one parser reads both; `coverage` says what it really holds.
        base: `${root_}/`,
        probe: String(entry.probe || GIT_PROBE_PATH),
        coverage: String(entry.coverage || 'partial'),
        ...(entry.note ? { note: String(entry.note) } : {}),
      }));
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
 * Origin ids that stay PUBLISHED but must not be selected.
 *
 * `retired` removes an origin from the interface entirely; `disabled` keeps it visible (so the site
 * can still show it and say why) while marking `enabled:false`, which every selector must honour.
 * A source that is temporarily unhealthy, or one kept only as a last-resort fallback, belongs here
 * rather than in `retired` — removing it from the manifest would also remove the fallback.
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
