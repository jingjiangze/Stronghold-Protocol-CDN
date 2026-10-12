// 逐源 × 逐分类 覆盖率实测（HTTP HEAD/GET 状态矩阵）。
// 用法: node probe-all.mjs   输出 _tmp/coverage-raw.json + 控制台矩阵
import fs from 'node:fs';

const probes = JSON.parse(fs.readFileSync(new URL('./probes.json', import.meta.url), 'utf8'));

const SRC = {
  'r2':            'https://weishucdn.jiangjiangze.icu',
  'r2-alt':        'https://weishucdn2.jiangjiangze.icu',
  'pages':         'https://spages.jiangjiangze.icu',
  'gitcdn-own':    'https://gitcdn.jiangjiangze.icu',
  'jsdelivr-assets': 'https://cdn.jsdelivr.net/gh/jingjiangze/Stronghold-Protocol-CDN@assets-raw',
  'ghfast-assets': 'https://ghfast.top/https://raw.githubusercontent.com/jingjiangze/Stronghold-Protocol-CDN/assets-raw',
  'ms-dataset':    'https://www.modelscope.cn/datasets/jingjiangze/Stronghold-Protocol-Assets/resolve/master/releases/v1-trial',
  'openi':         'https://openi.pcl.ac.cn/jingjiangze/Stronghold-Protocol/raw/branch/assets-raw',
  'ms-edge':       'https://jingjiangze-stronghold-protocol.ms.show',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function probe(base, p, timeoutMs = 25000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(base + '/' + p, {
      method: 'GET',
      signal: ctl.signal,
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: '*/*' },
    });
    clearTimeout(t);
    const buf = await r.arrayBuffer();
    return { code: r.status, bytes: buf.byteLength, ms: Date.now() - t0, loc: r.headers.get('location') || '' };
  } catch (e) {
    clearTimeout(t);
    return { code: 'ERR', err: String(e.name || e.message).slice(0, 40), ms: Date.now() - t0 };
  }
}

const out = {};
const names = Object.keys(SRC);
const N = 6; // 并发

for (const name of names) {
  const base = SRC[name];
  const rows = [];
  // 分批，避免同时打爆单源
  for (let i = 0; i < probes.length; i += N) {
    const batch = probes.slice(i, i + N);
    const res = await Promise.all(batch.map((p) => probe(base, p.path)));
    batch.forEach((p, k) => rows.push({ cat: p.cat, path: p.path, expect: p.size, ...res[k] }));
  }
  out[name] = rows;
  const ok = rows.filter((r) => r.code === 200).length;
  console.log(`${name.padEnd(16)} ${ok}/${rows.length} 200`);
}

fs.writeFileSync(new URL('./coverage-raw.json', import.meta.url), JSON.stringify(out, null, 1));
console.log('\n已写出 coverage-raw.json');
