// agent 上传通道：命令行把本地文件送进素材 CDN（同一套后台接口，不是另开一条路）。
//
//   node tools/agent-upload.mjs --file=art.png --to=assets/char/mod_x.png \
//        --source=demo-mod --what="说明" [--dispatch] [--wait]
//   node tools/agent-upload.mjs --list
//   node tools/agent-upload.mjs --kick
//
// 与网页的区别只有两件：
//   1. 走 presigned 直传桶的 S3 端点，不受「经代理域名单次请求体 100 MB」的限制（上限是单次 PUT 的 5 GiB）；
//   2. 可以顺手 --dispatch 叫起发布轮（要一个对本仓有 actions:write 的 token），不必等 20 分钟的 cron。
// 口令：env CDN_ADMIN_KEY 优先，否则读本机 ~/.cdn_admin_key。绝不打印，绝不进 git。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { cleanSource, validateKey } from '../src/upload.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_DEFAULT = 'https://downcdn.jiangjiangze.icu';

function arg(name, fallback = '') {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const flag = (name) => process.argv.slice(2).includes(`--${name}`);

const base = (arg('base', BASE_DEFAULT) || BASE_DEFAULT).replace(/\/+$/, '');
const adminKey = () => {
  const fromEnv = (process.env.CDN_ADMIN_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const file = path.join(os.homedir(), '.cdn_admin_key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').replace(/\r?\n/g, '');
  throw new Error('没有口令：设 CDN_ADMIN_KEY 或写进 ~/.cdn_admin_key');
};

/**
 * POST/GET 到后台。
 *
 * 先试 Node 自己的 fetch；这台机器的出口对部分域名会把 Node 的 TLS 掐掉（curl 走 schannel 反而通），
 * 失败就退回 curl，并只通过临时 config 传口令 —— 口令不进命令行参数（会留在进程列表与 shell 历史里）。
 */
async function api(method, urlPath, body, extraHeaders = {}) {
  const headers = { 'x-admin-key': adminKey(), 'content-type': 'application/json', ...extraHeaders };
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(base + urlPath, { method, headers, body: payload, signal: controller.signal });
    clearTimeout(timer);
    const text = await res.text();
    try { return { status: res.status, doc: JSON.parse(text) }; } catch { return { status: res.status, doc: { ok: false, error: text.slice(0, 200) } }; }
  } catch (error) {
    clearTimeout(timer);
    return apiViaCurl(method, urlPath, payload, headers, error);
  }
}

function apiViaCurl(method, urlPath, payload, headers, firstError) {
  const cfg = path.join(os.tmpdir(), `cdn-admin-${process.pid}-${Date.now()}.cfg`);
  const lines = [`url = "${base}${urlPath}"`, `request = "${method}"`];
  for (const [k, v] of Object.entries(headers)) lines.push(`header = "${k}: ${v}"`);
  if (payload !== undefined) lines.push(`data = ${JSON.stringify(payload)}`);
  fs.writeFileSync(cfg, `${lines.join('\n')}\n`);
  try {
    const out = execFileSync('curl', ['-sS', '--ssl-no-revoke', '-m', '45', '-w', '\\nHTTPCODE=%{http_code}', '-K', cfg], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const status = Number((out.match(/HTTPCODE=(\d+)/) || [])[1] || 0);
    const text = out.replace(/\n?HTTPCODE=\d+$/, '');
    let doc = { ok: false, error: text.slice(0, 200) };
    try { doc = JSON.parse(text); } catch { /* 保持原样 */ }
    if (!status) throw new Error(`curl 也没拿到状态码（先试 Node fetch：${firstError && firstError.message}）`);
    return { status, doc };
  } finally {
    fs.unlinkSync(cfg);
  }
}

function sha256OfFile(abs) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(abs);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** presigned PUT：文件流直接进桶的 S3 端点。Content-Length 必须显式给，S3 不接受 chunked。 */
function putToR2(putUrl, abs, size) {
  return new Promise((resolve, reject) => {
    const url = new URL(putUrl);
    const req = https.request(
      {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'PUT',
        headers: { 'content-length': String(size), 'content-type': 'application/octet-stream' },
        timeout: 600000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('上传超时')));
    fs.createReadStream(abs).pipe(req);
  });
}

function defaultKeyFor(abs) {
  const name = path.basename(abs).replace(/[^\w.\-]+/g, '_');
  return `assets/local/${name}`;
}

async function listStatus() {
  const { status, doc } = await api('GET', '/api/cdn/upload/status');
  if (!doc || doc.ok !== true) {
    console.log(`读状态失败 HTTP ${status}：${(doc && doc.error) || ''}`);
    process.exitCode = 1;
    return null;
  }
  console.log(`暂存 ${doc.staging.length} 组，待发布 ${doc.pending}，未提交 ${doc.awaitingCommit}`);
  for (const item of doc.staging) {
    console.log(`  ${String(item.state).padEnd(18)} ${item.key || item.stagingKey}  ${(item.size || item.stagedSize || 0)} B  ${item.source || ''}`);
  }
  for (const entry of (doc.log || []).slice(0, 10)) {
    console.log(`  已发布 ${entry.at} ${entry.key} ${entry.size} B ${entry.source || ''}`);
  }
  return doc;
}

async function dispatchPromote() {
  const token = (process.env.GH_TOKEN || '').trim() || (fs.existsSync(path.join(os.homedir(), '.gh_fine_token')) ? fs.readFileSync(path.join(os.homedir(), '.gh_fine_token'), 'utf8').trim() : '');
  const repo = process.env.GH_REPO || 'jingjiangze/Stronghold-Protocol-CDN';
  if (!token) {
    console.log('没有 GH_TOKEN / ~/.gh_fine_token，叫不起发布轮 —— 等 ≤20 分钟的定时任务也一样会上线');
    return false;
  }
  const out = execFileSync(
    'curl',
    ['-sS', '--ssl-no-revoke', '-m', '40', '-o', os.devnull, '-w', '%{http_code}', '-X', 'POST',
      '-H', `authorization: Bearer ${token}`, '-H', 'accept: application/vnd.github+json', '-H', 'x-github-api-version: 2022-11-28',
      '-H', 'content-type: application/json', '-d', JSON.stringify({ ref: 'main' }),
      `https://api.github.com/repos/${repo}/actions/workflows/promote-uploads.yml/dispatches`],
    { encoding: 'utf8' },
  );
  const ok = out.trim() === '204';
  console.log(ok ? '已叫起发布轮（约 1–2 分钟）' : `dispatch 返回 HTTP ${out.trim()}`);
  return ok;
}

async function waitPublished(id, timeoutMs = 420000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const doc = await listStatus();
    if (!doc) return false;
    const still = doc.staging.find((s) => s.id === id);
    const done = (doc.log || []).find((l) => l.id === id);
    if (done) {
      console.log(`已上线：${done.key}（${done.size} B，sha256 ${done.sha256}）`);
      return true;
    }
    if (!still) {
      console.log('这一份已从暂存区消失（要么上线了，要么被拒；看上面的列表与日志）');
      return false;
    }
    await new Promise((r) => setTimeout(r, 20000));
  }
  console.log(`等了 ${timeoutMs / 60000} 分钟还没上线，去看 Actions 的 promote-uploads 运行记录`);
  return false;
}

async function uploadOne(abs, targetKey, source, what) {
  const stat = fs.statSync(abs);
  const sha256 = await sha256OfFile(abs);
  console.log(`准备上传 ${abs}\n  → 键 ${targetKey}\n  → ${stat.size} 字节\n  → sha256 ${sha256}\n  → 来源 ${source}`);

  const begun = await api('POST', '/api/cdn/upload/begin', { key: targetKey, size: stat.size, sha256, source, note: what });
  if (!begun.doc || begun.doc.ok !== true) {
    console.log(`begin 被拒（HTTP ${begun.status}）：${(begun.doc && begun.doc.error) || ''}`);
    return null;
  }
  const { id, putUrl, stagingKey } = begun.doc;

  const put = await putToR2(putUrl, abs, stat.size);
  if (put.status !== 200) {
    console.log(`直传失败 HTTP ${put.status}：${put.text.slice(0, 200)}`);
    return null;
  }
  console.log(`  暂存 ${stagingKey} 已写入`);

  const committed = await api('POST', '/api/cdn/upload/commit', { id, stagingKey, key: targetKey, sha256, size: stat.size, source, what });
  if (!committed.doc || committed.doc.ok !== true) {
    console.log(`commit 被拒（HTTP ${committed.status}）：${(committed.doc && committed.doc.error) || ''}`);
    return null;
  }
  console.log(`  ${committed.doc.message}`);
  return { id, key: targetKey, sha256 };
}

async function main() {
  const file = arg('file');
  if (flag('list') && !file) { await listStatus(); return; }
  if (flag('kick') && !file) { await dispatchPromote(); return; }
  if (!file) {
    console.log('用法：--file=<路径> --to=<键名> --source=<分组id> --what=<说明> [--dispatch] [--wait]\n     --list 看暂存与日志，--kick 催发布轮');
    process.exitCode = 2;
    return;
  }

  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`文件不存在：${abs}`);
  const key = arg('to') || defaultKeyFor(abs);
  const k = validateKey(key);
  if (!k.ok) throw new Error(`键名不行：${k.reason}`);
  const src = cleanSource(arg('source'));
  if (!src.ok) throw new Error(`来源不行：${src.reason}`);
  const what = arg('what', '');

  const result = await uploadOne(abs, k.key, src.source, what);
  if (!result) { process.exitCode = 1; return; }
  if (flag('dispatch') || flag('wait')) await dispatchPromote();
  if (flag('wait')) {
    const ok = await waitPublished(result.id);
    if (!ok) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[agent-upload] 失败：${error.stack || error.message}`);
  process.exitCode = 1;
});
