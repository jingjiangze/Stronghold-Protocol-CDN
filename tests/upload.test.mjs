import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOSTED_INDEX_KEY,
  LOG_KEY,
  STAGING_PREFIX,
  UPLOAD_PREFIXES,
  appendToLog,
  buildHostedIndex,
  claimIsPublishable,
  claimKeyFor,
  claimsFromListing,
  cleanNote,
  cleanSource,
  collectReferences,
  emptyLog,
  hostedGroupFor,
  makeId,
  mergeHosted,
  removeKeysFromHosted,
  removalVerdict,
  stagingKeyFor,
  validateKey,
  validateSha,
  validateSize,
} from '../src/upload.mjs';

// 后台唯一的能力是「新增」。这两条是它的边界，写死在测试里，改代码的人必须连带改这里的理由。
test('only the asset prefixes are writable, and only with an allowed extension', () => {
  assert.deepEqual(UPLOAD_PREFIXES, ['assets/', 'fonts/', 'packs/']);
  assert.equal(validateKey('assets/char/avatar/mod_1.png').ok, true);
  assert.equal(validateKey('/assets/char/avatar/mod_1.png').ok, true, '前导斜杠应当被规范化掉');
  assert.equal(validateKey('fonts/mod.ttf').ok, true);
  assert.equal(validateKey('packs/mod-set-1.zip').ok, true);

  // 契约与其它产品线的键，从这里写不进去。
  for (const key of ['cdn/v1/index.json', 'data/assets.json', 'apk/stronghold-v0.2.2.apk', 'site/manifest.json', 'scout/state.json']) {
    const r = validateKey(key);
    assert.equal(r.ok, false, `${key} 必须被拒绝`);
    assert.match(r.reason, /契约与其它产品线/);
  }
});

test('path tricks and executable content are refused', () => {
  for (const key of ['assets/../apk/x.png', 'assets//x.png', 'assets\\x.png', 'assets/x.html', 'assets/x.svg', 'assets/x.js', 'assets/x.css', '', '   ', 42]) {
    assert.equal(validateKey(key).ok, false, `${JSON.stringify(key)} 必须被拒绝`);
  }
  assert.equal(validateKey(`assets/${'x'.repeat(1030)}.png`).ok, false, '键长超 R2 上限');
});

test('digest, size, source and note are validated before anything is written', () => {
  assert.equal(validateSha('A'.repeat(64)).sha256, 'a'.repeat(64), '大写十六进制归一成小写，别因为客户端大小写就拒');
  assert.equal(validateSha('a'.repeat(64)).ok, true);
  assert.equal(validateSha('sha256:' + 'a'.repeat(64)).ok, true, '接受带前缀的写法');
  assert.equal(validateSha('nope').ok, false);
  assert.equal(validateSize(0).ok, false);
  assert.equal(validateSize(1.5).ok, false);
  assert.equal(validateSize(5 * 1024 ** 3 + 1).ok, false, '超过单次 PUT 上限要拒，而不是静默截断');
  assert.equal(cleanSource('demo mod').ok, false, '空格不能进分组 id');
  assert.equal(cleanSource('demo-mod_1').source, 'demo-mod_1');
  assert.equal(cleanNote('a'.repeat(400)).length, 120);
  assert.equal(cleanNote('坏\uFFFD字符'), '坏字符');
});

test('staging keys are namespaced by upload id', () => {
  assert.equal(stagingKeyFor('abc123def456', 'assets/char/x.png'), `${STAGING_PREFIX}abc123def456/x.png`);
  assert.equal(claimKeyFor('abc123def456'), `${STAGING_PREFIX}abc123def456/claim.json`);
  assert.equal(makeId(() => '0123456789abcdef01234567').length, 24);
  assert.throws(() => makeId(() => 'zzzz'), /十六进制/);
});

