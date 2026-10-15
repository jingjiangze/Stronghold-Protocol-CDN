// /stage 的前端：口令门 → GET /api/cdn/upload/stage → 一张扁平表。
//
// 这一页刻意和 /admin 的前端分家，不共用 admin.js：
//   * 体积：admin.js 画两棵可展开目录树（含筛选、收起、行内备注）；这里只有一张表，
//     读一次列一次，没有展开态要维护。合在一起会让「给 agent 读的轻页」跟着上传后台一起变重。
//   * 语义：/admin 那页的关键词是「上传」，这一页是「暂存区有什么」。共用一份脚本的话，
//     两边都要为对方的维护付 review 成本。
//   * 没有轮询：读一次是给人/脚本看一眼的，不是盯着上传进度看的界面；要追进度去 /admin。
//
// 仍然保留的两条硬规则（和 admin.js 同源）：
//   1. 口令只放 sessionStorage（关标签页就没了），不落浏览器持久存储 —— 这把钥匙能读上传方的键名与来源。
//   2. 键名、来源标识、说明都是上传方给的不可信输入，进 innerHTML 之前必须转义。
(() => {
  'use strict';

  function failBanner(text) {
    const host = document.getElementById('nav-status');
    if (host) { host.textContent = text; host.style.color = '#ff8a8a'; }
    const note = document.getElementById('gate-msg');
    if (note) { note.textContent = text; note.className = 'section-note err'; }
  }
  window.addEventListener('error', (event) => {
    failBanner(`页面脚本出错：${String(event.message || event.error || '未知错误').slice(0, 120)}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    failBanner(`请求失败：${String(event.reason && event.reason.message || event.reason || '未知').slice(0, 120)}`);
  });

  const KEY_STORE = 'sp.cdnAdminKey';
  const $ = (id) => document.getElementById(id);
  const key = () => sessionStorage.getItem(KEY_STORE) || '';

  const fmt = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return '—';
    if (x >= 1048576) return `${(x / 1048576).toFixed(1)} MiB`;
    if (x >= 1024) return `${(x / 1024).toFixed(1)} KiB`;
    return `${x} B`;
  };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const STATE_CN = {
    queued: '等发布',
    'verified-at-edge': '边缘已核对',
    'awaiting-commit': '只传了字节',
    'claim-unreadable': 'claim 读不到',
  };

  async function load() {
    $('status').textContent = '读取中…';
    let res;
    try {
      res = await fetch('/api/cdn/upload/stage', { headers: { 'x-admin-key': key() }, cache: 'no-store' });
    } catch (error) {
      $('status').textContent = '';
      failBanner(`读暂存区失败：网络请求没成功（${String(error.message || error).slice(0, 60)}）`);
      return;
    }
    if (res.status === 401) {
      sessionStorage.removeItem(KEY_STORE);
      $('stage').hidden = true;
      $('gate-msg').textContent = '口令不对';
      $('nav-status').textContent = '未进入';
      return;
    }
    const doc = await res.json().catch(() => null);
    if (!res.ok || !doc || doc.ok !== true) {
      $('status').textContent = '';
      failBanner(`读暂存区失败：${(doc && doc.error) || `HTTP ${res.status}`}`);
      return;
    }
    render(doc);
    $('nav-status').textContent = '在线';
  }

  function render(doc) {
    $('q-groups').textContent = String((doc.staging || []).length);
    $('q-pending').textContent = String(doc.pending || 0);
    $('q-awaiting').textContent = String(doc.awaitingCommit || 0);
    $('q-bytes').textContent = fmt(doc.bytes || 0);

    const tbody = $('rows').tBodies[0];
    tbody.textContent = '';
    const rows = doc.staging || [];
    if (!rows.length) {
      const tr = tbody.insertRow();
      const td = tr.insertCell();
      td.colSpan = 6;
      td.className = 'muted';
      td.textContent = '暂存区是空的（刚发布完，或还没传过东西）';
      $('status').textContent = '0 组';
      $('stage-who').textContent = doc.at ? `读取于 ${doc.at.replace('T', ' ').slice(0, 19)}` : '读的是桶里的事实';
      return;
    }
    for (const item of rows) {
      const tr = tbody.insertRow();
      const state = STATE_CN[item.state] || item.state || '—';
      const key = item.key || '(还未提交，没有目标键)';
      const size = item.size == null ? (item.stagedSize == null ? '—' : fmt(item.stagedSize)) : fmt(item.size);
      const sha = item.sha256 ? `${item.sha256.slice(0, 12)}…` : '—';
      const source = item.source || '—';
      const what = item.reason || item.what || '—';
      // 目标键是要能被复制的：整串放进 mono 单元格，不给链接 —— 链到对外地址会误导，
      // 因为这一行还没上线，那个地址上什么都没有。
      for (const [text, cls] of [[state, ''], [key, 'mono'], [size, 'num'], [sha, 'mono'], [source, ''], [what, '']]) {
        const td = tr.insertCell();
        if (cls) td.className = cls;
        td.textContent = text;
      }
    }
    $('status').textContent = `${rows.length} 组 · ${fmt(doc.bytes || 0)}`;
    $('stage-who').textContent = doc.at ? `读取于 ${doc.at.replace('T', ' ').slice(0, 19)}` : '读的是桶里的事实';
  }

  $('gate-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = $('key').value.trim();
    if (!value) { $('gate-msg').textContent = '先输入口令'; return; }
    sessionStorage.setItem(KEY_STORE, value);
    $('gate-msg').textContent = '读取中…';
    await load();
    // 成功时把「读取中…」清掉；失败时 load() 已经把原因写进去了。
    if ($('nav-status').textContent === '在线') {
      $('gate-msg').textContent = '';
      $('stage').hidden = false;
    }
  });

  $('filter').addEventListener('input', () => {
    const q = $('filter').value.trim().toLowerCase();
    for (const tr of $('rows').tBodies[0].rows) {
      tr.hidden = q ? !tr.textContent.toLowerCase().includes(q) : false;
    }
  });

  $('reload').addEventListener('click', load);

  if (key()) { $('key').value = key(); $('gate-form').requestSubmit(); }
})();
