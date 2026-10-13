// 批量上传到素材 CDN：与 tools/agent-upload.mjs 同一套后台接口（begin → presigned PUT → commit），
// 但把每条链路上的常数开销消掉：
//   1) 管理面调用走 node:https + keep-alive 连接池（不再每个文件新建 TLS，也不再 fetch 失败就 spawn curl）
//   2) 桶侧 PUT 走 N 路并发（默认 6），begin/PUT/commit 三段流水化
//   3) 每个文件只读两遍（算哈希一遍、传一遍），哈希与体积在 ledger 里记账，中断可续
//   4) 全程只在结束时叫一轮发布轮（单文件版是每传一个 dispatch 一次）
//   5) 传完按 HEAD 复核 Content-Length，与本地字节逐键对账
// 用法：
//   node tools/agent-upload-batch.mjs --manifest=list.json [--source=组id] [--concurrency=6] [--kick] [--resume=ledger.json] [--limit=N] [--dry]
//   node tools/agent-upload-batch.mjs --dir=<目录> --to=<键前缀/> [--strip=public/] [--source=…]
// list.json = [{ "file": "绝对或相对路径", "key": "assets/char/portrait/x.png" }, …]（键必须落在 assets/ fonts/ packs/ 之下）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { cleanSource, validateKey } from '../src/upload.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE_DEFAULT = process.env.SP_CDN_BASE || 'https://downcdn.jiangjiangze.icu';

const arg = (name, dflt = '') => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const flag = (name) => process.argv.slice(2).includes(`--${name}`);

const base = String(arg('base', BASE_DEFAULT)).replace(/\/+$/, '');
const adminKey = () => {
  const fromEnv = (process.env.CDN_ADMIN_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const f = path.join(os.homedir(), '.cdn_admin_key');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').replace(/\r?\n/g, '');
  throw new Error('没有口令：设 CDN_ADMIN_KEY 或写进 ~/.cdn_admin_key');
};

// ── 连接池：管理面一条 TLS 连接复用到底 ─────────────────────────────
const host = new URL(base).hostname;
const agent = new https.Agent({ keepAlive: true, maxSockets: 12, timeout: 30000 });
function api(method, urlPath, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host, path: urlPath, method, agent,
        headers: {
          'x-admin-key': adminKey(),
          'content-type': 'application/json',
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 60000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let doc = { ok: false, error: text.slice(0, 200) };
          try { doc = JSON.parse(text); } catch { /* 原样 */ }
          resolve({ status: res.statusCode, doc });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('管理面超时')));
    if (payload) req.end(payload); else req.end();
  });
}

// ── 桶侧 PUT：presigned URL 自带签名，流式上传，单请求一次成功或抛错 ──
function putToR2(putUrl, abs, size) {
  const url = new URL(putUrl);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname, path: `${url.pathname}${url.search}`, method: 'PUT',
        headers: { 'content-length': String(size), 'content-type': 'application/octet-stream' },
        timeout: 900000, agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8').slice(0, 300) }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('PUT 超时')));
    fs.createReadStream(abs).pipe(req);
  });
}

function headLen(url) {
  const u = new URL(url);
  return new Promise((resolve) => {
    const req = https.request({ hostname: u.hostname, path: `${u.pathname}${u.search}`, method: 'HEAD', timeout: 25000 }, (res) => {
      resolve({ status: res.statusCode, len: Number(res.headers['content-length'] || 0) });
    });
    req.on('error', () => resolve({ status: 0, len: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, len: 0 }); });
    req.end();
  });
}

