#!/usr/bin/env node
// Pull files that exist only on the ModelScope dataset into the GitHub `assets-raw`
// branch — the return leg of the three-way sync:
//
//   dataset tree  --(this tool)-->  assets-raw  --(dataset-tree.yml)-->  dataset tree
//
// The forward leg (`tools/push-dataset-tree.mjs`) is add-only, so anything written
// straight into the dataset (manual git-lfs uploads, repair passes) never reaches git
// on its own. This closes that gap. Deletions are deliberately NOT propagated: the
// dataset is a mirror, so a missing file there must not remove bytes from git.
//
// Reads the public dataset over HTTPS (no ModelScope credential) and writes through the
// GitHub Data API with a fast-forward-only ref update. Never prints a token.
//
//   node tools/pull-dataset-tree.mjs            # dry run: print the plan
//   node tools/pull-dataset-tree.mjs --write    # download and commit into assets-raw
//
// Env: GH_TOKEN (or GITHUB_TOKEN), GITHUB_REPOSITORY, MODELSCOPE_DATASET
//      (ns/name), SP_DATASET_REV, SP_DATASET_ROOT, SP_SYNC_MAX_MB, GITHUB_STEP_SUMMARY.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = process.env.GITHUB_REPOSITORY || 'jingjiangze/Stronghold-Protocol-CDN';
const REF = process.env.SP_SYNC_REF || 'assets-raw';
const DATASET = process.env.MODELSCOPE_DATASET || 'jingjiangze/Stronghold-Protocol-Assets';
const REV = process.env.SP_DATASET_REV || 'master';
const ROOT = process.env.SP_DATASET_ROOT || 'releases/v1-trial';
// GitHub rejects blobs of 100 MB or more on a normal branch. assets-raw now carries an LFS
// rule for assets/local/sp-bundle/*.spart, but the Data API used below can only create plain
// blobs -- it cannot mint LFS objects -- so oversized files stay on the dataset and are listed
// in the summary rather than silently dropped.
const MAX_BYTES = Number(process.env.SP_SYNC_MAX_MB || 95) * 1024 * 1024;

const WRITE = process.argv.includes('--write');
const TOKEN =
  process.env.GH_TOKEN ||
  process.env.GITHUB_TOKEN ||
  execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();

const mib = (n) => (n / 1048576).toFixed(1);

const api = async (method, url, body) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch('https://api.github.com' + url, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    // 5xx is worth retrying; 4xx is a real answer (conflict handling is the caller's job).
    if (res.status < 500 || attempt === 3) {
      throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, 800 * attempt));
  }
};

const datasetTree = async () => {
  const base =
    `https://www.modelscope.cn/api/v1/datasets/${DATASET}/repo/tree` +
    `?Revision=${REV}&Path=${encodeURIComponent(ROOT)}&Recursive=true&PageSize=1000&PageNumber=`;
  const files = [];
  for (let page = 1; page <= 200; page++) {
    const res = await fetch(base + page);
    if (!res.ok) {
      throw new Error(
        `dataset tree page ${page} -> HTTP ${res.status}` +
          (res.status === 401 || res.status === 403
            ? ' (dataset may have been made private again; this leg needs it public)'
            : ''),
      );
    }
    const json = await res.json();
    const rows = (json.Data && json.Data.Files) || [];
    for (const row of rows) {
      if (row.Type !== 'blob') continue;
      const p = String(row.Path || '');
      if (!p.startsWith(ROOT + '/')) continue;
      files.push({ path: p.slice(ROOT.length + 1), size: Number(row.Size) || 0 });
    }
    if (rows.length < 1000) break;
  }
  return files;
};

const resolveUrl = (p) =>
  `https://www.modelscope.cn/datasets/${DATASET}/resolve/${REV}/${ROOT}/` +
  p.split('/').map(encodeURIComponent).join('/');

