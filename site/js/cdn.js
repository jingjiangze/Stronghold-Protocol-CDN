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

async function getJson(url) {
  if (!httpsOnly(url) && !url.startsWith('./')) throw new Error(`refusing non-https url: ${url}`);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function fmtCount(n) {
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—';
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false });
}

// ---- render ------------------------------------------------------------------------------

function renderStatus(art, source) {
  if (!art) {
    setText('status-line', '接口暂不可达，且没有可用的快照。');
    $('status-line')?.classList.add('cdn-status--err');
    return;
  }
  setText('s-tag', art.upstream?.tag || '—');
  setText('s-token', art.art?.token || '—');
  setText('p-token', art.art?.token || '…');
  for (const el of document.querySelectorAll('.tok')) el.textContent = art.art?.token || '…';

  const v = art.verified || {};
  const clean = v.missing === 0 && v.mismatch === 0;
  setText('s-verify', clean ? `0 缺失 / 0 不符（${fmtCount(v.probed)} 项）` : `${v.missing} 缺失 / ${v.mismatch} 不符`);
  $('s-verify')?.classList.toggle('cdn-stat__v--mint', clean);
  $('s-verify')?.classList.toggle('cdn-stat__v--gold', !clean);

  setText('s-files', fmtCount(art.tree?.files));
  setText('s-bytes', fmtBytes(art.tree?.bytes));
  setText('s-synced', fmtTime(art.syncedAt));

  const byteSample = v.byteSample;
  const parts = [`上游 ${art.upstream?.tag || '?'}`, `缓存令牌 ${art.art?.token || '?'}`];
  if (byteSample) parts.push(`字节抽样 ${byteSample.checked} 个文件 / ${byteSample.mismatch} 不符`);
  if (v.verifiedByBucket) parts.push(`${v.verifiedByBucket} 项由源桶兜底确认`);
  parts.push(source === 'live' ? '数据实时读取自接口' : '接口不可达，显示的是上次部署的快照');
  setText('status-line', parts.join(' · '));
}

function renderMirrors(flat) {
  const host = $('mirrors');
  if (!host) return;
  host.innerHTML = '';
  for (const mirror of flat || []) {
    const card = document.createElement('div');
    card.className = 'cdn-mirror';
    card.dataset.mirror = mirror.id;
    card.innerHTML =
      `<div class="cdn-mirror__id">${mirror.id}</div>` +
      `<div class="cdn-mirror__base">${mirror.base || mirror.root}</div>` +
      `<div class="cdn-mirror__meta">` +
      `<span class="micro">${mirror.kind || 'origin'}</span>` +
      `<span class="cdn-mirror__ms cdn-mirror__ms--bad" data-ms>未测速</span>` +
      `</div>`;
    host.appendChild(card);
  }
}

function renderPacks(packs) {
  const body = $('packs')?.querySelector('tbody');
  if (!body) return;
  if (!packs?.length) {
    body.innerHTML = '<tr><td colspan="5">本次同步没有产出打包通道。</td></tr>';
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
    body.innerHTML = '<tr><td colspan="3">没有目录数据。</td></tr>';
    return;
  }
  body.innerHTML = dirs
    .map(
      (d) =>
        `<tr><td class="mono">${d.prefix}</td><td class="num">${fmtCount(d.files)}</td>` +
        `<td class="num">${fmtBytes(d.bytes)}</td></tr>`,
    )
    .join('');
  if (totals) setText('dir-note', `共 ${fmtCount(totals.files)} 个文件 / ${fmtBytes(totals.bytes)}。`);
}

// ---- mirror speed test -------------------------------------------------------------------

async function probeMirrors(flat) {
  const ranked = await Promise.all(
    (flat || []).map(async (mirror) => {
      if (!httpsOnly(mirror.root)) return { ...mirror, ms: null, error: '非 https' };
      const started = performance.now();
      try {
        const res = await fetch(`${mirror.root}/cdn/v1/mirrors.json?probe=${Date.now()}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.arrayBuffer();
        return { ...mirror, ms: Math.round(performance.now() - started) };
      } catch (error) {
        return { ...mirror, ms: null, error: String(error.message || error) };
      }
    }),
  );
  ranked.sort((a, b) => (a.ms ?? Number.MAX_SAFE_INTEGER) - (b.ms ?? Number.MAX_SAFE_INTEGER));
  return ranked;
}

function paintProbe(ranked) {
  for (const mirror of ranked) {
    const card = document.querySelector(`.cdn-mirror[data-mirror="${CSS.escape(mirror.id)}"]`);
    if (!card) continue;
    const slot = card.querySelector('[data-ms]');
    if (!slot) continue;
    if (mirror.ms == null) {
      slot.textContent = mirror.error || '不可用';
      slot.className = 'cdn-mirror__ms cdn-mirror__ms--bad';
    } else {
      slot.textContent = `${mirror.ms} ms`;
      slot.className = 'cdn-mirror__ms';
    }
    card.classList.toggle('cdn-mirror--best', ranked[0]?.id === mirror.id && mirror.ms != null);
    const existing = card.querySelector('.cdn-mirror__tag');
    if (existing) existing.remove();
    if (ranked[0]?.id === mirror.id && mirror.ms != null) {
      const tag = document.createElement('span');
      tag.className = 'cdn-mirror__tag';
      tag.textContent = '最快';
      card.appendChild(tag);
    }
  }
}

function wireProbe(flat) {
  const button = $('probe');
  if (!button) return;
  button.addEventListener('click', async () => {
    const line = $('probe-line');
    button.disabled = true;
    if (line) line.textContent = '正在并发探测各镜像…';
    try {
      const ranked = await probeMirrors(flat);
      paintProbe(ranked);
      const best = ranked.find((m) => m.ms != null);
      if (line) line.textContent = best ? `最快：${best.id}（${best.ms} ms）` : '所有镜像都不可达。';
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

  try {
    [art, mirrors] = await Promise.all([getJson(`${CDN}/cdn/v1/art.json`), getJson(`${CDN}/cdn/v1/mirrors.json`)]);
  } catch {
    source = 'snapshot';
    snapshot = await getJson(SNAPSHOT).catch(() => null);
    art = snapshot?.art || null;
    mirrors = snapshot?.mirrors || null;
  }

  const flat = mirrors?.flat || art?.art?.mirrors || [];
  renderStatus(art, source);
  renderMirrors(flat);
  renderPacks(mirrors?.packs || art?.art?.packs || []);
  renderDirs(snapshot?.dirs || [], snapshot?.totals || null);
  wireProbe(flat);
}

main().catch((error) => {
  const line = $('status-line');
  if (line) {
    line.textContent = `页面初始化失败：${error.message}`;
    line.classList.add('cdn-status--err');
  }
});
