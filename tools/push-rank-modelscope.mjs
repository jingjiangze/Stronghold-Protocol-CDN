#!/usr/bin/env node
// 把 cdn/v1/rank.json 镜像一份到 ModelScope 数据集，作为容器侧「首选门牌」。
//
//   node tools/push-rank-modelscope.mjs [--dry-run] [--file=<path>]
//
// 为什么会有这个文件（2026-10-14 实测）：容器（ModelScope 创空间）读 rank.json 的两个 CF 门牌
// 都要 4.7~20 s，而旧代码的超时是 4 s —— 三条门牌全部读失败，`ranked ?? config.order` 一路退化成
// 静态 order，「动态最快 CDN」在容器侧等于没生效。数据集门牌把这份 3.6 KB 的 JSON 放到容器自己
// 的平台内（实测 67 ms），顺带解决了可达性。
//
// 做法是「稀疏克隆数据集 → 覆盖 cdn/v1/rank.json → 空 commit 短路 → push」：
//   - `--filter=blob:none --sparse` + sparse-checkout 排除 releases/：这个数据集装着 16 GB 素材，
//     普通 --depth 1 克隆实测 90 s 还没完（要拉全部 blob 元数据），blobless + 稀疏实测 **2.9 s**；
//   - 字节没变就跳过 push（`git diff --quiet`），一天四次的 rank 任务绝大多数时候是空转；
//   - 只碰 cdn/v1/rank.json 一个路径，数据集里的素材树一个字不动。
//
// 凭据走环境变量 MODELSCOPE_URL（与 tools/push-modelscope.mjs 同一约定），脚本从不打印它。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DATASET = 'jingjiangze/Stronghold-Protocol-Assets';
const BRANCH = 'master';
const DEST = 'cdn/v1/rank.json';
const SPARSE_EXCLUDE = '!releases/';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const REMOTE_URL = process.env.MODELSCOPE_URL || '';
if (!REMOTE_URL && !DRY) {
  console.error('缺少 MODELSCOPE_URL（形如 https://oauth2:<token>@www.modelscope.cn/datasets/<ns>/<name>.git）');
  process.exit(2);
}

const SRC = opt('file', path.join(REPO_ROOT, 'out', 'cdn', 'v1', 'rank.json'));
if (!fs.existsSync(SRC)) {
  console.error(`找不到 rank.json：${SRC}`);
  process.exit(2);
}
const bytes = fs.readFileSync(SRC);
// 上传前先自查：一份结构坏掉的 rank.json 比没有 rank.json 更糟（见 asset-jump.js 的 rankQualified
// 说明——它会把"谁先登记"放大成对外的速度结论）。
try {
  const doc = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(doc?.rank)) throw new Error('rank 不是数组');
} catch (e) {
  console.error(`rank.json 解析失败，拒绝上传：${e.message}`);
  process.exit(1);
}
console.log(`源：${SRC}（${bytes.length} B）`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rank-ms-'));
const git = (...a) => execFileSync('git', a, { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }).trim();
const sh = (cmd) => execFileSync('bash', ['-lc', cmd], { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }).trim();

try {
  sh(`git clone --depth 1 --filter=blob:none --sparse --branch ${BRANCH} --quiet "${REMOTE_URL}" work`);
  sh(`git -C work sparse-checkout set --no-cone '/*' '${SPARSE_EXCLUDE}'`);
  fs.mkdirSync(path.join(tmp, 'work', 'cdn', 'v1'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'work', DEST), bytes);
  // 必须先 add 再比：`git diff` 对**未跟踪文件**返回"无差异"，而 rank.json 首次落地正是这种情况，
  // 于是它会被误判成"一致"而永远推不上去。
  git('-C', 'work', 'add', DEST);
  const unchanged = (() => {
    try { git('-C', 'work', 'diff', '--quiet', '--cached', '--', DEST); return true; } catch { return false; }
  })();
  if (unchanged) {
    console.log('数据集里的 cdn/v1/rank.json 与本地一致，无需推送。');
    process.exit(0);
  }
  console.log('变更内容：');
  // ⚠ 这里必须显式 cwd：tmp ——裸 execFileSync 会在 CI 的检出目录里找 'work'，
  // 报 fatal: cannot change to 'work'（其余 git 调用都走带 cwd 的 git() helper）。
  console.log(execFileSync('git', ['-C', 'work', 'diff', '--cached', '--stat', '--', DEST], { cwd: tmp, encoding: 'utf8' }).trim());
  if (DRY) {
    console.log('干跑结束（未推送）。');
    process.exit(0);
  }
  const stamp = JSON.parse(bytes.toString('utf8')).generatedAt || new Date().toISOString();
  git('-C', 'work', '-c', 'user.name=cdn-bot', '-c', 'user.email=cdn-bot@users.noreply.modelscope.cn',
    '-c', 'commit.gpgsign=false', 'commit', '-m', `rank ${stamp}`);
  git('-C', 'work', 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
  console.log(`已推送到 ${DATASET}@${BRANCH}:${DEST}`);
  const head = git('-C', 'work', 'rev-parse', 'HEAD');
  console.log(`数据集 master 现指向 ${head}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
