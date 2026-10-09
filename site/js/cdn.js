// cdn.js — fills the asset-CDN page from the live interface, falling back to the deploy-time
// snapshot when the CDN is unreachable (a status page that breaks when the thing it documents is
// down is worse than useless).
//
// Only the interface hosts are ever contacted, and only over https: the same rule the tooling
// applies server-side, kept here so a tampered mirrors.json cannot point the page at something else.

const CDN = (document.body.dataset.cdnBase || '').replace(/\/+$/, '');
const SNAPSHOT = './data/snapshot.json';

const $ = (id) => document.getElementById(id);
const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };

const httpsOnly = (url) => {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

async function getJson(url, timeoutMs = 8000) {
  if (!httpsOnly(url) && !url.startsWith('./')) throw new Error(`refusing non-https url: ${url}`);
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const kb = bytes / 1024;
  // The drop-in zip is ~13 KB, and "0.0 MB" reads as a broken download.
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

const fmtCount = (n) => (Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—');

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false });
}

// ---- render ------------------------------------------------------------------------------

function renderStatus(art, source) {
  if (!art) {
    setText('status-line', '接口暂不可达，且没有可用的快照。');
    setText('nav-status', '接口不可达');
    $('status-line')?.classList.add('warn');
    return;
  }
  const v = art.verified || {};
  const clean = v.missing === 0 && v.mismatch === 0;

  setText('s-tag', art.upstream?.tag || '—');
  setText('s-files', fmtCount(art.tree?.files));
  setText('s-bytes', fmtBytes(art.tree?.bytes));
  setText('s-verify', clean ? '0 缺失' : `${v.missing} 缺失`);
  setText('nav-status', `${art.upstream?.tag || '?'} · ${clean ? '校验通过' : '校验异常'}`);
  setText('p-token', art.art?.token || '…');
  for (const el of document.querySelectorAll('.tok')) el.textContent = art.art?.token || '…';
  // the download box names the zip by upstream tag, not by cache token
  for (const el of document.querySelectorAll('.tag')) el.textContent = art.upstream?.tag || '…';

  const verifyEl = $('s-verify');
  verifyEl?.classList.toggle('ok', clean);
  verifyEl?.classList.toggle('warn', !clean);

  const byteSample = v.byteSample;
  const parts = [`上游 ${art.upstream?.tag || '?'}`, `缓存令牌 ${art.art?.token || '?'}`];
  parts.push(clean ? `全量 ${fmtCount(v.probed)} 项校验通过` : `${v.missing} 缺失 / ${v.mismatch} 不符`);
  if (byteSample) parts.push(`字节抽样 ${byteSample.checked} 个文件 / ${byteSample.mismatch} 不符`);
  if (v.verifiedByBucket) parts.push(`${v.verifiedByBucket} 项由源桶兜底确认`);
  parts.push(`上次同步 ${fmtTime(art.syncedAt)}`);
  parts.push(source === 'live' ? '数据实时读取自接口' : '接口不可达，显示的是上次部署的快照');
  setText('status-line', parts.join(' · '));
}

function renderMirrors(flat) {
  const host = $('mirror-cards');
  if (!host) return;
  host.innerHTML = '';
  for (const mirror of flat || []) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.mirror = mirror.id;
    // A git mount only serves what is committed to git, so say so rather than implying a full mirror.
    const coverage =
      mirror.coverage === 'partial'
        ? '<span class="chip" title="只挂载本仓 main 分支的工具文件，不含素材树">部分覆盖</span>'
        : '';
    // Show the path this card is measured on. It is not cosmetic: no single path exists on every
    // origin (the R2-only /cdn/v1/ tree 502s on a git mount), so the number below is only
    // comparable if the reader can see which object produced it.
    const probe = mirror.probe
      ? `<div class="mono muted" style="margin-top:6px;word-break:break-all">探针 ${mirror.probe}</div>`
      : '';
    card.innerHTML =
      `<div class="card__title">${mirror.id}</div>` +
      `<div class="mono muted" style="margin-top:8px;word-break:break-all">${mirror.base || mirror.root}</div>` +
      probe +
      `<div class="card__meta"><span>${mirror.kind || 'origin'}</span>${coverage}` +
      `<span class="card__value is-bad" data-ms>未测速</span></div>` +
      `<div class="card__stats" data-stats hidden>` +
      `<span>延迟 <b data-latency>—</b></span><span>速度 <b data-speed>—</b></span></div>`;
    host.appendChild(card);
  }
}

