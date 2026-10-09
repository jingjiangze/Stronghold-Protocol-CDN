// git-mount-relay -- serve this repository's committed files through OUR OWN hostname.
//
// Why this exists: jsDelivr / Statically / ghfast can mount files out of a git repo, but they are
// third-party hosts. Two things go wrong if a page links them directly:
//   * we are back to depending on somebody else's host staying up and staying https
//     (Statically's '/gh/<repo>/<ref>/<path>' form 301s to http, which a https page rejects);
//   * the browser talks to them directly, so nothing of ours is in the path.
// A Worker on our own domain fixes both: one URL for every backend, our cache in front, and the
// CORS/Range behaviour is ours rather than whatever the backend happens to send.
//
// What it will NOT do: it is not an open proxy. The upstream host is chosen from a fixed table by
// name, never from the request, and the path is validated. Only files committed to THIS repo are
// reachable -- there is no way to point it at another repo.

const REPO = 'jingjiangze/Stronghold-Protocol-CDN';

// The tree lives on two branches, because the two halves have opposite versioning needs:
//   main        -- the interface (site/, worker/, data/, probe/). Small, edited in place, history
//                  worth keeping.
//   assets-raw  -- the 618 MiB art tree, an orphan branch with a single parentless line of
//                  commits. Binary art gets no delta compression, so every upstream release
//                  replaces the whole tree wholesale; keeping it out of main keeps interface
//                  clones small and keeps that churn off the branch the site deploys from.
// A request names no branch: which one to read is chosen here, from the path.
const REF_MAIN = 'main';
const REF_ASSETS = 'assets-raw';

// Ordered; the first backend that answers wins. `prefix` is how each names a repo file.
//
// Statically was removed after measurement: it truncated a 262,144-byte probe to 16,384 / 32,768 /
// 0 bytes across three attempts and 403'd five times out of five on a real 854 KB asset. A backend
// that silently returns partial bytes is worse than an absent one, because Range and sha256 checks
// both pass on the first chunk and fail later.
const BACKENDS = [
  { id: 'jsdelivr', prefix: 'https://cdn.jsdelivr.net/gh/' + REPO + '@' + REF_MAIN },
  { id: 'ghfast-raw', prefix: 'https://ghfast.top/https://raw.githubusercontent.com/' + REPO + '/' + REF_MAIN },
];

// Same two backends pointed at the asset branch. Built separately because the ref is part of the
// URL for both forms: jsDelivr wants '@ref' after the repo, ghfast wants '/ref' in the raw path.
const ASSET_BACKENDS = [
  { id: 'jsdelivr-assets', prefix: 'https://cdn.jsdelivr.net/gh/' + REPO + '@' + REF_ASSETS },
  { id: 'ghfast-assets', prefix: 'https://ghfast.top/https://raw.githubusercontent.com/' + REPO + '/' + REF_ASSETS },
];

const MAX_PATH = 300;
const CACHE_TTL = 3600;
const NEGATIVE_TTL = 60;

// Where /dl/ sends a browser for a release asset. Ordered; only the first is used, because a
// redirect has no retry -- a mirror that is down must not be the one every visitor lands on.
// Same list as mirrors.json: ghfast measured fast, gh-proxy is the only one that sends
// Access-Control-Allow-Origin on release assets (see audit section 19.6).
const MIRROR_PREFIXES = ['https://ghfast.top/', 'https://gh-proxy.com/'];

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  svg: 'image/svg+xml', ico: 'image/x-icon',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
  json: 'application/json', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
  html: 'text/html; charset=utf-8', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8',
  bin: 'application/octet-stream', zip: 'application/zip',
};

const extOf = (p) => {
  const i = p.lastIndexOf('.');
  if (i < 0) return '';
  const q = p.slice(i + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(q) ? q : '';
};

/**
 * The path as the caller sent it, taken from the raw URL string.
 *
 * `new URL()` normalises while constructing: it resolves '..' against the path and decodes
 * '%2e%2e', so neither `url.pathname` nor `url.href` shows what was actually requested. The raw
 * request string is the only place the original survives, so that is where a traversal check has
 * to read from. Text after '?' or '#' is not part of the path.
 */
export function rawPathOf(rawUrl) {
  const raw = String(rawUrl || '');
  const hostAt = raw.indexOf('//');
  const afterScheme = hostAt >= 0 ? raw.slice(hostAt + 2) : raw;
  const start = afterScheme.indexOf('/');
  if (start < 0) return '';
  let path = afterScheme.slice(start);
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  return path;
}

/**
 * Accept only a plain repo-relative path.
 *
 * Rejects '..', backslashes, control characters, a scheme, and a protocol-relative '//host/x' --
 * in a browser that names another host, so it is refused outright rather than slash-collapsed
 * into a local path. Called with the RAW path, because the parsed one has already lost '..'.
 */
export function safePath(raw) {
  const p = String(raw || '');
  if (!p || p.length > MAX_PATH) return null;
  if (/[\u0000-\u001f\u007f]/.test(p)) return null;
  if (p.startsWith('//')) return null;
  if (p.includes('..') || p.includes('\\')) return null;
  if (!p.startsWith('/')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return null;
  return p.replace(/\/{2,}/g, '/');
}

/** True when the raw path carried traversal the URL parser would otherwise quietly resolve. */
export function hasTraversal(rawUrl) {
  const path = rawPathOf(rawUrl);
  if (!path) return false;
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true; // malformed percent-escapes are not a path we should serve
  }
  return path.includes('..') || decoded.includes('..') || /%2e/i.test(path);
}

// The asset tree used to be absent from git, and these prefixes were refused with a 404 rather
// than forwarded to a backend that would 404 anyway. It is committed now (branch `assets-raw`),
// so the prefixes do the opposite job: they select which branch to read.
const ASSET_TREE = ['/assets/', '/fonts/'];

export function isAssetTree(raw) {
  const p = String(raw || '');
  return ASSET_TREE.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix));
}

