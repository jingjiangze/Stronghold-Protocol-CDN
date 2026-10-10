import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readGitOrigins, GIT_PROBE_PATH, capabilitiesOf, withCapabilities, readDisabledOrigins } from '../src/origins.mjs';
import { carryForwardOrigins } from '../src/sync.mjs';

function withOriginsJson(doc, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-origins-'));
  fs.writeFileSync(path.join(dir, 'origins.json'), JSON.stringify(doc));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('git origins are read with their own probe path and coverage', () => {
  const out = withOriginsJson(
    {
      gitOrigins: [
        { id: 'jsdelivr', root: 'https://cdn.jsdelivr.net/gh/o/r@main/' },
        { id: 'statically', root: 'https://cdn.statically.io/gh/o/r@main', coverage: 'partial', note: 'n' },
      ],
    },
    readGitOrigins,
  );
  assert.equal(out.length, 2);
  // trailing slash must not survive into a doubled-slash url
  assert.equal(out[0].root, 'https://cdn.jsdelivr.net/gh/o/r@main');
  assert.equal(out[0].kind, 'git');
  assert.equal(out[0].probe, GIT_PROBE_PATH);
  assert.equal(out[0].coverage, 'partial');
  assert.equal(out[1].note, 'n');
});

test('a git origin with a non-https or private root is dropped, not fatal', () => {
  const out = withOriginsJson(
    {
      gitOrigins: [
        { id: 'ok', root: 'https://cdn.jsdelivr.net/gh/o/r@main' },
        { id: 'plain', root: 'http://cdn.jsdelivr.net/gh/o/r@main' },
        { id: 'local', root: 'https://127.0.0.1/gh/o/r@main' },
        { id: 'norooot' },
      ],
    },
    readGitOrigins,
  );
  assert.deepEqual(out.map((o) => o.id), ['ok']);
});

test('a missing or malformed origins.json yields no git origins', () => {
  assert.deepEqual(readGitOrigins(path.join(os.tmpdir(), 'sp-does-not-exist')), []);
  const out = withOriginsJson({ gitOrigins: 'not-an-array' }, readGitOrigins);
  assert.deepEqual(out, []);
});

// The regression that made the site show only r2: the Pages origin is pushed only when --pages is
// passed, so a run without it used to republish an interface claiming pages never existed.
test('an origin not rebuilt by this run is carried forward from the published interface', () => {
  const current = [{ id: 'r2', kind: 'r2', root: 'https://a.test', base: 'https://a.test/assets/' }];
  const published = [
    { id: 'r2', kind: 'r2', root: 'https://a.test', base: 'https://a.test/assets/' },
    { id: 'pages', kind: 'pages', root: 'https://b.test', base: 'https://b.test/assets/' },
  ];
  const merged = carryForwardOrigins(current, published);
  assert.deepEqual(merged.map((o) => o.id), ['r2', 'pages']);
  assert.equal(merged[1].root, 'https://b.test');
});

test('this run wins on conflict, and a carried origin keeps its probe and coverage', () => {
  const current = [{ id: 'r2', kind: 'r2', root: 'https://NEW.test', base: 'https://NEW.test/assets/' }];
  const published = [
    { id: 'r2', kind: 'r2', root: 'https://OLD.test', base: 'https://OLD.test/assets/' },
    { id: 'jsdelivr', kind: 'git', root: 'https://cdn.jsdelivr.net/gh/o/r@main', probe: '/probe/cdn-probe.bin', coverage: 'partial' },
  ];
  const merged = carryForwardOrigins(current, published);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((o) => o.id === 'r2').root, 'https://NEW.test');
  const git = merged.find((o) => o.id === 'jsdelivr');
  assert.equal(git.probe, '/probe/cdn-probe.bin');
  assert.equal(git.coverage, 'partial');
});

test('carry-forward is a no-op without a published interface, and ignores junk entries', () => {
  const current = [{ id: 'r2', kind: 'r2', root: 'https://a.test', base: 'https://a.test/assets/' }];
  assert.equal(carryForwardOrigins(current, undefined), current);
  assert.equal(carryForwardOrigins(current, []).length, 1);
  const junk = [{ id: 'x' }, { root: 'https://y.test' }, null];
  assert.deepEqual(carryForwardOrigins(current, junk).map((o) => o.id), ['r2']);
});

test('a carried origin without a base gets one derived rather than an undefined field', () => {
  const merged = carryForwardOrigins([], [{ id: 'pages', kind: 'pages', root: 'https://b.test/' }]);
  assert.equal(merged[0].base, 'https://b.test/assets/');
});

