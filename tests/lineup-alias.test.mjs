import test from 'node:test';
import assert from 'node:assert/strict';

import { aliasKeyFor, selectLatestLineups, syncLineupAliases } from '../src/lineup-alias.mjs';

test('the newest dated file per mode becomes the stable alias', () => {
  const keys = [
    'packs/lineup-library/mode_single_normal-2026-10-15.jsonl',
    'packs/lineup-library/mode_single_normal-2026-10-17.jsonl',
    'packs/lineup-library/mode_multi_hard-2026-10-16.jsonl',
    'packs/lineup-library/mode_single_hard-2026-10-17.jsonl',
    // 以下都不该被选中
    'packs/lineup-library/lineups_mode_single_normal.jsonl', // 别名本身
    'packs/lineup-library/mode-a-b-2026-10-17.jsonl',        // modeId 带连字符，形状不合法
    'packs/lineup-library/manifest.json',                    // 非日期文件
    'packs/lineup-library/mode_single_normal-2026-13-99.jsonl',
  ];
  const out = selectLatestLineups(keys);
  assert.deepEqual(out.map((t) => t.modeId), ['mode_multi_hard', 'mode_single_hard', 'mode_single_normal']);
  assert.equal(out.find((t) => t.modeId === 'mode_single_normal').sourceKey, 'packs/lineup-library/mode_single_normal-2026-10-17.jsonl');
  assert.equal(out.find((t) => t.modeId === 'mode_single_normal').destKey, 'packs/lineup-library/lineups_mode_single_normal.jsonl');
  // 稳定别名不带日期，且与读取器拼的名字一致
  assert.equal(aliasKeyFor('mode_single_normal'), 'packs/lineup-library/lineups_mode_single_normal.jsonl');
});

test('a run copies each mode once, and only when the candidate is not older', async () => {
  const rows = [
    { key: 'packs/lineup-library/mode_single_normal-2026-10-17.jsonl', size: 10 },
    { key: 'packs/lineup-library/mode_multi_hard-2026-10-16.jsonl', size: 10 },
  ];
  const heads = {
    'packs/lineup-library/mode_single_normal-2026-10-17.jsonl': { meta: { sha256: 'aa' } },
    'packs/lineup-library/mode_multi_hard-2026-10-16.jsonl': { meta: { sha256: 'bb' } },
    // 别名已在 2026-10-17：normal 的候选同一天 → 复制；multi_hard 的候选更旧 → 跳过
    'packs/lineup-library/lineups_mode_single_normal.jsonl': { meta: { lineupDate: '2026-10-16' } },
    'packs/lineup-library/lineups_mode_multi_hard.jsonl': { meta: { lineupDate: '2026-10-17' } },
  };
  const copies = [];
  const report = await syncLineupAliases({
    config: {},
    list: async () => rows,
    head: async (_c, k) => heads[k] ?? null,
    copy: async (_c, sourceKey, destKey, opts) => { copies.push({ sourceKey, destKey, opts }); },
    log: () => {},
  });
  assert.equal(report.copied.length, 1);
  assert.equal(report.skipped, 1);
  assert.equal(copies[0].destKey, 'packs/lineup-library/lineups_mode_single_normal.jsonl');
  // 别名必须短缓存（每天覆盖），不能沿用日期文件的 IMMUTABLE
  assert.match(copies[0].opts.cacheControl, /max-age=300/);
  assert.equal(copies[0].opts.meta.lineupDate, '2026-10-17');
  assert.equal(copies[0].opts.contentType, 'application/json');
});

test('one failing mode does not stop the others, and a dry run copies nothing', async () => {
  const rows = [
    { key: 'packs/lineup-library/mode_single_normal-2026-10-17.jsonl', size: 10 },
    { key: 'packs/lineup-library/mode_multi_hard-2026-10-16.jsonl', size: 10 },
  ];
  const copies = [];
  const report = await syncLineupAliases({
    config: {},
    list: async () => rows,
    head: async (_c, k) => (k.endsWith('mode_single_normal-2026-10-17.jsonl') ? { meta: { sha256: 'aa' } } : { meta: { sha256: 'bb' } }),
    copy: async (_c, sourceKey, destKey) => {
      if (destKey.includes('multi_hard')) throw new Error('boom');
      copies.push(destKey);
    },
    log: () => {},
  });
  assert.equal(report.copied.length, 1);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0].error, /boom/);

  const dryCopies = [];
  const dry = await syncLineupAliases({
    config: {}, dry: true, list: async () => rows,
    head: async () => null,
    copy: async (_c, _s, d) => { dryCopies.push(d); },
    log: () => {},
  });
  assert.equal(dryCopies.length, 0);
  assert.equal(dry.copied.length, 2);
});
