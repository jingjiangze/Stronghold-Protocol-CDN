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
  // 最后一次读到的 status 载荷。点「下线」后要就地改一行，不能等下一次刷新才给反馈。
  let lastDoc = null;
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
    const init = { ...options, headers: { 'x-admin-key': key(), ...(options.headers || {}) } };
    // 对象要自己序列化：fetch 不会替你 JSON.stringify，传对象会被转成字符串 "[object Object]"，
    // 后端只能回 400「请求体不是合法 JSON」—— 表现就是"点了下线没反应"（2026-10-10 实测）。
    if (init.body && typeof init.body !== 'string' && !(init.body instanceof Blob) && !(init.body instanceof ArrayBuffer)) {
      init.body = JSON.stringify(init.body);
      init.headers['content-type'] = 'application/json';
    }
    const res = await fetch(path, init);
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

  function cellLink(row, text, href) {
    const td = row.insertCell();
    if (!href) {
      td.textContent = text;
      return td;
    }
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = text;
    a.title = href;
    td.appendChild(a);
    return td;
  }

  function actionButton(row, label, title, handler) {
    const td = row.insertCell();
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'button button-secondary';
    b.style.padding = '2px 10px';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', handler);
    td.appendChild(b);
    return td;
  }

  async function purgeStaging(item) {
    if (!window.confirm(`清掉暂存区这一组？\n${item.stagingKey || item.id}\n\n这些字节还没上线，删掉不影响任何对外地址。`)) return;
    const { status, doc } = await api(`/api/cdn/upload/staging?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    if (doc && doc.ok) {
      line(`已清掉 ${doc.deleted} 个暂存对象，回收 ${fmt(doc.freed)}`);
      await refresh();
    } else {
      // 失败就别再刷一遍把提示盖掉 —— 那正是"点了没反应"的来源。
      line(`清理失败：${(doc && doc.error) || `HTTP ${status}（响应不是 JSON）`}`, 'err');
    }
  }

  async function removePublished(entry) {
    if (!entry.key) return;
    if (!window.confirm(`提交下线这个文件？\n${entry.key}\n\n发布轮会先核对「不在上游素材清单、且没有任何线上清单引用」才真删；被引用的会拒绝并写明原因。`)) return;
    const { status, doc } = await api('/api/cdn/upload/remove', { method: 'POST', body: { key: entry.key, reason: '后台手动下线' } });
    if (status === 202 || (doc && doc.ok)) {
      // 就地先标一行，让点击立刻有反馈；真实状态下一次刷新覆盖。
      entry.pendingRemoval = true;
      if (lastDoc) renderStatus(lastDoc);
      line(doc && doc.dispatched === false
        ? '撤销已入队，但叫不动发布轮（后台没配 GH_DISPATCH_TOKEN）—— 等下一次定时兜底'
        : '撤销已入队并已叫起发布轮，约 1–2 分钟后这个键就该 404');
    } else {
      line(`撤销被拒：${(doc && doc.error) || `HTTP ${status}（响应不是 JSON）`}`, 'err');
    }
  }

  function renderStatus(doc) {
    lastDoc = doc;
    const staged = (doc.staging || []);
    $('q-staged').textContent = String(staged.length);
    $('q-pending').textContent = String(doc.pending || 0);
    $('q-published').textContent = String((doc.log || []).filter((l) => !l.removedAt).length);

    const sbody = $('staging-table').tBodies[0];
    sbody.textContent = '';
    if (!staged.length) {
      const tr = sbody.insertRow();
      const td = tr.insertCell();
      td.colSpan = 6;
      td.className = 'muted';
      td.textContent = '暂存区是空的';
    }
    const STATE_CN = { queued: '等发布', 'verified-at-edge': '边缘已核对', 'awaiting-commit': '只传了字节、没提交' };
    for (const item of staged) {
      const tr = sbody.insertRow();
      cellLink(tr, item.key || item.stagingKey || item.id, item.url);
      const size = tr.insertCell();
      size.className = 'num';
      size.textContent = fmt(item.size || item.stagedSize);
      tr.insertCell().textContent = STATE_CN[item.state] || item.state;
      tr.insertCell().textContent = item.source || '—';
      tr.insertCell().textContent = item.claimedAt ? item.claimedAt.replace('T', ' ').slice(0, 19) : '—';
      actionButton(tr, '清暂存', '删掉这一组还没上线的字节（立即生效）', () => purgeStaging(item));
    }

    const lbody = $('log-table').tBodies[0];
    lbody.textContent = '';
    const logs = doc.log || [];
    const pendingRemoval = new Set((doc.removals || []).map((r) => r.key));
    if (!logs.length) {
      const tr = lbody.insertRow();
      const td = tr.insertCell();
      td.colSpan = 5;
      td.className = 'muted';
      td.textContent = '还没有发布记录（第一次上线之后才会有）';
    }
    for (const entry of logs) {
      const tr = lbody.insertRow();
      tr.insertCell().textContent = (entry.at || '').replace('T', ' ').slice(0, 19);
      cellLink(tr, entry.key || '', entry.url);
      const size = tr.insertCell();
      size.className = 'num';
      size.textContent = fmt(entry.size);
      tr.insertCell().textContent = entry.source || '—';
      if (entry.removedAt) {
        const td = tr.insertCell();
        td.textContent = `已下线 ${entry.removedAt.slice(0, 10)}`;
      } else if (pendingRemoval.has(entry.key) || entry.pendingRemoval) {
        const td = tr.insertCell();
        td.textContent = '撤销排队中';
      } else {
        actionButton(tr, '下线', '提交撤销请求（发布轮核对无引用后才真删）', () => removePublished(entry));
      }
    }
    // 撤销排队中的条目已经在上面按 key 标出来了；被拒的请求由发布轮直接丢弃并记在 Actions 日志里。
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
      // 元数据进查询串：HTTP 头只允许 ISO-8859-1，中文说明放头里会让 fetch 直接抛异常。
      const qs = new URLSearchParams({ key: targetKey, sha256: row.sha256, size: String(row.size), source, what });
      try {
        const res = await fetch(`/api/cdn/upload/put?${qs}`, {
          method: 'PUT',
          headers: {
            'x-admin-key': key(),
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

  async function copyText(text, label) {
    const box = $('copy-msg');
    try {
      await navigator.clipboard.writeText(text);
      box.textContent = `已复制${label}`;
    } catch {
      // 剪贴板 API 在非安全上下文或被拒时会抛；退回到一次性的选中复制。
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      box.textContent = ok ? `已复制${label}` : `复制失败，请手动选中：${text}`;
    }
    setTimeout(() => { box.textContent = ''; }, 4000);
  }

  $('copy-doc').addEventListener('click', () => copyText(`${location.origin}/docs/agent-upload.md`, '接入说明链接'));
  $('copy-key').addEventListener('click', () => {
    if (!key()) { $('gate-msg').textContent = '先进入再复制'; return; }
    copyText(key(), '直连密钥');
  });

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