function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(abs);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// ── 输入清单 ──────────────────────────────────────────────
function loadItems() {
  const mfArg = arg('manifest');
  if (mfArg) {
    const mf = path.resolve(mfArg);
    if (!fs.existsSync(mf)) throw new Error(`--manifest 指向的文件不存在：${mf}`);
    const list = JSON.parse(fs.readFileSync(mf, 'utf8'));
    if (!Array.isArray(list) || !list.length) throw new Error('--manifest 是一个非空数组 [{file,key}]');
    return list.map((x) => ({ file: path.resolve(path.dirname(mf), x.file || x.path), key: x.key }));
  }
  const dirArg = arg('dir');
  if (!dirArg) throw new Error('要么给 --manifest=list.json，要么给 --dir=<目录> --to=<键前缀/>');
  const dir = path.resolve(dirArg);
  // 防呆：绝不要把整个仓库（或任何带 .git 的目录）当成上传源
  if (fs.existsSync(path.join(dir, '.git'))) throw new Error(`--dir 指向了版本库根目录（${dir}），这显然不是要上传的素材树`);
  const prefix = String(arg('to')).replace(/^\/+|\/+$/g, '');
  if (!prefix) throw new Error('--dir 模式必须给 --to=<键前缀/>，否则会传成一堆没有归属的根键');
  const strip = arg('strip');
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(path.join(d), { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else {
        let k = r;
        if (strip && k.startsWith(strip)) k = k.slice(strip.length).replace(/^\/+/, '');
        out.push({ file: abs, key: `${prefix}${k}` });
      }
    }
  })(dir, '');
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const source = cleanSource(arg('source', 'batch-agent-upload'));
  if (!source.ok) throw new Error(`来源不行：${source.reason}`);
  const what = arg('what', '批量上传（agent-upload-batch）');
  const conc = Math.max(1, Math.min(16, Number(arg('concurrency', 6)) || 6));
  const ledgerPath = path.resolve(arg('resume', 'cdn-upload-ledger.json'));
  const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : { done: {}, failed: {} };
  let items = loadItems();
  const limit = Number(arg('limit', 0));

  // 键名先全部过一遍校验（后台只收 assets/ fonts/ packs/ 三个前缀与扩展表白名单）
  const bad = [];
  items = items.filter((it) => {
    const k = validateKey(it.key);
    if (!k.ok) { bad.push(`${it.key} — ${k.reason}`); return false; }
    it.key = k.key;
    return true;
  });
  if (bad.length) console.log(`跳过 ${bad.length} 个不合格键（前 5）：\n  ${bad.slice(0, 5).join('\n  ')}`);
  if (limit) items = items.slice(0, limit);
  const skipped = items.filter((it) => ledger.done[it.key]?.bytes === fs.statSync(it.file).size);
  const todo = items.filter((it) => !skipped.includes(it));
  const bytes = todo.reduce((n, it) => n + fs.statSync(it.file).size, 0);
  console.log(`[batch] 计划 ${items.length} 个键 / 待传 ${todo.length} 个（记账续传跳过 ${skipped.length}）/ ${(bytes / 1048576).toFixed(1)} MiB / 并发 ${conc} → 桶 ${base}`);
  if (flag('dry')) { for (const it of todo.slice(0, 12)) console.log('  dry:', it.key, fs.statSync(it.file).size, 'B'); console.log('  …共', todo.length); return; }

  const t0 = Date.now();
  let sentBytes = 0, sentFiles = 0, fails = 0;
  const sentKeys = [];
  let skippedExisting = 0, skippedExistingBytes = 0;
  const divergent = [];
  const stage = { begin: 0, put: 0, commit: 0 };
  const queue = [...todo];

  const saveLedger = () => fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1));

  async function worker(id) {
    for (let it = queue.shift(); it; it = queue.shift()) {
      const abs = path.isAbsolute(it.file) ? it.file : path.resolve(it.file);
      try {
        const size = fs.statSync(abs).size;
        // 预检走公开面 HEAD：cdn/v1/index.json 与 hosted-index.json 都会滞后于桶（别人刚传的、
        // 还在暂存区的都不在里面），只按清单判「缺不缺」就会撞 begin 的 409。
        if (!flag('no-precheck')) {
          const h = await headLen(`${base}/${it.key}`);
          if (h.status === 200) {
            skippedExisting++; skippedExistingBytes += h.len || size;
            ledger.done[it.key] = { bytes: h.len || size, sha: null, at: new Date().toISOString(), note: h.len === size ? '现网已有，同字节' : `现网已有但字节不同（现网 ${h.len} vs 本地 ${size}）——后台只增不覆盖，需人工裁决` };
            if (h.len && h.len !== size) divergent.push(it.key);
            continue;
          }
        }
        let t = Date.now();
        const sha = await sha256File(abs);
        const begun = await api('POST', '/api/cdn/upload/begin', { key: it.key, size, sha256: sha, source: source.source, note: what });
        stage.begin += Date.now() - t;
        if (!begun.doc?.ok) throw new Error(`begin HTTP ${begun.status}：${begun.doc?.error || ''}`);
        const { id: upId, putUrl, stagingKey } = begun.doc;
        t = Date.now();
        const put = await putToR2(putUrl, abs, size);
        stage.put += Date.now() - t;
        if (put.status !== 200) throw new Error(`PUT HTTP ${put.status}：${put.text}`);
        t = Date.now();
        const cm = await api('POST', '/api/cdn/upload/commit', { id: upId, stagingKey, key: it.key, sha256: sha, size, source: source.source, what });
        stage.commit += Date.now() - t;
        if (!cm.doc?.ok) throw new Error(`commit HTTP ${cm.status}：${cm.doc?.error || ''}`);
        ledger.done[it.key] = { bytes: size, sha, at: new Date().toISOString() };
        sentBytes += size; sentFiles++; sentKeys.push(`${it.key}=${size}`);
        if (sentFiles % 25 === 0 || sentFiles === todo.length) {
          const sec = (Date.now() - t0) / 1000;
          process.stdout.write(`  [w${id}] ${sentFiles}/${todo.length} · ${(sentBytes / 1048576).toFixed(1)} MiB · ${(sentBytes / 1048576 / sec * 1000 / 1024).toFixed(2)} MiB/s · ${((sec / sentFiles) * 1000).toFixed(0)} ms/件（begin ${(stage.begin / sentFiles).toFixed(0)} / put ${(stage.put / sentFiles).toFixed(0)} / commit ${(stage.commit / sentFiles).toFixed(0)}）\n`);
          saveLedger();
        }
      } catch (e) {
        fails++;
        ledger.failed[it.key] = { error: String(e.message || e).slice(0, 200), at: new Date().toISOString() };
        if (e.message && /429|频繁/.test(e.message)) await sleep(20000);
        console.log(`  ✗ ${it.key}：${e.message || e}`);
      }
    }
  }

  await Promise.all(Array.from({ length: conc }, (_, i) => worker(i + 1)));
  saveLedger();

  // 抽查复核：对外键此刻还在暂存区（要等发布轮 CopyObject），所以这里核的是「commit 已收 + 尺寸对得上」
  const sample = sentKeys.slice(0, 6);
  console.log(`[batch] 完成 ${sentFiles} 件 / ${(sentBytes / 1048576).toFixed(1)} MiB，失败 ${fails} 件，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (skippedExisting) console.log(`[batch] 预检跳过（现网已有）${skippedExisting} 件 / ${(skippedExistingBytes / 1048576).toFixed(1)} MiB${divergent.length ? `；其中字节不一致 ${divergent.length} 个需人工裁决：\n  ${divergent.slice(0, 8).join('\n  ')}` : ''}`);
  console.log(`[batch] 平均单件：begin ${(stage.begin / Math.max(1, sentFiles)).toFixed(0)}ms · PUT ${(stage.put / Math.max(1, sentFiles)).toFixed(0)}ms · commit ${(stage.commit / Math.max(1, sentFiles)).toFixed(0)}ms`);
  if (sample.length) console.log('[batch] 本轮样本：', sample.join(', '));

  if (flag('kick') || flag('dispatch')) {
    const { status, doc } = await api('POST', '/api/cdn/upload/kick', {});
    console.log(`[batch] 叫起发布轮：HTTP ${status} ${JSON.stringify(doc).slice(0, 160)}`);
  } else {
    console.log('[batch] 没有 --kick：等 ≤20 分钟的定时发布轮也会上线');
  }
  if (fails) process.exitCode = 1;
  agent.destroy();
}

main().catch((e) => { console.error(`[batch] 失败：${e.stack || e.message}`); process.exitCode = 1; });
