#!/usr/bin/env node
// 把 `assets-raw` 孤儿分支的整棵素材树推到 ModelScope **数据集**的 `releases/v1-trial/`。
//
//   node tools/push-dataset-tree.mjs [--dry-run] [--max-files=N] [--max-bytes=MiB]
//                                    [--no-lfs]
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
// ## 2026-10-15：改走 LFS，否则永远推不动
//
// pre-receive 拒收的理由是 `repo size(1784479944) greater than max repo size(1600000000)`。
// 这条上限**只量 git 对象库，不含 LFS 存量**（实测依据：数据集 API 报 StorageSize 3.9 GB，
// 远超 1.6 GB，却仍能正常读写）。而 `git ls-tree -l` 量出来对象库里躺着
// **16,702 份原始字节 blob / 1511.7 MiB**（>1 MiB 的全是 assets/packs/*.zip）——正是
// 本脚本自己用 `hash-object -w --no-filters` 显式绕过 LFS 灌进去的，把上限顶到只剩 ~10 MiB，
// 于是任何新增都被拒（rank.yml 推 3.6 KB 能过，因为它不加大对象）。
//
// 数据集根 `.gitattributes` 早就把 png/mp3/skel/atlas/ttf/otf/woff/woff2 等声明为 LFS，
// `releases/v1-trial/.gitattributes` 只补 `-text -diff -merge`、不动 filter —— 所以这些扩展名
// 本来就该是指针（D1 里 17,751 份确为 130 B 指针），是本脚本把它们写成了原始字节。
// 修法：命中 LFS 表的文件只把 **130 B 指针**写进对象库，真实字节经 `git lfs push` 上传
// （实测可用：Uploading LFS objects 100%，删本地对象后可按 ref 从远端 fetch 回同一字节）。
// 424 份缺口因此只占约 55 KB 对象库，而不是 186.2 MiB。
//
// ⚠ `*.zip` 不在数据集的 LFS 表里，而缺口 86% 的体积正是 8 个 zip（159.97 MiB）。它们仍按
// 原始字节进对象库 —— 这会吃掉余量里的大半。要根治得给数据集补 `*.zip` 的 LFS 规则，
// 但那会改变已有 16k 份的存储形态、影响面远超本次补齐，故本版不动，只把它写进文档。
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
// 默认走 LFS；--no-lfs 回到 2026-10-15 之前的原始字节行为（留作对照与回退）。
const USE_LFS = !args.includes('--no-lfs');
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? Number(h.slice(n.length + 3)) : d; };
// 单轮文件数默认 400：魔搭 `legacy_scan` 按**文件数**拒收（实测 400/490 过、1500 拒，与字节数无关）。
// 与 dataset-tree.yml 的 default/兜底三处必须一致——schedule run 没有 inputs，读的就是这里。
const MAX_FILES = opt('max-files', 400);
const MAX_BYTES = opt('max-bytes', 400) * 1024 * 1024;

// 与数据集根 .gitattributes 的 LFS 表逐字对齐（releases/v1-trial/.gitattributes 只补
// -text -diff -merge，不覆盖 filter）。改动任一侧都要同步这一行，否则本脚本写出的形态
// 与平台 resolve 时认定的形态不一致，客户端会拿到指针原文而不是素材。
//
// `zip` 是**我们补的第二组**：数据集自带的 LFS 表里没有它，而 assets/packs 下 16k 份 zip
// 全以原始字节躺在对象库里（ls-tree -l 实测 1511.7 MiB，>1 MiB 的 blob 几乎都是 zip），
// 正是它们把 1.6 GB 上限顶到只剩 ~10 MiB。给数据集补 `*.zip filter=lfs` 后，**新写入**的
// zip 走指针；已有的 16k 份不会被转换也不会被删（gitattributes 只作用于新写入的 blob）。
// 兼容性已实测：现有 zip 经 resolve 拿回的是 66,407,555 B 真实内容而非 130 B 指针 ——
// 平台会把 LFS 指针 materialize 成原始字节，所以客户端无感。
// `json`/`css`/`svg` 是 2026-10-16 补的第三组（用户 0.3.0 裁决：fill 后对象库又顶穿 1.6 GB，
// repo size(1602462630) > max(1600000000)。元凶 = json 不在 LFS 表 → 12,287 份待补里 5,460 份
// json / 126.9 MiB 走对象库）。配合 --migrate-lfs 一次性把已有 raw json 替换为指针 →
// 对象库降回上限内 → 后续推入不再撞墙。
const LFS_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif',
  'mp3', 'wav', 'ogg', 'm4a',
  'skel', 'atlas',
  'ttf', 'otf', 'woff', 'woff2',
  'zip',
  'json', 'css', 'svg',
]);
// 本轮之前已在 LFS 表里的扩展名——--migrate-lfs 只重推**新纳入**的（已在 LFS 的不用重推）。
const LEGACY_LFS_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif',
  'mp3', 'wav', 'ogg', 'm4a',
  'skel', 'atlas',
  'ttf', 'otf', 'woff', 'woff2',
  'zip',
]);
const isLfsPath = (p) => {
  const dot = p.lastIndexOf('.');
  return dot > p.lastIndexOf('/') && LFS_EXTS.has(p.slice(dot + 1).toLowerCase());
};

