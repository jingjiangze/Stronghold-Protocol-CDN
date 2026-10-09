// 跨服务体检：改了 CDN 契约之后，一条命令确认没波及别的仓库。node tools/health-sweep.mjs
//
// 覆盖：两个 R2 域名逐对象等长等头（含 ACAO 与 Range 206）、APK 签名清单引用的每个按需素材包、
// 被 prune 清掉的旧档在 GitHub 侧仍有后备、dl-site 的接口与签名清单、文档站加了 Functions 之后
// 静态面没被劫持（含别的窗口刚发布的 /mod）。
//
// 判定按现实写，不按想象写：HEAD 没有 body，所以长度读 content-length；
// dl 的 /api/servers 无口令时本来就返回 72 字节提示语（签名清单在 /servers.json）；
// jsDelivr 对裸路径回 301 是它自己的规范化跳转。每一步独立容错 —— 一次 curl 超时不该带走整轮。
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

const cb = () => `?cb=${Date.now()}${Math.floor(Math.random() * 9999)}`;
let pass = 0;
let fail = 0;
const bad = [];

function safeCurl(args, maxBuffer = 4 * 1024 * 1024) {
  try {
    return execFileSync('curl', args, { encoding: 'utf8', maxBuffer, timeout: 70000 });
  } catch {
    return null;
  }
}

function probe(url, method = 'HEAD') {
  const hdr = `${os.tmpdir()}/sw3-${Math.random().toString(36).slice(2)}.h`;
  const args = ['-sS', '--ssl-no-revoke', '-m', method === 'GET' ? '50' : '30', '-D', hdr, '-o', 'nul', '-w', '%{http_code}|%{content_type}|%{size_download}'];
  if (method === 'HEAD') args.push('-I');
  args.push(url);
  const out = safeCurl(args, 1024 * 1024) || 'ERR|0|0';
  const text = fs.existsSync(hdr) ? fs.readFileSync(hdr, 'utf8') : '';
  if (fs.existsSync(hdr)) fs.rmSync(hdr, { force: true });
  const [code, type, size] = out.trim().split('|');
  return {
    code,
    type: (type || '').split(';')[0],
    bytes: Number(size || 0) || Number((text.match(/^content-length:\s*(\d+)/im) || [])[1] || 0),
    acao: (text.match(/^access-control-allow-origin:\s*(\S+)/im) || [])[1] || '',
    range: (text.match(/^content-range:\s*(\S+)/im) || [])[1] || '',
  };
}

function check(label, url, want = {}, method = 'HEAD') {
  const r = probe(url, method);
  const p = [];
  if (want.code && r.code !== want.code) p.push(`码 ${r.code}≠${want.code}`);
  if (want.type && r.type !== want.type) p.push(`类型 ${r.type || '?'}≠${want.type}`);
  if (want.min && !(r.bytes >= want.min)) p.push(`长度 ${r.bytes}<${want.min}`);
  if (want.bytes && r.bytes !== want.bytes) p.push(`长度 ${r.bytes}≠${want.bytes}`);
  if (want.acao && r.acao !== want.acao) p.push(`ACAO ${r.acao || '(无)'}≠${want.acao}`);
  const ok = !p.length;
  ok ? pass++ : (fail++, bad.push(`${label}：${p.join('；')}`));
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label.padEnd(44)} ${r.code} ${r.type} ${r.bytes}B${r.acao ? ' ACAO=' + r.acao : ''}${p.length ? ' ← ' + p.join('；') : ''}`);
  return r;
}

function getJson(url) {
  const out = safeCurl(['-sS', '--ssl-no-revoke', '-m', '55', url], 48 * 1024 * 1024);
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * 内容的 sha256。跨来源比对必须比字节，不能比长度：
 * 长度相等而内容不同（旧档没清）与长度差几十字节（刚发布、传播窗口里两侧刷新时刻不同）
 * 都会骗过长度检查。2026-10-10 就被第二种骗过一次 —— 那次两域名其实完全一致。
 */
function shaOf(url) {
  const f = `${os.tmpdir()}/hs-${Math.random().toString(36).slice(2)}.bin`;
  const ok = safeCurl(['-sS', '--ssl-no-revoke', '-m', '60', '-o', f, url], 1024 * 1024) !== null;
  if (!ok || !fs.existsSync(f)) return '';
  const hash = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
  fs.rmSync(f, { force: true });
  return hash;
}

/** 比内容哈希；不等就再取一次，避开"刚发布还在传播"的窗口，只有两次都不等才判红。 */
function sameContent(label, urlA, urlB) {
  let a = shaOf(urlA);
  let b = shaOf(urlB);
  if (a === b && a) {
    console.log(`  PASS ${label}（sha ${a}）`);
    pass++;
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  a = shaOf(urlA);
  b = shaOf(urlB);
  const ok = a === b && !!a;
  ok ? pass++ : (fail++, bad.push(`${label}：内容不一致 ${a} vs ${b}（重试后仍不同）`));
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}（sha ${a} vs ${b}）${ok ? '（首次不同=传播窗口，重试后一致）' : ''}`);
}

