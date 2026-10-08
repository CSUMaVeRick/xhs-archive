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
  let lastAuthorNotes = null;  // 最近一次在作者主页收集到的清单（只用于面板显示与落盘判断）
  let authorManifest = null;   // 已落盘的清单（含 archived 标记），供面板对账显示

  // ---------- 设置（弹窗里的开关 + 面板上的展开范围） ----------
  // 面板渲染是同步的，所以用内存缓存；storage 变化时同步刷新
  const settings = { collectComments: false, expandScope: '5' };

  function applySettings(r) {
    if (!r) return;
    const sch = window.XHS_SCHEMA;
    if ('collectComments' in r) settings.collectComments = !!r.collectComments;
    if ('expandScope' in r) {
      const v = String(r.expandScope || '');
      const ok = sch && sch.EXPAND_SCOPES ? sch.EXPAND_SCOPES.some((s) => s.value === v) : true;
      settings.expandScope = ok && v ? v : (sch ? sch.DEFAULT_EXPAND_SCOPE : '5');
    }
  }

  function initSettings() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get(['collectComments', 'expandScope'], (r) => applySettings(r));
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        const patch = {};
        if (changes.collectComments) patch.collectComments = changes.collectComments.newValue;
        if (changes.expandScope) patch.expandScope = changes.expandScope.newValue;
        applySettings(patch);
        if (panelOpen) setPanelVisible(true); // 开关一变，面板立刻反映
      });
    } catch (e) {
      // 忽略：非扩展环境
    }
  }

  // 检索页关键词：归档时供 metadata._source.keyword 回填（时效见 schema.js KEYWORD_HINT_TTL_MS）
  // 只记录、不拦截请求：完全不触碰 MAIN world。
  // SPA 会频繁 pushState/replaceState（滚动、开详情弹窗都会触发），
  // 而每次写都会刷新时间戳，导致下游把"数据变了"判定为真 —— 所以同一关键词短时间内不重复写。
  let lastHint = null;
  function captureKeywordHint() {
    try {
      if (!/\/search_result/.test(location.pathname)) return;
      const kw = new URLSearchParams(location.search).get('keyword');
      if (!kw) return;
      const now = Date.now();
      if (lastHint && lastHint.keyword === kw && now - lastHint.at < 60 * 1000) return;
      lastHint = { keyword: kw, pageUrl: location.href, at: now };
      chrome.storage.local.set({ keywordHint: lastHint });    } catch (e) {
      // 忽略：非扩展环境或 URL 异常
    }
  }

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
    // 数据完整性闸门：抓到的仍是上一篇时禁止归档，否则会把 A 的元数据写进 B 的目录
    if (d._extraction && d._extraction.noteIdMismatch) {
      showToast('数据与页面 noteId 不一致（抓到 ' + (d._extraction.pickedNoteId || '?') + '），请等 1-2 秒再试', 'err');
      return;
    }
    showToast('归档中...');
    try {
      const res = await A.archive(d);
      const videoMsg = d.hasVideo
        ? (res.videoCoverOnly ? (res.videoErr ? `，视频失败: ${res.videoErr}` : '，仅封面（未存视频）')
           : (res.videoOk ? '，视频已下载' : `，视频失败: ${res.videoErr || '未知'}`))
        : '';
      showToast(`完成 ✅ 图片${res.ok}张${videoMsg}`, 'ok');
      loadAuthorManifest(true); // 归档完刷新对账（徽标与面板上的"还差"会立刻跟着变）
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
  // 我们的 UI 是插进页面里的兄弟节点：鼠标事件必须就地掐断。
  // 否则会冒泡到页面自己的"点击空白处关闭笔记弹窗"逻辑上——关我们的面板会把
  // 小红书的笔记一起关掉，笔记没了，工具栏随即自动隐藏，表现就是"面板一关插件就消失"。
  function stopEventLeak(el) {
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel']) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
  }

  function ensureUI() {
    let tb = document.getElementById('xhs-tb');
    if (!tb) {
      tb = document.createElement('div');
      tb.id = 'xhs-tb';
      tb.className = 'xhs-tb';
      tb.innerHTML = `
        <button class="xhs-tb-archive" title="归档当前笔记">📥</button>
        <button class="xhs-tb-badge" title="清单对账"></button>
        <button class="xhs-tb-toggle" title="展开 / 收起详情">⟨</button>
      `;
      tb.querySelector('.xhs-tb-archive').addEventListener('click', () => {
        archiveCurrentNote();
        tb.classList.add('xhs-tb-flash');
        setTimeout(() => tb.classList.remove('xhs-tb-flash'), 400);
      });
      // 徽标点一下 = 展开面板看"还差哪几篇"（顺便把清单重读一次，数字是新的）
      tb.querySelector('.xhs-tb-badge').addEventListener('click', () => {
        loadAuthorManifest(true);
        setPanelVisible(true);
      });
      tb.querySelector('.xhs-tb-toggle').addEventListener('click', () => {
        panelOpen = !panelOpen;
        setPanelVisible(panelOpen);
      });
      document.body.appendChild(tb);
      stopEventLeak(tb);
    }

    let panel = document.getElementById('xhs-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'xhs-panel';
      panel.className = 'xhs-panel';
      document.body.appendChild(panel);
      stopEventLeak(panel);
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
      loadAuthorManifest(false); // 在作者主页上顺手把清单读进来，对账行才有数
    }
  }

  // ---------- 渲染详情面板 ----------
  function renderPanel(result) {
    const { panel } = ensureUI();
    const data = result.data || {};
    const report = result.report || {};
    const diag = report.diagnostics || {};
    // 面板会随数据变化整体重渲染，不记住展开状态就会"点开即收起"
    const prevDetails = panel.querySelector('details.xr-detail');
    const detailsWasOpen = !!(prevDetails && prevDetails.open);
    const authorCount = cachedAuthorCount();
    const onProfilePage = !!profilePageUserId();
    const rows = [
      ['标题', data.title || '—'],
      ['作者', ((data.author && data.author.nickname) || '—')
        + (data._author && data._author.fansCount != null ? ` · 粉丝 ${data._author.fansCount}` : '')],
      ['发布时间', data.publishTime || '—'],
      ['话题标签', (data.tags && data.tags.length ? data.tags.join(' ') : '—')],
      ['图片', data.imageCount || 0 + '张'],
      ['视频', data.hasVideo ? '是' : '否'],
      ['来源', sourceText(data)],
      ['抽取来源', data._extraction ? data._extraction.strategy : '—'],
      ['schema', data._schemaVersion ? `v${data._schemaVersion} / 插件 ${data._pluginVersion || '?'}` : '—'],
    ];
    // 评论：把"采到几条 / 共几条 / 是否完整"直接摆出来，配合「展开评论」判断该不该再展开
    const cmMeta = data._comments && data._comments.meta;
    if (cmMeta) {
      const detail = cmMeta.declaredTotal != null
        ? `（共 ${cmMeta.declaredTotal}${cmMeta.complete ? ' · 完整' : ' · 未完整'}）`
        : (cmMeta.complete ? '（完整）' : '（未完整）');
      rows.push(['评论', `${cmMeta.capturedCount} 条${detail}`]);
    }

    // 在作者主页时先给出"当前作者"这一行：点保存之前就能看出解析到没解析到
    let reconcileHtml = '';
    try {
      if (onProfilePage) {
        const rec = X().helpers.readProfileFromDom();
        if (rec) {
          rows.unshift(['当前作者', `${rec.nickname || '?'} · 粉丝 ${rec.fansCount == null ? '未知' : rec.fansCount} · 关注 ${rec.followsCount == null ? '未知' : rec.followsCount}${rec.ipLocation ? ' · ' + rec.ipLocation : ''}`]);
        }
        // 清单对账：平台声明几篇 / 清单见过几篇 / 已归档几篇 / 还差哪几篇
        const an = lastAuthorNotes;
        if (an && an.count) {
          const declared = (an.declaredNoteCount == null) ? '平台未声明' : (an.declaredNoteCount + ' 篇');
          rows.unshift(['笔记清单', `平台 ${declared} · 清单 ${an.count} 篇（${an.source === 'bridge' ? '接口' : '页面'}）`]);
        }
        reconcileHtml = renderReconcileBlock();
      }
    } catch (e) { /* 解析失败就少显示一行，不影响其它信息 */ }

    const rowHtml = rows.map(([k, v]) => `<div class="xr-row"><span class="xr-k">${k}</span><span class="xr-v">${escapeHtml(String(v))}</span></div>`).join('');

    const diagHtml = [
      `URL: ${escapeHtml(diag.url || '')}`,
      `页面状态桥接: ${(diag.stateNoteIds || []).length} 篇 · API缓存: ${diag.apiCachedNotes} 个 · 命中: ${diag.apiHasCurrentNote ? '是' : '否'}`,
      `卡片字段: ${escapeHtml((diag.apiCardKeys || []).join(', ') || '无')}`,
      `原始video: ${escapeHtml(diag.videoPreview ? diag.videoPreview.slice(0, 200) : '无')}`,
    ].join('\n');
    const js = JSON.stringify(data, null, 2);

    const warnHtml = (report.warnings && report.warnings.length)
      ? `<div class="xr-warn">${report.warnings.map((w) => escapeHtml(w)).join('<br>')}</div>` : '';
    const mismatchWarn = (data._extraction && data._extraction.noteIdMismatch)
      ? `<div class="xr-warn">⚠ 数据与页面 noteId 不一致（${escapeHtml(String(data._extraction.pickedNoteId || '?'))} ≠ ${escapeHtml(String(data._extraction.urlNoteId || '?'))}），已禁止归档</div>`
      : '';
    // 只报"本次真正没抓到的"：结构性缺失（本插件不采集/平台不给）另算，否则告警恒亮看不出重点
    const S = window.XHS_SCHEMA || null;
    const structural = (S && S.STRUCTURAL_MISSING) || [];
    const missAll = Array.isArray(data._fieldsMissing) ? data._fieldsMissing : [];
    const missUnexpected = missAll.filter((f) => structural.indexOf(f) < 0);
    const missWarn = missUnexpected.length
      ? `<div class="xr-warn">本次未抓到: ${escapeHtml(missUnexpected.join(', '))}<br><span style="opacity:.7">另有 ${missAll.length - missUnexpected.length} 项属结构性缺失（本插件不采集/平台不给），完整清单见 metadata._fieldsMissing</span></div>`
      : '';

    panel.innerHTML = `
      <div class="xr-head">
        <span class="xr-title">📕 XHS 归档</span>
        <button class="xr-close">×</button>
      </div>
      ${warnHtml}
      ${mismatchWarn}
      ${missWarn}
      <div class="xr-body">${rowHtml}</div>
      ${reconcileHtml}
      ${settings.collectComments ? `<div class="xr-expand">
        <button class="xr-dlbtn xr-expand-btn">${expandRunning ? '停止展开' : '展开评论'}</button>
        <select class="xr-expand-scope" title="展开多少条回复">
          ${(window.XHS_SCHEMA && window.XHS_SCHEMA.EXPAND_SCOPES ? window.XHS_SCHEMA.EXPAND_SCOPES : [{ value: '5', label: '前 5 条回复' }])
            .map((s) => `<option value="${s.value}"${s.value === settings.expandScope ? ' selected' : ''}>${s.label}</option>`).join('')}
        </select>
        <span class="xr-expand-status"></span>
      </div>` : ''}
      <div class="xr-dl">
        <button class="xr-dlbtn xr-dl-archive">归档当前笔记</button>
        <button class="xr-dlbtn xr-dl-author">${onProfilePage ? '保存当前作者' : `保存已缓存作者 (${authorCount})`}</button>
        <button class="xr-dlbtn xr-copy">复制调试信息</button>
        <span class="xr-dlstatus"></span>
      </div>
      <details class="xr-detail"${detailsWasOpen ? ' open' : ''}><summary>调试信息（数据 / 诊断）</summary><pre>${escapeHtml(diagHtml)}</pre><pre>${escapeHtml(js)}</pre></details>
    `;

    panel.querySelector('.xr-close').addEventListener('click', () => setPanelVisible(false));
    panel.querySelector('.xr-dl-archive').addEventListener('click', () => archiveCurrentNote());
    panel.querySelector('.xr-dl-author').addEventListener('click', () => {
      if (profilePageUserId()) saveCurrentAuthor();
      else archiveCachedAuthors();
    });
    panel.querySelector('.xr-copy').addEventListener('click', () => copyDebugInfo(result));
    const expandBtn = panel.querySelector('.xr-expand-btn');
    if (expandBtn) {
      expandBtn.addEventListener('click', () => toggleExpandComments(panel));
      const scopeSel = panel.querySelector('.xr-expand-scope');
      if (scopeSel) {
        scopeSel.addEventListener('change', () => {
          settings.expandScope = scopeSel.value;
          try { chrome.storage.local.set({ expandScope: scopeSel.value }); } catch (e) {}
        });
      }
    }
  }

  // ---------- 保存作者（authors.json） ----------
  // 在作者主页：直接保存"当前正在看的作者"（DOM 解析，不依赖接口是否被拦到）。
  // 其他页面：退回把缓存里逛过的作者一起落盘。
  // 当前是否"在看某个作者"：URL 在主页，或笔记弹窗盖在主页之上（见 extract.js 的 resolveProfileUserId）
  function profilePageUserId() {
    try {
      const x = X();
      return (x && x.helpers && x.helpers.resolveProfileUserId && x.helpers.resolveProfileUserId()) || '';
    } catch (e) {
      return '';
    }
  }

  function cachedAuthorCount() {
    try {
      const x = X();
      const c = x && x.helpers && x.helpers.syncCache;
      return c ? Object.keys(c.authors || {}).length : 0;
    } catch (e) {
      return 0;
    }
  }

  function selfUserId() {
    try {
      const x = X();
      return (x && x.helpers && x.helpers.syncCache && x.helpers.syncCache.selfUserId) || '';
    } catch (e) {
      return '';
    }
  }

  async function saveCurrentAuthor() {
    const A = window.__XHS_ARCHIVE__;
    const x = X();
    if (!A || !A.archiveAuthors || !x || !x.helpers) { showToast('模块未加载', 'err'); return; }
    let rec = null;
    try {
      rec = x.helpers.flushCurrentAuthor && x.helpers.flushCurrentAuthor();
    } catch (e) {
      showToast('解析作者信息出错: ' + String(e && e.message || e), 'err');
      return;
    }
    if (!rec) { showToast('没能从页面解析出作者信息', 'err'); return; }
    if (selfUserId() && rec.userId === selfUserId()) {
      showToast('这是你自己登录的账号，不作为作者样本保存', 'err');
      return;
    }
    showToast('保存作者中...');
    try {
      const res = await A.archiveAuthors([rec], selfUserId());
      showToast(
        `已保存作者「${rec.nickname || rec.userId}」✅`
        + `（粉丝 ${rec.fansCount == null ? '未知' : rec.fansCount} / 关注 ${rec.followsCount == null ? '未知' : rec.followsCount}）→ ${res.file}`,
        'ok'
      );
      if (panelOpen) setPanelVisible(true);
    } catch (e) {
      showToast('保存作者失败: ' + String(e && e.message || e), 'err');
    }
  }

  async function archiveCachedAuthors() {
    const A = window.__XHS_ARCHIVE__;
    if (!A || !A.archiveAuthors) { showToast('归档模块未加载', 'err'); return; }
    const x = X();
    if (!x || !x.helpers || !x.helpers.flushAuthorCache) { showToast('抽取模块未加载', 'err'); return; }
    let records = [];
    try {
      records = x.helpers.flushAuthorCache() || [];
    } catch (e) {
      showToast('读取作者缓存失败: ' + String(e && e.message || e), 'err');
      return;
    }
    if (!records.length) {
      showToast('缓存里还没有作者资料：打开一次作者主页就会记下（纯被动）', 'err');
      return;
    }
    const selfId = (x.helpers.syncCache && x.helpers.syncCache.selfUserId) || '';
    showToast('保存作者中...');
    try {
      const res = await A.archiveAuthors(records, selfId);
      showToast(
        `已保存 ${res.total} 位作者 ✅（新增 ${res.added} / 变更 ${res.changed} / 确认 ${res.confirmed}）`
        + (res.removedSelf ? '，并清掉了误收的本人记录' : '')
        + ` → ${res.file}`,
        'ok'
      );
      if (panelOpen) setPanelVisible(true); // 刷新按钮上的计数
    } catch (e) {
      showToast('保存作者失败: ' + String(e && e.message || e), 'err');
    }
  }

  // 统计数解析不上时，需要真实 DOM 才能写出正确的选择器。
  // 这里采样三类线索：候选节点的 outerHTML、图标雪碧图的 use id、以及 aria-label。
  // 只为诊断存在，不进任何写盘数据。
  function collectDomSamples() {
    const out = { candidates: [], iconIds: [], ariaLabels: [] };
    try {
      const nodes = document.querySelectorAll(
        '[class*="like"],[class*="collect"],[class*="comment"],[class*="share"],[class*="count"],[class*="interact"],[aria-label]'
      );
      for (const el of nodes) {
        if (out.candidates.length >= 8) break;
        const html = el.outerHTML || '';
        out.candidates.push(html.slice(0, 500));
      }
    } catch (e) { /* 忽略 */ }
    try {
      const seen = new Set();
      for (const u of document.querySelectorAll('svg use')) {
        const id = u.getAttribute('xlink:href') || u.getAttribute('href') || '';
        if (id && !seen.has(id)) { seen.add(id); out.iconIds.push(id); }
        if (out.iconIds.length >= 30) break;
      }
    } catch (e) { /* 忽略 */ }
    try {
      const seen = new Set();
      for (const el of document.querySelectorAll('[aria-label]')) {
        const v = el.getAttribute('aria-label') || '';
        if (v && !seen.has(v)) { seen.add(v); out.ariaLabels.push(v); }
        if (out.ariaLabels.length >= 30) break;
      }
    } catch (e) { /* 忽略 */ }
    return out;
  }

  // 调试信息是折叠的、没法直接选中复制，所以单独给一个按钮
  async function copyDebugInfo(result) {
    // 作者资料的原始载荷放在这里：字段名是跨版本容错匹配的，对不上时需要原始响应来校准
    const bridge = document.getElementById('xhs-user-profile');
    const cache = (window.__XHS_EXTRACT__ && window.__XHS_EXTRACT__.helpers
      && window.__XHS_EXTRACT__.helpers.syncCache) || null;
    const payload = {
      ts: new Date().toISOString(),
      url: location.href,
      strategy: result && result.strategy,
      report: (result && result.report) || null,
      data: (result && result.data) || null,
      authorProfileRaw: bridge ? String(bridge.textContent || '').slice(0, 4000) : '',
      authorCacheSize: cache ? Object.keys(cache.authors || {}).length : 0,
      domSamples: collectDomSamples(),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      showToast('调试信息已复制到剪贴板', 'ok');
    } catch (e) {
      showToast('复制失败: ' + String(e && e.message || e), 'err');
    }
  }

  // 来源一行：抽样框架（从哪进来的）+ 仅搜索下才有的检索词
  function sourceText(data) {
    const s = (data && (data._source || data._search)) || {};
    const label = s.label || (s.type === 'search' ? '搜索' : (s.type || '未知'));
    if (s.keyword) return `${label} · ${s.keyword}`;
    return label;
  }

  // ---------- 展开评论 ----------
  // 这是插件里**唯一一处会替用户点击页面**的功能。守住四条：
  //  ① 默认关闭（弹窗里显式开启才出现按钮）② 逐篇由人点击触发 ③ 可限条数、可随时停止
  //  ④ 有硬上限（次数 + 时间），不会失控；点击之间带随机延迟，不做无间隔连点
  let expandRunning = false;
  let expandStop = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 找「展开 N 条回复」；只保留最内层的那个（外层容器的文本里也含这句话）
  function findExpandButtons() {
    const sch = window.XHS_SCHEMA;
    const root = document.getElementById('noteContainer') || document;
    let nodes = [];
    try { nodes = root.querySelectorAll('div, span, button, a'); } catch (e) { return []; }
    const hits = [];
    for (const el of nodes) {
      const text = (el.textContent || '').replace(/\s+/g, '');
      const ok = sch && sch.isExpandLabel ? sch.isExpandLabel(text) : /^展开\d+条回复$/.test(text);
      if (!ok) continue;
      if (hits.some((h) => h.contains(el))) continue;
      hits.push(el);
    }
    return hits;
  }

  function expandStatus(panel, msg) {
    const el = panel.querySelector('.xr-expand-status');
    if (el) el.textContent = msg || '';
  }

  function capturedCommentCount() {
    try {
      const x = X();
      const cm = x && x.helpers && x.helpers.readComments && x.helpers.readComments();
      return cm && Array.isArray(cm.list) ? cm.list.length : 0;
    } catch (e) {
      return 0;
    }
  }

  async function toggleExpandComments(panel) {
    if (expandRunning) { expandStop = true; expandStatus(panel, '正在停止…'); return; }
    const sch = window.XHS_SCHEMA || {};
    const scopeSel = panel.querySelector('.xr-expand-scope');
    const scope = (scopeSel && scopeSel.value) || settings.expandScope;
    const limit = sch.expandLimitOf ? sch.expandLimitOf(scope, sch.EXPAND_MAX_CLICKS) : 5;
    const maxMs = sch.EXPAND_MAX_MS || 180000;
    const scopeLabel = (sch.EXPAND_SCOPES || []).filter((s) => s.value === scope).map((s) => s.label)[0] || scope;

    expandRunning = true;
    expandStop = false;
    const btn = panel.querySelector('.xr-expand-btn');
    if (btn) btn.textContent = '停止展开';
    const started = Date.now();
    const beforeCount = capturedCommentCount();
    let clicks = 0;
    try {
      while (!expandStop) {
        if (clicks >= limit) {
          const left = findExpandButtons().length;
          expandStatus(panel, `已达「${scopeLabel}」· 评论 ${capturedCommentCount()} 条${left ? ` · 还有 ${left} 处未展开（想继续请选「全部展开」）` : ''}`);
          break;
        }
        if (Date.now() - started > maxMs) { expandStatus(panel, '已达时间上限，已停止'); break; }
        const btns = findExpandButtons();
        if (!btns.length) {
          // 更深一层的回复可能是异步加载的：给一段宽限时间再下结论，否则会误判"没了"
          let waited = 0;
          while (!expandStop && waited < 5000) {
            await sleep(1000);
            waited += 1000;
            if (findExpandButtons().length) break;
          }
          if (expandStop) break;
          if (!findExpandButtons().length) break;
          continue;
        }
        const el = btns[0];
        const before = btns.length;
        expandStatus(panel, `展开中… 本轮剩余 ${before} 处 · 已采到 ${capturedCommentCount()} 条`);
        try { el.click(); } catch (e) { /* 忽略 */ }
        clicks++;
        await sleep(1500 + Math.random() * 800);
        // 数量没减少 → 点到的不是真正可点的元素，向上找一层再试一次
        if (findExpandButtons().length >= before) {
          const up = el.parentElement;
          if (up && up.click) { try { up.click(); } catch (e) { /* 忽略 */ } await sleep(1200); }
        }
      }
      const afterCount = capturedCommentCount();
      if (expandStop) {
        expandStatus(panel, `已停止 · 展开 ${clicks} 处 · 评论 ${beforeCount} → ${afterCount} 条`);
      } else if (clicks === 0) {
        // 实测：更深的回复加载慢于宽限期，按钮过一会儿才出现——所以只说"此刻没找到"，
        // 不说"没有了"（那是替平台下结论，会假报完整），并提示可以再点一次。
        expandStatus(panel, `此刻没找到「展开」按钮（当前评论 ${afterCount} 条）· 更深的回复是异步加载的，稍等再点一次可能还有`);
      } else {
        const left = findExpandButtons().length;
        expandStatus(panel, `展开 ${clicks} 处 · 评论 ${beforeCount} → ${afterCount} 条${left ? ` · 还有 ${left} 处未展开` : ''}`);
      }
    } finally {
      expandRunning = false;
      expandStop = false;
      const b = panel.querySelector('.xr-expand-btn');
      if (b) b.textContent = '展开评论';
    }
  }

  // ---------- 抽取 ----------
  let lastSig = '';
  let lastLoggedKey = '';

  // 诊断：数据变了就报出是哪几个顶层字段在变（日志/重渲染刷屏时一眼定位）
  function changedKeys(prev, next) {
    if (!prev) return ['(first)'];
    const keys = new Set(Object.keys(prev).concat(Object.keys(next)));
    const out = [];
    for (const k of keys) {
      if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) out.push(k);
    }
    return out;
  }

  // 日志只在"有新信息"时打：首次抽取、换了笔记、换了抽取路径、出现告警或错标。
  // 每次数据微调都打会把控制台刷满，而完整数据随时可从面板「复制调试信息」取。
  function logKeyOf(result) {
    const ex = result.data._extraction || {};
    return [
      result.strategy,
      result.data.noteId || '',
      ex.noteIdMismatch ? 'mismatch' : '',
      (result.report.warnings || []).join(';').slice(0, 60),
    ].join('|');
  }

  // 注意：这里没有 force 参数。面板自己的刷新走 renderPanel，抽取只在数据真的变化时才动。
  // ---------- 作者主页：笔记清单采集与落盘（对账，不做自动归档） ----------
  // 只回答"这位作者平台上有几篇 / 我们见过哪几篇 / 还差哪几篇"。
  // 落盘写 `_meta/authors/<userId>.json`，管理页拿它跟已归档的 metadata 对账。
  // 说明：清单里的链接（xsec_token）会过期，只是路标 —— 详情仍由人工用 📥 逐篇归档。
  let authorNotesSavedSig = '';
  let authorNotesBusy = false;

  function collectAuthorNotesTick() {
    const x = X();
    const A = window.__XHS_ARCHIVE__;
    if (!x || !x.helpers || !x.helpers.collectAuthorNotes || !A || !A.saveAuthorNotes) return;
    if (authorNotesBusy) return;
    let data = null;
    try { data = x.helpers.collectAuthorNotes(); } catch (e) { return; }
    if (!data || !data.userId || !data.count) return;
    lastAuthorNotes = data;
    // 先用手上这份清单让徽标/面板立刻有数（归档标记稍后由落盘读回补上），
    // 否则"第一次进某个作者主页"就永远没有数字 —— 因为下面那次落盘还没完成。
    const S = window.XHS_SCHEMA || null;
    if (S && S.mergeAuthorNotes) {
      const base = (authorManifest && authorManifestFor === data.userId) ? authorManifest : null;
      const merged = S.mergeAuthorNotes(base, data.notes, data.capturedAt);
      authorManifest = Object.assign({}, base || {}, {
        author: Object.assign({}, (base && base.author) || {}, {
          userId: data.userId,
          declaredNoteCount: data.declaredNoteCount == null
            ? ((base && base.author && base.author.declaredNoteCount) || null)
            : data.declaredNoteCount,
        }),
        coverage: {
          source: data.source,
          hasMore: data.hasMore,
          cursorLast: data.cursorLast,
          capturedAt: (base && base.coverage && base.coverage.capturedAt) || data.capturedAt,
          inMemory: true,
        },
        notes: Object.values(merged.notes),
      });
      authorManifestFor = data.userId;
      updateToolbarBadge();
    }
    // 内容没变就不重复写盘（这个 tick 每 2.5 秒跑一次，HOME 页 DOM 会一直抖）
    const sig = [
      data.userId, data.count, data.source,
      data.declaredNoteCount == null ? '' : data.declaredNoteCount,
      data.hasMore === null ? '' : data.hasMore,
      data.cursorLast || '',
    ].join('|');
    if (sig === authorNotesSavedSig) return;
    authorNotesSavedSig = sig;

    authorNotesBusy = true;
    let authorInfo = null;
    try { authorInfo = x.helpers.flushCurrentAuthor ? x.helpers.flushCurrentAuthor() : null; } catch (e) { /* 忽略 */ }
    Promise.resolve()
      .then(() => A.saveAuthorNotes(data, authorInfo))
      .then((res) => {
        if (res && res.ok) {
          console.log('[XHS Archive] 作者清单已写入', res.file, '共', res.total, '条（新增', res.added, '）');
          loadAuthorManifest(true);   // ⚠ 必须**写完之后**再读回：同一 tick 里读会读到"文件还不存在"
        }
      })
      .catch((e) => { authorNotesSavedSig = ''; console.log('[XHS Archive] 作者清单落盘失败', e && e.message); })
      .then(() => { authorNotesBusy = false; });
  }

  function runExtract() {
    const x = X();
    if (!x) return;
    // 作者资料要独立于"当前页面像不像笔记页"：作者主页上真不一定判定为可见，
    // 若把捕获挂在 extract() 里，作者页那一轮就永远收不到资料。函数内部有内容未变即返回的短路。
    try { if (x.helpers && x.helpers.collectProfiles) x.helpers.collectProfiles(); } catch (e) {}
    try { if (x.helpers && x.helpers.collectSearchHint) x.helpers.collectSearchHint(); } catch (e) {}
    // 作者主页的笔记清单：只做"对账数据"的采集与落盘，不自动打开任何笔记。
    // 内部有内容未变即返回的短路，且只在作者主页上跑。
    collectAuthorNotesTick();
    const visible = x.detectNoteVisible();
    const { tb } = ensureUI();
    // 面板开着就不隐藏工具栏：正在进行交互时让它消失是最容易被当成 bug 的行为。
    // display 置空串而不是 'block'，否则会把 .xhs-tb 的 flex 竖排覆盖成横排。
    if (tb) tb.style.display = (visible || panelOpen) ? '' : 'none';
    // 折叠态的小进度徽标（作者主页上有清单时出现）
    updateToolbarBadge(true); // 带日志：徽标为什么不出现，控制台里能直接看到

    if (visible) {
      const result = x.extract();
      const prevData = lastData;
      lastData = result.data;
      // 签名忽略易变字段（见 schema.js 的 VOLATILE_*）：否则每次抽取都不同，
      // 面板会每几百毫秒重渲染，调试信息永远打不开。
      const S2 = window.XHS_SCHEMA;
      const sig = (S2 && S2.stableSig)
        ? S2.stableSig(result.data, result.strategy)
        : JSON.stringify(result.data) + '|' + result.strategy;
      if (sig !== lastSig) {
        lastSig = sig;
        if (panelOpen) renderPanel(result);
        const logKey = logKeyOf(result);
        if (logKey !== lastLoggedKey) {
          lastLoggedKey = logKey;
          console.log('[XHS Archive] 抽取结果', result, '变化字段:', changedKeys(prevData, result.data));
        }
        try {
          chrome.storage.local.set({ currentNote: { data: result.data, report: result.report, ts: Date.now() } });
        } catch (e) {}
      }
    }
  }

  // ---------- 作者主页：清单对账（面板里直接看到"还差哪几篇"） ----------
  // 数据来自 `_meta/authors/<userId>.json`：清单在打开主页时落盘，`archived` 标记由每次归档顺手刷新。
  // 全程只读本地文件，不构造任何请求；失败（没配目录 / 没权限 / 还没清单）都安静降级为一行提示。
  function renderReconcileBlock() {
    const S = window.XHS_SCHEMA || null;
    const userId = profilePageUserId();
    const m = userId ? authorManifest : null;
    if (!userId) return '';
    if (!m) {
      return `<div class="xr-warn xr-recon">清单对账：还没有这位作者的清单 —— 往下滚一屏（插件会顺手记下来），再点开本面板。</div>`;
    }
    const rec = (S && S.buildAuthorReconcile)
      ? S.buildAuthorReconcile(m, (S.archivedIdsOfManifest ? S.archivedIdsOfManifest(m) : {}))
      : null;
    if (!rec || !rec.listed) return '';
    const declared = rec.declared == null ? '平台未声明' : (rec.declared + ' 篇');
    const head = `清单对账：平台 ${declared} · 清单 ${rec.listed} 篇 · 已归档 ${rec.archived} 篇`;
    const tail = rec.missing
      ? `<b>还差 ${rec.missing} 篇</b>（下面列出来了，逐篇点开用 📥 归档）`
      : `<b>清单已全部归档</b>`;
    const when = rec.capturedAt ? String(rec.capturedAt).slice(0, 16).replace('T', ' ') : '—';
    const missList = rec.notArchived.slice(0, 12).map((n) => {
      const title = n.title ? String(n.title).slice(0, 24) : '(无标题)';
      return `${escapeHtml(title)} <span style="opacity:.6">${escapeHtml(String(n.noteId || '').slice(0, 8))}…</span>`;
    }).join('<br>');
    const more = rec.missing > 12 ? `<br><span style="opacity:.6">…还有 ${rec.missing - 12} 篇（管理页作者视图可看全）</span>` : '';
    const stale = (Date.now() - (Date.parse(rec.capturedAt || '') || 0)) > 30 * 60 * 1000;
    return `<div class="xr-warn xr-recon">${head} · ${tail}<br>`
      + `<span style="opacity:.75">清单抓取于 ${escapeHtml(when)}（${rec.source === 'bridge' ? '接口' : '页面'}）；`
      + `清单里的链接会过期${stale ? '，已经放了一会儿了，建议回主页滚一次刷新' : ''}</span>`
      + (rec.missing ? `<div class="xr-recon-list">${missList}${more}</div>` : '')
      + `</div>`;
  }

  // 打开主页时把清单读进来（只读本地文件；拿不到就留空，面板会提示"往下滚一屏"）
  let authorManifestFor = '';
  async function loadAuthorManifest(force) {
    const A = window.__XHS_ARCHIVE__;
    const userId = profilePageUserId();
    if (!userId) { authorManifest = null; authorManifestFor = ''; return; }
    if (!A || !A.readAuthorNotes) { authorManifest = null; return; }
    if (!force && authorManifestFor === userId && authorManifest) return; // 同一个作者只读一次
    const had = authorManifest;
    try {
      authorManifest = await A.readAuthorNotes(userId, !!force);
    } catch (e) {
      authorManifest = null;
    }
    authorManifestFor = userId;
    updateToolbarBadge(); // 折叠态那个小徽标跟着刷新
    // 读到了新内容且面板开着 → 重画一次，让"还差哪几篇"立刻出现
    if (panelOpen && JSON.stringify(authorManifest || null) !== JSON.stringify(had || null)) {
      try {
        const r = X().extract();
        if (r && r.data) renderPanel(r);
      } catch (e) { /* 忽略 */ }
    }
  }

  // 折叠态的小进度徽标：只在作者主页、且清单有数据时出现。
  // 文案刻意短：徽标宽度只有 34px，`7/18` 比"已归档 7/18"读得快。
  let badgeDiagLast = '';
  function badgeDiag(msg) {
    if (msg === badgeDiagLast) return; // 每 300ms 一次的抽取循环，别把控制台刷满
    badgeDiagLast = msg;
    console.log('[XHS Archive] 徽标：' + msg);
  }

  function updateToolbarBadge(diag) {
    try {
      const tb = document.getElementById('xhs-tb');
      if (!tb) return;
      const el = tb.querySelector('.xhs-tb-badge');
      if (!el) {
        if (diag) badgeDiag('工具栏里没有 .xhs-tb-badge 元素（扩展需要重新加载）');
        return;
      }
      const hide = (why) => {
        el.style.display = 'none';
        if (diag) badgeDiag('不显示 —— ' + why);
      };
      const S = window.XHS_SCHEMA || null;
      const userId = profilePageUserId();
      const m = userId ? authorManifest : null;
      if (!userId) return hide('当前页面不是作者主页');
      if (!S || !S.buildAuthorReconcile || !S.archivedIdsOfManifest) return hide('schema 缺对账函数（扩展需要重新加载）');
      if (!m) return hide('还没有这位作者的清单（往下滚一屏，让页面自己请求作品列表）');
      const rec = S.buildAuthorReconcile(m, S.archivedIdsOfManifest(m));
      if (!rec.listed) return hide('清单是空的（接口/页面都没抓到条目）');
      // ⚠ 这里必须写具体的 display 值，不能写空串：空串 = 移除 inline 样式、退回 CSS，
      // 而 `.xhs-tb-badge` 的 CSS 默认就是 display:none —— 于是"设了内容却永远看不见"（踩过）。
      el.style.display = 'inline-block';
      el.textContent = rec.archived + '/' + rec.listed;
      el.classList.toggle('is-done', rec.missing === 0);
      el.title = '清单对账：平台 ' + (rec.declared == null ? '未声明' : rec.declared + ' 篇')
        + ' · 清单 ' + rec.listed + ' 篇 · 已归档 ' + rec.archived + ' 篇'
        + (rec.missing ? ' · 还差 ' + rec.missing + ' 篇（点一下看是哪几篇）' : ' · 清单已全部归档');
      if (diag) badgeDiag(el.textContent + '（平台声明 ' + rec.declared + ' · 来源 ' + rec.source + '）');
    } catch (e) { /* 徽标是附加显示，失败不影响其它功能 */ }
  }

  function scheduleCheck() {
    let t = null;
    const fire = () => { if (t) clearTimeout(t); t = setTimeout(() => runExtract(), 300); };
    return fire;
  }

  async function init() {
    // 默认折叠/展开由设置决定。
    // ⚠ 判据必须是"**明确**选了展开才展开"：默认值只声明在 popup.html（collapsed）与 README，
    // 而 popup 只在用户手动改过时才写 storage。之前写成 `!(mode === 'collapsed')`，
    // 于是"从没设置过"= 展开 —— 每次打开小红书面板都自己弹出来（用户实测报障）。
    try {
      const r = await chrome.storage.local.get('panelMode');
      panelOpen = !!(r && r.panelMode === 'expanded');
    } catch (e) { panelOpen = false; }
    initSettings();
    ensureUI();
    setPanelVisible(panelOpen);

    const fire = scheduleCheck();
    const mo = new MutationObserver(() => fire());
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-note-id', 'noteid', 'class'] });
    setTimeout(() => runExtract(), 500);
    setInterval(() => runExtract(), 2500);

    window.addEventListener('popstate', () => { captureKeywordHint(); fire(); });
    const wrap = (fn) => function () { const ret = fn.apply(this, arguments); captureKeywordHint(); fire(); return ret; };
    try {
      history.pushState = wrap(history.pushState);
      history.replaceState = wrap(history.replaceState);
    } catch (e) {}
    captureKeywordHint();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
