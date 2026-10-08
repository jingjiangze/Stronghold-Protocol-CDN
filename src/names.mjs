// Names and layout constants shared by the sync job.
//
// Everything here is derived from the upstream release package layout (see upstream
// `tools/package.mjs`): the zips hold one top folder, and the full package adds the art the
// manifest lists. Nothing about it is guessed at run time — if a name stops matching, the job
// fails loudly instead of mirroring the wrong thing.

/** The single top folder inside the upstream zips. */
export const ZIP_ROOT = 'Stronghold-Protocol';

/** `<ZIP_ROOT>/public/assets` — the art tree, mirrored to `assets/`. */
export const ZIP_ASSETS_DIR = `${ZIP_ROOT}/public/assets`;
/** `<ZIP_ROOT>/public/fonts` — mirrored to `fonts/`. */
export const ZIP_FONTS_DIR = `${ZIP_ROOT}/public/fonts`;
/** Manifests the client reads; also the source of truth for "what must exist". */
export const ZIP_DATA_FILES = [
  `${ZIP_ROOT}/data/assets.json`,
  `${ZIP_ROOT}/data/local-assets.json`,
];
/** Content packs, when the release ships any (upstream docs/PACKS.md). */
export const ZIP_PACKS_DIR = `${ZIP_ROOT}/packs`;

/** Prefixes this repository owns on the bucket. Everything else belongs to other lines. */
export const OWNED_PREFIXES = ['assets/', 'fonts/', 'data/', 'cdn/', 'packs/'];

/** Root-level objects owned by exact name — `robots.txt` only works from the root. */
export const OWNED_KEYS = ['robots.txt'];

/** Manifest keys whose URL strings get rewritten to absolute CDN URLs. */
export const REWRITE_PREFIXES = ['/assets/', '/fonts/'];

export const fullZipName = (tag) => `Stronghold-Protocol-${tag}.zip`;
export { fullZipName as FULL_ZIP_NAME };

/** Unzip include patterns: selective extraction keeps the 428 MB package from being unpacked. */
export function zipIncludePatterns() {
  return [
    `${ZIP_ASSETS_DIR}/*`,
    `${ZIP_FONTS_DIR}/*`,
    ...ZIP_DATA_FILES,
    `${ZIP_PACKS_DIR}/*`,
  ];
}