function renderPacks(packs) {
  const body = $('packs')?.querySelector('tbody');
  if (!body) return;
  if (!packs?.length) {
    body.innerHTML = '<tr><td colspan="5" class="muted">本次同步没有产出打包通道。</td></tr>';
    return;
  }
  body.innerHTML = packs
    .map(
      (pack) =>
        `<tr><td class="mono">${pack.id}.zip</td><td class="mono">${pack.group || '—'}</td>` +
        `<td class="num">${fmtCount(pack.files)}</td><td class="num">${fmtBytes(pack.size)}</td>` +
        `<td class="num">${(pack.urls || []).length}</td></tr>`,
    )
    .join('');
}

/**
 * Human-readable answer to "what are these mirrors actually serving, and does this one have it".
 *
 * The asset tree used to be absent from git — derived from the upstream release pack and never
 * committed — which is why every git mount showed "部分覆盖": not lagging behind, but holding none
 * of these bytes. It is committed now, on the orphan branch `assets-raw`, so the answer flipped.
 * Saying that in words matters more than the chip on each card.
 */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * The official documentation the release package ships, listed from the tree rather than typed out.
 *
 * `docs/**` rides the same index as the art, so it arrives with tree.json — no extra fetch and no
 * second list to keep in step. Files are linked absolutely (this page is served from the site
 * origin, which has no `/docs/`), and `.md` is served as `text/plain` by the CDN so it renders
 * instead of downloading.
 */
function renderDocs(treePromise) {
  const body = $('doc-rows');
  if (!body) return;
  const dirs = treePromise ? treePromise.then((d) => d?.dirs || []).catch(() => []) : Promise.resolve([]);
  return dirs.then((list) => {
    const rows = [];
    for (const d of list) {
      if (d.path !== 'docs' && !d.path.startsWith('docs/')) continue;
      for (const f of d.files || []) {
        rows.push({ path: `${d.path}/${f[0]}`, size: f[1] });
      }
    }
    rows.sort((a, b) => a.path.localeCompare(b.path));
    setText('doc-status', rows.length ? `${rows.length} 个文件` : '');
    if (!rows.length) {
      body.innerHTML =
        '<tr><td colspan="3" class="muted">这次发布的包里没有 docs/（或者清单还没重建）。</td></tr>';
      return;
    }
    body.innerHTML = rows
      .map((r) => {
        const name = r.path.slice('docs/'.length);
        return (
          `<tr><td class="mono">${esc(name)}</td><td class="num">${fmtBytes(r.size)}</td>` +
          `<td><a class="mono" href="${CDN}/${r.path}" target="_blank" rel="noopener">打开</a></td></tr>`
        );
      })
      .join('');
  });
}

/**
 * The endpoint table, rendered from the published contract rather than hand-copied.
 *
 * The hand-copied table had already drifted: it listed /fonts/** as immutable when the real policy
 * is "1 year with a token, 1 hour without", and it omitted /packs/**, /dl/** and api.json itself.
 * Reading the contract means the table cannot disagree with what the sync publishes. Paths contain
 * `<token>` and `**`, so they are escaped — innerHTML would eat `<token>` as a tag.
 */
