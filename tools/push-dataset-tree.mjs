#!/usr/bin/env node
// 把 `assets-raw` 孤儿分支的整棵素材树推到 ModelScope **数据集**的 `releases/v1-trial/`。
//
//   node tools/push-dataset-tree.mjs [--dry-run] [--max-files=N] [--max-bytes=MiB]
//
// ## 为什么必须有这个脚本（2026-10-14 实测）
//
// 数据集 `jingjiangze/Stronghold-Protocol-Assets` 的 `releases/v1-trial` 装着素材树，是容器侧
// （魔搭创空间）的首选源，实测只覆盖 **53%**。审计结论：不是平台拒收，而是**这批文件从来没被推过**
// —— 全仓只有 `push-rank-modelscope.mjs` 会写这个数据集，而它只碰 `cdn/v1/rank.json` 一个路径，
// 素材树是当初一次性灌入后停更。本脚本补的就是这条链。
//
// ## 与另外两个魔搭推送者的分工（三条互不相干，别混）
//
//   push-modelscope.mjs     → **创空间** `cdn` 分支（整树，仅 feat/modelscope-mirror 分支有，未合 main）
//   push-rank-modelscope.mjs→ **数据集** `cdn/v1/rank.json`（单文件，rank.yml 每天四次）
//   push-dataset-tree.mjs   → **数据集** `releases/v1-trial/**`（整棵素材树，本脚本）
//
// ## 做法（照 push-rank-modelscope.mjs 已验证的模式）
//
//   - `--depth 1 --filter=blob:none --sparse` 克隆：数据集装着 16 GB，普通 depth-1 克隆实测 90 s
//     还没完（要拉全部 blob 元数据），blobless + 稀疏实测 ~3 s。
//   - 稀疏检出排除 `releases/` 之外的东西不管，但我们**要写 releases/**，所以 sparse 只用来
//     避免把已有 blob 拉全——实际写入的文件由本机从 CDN 取字节后落盘。
//   - 字节来源：默认从 `assets-raw` 用 `git archive` 直出（字节保真，与创空间那条链同策略）；
//     这要求本机有该 ref（CI 里 fetch 过就有）。
//   - 幂等：落盘后 `git add` 再 `git diff --cached --quiet`，无差异就跳过 push。
//     （必须先 add 再比：`git diff` 对未跟踪文件恒返回"无差异"，首次落地会被误判成一致。）
//   - 分批：整树一次性推会让魔搭侧连接超时，所以按 `--max-bytes` / `--max-files` 分批提交，
//     每批一个 commit 一次 push；跑完仍有剩余就退出码 3 提示再跑一轮。
//
// 凭据走环境变量 MODELSCOPE_URL（与另两个脚本同一约定），脚本从不打印它。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DATASET = 'jingjiangze/Stronghold-Protocol-Assets';
const BRANCH = 'master';
const DEST_ROOT = 'releases/v1-trial';
const SRC_REF = process.env.SRC_REF || 'assets-raw';
const SPARSE_EXCLUDE = '!releases/';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? Number(h.slice(n.length + 3)) : d; };
const MAX_FILES = opt('max-files', 1500);
const MAX_BYTES = opt('max-bytes', 400) * 1024 * 1024;

const REMOTE_URL = process.env.MODELSCOPE_URL || '';
if (!REMOTE_URL && !DRY) {
  console.error('缺少 MODELSCOPE_URL（形如 https://oauth2:<token>@www.modelscope.cn/datasets/<ns>/<name>.git）');
  process.exit(2);
}

const git = (cwd, ...a) =>
  execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim();
const sh = (cmd, cwd) =>
  execFileSync('bash', ['-lc', cmd], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });

/** 源树文件清单（ls-tree，不是 tar -tf：tar 每个目录也出一行，会把计数灌水）。 */
function sourceFiles() {
  const out = git(REPO_ROOT, 'ls-tree', '-r', '--long', SRC_REF);
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\d+\s+blob\s+([0-9a-f]+)\s+(\d+)\s+(.*)$/);
    if (m) rows.push({ path: m[3], size: Number(m[2]) });
  }
  if (!rows.length) throw new Error(`源 ref ${SRC_REF} 列不出文件（本机有这个 ref 吗？CI 里要先 fetch）`);
  return rows;
}