// Carry-forward exists so an origin that this run did not produce (Pages needs --pages) is not
// dropped from the published list. The cost is that deleting an entry from origins.json has no
// effect: the published list still names it, so it comes back every run. Statically lived on in the
// live interface that way, measured at 2958 ms and truncating payloads, long after removal.
test('a retired origin is not carried forward', () => {
  const published = [
    { id: 'pages', root: 'https://spages.test' },
    { id: 'statically', root: 'https://cdn.statically.io/gh/x@main' },
  ];
  const current = [{ id: 'r2', root: 'https://weishucdn.test' }];
  const merged = carryForwardOrigins(current, published, new Set(['statically']));
  assert.deepEqual(merged.map((o) => o.id).sort(), ['pages', 'r2'], 'statically must stay gone');
});

test('without a retired set nothing changes, so the Pages case still works', () => {
  const published = [{ id: 'pages', root: 'https://spages.test' }];
  const merged = carryForwardOrigins([{ id: 'r2', root: 'https://weishucdn.test' }], published);
  assert.deepEqual(merged.map((o) => o.id).sort(), ['pages', 'r2']);
});

// The shipped file must actually name it, or the removal above never takes effect.
test('the shipped origins.json retires statically', () => {
  const cfg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'origins.json'), 'utf8'));
  assert.ok(Array.isArray(cfg.retired), 'origins.json needs a retired array');
  assert.ok(cfg.retired.includes('statically'), 'statically must be listed as retired');
  assert.ok(!(cfg.gitOrigins || []).some((o) => o.id === 'statically'), 'and must not also be declared');
});

// --- capability fields (Stage 2) ---------------------------------------------------------------
// The whole point of these is that a SELECTOR can ask "may I use this source for art" instead of
// guessing from the id. They are derived, so a new origins.json entry cannot get them wrong.

test('assetEligible/fontEligible follow coverage: a partial mount is not an art source', () => {
  const partial = capabilitiesOf({ root: 'https://cdn.jsdelivr.net/gh/o/r@main', coverage: 'partial' });
  assert.equal(partial.assetEligible, false);
  assert.equal(partial.fontEligible, false);
  const full = capabilitiesOf({ root: 'https://cdn.jsdelivr.net/gh/o/r@assets-raw', coverage: 'full' });
  assert.equal(full.assetEligible, true);
  assert.equal(full.fontEligible, true);
  // No coverage field at all (r2 / pages) means a full mirror, not a partial one.
  assert.equal(capabilitiesOf({ root: 'https://weishucdn.example' }).assetEligible, true);
});

test('a relay is usable but not a default candidate (direct:false, proxied:true)', () => {
  const relay = capabilitiesOf({ root: 'https://gitcdn.example', note: '自有域中转（sp-git-mount-relay）' });
  assert.equal(relay.direct, false);
  assert.equal(relay.proxied, true);
  assert.equal(relay.assetEligible, true, 'a relay still carries the bytes');
  const plain = capabilitiesOf({ root: 'https://weishucdn.example' });
  assert.equal(plain.direct, true);
  assert.equal(plain.proxied, undefined, 'a direct origin must not carry a proxied flag');
});

test('two domains on one R2 bucket share a fault domain, so they are not counted as two mirrors', () => {
  const a = capabilitiesOf({ root: 'https://weishucdn.jiangjiangze.icu' });
  const b = capabilitiesOf({ root: 'https://weishucdn2.jiangjiangze.icu' });
  assert.equal(a.faultDomain, 'r2-bucket');
  assert.equal(b.faultDomain, 'r2-bucket');
  // A different host is its own domain.
  assert.equal(capabilitiesOf({ root: 'https://spages.jiangjiangze.icu' }).faultDomain, 'spages.jiangjiangze.icu');
});

test('every published git origin carries the capability fields', () => {
  const out = withOriginsJson(
    { gitOrigins: [{ id: 'jsdelivr-assets', root: 'https://cdn.jsdelivr.net/gh/o/r@assets-raw', coverage: 'full' }] },
    readGitOrigins,
  );
  const o = out[0];
  for (const f of ['enabled', 'assetEligible', 'fontEligible', 'supportsRange', 'direct', 'faultDomain']) {
    assert.ok(f in o, `a published origin is missing ${f}`);
  }
  assert.equal(o.assetEligible, true);
});

test('disabled is a soft off-switch: published but not selectable', () => {
  assert.deepEqual([...readDisabledOrigins(path.join(os.tmpdir(), 'sp-does-not-exist'))], []);
  const set = withOriginsJson({ disabled: ['ghfast-assets', 42, null] }, readDisabledOrigins);
  assert.deepEqual([...set], ['ghfast-assets'], 'only string ids count');
  // withCapabilities honours an explicit enabled:false and defaults to enabled otherwise.
  assert.equal(withCapabilities({ root: 'https://x.test' }).enabled, true);
  assert.equal(withCapabilities({ root: 'https://x.test', enabled: false }).enabled, false);
});

test('the shipped origins.json declares a disabled array (even when empty)', () => {
  const cfg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'origins.json'), 'utf8'));
  assert.ok(Array.isArray(cfg.disabled), 'origins.json needs a disabled array so the off-switch is discoverable');
});