function renderApi(doc) {
  const body = $('api-rows');
  if (!body) return;
  if (!doc?.endpoints?.length) {
    // Absolute, not relative: this page is served from the site origin, which answers /cdn/v1/*
    // with its SPA fallback (an HTML 200), so a relative link would render a page instead of JSON.
    body.innerHTML =
      '<tr><td colspan="3" class="muted">接口清单取不到，直接看 ' +
      `<a href="${CDN}/cdn/v1/api.json">${CDN}/cdn/v1/api.json</a>。</td></tr>`;
    return;
  }
  body.innerHTML = doc.endpoints
    .map((e) => `<tr><td class="mono">${esc(e.path)}</td><td>${esc(e.what)}</td><td class="mono">${esc(e.cache)}</td></tr>`)
    .join('');
  // The base is stamped into the contract, so every place that prints it agrees by construction.
  for (const el of document.querySelectorAll('[data-base]')) el.textContent = doc.base;
}

function renderManifest(dirs, totals, art) {
  const body = $('manifest-dirs')?.querySelector('tbody');
  if (!body) return;
  if (!dirs?.length) {
    body.innerHTML = '<tr><td colspan="5" class="muted">没有素材清单数据。</td></tr>';
    return;
  }
  const total = totals?.bytes || dirs.reduce((s, d) => s + d.bytes, 0);
  const files = totals?.files || dirs.reduce((s, d) => s + d.files, 0);

  // The last column used to be a constant "是". It is not one any more: `docs/**` is served by R2
  // and Pages like the rest, but it is not in the repo, so the git mounts answer 404 for it. A
  // column that says "是" for every row would be a claim the docs row cannot keep.
  const onGitMount = (prefix) => !prefix.startsWith('docs');
  body.innerHTML = dirs
    .map((d) => {
      const pct = total ? (d.bytes / total) * 100 : 0;
      const git = onGitMount(d.prefix)
        ? '<td class="num">是</td>'
        : '<td class="num">否 <span class="muted">（仅 R2 / Pages）</span></td>';
      return (
        `<tr><td class="mono">${d.prefix}</td><td class="num">${fmtCount(d.files)}</td>` +
        `<td class="num">${fmtBytes(d.bytes)}</td><td class="num">${pct.toFixed(1)}%</td>` +
        git +
        `</tr>`
      );
    })
    .join('');

  const tag = art?.upstream?.tag ? `上游 ${art.upstream.tag} 发布包` : '上游发布包';
  const docBytes = dirs.filter((d) => d.prefix.startsWith('docs')).reduce((s, d) => s + d.bytes, 0);
  const lead = $('manifest-lead');
  if (lead) {
    // innerHTML, not setText: the emphasis is the point, and setText escapes it into visible tags.
    lead.innerHTML =
      `这一批源在分发的是同一棵官方树：<b>${fmtCount(files)} 个文件 / ${fmtBytes(total)}</b>，全部由 ${tag} 解出。` +
      `R2 与 Pages 持有<b>全部</b>；git 挂载源（jsDelivr / ghfast / gitcdn）持有<b>素材部分</b> —— ` +
      `素材树已于 2026-10-09 提交到本仓的 <b>assets-raw</b> 孤儿分支，抽样 40 条路径 × 3 个源逐字节 sha256 校验一致。` +
      (docBytes
        ? `其中 <b>docs/</b>（${fmtBytes(docBytes)} 官方文档与 wiki 数据）<b>只在 R2 / Pages 上</b>：` +
          `它不在本仓里，git 挂载源对它返回 404，下表最后一行已按实际情况标注。`
        : '') +
      `「部分覆盖」这个说法在素材树进 git 之前是对的 —— 不是说还没同步完，而是当时这批字节在源里确实不存在。`;
  }
}

// ---- the browsable tree ------------------------------------------------------------------

/**
 * Turn the published flat map of directories into a nested model.
 *
 * The published file is grouped by directory (`dirs[path].files = [[name, size, mod?], …]`) because
 * that is the cheapest shape to serve. Rendering wants a tree, so the paths are split into nodes
 * once here; every later interaction works off this model and never re-fetches.
 */
