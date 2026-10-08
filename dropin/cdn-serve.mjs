#!/usr/bin/env node
// Serve an UNMODIFIED upstream deployment, with the art served from the CDN.
//
// It starts the game server as a child process on an internal port, listens on the public port,
// and rewrites the three art manifests on the way through so every /assets/… URL points at the
// CDN. Nothing in the deployment is edited, so this works on any upstream version — including
// ones released after this file was written — and removing the folder undoes it completely.
//
//   node cdn-serve.mjs                 # reads ./package.json in this folder's parent
//   SP_CDN_BASE=… SP_CDN_TOKEN=… PORT=3000 node cdn-serve.mjs
//
// Environment (all optional; the defaults are what the package was built with):
//   SP_CDN_BASE   CDN base, no trailing slash            (default __SP_CDN_BASE__)
//   SP_CDN_TOKEN  cache token for the asset URLs         (default __SP_CDN_TOKEN__)
//   PORT          public port                            (default 3000)
//   SP_SERVER_CMD how the game server is started         (default: npm start)
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CDN = (process.env.SP_CDN_BASE || '__SP_CDN_BASE__').replace(/\/+$/, '');
const TOKEN = process.env.SP_CDN_TOKEN || '__SP_CDN_TOKEN__';
const PORT = Number(process.env.PORT || 3000);
const UPSTREAM = PORT + 1;
const MANIFESTS = new Set(['/data/assets.json', '/data/local-assets.json', '/data/emotes.json']);
const TOKEN_QUERY = TOKEN ? `?v=${encodeURIComponent(TOKEN)}` : '';

// ---- localize mode -----------------------------------------------------------------------------
//
// One pack download instead of thousands of per-file requests. With SP_LOCALIZE=1 the sidecar
// fetches the packs, unpacks them into .sp-assets/ and answers /assets/** and /fonts/** from that
// directory — from local disk, same-origin.
//
// Note what this mode does NOT do: it does not rewrite the manifests. Upstream already serves them
// with relative /assets/… paths, and same-origin is exactly what the client asks for, so the right
// rewrite is no rewrite. Nothing in the deployment is touched either way.
const LOCALIZE = /^(1|true|yes)$/i.test(process.env.SP_LOCALIZE || '');
const LOCAL_DIR = path.join(HERE, '.sp-assets');
const LOCAL_PREFIXES = ['/assets/', '/fonts/'];
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  atlas: 'text/plain', skel: 'application/octet-stream', json: 'application/json', css: 'text/css',
};
const mimeFor = (p) => MIME[p.split('.').pop()?.toLowerCase()] || 'application/octet-stream';

function unpack(zipFile, into) {
  for (const [cmd, args] of [
    ['unzip', ['-o', '-q', zipFile, '-d', into]],
    ['tar', ['-xf', zipFile, '-C', into]],
  ]) {
    const res = spawnSync(cmd, args, { stdio: 'ignore' });
    if (!res.error && res.status === 0) return cmd;
  }
  throw new Error('could not unpack: neither unzip nor tar worked on this machine');
}

async function download(url, file) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
  return fs.statSync(file).size;
}

/** Fetch and unpack the packs once; later starts find the directory already populated. */
async function localize() {
  const marker = path.join(LOCAL_DIR, '.ready');
  if (fs.existsSync(marker)) {
    log(`localize: assets already unpacked in ${LOCAL_DIR}`);
    return;
  }
  const want = (process.env.SP_LOCALIZE_PACKS || 'all').trim();
  const res = await fetch(`${CDN}/cdn/v1/mirrors.json`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`cannot read the pack list: ${CDN}/cdn/v1/mirrors.json → HTTP ${res.status}`);
  const packs = ((await res.json()).packs || []).filter((p) => want === 'all' || want.split(',').includes(p.id));
  if (!packs.length) throw new Error('no packs to localize');

  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  let bytes = 0;
  for (const pack of packs) {
    const file = path.join(LOCAL_DIR, `${pack.id}.zip`);
    // Default to the mirror: this mode exists to pull 533 MB quickly on a Chinese link, and the
    // pack's URL list is [github, mirror, mirror] — so try the mirrors first and github last.
    const from = (process.env.SP_LOCALIZE_FROM || 'mirror').toLowerCase();
    const list = pack.urls || [];
    const urls = from === 'direct' ? list : [...list.slice(1), list[0]];
    let lastError;
    for (const url of urls) {
      try {
        log(`localize: ${pack.id} ← ${url.split('/')[2]}`);
        bytes += await download(url, file);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw new Error(`${pack.id}: ${lastError.message}`);
    unpack(file, LOCAL_DIR);
    fs.rmSync(file, { force: true });
  }
  fs.writeFileSync(marker, `${new Date().toISOString()}
`);
  log(`localize: ${packs.length} pack(s), ${(bytes / 1048576).toFixed(1)} MB unpacked into ${LOCAL_DIR}`);
}

/** Serve a request from the unpacked tree; returns false when the file is not there. */
function serveLocal(urlPath, req, res) {
  if (!LOCALIZE) return false;
  if (!LOCAL_PREFIXES.some((prefix) => urlPath.startsWith(prefix))) return false;
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  if (rel.includes('..')) return false;
  const file = path.join(LOCAL_DIR, ...rel.split('/'));
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    'content-type': mimeFor(file),
    'content-length': String(stat.size),
    'cache-control': 'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*',
    'accept-ranges': 'bytes',
    'x-sp': 'local',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(file).pipe(res);
  return true;
}

/**
 * Find the deployment, whichever way the folder was dropped in: inside it, next to it, or next to
 * its parent. Guessing wrong here is the difference between a one-click start and an error message,
 * so all the layouts the guide allows are checked, and SP_DEPLOY_DIR always wins.
 */
function findDeployDir() {
  const looksLikeDeployment = (dir) =>
    dir && fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'server'));
  const candidates = [
    process.env.SP_DEPLOY_DIR,
    path.resolve(HERE, '..'),
    path.join(HERE, 'Stronghold-Protocol'),
    path.resolve(HERE, '..', 'Stronghold-Protocol'),
  ];
  for (const dir of candidates) if (looksLikeDeployment(dir)) return dir;
  throw new Error(
    'could not find the game deployment (a folder with package.json and server/).\n' +
      'Put this folder inside it, or next to it, or set SP_DEPLOY_DIR=<the deployment folder>.',
  );
}

