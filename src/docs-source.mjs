// The upstream package's `docs/**` as a machine-readable index.
//
// WHY: the official docs (PLAYING.md / DEPLOY.md / docs/research/*.json — the wiki datasets) ride the
// release package, not this repository, so a git mount answers 404 for them. The only place that set
// was described was a rendered table on the site, which an agent cannot read: it had to pull the
// 1.7 MB key table or the 85 KB tree just to learn six paths, and it had no way to verify the bytes
// it got or to tell one release's copy from another's.
//
// This is a FILTERED VIEW of the release index (which already carries a sha256 per file) plus the
// release token, so "which files, how big, which bytes, which release" is one small fetch.
//
// The token is the point of the whole thing: those files are replaced wholesale on every upstream
// release while their paths stay the same, so a reader that wants the CURRENT copy must request
// `/docs/<path>?v=<token>` — the token makes the edge copy immutable, and a changed token is how a
// reader learns that upstream released.

/** Where the index is published, under the interface prefix every consumer already knows. */
export const DOCS_SOURCE_PATH = 'cdn/v1/docs.json';

/** Upstream docs live under `docs/` in the release package; keys are package-relative. */
export const UPSTREAM_DOCS_PREFIX = 'docs/';

/**
 * Build the published document.
 *
 * @param {{files?:Record<string,{size:number,sha256:string}>, token?:string, upstream?:{repo?:string,tag?:string}}} input
 * @returns {{schema:number, token:string, upstream:{repo:string,tag:string}, count:number, bytes:number, docs:{path:string,size:number,sha256:string}[], note:string}}
 */
export function buildDocsDoc({ files = {}, token = '', upstream = {} } = {}) {
  const docs = Object.keys(files || {})
    .filter((key) => String(key).startsWith(UPSTREAM_DOCS_PREFIX))
    .sort()
    .map((path) => {
      const entry = files[path] || {};
      return { path, size: Number(entry.size) || 0, sha256: String(entry.sha256 || '') };
    });
  return {
    schema: 1,
    token: String(token || ''),
    upstream: { repo: String(upstream.repo || ''), tag: String(upstream.tag || '') },
    count: docs.length,
    bytes: docs.reduce((sum, d) => sum + d.size, 0),
    docs,
    note:
      '官方文档与 wiki 数据（上游包内 docs/**，键即包内路径）。这些文件随上游每次发布整体更换、路径不变，' +
      '所以「取最新」= 先读本文件的 token 或 /cdn/v1/art.json 的 token，再请求 /<path>?v=<token>；' +
      '令牌一变即上游发了新版本。sha256 来自发布索引，可用于校验字节。' +
      '唯一的源是 R2 / Pages —— git 挂载源不含 docs/（清单里的 docsEligible=false 说的就是这件事）。',
  };
}
