// speedcdn 与 weishucdn 是否同一份字节：多文件 sha256 对照
import fs from 'node:fs';
import crypto from 'node:crypto';

const paths = [
  '/cdn/v1/api.json',
  '/cdn/v1/mirrors.json',
  '/cdn/v1/rank.json',
  '/cdn/v1/index.json',
  '/cdn/v1/tree.json',
  '/assets/char/avatar/char_002_amiya.png',
  '/assets/audio/bgm/m_bat_abyssalhunters_intro.mp3',
];

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 40000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    clearTimeout(t);
    const buf = Buffer.from(await r.arrayBuffer());
    return { code: r.status, buf };
  } catch (e) {
    clearTimeout(t);
    return { code: 'ERR', err: String(e.name).slice(0, 30), buf: Buffer.alloc(0) };
  }
}

const A = 'https://weishucdn.jiangjiangze.icu';
const B = 'https://speedcdn.jiangjiangze.icu';

console.log('路径'.padEnd(48), 'weishucdn'.padEnd(20), 'speedcdn'.padEnd(20), '一致?');
for (const p of paths) {
  const [a, b] = await Promise.all([get(A + p), get(B + p)]);
  const ha = crypto.createHash('sha256').update(a.buf).digest('hex').slice(0, 16);
  const hb = crypto.createHash('sha256').update(b.buf).digest('hex').slice(0, 16);
  const la = `${a.code}/${a.buf.length}`;
  const lb = `${b.code}/${b.buf.length}`;
  console.log(p.padEnd(48), (la + ' ' + ha).padEnd(20), (lb + ' ' + hb).padEnd(20), ha === hb && a.buf.length === b.buf.length ? 'YES ✅' : 'NO ❌');
}
