// 把「APK 按需素材包」那批键登记进 hosted.json —— 它们被签名清单 site/manifest.json 引用，
// 但不在上游 index.json 里，所以一次 `sync --prune` 就会把它们当镜像残渣删掉，玩家端按需素材全 404。
// 只登记，不删任何东西。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { HOSTED_FILE } from '../src/hosted.mjs';
import { hostedGroupFor, mergeHosted } from '../src/upload.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDN = process.env.SP_CDN_BASE || 'https://weishucdn.jiangjiangze.icu';

const curlGet = (url) => execFileSync('curl', ['-sS', '--ssl-no-revoke', '-m', '60', url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const manifest = JSON.parse(curlGet(`${CDN}/site/manifest.json?cb=${Date.now()}`));
const packs = (manifest.art && manifest.art.packs) || [];
if (!packs.length) throw new Error('site/manifest.json 里没有 art.packs，先确认 APK 清单是否还在这个键上');

// 只登记本桶上的键；GitHub / 镜像前缀那几条 URL 指的是同一批字节，不重复登记。
const rows = [];
const seen = new Set();
for (const pack of packs) {
  for (const url of pack.urls || []) {
    let key = '';
    try {
      const u = new URL(url);
      if (u.hostname !== 'weishucdn.jiangjiangze.icu') continue;
      key = decodeURIComponent(u.pathname).replace(/^\//, '');
    } catch {
      continue;
    }
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // 在线核对：这条键必须真的能取到，否则登记进去的是一个不存在的承诺。
    const status = execFileSync('curl', ['-sS', '--ssl-no-revoke', '-m', '40', '-o', 'nul', '-w', '%{http_code}', '-I', `${CDN}/${key}?cb=${Date.now()}`], { encoding: 'utf8' }).trim();
    if (status !== '200') throw new Error(`${key} 在 CDN 上不是 200（${status}），拒绝登记`);
    rows.push([key, Number(pack.size)]);
    console.log(`  ${key}  ${pack.size} B  sha256 ${String(pack.sha256).slice(0, 12)}…`);
    break;
  }
}

const bytes = rows.reduce((a, r) => a + r[1], 0);
console.log(`共 ${rows.length} 个键 / ${(bytes / 1048576).toFixed(1)} MB`);

const file = path.join(ROOT, HOSTED_FILE);
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const group = hostedGroupFor({
  source: 'apk-art-packs',
  what: '卫戍协议 APK 端的按需素材包（assets/packs/*.zip）。由签名清单 site/manifest.json 的 art.packs 引用，不属于上游素材树；删掉会让玩家端按需下载全部 404',
  addedAt: new Date().toISOString().slice(0, 10),
  keysWithSizes: rows,
});
const merged = mergeHosted(doc, group);
fs.writeFileSync(file, `${JSON.stringify(merged.doc, null, 2)}\n`, 'utf8');
console.log(`hosted.json：分组 ${group.id} 新增 ${merged.added}、覆盖 ${merged.replaced}，现共 ${merged.doc.hosted.length} 个分组`);