const DEPLOY = findDeployDir();

const log = (...args) => console.log('[cdn-serve]', ...args);

/** The same rewrite the fork's SP_ASSET_CDN does: only art URLs, only as a string transform. */
export function rewriteManifestText(text) {
  let count = 0;
  const out = text.replace(/"(\/(?:assets|fonts)\/[^"]*)"/g, (_m, p) => {
    count++;
    return `"${CDN}${p}${TOKEN_QUERY}"`;
  });
  return { text: out, count };
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (serveLocal(urlPath, req, res)) return;
  const isManifest = MANIFESTS.has(urlPath);
  const headers = { ...req.headers, host: `127.0.0.1:${UPSTREAM}` };
  // The manifests must arrive uncompressed: they are rewritten as text on the way through.
  if (isManifest) delete headers['accept-encoding'];

  const proxied = http.request(
    { host: '127.0.0.1', port: UPSTREAM, method: req.method, path: req.url, headers },
    (upstream) => {
      // Localize mode, last resort: the unpacked packs may be partial and the deployment's own
      // assets tree may be incomplete, so a 404 for an asset goes to the CDN instead of breaking.
      if (LOCALIZE && upstream.statusCode === 404 && LOCAL_PREFIXES.some((p) => urlPath.startsWith(p))) {
        upstream.resume();
        res.writeHead(302, { location: `${CDN}${urlPath}${TOKEN_QUERY}` });
        res.end();
        return;
      }
      if (!isManifest || upstream.statusCode !== 200) {
        res.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(res);
        return;
      }
      const chunks = [];
      upstream.on('data', (c) => chunks.push(c));
      upstream.on('end', () => {
        // In localize mode the manifest is passed through untouched (see the note above).
      const { text, count } = LOCALIZE
        ? { text: Buffer.concat(chunks).toString('utf8'), count: 0 }
        : rewriteManifestText(Buffer.concat(chunks).toString('utf8'));
        const body = Buffer.from(text, 'utf8');
        const out = { ...upstream.headers };
        delete out['content-encoding'];
        delete out['content-length'];
        out['content-length'] = String(body.length);
        out['cache-control'] = 'no-cache';
        res.writeHead(200, out);
        res.end(body);
        if (count) log(`${req.url}: ${count} art URLs → ${CDN}`);
      });
    },
  );
  proxied.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`upstream unreachable: ${error.message}`);
  });
  req.pipe(proxied);
});

// The game is a WebSocket app; a plain HTTP proxy would drop the room connection.
server.on('upgrade', (req, socket, head) => {
  const target = net.connect(UPSTREAM, '127.0.0.1', () => {
    target.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries({ ...req.headers, host: `127.0.0.1:${UPSTREAM}` })
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join('') +
        '\r\n',
    );
    if (head && head.length) target.write(head);
    socket.pipe(target).pipe(socket);
  });
  target.on('error', () => socket.destroy());
  socket.on('error', () => target.destroy());
});

const [cmd, ...args] = (process.env.SP_SERVER_CMD || 'npm start').split(' ').filter(Boolean);
log(`starting the game server: ${cmd} ${args.join(' ')} (internal port ${UPSTREAM})`);
const child = spawn(cmd, args, {
  cwd: DEPLOY,
  env: { ...process.env, PORT: String(UPSTREAM), HOST: process.env.HOST || '0.0.0.0' },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
child.on('exit', (code) => {
  log(`game server exited (${code})`);
  server.close();
  process.exit(code ?? 0);
});

async function start() {
  if (LOCALIZE) {
    try {
      await localize();
    } catch (error) {
      console.error(`[cdn-serve] localize FAILED: ${error.message}`);
      console.error('[cdn-serve] falling back to the CDN for assets (the server still starts)');
    }
  }
  server.listen(PORT, () => {
    if (LOCALIZE) {
      log(`serving http://localhost:${PORT} — art comes from local disk (${LOCAL_DIR})`);
      log('manifests are passed through unchanged: upstream already uses relative /assets/… paths');
    } else {
      log(`serving http://localhost:${PORT} — art comes from ${CDN}`);
      log(`manifests rewritten: ${[...MANIFESTS].join(', ')}`);
    }
  });
}

start();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill();
    server.close(() => process.exit(0));
  });
}
