import fs from 'node:fs';
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
const m = read('./wscdn-mirrors.json');
const api = read('./wscdn-api.json');
const idx = read('./wscdn-index.json');
const tr = read('./wscdn-tree.json');

console.log('=== index.json 结构 ===');
console.log('顶层:', Object.keys(idx).join(', '));
console.log('files 类型:', Array.isArray(idx.files) ? 'array' : typeof idx.files);
const f0 = idx.files;
if (f0 && typeof f0 === 'object') {
  const keys = Object.keys(f0);
  console.log('files 是对象，键数:', keys.length, '样例键:', keys.slice(0, 3));
  console.log('样例值:', JSON.stringify(f0[keys[0]]).slice(0, 300));
}

console.log('\n=== tree.json 结构 ===');
console.log('顶层:', Object.keys(tr).join(', '));
const dirs = tr.dirs;
console.log('dirs 类型:', Array.isArray(dirs) ? 'array' : typeof dirs, Array.isArray(dirs) ? dirs.length : Object.keys(dirs).length);
if (Array.isArray(dirs)) console.log('样例:', JSON.stringify(dirs[0]).slice(0, 400));
else {
  const k = Object.keys(dirs).slice(0, 3);
  for (const x of k) console.log(' ', x, '->', JSON.stringify(dirs[x]).slice(0, 300));
}

console.log('\n=== mirrors.flat 源清单 ===');
for (const s of m.flat) {
  console.log(
    String(s.id).padEnd(16),
    String(s.kind).padEnd(7),
    String(s.coverage).padEnd(8),
    'enabled=' + String(s.enabled ?? true).padEnd(6),
    'assetEligible=' + String(s.assetEligible ?? true).padEnd(6),
    s.base || s.host || ''
  );
}

console.log('\n=== mirrors.packs / index / pick ===');
console.log('packs:', JSON.stringify(m.packs).slice(0, 400));
console.log('index:', JSON.stringify(m.index).slice(0, 300));
console.log('pick :', JSON.stringify(m.pick).slice(0, 300));

console.log('\n=== api.endpoints ===');
console.log(JSON.stringify(api.endpoints, null, 1).slice(0, 1500));

console.log('\n=== api 全文 ===');
console.log(JSON.stringify(api, null, 1).slice(0, 2500));
