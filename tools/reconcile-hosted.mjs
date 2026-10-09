// 把被我用本地副本顶掉的 hosted.json 组补回来：以远端当前内容为准，只加不减。
// 这次的错在于：登记 APK 素材包时读的是本地 hosted.json，而 bot 刚在远端加了 admin-selftest 组。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { HOSTED_FILE } from '../src/hosted.mjs';
import { hostedGroupFor, mergeHosted } from '../src/upload.mjs';

const REPO = 'jingjiangze/Stronghold-Protocol-CDN';
const REPO_DIR = 'C:/DDDD/Agent Work/stronghold-cdn/repo';
const token = fs.readFileSync(path.join(os.homedir(), '.gh_fine_token'), 'utf8').trim();

const raw = execFileSync(
  'curl',
  ['-sS', '--ssl-no-revoke', '-m', '45', '-H', `authorization: Bearer ${token}`, '-H', 'accept: application/vnd.github.raw', `https://api.github.com/repos/${REPO}/contents/${HOSTED_FILE}?ref=main`],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);
const doc = JSON.parse(raw);
console.log('远端分组：', doc.hosted.map((e) => `${e.id}(${e.files})`).join(', '));

const logRaw = execFileSync('curl', ['-sS', '--ssl-no-revoke', '-m', '45', `https://weishucdn.jiangjiangze.icu/cdn/v1/upload-log.json?cb=${Date.now()}`], { encoding: 'utf8' });
const log = JSON.parse(logRaw);
const declared = new Set(doc.hosted.flatMap((e) => (e.keys || []).map((k) => (Array.isArray(k) ? k[0] : k))));
const missing = (log.items || []).filter((i) => i && i.key && !i.removedAt && !declared.has(i.key));
if (!missing.length) {
  console.log('没有漏登记的键，不用改。');
  process.exit(0);
}

const bySource = {};
for (const item of missing) (bySource[item.source || 'unknown'] = bySource[item.source || 'unknown'] || []).push(item);
let next = doc;
for (const [source, items] of Object.entries(bySource)) {
  const group = hostedGroupFor({
    source,
    what: items[0].what || `后台上传的 ${items.length} 个文件`,
    addedAt: String(items[0].at || '').slice(0, 10),
    keysWithSizes: items.map((i) => [i.key, Number(i.size)]),
  });
  const merged = mergeHosted(next, group);
  next = merged.doc;
  console.log(`补登记 ${source}：+${merged.added} 个键`);
}

fs.writeFileSync(path.join(REPO_DIR, HOSTED_FILE), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
console.log('写回本地 hosted.json（等待提交推送）');
