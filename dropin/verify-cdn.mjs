#!/usr/bin/env node
// Check that a deployment really serves its art from the CDN: fetch the manifests from the running
// server, confirm every art URL points at the CDN, and probe a sample of them.
//
//   node verify-cdn.mjs [http://127.0.0.1:3000]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const EXPECTED = process.env.SP_CDN_BASE || '__SP_CDN_BASE__';
// In localize mode the manifests are passed through untouched, so the correct expectation is the
// opposite one: relative paths, answered by this sidecar from local disk.
const LOCALIZED = /^(1|true|yes)$/i.test(process.env.SP_LOCALIZE || '') || process.argv.includes('--localized');
const MANIFESTS = ['/data/assets.json', '/data/local-assets.json', '/data/emotes.json'];

let total = 0;
let onCdn = 0;
let local = 0;
const urls = new Set();

for (const manifest of MANIFESTS) {
  let text;
  try {
    const res = await fetch(`${base}${manifest}`);
    if (!res.ok) continue;
    text = await res.text();
  } catch {
    continue;
  }
  for (const match of text.matchAll(/"((?:https?:\/\/[^"]+)?\/(?:assets|fonts)\/[^"]*)"/g)) {
    const url = match[1];
    total++;
    if (url.startsWith(EXPECTED)) {
      onCdn++;
      urls.add(url);
    } else if (url.startsWith('/')) {
      local++;
      // Localize mode: a relative path is the correct shape, and it is answered by this sidecar.
      if (LOCALIZED) urls.add(`${base}${url}`);
    }
  }
}

if (LOCALIZED) {
  console.log(`manifests: ${total} art URLs — ${local} relative (served by this sidecar), ${onCdn} absolute`);
  console.log('  localize mode: the manifests must stay relative, so absolute ones would be wrong');
} else {
  console.log(`manifests: ${total} art URLs — ${onCdn} on the CDN, ${local} still local`);
  if (local) console.log('  (local ones mean the deployment is not being served through the CDN)');
}

const sample = [...urls].filter((_, i) => i % Math.max(1, Math.floor(urls.size / 20)) === 0).slice(0, 20);

// A partial pack set is legitimate, so a manifest sample can legitimately miss every unpacked
// file. In localize mode, therefore, also sample the unpacked tree itself: those answers must
// come from local disk, which is the thing this mode is for.
function unpackedSample(limit = 8) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.sp-assets');
  const out = [];
  const walk = (rel) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.')) continue; // the localize marker, not an asset
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(`/${child}`);
    }
  };
  walk('');
  return out;
}
let ok = 0;
let localServed = 0;
const bad = [];
const unreachable = [];
for (const url of sample) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(25000) });
      if (res.ok) {
        ok++;
        // Localize mode: count how much really came from the unpacked tree. A partial pack set is
        // legitimate — the rest falls back to the server or the CDN — so this is a ratio, not a
        // pass/fail on its own, but zero local answers means localize mode is not working at all.
        if (LOCALIZED && res.headers.get('x-sp') === 'local') localServed++;
      } else bad.push(`${res.status} ${url}`);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  // A probe that could not complete says nothing about the CDN — only a non-200 does.
  if (lastError) unreachable.push(`${lastError.message} ${url}`);
}
console.log(`probe: ${ok}/${sample.length} manifest URLs answered${LOCALIZED ? `, ${localServed} from local disk` : ''}`);

let localOk = 0;
let localTotal = 0;
if (LOCALIZED) {
  const files = unpackedSample();
  localTotal = files.length;
  for (const file of files) {
    try {
      const res = await fetch(`${base}${file}`, { method: 'HEAD', signal: AbortSignal.timeout(25000) });
      if (res.ok && res.headers.get('x-sp') === 'local') localOk++;
      else bad.push(`not local (${res.status}): ${file}`);
    } catch (error) {
      bad.push(`${error.message} ${file}`);
    }
  }
  if (localTotal) console.log(`unpacked tree: ${localOk}/${localTotal} sampled files served from local disk`);
  else console.log('unpacked tree: nothing unpacked yet (.sp-assets is empty)');
}
for (const line of bad.slice(0, 10)) console.log(`  ! ${line}`);
for (const line of unreachable.slice(0, 5)) console.log(`  ~ could not probe from here: ${line}`);

const pass = LOCALIZED
  ? total > 0 && local === total && bad.length === 0 && localOk > 0
  : total > 0 && local === 0 && bad.length === 0;
if (pass) {
  console.log(LOCALIZED ? 'OK: art is served locally by this sidecar' : 'OK: art is served from the CDN');
  process.exit(0);
}
console.log(LOCALIZED ? 'FAIL: localize mode is not serving the art' : 'FAIL: the deployment is not fully on the CDN');
process.exit(1);
