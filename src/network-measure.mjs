#!/usr/bin/env node
// 内地三运营商实测：给 network.json 补上那些「已登记但从未实测」的源。
//
// 为什么要这个脚本（2026-10-14 审计结论）：
//   rank.mjs 的 measured 字段 = 「该源的 host 是否出现在 network.json.sources」。
//   ms-dataset / r2-alt / speedcdn / ms-edge 四条在 origins.json 里登记得好好的，
//   却因为 network.json 没有它们的 host 条目，被 rank 标成 measured:false、usable:null，
//   于是 asset-jump 的 rankQualified() 直接淘汰它们 —— 「动态最快」实际只剩一个源，
//   排序退化为静态 order。这是**数据缺口**，不是代码缺陷，所以修法是补数据。
//
// 为什么只能用 Globalping（不能用 GitHub runner 直测）：
//   runner 在境外。network.json 的文件头写得很清楚：这张表是「内地运营商实测」，
//   用途是决定哪些源能进运行时候选。境外视角量出来的链路不代表玩家，
//   rank.mjs 也因此把 liveProbe 的结果降级为「仅证据、不作降级依据」（down 硬编码 false）。
//   用 runner 直测会把这张表的语义毁掉。
//
// 用法：
//   node src/network-measure.mjs                    # 只打印将要写入的条目
//   node src/network-measure.mjs --write            # 回写 network.json
//   node src/network-measure.mjs --only=ms-dataset,speedcdn
//
// 设计约束：
//   1. **只补不删**：已有条目不动，只 upsert 本次被测的源。历史实测是证据，不能被一轮失败抹掉。
//   2. **测不到就留旧值**：某源这一轮全部失败 ⇒ 保留它原来的条目并加 lastFailedAt，
//      绝不写 measured 但全 0 的空数据进去（那会让 rank 把它判成 usable:false 而永久掉队）。
//   3. **写回前必须通过 parseNetworkTable**：否则 publish 那一步才会炸，且发布出去的是坏数据。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNetworkTable } from './network-table.mjs';
import { readExtraOrigins, readGitOrigins, readDisabledOrigins } from './origins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.globalping.io/v1/measurements';
const TOKEN = process.env.GLOBALPING_TOKEN || '';

const CARRIERS = [
  ['电信', 4134],
  ['联通', 4837],
  ['移动', 9808],
];

const write = process.argv.includes('--write');
const onlyArg = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
const only = onlyArg ? onlyArg.split(',').map((s) => s.trim()).filter(Boolean) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };

/**
 * 候选源 → 需要实测的 (id, host, probe)。只取已启用、且 network.json 里还没有的。
 *
 * **probe 必须按 root 的绝对路径算**：origins.json 里的 probe 是相对 root 的路径，
 * 而 root 可能带子路径（ms-dataset 的 root 是 modelscope.cn/datasets/.../releases/v1-trial）。
 * 直接拿 probe 拼 host 会得到 modelscope.cn/assets/...png（404）——rank.mjs 的 liveProbe
 * 一直在这样探空气，所以那些源的 liveMs 长期为 null。这里用 URL 解析出 pathname 前缀补上。
 * 没有 probe 的条目（如 r2-alt）回落到 root 自带的 pathname + 默认探针名。
 */
function targets(existingHosts) {
  const parked = readDisabledOrigins(ROOT);
  const rows = [
    { id: 'r2', host: 'weishucdn.jiangjiangze.icu', probe: '/cdn/v1/probe.bin' },
    ...readExtraOrigins(ROOT).map((o) => ({ id: o.id, host: hostOf(o.root), probe: absProbe(o) })),
    ...readGitOrigins(ROOT).map((o) => ({ id: o.id, host: hostOf(o.root), probe: absProbe(o) })),
  ].filter((r) => r.host && r.probe && !parked.has(r.id));

  const seen = new Set();
  return rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    if (only) return only.includes(r.id);
    return !existingHosts.has(r.host);   // 默认只补缺口：已有实测的不重复烧额度
  });
}

function hostOf(root) {
  try { return new URL(root).host; } catch { return ''; }
}

/**
 * root + 相对 probe → 可被 Globalping 直接请求的绝对路径。
 * 例：root=https://modelscope.cn/datasets/jingjiangze/.../releases/v1-trial
 *     probe=/assets/char/avatar/x.png
 *   ⇒ /datasets/jingjiangze/.../releases/v1-trial/assets/char/avatar/x.png
 */
function absProbe(o) {
  const p = typeof o.probe === 'string' ? o.probe : '';
  let base = '';
  try { base = new URL(o.root).pathname.replace(/\/+$/, ''); } catch { base = ''; }
  if (p.startsWith('/')) return base ? `${base}${p}` : p;
  if (p) return base ? `${base}/${p}` : `/${p}`;
  // 没写 probe：root 自带子路径的（数据集类）用 256KiB 探针，裸域的用根目录探针。
  return base ? `${base}/cdn/v1/probe.bin` : '/cdn/v1/probe.bin';
}

/**
 * 一次 Globalping HTTP 测量（单运营商）。返回 { ok, bad, ttfbMs[] }。
 * 只认 statusCode 200：重定向落到 HTML 错误页（R2 404 会返 28KB 的 text/html）不算成功，
 * 这正是 rank.mjs 的 liveProbe 里 `ct.includes('html')` 判失败的同一条规矩。
 */
