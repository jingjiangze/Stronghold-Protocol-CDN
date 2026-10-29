#!/usr/bin/env node
// 把**上游素材树**里还没进 git 的那部分补进 `assets-raw` 孤儿分支。
//
// ## 与 git-art-sync.mjs 的分工（不要混）
//
//   git-art-sync.mjs  → 补 hosted.json 登记的**第三方托管内容**（后台上传、mod 素材）。
//                      它的 todo 来源就是 hosted.json，结构上补不了上游素材。
//   art-tree-fill.mjs → 补**上游素材树**（R2 里 assets/** 这些由 sync.mjs 从上游 release 包
//                      解出并上线的字节）。2026-10-14 实测：R2 权威 29,788 个素材键，
//                      assets-raw 只有 21,768 → 缺 8,020（约 1,146 MiB，其中 assets/packs
//                      899 MiB 是待下线分片包，默认排除）。这 8,020 个**没有任何作业会补**：
//                      全仓只有 git-art-sync 写 assets-raw，而它不看上游树。
//                      后果是 git 挂载层（jsdelivr / ghfast / OpenI）与它的下游（魔搭数据集）
//                      对这批素材一律 404 —— 实测三源抽样：R2 全 200、jsDelivr 全 404。
//
// ## 为什么字节从公开 CDN 取而不是 S3
//
//   这些是**已上线**的公开素材，走公开域名 HEAD/GET 不需要桶凭据，本机就能跑；
//   只有兜底才用 S3（环境里有凭据时）。sha256 权威表来自桶内 cdn/v1/hosted-index.json，
//   取不到就退化为体积核对——与 git-art-sync 同一套保守策略。
//
// ## 为什么仍然走索引平面
//
//   同 git-art-sync：assets-raw 是 2 万+ 文件的孤儿分支，checkout 一遍只为加 blob 是浪费。
//   read-tree → hash-object -w → update-index --index-info → write-tree → commit-tree。
//   不碰工作树、不重新哈希既有 blob。
//
// ## 预算
//
//   首轮积压 ~247 MiB（排除 packs 后）。默认 --max-bytes=220 MiB / --max-files=1200 先停，
//   剩下的下一轮继续；跑空时一轮只做 read-tree + ls-tree 判定，几秒结束。
//
// 用法：
//   node src/art-tree-fill.mjs                      # 只报告
//   node src/art-tree-fill.mjs --write              # 真的提交并推送 assets-raw
//   node src/art-tree-fill.mjs --write --max-bytes=400
//   node src/art-tree-fill.mjs --include-packs      # 连 assets/packs/** 也补（899 MiB，默认不）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { r2Config, getObject } from './r2.mjs';
import { listKeys } from './r2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH = 'assets-raw';
// 无凭据时从哪取字节。原来缺省 weishucdn —— R2 退役后那个域名对任意路径都回 639 B 的占位页，
// 而它又是 200，等于把「取到了」当成了「取对了」。现在优先 SP_ASSET_BASE（真正供字节的门牌），
// 再退到 SP_CDN_BASE，最后才是数据集。
const CDN_BASE = (
  process.env.SP_ASSET_BASE
  || process.env.SP_CDN_BASE
  || 'https://modelscope.cn/datasets/jingjiangze/Stronghold-Protocol-Assets/resolve/master/releases/v1-trial'
).replace(/\/+$/, '');
const HOSTED_INDEX_KEY = 'cdn/v1/hosted-index.json';

// 分片包：待下线通道（manifest 改指 GitHub 后即废弃），899 MiB 全塞进 git 是纯浪费。
// `assets/local/sp-bundle/` 同理排除：那 5 个 256–300 MiB 的 .spart 在 assets-raw 里是
// **Git LFS 指针**，本脚本用 `hash-object -w --path` 写的是原始字节（--path 只查 main 工作树
// 的 .gitattributes，那里没有 LFS 规则），一旦从 R2 捞到这些键就会造出 >100 MB 的普通 blob，
// 推送直接被 GitHub 拒掉、整个 git-art-sync 作业变红。
const EXCLUDE_PREFIXES = ['assets/packs/', 'assets/local/sp-bundle/', 'packs/', 'apk/', 'cdn/'];

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

