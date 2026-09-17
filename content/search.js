/**
 * XHS Archive - 搜索结果页粗糙采集（隔离 world）
 *
 * 职责边界（见 docs/DESIGN-search-hits.md）：
 *  - 这里只做"滚动 + 采集 + 缓冲"：每次滚动触发一页请求，把 MAIN world 交接过来的
 *    有序批次去重、编号、写进 chrome.storage.local 的分片缓冲
 *  - 落盘不在这里。写文件由 popup 负责（用户选定），所以弹窗关掉不会中断采集；
 *    反过来说，只要 storage 里还有没落盘的分片，popup 打开就会接着写
 *  - 不构造任何请求：滚动是用页面自己的懒加载机制触发它本来就要发的请求
 */
(function () {
  'use strict';
  if (window.__XHS_SEARCH_CAPTURE__) return;

  const S = () => window.XHS_SCHEMA || null;
  const BRIDGE = 'xhs-search-hits';
  const ACK = 'xhs-search-hits-ack';
  const PROGRESS_KEY = 'searchProgress';
  const ADOPT_WINDOW_MS = 10 * 60 * 1000; // 只认这段时间内抓到的批次（免得把上一轮检索的页 1 当成这一轮）
  const PRUNE_AGE_MS = 24 * 3600 * 1000;  // 超过这个时间还没落盘的分片清掉，避免无上限堆积

  let state = null;      // 本次采集的会话状态
  let running = false;
  let stopRequested = false;
  let stopReason = '';
  let bar = null;

  function iso() { return new Date().toISOString(); }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function pad(n, w) {
    let s = String(n);
    while (s.length < (w || 4)) s = '0' + s;
    return s;
  }

  // ---------- 跨 world 交接 ----------
  function readBridge() {
    try {
      const node = document.getElementById(BRIDGE);
      if (!node || !node.textContent) return { batches: [], dropped: 0 };
      const j = JSON.parse(node.textContent);
      return { batches: Array.isArray(j.batches) ? j.batches : [], dropped: j.dropped || 0 };
    } catch (e) {
      return { batches: [], dropped: 0 };
    }
  }

  function writeAck(seq) {
    try {
      let node = document.getElementById(ACK);
      if (!node) {
        node = document.createElement('div');
        node.id = ACK;
        node.style.display = 'none';
        document.documentElement.appendChild(node);
      }
      node.textContent = JSON.stringify({ consumed: seq, at: Date.now() });
    } catch (e) { /* 忽略 */ }
  }

  // ---------- storage ----------
  function chunkKey(sid, i) { return 'searchChunk:' + sid + ':' + pad(i); }
  function sessionKey(sid) { return 'searchSession:' + sid; }

  async function putProgress(extra) {
    const s = state;
    if (!s) return;
    const progress = Object.assign({
      sessionId: s.sessionId,
      active: running,
      startedAt: s.startedAt,
      endedAt: s.endedAt || null,
      rounds: s.rounds,
      roundsDone: s.roundsDone,
      intervalMs: s.intervalMs,
      hitCount: s.hitCount,
      noteCount: s.noteCount,
      duplicateCount: s.duplicates.length,
      stopReason: s.stopReason || null,
      keyword: s.keyword || '',
      droppedBatches: s.droppedBatches,
      updatedAt: iso(),
    }, extra || {});
    try { await chrome.storage.local.set({ [PROGRESS_KEY]: progress }); } catch (e) { /* 忽略 */ }
  }

  async function putSessionHeader() {
    const s = state;
    if (!s) return;
    const sch = S();
    const header = {
      _type: 'session',
      schemaVersion: (sch && sch.SEARCH_SCHEMA_VERSION) || 1,
      pluginVersion: (sch && sch.pluginVersion && sch.pluginVersion()) || '',
      sessionId: s.sessionId,
      searchId: s.searchId || '',
      keyword: s.keyword || '',
      filters: s.filters || null,
      filtersSource: s.filters ? 'request_body' : 'absent',
      filtersLabel: (sch && sch.filterLabelOf) ? sch.filterLabelOf(s.filters) : '',
      sort: s.sort == null ? null : s.sort,
      noteType: s.noteType == null ? null : s.noteType,
      sortOrderSource: s.sortSource || null, // request_body | absent | legacy_body
      startedAt: s.startedAt,
      endedAt: s.endedAt || null,
      pages: { all: s.pages.slice(), first: s.pages.length ? Math.min.apply(null, s.pages) : null, last: s.pages.length ? Math.max.apply(null, s.pages) : null },
      scroll: { requested: s.rounds, done: s.roundsDone, intervalMs: s.intervalMs, stoppedBy: s.stopReason || null, limits: { rounds: null } },
      coverage: { hitCount: s.hitCount, noteCount: s.noteCount, duplicateCount: s.duplicates.length, hasMore: s.hasMore, complete: false, droppedBatches: s.droppedBatches },
      duplicates: s.duplicates.slice(0, 200), // 只留前 200 条，够审计重复程度
      cover: { ok: 0, fail: 0 },              // 由 popup 落盘时更新
      _note: 'rank 是本批次内按到达顺序的累计位次，与 page/indexInPage 一起可回溯；cover 计数在落盘时补写',
    };
    try { await chrome.storage.local.set({ [sessionKey(s.sessionId)]: header }); } catch (e) { /* 忽略 */ }
  }

  // 采集开始前清掉过期分片，避免 storage 无上限堆积
  async function pruneOld() {
    try {
      const all = await chrome.storage.local.get(null);
      const stale = [];
      const now = Date.now();
      for (const k of Object.keys(all)) {
        if (k.indexOf('searchSession:') !== 0) continue;
        const h = all[k];
        const t = h && h.startedAt ? Date.parse(h.startedAt) : 0;
        if (t && now - t > PRUNE_AGE_MS) stale.push(h.sessionId);
      }
      if (!stale.length) return;
      const keys = Object.keys(all).filter((k) => stale.some((sid) => k.indexOf(':' + sid) > 0 || k === 'searchSession:' + sid));
      if (keys.length) await chrome.storage.local.remove(keys);
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 采集 ----------
  function newSession(rounds, intervalMs) {
    return {
      sessionId: 'srch_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      startedAt: iso(),
      endedAt: null,
      rounds: rounds,
      intervalMs: intervalMs,
      roundsDone: 0,
      searchId: null,
      keyword: '',
      filters: null,
      sort: null,
      noteType: null,
      sortSource: null,
      pages: [],
      hasMore: null,
      rank: 0,
      noteRank: 0,
      seen: {},
      duplicates: [],
      hits: [],
      hitCount: 0,
      noteCount: 0,
      droppedBatches: 0,
      lastSeq: 0,
      chunkIndex: 0,
      stopReason: null,
    };
  }

  function adopt(batch) {
    const s = state;
    const req = batch.req || {};
    s.searchId = req.searchId || s.searchId;
    s.keyword = req.keyword || s.keyword;
    s.filters = req.filters || s.filters;
    s.sort = req.sort != null ? req.sort : s.sort;
    s.noteType = req.noteType != null ? req.noteType : s.noteType;
    s.sortSource = req.filters ? 'request_body' : (req.sort != null ? 'legacy_body' : s.sortSource);
  }

  // 消费一批：转成命中行、去重、编号
  async function consumeBatch(batch) {
    const s = state;
    const sch = S();
    if (!sch || !sch.buildSearchHit) return 0;
    const req = batch.req || {};
    const page = req.page == null ? null : req.page;
    if (page != null && s.pages.indexOf(page) < 0) s.pages.push(page);
    if (batch.hasMore != null) s.hasMore = batch.hasMore;
    if (s.searchId && req.searchId && req.searchId !== s.searchId) {
      // 检索条件变了（换了词、换了排序、重新搜索）：本批次到此为止，另起一批
      stopReason = 'search_changed';
      stopRequested = true;
      return 0;
    }
    adopt(batch);
    const hits = [];
    const items = Array.isArray(batch.items) ? batch.items : [];
    for (let i = 0; i < items.length; i++) {
      s.rank += 1;
      const kind = sch.searchItemKindOf(items[i]);
      if (kind === 'note') s.noteRank += 1;
      const hit = sch.buildSearchHit(items[i], {
        seq: s.hitCount + hits.length + 1,
        rank: s.rank,
        rankAmongNotes: s.noteRank,
        page: page,
        indexInPage: i + 1,
        seenAtRound: s.roundsDone + 1,
        capturedAt: iso(),
        // 相对发布时间（"4天前"）的锚点用响应到达时刻，不用写盘时刻
        observedAt: batch.at ? new Date(batch.at).toISOString() : iso(),
      });
      const merged = sch.mergeSearchHit(s.seen, hit);
      if (merged.status === 'repeat') {
        s.duplicates.push({ noteId: hit.noteId, rank: hit.rank, firstRank: merged.hit.rank, page: page });
        continue;
      }
      hits.push(hit);
    }
    if (!hits.length) return 0;
    s.hits = s.hits.concat(hits);
    s.hitCount += hits.length;
    s.noteCount += hits.filter((h) => h.itemKind === 'note').length;
    const key = chunkKey(s.sessionId, s.chunkIndex);
    s.chunkIndex += 1;
    try {
      await chrome.storage.local.set({ [key]: { sessionId: s.sessionId, index: s.chunkIndex - 1, at: iso(), hits: hits } });
    } catch (e) { /* 写不进 storage 就留在内存，浮条上的"已落盘"会体现出来 */ }
    return hits.length;
  }

  // 把桥上现有的批次都取走；返回新增命中数
  async function drainBridge() {
    const s = state;
    if (!s) return 0;
    const bridge = readBridge();
    const batches = bridge.batches.filter((b) => b && Number(b.seq) > s.lastSeq);
    if (bridge.dropped > s.droppedBatches) s.droppedBatches = bridge.dropped;
    let added = 0;
    for (const b of batches) {
      const seq = Number(b.seq) || 0;
      const bSearchId = (b.req && b.req.searchId) || '';
      // 检索条件变了（换词、改筛选、重新搜索）：本批到此为止，并说清原因。
      // 不能默默跳过——那样插件会继续滚下去，采的全是不属于这一批的数据。
      if (s.searchId && bSearchId && bSearchId !== s.searchId) {
        s.lastSeq = Math.max(s.lastSeq, seq);
        stopReason = 'search_changed';
        stopRequested = true;
        continue;
      }
      // 跨检索会话的旧批次不认（同一次检索的页 1 是允许的，它就在 10 分钟窗口内）
      const fresh = !b.at || (Date.now() - b.at) < ADOPT_WINDOW_MS;
      s.lastSeq = Math.max(s.lastSeq, seq);
      if (!fresh) continue;
      added += await consumeBatch(b);
    }
    if (s.lastSeq) writeAck(s.lastSeq);
    if (added) {
      await putSessionHeader();
      await putProgress();
    }
    return added;
  }

  // ---------- 页面浮条 ----------
  // 只读诊断不需要它，但采集期间它是必需的：弹窗关掉之后，"随时能停"只靠这里。
  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'xhs-search-bar';
    bar.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:16px', 'transform:translateX(-50%)',
      'z-index:2147483646', 'display:flex', 'align-items:center', 'gap:10px',
      'padding:8px 12px', 'border-radius:10px', 'background:rgba(30,30,30,.92)',
      'color:#fff', 'font-size:12px', 'line-height:1.4',
      'font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
      'box-shadow:0 4px 16px rgba(0,0,0,.25)',
    ].join(';');
    bar.innerHTML = '<span class="xsb-text"></span><button class="xsb-stop" style="border:0;border-radius:6px;padding:4px 10px;background:#ff2442;color:#fff;cursor:pointer;font-size:12px">停止</button>';
    bar.querySelector('.xsb-stop').addEventListener('click', () => requestStop('user'));
    // 别把点击冒泡给页面（页面自己的"点空白处关闭笔记弹窗"会被误触发）
    for (const type of ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup']) {
      bar.addEventListener(type, (e) => e.stopPropagation());
    }
    document.body.appendChild(bar);
    return bar;
  }

  function updateBar(msg) {
    try {
      const el = ensureBar();
      const s = state;
      const text = msg || (s
        ? '检索采集：已滚 ' + s.roundsDone + '/' + s.rounds + ' 次 · 已采 ' + s.hitCount + ' 条'
          + (s.duplicates.length ? '（重复 ' + s.duplicates.length + '）' : '')
        : '检索采集');
      el.querySelector('.xsb-text').textContent = text;
    } catch (e) { /* 忽略 */ }
  }

  function removeBar() {
    try { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); } catch (e) { /* 忽略 */ }
    bar = null;
  }

  function requestStop(reason) {
    stopReason = reason || 'user';
    stopRequested = true;
    updateBar('正在停止…');
  }

  // ---------- 主循环 ----------
  async function run() {
    const s = state;
    const fire = () => {
      try { window.dispatchEvent(new Event('scroll')); } catch (e) { /* 忽略 */ }
    };
    await drainBridge(); // 先把已经加载好的页 1（如果有）收进来
    while (s.roundsDone < s.rounds && !stopRequested) {
      try {
        const step = Math.max(200, Math.round((window.innerHeight || 800) * 0.9));
        window.scrollBy(0, step);
        fire();
      } catch (e) { /* 忽略 */ }
      s.roundsDone += 1;
      updateBar();
      await putProgress();
      // 等页面把这一页要回来：间隔由用户设，插件不擅自加速
      await sleep(s.intervalMs);
      await drainBridge();
      updateBar();
    }
    // 收尾：再取一次，把最后到达的一页收干净
    await sleep(400);
    await drainBridge();
    running = false;
    s.endedAt = iso();
    s.stopReason = stopReason || (s.roundsDone >= s.rounds ? 'rounds' : 'stopped');
    await putSessionHeader();
    await putProgress();
    updateBar('检索采集结束：本次共采 ' + s.hitCount + ' 条' + (stopReason === 'search_changed' ? '（检索条件变了，已另起一批）' : ''));
    setTimeout(removeBar, 4000);
  }

  async function start(opts) {
    if (running) return { ok: false, error: '已有一次采集在进行中' };
    const sch = S();
    const o = opts || {};
    let rounds = parseInt(o.rounds, 10);
    if (!Number.isFinite(rounds) || rounds < 1) rounds = (sch && sch.SEARCH_DEFAULT_ROUNDS) || 5;
    if (sch && sch.SEARCH_MAX_ROUNDS) rounds = Math.min(rounds, sch.SEARCH_MAX_ROUNDS);
    let intervalMs = parseInt(o.intervalMs, 10);
    if (!Number.isFinite(intervalMs) || intervalMs < 1) intervalMs = (sch && sch.SEARCH_DEFAULT_INTERVAL_MS) || 2000;
    const minMs = (sch && sch.SEARCH_MIN_INTERVAL_MS) || 1000;
    const intervalWarning = intervalMs < minMs;

    await pruneOld();
    state = newSession(rounds, intervalMs);
    running = true;
    stopRequested = false;
    stopReason = '';
    // 软提示而不硬拦：从结果页点进笔记后地址栏会变成 /explore/<id>，
    // 那时结果网格还在后面，滚动往往已经无效——但该由用户判断，插件只说明。
    const onSearchPage = /^\/search_result/.test(location.pathname);
    await putSessionHeader();
    await putProgress({ intervalWarning: intervalWarning, onSearchPage: onSearchPage });
    ensureBar();
    updateBar();
    run().catch(async (e) => {
      running = false;
      if (state) {
        state.endedAt = iso();
        state.stopReason = 'error:' + String(e && e.message || e);
        await putSessionHeader();
        await putProgress();
      }
      updateBar('采集出错：' + String(e && e.message || e));
      setTimeout(removeBar, 6000);
    });
    return { ok: true, sessionId: state.sessionId, intervalWarning: intervalWarning, onSearchPage: onSearchPage, rounds: rounds, intervalMs: intervalMs };
  }

  function status() {
    const s = state;
    if (!s) return { active: false, sessionId: null };
    return {
      active: running,
      sessionId: s.sessionId,
      startedAt: s.startedAt,
      rounds: s.rounds,
      roundsDone: s.roundsDone,
      intervalMs: s.intervalMs,
      hitCount: s.hitCount,
      noteCount: s.noteCount,
      duplicateCount: s.duplicates.length,
      keyword: s.keyword,
      stopReason: s.stopReason,
    };
  }

  window.addEventListener('beforeunload', () => {
    if (!running || !state) return;
    // 页面被关掉/跳走：采集随之结束，如实记下原因。
    // 只补写"结束时刻与原因"，不能把已经写好的会话头覆盖成一份更薄的——
    // 头和命中行分开两条消息写，Unload 时来不及读回，所以这里用 storage.get 再改。
    const sid = state.sessionId;
    const reason = 'page_unload';
    const done = state.roundsDone;
    const hits = state.hitCount;
    try {
      chrome.storage.local.get(sessionKey(sid), (r) => {
        const old = (r && r[sessionKey(sid)]) || { _type: 'session', sessionId: sid };
        const header = Object.assign({}, old, {
          endedAt: iso(),
          scroll: Object.assign({}, old.scroll || {}, { done: done, stoppedBy: reason }),
          coverage: Object.assign({}, old.coverage || {}, { hitCount: hits }),
        });
        chrome.storage.local.set({
          [sessionKey(sid)]: header,
          [PROGRESS_KEY]: { sessionId: sid, active: false, stopReason: reason, hitCount: hits, updatedAt: iso() },
        });
      });
    } catch (e) { /* 忽略 */ }
  });

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return false;
      if (msg.type === 'searchCaptureStart') {
        start(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
        return true;
      }
      if (msg.type === 'searchCaptureStop') {
        if (running) requestStop('user');
        sendResponse({ ok: true, active: running, status: status() });
        return false;
      }
      if (msg.type === 'searchCaptureStatus') {
        sendResponse(status());
        return false;
      }
      return false;
    });
  } catch (e) { /* 非扩展环境（自检沙箱）忽略 */ }

  // 供自检与调试直接驱动（不经过 chrome 消息）
  window.__XHS_SEARCH_CAPTURE__ = {
    start, stop: () => requestStop('user'), status,
    drainBridge,
    _state: () => state,
  };
})();
