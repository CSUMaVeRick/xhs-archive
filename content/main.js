/**
 * XHS Archive - 注入脚本（UI）
 * 默认折叠成右侧细长竖向工具栏；可在弹窗设置默认折叠/展开。
 * 数据抽取通过 MutationObserver / SPA 路由 自动进行；点击 📥 直接归档。
 */
(function () {
  'use strict';

  const X = () => window.__XHS_EXTRACT__;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 简洁 toast 提示（自动消失）
  function showToast(msg, kind) {
    let t = document.getElementById('xhs-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'xhs-toast';
      t.className = 'xhs-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'xhs-toast' + (kind ? ' ' + kind : '');
    t.style.display = 'block';
    clearTimeout(showToast._h);
    showToast._h = setTimeout(() => { t.style.display = 'none'; }, 3200);
  }

  let lastData = null;
  let panelOpen = false; // 是否展开详情面板

  // ---------- 归档（面板点击即手势，无需弹窗） ----------
  async function archiveCurrentNote() {
    const A = window.__XHS_ARCHIVE__;
    if (!A) { showToast('归档模块未加载', 'err'); return; }
    // 点归档时重新抽取一次，确保用到「当前」笔记（避免残留旧笔记）
    let d = lastData;
    try {
      const x = X();
      if (x) {
        const r = x.extract();
        if (r && r.data && (r.data.noteId || r.data.title)) d = r.data;
      }
    } catch (e) {}
    if (!d) { showToast('尚未抓到当前笔记', 'err'); return; }
    showToast('归档中...');
    try {
      const res = await A.archive(d);
      const videoMsg = d.hasVideo
        ? (res.videoCoverOnly ? (res.videoErr ? `，视频失败: ${res.videoErr}` : '，仅封面（未存视频）')
           : (res.videoOk ? '，视频已下载' : `，视频失败: ${res.videoErr || '未知'}`))
        : '';
      showToast(`完成 ✅ 图片${res.ok}张${videoMsg}`, 'ok');
    } catch (e) {
      showToast('页面内归档失败: ' + String(e && e.message || e) + '，改用弹窗...', 'err');
      try {
        await chrome.storage.local.set({ autoArchive: true });
        const r = await chrome.runtime.sendMessage({ type: 'openPopup' });
        if (!r || !r.ok) showToast('请点击右上角扩展图标归档', 'err');
      } catch (e2) {
        showToast('失败: ' + String(e2 && e2.message || e2), 'err');
      }
    }
  }

  // ---------- UI 容器 ----------
  function ensureUI() {
    let tb = document.getElementById('xhs-tb');
    if (!tb) {
      tb = document.createElement('div');
      tb.id = 'xhs-tb';
      tb.className = 'xhs-tb';
      tb.innerHTML = `
        <button class="xhs-tb-archive" title="归档当前笔记">📥</button>
        <button class="xhs-tb-toggle" title="展开 / 收起详情">⟨</button>
      `;
      tb.querySelector('.xhs-tb-archive').addEventListener('click', () => {
        archiveCurrentNote();
        tb.classList.add('xhs-tb-flash');
        setTimeout(() => tb.classList.remove('xhs-tb-flash'), 400);
      });
      tb.querySelector('.xhs-tb-toggle').addEventListener('click', () => {
        panelOpen = !panelOpen;
        setPanelVisible(panelOpen);
      });
      document.body.appendChild(tb);
    }

    let panel = document.getElementById('xhs-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'xhs-panel';
      panel.className = 'xhs-panel';
      document.body.appendChild(panel);
    }
    return { tb, panel };
  }

  function setPanelVisible(vis) {
    panelOpen = vis;
    const panel = document.getElementById('xhs-panel');
    const tb = document.getElementById('xhs-tb');
    if (panel) panel.style.display = vis ? '' : 'none';
    if (tb) tb.querySelector('.xhs-tb-toggle').textContent = vis ? '⟩' : '⟨';
    // 展开时用当前笔记重新渲染一次，避免显示的是旧笔记
    if (vis) {
      try {
        const x = X();
        const r = x ? x.extract() : null;
        if (r && r.data && (r.data.noteId || r.data.title)) renderPanel(r);
        else if (lastData) renderPanel({ data: lastData, report: {}, strategy: '' });
      } catch (e) {}
    }
  }

  // ---------- 渲染详情面板 ----------
  function renderPanel(result) {
    const { panel } = ensureUI();
    const data = result.data || {};
    const report = result.report || {};
    const diag = report.diagnostics || {};
    const rows = [
      ['标题', data.title || '—'],
      ['作者', (data.author && data.author.nickname) || '—'],
      ['发布时间', data.publishTime || '—'],
      ['话题标签', (data.tags && data.tags.length ? data.tags.join(' ') : '—')],
      ['图片', data.imageCount || 0 + '张'],
      ['视频', data.hasVideo ? '是' : '否'],
    ];
    const rowHtml = rows.map(([k, v]) => `<div class="xr-row"><span class="xr-k">${k}</span><span class="xr-v">${escapeHtml(String(v))}</span></div>`).join('');

    const diagHtml = [
      `URL: ${escapeHtml(diag.url || '')}`,
      `__INITIAL_STATE__: ${diag.hasInitialState ? '存在' : '不存在'} · API缓存: ${diag.apiCachedNotes} 个 · 命中: ${diag.apiHasCurrentNote ? '是' : '否'}`,
      `卡片字段: ${escapeHtml((diag.apiCardKeys || []).join(', ') || '无')}`,
      `原始video: ${escapeHtml(diag.videoPreview ? diag.videoPreview.slice(0, 200) : '无')}`,
    ].join('\n');
    const js = JSON.stringify(data, null, 2);

    const warnHtml = (report.warnings && report.warnings.length)
      ? `<div class="xr-warn">${report.warnings.map((w) => escapeHtml(w)).join('<br>')}</div>` : '';

    panel.innerHTML = `
      <div class="xr-head">
        <span class="xr-title">📕 XHS 归档</span>
        <button class="xr-close">×</button>
      </div>
      ${warnHtml}
      <div class="xr-body">${rowHtml}</div>
      <div class="xr-dl">
        <button class="xr-dlbtn xr-dl-archive">归档当前笔记</button>
        <span class="xr-dlstatus"></span>
      </div>
      <details class="xr-detail"><summary>调试信息（数据 / 诊断）</summary><pre>${escapeHtml(diagHtml)}</pre><pre>${escapeHtml(js)}</pre></details>
    `;

    panel.querySelector('.xr-close').addEventListener('click', () => setPanelVisible(false));
    panel.querySelector('.xr-dl-archive').addEventListener('click', () => archiveCurrentNote());
  }

  // ---------- 抽取 ----------
  let lastSig = '';
  function runExtract(force) {
    const x = X();
    if (!x) return;
    const visible = x.detectNoteVisible();
    const { tb } = ensureUI();
    if (tb) tb.style.display = visible ? 'block' : 'none';

    if (visible) {
      const result = x.extract();
      lastData = result.data;
      const sig = JSON.stringify(result.data) + '|' + result.strategy;
      if (force || sig !== lastSig) {
        lastSig = sig;
        if (panelOpen) renderPanel(result);
      }
      console.log('[XHS Archive] 抽取结果', result);
      try {
        chrome.storage.local.set({ currentNote: { data: result.data, report: result.report, ts: Date.now() } });
      } catch (e) {}
    }
  }

  function scheduleCheck() {
    let t = null;
    const fire = () => { if (t) clearTimeout(t); t = setTimeout(() => runExtract(false), 300); };
    return fire;
  }

  async function init() {
    // 默认折叠/展开由设置决定
    try {
      const r = await chrome.storage.local.get('panelMode');
      panelOpen = !(r && r.panelMode === 'collapsed');
    } catch (e) { panelOpen = false; }
    ensureUI();
    setPanelVisible(panelOpen);

    const fire = scheduleCheck();
    const mo = new MutationObserver(() => fire());
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-note-id', 'noteid', 'class'] });
    setTimeout(() => runExtract(false), 500);
    setInterval(() => runExtract(false), 2500);

    window.addEventListener('popstate', fire);
    const wrap = (fn) => function () { const ret = fn.apply(this, arguments); fire(); return ret; };
    try {
      history.pushState = wrap(history.pushState);
      history.replaceState = wrap(history.replaceState);
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
