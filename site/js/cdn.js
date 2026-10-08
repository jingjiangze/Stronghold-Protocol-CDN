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
    card.innerHTML =
      `<div class="card__title">${mirror.id}</div>` +
      `<div class="mono muted" style="margin-top:8px;word-break:break-all">${mirror.base || mirror.root}</div>` +
      `<div class="card__meta"><span>${mirror.kind || 'origin'}</span>` +
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

function renderDirs(dirs, totals) {
  const body = $('dirs')?.querySelector('tbody');
  if (!body) return;
  if (!dirs?.length) {
    body.innerHTML = '<tr><td colspan="3" class="muted">没有目录数据。</td></tr>';
    return;
  }
  body.innerHTML = dirs
    .map(
      (d) =>
        `<tr><td class="mono">${d.prefix}</td><td class="num">${fmtCount(d.files)}</td>` +
        `<td class="num">${fmtBytes(d.bytes)}</td></tr>`,
    )
    .join('');
  if (totals) setText('dir-note', `共 ${fmtCount(totals.files)} 个文件 / ${fmtBytes(totals.bytes)}`);
}

// ---- the drop-in download link -----------------------------------------------------------

/**
 * The zip is rebuilt whenever the guide, the launchers or the stamped token change, so the link
 * must never name a version. The deploy-time snapshot carries the resolved asset; the page only
 * falls back to the Releases page when that resolution failed.
 */
function renderDropin(dropin) {
  const button = $('dropin-download');
  if (!button) return;
  if (!dropin?.url) {
    setText('dropin-meta', ' · 在 Releases 页面的 Assets 里');
    return;
  }
  button.href = dropin.url;
  setText('dropin-name', dropin.name);
  setText(
    'dropin-meta',
    ` · ${fmtBytes(dropin.size)}${dropin.release ? ` · release ${dropin.release}` : ''}`,
  );
  const mirror = $('dropin-mirror');
  if (mirror && dropin.urls?.length > 1) {
    mirror.href = dropin.urls[1];
    mirror.hidden = false;
  }
}

/** Best effort: pick up a zip published after the last deploy. Never blocks the page. */
async function refreshDropin() {
  const repo = document.body.dataset.repo;
  if (!repo) return;
  const releases = await getJson(`https://api.github.com/repos/${repo}/releases?per_page=20`, 6000);
  const newest = (releases || [])
    .map((release) => ({
      release,
      asset: (release.assets || []).find((asset) => /stronghold-cdn[^/]*\.zip$/i.test(asset.name || '')),
    }))
    .filter((entry) => entry.asset)
    .sort((a, b) => String(b.release.published_at || '').localeCompare(String(a.release.published_at || '')))[0];
  if (!newest) return;
  const current = $('dropin-download')?.getAttribute('href');
  if (current === newest.asset.browser_download_url) return;
  renderDropin({
    url: newest.asset.browser_download_url,
    name: newest.asset.name,
    size: newest.asset.size,
    release: newest.release.tag_name,
    urls: [newest.asset.browser_download_url],
  });
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

async function measureMirror(mirror, attempts = 2) {
  let best = null;
  for (let i = 0; i < attempts; i++) {
    let sample;
    try {
      sample = await measureOnce(mirror, PROBE_PATH);
    } catch {
      sample = await measureOnce(mirror, PROBE_FALLBACK);
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
        return { ...mirror, error: String(error.message || error) };
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
  const [live, snap] = await Promise.all([
    Promise.all([getJson(`${CDN}/cdn/v1/art.json`), getJson(`${CDN}/cdn/v1/mirrors.json`)]).catch(() => null),
    getJson(SNAPSHOT).catch(() => null),
  ]);
  snapshot = snap;
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
  renderDirs(snapshot?.dirs || [], snapshot?.totals || null);
  renderDropin(snapshot?.dropin || null);
  wireProbe(flat);
  // Fire and forget: a blocked api.github.com must not delay or break the page.
  refreshDropin().catch(() => {});
}

main().catch((error) => {
  const line = $('status-line');
  if (line) {
    line.textContent = `页面初始化失败：${error.message}`;
    line.classList.add('warn');
  }
});
