// Which document the admin page hands out as "the integration instructions".
//
// The page used to hard-code `/docs/agent-upload.md` in three places. That is a promise nobody can
// keep: rename the document or publish a newer one and the page silently keeps handing out the old
// answer — the failure mode this repository has already hit with the endpoint list.
//
// So the docs are enumerated and dated instead, and "the newest one" becomes a computed fact rather
// than a path someone remembers to update.
//
// This module is deliberately free of `node:` imports: the same functions run in the Pages Function
// that assembles the copy, and the edge runtime has no filesystem. The walk that reads the files and
// asks git for dates lives in ./docs-index-build.mjs, which is free to use node.

/** Where the docs live, and where the index is published. Neither is configurable on purpose. */
export const DOCS_DIR = 'docs';
export const DOCS_INDEX_PATH = 'data/docs.json';

/**
 * Does this document describe the upload channel?
 *
 * This is what separates "the docs" from "the integration instructions". It is a content marker,
 * not a filename, so renaming or splitting the document keeps working. Kept deliberately narrow:
 * a document that lists the upload API's paths is the one an agent should be handed.
 */
export const AGENT_DOC_MARKER = '/api/cdn/upload/';

export const isAgentDoc = (text) => String(text || '').includes(AGENT_DOC_MARKER);

/** The first `# ` heading, which is what a reader would call the document's name. */
export function extractTitle(text) {
  const m = String(text || '').match(/^\s*#\s+(.+?)\s*$/m);
  return m ? m[1].replace(/[`*]/g, '').trim() : '';
}

/** Newest first; ties broken by path so the published index is byte-stable between runs. */
export function isNewer(a, b) {
  const ta = a?.updatedAt || '';
  const tb = b?.updatedAt || '';
  if (ta !== tb) return ta > tb;
  return String(a?.path) < String(b?.path);
}

export const sortDocs = (docs) => [...(docs || [])].sort((a, b) => (isNewer(a, b) ? -1 : 1));

/**
 * Which document is the integration instructions.
 *
 * The newest one that describes the upload channel — newest because the whole point is that the page
 * must not hand out a superseded document, and marker-matched so "newest" cannot pick an unrelated
 * document just because it was written later (the site also carries bandwidth and WebSocket notes;
 * picking the newest overall would hand an agent a bandwidth write-up as its upload instructions).
 *
 * `why` is returned so the page can say how it chose instead of asking the reader to trust it.
 */
export function pickAgentDoc(docs) {
  const list = [...(docs || [])].filter((d) => d && d.path);
  if (!list.length) return { path: '', why: '还没有任何文档' };
  const agentDocs = list.filter((d) => d.agent);
  const pool = agentDocs.length ? agentDocs : list;
  const newest = pool.reduce((best, d) => (isNewer(d, best) ? d : best));
  const when = newest?.updatedAt || '时间未知';
  return agentDocs.length
    ? { path: newest.path, why: `所有文档里提到 ${AGENT_DOC_MARKER} 的最新一份（${when}）` }
    : { path: newest ? newest.path : '', why: `没有任何文档提到 ${AGENT_DOC_MARKER}，退回到最新的一份（${when}）` };
}

/**
 * The placeholder the integration document carries where the key goes.
 *
 * Several spellings, because this is a document a human edits: the point is that a reader following
 * the instructions must never be left with a literal `<直连后台密钥>` where a key should be.
 */
const KEY_PLACEHOLDER = /<\s*(?:直连后台密钥|后台密钥|密钥|x-admin-key|admin[ _-]?key)\s*>/gi;

const hasPlaceholder = (text) => new RegExp(KEY_PLACEHOLDER.source, 'i').test(text);

/**
 * Substitute the real key into the document, so the copied text is complete.
 *
 * Returns `{text, injected}` rather than a bare string: when the document has no placeholder the key
 * is appended in a marked block, and the caller must be able to say which happened — a copy that
 * silently omits the key looks exactly like a successful one.
 *
 * With no key it returns the document untouched and `injected: false`; it never invents one.
 */
export function injectAdminKey(text, key) {
  const src = String(text || '');
  const k = String(key || '');
  if (!k) return { text: src, injected: false };
  if (hasPlaceholder(src)) return { text: src.replace(KEY_PLACEHOLDER, k), injected: true };
  return {
    text: `${src.replace(/\s*$/, '')}\n\n---\n\n本次直连密钥（请求头 x-admin-key）：${k}\n`,
    injected: true,
  };
}