function buildTreeModel(dirs) {
  const root = { name: '', path: '', dirs: new Map(), files: [], bytes: 0 };
  const nodeFor = (path) => {
    if (!path) return root;
    let node = root;
    let acc = '';
    for (const part of path.split('/')) {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.dirs.get(part);
      if (!child) {
        child = { name: part, path: acc, dirs: new Map(), files: [], bytes: 0 };
        node.dirs.set(part, child);
      }
      node = child;
    }
    return node;
  };
  for (const [dir, info] of Object.entries(dirs || {})) {
    const node = nodeFor(dir);
    for (const f of info.files || []) node.files.push({ name: f[0], size: f[1] || 0, mod: f[2] === 1 });
    node.bytes += info.bytes || 0;
  }
  // Roll the totals up so a collapsed row can say how much is underneath it without walking it.
  const rollUp = (node) => {
    for (const child of node.dirs.values()) node.bytes += rollUp(child);
    return node.bytes;
  };
  rollUp(root);
  return root;
}

const countFiles = (node) => node.files.length + [...node.dirs.values()].reduce((s, c) => s + countFiles(c), 0);

/** One row. Children are built on demand: 12k files must never all be in the DOM at once. */
function treeRow(node, depth, isDir) {
  const row = document.createElement('div');
  row.className = 'tree__row' + (isDir ? ' tree__row--dir' : '');
  row.style.paddingLeft = `${depth * 14 + 8}px`;
  if (isDir) {
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-expanded', 'false');
    row.innerHTML =
      `<span class="tree__caret">▸</span><span class="tree__name mono">${node.name}/</span>` +
      `<span class="tree__meta">${fmtCount(countFiles(node))} 个 · ${fmtBytes(node.bytes)}</span>`;
  } else {
    row.setAttribute('role', 'treeitem');
    // The href is the real asset URL, so a file name is not decoration: clicking it opens the file.
    row.innerHTML =
      `<span class="tree__caret"></span><a class="tree__name mono" href="${CDN}/${node.path}" target="_blank" rel="noopener">${node.name}</a>` +
      (node.mod ? '<span class="chip chip--mod" title="本仓刻意托管的第三方 mod 素材，不在上游清单里">托管</span>' : '') +
      `<span class="tree__meta">${fmtBytes(node.size)}</span>`;
  }
  return row;
}

/**
 * Render the published tree, expandable, with a filter.
 *
 * Filtering switches to a flat list of matching paths: a tree of matches would be mostly empty
 * directories, and the question being asked is "where is this file", not "what is this directory".
 */
