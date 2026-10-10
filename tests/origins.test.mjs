import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readGitOrigins, readDisabledOrigins, GIT_PROBE_PATH } from '../src/origins.mjs';
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

// OpenI is published but parked: bytes are correct and it is the fastest origin measured, but it
// answers Access-Control-Allow-Origin with a hard-coded third-party domain instead of echoing the
// requester, so a browser cannot use it for cross-origin assets. Parking it is `enabled:false` in
// origins.json — and that only works if the reader carries the field through.
test('a git origin marked disabled is published with enabled:false', () => {
  const out = withOriginsJson(
    {
      gitOrigins: [
        { id: 'openi', root: 'https://openi.pcl.ac.cn/j/r/raw/branch/assets-raw', coverage: 'full', enabled: false },
      ],
    },
    readGitOrigins,
  );
  assert.equal(out[0].enabled, false);
});

test('a git origin without the field is not marked disabled', () => {
  const out = withOriginsJson(
    { gitOrigins: [{ id: 'x', root: 'https://cdn.jsdelivr.net/gh/o/r@main', coverage: 'full' }] },
    readGitOrigins,
  );
  assert.equal('enabled' in out[0], false);
});

// `disabled` is the list form of parking an origin; it exists because the same repo publishes from
// two branches whose code reads the flag differently. Listing the id must park the origin even when
// the entry itself says nothing.
test('an id in the disabled list is read as a set', () => {
  const out = withOriginsJson({ disabled: ['openi', '', null] }, readDisabledOrigins);
  assert.equal(out.has('openi'), true);
  assert.equal(out.size, 1, 'blanks are dropped');
});

test('the shipped origins.json parks openi and keeps it listed', () => {
  const origins = readGitOrigins(path.resolve(process.cwd(), '.'));
  const openi = origins.find((o) => o.id === 'openi');
  assert.ok(openi, 'openi must stay in gitOrigins so the site can show it and say why');
  // Parked by the entry AND by the list: either publishing branch must honour it.
  assert.equal(openi.enabled, false);
  const disabled = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'origins.json'), 'utf8')).disabled || [];
  assert.ok(disabled.includes('openi'));
});
