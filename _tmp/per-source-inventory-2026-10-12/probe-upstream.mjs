// 口径修正后的逐源覆盖率实测。
//
// 昨天那版（2026-10-12 首轮）把 tree.json 的代表文件直接当探针，混进了 mod=1 的 hosted 自有内容。
// hosted 是不在 git 分支上的（只在本站 R2 托管），拿它要求 git 挂载源「提供」是错误的口径。
// 本版只从 index.json（= 上游同步内容）取样，这才是 coverage 声明所描述的集合。
import fs from 'node:fs';

const index = JSON.parse(fs.readFileSync(new URL('./wscdn-index.json', import.meta.url), 'utf8'));
const tree = JSON.parse(fs.readFileSync(new URL('./wscdn-tree.json', import.meta.url), 'utf8'));

// index.json 的键 = 上游内容
const upstream = Object.keys(index.files);
console.log('index.json 键数(=上游内容):', upstream.length);

// 按二级前缀归类
const byCat = new Map();
for (const k of upstream) {
  const parts = k.split('/');
  const cat = parts[0] === 'assets' ? parts[1] : parts[0];
  if (!byCat.has(cat)) byCat.set(cat, []);
  byCat.get(cat).push(k);
}
console.log('分类数:', byCat.size);

// 每类取 ≤2 个代表文件（避免单文件偶发）
const probes = [];
for (const [cat, keys] of [...byCat.entries()].sort()) {
  keys.sort();
  const step = Math.max(1, Math.floor(keys.length / 2));
  const picks = [keys[0], keys[step]].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  for (const p of picks) probes.push({ cat, path: p, size: index.files[p].size });
}
console.log('探针总数:', probes.length);
console.log('分类清单:', [...byCat.keys()].sort().join(' '));

fs.writeFileSync(new URL('./probes-upstream.json', import.meta.url), JSON.stringify(probes, null, 1));
for (const p of probes.slice(0, 12)) console.log('  ', p.cat.padEnd(10), p.path);