async function measure(host, probePath, asn) {
  const body = {
    type: 'http',
    target: host,
    locations: [{ country: 'CN', asn }],
    measurementOptions: { protocol: 'HTTPS', request: { path: probePath, method: 'GET' } },
    limit: 5,
  };
  const res = await fetch(API, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { error: `HTTP ${res.status} ${t.slice(0, 120)}` };
  }
  const { id } = await res.json();
  for (let i = 0; i < 50; i++) {
    await sleep(2500);
    const r = await fetch(`${API}/${id}`, { headers });
    if (!r.ok) return { error: `poll ${r.status}` };
    const j = await r.json();
    if (j.status === 'finished') {
      let ok = 0, bad = 0;
      const ttfbs = [];
      for (const row of j.results || []) {
        const rs = row.result || {};
        const st = rs.statusCode ?? rs.status;
        // 有些源本身就是跳转层：ms-edge（创空间容器）对 /assets/** 一律 302 到真正素材源，
        // 它永远不会自己返 200。把 3xx 算成功——玩家付的就是「到第一个字节」这段，
        // 而 302 的 firstByte 正是跳转决策的时间。真正该判死的是 4xx/5xx 和落到 HTML 错误页。
        if (st === 200 || (typeof st === 'number' && st >= 300 && st < 400)) {
          ok++;
          const t = rs.timings || {};
          const ttfb = t.firstByte ?? t.total ?? null;
          if (typeof ttfb === 'number' && ttfb < 30000) ttfbs.push(ttfb);
        } else {
          bad++;
        }
      }
      return { ok, bad, ttfbs };
    }
    if (j.status === 'failed') return { error: 'measurement failed' };
  }
  return { error: 'timeout' };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)]);
};

const netPath = path.join(ROOT, 'network.json');
const net = JSON.parse(fs.readFileSync(netPath, 'utf8'));
const existing = new Map((net.sources || []).map((s) => [s.id, s]));
const todo = targets(new Set((net.sources || []).map((s) => s.host)));

if (!todo.length) {
  console.log('network.json 已覆盖所有已登记源，无需补测。');
  process.exit(0);
}

console.log(`待补测 ${todo.length} 个源：${todo.map((t) => t.id).join(', ')}`);
console.log(`运营商：${CARRIERS.map((c) => `${c[0]}(AS${c[1]})`).join(' / ')}\n`);

const added = [];
const failed = [];
for (const t of todo) {
  const http = {};
  let anyOk = false;
  let anyErr = null;
  for (const [carrier, asn] of CARRIERS) {
    const m = await measure(t.host, t.probe, asn);
    if (m.error) { anyErr = m.error; process.stderr.write(`  ! ${t.id}/${carrier}: ${m.error}\n`); continue; }
    const ttfbMs = median(m.ttfbs);
    if (ttfbMs == null) { http[carrier] = { ok: 0, bad: m.bad, ttfbMs: null }; continue; }
    anyOk = true;
    http[carrier] = { ok: m.ok, bad: m.bad, ttfbMs };
  }
  if (!anyOk) {
    failed.push({ id: t.id, error: anyErr || 'no carrier returned 200' });
    process.stderr.write(`  × ${t.id}: 本轮全部失败（保留原条目，不写入空数据）\n`);
    continue;
  }
  const entry = {
    id: t.id,
    host: t.host,
    probe: t.probe,
    kind: (existing.get(t.id)?.kind) || 'cdn',
    http,
    note: `自动补测（${new Date().toISOString().slice(0, 10)}，Globalping 内地三运营商 HTTP GET ${t.probe}）`,
  };
  added.push(entry);
  const line = CARRIERS.map(([c]) => `${c}:${http[c]?.ttfbMs ?? '-'}ms(${http[c]?.ok ?? 0}/${(http[c]?.ok ?? 0) + (http[c]?.bad ?? 0)})`).join('  ');
  console.log(`  ✓ ${t.id.padEnd(12)} ${line}`);
  await sleep(1000);   // 匿名额度有限，源之间留一口气
}

if (!added.length) {
  console.log('\n没有任何源测得成功 —— network.json 未改动。');
  process.exit(1);
}

const merged = [...(net.sources || [])];
for (const e of added) {
  const i = merged.findIndex((s) => s.id === e.id);
  if (i >= 0) merged[i] = { ...merged[i], ...e };
  else merged.push(e);
  if (existing.has(e.id)) delete existing.get(e.id).lastFailedAt;
}
for (const f of failed) {
  const i = merged.findIndex((s) => s.id === f.id);
  if (i >= 0) merged[i] = { ...merged[i], lastFailedAt: new Date().toISOString().slice(0, 10), lastFailure: f.error };
}

const out = { ...net, measuredAt: new Date().toISOString().slice(0, 10), sources: merged };
const body = `${JSON.stringify(out, null, 2)}\n`;

// 写回前先自检：这一步能通过才允许落盘，否则发布出去的是坏表。
parseNetworkTable(body);
console.log(`\nparseNetworkTable 自检通过（${merged.length} 个源）`);

if (!write) {
  console.log('(dry run — 加 --write 回写 network.json)');
  process.exit(0);
}
fs.writeFileSync(netPath, body);
console.log(`written network.json（新增/更新 ${added.length} 条${failed.length ? `，失败 ${failed.length} 条` : ''}）`);
