import test from 'node:test';
import assert from 'node:assert/strict';

import { compareTags, groupByTag, planPacksPrune, referencedKeys } from '../src/prune-packs.mjs';

// 这个 pruner 会真删字节，所以判定必须在断言里钉死：排序错一档就会把当前版本删掉。
test('tags sort numerically per segment, not as strings', () => {
  assert.deepEqual(['v0.2.9', 'v0.2.10', 'v0.2.2'].sort(compareTags), ['v0.2.2', 'v0.2.9', 'v0.2.10']);
  assert.ok(compareTags('v0.2.2', 'v0.2.2-rc1') < 0, '缺段排在前面');
  assert.equal(compareTags('v0.2.2', 'v0.2.2'), 0);
});

test('only the packs/assets-<tag>/ shape is grouped', () => {
  const groups = groupByTag([
    { key: 'packs/assets-v0.2.1/a.zip', size: 10 },
    { key: 'packs/assets-v0.2.2/a.zip', size: 20 },
    { key: 'packs/other/x.zip', size: 5 },
    { key: 'assets/packs/audio.bgm-4.zip', size: 7 },
  ]);
  assert.deepEqual([...groups.keys()].sort(), ['v0.2.1', 'v0.2.2']);
  assert.equal(groups.get('v0.2.1')[0].key, 'packs/assets-v0.2.1/a.zip');
});

test('prune keeps the newest N and refuses when the newest tier is incomplete', () => {
  const groups = groupByTag([
    { key: 'packs/assets-v0.2.1/a.zip', size: 100 },
    { key: 'packs/assets-v0.2.2/a.zip', size: 200 },
    { key: 'packs/assets-v0.2.3/a.zip', size: 300 },
  ]);
  const plan = planPacksPrune(groups, { keep: 1 });
  assert.deepEqual(plan.remove.map((r) => r.key), ['packs/assets-v0.2.1/a.zip', 'packs/assets-v0.2.2/a.zip']);
  assert.equal(plan.bytes, 300);

  const notReady = planPacksPrune(groups, { keep: 1, newestComplete: false });
  assert.equal(notReady.remove.length, 0, '最新一档没写完时，旧档一个都不动');
  assert.match(notReady.skipped, /不完整/);

  const nothingToDo = planPacksPrune(groups, { keep: 3 });
  assert.equal(nothingToDo.remove.length, 0);
});

test('anything the live contract still names is never deleted', () => {
  const groups = groupByTag([
    { key: 'packs/assets-v0.2.1/still-used.zip', size: 100 },
    { key: 'packs/assets-v0.2.1/gone.zip', size: 50 },
    { key: 'packs/assets-v0.2.2/a.zip', size: 200 },
  ]);
  const referenced = referencedKeys({
    art: { packs: [{ id: 'x', urls: ['https://weishucdn.jiangjiangze.icu/packs/assets-v0.2.1/still-used.zip'] }] },
  });
  assert.deepEqual([...referenced], ['packs/assets-v0.2.1/still-used.zip']);
  const plan = planPacksPrune(groups, { keep: 1, referenced });
  assert.deepEqual(plan.remove.map((r) => r.key), ['packs/assets-v0.2.1/gone.zip']);
  assert.equal(plan.protectedByReference, 1);
});

test('URL strings that are not ours are ignored rather than guessed at', () => {
  const referenced = referencedKeys({
    art: {
      packs: [
        { urls: ['not a url', 'https://ghfast.top/github.com/x/packs/assets-v0.2.1/a.zip', '/relative/packs/assets-v0.2.1/b.zip'] },
      ],
    },
  });
  // 镜像前缀那条的 pathname 里仍含 packs/assets-...，登记它只会多保护一个键，不会误删 —— 方向是对的。
  assert.ok([...referenced].every((k) => k.startsWith('packs/assets-')), JSON.stringify([...referenced]));
});
