// 清掉「已经没人引用」的旧打包通道目录 packs/assets-<tag>/。
//
//   node src/prune-packs.mjs              干跑：只打印会删什么（默认不写）
//   node src/prune-packs.mjs --apply      真删
//   node src/prune-packs.mjs --keep=2     保留最新的 N 个 tag 目录（默认 1）
//
// 为什么要有这一件事：每上一个上游版本，packs/assets-<tag>/ 就多 ~450-500 MB，而 sync 的 --prune
// 只对着「上游素材清单」比较，packs/ 下的目录名根本不在那张表里 —— 于是它只增不减。
// 实测（2026-10-10）桶里同时躺着 assets-v0.2.1(405 MB) 与 assets-v0.2.2(504 MB)。
//
// 三道闸，缺一不可：
//   1. 只碰 packs/assets-* 这一种形状，其它前缀一律不动；
//   2. 现场读线上契约（cdn/v1/art.json 与 cdn/v1/mirrors.json）的 packs URL，被引用的键永不删；
//   3. 最新那一档必须是完整的（对象数与 art.json 声明的 files 一致），否则宁可不删 ——
//      半档的时候删掉旧档，玩家就没有可用的包了。
import { r2Config, listKeys, deleteObject, getObject } from './r2.mjs';

const PACKS_RE = /^packs\/assets-([^/]+)\/(.+)$/;

/** 从键列表里按 tag 分组。 */
export function groupByTag(rows) {
  const groups = new Map();
  for (const row of rows) {
    const m = PACKS_RE.exec(row.key);
    if (!m) continue;
    const tag = m[1];
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag).push(row);
  }
  return groups;
}

/**
 * 版本排序：`v0.2.10` 必须排在 `v0.2.9` 之后，字典序会把它排错。
 * 数字段比较，缺段当 0；非数字尾段（例如 `-rc1`）按字符串再比一次。
 */
export function compareTags(a, b) {
  const pa = a.split(/[.\-]/);
  const pb = b.split(/[.\-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 线上契约引用了哪些 packs URL（art.json 与 mirrors.json 都算）。 */
export function referencedKeys(...docs) {
  const urls = new Set();
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === 'string') {
      urls.add(node);
      return;
    }
    if (typeof node === 'object') Object.values(node).forEach(walk);
  };
  for (const doc of docs) walk((doc || {}).packs ?? doc?.art?.packs ?? doc?.packs);
  const keys = new Set();
  for (const u of urls) {
    if (typeof u !== 'string' || !u.includes('/packs/assets-')) continue;
    try {
      const path = decodeURIComponent(new URL(u).pathname).replace(/^\//, '');
      if (PACKS_RE.test(path)) keys.add(path);
    } catch {
      /* 不是绝对 URL 的字符串忽略即可 */
    }
  }
  return keys;
}

/**
 * 该删哪些。纯函数，好测。
 * @param {Map<string,{key:string,size:number}[]>} groups
 * @param {{keep:number, referenced:Set<string>, newestComplete:boolean}} options
 */
export function planPacksPrune(groups, { keep = 1, referenced = new Set(), newestComplete = true }) {
  const tags = [...groups.keys()].sort(compareTags);
  if (tags.length <= keep) return { tags, remove: [], bytes: 0, protectedByReference: 0 };
  const stale = tags.slice(0, tags.length - keep);
  if (!newestComplete) return { tags, remove: [], bytes: 0, skipped: '最新一档不完整，旧档一律不动' };
  const remove = [];
  let protectedByReference = 0;
  for (const tag of stale) {
    for (const row of groups.get(tag)) {
      if (referenced.has(row.key)) {
        protectedByReference++;
        continue;
      }
      remove.push(row);
    }
  }
  return { tags, remove, bytes: remove.reduce((a, r) => a + r.size, 0), protectedByReference };
}

async function readJsonKey(config, key) {
  const body = await getObject(config, key);
  if (!body) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const keepArg = argv.find((a) => a.startsWith('--keep='));
  const keep = keepArg ? Math.max(1, Number(keepArg.split('=')[1]) || 1) : 1;

  const config = r2Config(process.env);
  const rows = await listKeys(config, 'packs/');
  const groups = groupByTag(rows);
  const art = await readJsonKey(config, 'cdn/v1/art.json');
  const mirrors = await readJsonKey(config, 'cdn/v1/mirrors.json');
  const referenced = referencedKeys(art, mirrors);

  const packsDeclared = (art?.art?.packs || []).reduce((a, p) => a + (p.files || 0), 0);
  const newest = [...groups.keys()].sort(compareTags).at(-1);
  const newestRows = groups.get(newest) || [];
  // art.json 声明的 files 是「这批包一共覆盖多少素材文件」，不是包个数，所以这里只核对
  // 包对象数与 art.packs 条数是否一致 —— 不一致就说明那一档还没写完。
  const expectedPacks = (art?.art?.packs || []).length;
  const newestComplete = newestRows.length >= expectedPacks && expectedPacks > 0;

  const plan = planPacksPrune(groups, { keep, referenced, newestComplete });

  console.log(`packs/ 共 ${rows.length} 个对象、${(rows.reduce((a, r) => a + r.size, 0) / 1048576).toFixed(1)} MB，tag：${plan.tags.join(', ')}`);
  console.log(`最新一档 ${newest} 有 ${newestRows.length} 个包对象（art.json 声明 ${expectedPacks} 个）→ ${newestComplete ? '完整' : '不完整'}`);
  if (plan.skipped) console.log(`不删：${plan.skipped}`);
  console.log(`保留最新 ${keep} 档，本轮计划删除 ${plan.remove.length} 个对象 / ${(plan.bytes / 1048576).toFixed(1)} MB${plan.protectedByReference ? `（另有 ${plan.protectedByReference} 个仍被线上契约引用，放过）` : ''}`);
  for (const r of plan.remove) console.log(`  - ${r.key}  ${(r.size / 1048576).toFixed(1)} MB`);

  if (!apply) {
    console.log('\n（干跑，没有删任何东西；要真删加 --apply）');
    return { ...plan, apply: false };
  }
  for (const r of plan.remove) {
    if (!PACKS_RE.test(r.key)) throw new Error(`越界键，拒绝删除：${r.key}`);
    await deleteObject(config, r.key);
    console.log(`deleted ${r.key}`);
  }
  return { ...plan, apply: true };
}

if (process.argv[1] && process.argv[1].endsWith('prune-packs.mjs')) {
  main().catch((error) => {
    console.error(`[prune-packs] 失败：${error.stack || error.message}`);
    process.exit(1);
  });
}
