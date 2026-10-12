// 追加探针：扩大 docs 与其它分类的取样，确认「唯一例外是 docs/」这条叙述是否成立。
// 同时重测 ms-dataset 的 local 缺口是「全类缺失」还是「个别文件缺失」。
import fs from 'node:fs';

const index = JSON.parse(fs.readFileSync(new URL('./wscdn-index.json', import.meta.url), 'utf8'));
const tree = JSON.parse(fs.readFileSync(new URL('./wscdn-tree.json', import.meta.url), 'utf8'));

// 每个分类各取 3 个（首/中/末），目的是确认「整类缺失」而不是「碰巧缺几个文件」
const byCat = new Map();
for (const k of Object.keys(index.files)) {
  const parts = k.split('/');
  const cat = parts[0] === 'assets' ? parts[1] : parts[0];
  if (!byCat.has(cat)) byCat.set(cat, []);
  byCat.get(cat).push(k);
}

const probes = [];
for (const [cat, keys] of [...byCat.entries()].sort()) {
  keys.sort();
  const n = keys.length;
  const picks = [keys[0], keys[Math.floor(n / 2)], keys[n - 1]].filter(Boolean);
  for (const p of picks) probes.push({ cat, path: p, size: index.files[p].size });
}
// local 分类额外取样，用于判定 ms-dataset 的缺口是整类还是个别
const locals = (byCat.get('local') || []).slice().sort();
const extra = [];
for (let i = 0; i < locals.length; i += Math.max(1, Math.floor(locals.length / 8))) extra.push(locals[i]);
console.log('探针总数:', probes.length, '| local 总数:', locals.length);

fs.writeFileSync(new URL('./probes-upstream2.json', import.meta.url), JSON.stringify(probes, null, 1));
fs.writeFileSync(new URL('./local-samples.json', import.meta.url), JSON.stringify(extra, null, 1));
console.log('分类:', [...byCat.keys()].sort().join(' '));
console.log('local 额外取样', extra.length, '条');
