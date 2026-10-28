#!/usr/bin/env node
// Delete the copies R2 keeps of files git already stores.
//
// R2 is upload staging only now (2026-10-28 用户指令); the durable copy of every asset is the
// `assets-raw` git branch (which the ModelScope dataset then mirrors). This removes the duplicate
// from the bucket, but only for a key whose path exists in `assets-raw` **with the same size** —
// anything without a verified twin stays, so a bug here can only under-delete.
//
//   node tools/purge-r2-mirror.mjs                 # dry run: report what would go
//   node tools/purge-r2-mirror.mjs --apply         # actually delete (capped by --max)
//   node tools/purge-r2-mirror.mjs --apply --include-packs
//
// Never touches: cdn/incoming/ (staging), cdn/removals/ (requests), cdn/v1/ (interface files the
// pipelines still read), data/ (client manifests), and packs/lineup-library/ (live aliases).
import { execFileSync } from 'node:child_process';

import { deleteObject, listKeys, r2Config } from '../src/r2.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'jingjiangze/Stronghold-Protocol-CDN';
const REF = process.env.SP_PURGE_REF || 'assets-raw';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();

const APPLY = process.argv.includes('--apply');
const INCLUDE_PACKS = process.argv.includes('--include-packs');
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : fallback;
};
const MAX = arg('max', 500);
const CONCURRENCY = arg('concurrency', 4);

// Prefixes whose bytes are mirrored in git. `packs/` is opt-in: its zips are built artifacts, not
// art, and the audit that cleared them is only true while packs.mjs keeps publishing to Releases.
const PREFIXES = ['assets/', 'fonts/', ...(INCLUDE_PACKS ? ['packs/'] : [])];
const KEEP_PREFIXES = ['packs/lineup-library/'];

const mib = (n) => (n / 1048576).toFixed(1);

const gitTree = async () => {
  const sizes = new Map();
  let url = `https://api.github.com/repos/${REPO}/git/trees/${REF}?recursive=1`;
  for (let page = 0; page < 10; page++) {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`git tree ${REF} → HTTP ${res.status} ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    if (json.truncated) throw new Error('git tree response truncated; refusing to delete anything');
    for (const entry of json.tree) {
      if (entry.type === 'blob') sizes.set(entry.path, entry.size);
    }
    if (!json.next_url) break;
    url = json.next_url;
  }
  return sizes;
};

const main = async () => {
  const config = r2Config(process.env);
  const tree = await gitTree();
  console.log(`${REF}: ${tree.size} blobs`);

  const doomed = [];
  const kept = { sizeMismatch: 0, missingInGit: 0, protectedPrefix: 0 };
  for (const prefix of PREFIXES) {
    const rows = await listKeys(config, prefix);
    console.log(`R2 ${prefix}: ${rows.length} keys`);
    for (const row of rows) {
      if (KEEP_PREFIXES.some((p) => row.key.startsWith(p))) {
        kept.protectedPrefix++;
        continue;
      }
      const size = tree.get(row.key);
      if (size === undefined) {
        // `packs/` never lives in git, so "no twin there" is expected — it stays either way.
        kept.missingInGit++;
        continue;
      }
      if (size !== row.size) {
        kept.sizeMismatch++;
        continue;
      }
      doomed.push(row);
    }
  }

  const bytes = doomed.reduce((s, r) => s + r.size, 0);
  console.log(
    `\nverified duplicates: ${doomed.length} (${mib(bytes)} MiB)\n` +
      `kept: size mismatch ${kept.sizeMismatch}, no twin in git ${kept.missingInGit}, ` +
      `protected ${kept.protectedPrefix}`,
  );
  for (const row of doomed.slice(0, 15)) console.log(`  ${mib(row.size)} MiB  ${row.key}`);
  if (doomed.length > 15) console.log(`  … ${doomed.length - 15} more`);

  const summary = [
    '### purge-r2-mirror',
    '',
    `mode: ${APPLY ? 'apply' : 'dry run'}${INCLUDE_PACKS ? ' (packs included)' : ''}`,
    `verified duplicates: **${doomed.length}** (${mib(bytes)} MiB)`,
    `kept — size mismatch: ${kept.sizeMismatch}, no twin: ${kept.missingInGit}, protected: ${kept.protectedPrefix}`,
  ];

  if (!APPLY) {
    console.log('\ndry run; nothing deleted. Re-run with --apply.');
  } else {
    const slice = doomed.slice(0, MAX);
    if (doomed.length > slice.length) console.log(`\ncapped at --max=${MAX}; ${doomed.length - slice.length} left for the next run`);
    let deleted = 0;
    let failed = 0;
    let freed = 0;
    const queue = [...slice];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        try {
          await deleteObject(config, row.key);
          deleted++;
          freed += row.size;
        } catch (error) {
          failed++;
          console.log(`  FAILED ${row.key}: ${error.message}`);
        }
      }
    });
    await Promise.all(workers);
    console.log(`\ndeleted ${deleted} (${mib(freed)} MiB), failed ${failed}`);
    summary.push('', `deleted **${deleted}** (${mib(freed)} MiB), failed ${failed}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  }
};

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
