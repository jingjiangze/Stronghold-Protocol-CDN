// 逐源素材覆盖率矩阵实测。用法: node coverage-matrix.mjs
// 每个顶层目录挑代表文件，逐源探测，产出「每个源实际有什么」的清单证据。
import fs from 'node:fs';
import path from 'node:path';

const tree = JSON.parse(fs.readFileSync(new URL('./wscdn-tree.json', import.meta.url), 'utf8'));
const index = JSON.parse(fs.readFileSync(new URL('./wscdn-index.json', import.meta.url), 'utf8'));

// 1. 顶层分类：从 tree.dirs 归纳 assets/ 下的二级前缀
const cats = new Map();
for (const dir of Object.keys(tree.dirs)) {
  if (!dir.startsWith('assets/')) continue;
  const rest = dir.slice('assets/'.length);
  const cat = rest.split('/')[0];
  const d = cats.get(cat) || { dirs: 0, bytes: 0, files: 0 };
  d.dirs += 1;
  d.bytes += tree.dirs[dir].bytes || 0;
  d.files += (tree.dirs[dir].files || []).length;
  cats.set(cat, d);
}
console.log('=== assets/ 下的顶层分类（来自 tree.json） ===');
let totB = 0, totF = 0;
for (const [c, d] of [...cats.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  totB += d.bytes; totF += d.files;
  console.log(
    String(c).padEnd(22),
    ('dirs=' + d.dirs).padEnd(10),
    ('files=' + d.files).padEnd(11),
    (d.bytes / 1048576).toFixed(1) + ' MiB'
  );
}
console.log('合计'.padEnd(22), '', 'files=' + totF, '', (totB / 1048576).toFixed(1) + ' MiB');

// 2. 每个分类挑代表文件（取该分类里第一个文件）
const probes = [];
for (const [cat] of cats) {
  for (const dir of Object.keys(tree.dirs)) {
    if (!dir.startsWith('assets/' + cat)) continue;
    const f = (tree.dirs[dir].files || [])[0];
    if (!f) continue;
    probes.push({ cat, path: dir + '/' + f[0], size: f[1] });
    break;
  }
}
console.log(`\n=== 代表文件 ${probes.length} 个 ===`);
for (const p of probes) console.log(' ', p.cat.padEnd(22), p.path);

fs.writeFileSync(new URL('./probes.json', import.meta.url), JSON.stringify(probes, null, 1));

// 3. index.json 的覆盖口径
const idxKeys = Object.keys(index.files);
const inAssets = idxKeys.filter((k) => k.startsWith('assets/'));
const notAssets = idxKeys.filter((k) => !k.startsWith('assets/'));
console.log('\n=== index.json 键空间 ===');
console.log('总键数:', idxKeys.length, '| assets/ 前缀:', inAssets.length, '| 非 assets/:', notAssets.length);
console.log('非 assets/ 样例:', notAssets.slice(0, 12));
console.log('\n=== tree.totals ===', JSON.stringify(tree.totals));
