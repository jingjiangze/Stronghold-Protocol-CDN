// Minimal S3-compatible client for Cloudflare R2, signed with SigV4.
//
// Ported from the uploader the other product line already proved in production (idempotent PUT,
// a retry around every request because a dropped local hop is transient, and an explicit
// content-length because R2 answers 411 when Node falls back to chunked transfer-encoding).
//
// Credentials come from the environment ONLY. Never put them in source, fixtures or tests.
import { createHash, createHmac } from 'node:crypto';
import https from 'node:https';
import { OWNED_PREFIXES, OWNED_KEYS } from './names.mjs';

const REGION = 'auto';
const SERVICE = 's3';
const TIMEOUT_MS = 120_000;
const ATTEMPTS = 4;

export function r2Config(env = process.env) {
  const missing = [];
  const endpoint = env.R2_ENDPOINT;
  const accessKeyId = env.R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY || env.R2_SECRET_KEY;
  const bucket = env.R2_BUCKET || 'stronghold-assets';
  if (!endpoint) missing.push('R2_ENDPOINT');
  if (!accessKeyId) missing.push('R2_ACCESS_KEY_ID');
  if (!secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY');
  if (missing.length) {
    throw new Error(`missing R2 credentials in the environment: ${missing.join(', ')}`);
  }
  return {
    host: String(endpoint).replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    accessKeyId,
    secretAccessKey,
    bucket,
  };
}

/**
 * This repository owns only the asset tree, the fonts and the interface files. Other prefixes on
 * the bucket belong to other product lines, so writing to them is a bug — fail instead.
 */
export function assertOwnedKey(key) {
  if (OWNED_KEYS.includes(key) || OWNED_PREFIXES.some((prefix) => key.startsWith(prefix))) return;
  throw new Error(
    `refusing to write outside the owned prefixes (${[...OWNED_PREFIXES, ...OWNED_KEYS].join(', ')}): ${key}`,
  );
}

// SigV4 canonicalization: everything except unreserved (A-Za-z0-9-._~) and '/' is percent-encoded.
// encodeURIComponent leaves !*'() alone, which the spec does not allow.
const qencode = (s) =>
  s
    .split('')
    .map((c) =>
      /[A-Za-z0-9\-._~]/.test(c)
        ? c
        : [...Buffer.from(c, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join(''),
    )
    .join('');

const encodeKey = (key) => key.split('/').map(qencode).join('/');

function canonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${qencode(k)}=${qencode(String(params[k]))}`)
    .join('&');
}

function sign(config, method, canonicalUri, query, payload, headers) {
  const now = new Date();
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15)}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash('sha256').update(payload).digest('hex');
  const all = {
    host: config.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...headers,
  };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((k) => `${k}:${all[k]}\n`).join('');
  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, names.join(';'), payloadHash].join('\n');
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  let key = createHmac('sha256', `AWS4${config.secretAccessKey}`).update(dateStamp).digest();
  for (const part of [REGION, SERVICE, 'aws4_request']) {
    key = createHmac('sha256', key).update(part).digest();
  }
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  return {
    ...all,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

function once(config, method, key, { query = '', headers = {}, body = Buffer.alloc(0) } = {}) {
  const uri = key === null ? `/${config.bucket}` : `/${config.bucket}/${encodeKey(key)}`;
  const withLength = method === 'PUT' ? { ...headers, 'content-length': String(body.length) } : headers;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: config.host,
        path: uri + (query ? `?${query}` : ''),
        method,
        headers: sign(config, method, uri, query, body, withLength),
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body.length) req.write(body);
    req.end();
  });
}

async function request(config, method, key, options) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await once(config, method, key, options);
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastError;
}

export async function putObject(config, key, body, { contentType, cacheControl } = {}) {
  assertOwnedKey(key);
  const res = await request(config, 'PUT', key, {
    body,
    headers: {
      ...(contentType ? { 'content-type': contentType } : {}),
      ...(cacheControl ? { 'cache-control': cacheControl } : {}),
    },
  });
  if (res.status >= 300) throw new Error(`PUT ${key} → HTTP ${res.status}: ${res.body.toString().slice(0, 200)}`);
}

export async function getObject(config, key) {
  const res = await request(config, 'GET', key);
  if (res.status === 404) return null;
  if (res.status >= 300) throw new Error(`GET ${key} → HTTP ${res.status}`);
  return res.body;
}

export async function deleteObject(config, key) {
  assertOwnedKey(key);
  const res = await request(config, 'DELETE', key);
  if (res.status >= 300 && res.status !== 404) throw new Error(`DELETE ${key} → HTTP ${res.status}`);
}

export async function headObject(config, key) {
  const res = await request(config, 'HEAD', key);
  if (res.status === 404) return null;
  if (res.status >= 300) throw new Error(`HEAD ${key} → HTTP ${res.status}`);
  return { size: Number(res.headers['content-length']) };
}

export const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  atlas: 'text/plain',
  skel: 'application/octet-stream',
  json: 'application/json',
  css: 'text/css',
};

export function mimeFor(key) {
  const ext = key.split('.').pop()?.toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

/** Content-addressed art never changes under a stable URL, so cache it hard. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Interface files must be able to move within minutes. */
export const SHORT = 'public, max-age=300';
