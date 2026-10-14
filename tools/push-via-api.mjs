#!/usr/bin/env node
// 用 GitHub REST API 把一批 blob 提交到 `assets-raw` 分支——git 推送走不通时的兜底。
//
// 为什么需要它（2026-10-14 实测）：本机 git push 到 github.com 两种 SSL 后端都失败——
//   schannel: failed to receive handshake
//   openssl : TLS connect error ... unexpected eof while reading
// 而 `gh api` / curl 走 443 正常。Clash 代理端口（7890/7897）当时全无响应，不改用户代理配置
// 的前提下，git 协议层没有可用通路，于是改用 REST API 的 git data 端点。
//
// 端点序列（与 git  plumbing 一一对应）：
//   POST /repos/{o}/{r}/git/blobs        ← hash-object -w
//   GET  /repos/{o}/{r}/git/refs/heads/assets-raw   ← rev-parse（取父提交）
//   POST /repos/{o}/{r}/git/trees        ← update-index + write-tree
//   POST /repos/{o}/{r}/git/commits      ← commit-tree
//   PATCH /repos/{o}/{r}/git/refs/heads/assets-raw  ← update-ref（fast-forward）
//
// 字节来源：本机 `git cat-file blob <assets-raw-ref>:<path>`——源 ref 已在本地，不经网络。
// 幂等：先取分支已有路径（递归 tree），跳过已存在的，无新增就退出。
// 绝不 force：PATCH 失败（非 fast-forward）即停止重取父提交重试。
//
// 用法：node push-via-api.mjs --max-files=800 --max-bytes=60
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OWNER = 'jingjiangze', REPO = 'Stronghold-Protocol-CDN', BRANCH = 'assets-raw';
const ROOT = path.resolve(import.meta.dirname, '..');

const args = process.argv.slice(2);
const num = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? Number(h.slice(n.length + 3)) : d; };
const MAX_FILES = num('max-files', 800), MAX_BYTES = num('max-bytes', 60) * 1024 * 1024;

// Git Bash 会把 `/repos/...` 改写成文件系统路径（gh 自己报 "Your shell might be rewriting URL
// paths"）。MSYS_NO_PATHCONV=1 关掉这个转换。
const BASH_ENV = { ...process.env, MSYS_NO_PATHCONV: '1' };
const api = async (method, path_, body) => {
  const tmp = path.join(os.tmpdir(), 'sp-api-body.json');
  let cmd;
  if (body) {
    fs.writeFileSync(tmp, JSON.stringify(body));
    cmd = `gh api -X ${method} ${path_} --input "${tmp}"`;
  } else {
    cmd = `gh api -X ${method} ${path_}`;
  }
  const out = execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', maxBuffer: 1 << 28, env: BASH_ENV });
  return out ? JSON.parse(out) : null;
};
const gh = (cmd) => execFileSync('bash', ['-lc', `gh ${cmd}`], { encoding: 'utf8', maxBuffer: 1 << 28, env: BASH_ENV }).trim();
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// 1. 分支已有路径
const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
const parentSha = ref.object.sha;
const parent = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${parentSha}`);
const baseTree = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${parent.tree.sha}?recursive=1`);
const have = new Set((baseTree.tree || []).filter((e) => e.type === 'blob').map((e) => e.path));
console.log(`分支 ${BRANCH} @ ${parentSha.slice(0, 8)}  已有 ${have.size} 个 blob`);

// 2. 本机源 ref 的文件清单（用本地 ref 而不是远端，本机 fetch 过且更全）
const listed = git('ls-tree', '-r', '--long', `refs/heads/${BRANCH}`);
const local = new Map();
for (const line of listed.split('\n')) {
  const m = line.match(/^\d+\s+blob\s+([0-9a-f]+)\s+(\d+)\s+(.*)$/);
  if (m) local.set(m[3], { sha: m[1], size: Number(m[2]) });
}
console.log(`本机 ${BRANCH} ${local.size} 份`);

// 远端缺的（本机有、远端没有）
const todo = [...local.keys()].filter((p) => !have.has(p));
console.log(`待补 ${todo.length} 份`);
if (!todo.length) { console.log('远端已与本机一致'); process.exit(0); }

let added = 0, bytes = 0; const tree = [];
for (const p of todo) {
  if (added >= MAX_FILES || bytes >= MAX_BYTES) break;
  const meta = local.get(p);
  const buf = execFileSync('git', ['cat-file', 'blob', `${BRANCH}:${p}`], { cwd: ROOT, maxBuffer: 1 << 28 });
  const b64 = buf.toString('base64');
  const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, { content: b64, encoding: 'base64' });
  tree.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
  added++; bytes += meta.size;
  if (added % 100 === 0) console.log(`  ...${added} 份 / ${(bytes / 1048576).toFixed(1)} MiB`);
}
if (!added) { console.log('本轮无新增'); process.exit(0); }
console.log(`本轮 ${added} 份 / ${(bytes / 1048576).toFixed(1)} MiB`);

const t = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, { base_tree: parent.tree.sha, tree });
const c = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
  message: `assets: 补入上游素材树缺口（${added} 个键，${(bytes / 1048576).toFixed(1)} MiB）`,
  tree: t.sha, parents: [parentSha],
});
await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: c.sha });
console.log(`已提交 ${c.sha.slice(0, 8)} → ${BRANCH}`);
console.log(`剩余 ${todo.length - added} 份，再跑一轮`);
