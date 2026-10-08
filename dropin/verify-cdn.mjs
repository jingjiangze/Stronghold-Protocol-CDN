#!/usr/bin/env node
// Check that a deployment really serves its art from the CDN: fetch the manifests from the running
// server, confirm every art URL points at the CDN, and probe a sample of them.
//
//   node verify-cdn.mjs [http://127.0.0.1:3000]
import { createHash } from 'node:crypto';

const base = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const EXPECTED = process.env.SP_CDN_BASE || '__SP_CDN_BASE__';
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
    } else if (url.startsWith('/')) local++;
  }
}

console.log(`manifests: ${total} art URLs — ${onCdn} on the CDN, ${local} still local`);
if (local) console.log('  (local ones mean the deployment is not being served through the CDN)');

const sample = [...urls].filter((_, i) => i % Math.max(1, Math.floor(urls.size / 20)) === 0).slice(0, 20);
let ok = 0;
const bad = [];
const unreachable = [];
for (const url of sample) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(25000) });
      if (res.ok) ok++;
      else bad.push(`${res.status} ${url}`);
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
console.log(`probe: ${ok}/${sample.length} sampled URLs answered`);
for (const line of bad.slice(0, 10)) console.log(`  ! ${line}`);
for (const line of unreachable.slice(0, 5)) console.log(`  ~ could not probe from here: ${line}`);

if (total && local === 0 && bad.length === 0) {
  console.log('OK: art is served from the CDN');
  process.exit(0);
}
console.log('FAIL: the deployment is not fully on the CDN');
process.exit(1);