async function renderTree(snapshotDirs, snapshotTotals, treePromise = null) {
  const host = $('tree');
  if (!host) return;
  const status = (t) => setText('tree-status', t);

  let doc = treePromise ? await treePromise : null;
  if (!doc?.dirs) {
    try {
      doc = await getJson(`${CDN}/cdn/v1/tree.json`, 20000);
    } catch {
      /* fall through to the snapshot */
    }
  }
  if (!doc?.dirs) {
    // Degraded: the deploy snapshot only carries per-directory totals, so say so rather than
    // showing a tree that silently stops at the directory level.
    if (!snapshotDirs?.length) {
      host.innerHTML = '<p class="muted">目录数据不可用。</p>';
      status('');
      return;
    }
    host.innerHTML =
      '<p class="muted">暂时取不到完整文件树（cdn/v1/tree.json）。下面只到目录一级，来自部署快照。</p>' +
      snapshotDirs
        .map(
          (d) =>
            `<div class="tree__row tree__row--dir" style="padding-left:8px"><span class="tree__caret"></span>` +
            `<span class="tree__name mono">${d.prefix}</span>` +
            `<span class="tree__meta">${fmtCount(d.files)} 个 · ${fmtBytes(d.bytes)}</span></div>`,
        )
        .join('');
    if (snapshotTotals) status(`共 ${fmtCount(snapshotTotals.files)} 个文件 / ${fmtBytes(snapshotTotals.bytes)}（目录级）`);
    return;
  }

  const root = buildTreeModel(doc.dirs);
  const t = doc.totals || {};
  setText('dir-note', `共 ${fmtCount(t.files)} 个文件 / ${fmtBytes(t.bytes)}`);
  status(`共 ${fmtCount(t.files)} 个文件 / ${fmtBytes(t.bytes)} · ${fmtCount(t.dirs)} 个目录` + (t.hosted ? ` · 其中 ${t.hosted} 个为刻意托管` : ''));

  /** Draw one level of a node's children. */
  const paint = (node, container, depth) => {
    for (const child of [...node.dirs.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const row = treeRow(child, depth, true);
      const kids = document.createElement('div');
      kids.className = 'tree__children';
      kids.hidden = true;
      let built = false;
      const toggle = () => {
        if (!built) {
          paint(child, kids, depth + 1);
          for (const f of child.files.sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const fr = treeRow({ ...f, path: `${child.path}/${f.name}` }, depth + 1, false);
            kids.appendChild(fr);
          }
          built = true;
        }
        kids.hidden = !kids.hidden;
        row.setAttribute('aria-expanded', String(!kids.hidden));
        row.querySelector('.tree__caret').textContent = kids.hidden ? '▸' : '▾';
      };
      row.addEventListener('click', (e) => {
        if (e.target.closest('a')) return; // a file link inside a dir row is not a toggle
        toggle();
      });
      row.tabIndex = 0;
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
      container.appendChild(row);
      container.appendChild(kids);
    }
    // Files directly in this directory (the root has none, but a leaf directory does).
    if (depth >= 0) {
      for (const f of node.files.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        container.appendChild(treeRow({ ...f, path: node.path ? `${node.path}/${f.name}` : f.name }, depth, false));
      }
    }
  };

  const draw = () => {
    host.innerHTML = '';
    paint(root, host, 0);
  };
  draw();

  // Filter: flatten to matching file paths so the result is the answer, not a mostly-empty tree.
  const filter = $('tree-filter');
  if (filter) {
    let timer = null;
    filter.addEventListener('input', () => {
      clearTimeout(timer);
      // Debounced: the walk touches 12k files and a keystroke must not pay for all of them.
      timer = setTimeout(() => {
        const q = filter.value.trim().toLowerCase();
        if (!q) { draw(); return; }
        const hits = [];
        const walk = (node) => {
          for (const f of node.files) {
            const p = node.path ? `${node.path}/${f.name}` : f.name;
            if (p.toLowerCase().includes(q)) hits.push({ ...f, path: p });
          }
          for (const c of node.dirs.values()) walk(c);
        };
        walk(root);
        hits.sort((a, b) => (a.path < b.path ? -1 : 1));
        const shown = hits.slice(0, 400);
        host.innerHTML = shown.map((f) => treeRow(f, 0, false).outerHTML).join('');
        status(`${fmtCount(hits.length)} 个匹配${hits.length > shown.length ? `（显示前 ${shown.length}）` : ''}`);
      }, 150);
    });
  }
  const collapse = $('tree-collapse');
  if (collapse) collapse.addEventListener('click', () => { if (filter) filter.value = ''; draw(); });
}


// ---- the two download links --------------------------------------------------------------

/**
 * Each zip is rebuilt whenever the guide, the launchers or the stamped token change, so a link
 * must never name a version. The deploy-time snapshot carries the resolved assets; the page only
 * falls back to the Releases page when that resolution failed.
 *
 * The two variants are the same shape, so they share one renderer. The name patterns are kept
 * disjoint on purpose: "stronghold-official-cdn-…" does not contain "stronghold-cdn" (the
 * substring is "official-cdn"), so neither can put the other's zip behind its own button.
 */
const DOWNLOADS = [
  { key: 'dropin', id: 'dropin', pattern: /stronghold-cdn[^/]*\.zip$/i },
  { key: 'officialCdn', id: 'official', pattern: /^stronghold-official-cdn[^/]*\.zip$/i },
];

function renderDownload({ id }, asset) {
  const button = $(`${id}-download`);
  if (!button) return;
  if (!asset?.url) {
    setText(`${id}-meta`, ' · 在 Releases 页面的 Assets 里');
    return;
  }
  button.href = asset.url;
  setText(`${id}-name`, asset.name);
  setText(`${id}-meta`, ` · ${fmtBytes(asset.size)}${asset.release ? ` · release ${asset.release}` : ''}`);
  const mirror = $(`${id}-mirror`);
  if (mirror && asset.urls?.length > 1) {
    mirror.href = asset.urls[1];
    mirror.hidden = false;
  }
}

function renderDownloads(snapshot) {
  for (const variant of DOWNLOADS) renderDownload(variant, snapshot?.[variant.key]);
}

/**
 * Point each download at whichever of its own URLs measures fastest.
 *
 * The zips are offered on several hosts and the ranking is not stable — measured from mainland
 * China the own origin and the ghfast mirror trade places — so leaving the button on whichever URL
 * happens to be first gives some visitors the slower one. The speed test already measures every
 * mirror, so the same measurement should decide the download.
 *
 * Only the hosts the downloads actually use are probed. Running the full nine-mirror test here
 * would spend megabytes per visitor to choose between the two or three URLs a button has.
 *
 * Costs one 256 KiB fetch per candidate host, once per page load. It never blocks the page and
 * silently leaves the button alone if nothing measured better.
 */
async function preferFastestDownload(snapshot, flat) {
  const byHost = new Map();
  for (const m of flat || []) {
    try {
      byHost.set(new URL(m.root).host, m);
    } catch {
      /* a malformed root is not a candidate */
    }
  }
  for (const variant of DOWNLOADS) {
    const asset = snapshot?.[variant.key];
    const button = $(`${variant.id}-download`);
    if (!asset?.urls?.length || !button) continue;

    // One candidate per distinct host, so a variant listing the same host twice is probed once.
    const candidates = new Map();
    for (const url of asset.urls) {
      try {
        const host = new URL(url).host;
        const mirror = byHost.get(host);
        if (mirror && !candidates.has(host)) candidates.set(host, { url, mirror });
      } catch {
        /* skip a URL we cannot parse */
      }
    }
    // Fewer than two measurable hosts means there is no choice to make.
    if (candidates.size < 2) continue;

    const measured = [];
    for (const [host, { url, mirror }] of candidates) {
      try {
        measured.push({ host, url, ...(await measureMirror(mirror, 1)) });
      } catch {
        /* an unreachable candidate simply loses */
      }
    }
    if (measured.length < 2) continue;
    measured.sort((a, b) => b.kbps - a.kbps || a.latency - b.latency);
    const win = measured[0];
    button.href = win.url;
    const meta = $(`${variant.id}-meta`);
    if (meta) meta.textContent = `${meta.textContent} · 已按实测选 ${win.host}（${fmtSpeed(win.kbps)}）`;
  }
}

/** Best effort: pick up a zip published after the last deploy. Never blocks the page. */
async function refreshDownloads() {
  const repo = document.body.dataset.repo;
  if (!repo) return;
  const releases = await getJson(`https://api.github.com/repos/${repo}/releases?per_page=20`, 6000);
  for (const { id, pattern } of DOWNLOADS) {
    const newest = (releases || [])
      .map((release) => ({
        release,
        asset: (release.assets || []).find((asset) => pattern.test(asset.name || '')),
      }))
      .filter((entry) => entry.asset)
      .sort((a, b) => String(b.release.published_at || '').localeCompare(String(a.release.published_at || '')))[0];
    if (!newest) continue;
    if ($(`${id}-download`)?.getAttribute('href') === newest.asset.browser_download_url) continue;
    renderDownload({ id }, {
      url: newest.asset.browser_download_url,
      name: newest.asset.name,
      size: newest.asset.size,
      release: newest.release.tag_name,
      urls: [newest.asset.browser_download_url],
    });
  }
}

// ---- mirror speed test -------------------------------------------------------------------

/**
 * Probe target: the interface's own 256 KiB file, which every origin serves.
 *
 * Both halves of "fast" matter — how long until the first byte (latency) and how fast the rest
 * follows (throughput) — and a 26-byte robots.txt only answers the first. Range requests would
 * sample a big file cheaply but the Pages origin rejects their CORS preflight (405), so a small
 * known-size file is the portable way. Two attempts, best throughput wins, so a cold connection
 * is not the verdict.
 */
const PROBE_PATH = '/cdn/v1/probe.bin';

function fmtSpeed(kbps) {
  return kbps >= 1024 ? `${(kbps / 1024).toFixed(1)} MB/s` : `${kbps} KB/s`;
}

// Before the probe file has been deployed everywhere, fall back to the index — it exists on every
// origin, so the test never depends on deploy order.
const PROBE_FALLBACK = '/cdn/v1/index.json';
// A git origin has no /cdn/v1/ tree, so its fallback is another file committed to the repo.
const PROBE_FALLBACK_GIT = '/README.md';

async function measureOnce(mirror, path) {
  const url = `${mirror.root}${path}?probe=${Date.now()}`;
  const t0 = performance.now();
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // The promise resolves when the headers arrive, so this is the time to first byte.
  const tHeaders = performance.now();
  const body = await res.arrayBuffer();
  const t1 = performance.now();
  const seconds = Math.max(0.001, (t1 - tHeaders) / 1000);
  return {
    latency: Math.round(tHeaders - t0),
    kbps: Math.round(body.byteLength / 1024 / seconds),
    bytes: body.byteLength,
    path,
  };
}

// A git-mount origin has no /cdn/v1/ tree of its own, so it publishes its own probe path; using it
// directly avoids spending the first attempt on a guaranteed 404.
function probePathFor(mirror) {
  return mirror.probe || PROBE_PATH;
}

async function measureMirror(mirror, attempts = 2) {
  let best = null;
  for (let i = 0; i < attempts; i++) {
    let sample;
    try {
      sample = await measureOnce(mirror, probePathFor(mirror));
    } catch {
      sample = await measureOnce(mirror, mirror.probe ? PROBE_FALLBACK_GIT : PROBE_FALLBACK);
    }
    if (!best || sample.kbps > best.kbps) best = sample;
  }
  return best;
}

async function probeMirrors(flat) {
  const ranked = await Promise.all(
    (flat || []).map(async (mirror) => {
      if (!httpsOnly(mirror.root)) return { ...mirror, error: '非 https' };
      try {
        return { ...mirror, ...(await measureMirror(mirror)) };
      } catch (error) {
        // A git mirror can be genuinely slow rather than down (Statically served one probe at
        // ~700 B/s on a good day), so distinguish a timeout from a refusal.
        const message = String(error?.message || error);
        return { ...mirror, error: /timed? ?out|abort/i.test(message) ? '超时' : message };
      }
    }),
  );
  // Ranked by download speed, which is what the assets actually cost; latency is shown beside it.
  ranked.sort((a, b) => (b.kbps ?? -1) - (a.kbps ?? -1) || (a.latency ?? 1e9) - (b.latency ?? 1e9));
  return ranked;
}

function paintProbe(ranked) {
  for (const mirror of ranked) {
    const card = document.querySelector(`.card[data-mirror="${CSS.escape(mirror.id)}"]`);
    if (!card) continue;
    const state = card.querySelector('[data-ms]');
    const stats = card.querySelector('[data-stats]');
    const failed = mirror.kbps == null;

    if (state) {
      state.textContent = failed ? mirror.error || '不可用' : '已测速';
      state.className = failed ? 'card__value is-bad' : 'card__value';
    }
    if (stats) {
      stats.hidden = failed;
      if (!failed) {
        const latency = stats.querySelector('[data-latency]');
        const speed = stats.querySelector('[data-speed]');
        if (latency) latency.textContent = `${mirror.latency} ms`;
        if (speed) speed.textContent = fmtSpeed(mirror.kbps);
      }
    }

    const isBest = ranked[0]?.id === mirror.id && !failed;
    card.classList.toggle('is-best', isBest);
    card.querySelector('.badge')?.remove();
    if (isBest) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '最快';
      card.appendChild(badge);
    }
  }
}

