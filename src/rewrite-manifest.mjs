// Rewrite the upstream manifests so every art URL points at the CDN, with a version token.
//
// The client reads `data/assets.json` and requests exactly the URLs it finds there, so this is
// the only place a source swap has to happen. Two properties matter:
//
//   · it is a pure string transform — the surrounding JSON formatting, key order and every
//     non-art value are preserved byte for byte (the game server also parses this file);
//   · the `?v=<tag>` token is what makes the CDN's immutable caching safe. Without it a changed
//     file under an unchanged URL would keep serving the old bytes from the edge cache.
import { REWRITE_PREFIXES } from './names.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `"/assets/…"` and `"/fonts/…"` strings → `"<base>/assets/…?v=<version>"`. */
export function rewriteManifestText(text, { base, version = '' } = {}) {
  if (!base) throw new Error('rewriteManifestText: base is required');
  const trimmed = String(base).replace(/\/+$/, '');
  const token = version ? `?v=${encodeURIComponent(version)}` : '';
  const alternation = REWRITE_PREFIXES.map(escapeRe).join('|');
  const pattern = new RegExp(`"((?:${alternation})[^"]*)"`, 'g');

  let count = 0;
  const out = text.replace(pattern, (_match, p) => {
    count++;
    return `"${trimmed}${p}${token}"`;
  });
  return { text: out, count };
}

/**
 * Every `/assets/…` and `/fonts/…` path the manifest references, deduplicated.
 * This is the acceptance list: each of these must resolve on the CDN.
 */
export function collectManifestPaths(text) {
  const alternation = REWRITE_PREFIXES.map(escapeRe).join('|');
  const pattern = new RegExp(`"((?:${alternation})[^"]*)"`, 'g');
  const out = new Set();
  for (const match of text.matchAll(pattern)) out.add(match[1]);
  return [...out].sort();
}

/** Absolute CDN URLs for the manifest's paths, in the same order. */
export function manifestUrls(text, { base, version = '' } = {}) {
  const trimmed = String(base).replace(/\/+$/, '');
  const token = version ? `?v=${encodeURIComponent(version)}` : '';
  return collectManifestPaths(text).map((p) => `${trimmed}${p}${token}`);
}
