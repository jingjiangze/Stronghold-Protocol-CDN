// The format gate: what may go straight to a public key, and what must wait in staging.
//
// Two invariants here are worth pinning because breaking either is silent and expensive:
//   1. ASSET_EXTENSIONS must be a subset of UPLOAD_EXTENSIONS. A format that may be published but
//      cannot be uploaded is a key nobody can ever write; the gate would look enforced while being
//      unreachable.
//   2. A held claim must never read as an ordinary rejection. promote-uploads.mjs deletes staging
//      bytes for rejections -- if "awaiting audit" shared that path, the audit step would destroy
//      the very bytes it exists to look at.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSET_EXTENSIONS,
  ASSET_TREE_PREFIXES,
  UPLOAD_EXTENSIONS,
  claimIsPublishable,
  cleanNote,
  cleanWhat,
  formatVerdict,
  releaseClaim,
  validateKey,
} from '../src/upload.mjs';

const claimFor = (key, over = {}) => ({
  schema: 1,
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  key,
  stagingKey: `cdn/incoming/aaaaaaaaaaaaaaaaaaaaaaaa/${key.split('/').pop()}`,
  size: 1024,
  sha256: '0'.repeat(64),
  source: 'unit-test',
  what: 'fixture',
  state: 'queued',
  tier: formatVerdict(key).tier,
  claimedAt: '2026-10-14T00:00:00.000Z',
  ...over,
});

test('every publishable format is also uploadable', () => {
  for (const ext of ASSET_EXTENSIONS) {
    assert.ok(UPLOAD_EXTENSIONS.has(ext), `.${ext} may be published but begin/commit would reject it`);
  }
});

test('the asset tree prefixes are the two the client reads bytes from', () => {
  assert.deepEqual(ASSET_TREE_PREFIXES, ['assets/', 'fonts/']);
});

test('format and landing place together decide the tier', () => {
  // Formats measured live (2026-10-14) in index.json / hosted-index.json, under the asset tree.
  for (const key of [
    'assets/char/avatar/char_003_kalts.png',
    'assets/audio/bgm/m_bat_abyssalhunters_intro.mp3',
    'assets/spine/enemy/enemy_10138_xdsnow/enemy_10138_xdsnow.atlas',
    'assets/spine/enemy/enemy_10138_xdsnow/enemy_10138_xdsnow.skel',
    'assets/local/map/common/materials.json',
    'assets/local/scene/act1autochess_m01/scene.bin',
    'assets/local/map/fx/Start_back.obj',
    // 2026-10-20：上传通道开了 mp4（用户指令）。它与 mp3 同属「按 URL 直接取字节的媒体素材」，
    // 所以素材树内必须直发；下面那组用同一扩展名但落在树外来反证「格式 × 落点」这条判据没被放宽。
    'assets/audio/voice/mod_intro.mp4',
    'fonts/noto-sans-sc.ttf',
  ]) {
    assert.equal(formatVerdict(key).tier, 'asset', `${key} is art the client loads by URL`);
  }

  // Same extension, different landing place. This is the whole reason the rule cannot be a bare
  // extension list: .json is both an art payload (materials.json) and metadata (mod manifests).
  for (const key of ['packs/mod-assets/index.json', 'packs/fanpack/pack.json', 'packs/sp-forge-2026-10-13/index.json']) {
    const v = formatVerdict(key);
    assert.equal(v.tier, 'hold', `${key} must wait for audit`);
    assert.match(v.reason, /\/api\/cdn\/upload\/release/);
  }

  // Container and text formats that are not part of the measured asset set, wherever they land.
  for (const key of [
    'packs/sp-forge-2026-10-13/cosmetics-01.zip',
    'assets/packs/core.spine.op.1-5.zip',
    'assets/local/x.txt',
    'packs/mod-assets/README.txt',
    'assets/local/x.ogg',
    // 反证：mp4 只在素材树里直发。同一个扩展名落到 packs/ 仍然要等人工放行 ——
    // 否则「开了 mp4」会被误读成「任何位置都能发视频」。
    'packs/mod-assets/intro.mp4',
  ]) {
    assert.equal(formatVerdict(key).tier, 'hold', `${key} is not a static asset format`);
  }

  assert.equal(formatVerdict('/assets/leading/slash.png').tier, 'asset', 'a leading slash normalizes before the prefix test');
});

test('dangerous formats are still refused outright, not merely held', () => {
  // The bucket domain answers ACAO `*`; an html/svg/js object there is an executable content slot.
  // The gate must not have quietly turned "refuse" into "accept into staging".
  for (const key of ['assets/x.html', 'assets/x.svg', 'assets/x.js', 'assets/x.md', 'assets/x.css', 'cdn/v1/x.json']) {
    assert.equal(validateKey(key).ok, false, `${key} must never be accepted`);
  }
});

