// rank.mjs / network-measure.mjs 的候选表不变量。
//
// 2026-10-28：R2 不再是访问源（origins.json 已把 r2 / r2-alt / speedcdn 记 retired，桶降级为上传暂存），
// 所以候选表里不允许再出现 R2 条目；原先「r2 探针必须命中桶对象」「r2 host 必须等于 order 第一位」
// 这两条断言编码的是 R2 当家的旧世界，已替换为下面这组。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), '.');
const RANK_SRC = fs.readFileSync(path.join(ROOT, 'src', 'rank.mjs'), 'utf8');
const NET_SRC = fs.readFileSync(path.join(ROOT, 'src', 'network-measure.mjs'), 'utf8');
const HEALTH_SRC = fs.readFileSync(path.join(ROOT, 'tools', 'health-sweep.mjs'), 'utf8');
const origins = JSON.parse(fs.readFileSync(path.join(ROOT, 'origins.json'), 'utf8'));

/** 源码里真正参与探测的候选对象（`{ id: '…', host: … }`），注释行不算。 */
function candidates(src) {
  const out = [];
  for (const line of src.split('\n')) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    const m = /\{\s*id:\s*'([^']+)'([^}]*)\}/.exec(line);
    if (!m) continue;
    out.push({
      id: m[1],
      host: (/host:\s*'([^']+)'/.exec(m[2]) || [])[1],
      probe: (/probe:\s*'([^']+)'/.exec(m[2]) || [])[1],
    });
  }
  return out;
}

const allRoots = [...(origins.extraOrigins || []), ...(origins.gitOrigins || [])];
const rootOf = (id) => allRoots.find((o) => o.id === id)?.root;

test('R2 已退役：候选表里不得再出现 r2 条目', () => {
  const retired = origins.retired || [];
  for (const id of ['r2', 'r2-alt', 'speedcdn']) {
    assert.ok(retired.includes(id), `${id} 必须留在 origins.json 的 retired 里（R2 只做上传暂存）`);
  }
  const rankIds = candidates(RANK_SRC).map((c) => c.id);
  assert.ok(!rankIds.includes('r2'), `rank.mjs 仍把 r2 当候选：${rankIds.join(', ')}`);
  // network-measure 允许保留 r2 作为历史测速口径，但它不能出现在 order 里误导选源。
  assert.ok(!(origins.order || []).includes('r2'), 'r2 不得出现在 order 里');
});

test('任何候选的探针都指向接口对象，而不是只活在 git 里的路径', () => {
  for (const [name, src] of [['rank.mjs', RANK_SRC], ['network-measure.mjs', NET_SRC]]) {
    for (const c of candidates(src)) {
      if (!c.probe) continue;
      assert.notEqual(c.probe, '/probe/cdn-probe.bin', `${name} 的 ${c.id} 探针指向只在 git 里的路径，桶上 404`);
      assert.match(c.probe, /^\//, `${name} 的 ${c.id} 探针必须是根相对路径，实际 ${c.probe}`);
    }
  }
});

test('同一条链路里同一个 id 只用一个 host', () => {
  for (const [name, src] of [['rank.mjs', RANK_SRC], ['network-measure.mjs', NET_SRC]]) {
    const seen = new Map();
    for (const c of candidates(src)) {
      if (!c.host) continue;
      const prev = seen.get(c.id);
      assert.ok(!prev || prev === c.host, `${name} 里 ${c.id} 出现两个 host：${prev} / ${c.host}`);
      seen.set(c.id, c.host);
    }
  }
});

test('health-sweep 覆盖 order 里每个源的门牌', () => {
  for (const id of origins.order || []) {
    const root = rootOf(id);
    assert.ok(root, `order 里的 ${id} 在 origins.json 找不到 root`);
    const host = new URL(root).host;
    assert.ok(HEALTH_SRC.includes(host), `health-sweep 没测最优先门牌 ${host}（${id}）`);
  }
});
