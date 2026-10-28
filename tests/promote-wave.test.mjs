// runWave 是 promote 并发化的唯一新增原语：把「一轮处理几条」和「怎么处理一条」分开。
// 它必须保序（report / hosted.json 的写入顺序靠这个可复现），并严守并发上限（R2 的请求速率）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { runWave } from '../src/promote-uploads.mjs';

test('结果按输入顺序返回，与完成先后无关', async () => {
  const delays = [30, 5, 20, 1];
  const out = await runWave(delays, 4, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3]);
});

test('同时最多 limit 条在飞', async () => {
  let live = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  await runWave(items, 3, async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 4));
    live -= 1;
    return true;
  });
  assert.ok(peak <= 3, `并发峰值 ${peak} 超过 3`);
  assert.ok(peak >= 2, `并发峰值 ${peak} —— 这组数据下应当真的并行过，否则这个测试没意义`);
});

test('limit 大于条目数时每条仍只跑一次', async () => {
  const seen = [];
  const out = await runWave(['a', 'b'], 8, async (x) => {
    seen.push(x);
    return x.toUpperCase();
  });
  assert.deepEqual(out, ['A', 'B']);
  assert.deepEqual(seen.sort(), ['a', 'b']);
});

test('空输入不启动任何 worker', async () => {
  let calls = 0;
  const out = await runWave([], 4, async () => {
    calls += 1;
    return 1;
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});

test('limit 为 0 或 NaN 时退化为串行，而不是死锁', async () => {
  for (const limit of [0, Number.NaN]) {
    const order = [];
    const out = await runWave([1, 2, 3], limit, async (n) => {
      order.push(n);
      return n * 2;
    });
    assert.deepEqual(out, [2, 4, 6]);
    assert.deepEqual(order, [1, 2, 3]);
  }
});

test('条目抛错时整波 reject —— 由调用方决定隔离粒度', async () => {
  await assert.rejects(
    () => runWave([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    }),
    /boom/,
  );
});
