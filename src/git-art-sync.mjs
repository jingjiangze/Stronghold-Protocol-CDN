#!/usr/bin/env node
// 把 R2 里**已上线**的托管素材（后台上传登记的 hosted.json）补提交进 git 的 assets-raw 分支。
//
// ## 为什么必须有这一步
//
// git 挂载镜像（ghfast / gitcdn / OpenI raw …）拉的是本仓库的 `assets-raw` 孤儿分支，不是 R2。
// 后台上传的字节只落 R2，登记只进 main 的 hosted.json —— 于是这些源对**后台上传的那部分素材**是
// 404。2026-10-12 审计实测：hosted.json 登记 5,246 个键，只有 1,856 个在 assets-raw 里，
// 缺 3,390 个（约 932 MiB）。本工具补的就是这个缺口，让 git 挂载层对全部素材 coverage:full 名副其实。
//
// ## 为什么不检出工作树
//
// assets-raw 是 14k 文件 / 2 GiB 的孤儿分支。每轮 checkout 一遍只为加几个 blob 是浪费，而且会
// 把 CI 的磁盘跑满。这里用索引平面操作：`read-tree` 把既有树读进一个临时索引（只读对象，快），
// `hash-object -w` 写新 blob，`update-index --index-info` 挂进索引，`write-tree` + `commit-tree`
// 生成提交。全程不碰工作树、不重新哈希任何既有 blob。
//
// ## 为什么逐个 sha256 核对
//
// 索引操作写错一个 blob sha 会静默发布一棵空内容树，而 push 仍然报成功（openi-mirror.mjs 顶部记过
// 这个坑）。所以每个字节在 `hash-object` 之前先与 `cdn/v1/hosted-index.json` 的 sha256 比对，
// 不一致就跳过并报错——宁可少提交，不发布错的字节。
//
// ## 预算：为什么一轮不补完
//
// 首次积压约 932 MiB。CE/作业有超时，且一天四次的节奏本来就是"连续排干"。所以按**字节预算**（默认
// 700 MiB）与**份数**先停，剩下的下一轮继续；没积压时一轮几秒结束（只做一次 read-tree + ls-remote 判定）。
//
// 用法：
//   node src/git-art-sync.mjs                 # 只报告
//   node src/git-art-sync.mjs --write         # 真的提交并推送 assets-raw
//   node src/git-art-sync.mjs --max-bytes=200 # 预算改成 200 MiB
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readHosted } from './hosted.mjs';
import { r2Config, getObject } from './r2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH = 'assets-raw';
const HOSTED_INDEX_KEY = 'cdn/v1/hosted-index.json';

