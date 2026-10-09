// Content-hash the site's own JS/CSS references.
//
// A `?v=` token is the usual way to bust a cache, but this zone has a Cache Rule on /js/* that
// ignores the query string: /js/cdn.js?v=2 kept returning the bytes cached under ?v=1 (verified:
// 8,197 B on the custom domain vs 9,136 B on the Pages origin). A path that changes with the
// content cannot be defeated by a cache-key rule, so the files are renamed to
// `<name>.<hash8>.<ext>` and the references rewritten.
//
// Run before the Pages deploy: node src/site-hash.mjs --dir=site
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hash8 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8);

const REF = /(\.\/(?:js|css)\/)([A-Za-z0-9_-]+)\.(js|css)(\?v=\d+)?/g;

/**
 * Rewrite `./js/x.js?v=N` and `./css/x.css?v=N` to content-hashed filenames, in every page.
 *
 * Every top-level .html file participates, not just index.html. A page skipped here keeps
 * pointing at the unhashed name, which no longer exists after the rename, and Pages answers that
 * path with its SPA fallback — an HTML document sent as `text/css`, which the browser discards.
 * The page then renders unstyled, which is what /bandwidth did on 2026-10-09.
 */
export function hashReferences(dir, { log = console.log } = {}) {
  const pages = fs.readdirSync(dir).filter((name) => name.endsWith('.html')).sort();
  const renamed = [];

  // Two passes: rename every referenced asset once, then rewrite every page. Doing it in a
  // single pass would let the first page delete css/cdn.css before the second page looks for it,
  // leaving the second page pointing at a name that no longer exists.
  const assets = new Map();
  for (const page of pages) {
    const html = fs.readFileSync(path.join(dir, page), 'utf8');
    for (const match of html.matchAll(REF)) {
      assets.set(`${match[1]}${match[2]}.${match[3]}`, { prefix: match[1], name: match[2], ext: match[3] });
    }
  }

  const hashedNames = new Map();
  for (const [ref, asset] of assets) {
    const abs = path.join(dir, asset.prefix.slice(2), `${asset.name}.${asset.ext}`);
    if (!fs.existsSync(abs)) continue;
    const hashed = `${asset.name}.${hash8(abs)}.${asset.ext}`;
    const target = path.join(dir, asset.prefix.slice(2), hashed);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(abs, target);
      fs.rmSync(abs);
    }
    hashedNames.set(ref, `${asset.prefix}${hashed}`);
    renamed.push(`${asset.prefix}${hashed}`);
  }

  for (const page of pages) {
    const htmlPath = path.join(dir, page);
    const html = fs.readFileSync(htmlPath, 'utf8').replace(REF, (match, prefix, name, ext) => hashedNames.get(`${prefix}${name}.${ext}`) || match);
    fs.writeFileSync(htmlPath, html, 'utf8');
  }

  log(`site-hash: ${renamed.length} reference(s)${renamed.length ? ` → ${renamed.join(', ')}` : ''}`);
  return renamed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const hit = process.argv.find((a) => a.startsWith('--dir='));
  hashReferences(path.resolve(hit ? hit.slice('--dir='.length) : 'site'));
}
