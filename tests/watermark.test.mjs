// The watermark decision: does this run stop, or does the published interface still lack something?
//
// This is the most consequential branch in the sync job, because a wrong "skip" is invisible — the
// run reports success and the publication quietly stays where it was. Every case below is a state
// that has actually happened, and the third one is the bug that made the download page keep
// offering the previous release's packages.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ART_SCHEMA, watermarkDecision } from '../src/sync.mjs';

const pack = (id, tag) => ({
  id,
  files: 10,
  size: 1000,
  urls: [
    `https://weishucdn.jiangjiangze.icu/packs/assets-${tag}/${id}.zip`,
    `https://github.com/jingjiangze/Stronghold-Protocol-CDN/releases/download/assets-${tag}/${id}.zip`,
  ],
});

/** A published interface that is fully up to date for `tag`, unless something is overridden. */
const current = (tag = 'v0.2.3', over = {}) => ({
  schema: ART_SCHEMA,
  upstream: { tag },
  syncedAt: '2026-10-10T03:33:08Z',
  verified: { probed: 12561, missing: 0, mismatch: 0, unreachable: 0 },
  art: {
    token: `${tag}-c992aeae`,
    mirrors: [{ id: 'r2' }, { id: 'pages' }],
    packs: [pack('assets-audio-1', tag), pack('assets-spine-1', tag)],
    sources: [{ id: 'fusion' }],
  },
  ...over,
});

const allOpts = { pages: true, packs: true, sources: true };

test('an up-to-date publication is skipped', () => {
  const d = watermarkDecision({ published: current('v0.2.3'), releaseTag: 'v0.2.3', opts: allOpts });
  assert.equal(d.skip, true);
  assert.deepEqual(d.pending, []);
});

test('nothing published yet means there is everything to do', () => {
  const d = watermarkDecision({ published: null, releaseTag: 'v0.2.3', opts: allOpts });
  assert.equal(d.skip, false);
  assert.ok(d.pending.length);
});

// The regression. A run that publishes the interface WITHOUT --packs moves the tag and carries the
// packs forward, so `published.upstream.tag` matches, the schema matches and verification is clean
// — every old clause passes — while the packs and both download zips still belong to the previous
// release. The job would then skip forever and the page would keep offering the old packages.
test('packs left pointing at an older release are not "nothing to do"', () => {
  const published = current('v0.2.3');
  published.art.packs = [pack('assets-audio-1', 'v0.2.2'), pack('assets-spine-1', 'v0.2.2')];
  const d = watermarkDecision({ published, releaseTag: 'v0.2.3', opts: allOpts });
  assert.equal(d.skip, false, 'the tag matching must not hide that the packs are from another release');
  assert.match(d.pending.join(' '), /2 of 2 packs still point at an older release/);
  assert.match(d.pending.join(' '), /assets-audio-1/);
});

test('one stale pack is enough to continue', () => {
  const published = current('v0.2.3');
  published.art.packs = [pack('assets-audio-1', 'v0.2.3'), pack('assets-spine-1', 'v0.2.2')];
  const d = watermarkDecision({ published, releaseTag: 'v0.2.3', opts: allOpts });
  assert.equal(d.skip, false);
  assert.match(d.pending.join(' '), /1 of 2 packs/);
});

// A run without --packs cannot rebuild them, so flagging staleness there would cost a full 505 MB
// download to learn nothing.
test('stale packs are ignored when this run cannot pack anyway', () => {
  const published = current('v0.2.3');
  published.art.packs = [pack('assets-audio-1', 'v0.2.2')];
  const d = watermarkDecision({
    published,
    releaseTag: 'v0.2.3',
    opts: { pages: false, packs: false, sources: false },
  });
  assert.equal(d.skip, true);
});

test('an absent pack channel is its own reason', () => {
  const published = current('v0.2.3');
  published.art.packs = [];
  const d = watermarkDecision({ published, releaseTag: 'v0.2.3', opts: allOpts });
  assert.equal(d.skip, false);
  assert.match(d.pending.join(' '), /pack channel is not published/);
});

test('a moved tag, a schema bump, unresolved URLs and a missing extra each hold the run open', () => {
  const cases = [
    [{ upstream: { tag: 'v0.2.2' } }, /upstream tag moved/],
    [{ schema: ART_SCHEMA - 1 }, /schema \d+, this code publishes/],
    [{ verified: { probed: 100, missing: 7 } }, /7 URLs unresolved/],
  ];
  for (const [over, want] of cases) {
    const d = watermarkDecision({ published: current('v0.2.3', over), releaseTag: 'v0.2.3', opts: allOpts });
    assert.equal(d.skip, false, JSON.stringify(over));
    assert.match(d.pending.join(' '), want);
  }

  const noPages = current('v0.2.3');
  noPages.art.mirrors = [{ id: 'r2' }];
  assert.match(
    watermarkDecision({ published: noPages, releaseTag: 'v0.2.3', opts: allOpts }).pending.join(' '),
    /pages origin is not published/,
  );

  const noSources = current('v0.2.3');
  noSources.art.sources = [];
  assert.match(
    watermarkDecision({ published: noSources, releaseTag: 'v0.2.3', opts: allOpts }).pending.join(' '),
    /extra sources are not published/,
  );
});

// A pack with no URLs at all is broken rather than stale, and must not be reported as "an older
// release" — a wrong reason sends the reader looking in the wrong place.
test('a pack with no urls is not described as pointing at an older release', () => {
  const published = current('v0.2.3');
  published.art.packs = [{ id: 'assets-audio-1', files: 1, size: 1, urls: [] }];
  const d = watermarkDecision({ published, releaseTag: 'v0.2.3', opts: allOpts });
  assert.equal(d.skip, true);
});
