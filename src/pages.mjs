// Second flat-file origin: Cloudflare Pages.
//
// R2 stays the primary, but a second origin with its own edge cache and its own domain turns
// "the CDN is having a bad day" into a base-URL switch for consumers instead of an outage. The
// deploy directory is the extracted tree plus the interface files, each manifest rewritten for
// this origin's base, so switching origins is a complete switch and not a partial one.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { rewriteManifestText } from './rewrite-manifest.mjs';
import { ZIP_ROOT, ZIP_DOCS_DIR } from './names.mjs';
import { makeProbeBuffer, PROBE_KEY } from './probe-file.mjs';

export const PAGES_PROJECT = process.env.SP_PAGES_PROJECT || 'stronghold-assets-cdn';
/** The pages.dev subdomain exists as soon as the project does; the custom domain rides DNS. */
export function pagesBase(subdomain = PAGES_PROJECT) {
  return `https://${subdomain}.pages.dev`;
}

/**
 * Pages answers with its own edge cache, so the same headers the bucket objects carry have to be
 * restated here: immutable art, short-lived interface files, CORS for crossOrigin images, and no
 * search-engine indexing (same posture as the bucket).
 *
 * `/docs/*` gets an hour, not `immutable`: the art URLs carry a `?v=` token that makes a year
 * correct, and the docs have no such token when read as `/docs/PLAYING.md`. On R2 that case is
 * handled by a rule that keys off the query string; a Pages `_headers` rule cannot, so the docs
 * take the unversioned answer — the same one R2 gives a bare path.
 *
 * The `.md` rule restates the content type. Pages infers `text/markdown` from the extension, which
 * a Chromium test showed does render — but it disagrees with what R2 serves for the same key, and
 * a page with no charset makes the browser guess at Chinese text. Stating both makes the two
 * origins give one answer. (`_headers` rules stack, so this neither replaces nor fights the `/*`
 * rule above it.)
 */
const HEADERS = `/*
  Access-Control-Allow-Origin: *
  Access-Control-Expose-Headers: Content-Length, Content-Range, ETag
  Access-Control-Allow-Methods: GET, HEAD, OPTIONS
  X-Robots-Tag: noindex

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/fonts/*
  Cache-Control: public, max-age=31536000, immutable

/docs/*
  Cache-Control: public, max-age=3600

/docs/*.md
  Content-Type: text/plain; charset=utf-8

/packs/*
  Cache-Control: public, max-age=31536000, immutable

/cdn/*
  Cache-Control: public, max-age=300

/data/*
  Cache-Control: public, max-age=300
`;

/**
 * Assemble the deploy directory: the art tree, the fonts, the official docs, every manifest
 * rewritten for this origin, the index and the robots file. Returns the directory and the file count.
 */
export async function preparePagesDist({ stage, out, manifests, base, tag, indexJson }) {
  // The extracted tree sits under the package's own top folder (ZIP_ROOT), not directly in stage.
  const publicDir = path.join(stage, ZIP_ROOT, 'public');
  if (!fs.existsSync(publicDir)) {
    throw new Error(`preparePagesDist: no extracted tree at ${publicDir}`);
  }
  fs.mkdirSync(out, { recursive: true });
  await fsp.writeFile(path.join(out, '_headers'), HEADERS, 'utf8');

  let files = 0;
  // Only the flat tree: pack zips are ~100 MB and Pages caps a single file at 25 MiB, so packs
  // live on the bucket and the GitHub release only.
  for (const entry of ['assets', 'fonts']) {
    const from = path.join(publicDir, entry);
    if (!fs.existsSync(from)) continue;
    const to = path.join(out, entry);
    if (fs.existsSync(to)) await fsp.rm(to, { recursive: true, force: true });
    await fsp.cp(from, to, { recursive: true });
    files += countFiles(to);
  }

  // The docs come from the package root, not from public/. Pages is the second FULL origin (the
  // site says so, and the mirror table is read that way), so leaving them off here would make that
  // claim false for one of the two origins.
  const docsFrom = path.join(stage, ZIP_DOCS_DIR);
  if (fs.existsSync(docsFrom)) {
    const docsTo = path.join(out, 'docs');
    if (fs.existsSync(docsTo)) await fsp.rm(docsTo, { recursive: true, force: true });
    await fsp.cp(docsFrom, docsTo, { recursive: true });
    files += countFiles(docsTo);
  }

  const dataDir = path.join(out, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  for (const manifest of manifests) {
    const rewritten = rewriteManifestText(manifest.text, { base, version: tag });
    await fsp.writeFile(path.join(dataDir, manifest.name), rewritten.text, 'utf8');
    files++;
  }

  const cdnDir = path.join(out, 'cdn', 'v1');
  fs.mkdirSync(cdnDir, { recursive: true });
  await fsp.writeFile(path.join(cdnDir, 'index.json'), indexJson, 'utf8');
  // The speed-test probe has to exist on every origin, or the others measure as broken.
  await fsp.writeFile(path.join(out, ...PROBE_KEY.split('/')), makeProbeBuffer());
  await fsp.writeFile(path.join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n', 'utf8');
  files += 4;

  return { out, files };
}

function countFiles(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name !== '_headers') total++;
    }
  }
  return total;
}

/**
 * Deploy with wrangler (installed on demand). Credentials come from the environment —
 * CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID — never from this repository's source.
 */
export function deployPages({ dist, project = PAGES_PROJECT, wrangler = 'wrangler@4' }) {
  for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    if (!process.env[name]) throw new Error(`deployPages: ${name} is not set in the environment`);
  }
  const res = spawnSync(
    'npx',
    [
      '--yes',
      wrangler,
      'pages',
      'deploy',
      dist,
      '--project-name',
      project,
      '--branch',
      'main',
      '--commit-dirty=true',
    ],
    { stdio: 'inherit', env: process.env },
  );
  if (res.status !== 0) throw new Error(`wrangler pages deploy failed with status ${res.status}`);
}
