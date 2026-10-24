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
// network.json 的测量表 id 与 rank 候选 id 不总是同名（r2-primary 就是 r2 的门牌条目，
// 2026-10-22 R2 停用后它被 excluded，但候选仍叫 r2）——不做别名就会「排除了却仍进头部」。
const EXCLUDED_ALIAS = { 'r2-primary': 'r2' };
const excluded = new Set((net.excluded || []).map((e) => EXCLUDED_ALIAS[e.id] || e.id));

/** 每个启用源的候选项：来自 origins.json（r2 + extras + git origins），按 order 排好。 */
function candidates() {
  const list = [
    // 2026-10-22：speedcdn 已改由 CF Redirect Rule 302 到数据集（R2 订阅停用后它不再指向 R2 桶）。
    // 因此 r2 候选的门牌必须是**真正的 R2 门** weishucdn；继续写 speedcdn 会把「数据集的 302 速度」
    // 记在 R2 名下 —— rank 表里 r2 和 speedcdn 两个条目会同时报 speedcdn 主机，实际一个是另一个的跳板。
    { id: 'r2', kind: 'r2', host: 'weishucdn.jiangjiangze.icu', probe: '/cdn/v1/probe.bin', coverage: 'full' },
    ...readExtraOrigins(ROOT).map((o) => ({ id: o.id, kind: o.kind, host: (() => { try { return new URL(o.root).host; } catch { return ''; } })(), probe: o.probe, coverage: o.coverage })),
    ...readGitOrigins(ROOT).map((o) => ({ id: o.id, kind: o.kind, host: (() => { try { return new URL(o.root).host; } catch { return ''; } })(), probe: o.probe, coverage: o.coverage })),
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

/** 实时探测：每次运行真探一遍各源的探针路径（HTTP 成功 + 首字节时间），失败的当场标 down。 */
async function liveProbe(host, probePath) {
  if (!host || !probePath) return null;
  const t0 = Date.now();
  try {
    const res = await fetch(`https://${host}${probePath}`, { headers: { 'user-agent': 'sp-rank/1' }, signal: AbortSignal.timeout(8000) });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || ct.includes('html')) return { ok: false, ms: Date.now() - t0, status: res.status };
    await res.arrayBuffer().catch(() => {});
    return { ok: true, ms: Date.now() - t0, status: res.status };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 60) };
  }
}

const rows = [];
for (const c of candidates()) {
  const m = measure(c.host);
  const live = await liveProbe(c.host, c.probe);
  // 降级只认内地实测（network.json）：CI runner 在境外，它探不到 ≠ 源挂了（2026-10-12 实测：
  // 从 runner 看 ms-dataset/ms-edge/r2 全部不可达，而它们对玩家完全可用）。实时探测只作证据上报。
  const down = false;
  rows.push({ ...c, ...(m || { measured: false, usable: null, ttfbMs: null }), live, down, excluded: excluded.has(c.id) });
}
const order = readPreferredOrder(ROOT);
const rank = (id) => { const i = order.indexOf(id); return i < 0 ? 999 : i; };
rows.sort((a, b) => {
  const ea = a.excluded || a.usable === false || a.down === true, eb = b.excluded || b.usable === false || b.down === true;
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
  method: '排序以内地实测为准（network.json）；liveMs 是 CI runner 的即时探测，仅作证据（境外视角，不作为降级依据）；无实测的新源按 origins.json 的 order 排并标 measured:false',
  measuredAt: net.measuredAt,
  carriers: net.carriers,
  rank: rows.map((r, i) => ({
    n: i + 1, id: r.id, kind: r.kind, host: r.host, coverage: r.coverage,
    measured: r.measured, usable: r.usable, ttfbMs: r.ttfbMs, ok: r.ok, excluded: r.excluded,
    down: r.down === true, liveMs: r.live?.ms ?? null,
  })),
};
const body = `${JSON.stringify(doc, null, 2)}\n`;
console.log(body.split('\n').slice(0, 22).join('\n'));
// 同时落一份本地副本：CDN 侧的另一条链（tools/push-rank-modelscope.mjs）要把它镜像到魔搭数据集，
// 作为容器侧的首选门牌。R2 仍是权威发布点，这里只是把同一份字节交给镜像链，不改变发布语义。
const LOCAL_COPY = path.join(ROOT, 'out', 'cdn', 'v1', 'rank.json');
fs.mkdirSync(path.dirname(LOCAL_COPY), { recursive: true });
fs.writeFileSync(LOCAL_COPY, body);
console.log(`本地副本：${path.relative(ROOT, LOCAL_COPY)}`);
if (!write) { console.log('(dry run — 加 --write 发布到 cdn/v1/rank.json)'); process.exit(0); }
// 2026-10-22：R2 订阅在账户级停用时，这一步必然失败（putObject 403/签名失败）。按用户指令
// 「兜底最后还是 R2、额度恢复即用」，R2 仍是权威发布点 —— 但它挂掉不该阻断**魔搭数据集镜像**：
// 容器读的是数据集那份（RANK_URLS[0]，67 ms），R2 那份是给浏览器门牌用的。降级成警告并继续，
// 让 rank.yml 的下一步仍能把新榜推出去；R2 恢复后这里自然又写成功，无需改代码。
try {
  const config = r2Config();
  await putObject(config, 'cdn/v1/rank.json', Buffer.from(body, 'utf8'), { contentType: 'application/json', cacheControl: 'public, max-age=300' });
  console.log('published cdn/v1/rank.json');
} catch (e) {
  console.warn(`R2 publish skipped: ${String(e?.message || e).slice(0, 160)}`);
  console.warn('（R2 恢复后自动恢复发布；本轮的字节已写入 out/，由下一步镜像到魔搭数据集）');
}
