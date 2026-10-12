// 单源覆盖率实测。用法: node probe-one.mjs <源名>   —— 输出 coverage-<源名>.json
import fs from 'node:fs';

const probes = JSON.parse(fs.readFileSync(new URL('./probes.json', import.meta.url), 'utf8'));

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
if (!base) { console.error('未知源:', name, '\n可用:', Object.keys(SRC).join(' ')); process.exit(1); }

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function probe(p, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(base + '/' + p, {
      signal: ctl.signal,
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: '*/*' },
    });
    clearTimeout(t);
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      code: r.status,
      bytes: buf.byteLength,
      ms: Date.now() - t0,
      loc: r.headers.get('location') || '',
    };
  } catch (e) {
    clearTimeout(t);
    return { code: 'ERR', bytes: 0, ms: Date.now() - t0, err: String(e.name).slice(0, 30) };
  }
}

const rows = [];
const N = 6;
for (let i = 0; i < probes.length; i += N) {
  const batch = probes.slice(i, i + N);
  const res = await Promise.all(batch.map((p) => probe(p.path)));
  batch.forEach((p, k) => rows.push({ cat: p.cat, path: p.path, expect: p.size, ...res[k] }));
}

const ok = rows.filter((r) => r.code === 200).length;
fs.writeFileSync(new URL(`./coverage-${name}.json`, import.meta.url), JSON.stringify(rows, null, 1));
console.log(`${name.padEnd(16)} ${ok}/${rows.length} 直接 200`);
for (const r of rows) {
  if (r.code !== 200) {
    console.log('   ', String(r.code).padEnd(5), String(r.cat).padEnd(14), String(r.ms + 'ms').padEnd(8), r.path, r.loc ? '→ ' + r.loc.slice(0, 70) : '');
  }
}
