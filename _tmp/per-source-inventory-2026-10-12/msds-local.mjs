// 判定 ms-dataset 的 local 缺口是「整类缺失」还是「个别文件缺失」
import fs from 'node:fs';
const index = JSON.parse(fs.readFileSync(new URL('./wscdn-index.json', import.meta.url), 'utf8'));

const locals = Object.keys(index.files).filter((k) => k.startsWith('assets/local/')).sort();
console.log('assets/local/ 上游文件总数:', locals.length);

// 均匀抽 6 个
const picks = [];
const step = Math.max(1, Math.floor(locals.length / 6));
for (let i = 0; i < locals.length && picks.length < 6; i += step) picks.push(locals[i]);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const B = 'https://www.modelscope.cn/datasets/jingjiangze/Stronghold-Protocol-Assets/resolve/master/releases/v1-trial';
const R2 = 'https://weishucdn.jiangjiangze.icu';

async function get(base, p) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(base + '/' + p, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA } });
    clearTimeout(t);
    const b = Buffer.from(await r.arrayBuffer());
    return { code: r.status, bytes: b.length };
  } catch (e) { clearTimeout(t); return { code: 'ERR', bytes: 0 }; }
}

for (const p of picks) {
  const [a, b] = await Promise.all([get(R2, p), get(B, p)]);
  const exp = index.files[p].size;
  console.log(
    String(a.code).padEnd(4), 'r2=' + String(a.bytes).padEnd(9),
    '| ms-dataset', String(b.code).padEnd(4), 'bytes=' + String(b.bytes).padEnd(9),
    '| expect', exp, '|', p.replace('assets/local/', '')
  );
}
