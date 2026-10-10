// Cache warming, bounded.
//
// WHY NOT A MOD (see docs/audit/asset-slowness-root-cause.md §28.14 note): Forge's server-module
// surface grants `boot / shutdown / healthz / matchClass` and explicitly no network hook, so mirror
// warming cannot be a mod without breaking the capability model. And WHY NOT UNBOUNDED: R2's free tier
// is 10M Class B ops/month, the third-party mirrors already time out under load, and edge caches are
// PER-COLO — warming the server's colo does almost nothing for a player's colo. So: one pass per
// release token, hot paths only, hard request/byte/time budgets, concurrency capped.
//
// Usage:
//   node tools/warm-cache.mjs [--base=https://weishucdn.jiangjiangze.icu] [--requests=300] [--bytes=200000000]
//                             [--concurrency=4] [--timeout-ms=8000] [--state=.warm-state.json]
// Exit 0 when the pass completed inside budget; 2 when the budget stopped it early (re-run later).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const BASE = String(arg('base', 'https://weishucdn.jiangjiangze.icu')).replace(/\/+$/, '');
const MAX_REQUESTS = Number(arg('requests', 300));
const MAX_BYTES = Number(arg('bytes', 2e8));
const CONCURRENCY = Math.max(1, Number(arg('concurrency', 4)));
const TIMEOUT_MS = Number(arg('timeout-ms', 8000));
const STATE = path.resolve(ROOT, arg('state', '.warm-state.json'));

/** Hot paths only: the battle/first-screen classes a player actually waits on, per classOf(). */
const HOT_PREFIXES = [
  'assets/spine/op/', 'assets/spine/enemy/', 'assets/char/avatar/', 'assets/ui/',
  'assets/local/map/', 'assets/audio/bgm/', 'assets/audio/sfx/',
];

async function main() {
  const art = await (await fetch(`${BASE}/cdn/v1/art.json`, { signal: AbortSignal.timeout(15000) })).json();
  const token = art?.art?.token || art?.token || '';
  if (!token) throw new Error('no release token in art.json');
  const tree = await (await fetch(`${BASE}/cdn/v1/tree.json`, { signal: AbortSignal.timeout(20000) })).json();

  // Real paths, hot prefixes only, smallest-first inside a class: warm many cheap files before the
  // few fat ones, so the first N requests buy the most player-visible coverage.
  const hot = [];
  for (const [dir, info] of Object.entries(tree?.dirs || {})) {
    if (!HOT_PREFIXES.some((p) => dir === p.replace(/\/$/, '') || dir.startsWith(p))) continue;
    for (const f of info.files || []) hot.push({ path: `${dir}/${f[0]}`, size: Number(f[1]) || 0 });
  }
  hot.sort((a, b) => a.size - b.size);

  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  const done = new Set(state[token]?.done || []);
  const queue = hot.filter((h) => !done.has(h.path));
  const budget = { requests: 0, bytes: 0 };
  const stopped = { requests: false, bytes: false };

  async function one(item) {
    if (budget.requests >= MAX_REQUESTS) { stopped.requests = true; return; }
    if (budget.bytes + item.size > MAX_BYTES) { stopped.bytes = true; return; }
    budget.requests += 1;
    budget.bytes += item.size;
    try {
      // `?v=<token>`: immutable at the edge for a year, and it names the release being warmed — a new
      // release gets a fresh URL, which is exactly when a fresh warm pass is worth running.
      const res = await fetch(`${BASE}/${item.path}?v=${token}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      await res.arrayBuffer();
      if (res.status === 200) done.add(item.path);
    } catch { /* a source that will not answer is skipped; the pass continues */ }
  }

  const worker = async () => {
    while (queue.length && !stopped.requests && !stopped.bytes) await one(queue.shift());
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  state[token] = { done: [...done], updatedAt: new Date().toISOString() };
  // Keep only the current token's ledger: a stale release's warmed paths are irrelevant.
  for (const k of Object.keys(state)) if (k !== token) delete state[k];
  fs.writeFileSync(STATE, JSON.stringify(state), 'utf8');

  const out = {
    base: BASE, token, hotPaths: hot.length, warmed: done.size,
    requests: budget.requests, bytes: budget.bytes,
    stoppedByBudget: stopped, complete: queue.length === 0 && !stopped.requests && !stopped.bytes,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.complete ? 0 : 2;
}

await main();
