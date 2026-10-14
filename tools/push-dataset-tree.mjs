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
//   - `--depth 1 --filter=blob:none --no-checkout` 克隆：数据集装着 16 GB，普通 depth-1 克隆实测 90 s
//     还没完（要拉全部 blob 元数据），blobless 约 3 s；再加 `--no-checkout` 连工作树都不落
//     （sparse-checkout 会把我们要写的 releases/ 排除掉，实测 `git add` 直接报
//     "not in the current sparse checkout"，所以这条链不能用 sparse）。
//   - 不检出就没有 index，clone 后 `git read-tree HEAD` 把 HEAD 树灌进 index —— 否则 commit
//     出来的树只有本轮新增，会把数据集已有的 17k 份全删掉。
//   - 已有哪些：直接 `git ls-tree -r HEAD -- releases/v1-trial`（读树，不依赖 index/工作树）。
//   - 字节来源：从 `assets-raw` 用 `git cat-file blob` 直读（字节保真，不经网络）。
//   - 幂等：落盘后 `git add` 再 `git diff --cached --quiet`，无差异就跳过 push。
//     （必须先 add 再比：`git diff` 对未跟踪文件恒返回"无差异"，首次落地会被误判成一致。）
//   - 分批：整树一次性推会让魔搭侧连接超时，所以按 `--max-bytes` / `--max-files` 分批提交，
//     每批一个 commit 一次 push；跑完仍有剩余就退出码 3 提示再跑一轮。
//
// 凭据走环境变量 MODELSCOPE_URL（与另两个脚本同一约定），脚本从不打印它。
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DATASET = 'jingjiangze/Stronghold-Protocol-Assets';
const BRANCH = 'master';
const DEST_ROOT = 'releases/v1-trial';
const SRC_REF = process.env.SRC_REF || 'assets-raw';

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
  sh(`git clone --depth 1 --filter=blob:none --no-checkout --branch ${BRANCH} --quiet "${REMOTE_URL}" work`, tmp);

  // 没有工作树就没有 index：把 HEAD 树灌进 index，否则本轮 commit 只会含新增文件，
  // 等于把数据集已有的 17k 份全删掉。
  sh('git -C work read-tree HEAD', tmp);

  // 已有哪些：读远端树（不依赖 index/工作树）
  const have = new Set();
  for (const line of git(path.join(tmp, 'work'), 'ls-tree', '-r', '--name-only', 'HEAD', '--', DEST_ROOT).split('\n')) {
    if (line.startsWith(DEST_ROOT + '/')) have.add(line.slice(DEST_ROOT.length + 1));
  }
  console.log(`  数据集已有 ${have.size} 份`);

  const todo = all.filter((r) => !have.has(r.path));
  console.log(`  待补 ${todo.length} 份 / ${(todo.reduce((s, r) => s + r.size, 0) / 1048576).toFixed(1)} MiB`);
  if (!todo.length) { console.log('数据集已与源树一致，无需推送。'); process.exit(0); }

  const w = path.join(tmp, 'work');
  // 写入：字节从源 ref 的 blob 读出，hash-object -w --stdin 写进数据集对象库，
  // update-index --cacheinfo 挂到 index —— 全程不落工作树（clone 用了 --no-checkout，
  // 本来就没有工作树；走 `git add` 会报 "not in the current sparse checkout"）。
  //
  // 批量：逐文件一个 git 进程实测 1200 份要 9 s（且 round 上限把总量卡死在 37 MiB/轮）；
  // `git hash-object -w --stdin-paths` 一次进程能吃整批路径清单，字节走它的 stdin。
  // 但 --stdin-paths 读的是**本地文件路径**，源在工作树里并不存在（源是孤儿分支上的 blob），
  // 所以这里用 --no-filters 的批处理做不到；改成本批先落盘到临时目录再一次 hash-object。
  // cat-file 同理：--batch 一条进程吐整批 blob（逐文件起进程实测 1200 份 ~9 s，批量 500 份 0.87 s）。
  // 用 spawnSync：execFileSync 的 maxBuffer 对 Buffer 返回值有硬上限，整批字节会抛 ERR_OUT_OF_RANGE。
  const plan = [];
  {
    let n = 0, b = 0;
    for (const r of todo) { if (n >= MAX_FILES || b >= MAX_BYTES) break; plan.push(r); n++; b += r.size; }
  }
  if (!plan.length) { console.log('本轮没有可提交内容'); process.exit(0); }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-stage-'));
  // 分块喂 --batch：一次喂几千条会撞上 Node/管道缓冲，实测第 4119 条开始 head 为空（输出被截）。
  // 每块 CHUNK 条、单独一条进程，既稳又比逐文件快两个数量级（500 份实测 0.87 s）。
  const CHUNK = Number(process.env.BATCH_CHUNK || 800);
  const rel = [];
  for (let c = 0; c < plan.length; c += CHUNK) {
    const slice = plan.slice(c, c + CHUNK);
    const res = spawnSync('git', ['cat-file', '--batch'], {
      cwd: REPO_ROOT, maxBuffer: 512 * 1024 * 1024, input: slice.map((r) => `${SRC_REF}:${r.path}\n`).join(''),
    });
    if (res.status) throw new Error(`cat-file --batch 退出 ${res.status}: ${res.stderr}`);
    const out = res.stdout;
    let off = 0;
    for (let i = 0; i < slice.length; i++) {
      const nl = out.indexOf('\n', off);
      if (nl < 0) throw new Error(`cat-file --batch 块 ${c} 第 ${i} 条：${slice[i].path} 找不到头部换行（off=${off}/${out.length}）`);
      const head = out.slice(off, nl).toString('utf8').trim().split(/\s+/);
      const size = Number(head[2]);
      if (!Number.isFinite(size) || head[1] !== 'blob') {
        throw new Error(`cat-file --batch 块 ${c} 第 ${i} 条：${slice[i].path} 解析失败 head="${head.join(' ')}"`);
      }
      const start = nl + 1;
      const dest = path.join(stage, slice[i].path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, out.subarray(start, start + size));
      rel.push(slice[i].path);
      off = start + size + 1; // 末尾还有一个 \n
    }
  }
  const bytes = plan.reduce((s, r) => s + r.size, 0);
  const added = rel.length;

  // 一次进程 hash 一批（--stdin-paths 读路径清单），同样分块避免命令行/输出缓冲爆掉。
  const cacheinfo = [];
  for (let i = 0; i < rel.length; i += CHUNK) {
    const slice = rel.slice(i, i + CHUNK);
    const h = spawnSync('git', ['hash-object', '-w', '--no-filters', '--stdin-paths'], {
      cwd: w, maxBuffer: 64 * 1024 * 1024,
      input: slice.map((p) => path.resolve(stage, p)).join('\n') + '\n',
    });
    if (h.status) throw new Error(`hash-object 退出 ${h.status}: ${h.stderr}`);
    const shas = h.stdout.toString('utf8').trim().split('\n');
    if (shas.length !== slice.length) throw new Error(`hash-object 返回 ${shas.length} 行，期望 ${slice.length}`);
    for (let k = 0; k < slice.length; k++) cacheinfo.push(`100644 ${shas[k]}\t${DEST_ROOT}/${slice[k]}`);
  }
  fs.rmSync(stage, { recursive: true, force: true });

  // update-index 分批喂（一次几万条会让命令行爆掉）
  for (let i = 0; i < cacheinfo.length; i += 2000) {
    execFileSync('git', ['update-index', '--add', '--index-info'], {
      cwd: w, input: cacheinfo.slice(i, i + 2000).join('\n') + '\n', encoding: 'utf8',
    });
  }
  console.log(`  index 已挂 ${cacheinfo.length} 条`);

  const tree = git(w, 'write-tree');
  // 与父提交同树？不可能（我们刚加了文件），但要防重复跑：比对父提交树
  const parent = git(w, 'rev-parse', 'HEAD');
  const parentTree = git(w, 'rev-parse', 'HEAD^{tree}');
  if (tree === parentTree) { console.log('内容与数据集一致，无需推送。'); process.exit(0); }

  console.log(`  本轮 ${added} 份 / ${(bytes / 1048576).toFixed(1)} MiB`);
  if (DRY) { console.log('干跑结束（未推送）。'); process.exit(0); }

  const commit = git(w, '-c', 'user.name=cdn-bot', '-c', 'user.email=cdn-bot@users.noreply.modelscope.cn',
    '-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', parent,
    '-m', `assets: 补入素材树（${added} 份，${(bytes / 1048576).toFixed(1)} MiB）`);
  git(w, 'update-ref', `refs/heads/${BRANCH}`, commit);
  git(w, 'push', 'origin', `refs/heads/${BRANCH}:refs/heads/${BRANCH}`);
  console.log(`已推送 ${DATASET}@${BRANCH} → ${commit.slice(0, 8)}`);
  const remain = todo.length - added;
  if (remain > 0) {
    console.log(`还剩 ${remain} 份 —— 再跑一轮本脚本继续。`);
    process.exit(3);
  }
  console.log('数据集素材树已与源树一致。');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