console.log(`源：${SRC_REF} → ${DATASET}@${BRANCH}:${DEST_ROOT}/`);
const all = sourceFiles();
console.log(`  源树 ${all.length} 份 / ${(all.reduce((s, r) => s + r.size, 0) / 1048576).toFixed(1)} MiB`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-tree-'));
try {
  sh(`git clone --depth 1 --filter=blob:none --sparse --branch ${BRANCH} --quiet "${REMOTE_URL}" work`, tmp);
  sh(`git -C work sparse-checkout set --no-cone '/*' '${SPARSE_EXCLUDE}'`, tmp);

  // 已有哪些（按路径判定，避免重复下载字节）
  const have = new Set();
  try {
    const files = fs.readdirSync(path.join(tmp, 'work', DEST_ROOT), { recursive: true });
    console.log(`  数据集现已有 ${files.length} 个条目（部分为目录，仅用于粗判）`);
  } catch { /* 首次，还没有这个目录 */ }
  // 精确判定：git 里已跟踪的路径
  try {
    const tracked = git(path.join(tmp, 'work'), 'ls-files', '--', DEST_ROOT).split('\n').filter(Boolean);
    for (const p of tracked) have.add(p.slice(DEST_ROOT.length + 1));
  } catch { /* 空仓 */ }
  console.log(`  数据集已跟踪 ${have.size} 份`);

  const todo = all.filter((r) => !have.has(r.path));
  console.log(`  待补 ${todo.length} 份 / ${(todo.reduce((s, r) => s + r.size, 0) / 1048576).toFixed(1)} MiB`);
  if (!todo.length) { console.log('数据集已与源树一致，无需推送。'); process.exit(0); }

  // 取字节：直接从 git 对象读，不经网络（源 ref 在本机/CI 已 fetch）
  let added = 0, bytes = 0;
  const batch = [];
  for (const r of todo) {
    if (added >= MAX_FILES || bytes >= MAX_BYTES) break;
    const dest = path.join(tmp, 'work', DEST_ROOT, r.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      execFileSync('git', ['cat-file', 'blob', `${SRC_REF}:${r.path}`], {
        cwd: REPO_ROOT, stdio: ['ignore', fs.openSync(dest, 'w'), 'pipe'], maxBuffer: 1 << 28,
      });
    } catch (e) {
      console.warn(`  跳过 ${r.path}（读 blob 失败：${e.message}）`);
      continue;
    }
    batch.push(`${DEST_ROOT}/${r.path}`);
    added++; bytes += r.size;
  }
  if (!added) { console.log('本轮没有可提交内容'); process.exit(0); }

  const w = path.join(tmp, 'work');
  // 分批 add，避免命令行过长
  for (let i = 0; i < batch.length; i += 400) {
    git(w, 'add', '--', ...batch.slice(i, i + 400));
  }
  const unchanged = (() => {
    try { git(w, 'diff', '--quiet', '--cached'); return true; } catch { return false; }
  })();
  if (unchanged) { console.log('内容与数据集一致，无需推送。'); process.exit(0); }

  console.log(`  本轮 ${added} 份 / ${(bytes / 1048576).toFixed(1)} MiB`);
  if (DRY) { console.log('干跑结束（未推送）。'); process.exit(0); }

  execFileSync('git', ['-C', w, '-c', 'user.name=cdn-bot', '-c', 'user.email=cdn-bot@users.noreply.modelscope.cn',
    '-c', 'commit.gpgsign=false', 'commit', '-m', `assets: 补入素材树（${added} 份，${(bytes / 1048576).toFixed(1)} MiB）`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(w, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
  console.log(`已推送 ${DATASET}@${BRANCH}`);
  const remain = todo.length - added;
  if (remain > 0) {
    console.log(`还剩 ${remain} 份 —— 再跑一轮本脚本继续。`);
    process.exit(3);
  }
  console.log('数据集素材树已与源树一致。');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