// 平台已知不可达豁免表：这些路径**推得上去、但会被平台内容审核自动 revert**，永远进不了
// 数据集 HEAD。若不排除，`have` 永远不含它们 → `todo` 永远含它们 → 每轮 `remain > 0`
// → exit 3 → workflow 自触发续跑 → 再推再被 revert，**无限循环**（每轮还要 clone ~650 MB
// 树、跑 6 轮，白烧 Actions 额度；而 git-art-sync 每次 assets-raw 前进都会再供一次燃料）。
//
// 收录判据（三条同时满足，缺一不收）：
//   ① 源树确有该文件（assets-raw 的 ls-tree 能列出，字节完好）；
//   ② 推送侧无过错——git push 与 git lfs push 都成功，平台却把该路径单独 revert；
//   ③ 历史上重复出现，不是一次性抖动（同一条 revert 记录跨多次推送复现）。
//
// 当前唯一条目（2026-10-15 实测）：
//   assets/skins/char_340_shwaz_snow_1/illustration.png（3,541,555 B，源 blob ef7cac43）
//   平台 revert 记录：9d6d566 加入 → da58372 revert → b51194a revert → … → c64e935 revert
//   （c64e935  revert 的正是本轮 LFS 化推送 df7d76e，且 diff 只有这一条路径、无附带损伤）。
//   客户端侧已有改道：ms-edge 层的 exceptions 表把它指向 r2，见 origins.json 的 ms-dataset note。
//
// ⚠ 维护约定：平台若放行某个路径，**必须从表里删掉它**，否则它会从「永动」变成「静默缺失」。
// 脚本每轮都会打印豁免清单（见下方 `平台审核豁免` 日志），审查时以那行为准。
const PLATFORM_REJECTED = new Set([
  'assets/skins/char_340_shwaz_snow_1/illustration.png',
]);

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

  // --migrate-lfs：一次性把「新纳入 LFS 表但当时以原始字节推入」的路径从 `have` 摘出
  // → 进 todo → 以 130 B 指针重推 → 数据集对象库瘦身回 1.6 GB 内。
  // 正常增量轮不加此 flag（幂等：推过的指针在下一轮 clone 后被 have 覆盖，不会重复）。
  if (args.includes('--migrate-lfs')) {
    let migrated = 0;
    for (const p of [...have]) {
      const ext = isLfsPath(p) ? p.slice(p.lastIndexOf('.') + 1).toLowerCase() : '';
      if (ext && LFS_EXTS.has(ext) && !LEGACY_LFS_EXTS.has(ext)) { have.delete(p); migrated++; }
    }
    console.log(`  --migrate-lfs：${migrated} 份 raw → 指针重推（数据集对象库瘦身）`);
  }

  // 平台审核豁免：先摘出来再算待补。**不是**把它塞进 `have` —— `have` 是「远端真实有什么」，
  // 掺假会让下面的日志与 `ls-tree` 对不上；这里直接从 `todo` 排除，树里自然也没有它。
  // 效果：`remain` 归零 → exit 0 正常收敛，不再触发 workflow 自触发续跑。
  const exempt = all.filter((r) => PLATFORM_REJECTED.has(r.path));
  const exemptPresent = exempt.filter((r) => have.has(r.path));
  if (exempt.length) {
    const kinds = exempt.map((r) => {
      const state = have.has(r.path) ? '已在远端（平台曾放行）' : '不在远端（平台 revert）';
      return `${r.path} [${(r.size / 1024).toFixed(0)} KB] ${state}`;
    });
    console.log(`  平台审核豁免 ${exempt.length} 份 —— 不计入待补、不写入树、不影响 exit 码：`);
    for (const k of kinds) console.log(`    - ${k}`);
    if (exemptPresent.length) {
      console.log(`    ⚠ 其中 ${exemptPresent.length} 份已在远端，说明平台已放行 —— `
        + `应从 PLATFORM_REJECTED 删除，否则会静默不再更新`);
    }
  }

  const todo = all.filter((r) => !have.has(r.path) && !PLATFORM_REJECTED.has(r.path));
  console.log(`  待补 ${todo.length} 份 / ${(todo.reduce((s, r) => s + r.size, 0) / 1048576).toFixed(1)} MiB`);
  if (!todo.length) { console.log('数据集已与源树一致（含平台审核豁免），无需推送。'); process.exit(0); }

  const w = path.join(tmp, 'work');
  // 写入：字节从源 ref 的 blob 读出，hash-object -w --stdin-paths 写进数据集对象库，
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

  // 数据集根 .gitattributes 必须有 `*.zip filter=lfs`，否则我们写进去的 zip 指针不会被平台
  // materialize，客户端 resolve 到的是 130 B 指针原文。幂等：已在就跳过。
  // 只追加一行、不改任何已有行 —— 已有的 16k 份 zip 继续以原始字节躺着，不受影响。
  // 记进 attrCacheinfo 而不是直接 update-index：下面 `read-tree remoteHead`（对齐 rank.yml 的
  // 并发写入）会把 index 整个重置，直接挂上去的那条会丢，必须跟着 cacheinfo 一起重挂。
  const attrCacheinfo = [];
  if (USE_LFS && !args.includes('--no-gitattributes')) {
    let attr = '';
    try { attr = git(w, 'cat-file', '-p', 'HEAD:.gitattributes'); } catch { /* 空仓库，从零写 */ }
    // 确保属性规则 ⊇ LFS_EXTS（不变量：LFS_EXTS 里的每个扩展名都必须有对应的 attr 行，
    // 否则指针不会被平台 materialize，客户端 resolve 到 130 B 原文）。缺哪条补哪条。
    // json/css/svg 的规则限 releases/v1-trial/ 子树，不影响 rank.yml 写的 cdn/v1/rank.json。
    const lines = [];
    for (const ext of LFS_EXTS) {
      const pattern = (ext === 'json' || ext === 'css' || ext === 'svg')
        ? `releases/v1-trial/**/**/*.${ext}`
        : `*.${ext}`;
      if (!new RegExp(`(^|\\n)${pattern.replace(/[./*]/g, m => '\\' + m)}\\s+filter=lfs`).test(attr)) {
        lines.push(`${pattern} filter=lfs diff=lfs merge=lfs -text`);
      }
    }
    if (lines.length) {
      const addition = (attr && !attr.endsWith('\n') ? '\n' : '') + lines.join('\n') + '\n';
      const p = path.join(stage, 'root-gitattributes');
      fs.writeFileSync(p, attr + addition);
      const h = spawnSync('git', ['hash-object', '-w', p], { cwd: w, encoding: 'utf8' });
      if (h.status) throw new Error(`hash-object(.gitattributes) 退出 ${h.status}: ${h.stderr}`);
      attrCacheinfo.push(`100644 ${h.stdout.trim()}\t.gitattributes`);
      console.log(`  将向数据集根 .gitattributes 追加 ${lines.length} 条 LFS 规则`);
    } else {
      console.log('  数据集根 .gitattributes 已含全部 LFS 规则，跳过');
    }
  }
  // 分块喂 --batch：一次喂几千条会撞上 Node/管道缓冲，实测第 4119 条开始 head 为空（输出被截）。
  // 每块 CHUNK 条、单独一条进程，既稳又比逐文件快两个数量级（500 份实测 0.87 s）。
  const CHUNK = Number(process.env.BATCH_CHUNK || 800);
  const rel = [];
  // LFS 分流：命中 LFS 表的文件，真实字节**不进对象库**，只写 130 B 指针；字节交给
  // `git lfs push`。所以落盘后要记下谁走 LFS，后面分别构造指针 blob 与原始 blob。
  const lfsRel = [];
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
      const buf = out.subarray(start, start + size);
      fs.writeFileSync(dest, buf);
      rel.push(slice[i].path);
      if (USE_LFS && isLfsPath(slice[i].path)) lfsRel.push({ path: slice[i].path, size, buf });
      off = start + size + 1; // 末尾还有一个 \n
    }
  }
  const bytes = plan.reduce((s, r) => s + r.size, 0);
  const added = rel.length;

  // 一次进程 hash 一批（--stdin-paths 读路径清单），同样分块避免命令行/输出缓冲爆掉。
  const cacheinfo = [];
  const lfsOids = [];
  if (USE_LFS && lfsRel.length) {
    // 指针自己就是 blob：`git lfs clean` 的输出格式与 `hash-object` 的结果逐字节一致
    // （已用 100 KB 随机文件对照验证：oid/size/换行全部相同），所以不必起 git-lfs 进程。
    const crypto = await import('node:crypto');
    // git-lfs 客户端认得出 index 里的指针（实测报 `(missing) <path> (<oid>)`），但它要求
    // **本地 LFS 对象**存在于 `.git/lfs/objects/<oid[:2]>/<oid[2:4]>/<oid>`；缺了就
    // "Your push was rejected due to missing or corrupt local objects"。字节本来就在内存里，
    // 落一份进去即可 —— 不落会白丢一次上传机会（实测：放好后同一命令立刻 Uploading 100%）。
    const lfsDir = path.join(w, '.git', 'lfs', 'objects');
    for (const f of lfsRel) {
      const oid = crypto.createHash('sha256').update(f.buf).digest('hex');
      const ptr = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${f.size}\n`;
      const p = path.join(stage, f.path + '.lfsptr');
      fs.writeFileSync(p, ptr);
      const h = spawnSync('git', ['hash-object', '-w', p], { cwd: w, encoding: 'utf8' });
      if (h.status) throw new Error(`hash-object(指针) 退出 ${h.status}: ${h.stderr}`);
      cacheinfo.push(`100644 ${h.stdout.trim()}\t${DEST_ROOT}/${f.path}`);
      const dir = path.join(lfsDir, oid.slice(0, 2), oid.slice(2, 4));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, oid), f.buf);
      lfsOids.push(oid);
    }
    const ptrBytes = lfsOids.length * 131;
    console.log(`  LFS 分流：${lfsOids.length} 份写指针（约 ${(ptrBytes / 1024).toFixed(0)} KB），`
      + `原始字节省 ${(lfsRel.reduce((s, f) => s + f.size, 0) / 1048576).toFixed(1)} MiB`);
  }
  for (let i = 0; i < rel.length; i += CHUNK) {
    const slice = rel.slice(i, i + CHUNK);
    // 走 LFS 的已经单独处理过，这里只 hash 剩下的（--no-filters 保持字节原样）。
    // 用 Set 判 membership：数组 some() 在整批 424 份上是 O(n²)，脚本每轮都要跑一遍。
    const lfsSet = USE_LFS ? new Set(lfsRel.map((f) => f.path)) : null;
    const rest = lfsSet ? slice.filter((p) => !lfsSet.has(p)) : slice;
    if (!rest.length) continue;
    const h = spawnSync('git', ['hash-object', '-w', '--no-filters', '--stdin-paths'], {
      cwd: w, maxBuffer: 64 * 1024 * 1024,
      input: rest.map((p) => path.resolve(stage, p)).join('\n') + '\n',
    });
    if (h.status) throw new Error(`hash-object 退出 ${h.status}: ${h.stderr}`);
    const shas = h.stdout.toString('utf8').trim().split('\n');
    if (shas.length !== rest.length) throw new Error(`hash-object 返回 ${shas.length} 行，期望 ${rest.length}`);
    for (let k = 0; k < rest.length; k++) cacheinfo.push(`100644 ${shas[k]}\t${DEST_ROOT}/${rest[k]}`);
  }
  fs.rmSync(stage, { recursive: true, force: true });

  const applyCacheinfo = () => {
    const all = attrCacheinfo.concat(cacheinfo);
    for (let i = 0; i < all.length; i += 2000) {
      execFileSync('git', ['update-index', '--add', '--index-info'], {
        cwd: w, input: all.slice(i, i + 2000).join('\n') + '\n', encoding: 'utf8',
      });
    }
  };
  applyCacheinfo();
  console.log(`  index 已挂 ${cacheinfo.length} 条`);

  // `--missing-ok`：blobless 克隆里 write-tree 会**懒取整棵既有树的 blob** 去解析属性
  // （本地复现：根 .gitattributes → 每个 README/rank.json → 一路索取到每个 mp3/png），
  // 而魔搭对历史 blob 按需取直接拒（`could not fetch … from promisor remote`，
  // run 38852770221 round 2 即死于此）。未变化的条目本来就来自 `read-tree HEAD`（mode/type/oid
  // 齐全），新条目是我们自己 hash-object 的 —— 组树不需要读任何一个 blob 的内容，
  // --missing-ok 写出的 tree 与全物化时字节级相同（run 38798043798/38852770221 实测）。
  const tree = git(w, 'write-tree', '--missing-ok');
  const parentTree = git(w, 'rev-parse', 'HEAD^{tree}');
  if (tree === parentTree) { console.log('内容与数据集一致，无需推送。'); process.exit(0); }

  console.log(`  本轮 ${added} 份 / ${(bytes / 1048576).toFixed(1)} MiB`);
  if (DRY) { console.log('干跑结束（未推送）。'); process.exit(0); }

  // ⚠ 提交前先对齐远端：rank.yml 也在推这个数据集的 master（写 cdn/v1/rank.json），
  // 两边撞车时 push 会报 "cannot lock ref ... is at X but expected Y"（实测 38614298983）。
  // 处理：fetch 后把 index 重置成远端最新树，再把本轮改动重新挂上去 —— 两条链写的路径
  // 互不相交（我们只碰 releases/v1-trial/**），这样合并不会吃掉 rank 那一侧的新提交。
  try {
    git(w, 'fetch', '--depth', '1', 'origin', BRANCH);
  } catch (e) {
    console.warn(`  fetch 失败（按原父提交继续）：${String(e.message).slice(0, 120)}`);
  }
  let parent = git(w, 'rev-parse', 'HEAD');
  const remoteHead = git(w, 'rev-parse', `refs/remotes/origin/${BRANCH}`);
  if (remoteHead !== parent) {
    console.log(`  远端已前进到 ${remoteHead.slice(0, 8)}（并发写入），重挂本轮改动`);
    git(w, 'read-tree', remoteHead);
    applyCacheinfo();
    parent = remoteHead;
  }

  const tree2 = git(w, 'write-tree', '--missing-ok');
  const commit = git(w, '-c', 'user.name=cdn-bot', '-c', 'user.email=cdn-bot@users.noreply.modelscope.cn',
    '-c', 'commit.gpgsign=false', 'commit-tree', tree2, '-p', parent,
    '-m', `assets: 补入素材树（${added} 份，${(bytes / 1048576).toFixed(1)} MiB）`);
  git(w, 'update-ref', `refs/heads/${BRANCH}`, commit);

  // ⚠ 顺序：LFS 字节必须在 git push 之前传上去。指针先落库、字节后到，中间这段窗口里
  // 远端 ref 指向的树里有指针却取不到内容；把 LFS 放前面能把这个窗口压到本进程内，
  // 且 git push 一旦失败，多出来的 LFS 对象只是孤儿、无害（可被平台 GC）。
  // 反过来则会真的坏：客户端解析指针时字节不存在。
  if (USE_LFS && lfsOids.length) {
    const r = spawnSync('git', ['lfs', 'push', 'origin', `refs/heads/${BRANCH}`], {
      cwd: w, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'],
    });
    // git-lfs 对"本地对象缺失"只打 hint、退出码仍是 0（实测），所以不能只判 status，
    // 必须连输出一起看，否则会出现"以为传上去了、其实一个字节都没动"的假成功。
    const msg = String(r.stdout || '') + String(r.stderr || '');
    if (r.status || /missing|corrupt|failed/i.test(msg)) {
      throw new Error(`git lfs push 失败：${msg.slice(0, 400)}`);
    }
    console.log(`  LFS 字节已上传 ${lfsOids.length} 份`);
  }

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
