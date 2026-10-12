// 单源覆盖率实测（上游口径）。用法: node probe-up1.mjs <源名>
import fs from 'node:fs';

const probes = JSON.parse(fs.readFileSync(new URL('./probes-upstream.json', import.meta.url), 'utf8'));

const SRC = {
  'r2':              'https://weishucdn.jiangjiangze.icu',
  'r2-alt':          'https://weishucdn2.jiangjiangze.icu',
  'pages':           'https://spages.jiangjiangze.icu',
  'gitcdn-own':      'https://gitcdn.jiangjiangze.icu',
  'jsdelivr-assets': 'https://cdn.jsdelivr.net/gh/jingjiangze/Stronghold-Protocol-CDN@assets-raw',
  'ghfast-assets':   'https://ghfast.top/https://raw.githubusercontent.com/jingjiangze/Stronghold-Protocol-CDN/assets-raw',
  'ms-dataset':      'https://www.modelscope.cn/datasets/jingjiangze/Stronghold-Protocol-Assets/resolve/master/releases/v1-trial',
  'openi':           'https://openi.pcl.ac.cn/jingjiangze/Stronghold-Protocol/raw/branch/assets-raw',
  'ms-edge':         'https://jingjiangze-stronghold-protocol.ms.show',
  'jsdelivr':        'https://cdn.jsdelivr.net/gh/jingjiangze/Stronghold-Protocol-CDN@main',
  'ghfast-raw':      'https://ghfast.top/https://raw.githubusercontent.com/jingjiangze/Stronghold-Protocol-CDN/main',
};

const name = process.argv[2];
const base = SRC[name];
if (!base) { console.error('可用:', Object.keys(SRC).join(' ')); process.exit(1); }

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function probe(p, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(base + '/' + p, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: '*/*' },
    });
    clearTimeout(t);
    const buf = Buffer.from(await r.arrayBuffer());
    return { code: r.status, bytes: buf.byteLength, ms: Date.now() - t0 };
  } catch (e) {
    clearTimeout(t);
    return { code: 'ERR', bytes: 0, ms: Date.now() - t0, err: String(e.name).slice(0, 30) };
  }
}

const rows = [];
const N = 5;
for (let i = 0; i < probes.length; i += N) {
  const batch = probes.slice(i, i + N);
  const res = await Promise.all(batch.map((p) => probe(p.path)));
  batch.forEach((p, k) => rows.push({ cat: p.cat, path: p.path, expect: p.size, ...res[k] }));
}

const ok = rows.filter((r) => r.code === 200 && r.bytes === r.expect).length;
const c200 = rows.filter((r) => r.code === 200).length;
fs.writeFileSync(new URL(`./up-${name}.json`, import.meta.url), JSON.stringify(rows, null, 1));
console.log(`${name.padEnd(16)} 200:${c200}/${rows.length}  字节与 index.json 完全相符:${ok}/${rows.length}`);
for (const r of rows) {
  if (r.code !== 200) console.log('   缺:', String(r.code).padEnd(5), String(r.cat).padEnd(10), r.path);
  else if (r.bytes !== r.expect) console.log('   字节不符:', String(r.cat).padEnd(10), r.bytes, '≠', r.expect, r.path);
}
