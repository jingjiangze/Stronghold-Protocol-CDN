// 上传端点共用的 HTTP 外壳：口令、JSON 读法、统一响应形状。
// 口令只和 env.ADMIN_UPLOAD_KEY 比较（Pages secret），不进代码、不进日志、不回给调用方。
import { timingSafeEqual } from './_edge.js';

export const json = (data, status = 200) =>
  new Response(`${JSON.stringify(data, null, 2)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });

export const deny = (error, status = 400, extra = {}) => json({ ok: false, error, ...extra }, status);

/** 只允许同源页面调用：浏览器跨源带自定义头会先走 preflight，这里明确不接受。 */
export function sameOriginOrNone(request) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const host = new URL(request.url).origin;
  if (origin === host) return null;
  return `这个接口只接受同源调用（${host}）；命令行请用 tools/agent-upload.mjs`;
}

/** 返回 null 表示通过；否则返回给调用方的原因。 */
export function checkAuth(request, env) {
  const expected = env.ADMIN_UPLOAD_KEY || '';
  const given = request.headers.get('x-admin-key') || '';
  if (!expected) return '后台未配置口令（Pages secret ADMIN_UPLOAD_KEY 缺失），通道按关闭处理';
  if (!given) return '缺少 x-admin-key';
  if (!timingSafeEqual(given, expected)) return '口令不对';
  return null;
}

export async function readBody(request, limitBytes = 64 * 1024) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > limitBytes) return { error: '请求体过大' };
  const text = await request.text();
  if (text.length > limitBytes) return { error: '请求体过大' };
  try {
    return { doc: text ? JSON.parse(text) : {} };
  } catch {
    return { error: '请求体不是合法 JSON' };
  }
}

/** 调用方标识：只留哈希，不落明文 IP —— 后台的审计要能回答「谁投的」，但不该变成访问日志。 */
export function actorHash(request) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '';
  const ua = (request.headers.get('user-agent') || '').slice(0, 40);
  return { actor: hashLegacy(`${ip}|${ua}`), via: ua.includes('node') ? 'cli' : 'browser' };
}

// FNV-1a 64bit 的紧凑实现（边缘没有 node:crypto；这个只用于把来源压成不可逆的短标识）
function hashLegacy(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ (c & 0xff), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c >> 8), 0x811c9dc5) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16);
}