// 待办来自「列前缀」，不是共享队列文件 —— 所以归并函数必须能从一堆键里认出每个上传的角色。
test('a staging listing becomes one todo per upload, with roles separated', () => {
  const rows = [
    { key: `${STAGING_PREFIX}aaa/x.png`, size: 10 },
    { key: `${STAGING_PREFIX}aaa/claim.json`, size: 200 },
    { key: `${STAGING_PREFIX}bbb/y.png`, size: 30 },
    { key: `${STAGING_PREFIX}ccc/_selftest-1.bin`, size: 40 },
    { key: 'assets/not-mine.png', size: 50 },
  ];
  const groups = claimsFromListing(rows);
  assert.equal(groups.length, 3);
  const aaa = groups.find((g) => g.id === 'aaa');
  assert.equal(aaa.payload.size, 10);
  assert.equal(aaa.claim.size, 200);
  const bbb = groups.find((g) => g.id === 'bbb');
  assert.equal(bbb.claim, null, '只传了字节、没点提交 → 不该被当成待办');
  const ccc = groups.find((g) => g.id === 'ccc');
  assert.deepEqual(ccc.junk, [`${STAGING_PREFIX}ccc/_selftest-1.bin`], '下划线开头的自检键不能当事务对象');
});

test('a claim is publishable only when every field agrees with the bytes', () => {
  const claim = { schema: 1, key: 'assets/char/x.png', size: 10, sha256: 'a'.repeat(64), state: 'queued' };
  assert.equal(claimIsPublishable(claim, { payloadSize: 10 }).ok, true);
  assert.equal(claimIsPublishable(claim, { payloadSize: 11 }).ok, false, '大小与实收不符');
  assert.equal(claimIsPublishable({ ...claim, schema: 9 }).ok, false, '不认识的 schema 不猜');
  assert.equal(claimIsPublishable({ ...claim, state: 'published' }).ok, false, '终态不该出现在待办里');
  assert.equal(claimIsPublishable({ ...claim, key: 'apk/stronghold.apk' }).ok, false);
  assert.equal(claimIsPublishable(null).ok, false);
});

test('hosted.json merge is additive and dedupes by key', () => {
  const doc = { _comment: '保持原样', hosted: [] };
  const g1 = hostedGroupFor({ source: 'demo', what: '一份演示素材', addedAt: '2026-10-10', keysWithSizes: [['assets/a.png', 10], ['assets/b.png', 20]] });
  const first = mergeHosted(doc, g1);
  assert.equal(first.added, 2);
  assert.equal(first.doc.hosted.length, 1);
  assert.equal(first.doc.hosted[0].bytes, 30);
  assert.equal(first.doc._comment, '保持原样', '注释字段不能被发布过程吃掉');

  const again = mergeHosted(first.doc, hostedGroupFor({ source: 'demo', what: '重传与新增', addedAt: '2026-10-10', keysWithSizes: [['assets/b.png', 20], ['assets/c.png', 5]] }));
  assert.equal(again.added, 1);
  assert.equal(again.replaced, 1);
  assert.equal(again.doc.hosted[0].files, 3, '同 id 合并键集，不产生第二个分组');
  assert.deepEqual(again.doc.hosted[0].keys.map((k) => k[0]), ['assets/a.png', 'assets/b.png', 'assets/c.png'], '键要有序，两次运行才产出同一份文件');

  const other = mergeHosted(again.doc, hostedGroupFor({ source: 'other', what: '另一人的素材', addedAt: '2026-10-10', keysWithSizes: [['assets/z.png', 1]] }));
  assert.equal(other.doc.hosted.length, 2);
});

test('the hosted index is sorted, counted, and lives beside the tree view', () => {
  const { doc, json } = buildHostedIndex({
    b: [{ key: 'assets/z.png', size: 2, sha256: 'f'.repeat(64) }],
    a: [{ key: 'assets/a.png', size: 1, sha256: 'e'.repeat(64) }],
  });
  assert.deepEqual(Object.keys(doc.files), ['assets/a.png', 'assets/z.png']);
  assert.equal(doc.totals.files, 2);
  assert.equal(doc.totals.bytes, 3);
  assert.equal(doc.files['assets/a.png'].source, 'a');
  assert.ok(json.endsWith('\n'));
  assert.ok(HOSTED_INDEX_KEY.startsWith('cdn/'), '这张表本身也在契约前缀里，后台写不进它');
});

