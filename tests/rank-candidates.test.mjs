// rank.mjs 的候选表：探针路径必须真实存在于 R2 桶，host 必须与 origins.json 的 order 第一位一致。
// 2026-10-19 修的两处回归：探针曾指向只在 git 仓库里的 /probe/cdn-probe.bin（桶上 404），
// host 曾写死 weishucdn（与 order 第一位的 speedcdn 不一致，rank 表里出现两个同源条目）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), '.');
const RANK_SRC = fs.readFileSync(path.join(ROOT, 'src', 'rank.mjs'), 'utf8');
const NET_SRC = fs.readFileSync(path.join(ROOT, 'src', 'network-measure.mjs'), 'utf8');
const origins = JSON.parse(fs.readFileSync(path.join(ROOT, 'origins.json'), 'utf8'));

/** 取 candidates() 里那条硬编码的 r2 条目。 */
function hardcodedR2(src) {
  const m = /\{\s*id:\s*'r2'[\s\S]{0,200}?\}/.exec(src);
  assert.ok(m, 'rank/network 源码里应有一条硬编码的 r2 候选');
  const host = /host:\s*'([^']+)'/.exec(m[0]);
  const probe = /probe:\s*'([^']+)'/.exec(m[0]);
  return { host: host?.[1], probe: probe?.[1] };
}

test('rank.mjs 的 r2 探针路径是桶里真实存在的对象', () => {
  const { probe } = hardcodedR2(RANK_SRC);
  // /probe/cdn-probe.bin 只活在 git 仓库（git 挂载源能取到），R2 桶上 404。
  assert.notEqual(probe, '/probe/cdn-probe.bin', '该路径在 R2 桶上不存在，实时探测每次都在量必然失败的路径');
  assert.match(probe, /^\/cdn\/v1\/probe\.bin$/, `r2 的探针必须是桶里的接口对象，实际是 ${probe}`);
});

test('rank.mjs 与 network-measure.mjs 给 r2 用同一个探针路径与同一个 host', () => {
  const a = hardcodedR2(RANK_SRC);
  const b = hardcodedR2(NET_SRC);
  assert.equal(a.probe, b.probe, `两条链的 r2 探针不一致：rank=${a.probe} network=${b.probe}`);
  assert.equal(a.host, b.host, `两条链的 r2 host 不一致：rank=${a.host} network=${b.host}（两条链必须指向 order 第一位的同一个门牌）`);
});

test('rank.mjs 的 r2 host 与 origins.json 的 order 第一位一致', () => {
  const { host } = hardcodedR2(RANK_SRC);
  const lead = origins.order[0];
  const leadRoot = origins.extraOrigins.find((o) => o.id === lead)?.root;
  const leadHost = leadRoot ? new URL(leadRoot).host : null;
  // order 第一位是 r2 系门牌时，硬编码 host 必须跟着它；否则 rank 表里 r2 与 speedcdn
  // 会各报一个不同门牌，看起来像两个源在竞争排名（实际同桶同字节）。
  if (leadHost && /weishucdn|speedcdn/.test(leadHost)) {
    assert.equal(host, leadHost, `order 第一位是 ${lead}(${leadHost})，硬编码 host 却是 ${host}`);
  }
});

test('health-sweep 覆盖 order 第一位的门牌', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'health-sweep.mjs'), 'utf8');
  const lead = origins.order[0];
  const leadRoot = origins.extraOrigins.find((o) => o.id === lead)?.root;
  const leadHost = leadRoot ? new URL(leadRoot).host : null;
  if (leadHost) {
    assert.ok(src.includes(leadHost), `health-sweep 没测最优先门牌 ${leadHost}（用户已指定它优先）`);
  }
});
