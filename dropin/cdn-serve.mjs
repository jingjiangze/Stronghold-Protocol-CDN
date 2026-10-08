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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CDN = (process.env.SP_CDN_BASE || '__SP_CDN_BASE__').replace(/\/+$/, '');
const TOKEN = process.env.SP_CDN_TOKEN || '__SP_CDN_TOKEN__';
const PORT = Number(process.env.PORT || 3000);
const UPSTREAM = PORT + 1;
const MANIFESTS = new Set(['/data/assets.json', '/data/local-assets.json', '/data/emotes.json']);
const TOKEN_QUERY = TOKEN ? `?v=${encodeURIComponent(TOKEN)}` : '';

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
  const isManifest = MANIFESTS.has((req.url || '').split('?')[0]);
  const headers = { ...req.headers, host: `127.0.0.1:${UPSTREAM}` };
  // The manifests must arrive uncompressed: they are rewritten as text on the way through.
  if (isManifest) delete headers['accept-encoding'];

  const proxied = http.request(
    { host: '127.0.0.1', port: UPSTREAM, method: req.method, path: req.url, headers },
    (upstream) => {
      if (!isManifest || upstream.statusCode !== 200) {
        res.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(res);
        return;
      }
      const chunks = [];
      upstream.on('data', (c) => chunks.push(c));
      upstream.on('end', () => {
        const { text, count } = rewriteManifestText(Buffer.concat(chunks).toString('utf8'));
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

server.listen(PORT, () => {
  log(`serving http://localhost:${PORT} — art comes from ${CDN}`);
  log(`manifests rewritten: ${[...MANIFESTS].join(', ')}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill();
    server.close(() => process.exit(0));
  });
}