test('the log keeps the newest entries first', () => {
  let log = emptyLog();
  log = appendToLog(log, { at: '2026-10-10T00:00:00Z', key: 'assets/one.png' }, { keep: 2 });
  log = appendToLog(log, { at: '2026-10-10T01:00:00Z', key: 'assets/two.png' }, { keep: 2 });
  log = appendToLog(log, { at: '2026-10-10T02:00:00Z', key: 'assets/three.png' }, { keep: 2 });
  assert.deepEqual(log.items.map((i) => i.key), ['assets/three.png', 'assets/two.png']);
  assert.ok(LOG_KEY.startsWith('cdn/'));
});

// 撤销的边界比上传更要紧：删错的代价是玩家端静默 404，而且没有回滚副本。
test('removal only accepts backend-published, currently unreferenced keys', () => {
  const base = { logged: true, inUpstreamIndex: false, referenced: null, exists: true };
  assert.equal(removalVerdict('assets/local/x.png', base).ok, true);
  assert.equal(removalVerdict('assets/local/x.png', { ...base, logged: false }).ok, false, '不是后台上线的不许从这里删');
  assert.equal(removalVerdict('assets/audio/bgm/m.png', { ...base, inUpstreamIndex: true }).ok, false, '上游镜像件不许删');
  assert.equal(removalVerdict('assets/packs/a.zip', { ...base, referenced: '线上清单仍写着这个路径' }).ok, false, '仍被引用不许删');
  assert.equal(removalVerdict('assets/gone.png', { ...base, exists: false }).ok, false, '不存在就没什么可删');
  assert.equal(removalVerdict('cdn/v1/art.json', base).ok, false, '契约文件不在可删前缀里');
  assert.equal(removalVerdict('apk/x.apk', base).ok, false, '别人产品线不在可删前缀里');
});

test('de-registering keys from hosted.json keeps other entries and drops empty groups', () => {
  const doc = {
    _comment: '保持',
    hosted: [
      { id: 'a', what: '第一组', keys: [['assets/1.png', 10], ['assets/2.png', 20]], files: 2, bytes: 30 },
      { id: 'b', what: '第二组', keys: [['assets/3.png', 5]], files: 1, bytes: 5 },
    ],
  };
  const onlyOne = removeKeysFromHosted(doc, ['assets/3.png']);
  assert.equal(onlyOne.removed, 1);
  assert.equal(onlyOne.emptied, 1, '整组空了就删掉这一组，别留 files:0 的假保护');
  assert.equal(onlyOne.doc.hosted.length, 1);
  assert.deepEqual(onlyOne.doc.hosted[0].keys.map((k) => k[0]), ['assets/1.png', 'assets/2.png']);
  assert.equal(onlyOne.doc._comment, '保持');

  const partial = removeKeysFromHosted(doc, ['assets/1.png']);
  assert.equal(partial.doc.hosted.length, 2);
  assert.deepEqual(partial.doc.hosted[0].keys.map((k) => k[0]), ['assets/2.png']);
  assert.equal(partial.doc.hosted[0].bytes, 20, '分组体积要重算');
});

test('reference collection covers upstream index, pack urls and manifest text', () => {
  const refs = collectReferences({
    indexFiles: { 'assets/a.png': { size: 1 } },
    packKeys: ['assets/packs/p-4.zip'],
    manifestTexts: ['{"url":"https://weishucdn.jiangjiangze.icu/assets/local/b.png?v=1"}'],
  });
  assert.ok(refs.has('assets/a.png'));
  assert.ok(refs.has('assets/packs/p-4.zip'));
  assert.ok(refs.has('assets/local/b.png'), '清单正文里出现过的路径也算引用');
  assert.equal(refs.has('assets/nope.png'), false);
});