async function fetchBranch() {
  await run('git', ['fetch', '--quiet', 'origin', `${BRANCH}:refs/heads/${BRANCH}`]).catch(() => {});
  try {
    return (await run('git', ['rev-parse', `refs/heads/${BRANCH}`])).trim();
  } catch {
    throw new Error(`分支 ${BRANCH} 不存在：先建孤儿分支再跑本脚本`);
  }
}

/** 分支里已有的路径集合（只列名字，不读字节）。 */
async function trackedPaths() {
  // 带上体积：只取路径名时，「路径在、字节变了」的上游文件永远进不了 todo，镜像会永久停在
  // 第一次写入的那一版（实测 CDN 卡在 v0.3.1 就有这一半原因）。修复通道需要体积做判据。
  const out = await run('git', ['ls-tree', '-r', '-l', `refs/heads/${BRANCH}`]);
  const sizes = new Map();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab).trim().split(/\s+/);
    if (meta[1] !== 'blob') continue;
    sizes.set(line.slice(tab + 1), Number(meta[3]) || 0);
  }
  return sizes;
}

/**
 * 取一个键的字节。
 *
 * 2026-10-29 事故：这个函数原先在**有凭据时也先走 CDN_BASE**。R2 的自定义域退役后，`CDN_BASE`
 * 指向的域名对任意路径都回 200 + 639 B 的 `o2p-platform` 占位页 —— 于是 714 个「体积不符」的
 * 文件被写成了占位页；而本该兜住的 sha256 权威表（hosted-index.json）也是从同一个域名读的、
 * 同样解析失败，两道保护同时失效。
 *
 * 现在：有凭据就走 S3；并强制用**期望体积**校验（体积来自 S3 LIST，与字节同源），不符就抛错。
 * 占位页 639 B 与真实素材的几万字节永远对不上，这类事故不会再静默通过。
 */
