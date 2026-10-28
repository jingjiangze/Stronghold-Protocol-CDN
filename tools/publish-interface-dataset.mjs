#!/usr/bin/env node
// Mirror the published interface files (`cdn/v1/*`) from R2 into the ModelScope dataset root.
//
// Why this exists (2026-10-28): R2 is upload staging only and its custom domains are unbound, so
// R2 can no longer serve the interface. The site seeds its same-origin copies from the dataset root
// — and the dataset's `cdn/v1/*` had drifted into a mix of eras (index v0.3.1, art v0.2.6), which
// is why `tree-refresh` refuses to publish. This copies the freshly rebuilt set (produced by
// `sync.mjs --write --interface-only` into R2) into the dataset, so the dataset becomes the
// durable, R2-free home of the interface.
//
//   node tools/publish-interface-dataset.mjs [--dry-run]
//
// Env: MODELSCOPE_URL (dataset remote, never printed) + the usual R2_* credentials.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getObject, r2Config } from '../src/r2.mjs';

const DATASET = 'jingjiangze/Stronghold-Protocol-Assets';
const BRANCH = 'master';
// The set `sync.mjs --interface-only` republishes. `rank.json` is handled by its own tool.
const KEYS = [
  'cdn/v1/art.json',
  'cdn/v1/mirrors.json',
  'cdn/v1/pick.js',
  'cdn/v1/network.json',
  'cdn/v1/tree.json',
  'cdn/v1/api.json',
];
const SPARSE_EXCLUDE = '!releases/';

const DRY = process.argv.includes('--dry-run');
const REMOTE_URL = process.env.MODELSCOPE_URL || '';
if (!REMOTE_URL && !DRY) {
  console.error('缺少 MODELSCOPE_URL（形如 https://oauth2:<token>@www.modelscope.cn/datasets/<ns>/<name>.git）');
  process.exit(2);
}

const config = r2Config(process.env);

/** Read + sanity-check one object. A malformed interface file is worse than a stale one. */
const fetchKey = async (key) => {
  const body = await getObject(config, key);
  if (body == null) throw new Error(`${key} 在 R2 上不存在 —— 先跑 sync.mjs --write --interface-only 生成它`);
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (buf.length === 0) throw new Error(`${key} 是空对象`);
  if (key.endsWith('.json')) {
    let doc;
    try {
      doc = JSON.parse(buf.toString('utf8'));
    } catch (error) {
      throw new Error(`${key} 不是合法 JSON：${error.message}`);
    }
    if (key === 'cdn/v1/art.json') {
      const token = (doc.art || doc).token;
      if (!token) throw new Error('art.json 里没有 token —— 它可能是旧的或没被 --interface-only 重写过');
    }
  }
  return buf;
};

const main = async () => {
  const files = new Map();
  for (const key of KEYS) files.set(key, await fetchKey(key));

  // tree-<token>.json 的版本化副本也在发布集里，key 名要按刚读到的 token 拼。
  const art = JSON.parse(files.get('cdn/v1/art.json').toString('utf8'));
  const token = (art.art || art).token;
  const versionedTree = `cdn/v1/tree-${token}.json`;
  files.set(versionedTree, await fetchKey(versionedTree));

  for (const [key, buf] of files) console.log(`  ${buf.length} B  ${key}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iface-ms-'));
  const git = (...a) =>
    execFileSync('git', a, { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }).trim();
  const sh = (cmd) =>
    execFileSync('bash', ['-lc', cmd], { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }).trim();

  try {
    sh(`git clone --depth 1 --filter=blob:none --sparse --branch ${BRANCH} --quiet "${REMOTE_URL}" work`);
    sh(`git -C work sparse-checkout set --no-cone '/*' '${SPARSE_EXCLUDE}'`);
    fs.mkdirSync(path.join(tmp, 'work', 'cdn', 'v1'), { recursive: true });

    for (const [key, buf] of files) {
      const dest = path.join(tmp, 'work', key);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      // 先 add 再比：`git diff` 对未跟踪文件返回「无差异」，首次落地的文件会被误判成一致。
      git('-C', 'work', 'add', key);
    }

    let changed = false;
    try {
      git('-C', 'work', 'diff', '--quiet', '--cached', '--', 'cdn/v1');
    } catch {
      changed = true;
    }
    if (!changed) {
      console.log('数据集里的 cdn/v1/* 与 R2 一致，无需推送。');
      return;
    }
    console.log('变更内容：');
    console.log(execFileSync('git', ['-C', 'work', 'diff', '--cached', '--stat', '--', 'cdn/v1'], {
      cwd: tmp,
      encoding: 'utf8',
    }).trim());

    if (DRY) {
      console.log('干跑结束（未推送）。');
      return;
    }
    git('-C', 'work', '-c', 'user.name=cdn-bot', '-c', 'user.email=cdn-bot@users.noreply.modelscope.cn',
      '-c', 'commit.gpgsign=false', 'commit', '-m', `interface ${token}`);
    git('-C', 'work', 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
    console.log(`已推送到 ${DATASET}@${BRANCH}:cdn/v1/*（token ${token}）`);
    console.log(`数据集 master 现指向 ${git('-C', 'work', 'rev-parse', 'HEAD')}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
