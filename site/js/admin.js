// 上传后台的前端：口令门 → 选文件 → 浏览器算 sha256 → PUT /api/cdn/upload/put → 看状态。
//
// 四条刻意的设计：
//   1. 口令只放 sessionStorage（关标签页就没了），不是 localStorage —— 这把钥匙能往玩家下载的
//      域名里写字节，不该在一台公用机器上活过下一次开机。
//   2. 摘要在浏览器算，服务端与发布机各算一遍做三方核对；三份不一致就不上线。
//   3. 页面上没有任何「覆盖」「删除」按钮，而且**这是刻意的、不是没做**：删除确实存在，但只走
//      agent 通道（CLI 的 --purge / --rm），因为一次误点就会把对外正被引用的字节拿掉。
//      这里没有按钮可点，就没有误点的可能。
//   4. 「复制接入说明（含密钥）」由服务端拼（GET /api/cdn/upload/agent-doc）：文档路径不写死，
//      取站点文档里最新的一份描述上传通道的文档，密钥由边缘替换进占位符。页面自己拼也能做，
//      但「复制的说明里少了钥匙」是静默失败 —— 粘出来的文本看起来完全正常。
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

  /**
   * 转义要进 innerHTML 的文本。
   *
   * 键名、来源标识都是上传方给的 —— 也就是不可信输入。它们进模板字符串拼 HTML，不转义就等于
   * 让投稿者在这个域上放标签。首页那份只处理自家键表，这里必须转。
   */
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---- 目录树（与首页同一套标记与手感） --------------------------------------------------------
  //
  // 首页那份是惰性构建的，因为它有 1.2 万个文件；这里的两棵树是「暂存区」和「最近发布 20 条」，
  // 量级完全不同，所以一次画完，但用的 class 与交互（▸ 展开、行可点、筛选拍平成文件清单）保持一致：
  // 同一套观感，不为了复用把首页那棵改成能跑的通用件。

  const countFiles = (node) => node.files.length + [...node.dirs.values()].reduce((s, c) => s + countFiles(c), 0);

  function treeRow(node, depth, isDir) {
    const row = document.createElement('div');
    row.className = 'tree__row' + (isDir ? ' tree__row--dir' : '');
    row.style.paddingLeft = `${depth * 14 + 8}px`;
    row.setAttribute('role', 'treeitem');
    if (isDir) {
      row.setAttribute('aria-expanded', 'false');
      row.innerHTML =
        `<span class="tree__caret">▸</span><span class="tree__name mono">${esc(node.name)}/</span>` +
        `<span class="tree__meta">${countFiles(node)} 个 · ${fmt(node.bytes)}</span>`;
    } else {
      const label = node.url
        ? `<a class="tree__name mono" href="${esc(node.url)}" target="_blank" rel="noopener">${esc(node.name)}</a>`
        : `<span class="tree__name mono">${esc(node.name)}</span>`;
      row.innerHTML =
        `<span class="tree__caret"></span>${label}` +
        (node.tag ? `<span class="chip chip--mod" title="${esc(node.note || '')}">${esc(node.tag)}</span>` : '') +
        `<span class="tree__meta">${node.size == null ? '—' : fmt(node.size)}</span>`;
    }
    return row;
  }

  /** {path, size, url, ...} 的扁平清单 → 嵌套模型。 */
  function buildTree(rows) {
    const root = { name: '', path: '', dirs: new Map(), files: [], bytes: 0 };
    for (const r of rows) {
      const parts = String(r.path || '').split('/').filter(Boolean);
      const name = parts.pop();
      if (!name) continue;
      let node = root;
      let acc = '';
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: acc, dirs: new Map(), files: [], bytes: 0 });
        node = node.dirs.get(part);
      }
      node.files.push({ ...r, name });
      node.bytes += r.size || 0;
    }
    const rollUp = (node) => {
      for (const child of node.dirs.values()) node.bytes += rollUp(child);
      return node.bytes;
    };
    rollUp(root);
    return root;
  }

  function renderTree(host, filterEl, statusEl, collapseEl, rows, emptyText) {
    if (!host) return;
    const draw = () => {
      host.textContent = '';
      if (!rows.length) {
        host.innerHTML = `<p class="muted">${esc(emptyText)}</p>`;
        if (statusEl) statusEl.textContent = '';
        return;
      }
      const model = buildTree(rows);
      // 文件行后面跟上「说明」：必须可见，不能只藏在 chip 的 tooltip 里。
      // awaiting-commit 行的 note 就是「没提交的原因」，后台一眼要能看到，不用悬停。
      const appendFile = (file, atDepth) => {
        const row = treeRow(file, atDepth, false);
        container.appendChild(row);
        if (file.note) {
          const noteEl = document.createElement('div');
          noteEl.className = 'tree__note';
          noteEl.textContent = file.note;
          noteEl.style.paddingLeft = `${atDepth * 14 + 8}px`;
          container.appendChild(noteEl);
        }
      };
      const paint = (node, container, depth) => {
        for (const child of [...node.dirs.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
          const row = treeRow(child, depth, true);
          const kids = document.createElement('div');
          kids.className = 'tree__children';
          kids.hidden = true;
          paint(child, kids, depth + 1);
          for (const f of child.files.sort((a, b) => (a.name < b.name ? -1 : 1))) {
            kids.appendChild(treeRow({ ...f, path: `${child.path}/${f.name}` }, depth + 1, false));
          }
          const toggle = () => {
            kids.hidden = !kids.hidden;
            row.setAttribute('aria-expanded', String(!kids.hidden));
            row.querySelector('.tree__caret').textContent = kids.hidden ? '▸' : '▾';
          };
          row.addEventListener('click', (e) => { if (!e.target.closest('a')) toggle(); });
          row.tabIndex = 0;
          row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
          });
          container.appendChild(row);
          container.appendChild(kids);
        }
        for (const f of node.files.sort((a, b) => (a.name < b.name ? -1 : 1))) {
          appendFile({ ...f, path: node.path ? `${node.path}/${f.name}` : f.name }, depth);
        }
      };
      paint(model, host, 0);
      if (statusEl) statusEl.textContent = `${rows.length} 个 · ${fmt(rows.reduce((s, r) => s + (r.size || 0), 0))}`;
    };

    if (filterEl) {
      let timer = null;
      filterEl.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const q = filterEl.value.trim().toLowerCase();
          if (!q) { draw(); return; }
          // 筛选结果直接列出来，不套目录：问的是「这个文件在哪」，不是「这棵树长什么样」。
          const shown = rows.filter((r) => String(r.path).toLowerCase().includes(q))
            .sort((a, b) => String(a.path).localeCompare(String(b.path)));
          host.textContent = '';
          for (const r of shown) host.appendChild(treeRow({ ...r, name: r.path }, 0, false));
          if (!shown.length) host.innerHTML = '<p class="muted">没有匹配的路径</p>';
          if (statusEl) statusEl.textContent = `${shown.length} / ${rows.length} 个匹配`;
        }, 120);
      });
    }
    if (collapseEl) {
      collapseEl.addEventListener('click', () => { if (filterEl) filterEl.value = ''; draw(); });
    }
    draw();
  }

  // ---- 接入说明 ------------------------------------------------------------------------------

  let agentDoc = null;

  function setCopyEnabled() {
    const btn = $('copy-agent');
    if (btn) btn.disabled = !key();
  }

  async function fetchAgentDoc() {
    const res = await fetch('/api/cdn/upload/agent-doc', { headers: { 'x-admin-key': key() }, cache: 'no-store' });
    const doc = await res.json().catch(() => null);
    if (!res.ok || !doc || doc.ok !== true) throw new Error((doc && doc.error) || `HTTP ${res.status}`);
    agentDoc = doc;
    showDocNote();
    return doc;
  }

  /** 只把「这份说明是哪一份」显示出来，不复制。进入后台时用。 */
  async function peekAgentDoc() {
    if (!key()) return;
    try {
      await fetchAgentDoc();
    } catch (error) {
      const el = $('doc-note');
      if (el) el.textContent = `取接入说明失败：${String(error.message || error).slice(0, 80)}`;
    }
  }

  async function copyAgentDoc() {
    const box = $('copy-msg');
    if (!key()) { if (box) box.textContent = '先输入口令再复制'; return; }
    if (box) box.textContent = '取接入说明…';
    try {
      const doc = await fetchAgentDoc();
      // 复制的是**含密钥的正文**，不是链接：调用方拿到就能干活。
      await copyText(doc.text, doc.injected ? '接入说明（已含本次密钥）' : '接入说明（⚠ 未含密钥）');
    } catch (error) {
      if (box) box.textContent = `取不到接入说明：${String(error.message || error).slice(0, 80)}`;
    }
  }

  /** 说清「这份说明是哪来的」——路径与挑选理由都来自服务端，不是页面猜的。 */
  function showDocNote() {
    const el = $('doc-note');
    if (!el || !agentDoc) return;
    el.textContent = `接入说明 = ${agentDoc.path}${agentDoc.injected ? '（已含本次密钥）' : '（未含密钥）'}`;
    if (agentDoc.why) el.textContent += ` · ${agentDoc.why}`;
  }

  function renderStatus(doc) {
    const staged = (doc.staging || []);
    $('q-staged').textContent = String(staged.length);
    $('q-pending').textContent = String(doc.pending || 0);
    $('q-published').textContent = String((doc.log || []).filter((l) => !l.removedAt).length);

    const STATE_CN = { queued: '等发布', 'verified-at-edge': '边缘已核对', 'awaiting-commit': '只传了字节、没提交' };
    // 按目标键成树：那才是这些字节上线之后的位置。还没提交的只有暂存键，就用它。
    const stageRows = staged.map((item) => ({
      path: item.key || item.stagingKey || item.id,
      size: item.size || item.stagedSize || 0,
      url: item.url || null,
      tag: STATE_CN[item.state] || item.state,
      // 树节点只显示一条 note：把「没提交的原因」也带进去，让 awaiting-commit 不再是无理由一行字。
      // 重复不是这一态的成因（重复在 begin/commit 时就以 409 当场拒了），所以原因只说「缺 claim / 中断」。
      note:
        item.state === 'awaiting-commit'
          ? (item.reason || '选中的字节还在暂存区，没点提交，发布轮不会碰它')
          : `来源 ${item.source || '—'}${item.claimedAt ? ` · ${item.claimedAt.replace('T', ' ').slice(0, 19)}` : ''}`,
    }));
    renderTree(
      $('stage-tree'), $('stage-filter'), $('stage-status'), $('stage-collapse'),
      stageRows, '暂存区是空的（刚发布完，或还没传过东西）',
    );

    const logs = doc.log || [];
    const pendingRemoval = new Set((doc.removals || []).map((r) => r.key));
    const logRows = logs.map((entry) => ({
      path: entry.key || '',
      size: entry.size,
      url: entry.url || null,
      tag: entry.removedAt ? `已下线 ${entry.removedAt.slice(0, 10)}` : pendingRemoval.has(entry.key) ? '撤销排队中' : null,
      note: [(entry.at || '').replace('T', ' ').slice(0, 19), entry.source ? `来源 ${entry.source}` : ''].filter(Boolean).join(' · '),
    }));
    renderTree(
      $('log-tree'), $('log-filter'), $('log-status'), $('log-collapse'),
      logRows, '还没有发布记录（第一次上线之后才会有）',
    );
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

  $('copy-agent').addEventListener('click', copyAgentDoc);
  setCopyEnabled();

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
      setCopyEnabled();
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
    setCopyEnabled();
    // 顺手把「这份说明是哪一份」显示出来：它由服务端挑，页面不该让人猜。
    peekAgentDoc();
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