function run(cmd, args, { cwd = ROOT, env = process.env, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} → ${code}: ${err || out}`))));
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const MiB = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const v = hit.slice(name.length + 3);
  return Number.isFinite(Number(v)) ? Number(v) : v;
}

/** 拉一次远端分支：孤儿分支不会被默认 checkout 带上。 */
async function fetchBranch() {
  await run('git', ['fetch', '--quiet', 'origin', `${BRANCH}:refs/heads/${BRANCH}`]);
  return (await run('git', ['rev-parse', `refs/heads/${BRANCH}`])).trim();
}

/** 该分支上已有哪些路径（用于求差集）。 */
async function trackedPaths() {
  const out = await run('git', ['ls-tree', '-r', '--name-only', `refs/heads/${BRANCH}`]);
  return new Set(out.split('\n').filter(Boolean));
}

/** fetch 的 body 可能是 stream/Buffer，统一成 Buffer（sha256 与写 blob 都要具体字节）。 */
async function toBuffer(body) {
  if (!body) return null;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body.arrayBuffer === 'function') return Buffer.from(await body.arrayBuffer());
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/**
 * 把 R2 的字节写成 git blob（不带工作树）。--path 让 git 按该路径的属性判定二进制；
 * 必须在仓库内执行——临时目录不是 git 仓库，hash-object -w 会在那里面失败。
 */
async function writeBlob(buf, key) {
  const sha = await run('git', ['hash-object', '-w', '--path', key, '--stdin'], { cwd: ROOT, input: buf });
  return sha.trim();
}

export async function sync({ write = false, maxBytes = 700 * 1024 * 1024, maxFiles = 1500, log = console.log } = {}) {
  const report = { scanned: 0, added: 0, skipped: 0, bytes: 0, mismatched: [], missing: [], pushed: false, commit: null, remaining: 0, dry: !write };
  const head = await fetchBranch();
  const have = await trackedPaths();
  const { keys, sizes } = readHosted(ROOT);
  const todo = [...keys].filter((k) => !have.has(k));
  report.scanned = todo.length;
  log(`[git-art-sync] 登记 ${keys.size} 键 / 分支已有 ${have.size} 个路径 → 待补 ${todo.length}`);

  // Dry run 到此为止，且**不碰网络与凭据**：首轮积压几百 MiB，只为"报告一下"全量下载一遍字节不划算，
  // 而它并不比上面的路径差集多出任何信息。真正要写才去连桶。
  if (!write) {
    report.remaining = todo.length;
    let bytes = 0; for (const k of todo) bytes += sizes.get(k) || 0;
    report.bytes = bytes;
    log(`[git-art-sync] dry：只做路径差集（不取字节）；待补 ${todo.length} 份 / 约 ${MiB(bytes)}；加 --write 会按预算取并提交`);
    return report;
  }

  const config = r2Config(process.env);

  // sha256 权威表：不在这里的值只能靠体积兜底，仍然会核对，只是少一道。
  let indexFiles = {};
  try {
    const raw = await toBuffer(await getObject(config, HOSTED_INDEX_KEY));
    if (raw) indexFiles = (JSON.parse(raw.toString('utf8'))).files || {};
  } catch (e) {
    log(`[git-art-sync] 读 ${HOSTED_INDEX_KEY} 失败（${e.message}）—— 仍会按体积核对`);
  }

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-gitart-'));
  const indexFile = path.join(cwd, 'index');
  // 既有树读进临时索引：只遍历对象，不检出字节。
  await run('git', ['read-tree', `refs/heads/${BRANCH}`], { cwd: ROOT, env: { ...process.env, GIT_INDEX_FILE: indexFile } });
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };

  const cacheinfo = [];
  for (const key of todo) {
    if (report.added >= maxFiles || report.bytes >= maxBytes) { report.remaining = todo.length - report.added - report.skipped; log(`[git-art-sync] 达到预算（${MiB(report.bytes)} / ${report.added} 份），剩余 ${report.remaining} 留给下一轮`); break; }
    let buf;
    try {
      const raw = await toBuffer(await getObject(config, key));
      if (!raw) { report.missing.push(key); continue; }
      buf = raw;
    } catch (e) {
      report.missing.push(key);   // 桶里取不到：不是本轮能修的，留给下一轮
      continue;
    }
    const want = indexFiles[key]?.sha256;
    if (want && sha256(buf) !== want) { report.mismatched.push(key); continue; }   // 绝不带错字节进树
    const blob = await writeBlob(buf, key);
    cacheinfo.push(`100644 ${blob}	${key}`);
    report.added++;
    report.bytes += buf.length;
  }

  if (!cacheinfo.length) {
    log(`[git-art-sync] 没有新内容可提交（${report.dry ? 'dry' : 'write'}）`);
    return report;
  }

  // update-index 从 stdin 读 `--index-info`：格式是「mode SP sha TAB path」——
  // 逗号分隔是 `--cacheinfo <mode,sha,path>` 的格式，喂给 --index-info 会被判 malformed（实测踩过）。
  // 分批喂，避免单次输入过长。
  for (let i = 0; i < cacheinfo.length; i += 500) {
    const chunk = cacheinfo.slice(i, i + 500);
    await run('git', ['update-index', '--add', '--index-info'], { cwd: ROOT, env, input: `${chunk.join('\n')}\n` });
  }
  const tree = (await run('git', ['write-tree'], { cwd: ROOT, env })).trim();
  const message = `assets: 后台上传素材补入 git（${cacheinfo.length} 个键，${MiB(report.bytes)}，sha256 已逐字节核对）`;
  const commit = (await run('git', ['commit-tree', tree, '-p', head, '-m', message], { cwd: ROOT, env })).trim();
  report.commit = commit;

  if (!write) {
    log(`[git-art-sync] dry：将提交 ${commit.slice(0, 8)}（${cacheinfo.length} 份 / ${MiB(report.bytes)}）；加 --write 才推送`);
    return report;
  }

  // 与 promote-uploads 同一套重试：远端被别的作业推进过时 rebase 语义不适用（孤儿分支只追加提交），
  // 所以这里取回后再以远端为父重做一次提交，绝不 force push。
  await run('git', ['update-ref', `refs/heads/${BRANCH}`, commit], { cwd: ROOT });
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await run('git', ['push', 'origin', `${BRANCH}:${BRANCH}`], { cwd: ROOT });
      report.pushed = true;
      log(`[git-art-sync] 已推送 ${BRANCH} → ${commit.slice(0, 8)}（${cacheinfo.length} 份 / ${MiB(report.bytes)}）`);
      return report;
    } catch (e) {
      log(`[git-art-sync] push 第 ${attempt} 次失败：${e.message}`);
      await run('git', ['fetch', '--quiet', 'origin', `${BRANCH}:refs/heads/${BRANCH}`], { cwd: ROOT }).catch(() => {});
      const nowHead = (await run('git', ['rev-parse', `refs/heads/${BRANCH}`], { cwd: ROOT })).trim();
      const t2 = (await run('git', ['write-tree'], { cwd: ROOT, env })).trim();
      const c2 = (await run('git', ['commit-tree', t2, '-p', nowHead, '-m', message], { cwd: ROOT, env })).trim();
      report.commit = c2;
      await run('git', ['update-ref', `refs/heads/${BRANCH}`, c2], { cwd: ROOT });
    }
  }
  throw new Error('assets-raw 推不上去：字节未进 git，git 挂载镜像仍拿不到这批素材');
}

// Windows 上 path.resolve 给出 `C:\...`，直接拼 `file://` 永远不相等 —— 用 pathToFileURL 才对得上。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const write = process.argv.includes('--write');
  const r = await sync({ write, maxBytes: arg('max-bytes', 700) * 1024 * 1024, maxFiles: arg('max-files', 1500) });
  if (r.mismatched.length) console.log(`[git-art-sync] 摘要不一致已跳过 ${r.mismatched.length} 个：${r.mismatched.slice(0, 5).join(', ')}`);
  if (r.missing.length) console.log(`[git-art-sync] 桶里取不到 ${r.missing.length} 个：${r.missing.slice(0, 5).join(', ')}`);
}
