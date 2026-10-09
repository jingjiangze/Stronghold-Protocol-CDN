// 上传后台的前端：口令门 → 选文件 → 浏览器算 sha256 → PUT /api/cdn/upload/put → 看状态。
//
// 三条刻意的设计：
//   1. 口令只放 sessionStorage（关标签页就没了），不是 localStorage —— 这把钥匙能往玩家下载的
//      域名里写字节，不该在一台公用机器上活过下一次开机。
//   2. 摘要在浏览器算，服务端与发布机各算一遍做三方核对；三份不一致就不上线。
//   3. 页面上没有任何「覆盖」「删除」按钮 —— 后端也没有这两个入口，不是藏起来了。
(() => {
  'use strict';

  const KEY_STORE = 'sp.cdnAdminKey';
  const MAX_BYTES = 64 * 1024 * 1024;
  const $ = (id) => document.getElementById(id);
  const key = () => sessionStorage.getItem(KEY_STORE) || '';

  const fmt = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return '—';
    if (x >= 1073741824) return `${(x / 1073741824).toFixed(2)} GiB`;
    if (x >= 1048576) return `${(x / 1048576).toFixed(1)} MiB`;
    if (x >= 1024) return `${(x / 1024).toFixed(1)} KiB`;
    return `${x} B`;
  };

  const line = (text, kind) => {
    const el = $('line');
    el.textContent = text;
    el.className = `section-note${kind === 'err' ? ' err' : ''}`;
  };

  const setNav = (text) => { $('nav-status').textContent = text; };

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { 'x-admin-key': key(), ...(options.headers || {}) },
    });
    let doc = null;
    try { doc = await res.json(); } catch { /* 非 JSON 一律按失败处理 */ }
    return { status: res.status, doc };
  }

  // 与后端同一套键名规则，客户端先挡一遍，省一次往返；真正的判定在服务端。
  const sanitizeName = (name) =>
    String(name)
      .replace(/[\uFFFD\u0000-\u001F]/g, '')
      .replace(/\\/g, '/')
      .replace(/\s+/g, '_')
      .replace(/^\.+/, '')
      .replace(/\/+/g, '/');

  const filesFromInput = () => {
    const picked = [];
    for (const input of [$('files'), $('dir')]) {
      for (const f of input.files || []) {
        const rel = f.webkitRelativePath ? sanitizeName(f.webkitRelativePath) : sanitizeName(f.name);
        picked.push({ file: f, rel });
      }
    }
    return picked;
  };

  async function sha256Of(file) {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function renderPlan(rows) {
    const tbody = $('queue-table').tBodies[0];
    tbody.textContent = '';
    if (!rows.length) {
      const tr = tbody.insertRow();
      const td = tr.insertCell();
      td.colSpan = 5;
      td.className = 'muted';
      td.textContent = '还没选文件';
      return;
    }
    for (const r of rows) {
      const tr = tbody.insertRow();
      for (const [text, cls] of [[r.rel, ''], [fmt(r.size), 'num'], [r.sha256 ? `${r.sha256.slice(0, 16)}…` : '…', 'mono'], [r.state, ''], [r.note || '', '']]) {
        const td = tr.insertCell();
        if (cls) td.className = cls;
        td.textContent = text;
      }
    }
  }

  function renderStatus(doc) {
    const staged = (doc.staging || []);
    $('q-staged').textContent = String(staged.length);
    $('q-pending').textContent = String(doc.pending || 0);
    $('q-published').textContent = String((doc.log || []).length);

    const sbody = $('staging-table').tBodies[0];
    sbody.textContent = '';
    if (!staged.length) {
      const tr = sbody.insertRow();
      const td = tr.insertCell();
      td.colSpan = 5;
      td.className = 'muted';
      td.textContent = '暂存区是空的';
    }
    const STATE_CN = { queued: '等发布', 'verified-at-edge': '边缘已核对', 'awaiting-commit': '只传了字节、没提交' };
    for (const item of staged) {
      const tr = sbody.insertRow();
      tr.insertCell().textContent = item.key || item.stagingKey || item.id;
      const size = tr.insertCell();
      size.className = 'num';
      size.textContent = fmt(item.size || item.stagedSize);
      tr.insertCell().textContent = STATE_CN[item.state] || item.state;
      tr.insertCell().textContent = item.source || '—';
      tr.insertCell().textContent = item.claimedAt ? item.claimedAt.replace('T', ' ').slice(0, 19) : '—';
    }

    const lbody = $('log-table').tBodies[0];
    lbody.textContent = '';
    const logs = doc.log || [];
    if (!logs.length) {
      const tr = lbody.insertRow();
      const td = tr.insertCell();
      td.colSpan = 4;
      td.className = 'muted';
      td.textContent = '还没有发布记录（第一次上线之后才会有）';
    }
    for (const entry of logs) {
      const tr = lbody.insertRow();
      tr.insertCell().textContent = (entry.at || '').replace('T', ' ').slice(0, 19);
      tr.insertCell().textContent = entry.key || '';
      const size = tr.insertCell();
      size.className = 'num';
      size.textContent = fmt(entry.size);
      tr.insertCell().textContent = entry.source || '—';
    }
  }

  async function refresh() {
    const { status, doc } = await api('/api/cdn/upload/status');
    if (status === 401) {
      $('gate-msg').textContent = doc && doc.error ? doc.error : '口令不对';
      sessionStorage.removeItem(KEY_STORE);
      $('upload').hidden = true;
      $('todo').hidden = true;
      setNav('未进入');
      return;
    }
    if (!doc || doc.ok !== true) {
      setNav('状态读不到');
      line(`读状态失败：${(doc && doc.error) || `HTTP ${status}`}`, 'err');
      return;
    }
    renderStatus(doc);
    setNav('在线');
  }

  async function prepare() {
    const prefix = $('prefix').value.trim();
    if (!/^(assets|fonts|packs)\/[A-Za-z0-9._/-]*$/.test(prefix + 'x')) {
      line('目标目录必须是 assets/ fonts/ packs/ 之下', 'err');
      return;
    }
    const source = $('source').value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,59}$/.test(source)) {
      line('来源标识需要是 2–60 位字母数字 . _ -（它会进 hosted.json 当分组 id）', 'err');
      return;
    }
    const rows = filesFromInput().map((r) => ({ ...r, size: r.file.size, sha256: '', state: '算摘要…', note: '' }));
    if (!rows.length) { line('还没选文件', 'err'); return; }
    renderPlan(rows);

    for (const row of rows) {
      if (row.size > MAX_BYTES) {
        row.state = '太大';
        row.note = `超过 ${MAX_BYTES / 1048576} MiB，请用 agent 通道`;
        renderPlan(rows);
        continue;
      }
      try {
        row.sha256 = await sha256Of(row.file);
      } catch (error) {
        row.state = '摘要失败';
        row.note = String(error.message || error).slice(0, 60);
        renderPlan(rows);
        continue;
      }
      renderPlan(rows);
    }
    window.__plan = rows.filter((r) => r.sha256 && r.state !== '太大');
    line(`准备好了 ${window.__plan.length} 个文件，点「计算摘要并上传」再点一次即开始上传`);
  }

  async function upload() {
    if (!window.__plan || !window.__plan.length) { await prepare(); }
    const plan = window.__plan || [];
    if (!plan.length) { line('没有可上传的文件', 'err'); return; }
    const prefix = $('prefix').value.trim().replace(/\/+$/, '');
    const source = $('source').value.trim();
    const what = $('what').value.trim();

    for (const row of plan) {
      row.state = '上传中…';
      renderPlan(plan);
      const targetKey = `${prefix}/${row.rel}`;
      try {
        const res = await fetch('/api/cdn/upload/put', {
          method: 'PUT',
          headers: {
            'x-admin-key': key(),
            'x-sp-key': targetKey,
            'x-sp-sha256': row.sha256,
            'x-sp-size': String(row.size),
            'x-sp-source': source,
            'x-sp-what': what,
            'content-type': 'application/octet-stream',
          },
          body: row.file,
        });
        const doc = await res.json().catch(() => ({}));
        if (res.ok && doc.ok) {
          row.state = '已进暂存';
          row.note = doc.id;
        } else {
          row.state = '被拒';
          row.note = (doc && doc.error) || `HTTP ${res.status}`;
        }
      } catch (error) {
        row.state = '失败';
        row.note = String(error.message || error).slice(0, 80);
      }
      renderPlan(plan);
    }
    await refresh();
    line(`已提交 ${plan.length} 个，等发布轮核对上线（约 20 分钟内，或点「催一次发布」）`);
  }

  async function kick() {
    const { status, doc } = await api('/api/cdn/upload/kick', { method: 'POST' });
    if (status === 202 || (doc && doc.ok)) {
      line('已叫起一次发布，约 1–2 分钟后再刷新');
    } else {
      line(`催不动：${(doc && (doc.error || doc.message)) || `HTTP ${status}`}`, 'err');
    }
    setTimeout(refresh, 90000);
  }

  $('gate-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = $('key').value.trim();
    if (!value) { $('gate-msg').textContent = '先输入口令'; return; }
    sessionStorage.setItem(KEY_STORE, value);
    $('gate-msg').textContent = '校验中…';
    const { status, doc } = await api('/api/cdn/upload/status');
    if (status === 401) {
      sessionStorage.removeItem(KEY_STORE);
      $('gate-msg').textContent = (doc && doc.error) || '口令不对';
      return;
    }
    if (!doc || doc.ok !== true) {
      $('gate-msg').textContent = `后端没准备好：${(doc && doc.error) || `HTTP ${status}`}（多半是 Pages secret 还没配）`;
      return;
    }
    $('gate-msg').textContent = '';
    $('upload').hidden = false;
    $('todo').hidden = false;
    renderStatus(doc);
    setNav('在线');
  });

  $('go').addEventListener('click', upload);
  $('files').addEventListener('change', () => { prepare(); });
  $('dir').addEventListener('change', () => { prepare(); });
  $('kick').addEventListener('click', kick);
  $('refresh').addEventListener('click', () => { refresh(); });

  // 已经开着标签页的人不用重打口令：sessionStorage 里有就先验一次。
  if (key()) { $('key').value = key(); $('gate-form').requestSubmit(); }
  setInterval(() => { if (!$('upload').hidden) refresh(); }, 120000);
})();
