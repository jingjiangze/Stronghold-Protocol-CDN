// 把非 200 的条目按 redirect 跟进，判定「最终能否取到字节」
import fs from 'node:fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

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
};

async function probe(base, p, timeoutMs = 25000) {
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
    return { code: r.status, bytes: buf.byteLength, ms: Date.now() - t0, hops: 0 };
  } catch (e) {
    clearTimeout(t);
    return { code: 'ERR', bytes: 0, ms: Date.now() - t0, err: String(e.name).slice(0, 30) };
  }
}

const name = process.argv[2];
const rows = JSON.parse(fs.readFileSync(new URL(`./coverage-${name}.json`, import.meta.url), 'utf8'));
const base = SRC[name];
const fixed = [];
for (const r of rows) {
  if (r.code === 200) { fixed.push({ ...r, final: 200 }); continue; }
  const retry = await probe(base, r.path);
  fixed.push({ ...r, followCode: retry.code, followBytes: retry.bytes, ms2: retry.ms, final: retry.code });
}
const ok = fixed.filter((r) => r.final === 200).length;
console.log(`${name.padEnd(16)} 跟随后 ${ok}/${fixed.length} 可取到字节`);
for (const r of fixed) if (r.final !== 200) console.log('   缺:', String(r.cat).padEnd(14), String(r.code).padEnd(5), r.followCode ?? '', r.path);
fs.writeFileSync(new URL(`./coverage-final-${name}.json`, import.meta.url), JSON.stringify(fixed, null, 1));
