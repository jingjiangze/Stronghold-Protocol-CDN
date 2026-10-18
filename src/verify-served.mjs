// Re-read what the bucket is actually serving and re-run the tree↔index consistency check on it.
//
// The step in tree-refresh.yml that calls this exists because the previous step validates the tree
// it just rebuilt, and what a reader gets is the tree the CDN is serving. Those are different
// objects: tree.json is published with `max-age=300`, so between the two sits an edge cache. A
// verification that re-reads the bytes it wrote proves the writer is correct; only this one proves
// the reader is being told the truth.
//
// It reads the bucket directly rather than over HTTP on purpose — through the edge it would answer
// whatever is cached, which is the exact ambiguity this step is here to remove.
import { r2Config, getObject } from './r2.mjs';
import { verifyTreeAndIndex } from './tree-verify.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const INDEX_KEY = 'cdn/v1/index.json';
export const TREE_KEY = 'cdn/v1/tree.json';

/**
 * @param {object} [deps] injected dependencies; the defaults are what production uses
 * @param {object} [deps.config] the R2 configuration
 * @param {(config: object, key: string) => Promise<Buffer|null>} [deps.getObject] the bucket reader
 * @returns {Promise<{ok: boolean, failures: string[], tag: string, token: string, totals: object}>}
 */
export async function verifyServedTree({ config = r2Config(), getObject: read = getObject } = {}) {
  const [indexBytes, treeBytes] = await Promise.all([
    read(config, INDEX_KEY),
    read(config, TREE_KEY),
  ]);
  if (!indexBytes) throw new Error(`桶里没有 ${INDEX_KEY} —— sync 从未发布过？`);
  if (!treeBytes) throw new Error(`桶里没有 ${TREE_KEY} —— 上一步失败了？`);
  const index = JSON.parse(indexBytes.toString('utf8'));
  const tree = JSON.parse(treeBytes.toString('utf8'));
  const { ok, failures } = verifyTreeAndIndex({ indexBytes, index, tree });
  return { ok, failures, tag: index.tag, token: tree.token, totals: tree.totals };
}

// Only when run directly, so the workflow can call it as a step while tests import it as a module.
// The comparison goes through pathToFileURL rather than a hand-built `file://` string: on Windows the
// latter needs backslash rewriting *and* percent-encoding of spaces in the path, and this repo lives
// under "Agent Work". Getting it wrong fails silently — the script exits 0 having verified nothing,
// which is the one outcome a verification step must never have.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await verifyServedTree();
    console.log(`[tree-refresh] index ${result.tag} / tree ${result.token}`);
    console.log(`[tree-refresh] totals ${JSON.stringify(result.totals)}`);
    if (!result.ok) {
      for (const failure of result.failures) console.error(`[tree-refresh] FAIL ${failure}`);
      process.exit(1);
    }
    console.log('[tree-refresh] PASS: 桶里 serving 的 tree 与 index 一致');
  } catch (error) {
    console.error(`[tree-refresh] FAIL ${error.message}`);
    process.exit(1);
  }
}