const download = async (p, expect) => {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(resolveUrl(p), { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (expect && buf.length !== expect) throw new Error(`size ${buf.length} != ${expect}`);
      return buf;
    } catch (e) {
      if (attempt === 4) throw new Error(`download ${p}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
};

const head = async () => {
  const ref = await api('GET', `/repos/${REPO}/git/ref/heads/${REF}`);
  const commit = await api('GET', `/repos/${REPO}/git/commits/${ref.object.sha}`);
  return { sha: ref.object.sha, tree: commit.tree.sha };
};

const main = async () => {
  const [base, datasetFiles] = await Promise.all([head(), datasetTree()]);
  const tree = await api('GET', `/repos/${REPO}/git/trees/${base.tree}?recursive=1`);
  if (tree.truncated) throw new Error('assets-raw tree response truncated; refusing to diff');
  const have = new Set(tree.tree.filter((e) => e.type === 'blob').map((e) => e.path));

  const only = datasetFiles
    .filter((f) => !have.has(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const tooBig = only.filter((f) => f.size >= MAX_BYTES);
  const todo = only.filter((f) => f.size < MAX_BYTES);

  const lines = [
    `assets-raw head: \`${base.sha}\``,
    `dataset files: ${datasetFiles.length} · assets-raw blobs: ${have.size}`,
    `dataset-only: ${only.length} (${mib(only.reduce((s, f) => s + f.size, 0))} MiB)`,
    `· will pull into git: ${todo.length} (${mib(todo.reduce((s, f) => s + f.size, 0))} MiB)`,
    `· left on the dataset only (>= ${MAX_BYTES / 1048576} MiB; the Data API cannot create LFS objects): ${tooBig.length}`,
    ...tooBig.map((f) => `  - ${mib(f.size)} MiB \`${f.path}\``),
    ...todo.map((f) => `  - ${f.size} B \`${f.path}\``),
  ];
  console.log(lines.join('\n').replace(/`/g, ''));

  if (!WRITE || !todo.length) {
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### dataset → git\n\n${lines.map((l) => l.replace(/^· /, '- ')).join('\n')}\n\n` +
          (WRITE ? 'nothing to pull.\n' : 'dry run.\n'),
      );
    }
    console.log(WRITE ? '\nnothing to pull; in sync.' : '\ndry run; pass --write to apply.');
    return;
  }

  const entries = [];
  for (const f of todo) {
    const buf = await download(f.path, f.size);
    const blob = await api('POST', `/repos/${REPO}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64',
    });
    entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    console.log(`blob ${blob.sha.slice(0, 8)}  ${buf.length} B  ${f.path}`);
  }

  const message =
    `sync(assets-raw): 从魔搭数据集拉回 ${entries.length} 份仅存在于魔搭的素材\n\n` +
    `来源 ${DATASET}@${REV}:${ROOT}/。另有 ${tooBig.length} 份单文件超过 GitHub 100 MB 上限（` +
    `本工具只用 Data API 建普通 blob，造不出 LFS 对象）留在数据集侧，未纳入 git。`;

  // Fast-forward only: if the branch moved while we were downloading, rebuild on the new head.
  for (let attempt = 1; attempt <= 4; attempt++) {
    const now = await head();
    try {
      const newTree = await api('POST', `/repos/${REPO}/git/trees`, {
        base_tree: now.tree,
        tree: entries,
      });
      const commit = await api('POST', `/repos/${REPO}/git/commits`, {
        message,
        tree: newTree.sha,
        parents: [now.sha],
      });
      await api('PATCH', `/repos/${REPO}/git/refs/heads/${REF}`, { sha: commit.sha, force: false });
      console.log(`\ncommitted ${commit.sha} (parent ${now.sha})`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `\ncommitted \`${commit.sha}\` with ${entries.length} files.\n`,
        );
      }
      return;
    } catch (e) {
      if (attempt === 4) throw e;
      console.log(`attempt ${attempt} hit ${e.message}; retrying on the new head`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
};

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
