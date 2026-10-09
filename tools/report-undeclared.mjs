// 只读体检：把「桶里有、契约里没有、hosted.json 也没登记」的对象列出来，按目录聚合。
// 目的不是删，而是先回答「这 600 多 MB 是谁的、有没有人引用」——没有答案之前谁都不该动它。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const t = fs.readFileSync(path.join(os.homedir(), '.cf_r2_creds'), 'utf8');
const V = Object.fromEntries([...t.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
const HOST = (V.r2_endpoint || '').replace(/^https:\/\//, '').replace(/\/$/, '');
const AK = V.r2_access_key;
const SK = V.r2_secret;
const BUCKET = 'stronghold-assets';
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const qenc = (s) => [...String(s)].map((c) => (/[A-Za-z0-9\-._~]/.test(c) ? c : [...Buffer.from(c, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join(''))).join('');

function curl(url, headers) {
  const cfg = path.join(os.tmpdir(), `undecl-${Math.random().toString(36).slice(2)}.cfg`);
  fs.writeFileSync(cfg, [`url = "${url}"`, ...headers.map((h) => `header = "${h}"`)].join('\n') + '\n');
  try {
    return execFileSync('curl', ['-sS', '--ssl-no-revoke', '-m', '60', '-K', cfg], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' });
  } finally {
    fs.unlinkSync(cfg);
  }
}
function auth(method, uri, query) {
  const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const amzDate = `${iso.slice(0, 15)}Z`;
  const ds = amzDate.slice(0, 8);
  const all = { host: HOST, 'x-amz-content-sha256': EMPTY, 'x-amz-date': amzDate };
  const names = Object.keys(all).sort();
  const cr = [method, uri, query, names.map((k) => `${k}:${all[k]}\n`).join(''), names.join(';'), EMPTY].join('\n');
  const scope = `${ds}/auto/s3/aws4_request`;
  let k = crypto_HMAC(`AWS4${SK}`, ds);
  for (const p of ['auto', 's3', 'aws4_request']) k = crypto_HMAC(k, p);
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, crypto_HASH(cr)].join('\n');
  const sig = crypto_HMAC(k, sts).toString('hex');
  return [`x-amz-content-sha256: ${EMPTY}`, `x-amz-date: ${amzDate}`, `Authorization: AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`];
}
const crypto_HMAC = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
const crypto_HASH = (s) => crypto.createHash('sha256').update(s).digest('hex');

function listAll(prefix) {
  const rows = [];
  let token = '';
  for (let page = 0; page < 200; page++) {
    const params = { 'list-type': '2', 'max-keys': '1000', prefix };
    if (token) params['continuation-token'] = token;
    const query = Object.keys(params).sort().map((kk) => `${qenc(kk)}=${qenc(params[kk])}`).join('&');

    // 每一页都要「自己数得跟它报的一样」才信。这台机器的出口会把响应截断，
    // 截断的一页少了两千行也照样带着 IsTruncated=false —— 于是整份清单少一万行还看着一切正常。
    let xml = '';
    let parsed = [];
    let reported = 0;
    let truncated = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        xml = curl(`https://${HOST}/${BUCKET}?${query}`, auth('GET', `/${BUCKET}`, query));
      } catch (error) {
        if (attempt === 4) throw new Error(`LIST ${prefix} 第 ${page + 1} 页取不到：${error.message}`);
        continue;
      }
      if (/<Error>/.test(xml)) throw new Error(`LIST ${prefix}: ${(xml.match(/<Code>([^<]+)<\/Code>/) || [])[1]}`);
      // R2 的字段顺序是 Key → Size → LastModified（跟 AWS 文档里的顺序不一样）。
      // 按 Key…LastModified…Size 去配会把上一条的 Key 配上下条的 Size，数出来又少又错。
      parsed = [...xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<LastModified>([^<]+)<\/LastModified>[\s\S]*?<\/Contents>/g)]
        .map((m) => ({ key: m[1], size: Number(m[2]), mday: m[3].slice(0, 10) }));
      reported = Number((xml.match(/<KeyCount>(\d+)<\/KeyCount>/) || [])[1] || -1);
      truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const closed = /<\/ListBucketResult>/.test(xml);
      if (closed && (reported < 0 || parsed.length === reported)) break;
      parsed = [];
      if (attempt === 4) throw new Error(`LIST ${prefix} 第 ${page + 1} 页反复对不上（解析 ${parsed.length} / 报的 ${reported}），拒绝给出半份清单`);
    }

    for (const row of parsed) rows.push(row);
    if (!truncated) return rows;
    const nt = (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1];
    if (!nt) throw new Error(`LIST ${prefix}: 第 ${page + 1} 页说还有，却没给续接令牌`);
    token = nt;
  }
  throw new Error(`LIST ${prefix}: 超过 200 页，中止`);
}

const cdn = 'https://weishucdn.jiangjiangze.icu';
const cb = () => `?cb=${Date.now()}${Math.floor(Math.random() * 9999)}`;
const indexFiles = JSON.parse(execFileSync('curl', ['-sS', '--ssl-no-revoke', '-m', '60', `${cdn}/cdn/v1/index.json${cb()}`], { maxBuffer: 128 * 1024 * 1024, encoding: 'utf8' })).files;
const hostedDoc = JSON.parse(fs.readFileSync('C:/DDDD/Agent Work/stronghold-cdn/repo/hosted.json', 'utf8'));
const hosted = new Set((hostedDoc.hosted || []).flatMap((e) => (e.keys || []).map((k) => (Array.isArray(k) ? k[0] : k))));
const manifestText = execFileSync('curl', ['-sS', '--ssl-no-revoke', '-m', '60', `${cdn}/site/manifest.json${cb()}`], { encoding: 'utf8' });
const manifest = JSON.parse(manifestText);
const packKeys = new Set(((manifest.art && manifest.art.packs) || []).flatMap((p) => (p.urls || []).map((u) => {
  try { return decodeURIComponent(new URL(u).pathname).replace(/^\//, ''); } catch { return null; }
}).filter(Boolean)));

const rows = listAll('assets/').concat(listAll('fonts/')).concat(listAll('docs/'));
const inIndex = rows.filter((r) => indexFiles[r.key]);
const declared = rows.filter((r) => !indexFiles[r.key] && hosted.has(r.key));
const referenced = rows.filter((r) => !indexFiles[r.key] && !hosted.has(r.key) && packKeys.has(r.key));
const unknown = rows.filter((r) => !indexFiles[r.key] && !hosted.has(r.key) && !packKeys.has(r.key));
const sum = (a) => a.reduce((s, r) => s + r.size, 0);

console.log(`assets/+fonts/+docs/ 实际对象 ${rows.length} 个 / ${(sum(rows) / 1048576).toFixed(1)} MB`);
console.log(`  上游 index.json 覆盖   ${inIndex.length} 个 / ${(sum(inIndex) / 1048576).toFixed(1)} MB`);
console.log(`  hosted.json 已登记      ${declared.length} 个 / ${(sum(declared) / 1048576).toFixed(1)} MB`);
console.log(`  APK 素材包清单引用      ${referenced.length} 个 / ${(sum(referenced) / 1048576).toFixed(1)} MB   ← 该登记但现在没登记`);
console.log(`  三者都不沾              ${unknown.length} 个 / ${(sum(unknown) / 1048576).toFixed(1)} MB`);
console.log('\n--- 「三者都不沾」按目录聚合（前 14）---');
const g = {};
for (const r of unknown) {
  const seg = r.key.split('/').slice(0, 3).join('/');
  g[seg] = g[seg] || { n: 0, b: 0, days: new Set() };
  g[seg].n++;
  g[seg].b += r.size;
  g[seg].days.add(r.mday);
}
for (const [k, v] of Object.entries(g).sort((a, b) => b[1].b - a[1].b).slice(0, 14)) {
  console.log(String(k).padEnd(30), String(v.n).padStart(5), `${(v.b / 1048576).toFixed(1).padStart(9)} MB`, [...v.days].sort().join(','));
}
console.log('\n--- APK 素材包键（要登记进 hosted.json 的那批）---');
for (const r of referenced.sort((a, b) => b.size - a.size).slice(0, 8)) console.log(String(r.key).padEnd(46), `${(r.size / 1048576).toFixed(1)} MB`, r.mday);
console.log(`  …共 ${referenced.length} 个 / ${(sum(referenced) / 1048576).toFixed(1)} MB`);
console.log('\n--- 其它前缀（不属于本仓）---');
for (const p of ['apk/', 'apk-test/', 'packs/', 'upstream/', 'deploy/', 'site/', 'scout/', 'cdn/', 'data/']) {
  const rs = listAll(p);
  console.log(String(p).padEnd(12), String(rs.length).padStart(5), `${(sum(rs) / 1048576).toFixed(1)} MB`);
}
