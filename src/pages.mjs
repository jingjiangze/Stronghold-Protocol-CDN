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
import { ZIP_ROOT } from './names.mjs';
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

/packs/*
  Cache-Control: public, max-age=31536000, immutable

/cdn/*
  Cache-Control: public, max-age=300

/data/*
  Cache-Control: public, max-age=300
`;

/**
 * Assemble the deploy directory: the art tree, the fonts, every manifest rewritten for this
 * origin, the index and the robots file. Returns the directory and the file count.
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
