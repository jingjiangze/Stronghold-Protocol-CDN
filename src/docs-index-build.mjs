// Read the docs off disk and date them, to produce the index the site publishes.
//
// Split from ./docs-index.mjs on purpose: the selection rules and the key substitution run in the
// Pages Function (no filesystem there), while this half needs fs and git. Keeping them in one module
// would drag `node:fs` into the edge bundle.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { sha256File } from './index-tree.mjs';
import { AGENT_DOC_MARKER, DOCS_DIR, extractTitle, isAgentDoc, pickAgentDoc, sortDocs } from './docs-index.mjs';

/** Every file under `site/docs/**`, skipping dotfiles and dot-directories. */
function walkDocs(absDir, relDir = DOCS_DIR) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(absDir, entry.name);
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkDocs(abs, rel));
    else if (entry.isFile()) out.push({ abs, rel });
  }
  return out;
}

/**
 * When git last changed a file.
 *
 * Filesystem mtimes are not a substitute: a fresh checkout stamps every file with the same time, so
 * the "newest document" would be decided by checkout order. Returns an empty date when git cannot
 * answer, and records that, rather than guessing.
 */
function gitUpdatedAt(repoRoot, repoRelPath) {
  try {
    const res = spawnSync('git', ['-C', repoRoot, 'log', '-1', '--format=%cI', '--', repoRelPath], {
      encoding: 'utf8',
      timeout: 15000,
    });
    const iso = (res.stdout || '').trim();
    if (res.status === 0 && /^\d{4}-\d{2}-\d{2}T/.test(iso)) return { updatedAt: iso, datedBy: 'git' };
  } catch {
    /* fall through */
  }
  return { updatedAt: '', datedBy: 'none' };
}

/**
 * Build the published document. `siteDir` is `site/`; `repoRoot` is the checkout root, because git
 * needs the path it tracks (`site/docs/x.md`), not the one the site serves (`docs/x.md`).
 */
export async function buildDocsIndex({ siteDir, repoRoot, log = () => {} }) {
  const files = walkDocs(path.join(siteDir, DOCS_DIR));
  const docs = [];
  for (const f of files) {
    const isMd = f.rel.endsWith('.md');
    const text = isMd ? fs.readFileSync(f.abs, 'utf8') : '';
    const dated = gitUpdatedAt(repoRoot, path.relative(repoRoot, f.abs).split(path.sep).join('/'));
    docs.push({
      path: f.rel,
      title: extractTitle(text),
      bytes: fs.statSync(f.abs).size,
      sha256: await sha256File(f.abs),
      updatedAt: dated.updatedAt,
      datedBy: dated.datedBy,
      agent: isAgentDoc(text),
    });
  }
  const sorted = sortDocs(docs);
  const picked = pickAgentDoc(sorted);
  log(`docs index: ${sorted.length} file(s); integration doc = ${picked.path || '(none)'}`);
  return {
    schema: 1,
    _how:
      '站点文档的索引，部署时重新生成（所以「最新」是算出来的，不是记在代码里的路径）。' +
      'updatedAt 来自 git 的提交时间，不是文件系统 mtime —— 后者在一次全新 checkout 之后会让所有文件看起来一样新。' +
      `agentDoc 是所有文档里提到 ${AGENT_DOC_MARKER} 的最新一份：既保证是最新的，也不会因为某篇无关文档写得晚而把它当成接入说明。`,
    generatedAt: new Date().toISOString(),
    docs: sorted,
    agentDoc: picked.path,
    agentDocWhy: picked.why,
  };
}
