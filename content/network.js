/**
 * XHS Archive - 网络响应拦截 + 页面状态桥接（MAIN world, document_start）
 *
 * 两条数据来源：
 *  ① hook fetch/XHR，捕获笔记 API 响应（note_card / note）→ window.__XHS_NOTE_API__
 *  ② 读页面自己的 window.__INITIAL_STATE__.note.noteDetailMap
 *     （直开链接的笔记页是 SSR，页面不发 API 请求，数据只在这个页面变量里；
 *      隔离 world 的内容脚本看不到页面变量，所以必须在这里读出来、写进 DOM 桥）
 * 两者都写进隐藏 DOM 节点，供隔离 world 的抽取模块读取。
 */
(function () {
  'use strict';
  if (window.__XHS_NETWORK_INSTALLED__) return;
  window.__XHS_NETWORK_INSTALLED__ = true;

  // 供隔离 world 读取的缓存容器
  // ponytail: MAP/URLS 都不淘汰，长会话（几百篇）下内存与 JSON 序列化开销会涨；
  // 需要时再加 LRU 上限，现在没必要。
  const MAP = {}; // noteId -> note_card

  // 只处理"可能包含笔记的接口"。私信 / IM / 埋点 / 风控 / 搜索历史一律不碰：
  // 插件没有任何理由去读用户的聊天记录和搜索历史（实测这些请求确实会经过我们这里）。
  const SKIP_URL_RE = /(\/api\/im\/|\/im\/web\/|\/api\/v2\/collect|\/apm-fe\.|pages\.xiaohongshu\.com\/data|\/api\/sec\/|redcaptcha|unread_count|search\/history|note\/metrics_report|message\/web\/detect|\/api\/p\/pj)/;

  function isXhsApiUrl(url) {
    if (!url) return false;
    if (SKIP_URL_RE.test(url)) return false;
    return /xiaohongshu\.com\/api\//.test(url);
  }

  // 判断一个对象是否是"笔记"：具备 id/noteId + 标题/正文/图片 任一特征
  function looksLikeNote(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    const hasId = !!(o.id || o.noteId || o.note_id);
    const hasTitle = typeof o.title === 'string' && o.title.length > 0;
    const hasDesc = typeof o.desc === 'string' && o.desc.length > 0;
    const hasImages = Array.isArray(o.imageList) && o.imageList.length > 0;
    return hasId && (hasTitle || hasDesc || hasImages);
  }

  // 递归找出所有"像笔记"的对象（不固定结构，抗改版）
  function collectNoteCards(j) {
    const cards = [];
    const seenIds = new Set();
    const seenObjs = new WeakSet();
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 6) return;
      if (seenObjs.has(o)) return;
      seenObjs.add(o);
      if (looksLikeNote(o)) {
        const id = o.id || o.noteId || o.note_id;
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          cards.push(o);
        }
        return; // 笔记对象内部不再深入找子笔记
      }
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (v && typeof v === 'object') walk(v, depth + 1);
      }
    };
    walk(j, 0);
    return cards;
  }

  function flushToDom() {
    // ponytail: 每次变化全量重写整块 JSON，且会触发 content/main.js 的 MutationObserver
    // （自我触发回路，靠去抖兜住）。接入评论这类大载荷前再改增量写。
    try {
      let node = document.getElementById('xhs-note-api');
      if (!node) {
        node = document.createElement('div');
        node.id = 'xhs-note-api';
        node.style.display = 'none';
        document.documentElement.appendChild(node);
      }
      node.textContent = JSON.stringify(Object.values(MAP));
      let u = document.getElementById('xhs-note-api-urls');
      if (!u) {
        u = document.createElement('div');
        u.id = 'xhs-note-api-urls';
        u.style.display = 'none';
        document.documentElement.appendChild(u);
      }
      u.textContent = JSON.stringify(URLS);
      // 作者资料：机会性捕获（用户点开作者主页时页面自己发的请求），供归档时反查
      let p = document.getElementById('xhs-user-profile');
      if (!p) {
        p = document.createElement('div');
        p.id = 'xhs-user-profile';
        p.style.display = 'none';
        document.documentElement.appendChild(p);
      }
      p.textContent = JSON.stringify(PROFILES);
      // 哪些笔记卡片来自页面状态（而不是 API 响应）：抽取层据此如实标注来源
      let s = document.getElementById('xhs-note-state');
      if (!s) {
        s = document.createElement('div');
        s.id = 'xhs-note-state';
        s.style.display = 'none';
        document.documentElement.appendChild(s);
      }
      s.textContent = JSON.stringify({ ids: STATE_IDS, at: STATE_AT });
      // 当前笔记的评论（只发当前这一篇，控制桥节点体积）
      let cm = document.getElementById('xhs-note-comments');
      if (!cm) {
        cm = document.createElement('div');
        cm.id = 'xhs-note-comments';
        cm.style.display = 'none';
        document.documentElement.appendChild(cm);
      }
      cm.textContent = JSON.stringify(commentsForCurrentNote());
      // 检索关键词（来自检索接口 URL）
      let sh = document.getElementById('xhs-search');
      if (!sh) {
        sh = document.createElement('div');
        sh.id = 'xhs-search';
        sh.style.display = 'none';
        document.documentElement.appendChild(sh);
      }
      sh.textContent = JSON.stringify(SEARCH_HINT);
    } catch (e) {
      // 忽略
    }
  }

  const URLS = []; // 拦截到的 xhs api url（去重 + 上限，纯粹给调试信息看）
  const MAX_URLS = 60;

  function rememberUrl(url) {
    if (!url) return;
    const u = String(url).slice(0, 160);
    if (URLS.indexOf(u) >= 0) return;
    URLS.push(u);
    if (URLS.length > MAX_URLS) URLS.shift();
  }

  // 用户资料接口：只认"针对某个目标用户的查询"（user/otherinfo?target_user_id=…）。
  // ⚠ user/me 与 user/selfinfo 返回的是**登录者本人**，属于账号身份而不是作者资料：
  // 把它们当成资料收，就会把用户自己的账号写进 authors.json。这里单独识别并标记 self，
  // 下游只用它来"排除自己"。
  const PROFILE_URL_RE = /\/api\/sns\/web\/v?\d*\/user\/otherinfo/;
  const SELF_URL_RE = /\/api\/sns\/web\/v?\d*\/user\/(me|selfinfo)/;
  const PROFILES = []; // 最新的在前
  // ponytail: 只留最近 10 条且不淘汰式持久化，长会话下够用；要长期积累再加去重与上限策略。
  const MAX_PROFILES = 10;

  // 卡片"丰富度"评分：字段越全越可信。
  // 旧实现是「首次写入优先」，导致列表流（推荐/检索）先抓到的薄卡片永久占位，
  // 详情页更完整的卡片反而被丢弃；这里改为字段更全者覆盖。
  function richness(c) {
    let s = 0;
    if (typeof c.desc === 'string') s += Math.min(c.desc.length, 400);
    const imgs = c.imageList || c.image_list;
    if (Array.isArray(imgs)) s += imgs.length * 5;
    if (c.interactInfo || c.interact_info || c.note_interact_info) s += 20;
    if (c.video && (c.video.media || c.video.consumer)) s += 30;
    if (c.title) s += 10;
    if (c.user) s += 5;
    if (c.tagList || c.tag_list) s += 5;
    return s;
  }

  function ingest(json, url) {
    try {
      // 闸门放在这里而不是只放在 hook 里：hook 那里是为了"别去解析无关的响应"（性能），
      // 这里是为了"无论谁调用都不会读到不该读的接口"（安全）。两处都要有。
      if (!isXhsApiUrl(url)) return;
      rememberUrl(url);
      ingestSearchHint(url);
      if (url && (PROFILE_URL_RE.test(url) || SELF_URL_RE.test(url))) {
        // 作者资料原样留存，字段容错解析交给 extract.js（那里能被单测覆盖）
        PROFILES.unshift({
          url: String(url).slice(0, 200),
          at: Date.now(),
          self: SELF_URL_RE.test(url) ? true : undefined,
          json: json,
        });
        if (PROFILES.length > MAX_PROFILES) PROFILES.length = MAX_PROFILES;
      }
      let changed = false;
      for (const c of collectNoteCards(json)) {
        const id = c.id || c.noteId || c.note_id;
        if (!id) continue;
        if (!MAP[id] || richness(c) > richness(MAP[id])) {
          MAP[id] = c;
          changed = true;
        }
      }
      if (changed) window.__XHS_NOTE_API__ = MAP;
      ingestCommentApi(json, url);
      flushToDom(); // URL 列表也变了，无条件刷新（与原行为一致）
    } catch (e) {
      // 忽略解析失败
    }
  }

  // hook fetch
  const _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      const p = _fetch.call(this, input, init);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (isXhsApiUrl(url)) {
          p.then((resp) => {
            try {
              const ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
              if (ct.indexOf('json') >= 0) {
                const cloned = resp.clone();
                cloned.json().then((j) => ingest(j, url)).catch(() => {});
              }
            } catch (e) {}
          }).catch(() => {});
        }
      } catch (e) {}
      return p;
    };
  }

  // hook XMLHttpRequest
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__xhs_url = url; } catch (e) {}
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      this.addEventListener('load', function () {
        try {
          if ((this.status === 200 || this.status === 304) && grepXhs(this.__xhs_url)) {
            // responseType 为 'json' 时读取 responseText 会抛 InvalidStateError，
            // 旧实现因此静默漏抓这类响应；这里按 responseType 分流。
            const rt = this.responseType || '';
            let j = null;
            if (rt === 'json') j = this.response;
            else if (rt === '' || rt === 'text') j = this.responseText ? JSON.parse(this.responseText) : null;
            if (j) ingest(j, this.__xhs_url);
          }
        } catch (e) {}
      });
    } catch (e) {}
    return _send.apply(this, arguments);
  };
  function grepXhs(url) {
    return isXhsApiUrl(url);
  }

  // ---------------- 页面状态桥接 ----------------
  // 直开链接的笔记页是 SSR：数据在 window.__INITIAL_STATE__ 里，页面不发 API 请求，
  // 而内容脚本（隔离 world）读不到页面变量。所以在这里读出来，按与 API 卡片相同的
  // 富集规则合并进 MAP，并记下"这些卡片来自状态"，让抽取层能如实标注来源。
  const STATE_IDS = [];
  let STATE_AT = 0;
  let lastStateSig = '';
  let lastCommentSig = '';

  function currentNotePathId() {
    try {
      const m = location.pathname.match(/\/explore\/([0-9a-zA-Z]+)/);
      return m ? m[1] : '';
    } catch (e) {
      return '';
    }
  }

  function readInitialState() {
    try {
      return window.__INITIAL_STATE__ || null;
    } catch (e) {
      return null; // 页面可能用 getter 保护，读失败就当没有
    }
  }

  function ingestStateNote() {
    try {
      const pathId = currentNotePathId();
      if (!pathId) return false; // 只在笔记详情页读，避免把别的笔记当当前笔记
      const S = readInitialState();
      const map = S && S.note && S.note.noteDetailMap;
      if (!map || typeof map !== 'object') return false;
      const entry = map[pathId];
      const note = entry && entry.note;
      if (!note || typeof note !== 'object') return false;

      const id = note.noteId || note.note_id || note.id || pathId;
      if (!id) return false;
      // 状态没变就别动 DOM（这里每 1.5 秒跑一次，桥节点可能是几十上百 KB）
      const sig = id + '|' + JSON.stringify(note.interactInfo || note.interact_info || null)
        + '|' + (note.lastUpdateTime || note.time || '') + '|' + (note.title || '').length
        + '|' + commentSig(); // 评论也可能在状态里继续加载，必须一起进签名
      if (sig === lastStateSig) return false;
      lastStateSig = sig;

      // 状态里的首屏评论一并收下（同一份数据，不额外请求）
      const st = entry.comments;
      if (st && Array.isArray(st.list)) {
        mergeComments(id, st.list, {
          cursor: st.cursor || '',
          hasMore: st.hasMore !== undefined ? !!st.hasMore : null,
          source: 'state',
        });
      }

      if (!MAP[id] || richness(note) > richness(MAP[id])) MAP[id] = note;
      if (STATE_IDS.indexOf(id) < 0) STATE_IDS.push(id);
      STATE_AT = Date.now();
      window.__XHS_NOTE_API__ = MAP;
      flushToDom();
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------------- 检索关键词 ----------------
  // 实测：笔记页 URL 只有 xsec_source=pc_search、**没有 keyword**；而检索时页面必然请求
  // /search/... 接口，keyword 就在这些请求的 URL 里（search/filter、search/recommend、
  // search/onebox、v2/search/notes…）。从接口取比从地址栏取可靠得多——地址栏那条路
  // 只在"人正好停在检索页"时才成立，实测出现过"归档后 39 秒才学到关键词"。
  const SEARCH_URL_RE = /xiaohongshu\.com\/api\/[^?#]*search/i;
  let SEARCH_HINT = { keyword: '', at: 0, url: '' };

  function ingestSearchHint(url) {
    try {
      if (!url || !SEARCH_URL_RE.test(url)) return false;
      const kw = new URL(url, location.href).searchParams.get('keyword');
      if (!kw) return false;
      if (SEARCH_HINT.keyword === kw) return false;
      SEARCH_HINT = { keyword: kw, at: Date.now(), url: String(url).slice(0, 200) };
      flushToDom();
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------------- 评论 ----------------
  // 两个来源，形状不同但字段同名，容错读取：
  //  ① 页面状态 noteDetailMap[id].comments = { list, cursor, hasMore, ... }（直开页首屏）
  //  ② 滚动时页面自己请求的 /api/sns/web/v2/comment/page → data.comments / data.has_more
  // 统一压成"扁平 + parentId"的列表：分析时按 parentId 分组即可，不必处理嵌套结构。
  // 不自动滚动：只采页面已经加载的部分，完整性与否交给抽取层如实标注。
  const COMMENTS = {}; // noteId -> { list, cursor, hasMore, sources, at }

  function commentIdOf(c) {
    return (c && (c.id || c.commentId || c.comment_id)) || '';
  }

  function normalizeComment(c, parentId) {
    if (!c || typeof c !== 'object') return null;
    const id = commentIdOf(c);
    if (!id) return null;
    const u = c.userInfo || c.user_info || c.user || {};
    return {
      id: id,
      parentId: parentId || (c.targetComment && c.targetComment.id) || c.rootCommentId || c.root_comment_id || '',
      content: typeof c.content === 'string' ? c.content : '',
      userId: u.userId || u.user_id || '',
      nickname: u.nickname || u.nick_name || '',
      likeCount: c.likeCount != null ? c.likeCount : (c.like_count != null ? c.like_count : null),
      createTime: c.createTime || c.create_time || null,
      ipLocation: c.ipLocation || c.ip_location || '',
      isAuthor: Array.isArray(c.showTags) ? c.showTags.indexOf('is_author') >= 0 : !!c.isAuthor,
    };
  }

  function flattenComments(list, parentId, out) {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      const n = normalizeComment(c, parentId);
      if (!n) continue;
      out.push(n);
      flattenComments(c.subComments || c.sub_comments, n.id, out);
    }
  }

  // 同一条评论可能来自两个来源：状态那份带 showTags（能判"作者回复"），接口那份不带。
  // 若按"先到先得"去重，后到的 richer 版本会被丢掉（实测踩过：作者回复被标成 isAuthor=false）。
  // 所以重复 id 不丢弃，而是就地把缺失字段补齐、只增不减。
  function upgradeComment(oldC, newC) {
    let changed = false;
    for (const k of ['parentId', 'content', 'userId', 'nickname', 'ipLocation']) {
      if (!oldC[k] && newC[k]) { oldC[k] = newC[k]; changed = true; }
    }
    for (const k of ['likeCount', 'createTime']) {
      if ((oldC[k] == null || oldC[k] === '') && newC[k] != null && newC[k] !== '') {
        oldC[k] = newC[k];
        changed = true;
      }
    }
    if (newC.isAuthor && !oldC.isAuthor) { oldC.isAuthor = true; changed = true; }
    return changed;
  }

  function mergeComments(noteId, list, meta, parentId) {
    if (!noteId || !Array.isArray(list) || !list.length) return false;
    const flat = [];
    flattenComments(list, parentId, flat);
    if (!flat.length) return false;
    const store = COMMENTS[noteId] || (COMMENTS[noteId] = { list: [], cursor: '', hasMore: null, sources: [], at: 0 });
    const byId = {};
    for (const c of store.list) byId[c.id] = c;
    let changed = false;
    for (const c of flat) {
      const old = byId[c.id];
      if (!old) {
        store.list.push(c);
        byId[c.id] = c;
        changed = true;
      } else if (upgradeComment(old, c)) {
        changed = true;
      }
    }
    if (meta) {
      if (meta.cursor) store.cursor = meta.cursor;
      if (meta.hasMore !== undefined && meta.hasMore !== null) store.hasMore = meta.hasMore;
      const src = meta.source || 'unknown';
      if (store.sources.indexOf(src) < 0) store.sources.push(src);
    }
    store.at = Date.now();
    return changed;
  }

  function commentsForCurrentNote() {
    const id = currentNotePathId();
    const store = id ? COMMENTS[id] : null;
    if (!store) return { noteId: id || '', list: [], cursor: '', hasMore: null, sources: [], at: 0 };
    return { noteId: id, list: store.list, cursor: store.cursor, hasMore: store.hasMore, sources: store.sources, at: store.at };
  }

  function commentSig() {
    const store = COMMENTS[currentNotePathId()];
    if (!store) return 'none';
    return store.list.length + '|' + store.cursor + '|' + store.hasMore;
  }

  const COMMENT_URL_RE = /\/api\/sns\/web\/v?[\d.]*\/comment\/(page|sub\/page)/;

  function ingestCommentApi(json, url) {
    try {
      if (!COMMENT_URL_RE.test(url)) return false;
      const d = (json && json.data) || {};
      const list = Array.isArray(d.comments) ? d.comments : (Array.isArray(d.list) ? d.list : null);
      if (!list) return false;
      let noteId = '';
      let rootId = '';
      try {
        const q = new URL(url, location.href).searchParams;
        noteId = q.get('note_id') || '';
        rootId = q.get('root_comment_id') || '';
      } catch (e) { /* 忽略 */ }
      if (!noteId) noteId = currentNotePathId();
      const changed = mergeComments(noteId, list, {
        cursor: d.cursor || '',
        hasMore: d.has_more !== undefined ? !!d.has_more : (d.hasMore !== undefined ? !!d.hasMore : null),
        source: 'api',
      }, rootId);
      if (changed) flushToDom();
      return changed;
    } catch (e) {
      return false;
    }
  }

  window.__XHS_STATE_INGEST__ = ingestStateNote; // 供自检直接调用
  window.__XHS_INGEST__ = ingest; // 供自检验证"哪些接口会被处理"
  ingestStateNote();  setInterval(ingestStateNote, 1500); // SPA 内切笔记时状态会更新，靠轮询兜住
})();
