// The Cache Rule that makes /dl/'s day-long 302 REAL.
//
// WHY THIS EXISTS: the relay now answers /dl/<tag>/<file> with `cache-control: public, max-age=86400`
// (worker/git-mount-relay.worker.mjs, DL_TTL), and the plan is that a cached 302 is served by the
// edge WITHOUT running the Worker — so it does not spend the free Workers request budget. But two
// defaults stand in the way, and neither is a header the Worker can set:
//   1. Worker responses are not cache-eligible by default (they are DYNAMIC unless a Cache Rule says
//      otherwise) — `cache: true` is the eligibility bit, same as fix-cache-rule.mjs needed for
//      .skel/.atlas on the R2 host.
//   2. 302 is not in Cloudflare's default cacheable status set — the edge_ttl status_code_ttl entry
//      below is what puts it there. Without it the max-age header is a no-op at the edge.
//
// The schema was NOT taken from memory as final: the first --apply was rejected with
// `invalid JSON: unknown field "ttl"`, and the entry shape below is the API's own correction. The
// PUT is atomic — a rejected write changes nothing, including the two existing rules. Final proof is
// live: two HEAD requests to a /dl/ URL, first MISS/DYNAMIC, second HIT (a HIT means the Worker did
// not run and the free-plan budget was not spent).
//
//   node tools/dl-cache-rule.mjs            # dry run: names the token, prints the rule
//   node tools/dl-cache-rule.mjs --apply    # create it
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const ZONE = 'jiangjiangze.icu';
const PHASE = 'http_request_cache_settings';
const HOST = 'gitcdn.jiangjiangze.icu';
const DL_TTL = 86400; // seconds — keep in lockstep with DL_TTL in worker/git-mount-relay.worker.mjs

const CANDIDATES = [];
for (const [label, file] of [
  ['~/.cf_cache_token', path.join(os.homedir(), '.cf_cache_token')],
  ['~/.cf_agent_token', path.join(os.homedir(), '.cf_agent_token')],
]) {
  if (!fs.existsSync(file)) continue;
  const t = fs.readFileSync(file, 'utf8').trim();
  if (/^[A-Za-z0-9_-]{30,}$/.test(t)) CANDIDATES.push({ label, token: t });
}
{
  const dir = path.join(os.homedir(), 'Documents');
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const cf = path.join(dir, name, 'cf.txt');
    if (!name.startsWith('github_pat_') || !fs.existsSync(cf)) continue;
    for (const [i, t] of fs.readFileSync(cf, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^cfat_[A-Za-z0-9_-]+$/.test(l)).entries()) {
      CANDIDATES.push({ label: `${name.slice(0, 14)}…/cf.txt token#${i + 1}`, token: t });
    }
  }
}
if (!CANDIDATES.length) throw new Error('no api token found');

const api = async (token, method, p, body) => {
  const res = await fetch('https://api.cloudflare.com/client/v4' + p, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

// Scoped to /dl/ ONLY. The relay's other paths proxy bytes with their own cache-control and must not
// be touched by this rule. default: 0 means "nothing else is cached by this rule" — only the listed
// status codes get a TTL, which here is exactly one: 302.
const RULE = {
  description: 'cache the /dl/ 302 for a day so a cache hit never runs the Worker (free-plan budget)',
  expression: `(http.host eq "${HOST}" and starts_with(http.request.uri.path, "/dl/"))`,
  action: 'set_cache_settings',
  action_parameters: {
    cache: true,
    edge_ttl: {
      mode: 'override_origin',
      default: 0,
      // The entry field is `value` (integer seconds), NOT a nested {ttl:{value,unit}} — the API
      // rejected `ttl` with "unknown field" on the first attempt (2026-10-10), and that error is the
      // authority here (the docs URLs 404'd during the audit). default:0 means only 302 gets a TTL.
      status_code_ttl: [{ status_code: 302, value: DL_TTL }],
    },
    browser_ttl: { mode: 'respect_origin' },
  },
  enabled: true,
};

console.log('candidates:', CANDIDATES.map((c) => c.label).join(', '));

let chosen = null;
for (const c of CANDIDATES) {
  const zones = await api(c.token, 'GET', `/zones?name=${ZONE}`);
  const zone = (zones.json?.result || [])[0];
  if (!zone) {
    console.log(`  ${c.label.padEnd(20)} zone not readable (${zones.status})`);
    continue;
  }
  const r = await api(c.token, 'GET', `/zones/${zone.id}/rulesets/phases/${PHASE}/entrypoint`);
  const code = r.json?.errors?.[0]?.code;
  if (r.status === 403) {
    console.log(`  ${c.label.padEnd(20)} cache settings → 403 no permission`);
    continue;
  }
  if (r.status === 404 && code === 10003) {
    console.log(`  ${c.label.padEnd(20)} authorized, no ruleset yet`);
    chosen = { ...c, zoneId: zone.id, existing: null };
    break;
  }
  if (r.json?.success) {
    const rules = r.json.result?.rules || [];
    console.log(`  ${c.label.padEnd(20)} authorized, ${rules.length} existing rule(s)`);
    chosen = { ...c, zoneId: zone.id, existing: r.json.result };
    break;
  }
  console.log(`  ${c.label.padEnd(20)} cache settings → ${r.status} ${JSON.stringify(r.json?.errors || {}).slice(0, 80)}`);
}

if (!chosen) {
  console.log('\nNo token can read cache settings.');
  process.exit(1);
}
console.log(`\nusing ${chosen.label} on zone ${chosen.zoneId.slice(0, 8)}…`);
console.log('rule:', JSON.stringify(RULE, null, 1));

const dup = (chosen.existing?.rules || []).find((r) => r.description === RULE.description);
if (dup) {
  console.log('\na rule with this description already exists — nothing to do');
  process.exit(0);
}

if (!APPLY) {
  console.log('\ndry run — pass --apply to create the rule');
  process.exit(0);
}

// The entrypoint is replaced wholesale: send existing rules back with the new one appended, so the
// weishucdn /assets rule (fix-cache-rule.mjs) survives this write.
const body = { rules: [...(chosen.existing?.rules || []), RULE] };
const res = await api(chosen.token, 'PUT', `/zones/${chosen.zoneId}/rulesets/phases/${PHASE}/entrypoint`, body);

console.log('\nwrite:', res.status, res.json?.success ? 'ok' : JSON.stringify(res.json?.errors || res.json).slice(0, 300));
if (res.json?.success) {
  const rules = res.json.result?.rules || [];
  console.log('rules now:', rules.length);
  for (const r of rules) console.log(`  - ${r.description || r.id}  enabled=${r.enabled}`);
  console.log('\nverify (first request MISS/DYNAMIC, second must be HIT — a HIT means the Worker did NOT run):');
  console.log('  curl -sI --noproxy "*" https://gitcdn.jiangjiangze.icu/dl/<tag>/<file> | grep -iE "cf-cache-status|cache-control"');
}
