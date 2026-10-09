// Verify that the git-mount sources really serve the asset branch.
//
// This is the check that decides whether the site may call a git origin "full". The tree on disk
// is verified separately (size + sha256 against cdn/v1/index.json); this verifies the other half of
// the claim, which is that a mirror actually serves those bytes. Size AND sha256 both, because a
// mirror that truncates or re-encodes still answers 200.
//
// Usage: node src/verify-mounts.mjs [sampleSize] [indexPath]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = 'jingjiangze/Stronghold-Protocol-CDN';
const REF_ASSETS = 'assets-raw';

const SOURCES = [
  { id: 'jsdelivr', prefix: `https://cdn.jsdelivr.net/gh/${REPO}@${REF_ASSETS}` },
  { id: 'ghfast', prefix: `https://ghfast.top/https://raw.githubusercontent.com/${REPO}/${REF_ASSETS}` },
  { id: 'ghproxy', prefix: `https://gh-proxy.com/https://raw.githubusercontent.com/${REPO}/${REF_ASSETS}` },
];

const indexPath = process.argv[3] || path.join(process.cwd(), 'site', 'data', 'index.json');
const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
// index.json is { schema, tag, count, bytes, files: { path: { size, sha256 } } } -- the key table
// is nested under `files`, not at the top level.
const index = raw.files || raw;

const keys = Object.keys(index).filter((k) => k.startsWith('assets/') || k.startsWith('fonts/'));

// Spread the sample across the whole keyspace rather than taking the head: a failure confined to
// one directory would be missed by a contiguous slice.
const N = Number(process.argv[2] || 24);
const step = Math.max(1, Math.floor(keys.length / N));
const sample = [];
for (let i = 0; i < keys.length && sample.length < N; i += step) sample.push(keys[i]);

const fetchOk = async (url) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'sp-verify-mounts' } });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      buf,
      ctype: res.headers.get('content-type') || '',
      acao: res.headers.get('access-control-allow-origin') || '',
    };
  } finally {
    clearTimeout(timer);
  }
};

// Every source throws a sporadic "fetch failed" mid-run; retries move the failure between sources
// and paths while the bytes themselves stay correct, so treat one throw as a flake and only report
// a path bad when it never comes back.
const fetchRetry = async (url) => {
  let last;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const got = await fetchOk(url);
      if (got.status === 200) return got;
      last = got;
    } catch (e) {
      last = { status: 0, error: e.message, buf: Buffer.alloc(0), ctype: '', acao: '' };
    }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  return last;
};

let bad = 0;
for (const src of SOURCES) {
  let ok = 0;
  let fail = 0;
  const bads = [];
  for (const key of sample) {
    const want = index[key];
    const got = await fetchRetry(src.prefix + '/' + key.split('/').map(encodeURIComponent).join('/'));
    if (got.status !== 200) {
      fail += 1;
      bads.push(`${key} HTTP ${got.status}${got.error ? ' ' + got.error : ''}`);
      continue;
    }
    const sha = crypto.createHash('sha256').update(got.buf).digest('hex');
    if (got.buf.length !== want.size || sha !== want.sha256) {
      fail += 1;
      bads.push(`${key} size ${got.buf.length}/${want.size} sha ${sha.slice(0, 8)}/${want.sha256.slice(0, 8)}`);
      continue;
    }
    ok += 1;
  }
  const last = sample[sample.length - 1];
  const one = await fetchOk(src.prefix + '/' + last.split('/').map(encodeURIComponent).join('/')).catch(() => null);
  console.log(`${src.id.padEnd(10)} ok ${String(ok).padStart(3)}/${sample.length}  fail ${fail}  ctype=${one?.ctype || '-'}  acao=${one?.acao || 'NONE'}`);
  for (const b of bads.slice(0, 5)) console.log(`   ${b}`);
  bad += fail;
}

console.log(`\n${sample.length} paths x ${SOURCES.length} sources; mismatches = ${bad}`);
console.log(bad === 0 ? 'VERDICT: CLEAN — every sampled byte matches index.json' : 'VERDICT: DIRTY');
process.exit(bad === 0 ? 0 : 1);