/**
 * Which backends may answer this path. Exported so the branch choice is testable without a
 * request: the caller never names a branch, so the mapping has to be pinned down somewhere.
 */
export function backendFor(raw) {
  return isAssetTree(raw) ? ASSET_BACKENDS : BACKENDS;
}

export const MAX_BYTES = 32 * 1024 * 1024;

const cors = (extra = {}) => ({
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Content-Length, Content-Range, ETag, X-Git-Mount-Backend',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-max-age': '86400',
  ...extra,
});

async function fetchBackend(backend, path, { range, method }) {
  const url = backend.prefix + path.split('/').map(encodeURIComponent).join('/');
  const headers = { 'user-agent': 'sp-git-mount-relay', accept: '*/*' };
  if (range) headers.range = range;
  const res = await fetch(url, { method, headers, redirect: 'follow', cf: { cacheTtl: CACHE_TTL } });
  return { res, url };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405, headers: cors() });
    }

    if (url.pathname === '/' || url.pathname === '') {
      const body = JSON.stringify({
        ok: true, repo: REPO,
        branches: { interface: REF_MAIN, assets: REF_ASSETS },
        backends: [...BACKENDS, ...ASSET_BACKENDS].map((b) => b.id),
        usage: '/<path-in-repo> | /dl/<tag>/<pack>.zip',
      });
      return new Response(body, { status: 200, headers: cors({ 'content-type': 'application/json; charset=utf-8' }) });
    }

    // /dl/<tag>/<file> -- a stable own-domain short link to a GitHub release asset. Redirects
    // rather than proxies: a 405 MiB pack pulled through the Worker would spend our request
    // budget and our egress on bytes a mirror already has at the edge.
    const dl = url.pathname.match(/^\/dl\/([^/]+)\/([^/]+)$/);
    if (dl) {
      const tag = decodeURIComponent(dl[1]);
      const file = decodeURIComponent(dl[2]);
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(tag) || !/^[A-Za-z0-9._-]{1,120}$/.test(file)) {
        return new Response('bad tag or file name', { status: 400, headers: cors() });
      }
      const target = 'https://github.com/' + REPO + '/releases/download/' + tag + '/' + file;
      const headers = new Headers({ ...cors(), location: MIRROR_PREFIXES[0] + target.replace(/^https:\/\//, ''), 'cache-control': 'public, max-age=3600' });
      headers.set('x-download-target', target);
      return new Response(null, { status: 302, headers });
    }

    // Both checks read the raw request string; the parsed URL has already normalised '..' away.
    if (hasTraversal(request.url)) return new Response('bad path', { status: 400, headers: cors() });
    const raw = rawPathOf(request.url);
    const path = safePath(raw);
    if (!path) return new Response('bad path', { status: 400, headers: cors() });

    // Asset paths come from the orphan branch, everything else from main. Callers never name a
    // branch: the path decides, and a path outside /assets/** can never reach the art branch.
    const asset = isAssetTree(raw);
    const backends = asset ? ASSET_BACKENDS : BACKENDS;

    const range = request.headers.get('range');
    const method = request.method;
    const failures = [];

    for (const backend of backends) {
      try {
        const { res, url: backendUrl } = await fetchBackend(backend, path, { range, method });
        if (!res.ok) {
          failures.push(backend.id + ':' + res.status);
          continue;
        }
        const declared = Number(res.headers.get('content-length') || 0);
        if (declared > MAX_BYTES) return new Response('too large', { status: 413, headers: cors() });

        const headers = new Headers(cors());
        headers.set('content-type', res.headers.get('content-type') || MIME[extOf(path)] || 'application/octet-stream');
        for (const h of ['content-length', 'content-range', 'etag', 'last-modified']) {
          const v = res.headers.get(h);
          if (v) headers.set(h, v);
        }
        // Claim Range support only when the backend actually honoured it, or audio seek breaks.
        if (range && !res.headers.get('content-range')) headers.delete('accept-ranges');
        else headers.set('accept-ranges', 'bytes');
        headers.set('cache-control', 'public, max-age=' + CACHE_TTL);
        headers.set('x-git-mount-backend', backend.id);
        headers.set('x-git-mount-url', backendUrl);
        return new Response(method === 'HEAD' ? null : res.body, { status: res.status, headers });
      } catch (error) {
        failures.push(backend.id + ':' + String(error && error.message ? error.message : error).slice(0, 40));
      }
    }

    const body = JSON.stringify({ ok: false, error: 'no git-mount backend served this path', path, failures });
    return new Response(body, {
      status: 502,
      headers: cors({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=' + NEGATIVE_TTL }),
    });
  },
};