test('metadata that lands inside the asset tree is treated as art -- a known, stated blind spot', () => {
  // assets/** is where the client's own art lives, and it also carries per-source folders that
  // hold config (assets/local/<source>/config-*.json). No prefix/format rule can tell those apart
  // from materials.json, so this test pins the *choosen* behaviour instead of leaving it implicit:
  // in-tree art formats publish directly; a manifest someone put under assets/ publishes too.
  // Anything that must be audited belongs under packs/ -- which is where agent-upload.mjs defaults.
  assert.equal(formatVerdict('assets/docs/img/x.json').tier, 'asset');
  assert.equal(formatVerdict('assets/local/sp-four-02a466edd43d/config-983fc33d3181838e.json').tier, 'asset');
  assert.equal(formatVerdict('assets/local/x.zip').tier, 'hold', 'container formats are held even inside the tree');
});

test('cleanNote strips every control character, not just the first', () => {
  // BAD_CHARS has no /g on purpose (a global regex makes .test() stateful). That means a
  // non-global replace used to leave the *second and later* control characters standing -- and
  // this is the text that goes into claim.json and hosted.json. Found while adding the length
  // floor below: a note with a tab and a newline kept the newline.
  const raw = `说明\t带\n换行\u000B和另一个制表符\u0007的一整段足够长的文字`;
  const out = cleanNote(raw, 120);
  assert.equal(/[\u0000-\u001F\u007F]/.test(out), false, 'no control character survives');
  assert.equal(out.length, raw.replace(/[\u0000-\u001F]/g, '').trim().length);
  assert.equal(cleanNote(`带替换符的说明${'很长'.repeat(20)}`, 120).includes(String.fromCharCode(0xfffd)), false);
});

test('a too-short description is refused at the edge, not at the publisher', () => {
  // src/hosted.mjs throws on any group whose `what` is shorter than 10 chars, and that check runs
  // in promote's own test gate -- so a five-character note used to turn every later publish round
  // (and the site deploy) red, including the round that was supposed to clean the file up.
  // Live proof: 2026-10-14, a self-test upload with a 5-character note reddened run 38539951690.
  assert.equal(cleanWhat('闸门验收件').ok, false);
  assert.match(cleanWhat('闸门验收件').reason, /至少 10/);
  const ok = cleanWhat('闸门验收件：格式闸门上线后端到端自测');
  assert.equal(ok.ok, true);
  assert.equal(cleanWhat('').ok, false, 'an empty description is the same trap');
  assert.equal(cleanWhat(`说明${'很'.repeat(300)}`).what.length, 200, 'still capped at 200');
  assert.equal(cleanWhat('带\t制表符和\n换行的说明至少十个字').what.includes('\n'), false, 'control characters go');
});

test('a held claim publishes only after release, and never reads as a rejection', () => {
  const verdict = claimIsPublishable(claimFor('packs/mod-assets/index.json'), { payloadSize: 1024 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.hold, true, 'promote must key off hold to keep the staging bytes');
  assert.match(verdict.reason, /暂存区/);

  // Both legacy states behave the same way -- the hold marker is the tier, not the state.
  for (const state of ['queued', 'verified-at-edge']) {
    assert.equal(claimIsPublishable(claimFor('packs/x.json', { state }), { payloadSize: 1024 }).hold, true);
  }

  assert.equal(claimIsPublishable(claimFor('packs/x.json', { releasedAt: '2026-10-14T01:00:00.000Z' }), { payloadSize: 1024 }).ok, true, 'a released claim publishes');
  assert.equal(claimIsPublishable(claimFor('assets/a/char.png'), { payloadSize: 1024 }).ok, true, 'art is never held');

  // A real defect stays a real rejection: hold must not swallow it.
  const bad = claimIsPublishable(claimFor('packs/x.json'), { payloadSize: 999 });
  assert.equal(bad.ok, false);
  assert.notEqual(bad.hold, true);
  assert.match(bad.reason, /staging 大小/);
});

test('releaseClaim marks once, refuses art, and sanitizes the note', () => {
  const art = releaseClaim(claimFor('assets/a/char.png'), { note: 'nope' });
  assert.equal(art.ok, false);
  assert.match(art.reason, /静态素材/);

  const out = releaseClaim(claimFor('packs/x.json'), {
    note: `已核对 mod 清单\u0000${'长'.repeat(200)}`,
    actor: { actor: 'deadbeefdeadbeef', via: 'browser' },
    at: '2026-10-14T02:00:00.000Z',
  });
  assert.equal(out.ok, true);
  assert.equal(out.claim.releasedAt, '2026-10-14T02:00:00.000Z');
  assert.equal(out.claim.releasedBy, 'deadbeefdeadbeef');
  assert.equal(out.claim.releasedVia, 'browser');
  assert.ok(out.claim.releasedNote.length <= 120, 'the note is capped');
  assert.ok(!/[\u0000-\u001F]/.test(out.claim.releasedNote), 'control characters are stripped');
  assert.equal(out.claim.key, 'packs/x.json', 'the claim keeps its identity');
  assert.equal(out.claim.sha256, '0'.repeat(64));

  const twice = releaseClaim(out.claim, { note: '再放一次' });
  assert.equal(twice.ok, false, 'release is one-way');
  assert.match(twice.reason, /放行过了/);

  // Whatever releaseClaim produces must satisfy the publish gate, or the audit step is a dead end.
  assert.equal(claimIsPublishable(out.claim, { payloadSize: 1024 }).ok, true);
});