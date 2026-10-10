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

  // If every document reports the same commit time, "newest" was decided by the path tie-break, not
  // by time — the signature of a shallow clone (a CI checkout with depth=1 holds one commit, so
  // `git log -1` answers the same thing for every file). Saying so is the point: a reader who is
  // told "newest" will otherwise trust a choice that was never about time. site.yml sets
  // fetch-depth: 0 to avoid this; the note stays so a regression is visible instead of silent.
  const dates = new Set(sorted.map((d) => d.updatedAt).filter(Boolean));
  const degenerate = sorted.length > 1 && dates.size <= 1;
  if (degenerate) log(`docs index: every document reports the same date (${[...dates][0] || 'none'}) — dates are not discriminating`);

  return {
    schema: 1,
    _how:
      '站点文档的索引，部署时重新生成（所以「最新」是算出来的，不是记在代码里的路径）。' +
      'updatedAt 来自 git 的提交时间，不是文件系统 mtime —— 后者在一次全新 checkout 之后会让所有文件看起来一样新。' +
      `agentDoc 是所有文档里提到 ${AGENT_DOC_MARKER} 的最新一份：既保证是最新的，也不会因为某篇无关文档写得晚而把它当成接入说明。`,
    generatedAt: new Date().toISOString(),
    dating: degenerate ? 'degenerate' : 'ok',
    _dating_note: degenerate
      ? '所有文档的 updatedAt 相同，说明这次取到的是浅克隆（只有一条提交），「最新」实际由路径排序决定、与时间无关。site.yml 已设 fetch-depth: 0；这条字段在是为了让回归看得见。'
      : '每条文档的 updatedAt 来自它最后一次被提交的时间，可以据此判断新旧。',
    docs: sorted,
    agentDoc: picked.path,
    agentDocWhy: degenerate ? `${picked.why}（注意：本次所有文档日期相同，选的其实是路径序第一份）` : picked.why,
  };
}
