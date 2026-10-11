#!/usr/bin/env node
// 发布「源排名」：cdn/v1/rank.json —— 客户端在测速完成前（或测不了速时）按这个次序取源。
//
// 权威数据 = network.json（内地三运营商实测：每源每运营商的 HTTP 成功数与首字节时间），
// 不是本机/CI 的网络视角——GitHub runner 在境外，量出来的链路不代表玩家。
// 没有内地实测的新源（ms-dataset / ms-edge）不编造数字：按 origins.json 的 order 排序并标
// measured:false，等下一次内地实测（tools/measure-cn*.mjs）把它们纳入。
//
// 用法：node src/rank.mjs            # 只打印
//       node src/rank.mjs --write    # 发布到 R2（cdn/v1/rank.json，speedcdn/weishucdn 同桶同文）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { r2Config, putObject } from './r2.mjs';
import { readExtraOrigins, readGitOrigins, readDisabledOrigins, readPreferredOrder } from './origins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARRIERS = ['电信', '联通', '移动'];
const write = process.argv.includes('--write');

const net = JSON.parse(fs.readFileSync(path.join(ROOT, 'network.json'), 'utf8'));
const byHost = new Map((net.sources || []).map((s) => [s.host, s]));
const excluded = new Set((net.excluded || []).map((e) => e.id));

/** 每个启用源的候选项：来自 origins.json（r2 + extras + git origins），按 order 排好。 */
function candidates() {
  const list = [
    { id: 'r2', kind: 'r2', host: 'weishucdn.jiangjiangze.icu', coverage: 'full' },
    ...readExtraOrigins(ROOT).map((o) => ({ id: o.id, kind: o.kind, host: (() => { try { return new URL(o.root).host; } catch { return ''; } })(), coverage: o.coverage })),
    ...readGitOrigins(ROOT).map((o) => ({ id: o.id, kind: o.kind, host: (() => { try { return new URL(o.root).host; } catch { return ''; } })(), coverage: o.coverage })),
  ];
  const parked = readDisabledOrigins(ROOT);
  return list.filter((c) => !parked.has(c.id));
}

/** 取该源在内地的可用性与最差运营商 TTFB（可用性优先：成功率 <4/5 的运营商不参与排序）。 */
function measure(host) {
  const s = byHost.get(host);
  if (!s) return null;
  const ttfb = {}, ok = {};
  let usable = 0;
  for (const c of CARRIERS) {
    const h = s.http?.[c];
    if (!h) continue;
    ok[c] = `${h.ok}/${h.ok + h.bad}`;
    if (h.ok >= 4) { ttfb[c] = h.ttfbMs; usable++; }
  }
  if (!usable) return { measured: true, usable: false, ok, ttfbMs: null };
  return { measured: true, usable: true, ok, ttfbMs: ttfb, worst: Math.max(...Object.values(ttfb)) };
}

const rows = [];
for (const c of candidates()) {
  const m = measure(c.host);
  rows.push({ ...c, ...(m || { measured: false, usable: null, ttfbMs: null }), excluded: excluded.has(c.id) });
}
const order = readPreferredOrder(ROOT);
const rank = (id) => { const i = order.indexOf(id); return i < 0 ? 999 : i; };
rows.sort((a, b) => {
  const ea = a.excluded || a.usable === false, eb = b.excluded || b.usable === false;
  if (ea !== eb) return ea ? 1 : -1;                 // 实测不可用/被排除的排最后
  const ra = rank(a.id), rb = rank(b.id);            // 主序：origins.json 的 order（已按实测最快打头）
  if (ra !== rb) return ra - rb;
  // 未点名的源：按内地实测的最差运营商 TTFB 排（无实测者排在有实测者之后）
  const ta = a.measured && a.ttfbMs ? a.worst : Infinity;
  const tb = b.measured && b.ttfbMs ? b.worst : Infinity;
  return ta - tb;
});

const doc = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  method: 'network.json（内地三运营商实测 TTFB，来源见其 _method）；无实测的新源按 origins.json 的 order 排在其后并标 measured:false',
  measuredAt: net.measuredAt,
  carriers: net.carriers,
  rank: rows.map((r, i) => ({
    n: i + 1, id: r.id, kind: r.kind, host: r.host, coverage: r.coverage,
    measured: r.measured, usable: r.usable, ttfbMs: r.ttfbMs, ok: r.ok, excluded: r.excluded,
  })),
};
const body = `${JSON.stringify(doc, null, 2)}\n`;
console.log(body.split('\n').slice(0, 22).join('\n'));
if (!write) { console.log('(dry run — 加 --write 发布到 cdn/v1/rank.json)'); process.exit(0); }
const config = r2Config();
await putObject(config, 'cdn/v1/rank.json', Buffer.from(body, 'utf8'), { contentType: 'application/json', cacheControl: 'public, max-age=300' });
console.log('published cdn/v1/rank.json');
