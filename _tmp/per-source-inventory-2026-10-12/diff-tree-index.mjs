// 三份清单的口径对齐审计：tree.json / index.json / r2 实际线上
import fs from 'node:fs';

const tree = JSON.parse(fs.readFileSync(new URL('./wscdn-tree.json', import.meta.url), 'utf8'));
const index = JSON.parse(fs.readFileSync(new URL('./wscdn-index.json', import.meta.url), 'utf8'));

const treeSet = new Map();
for (const [dir, v] of Object.entries(tree.dirs)) {
  for (const f of v.files || []) treeSet.set(dir + '/' + f[0], f[1]);
}
const idxSet = new Map(Object.entries(index.files).map(([k, v]) => [k, v.size]));

console.log('tree.json 文件数:', treeSet.size, '| index.json 键数:', idxSet.size);

const onlyTree = [...treeSet.keys()].filter((k) => !idxSet.has(k));
const onlyIdx = [...idxSet.keys()].filter((k) => !treeSet.has(k));

console.log('\n只在 tree.json（index.json 缺）:', onlyTree.length);
console.log('只在 index.json（tree.json 缺）:', onlyIdx.length);

const byPrefix = (list) => {
  const m = new Map();
  for (const k of list) {
    const p = k.split('/').slice(0, 2).join('/');
    m.set(p, (m.get(p) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

console.log('\n=== 只在 tree.json 里的（按前缀 Top 20）===');
for (const [p, n] of byPrefix(onlyTree).slice(0, 20)) console.log('  ', String(n).padStart(6), p);
console.log('\n  样例:', onlyTree.slice(0, 8));

console.log('\n=== 只在 index.json 里的（按前缀 Top 20）===');
for (const [p, n] of byPrefix(onlyIdx).slice(0, 20)) console.log('  ', String(n).padStart(6), p);
console.log('  样例:', onlyIdx.slice(0, 8));