async function fetchBytes(config, key, expected = 0) {
  const check = (buf) => {
    if (expected && buf.length !== expected) {
      throw new Error(`${key}: 取到 ${buf.length} B，与期望 ${expected} B 不符（可能是占位页/错误页）`);
    }
    return buf;
  };
  if (config) {
    return check(Buffer.from(await toBuffer(await getObject(config, key))));
  }
  const res = await fetch(`${CDN_BASE}/${key}`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${key}: CDN ${CDN_BASE} 返 ${res.status}`);
  return check(Buffer.from(await res.arrayBuffer()));
}

async function toBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body.arrayBuffer === 'function') return Buffer.from(await body.arrayBuffer());
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

async function writeBlob(buf, key) {
  const child = spawn('git', ['hash-object', '-w', '--stdin', '--path', key], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const p = new Promise((resolve, reject) => {
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`hash-object ${key} → ${code}: ${err}`))));
  });
  child.stdin.end(buf);
  return p;
}

/**
 * R2 里的上游素材键。
 *
 * 两种来源，按可用性选：
 *  - `--snapshot=<file>`：一份 R2 全量清单（形如 `[{key,size}]` 或 `{objects:[…]}`）。本机没有
 *    R2 S3 凭据（那些是 CI secret），所以本机跑只能走这个。清单必须是当轮审计产物，陈旧清单
 *    会把已删的键当缺口——所以要求它比分支新，且脚本会报告来源与条数让人核对。
 *  - 无 snapshot 时走 S3 LIST（CI 里有凭据时的正常路径）。
 */
async function upstreamKeys(config, snapshot) {
  const keys = new Map();
  if (snapshot) {
    const raw = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.objects || raw.keys || []);
    for (const r of arr) {
      const k = r.key || r.Key;
      if (typeof k !== 'string') continue;
      if (!(k.startsWith('assets/') || k.startsWith('fonts/'))) continue;
      keys.set(k, Number(r.size || r.Size || 0));
    }
    if (!keys.size) throw new Error(`${snapshot}: 没解析出任何 assets/ 或 fonts/ 键`);
    return keys;
  }
  if (!config || !config.bucket) throw new Error('需要 R2 凭据或 --snapshot=<file>');
  for (const prefix of ['assets/', 'fonts/']) {
    for (const row of await listKeys(config, prefix, { maxPages: 200 })) keys.set(row.key, row.size);
  }
  return keys;
}

export async function fill({
  write = false, maxBytes = 220 * 1024 * 1024, maxFiles = 1200,
  includePacks = false, repair = false, snapshot = null, push = true, log = console.log,
} = {}) {
  const report = { scanned: 0, added: 0, bytes: 0, missing: [], mismatched: [], pushed: false, commit: null, remaining: 0, dry: !write };

  const head = await fetchBranch();
  const have = await trackedPaths();
  // 本机没有 R2 S3 凭据（那些是 CI secret）。字节走公开 CDN 已足够——这些是已上线的公开素材——
  // 所以凭据缺失不是错误，只是少一道 sha256 权威核对。
  let config = null;
  try { config = r2Config(process.env); } catch { config = null; }
  const hasCreds = !!(config && config.bucket && config.accessKeyId);

  let indexFiles = {};
  if (hasCreds) {
    try {
      const raw = await fetchBytes(config, HOSTED_INDEX_KEY);
      if (raw) indexFiles = (JSON.parse(raw.toString('utf8'))).files || {};
    } catch (e) {
      log(`[art-tree-fill] 读 ${HOSTED_INDEX_KEY} 失败（${e.message}）—— 仍会按体积核对`);
    }
  } else {
    log(`[art-tree-fill] 无 R2 凭据：字节走 ${CDN_BASE}，sha256 权威表不可用（退化为体积核对）`);
  }

  const all = await upstreamKeys(config, snapshot);
  const exclude = includePacks ? EXCLUDE_PREFIXES.filter((p) => p !== 'assets/packs/') : EXCLUDE_PREFIXES;
  // 默认只补缺失路径（历史行为）。`--repair` 额外收录「路径在、体积不同」的键 —— 上游改过的
  // 文件只有这条通道能进 git；不传则一切照旧。
  const todo = [...all.keys()].filter((k) => {
    if (exclude.some((p) => k.startsWith(p))) return false;
    if (!have.has(k)) return true;
    return repair && have.get(k) !== (all.get(k) || 0);
  });
  const repairs = todo.filter((k) => have.has(k)).length;
  report.scanned = todo.length;
  let backlogBytes = 0;
  for (const k of todo) backlogBytes += all.get(k) || 0;
  log(`[art-tree-fill] R2 上游素材 ${all.size} 键（来源 ${snapshot ? snapshot : 'S3 LIST'}）/ 分支已有 ${have.size} → 待补 ${todo.length}（其中修复 ${repairs} 份体积不符，约 ${MiB(backlogBytes)}）`);

  if (!write) {
    report.remaining = todo.length;
    report.bytes = backlogBytes;
    log(`[art-tree-fill] dry：只做路径差集；加 --write 按预算取字节并提交`);
    return report;
  }
  if (!todo.length) { log('[art-tree-fill] 无缺口'); return report; }

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-artfill-'));
  const indexFile = path.join(cwd, 'index');
  await run('git', ['read-tree', `refs/heads/${BRANCH}`], { env: { ...process.env, GIT_INDEX_FILE: indexFile } });
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };

  // 并发取字节：串行时每份一个 HTTP 往返，实测 400 份要 20+ 分钟（本机 Clash 下单次 RTT 上百毫秒）。
  // 并发度 8 是被两边夹出来的：CDN 侧没有理由限流，但本机代理并发过高会 ECONNRESET（已知网络特例），
  // 失败的文件会进 missing 留给下一轮，不会静默丢。
  const CONCURRENCY = 8;
  const budget = todo.slice(0, maxFiles);
  const cacheinfo = [];
  let cursor = 0;
  const nextKey = () => {
    while (cursor < budget.length) {
      const k = budget[cursor++];
      if (report.missing.includes(k)) continue;
      if (report.bytes >= maxBytes || report.added >= maxFiles) return null;
      return k;
    }
    return null;
  };
  const worker = async () => {
    for (;;) {
      const key = nextKey();
      if (!key) return;
      let buf;
      try {
        // 期望体积来自 S3 LIST（与字节同源）：占位页/错误页在这一步就会被挡下。
        buf = await fetchBytes(hasCreds ? config : null, key, all.get(key) || 0);
        if (!buf || !buf.length) { report.missing.push(key); continue; }
      } catch { report.missing.push(key); continue; }
      if (report.bytes + buf.length > maxBytes && report.added > 0) { cursor--; return; }
      const want = indexFiles[key]?.sha256;
      if (want && sha256(buf) !== want) { report.mismatched.push(key); continue; }
      const blob = await writeBlob(buf, key);
      cacheinfo.push(`100644 ${blob}\t${key}`);
      report.added++;
      report.bytes += buf.length;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  report.remaining = Math.max(0, todo.length - report.added - report.missing.length);
  if (report.remaining) log(`[art-tree-fill] 达到预算（${MiB(report.bytes)} / ${report.added} 份），剩 ${report.remaining} 留给下一轮`);

  if (!cacheinfo.length) { log('[art-tree-fill] 本轮没有可提交内容'); return report; }

  for (let i = 0; i < cacheinfo.length; i += 500) {
    await run('git', ['update-index', '--add', '--index-info'], { env, input: `${cacheinfo.slice(i, i + 500).join('\n')}\n` });
  }
  const tree = (await run('git', ['write-tree'], { env })).trim();
  const message = `assets: 补入上游素材树缺口（${cacheinfo.length} 个键，${MiB(report.bytes)}）`;
  let commit = (await run('git', ['commit-tree', tree, '-p', head, '-m', message], { env })).trim();
  report.commit = commit;

  await run('git', ['update-ref', `refs/heads/${BRANCH}`, commit]);

  // --no-push：只把提交落在本地 ref，推送交给 tools/push-via-api（git push 走不通时的通路）。
  // 2026-10-14 实测：本机 git push 到 github.com 两种 SSL 后端都失败（schannel 握手失败 /
  // openssl unexpected eof），而 gh 走 443 正常。两段式让字节采集与推送各自可重试。
  if (!push) {
    log(`[art-tree-fill] 已提交 ${BRANCH} → ${commit.slice(0, 8)}（${cacheinfo.length} 份 / ${MiB(report.bytes)}），按 --no-push 未推送`);
    return report;
  }

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await run('git', ['push', 'origin', `${BRANCH}:${BRANCH}`]);
      report.pushed = true;
      log(`[art-tree-fill] 已推送 ${BRANCH} → ${commit.slice(0, 8)}（${cacheinfo.length} 份 / ${MiB(report.bytes)}）`);
      return report;
    } catch (e) {
      log(`[art-tree-fill] push 第 ${attempt} 次失败：${e.message}`);
      await run('git', ['fetch', '--quiet', 'origin', `${BRANCH}:refs/heads/${BRANCH}`]).catch(() => {});
      const nowHead = (await run('git', ['rev-parse', `refs/heads/${BRANCH}`])).trim();
      const t2 = (await run('git', ['write-tree'], { env })).trim();
      commit = (await run('git', ['commit-tree', t2, '-p', nowHead, '-m', message], { env })).trim();
      report.commit = commit;
      await run('git', ['update-ref', `refs/heads/${BRANCH}`, commit]);
    }
  }
  throw new Error('assets-raw 推不上去');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const write = process.argv.includes('--write');
  const includePacks = process.argv.includes('--include-packs');
  const repair = process.argv.includes('--repair');
  // 前缀 = "--" (2) + name + "=" (1) = name.length + 3。写成 +2 会把 "=" 留在值里（路径变 "=C:\…"）。
  const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? Number(h.slice(n.length + 3)) : d; };
  const sarg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
  const r = await fill({
    repair,
    write, includePacks,
    push: !process.argv.includes('--no-push'),
    snapshot: sarg('snapshot', null),
    maxBytes: arg('max-bytes', 220) * 1024 * 1024,
    maxFiles: arg('max-files', 1200),
  });
  if (r.missing.length) console.log(`取不到字节 ${r.missing.length} 份，例：${r.missing.slice(0, 3).join(', ')}`);
  if (r.mismatched.length) console.log(`sha256 不符已跳过 ${r.mismatched.length} 份`);
  process.exit(r.pushed || r.dry || r.added === 0 ? 0 : 1);
}