function wireProbe(flat) {
  const button = $('probe');
  if (!button) return;
  button.addEventListener('click', async () => {
    const line = $('probe-line');
    button.disabled = true;
    if (line) line.textContent = '正在并发探测各镜像（每个下载 256 KiB）…';
    try {
      const ranked = await probeMirrors(flat);
      paintProbe(ranked);
      const best = ranked.find((m) => m.kbps != null);
      if (line) {
        line.textContent = best
          ? `最快：${best.id}（${fmtSpeed(best.kbps)}，延迟 ${best.latency} ms）——按下载速度排序`
          : '所有镜像都不可达。';
      }
    } finally {
      button.disabled = false;
    }
  });
}

// ---- boot ---------------------------------------------------------------------------------

async function main() {
  let art = null;
  let mirrors = null;
  let snapshot = null;
  let source = 'live';

  // The snapshot is fetched either way: the interface gives the live numbers, but the directory
  // table comes from it (aggregating 1.3 MB of index on every visit is not worth it), and it is
  // the fallback when the interface is unreachable.
  const [live, snap, contract] = await Promise.all([
    Promise.all([getJson(`${CDN}/cdn/v1/art.json`), getJson(`${CDN}/cdn/v1/mirrors.json`)]).catch(() => null),
    getJson(SNAPSHOT).catch(() => null),
    getJson(`${CDN}/cdn/v1/api.json`).catch(() => null),
  ]);
  snapshot = snap;
  renderApi(contract);
  if (live) {
    [art, mirrors] = live;
  } else {
    source = 'snapshot';
    art = snapshot?.art || null;
    mirrors = snapshot?.mirrors || null;
  }

  const flat = mirrors?.flat || art?.art?.mirrors || [];
  renderStatus(art, source);
  renderMirrors(flat);
  // art.json's pack list is the complete one (id, group, files, size, urls); mirrors.json's copy
  // is what a consumer reads for the URLs, so prefer the complete one and fall back to it.
  renderPacks(art?.art?.packs?.length ? art.art.packs : mirrors?.packs || []);
  renderManifest(snapshot?.dirs || [], snapshot?.totals || null, art);
  // One fetch of the 85 KiB tree feeds both the directory browser and the docs list; neither may
  // hold up the rest of the page, so the promise is handed to each and awaited inside.
  const treePromise = getJson(`${CDN}/cdn/v1/tree.json`, 20000).catch(() => null);
  renderDocs(treePromise).catch(() => {});
  renderTree(snapshot?.dirs || [], snapshot?.totals || null, treePromise).catch(() => {});
  renderDownloads(snapshot);
  wireProbe(flat);
  // Fire and forget: a blocked api.github.com must not delay or break the page.
  refreshDownloads().catch(() => {});
  // Fire and forget: the fastest-host choice must never hold up the page.
  preferFastestDownload(snapshot, flat).catch(() => {});
}

main().catch((error) => {
  const line = $('status-line');
  if (line) {
    line.textContent = `页面初始化失败：${error.message}`;
    line.classList.add('warn');
  }
});