console.log('=== 1) 两个 CDN 域名的关键对象必须等价 ===');
const objects = [
  ['/cdn/v1/art.json', 'application/json', 10000],
  ['/cdn/v1/mirrors.json', 'application/json', 10000],
  ['/cdn/v1/index.json', 'application/json', 1000000],
  ['/cdn/v1/tree.json', 'application/json', 100000],
  ['/cdn/v1/pick.js', 'text/javascript', 2000],
  // The contract itself is part of the interface, so it is swept like every other interface file.
  ['/cdn/v1/api.json', 'application/json', 500],
  ['/cdn/v1/hosted-index.json', 'application/json', 100],
  ['/cdn/v1/upload-log.json', 'application/json', 100],
  ['/cdn/v1/probe.bin', 'application/octet-stream', 262144],
  ['/data/assets.json', 'application/json', 100000],
  ['/data/local-assets.json', 'application/json', 100000],
  ['/assets/char/avatar/char_1016_agoat2.png', 'image/png', 60000],
  ['/fonts/bender-regular.otf', 'font/otf', 40000],
];
const A = 'weishucdn.jiangjiangze.icu';
const B = 'weishucdn2.jiangjiangze.icu';
for (const [p, type, min] of objects) {
  check(`${A.split('.')[0]}${p}`, `https://${A}${p}${cb()}`, { code: '200', type, min, acao: '*' });
  check(`${B.split('.')[0]}${p}`, `https://${B}${p}${cb()}`, { code: '200', type, min, acao: '*' });
}
console.log('  —— 两域名逐对象比内容哈希（不是比长度）——');
for (const [p] of objects) sameContent(`两域名 ${p}`, `https://${A}${p}${cb()}`, `https://${B}${p}${cb()}`);

console.log('\n=== 2) APK 线：签名清单引用的每个按需素材包都必须在桶上 ===');
const man = getJson(`https://weishucdn.jiangjiangze.icu/site/manifest.json${cb()}`);
const packs = (man && man.art && man.art.packs) || [];
console.log(`  site/manifest.json buildTag=${man && man.buildTag} art.version=${man && man.art && man.art.version} packs=${packs.length}`);
let packFail = 0;
for (const p of packs) {
  const url = (p.urls || [])[0];
  if (!url) continue;
  const r = probe(url);
  const ok = r.code === '200' && r.bytes === Number(p.size);
  if (!ok) {
    packFail++;
    bad.push(`APK 包 ${p.id}: ${r.code} ${r.bytes}B / 声明 ${p.size}B`);
  }
}
console.log(`  ${packFail ? 'FAIL' : 'PASS'} 逐个包核对：${packs.length - packFail}/${packs.length} 命中且大小与清单一致`);
packFail ? (fail += 1) : (pass += 1);
const apkJ = getJson(`https://weishucdn.jiangjiangze.icu/apk/latest.json${cb()}`);
if (apkJ) check(`APK ${apkJ.tag}`, `${apkJ.apkUrl}${cb()}`, { code: '200', bytes: Number(apkJ.size) });

