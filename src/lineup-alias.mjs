// src/lineup-alias.mjs — AI 布阵学习库的「稳定别名」：把每个模式最新的一份日期文件复制成
// `packs/lineup-library/lineups_<modeId>.jsonl`，供服务器侧 lineupSync 按固定名字拉取。
//
// 为什么需要：发布键带日期（上传 API 只增不改，同一天重发会 409），而读取器拼的是稳定名
// `<base>/lineups_<modeId>.jsonl`。别名是两侧之间唯一薄的一层，且是幂等的。
//
// 三条硬规则：
//   1. 每轮都跑、与 staging 有没有积压无关（promote() 无发布时会提前返回，别名不能挂在它里面）。
//   2. 每个模式独立 try/catch：一个模式失败只进 errors，不阻塞其它模式，也绝不删旧别名。
//   3. 单调不回退：别名对象上记 `lineupDate` 元数据，候选日期不早于它才覆盖；读不到就覆盖一次
//      （首次建立别名的老对象没有这个字段）。
//
// 缓存：别名每天覆盖，**不能用 IMMUTABLE**（一年 TTL 会让更新对读者不可见），用 SHORT（5 分钟）。
import { copyObject, headObject, listKeys, SHORT } from './r2.mjs';
import { LINEUP_PREFIX } from './upload.mjs';

/** `packs/lineup-library/<modeId>-<YYYY-MM-DD>.jsonl` —— modeId 限定为非连字符字符类，日期锚定到结尾。 */
const DATED = /^packs\/lineup-library\/([A-Za-z0-9_]+)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * 形状像日期还不够：`2026-13-99` 也匹配 `\d{4}-\d{2}-\d{2}`，而且字符串比较会把它排到最前。
 * 用一个 UTC 往返校验，把不存在的日子挡掉（否则一个坏键会永久占住「最新」的位置）。
 */
function isRealDate(s) {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 稳定别名键。读取器拼的是 `lineups_<modeId>.jsonl`，所以这里不能再带日期。 */
export function aliasKeyFor(modeId) {
  return `${LINEUP_PREFIX}lineups_${modeId || ''}.jsonl`;
}

/**
 * 从一批键里挑出「每个模式最新的一份」。纯函数，无 I/O。
 *
 * 不按字典序取最大：`lineups_…` 在 ASCII 序上大于 `mode_…`，而列表顺序是 S3 LIST 顺序（不排序）。
 * 所以这里必须按 modeId 分组、组内比日期；带日期的正则天然把别名本身排除在外。
 * @param {Array<string | {key: string}>} keys
 * @returns {Array<{modeId: string, date: string, sourceKey: string, destKey: string}>}
 */
export function selectLatestLineups(keys) {
  const best = new Map();
  for (const row of keys || []) {
    const key = String((row && row.key) || row || '').trim();
    const m = DATED.exec(key);
    if (!m) continue;
    const modeId = m[1];
    const date = m[2];
    if (!isRealDate(date)) continue;
    const cur = best.get(modeId);
    if (!cur || date > cur.date) best.set(modeId, { modeId, date, sourceKey: key });
  }
  return [...best.values()]
    .sort((a, b) => (a.modeId < b.modeId ? -1 : a.modeId > b.modeId ? 1 : 0))
    .map((t) => ({ ...t, destKey: aliasKeyFor(t.modeId) }));
}

/** 从 HEAD 结果里取某个 meta 字段（HTTP 头大小写不敏感，Node 会统一小写）。 */
function metaOf(head, name) {
  if (!head || !head.meta) return '';
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(head.meta)) if (k.toLowerCase() === lower) return String(v || '');
  return '';
}

/**
 * 把每个模式最新的日期文件复制成稳定别名。
 *
 * 依赖注入（list/head/copy）是为了让单测不碰真桶；生产调用不传即用 r2.mjs 的实现。
 * @returns {Promise<{targets: Array, copied: Array, skipped: number, errors: Array}>}
 */
export async function syncLineupAliases({
  config, dry = false, log = console,
  list = listKeys, head = headObject, copy = copyObject,
} = {}) {
  const report = { targets: [], copied: [], skipped: 0, errors: [] };
  if (!config) { report.errors.push({ error: '没有 R2 配置' }); return report; }

  let rows;
  try {
    rows = await list(config, LINEUP_PREFIX);
  } catch (error) {
    report.errors.push({ error: `列 ${LINEUP_PREFIX} 失败：${error.message}` });
    return report;
  }
  report.targets = selectLatestLineups(rows);

  for (const t of report.targets) {
    try {
      const cur = await head(config, t.destKey);
      const curDate = metaOf(cur, 'lineupDate');
      // 只在候选不早于当前时才覆盖：早于当前说明这一轮拿到的是旧文件（或同一批里的乱序），
      // 覆盖会把读者推回旧数据。没有 lineupDate（首次建立别名）就覆盖一次。
      if (curDate && curDate >= t.date) { report.skipped++; continue; }
      if (dry) { report.copied.push({ ...t, dry: true }); continue; }

      // 源对象的摘要随对象一起复制进别名：读取器/审计都能从别名本身核对字节。
      const src = await head(config, t.sourceKey);
      const sha = metaOf(src, 'sha256');
      await copy(config, t.sourceKey, t.destKey, {
        contentType: 'application/json',
        cacheControl: SHORT,
        meta: { sha256: sha, lineupDate: t.date, source: 'lineup-library' },
      });
      report.copied.push({ ...t, sha256: sha });
      log(`[lineup-alias] ${t.sourceKey} → ${t.destKey} (${t.date})`);
    } catch (error) {
      // 一个模式失败不影响其它模式；旧别名原样保留（绝不删）。
      report.errors.push({ ...t, error: String((error && error.message) || error) });
    }
  }
  return report;
}
