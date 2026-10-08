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

/** Rewrite `./js/x.js?v=N` and `./css/x.css?v=N` to content-hashed filenames. */
export function hashReferences(dir, { log = console.log } = {}) {
  const htmlPath = path.join(dir, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  const renamed = [];

  html = html.replace(/(\.\/(?:js|css)\/)([A-Za-z0-9_-]+)\.(js|css)(\?v=\d+)?/g, (match, prefix, name, ext) => {
    const abs = path.join(dir, prefix.slice(2), `${name}.${ext}`);
    if (!fs.existsSync(abs)) return match;
    const hashed = `${name}.${hash8(abs)}.${ext}`;
    const target = path.join(dir, prefix.slice(2), hashed);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(abs, target);
      fs.rmSync(abs);
    }
    renamed.push(`${prefix}${hashed}`);
    return `${prefix}${hashed}`;
  });

  fs.writeFileSync(htmlPath, html, 'utf8');
  log(`site-hash: ${renamed.length} reference(s) → ${renamed.join(', ')}`);
  return renamed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const hit = process.argv.find((a) => a.startsWith('--dir='));
  hashReferences(path.resolve(hit ? hit.slice('--dir='.length) : 'site'));
}