console.log('\n=== 3) 我清掉的旧 packs 档：GitHub 侧仍在（镜像链后备）===');
const rel = getJson('https://api.github.com/repos/jingjiangze/Stronghold-Protocol-CDN/releases/tags/assets-v0.2.1');
const assets = (rel && rel.assets) || [];
console.log(`  ${assets.length ? 'PASS' : 'FAIL'} release assets-v0.2.1 仍有 ${assets.length} 个资产（R2 那份已清，玩家侧回退还在）`);
assets.length ? pass++ : (fail++, bad.push('GitHub release assets-v0.2.1 没有资产了'));
const cur = getJson('https://api.github.com/repos/jingjiangze/Stronghold-Protocol-CDN/releases/tags/assets-v0.2.2');
console.log(`  当前档 release assets-v0.2.2 资产 ${((cur && cur.assets) || []).length} 个`);

console.log('\n=== 4) dl-site：另一个 Pages 项目（接口必须 GET 探）===');
check('dl 首页', 'https://dl.jiangjiangze.icu/', { code: '200', type: 'text/html' }, 'GET');
check('dl /api/latest', `https://dl.jiangjiangze.icu/api/latest${cb()}`, { code: '200', type: 'application/json', min: 500 }, 'GET');
check('dl /api/servers（无口令=提示语）', `https://dl.jiangjiangze.icu/api/servers${cb()}`, { code: '200', type: 'application/json', min: 20 }, 'GET');
check('dl /servers.json', `https://dl.jiangjiangze.icu/servers.json${cb()}`, { code: '200', type: 'application/json', min: 1000 }, 'GET');
check('dl /admin', 'https://dl.jiangjiangze.icu/admin', { code: '200', type: 'text/html' }, 'GET');
check('R2 site/verified.json', `https://weishucdn.jiangjiangze.icu/site/verified.json${cb()}`, { code: '200', type: 'application/json', min: 1000 });
check('R2 site/servers.json', `https://weishucdn.jiangjiangze.icu/site/servers.json${cb()}`, { code: '200', type: 'application/json', min: 1000 });

console.log('\n=== 5) 文档站：加了 Functions 后静态面不能被劫持 ===');
for (const [label, p] of [['首页', '/'], ['/admin', '/admin'], ['/bandwidth', '/bandwidth'], ['/mod（另一窗口的页）', '/mod']]) {
  check(label, `https://downcdn.jiangjiangze.icu${p}${cb()}`, { code: '200', type: 'text/html' }, 'GET');
}
check('/docs/agent-upload.md', `https://downcdn.jiangjiangze.icu/docs/agent-upload.md${cb()}`, { code: '200', type: 'text/plain', min: 2000 }, 'GET');
check('/data/snapshot.json', `https://downcdn.jiangjiangze.icu/data/snapshot.json${cb()}`, { code: '200', type: 'application/json', min: 100 }, 'GET');
const html = safeCurl(['-sS', '--ssl-no-revoke', '-m', '45', `https://downcdn.jiangjiangze.icu/${cb()}`], 4 * 1024 * 1024) || '';
const css = (html.match(/href="\.\/css\/(cdn\.[0-9a-f]+\.css)"/) || [])[1];
const js = (html.match(/src="\.\/js\/(cdn\.[0-9a-f]+\.js)"/) || [])[1];
// 静态资源用 GET 量长度：Pages 对 HEAD 不回 content-length（chunked），HEAD 只会得到「长度 0」的假红。
if (css) check(`css ${css}`, `https://downcdn.jiangjiangze.icu/css/${css}`, { code: '200', type: 'text/css', min: 2000 }, 'GET');
if (js) check(`js ${js}`, `https://downcdn.jiangjiangze.icu/js/${js}`, { code: '200', type: 'application/javascript', min: 2000 }, 'GET');

console.log(`\n=== 汇总 ===\nPASS ${pass} / FAIL ${fail}`);
console.log(fail ? '要处理的：\n  ' + bad.join('\n  ') : '全绿：改动没有波及别的仓库或 CDN');
// 红了就非零退出：这条命令的用处就是能在改动之后被机器判定，而不只是给人看一眼。
process.exitCode = fail ? 1 : 0;
