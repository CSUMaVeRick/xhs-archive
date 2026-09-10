/**
 * XHS Archive - 数据抽取模块
 * 职责：从真实小红书笔记页/弹窗抽取结构化数据。
 * 不依赖 URL 是否变化；通过检测页面上是否出现"笔记详情容器"来判断。
 * 策略优先级：window.__INITIAL_STATE__ > DOM 选择器回退。
 * 暴露为 window.__XHS_EXTRACT__，供注入脚本调用。
 */
(function () {
  'use strict';

  // ---------- URL 识别 ----------
  const URL_HELPERS = {
    isNotePage(url) {
      return /\/explore\/[0-9a-zA-Z]+/.test(url) || /\/discovery\/item\/[0-9a-zA-Z]+/.test(url);
    },
    extractNoteId(url) {
      const m = url.match(/\/explore\/([0-9a-zA-Z]+)/) || url.match(/\/discovery\/item\/([0-9a-zA-Z]+)/);
      return m ? m[1] : null;
    },
  };

  // ---------- 共享常量与同步缓存 ----------
  // extract() 是同步函数，无法 await chrome.storage，因此在模块加载时把
  // 采集者信息、检索关键词提示、作者资料缓存读进内存，并在 storage 变化时更新。
  const S = () => window.XHS_SCHEMA || null;

  const syncCache = {
    collector: { collectorId: '', accountLabel: '', accountSource: 'none' },
    keywordHint: null,
    authors: {}, // userId -> { 作者字段 }
    selfUserId: '', // 登录者本人 id：只用来排除自己，绝不当作者存
    lastProfileUserId: '', // 最近一次确认在看的作者主页（笔记弹窗覆盖时仍沿用）
  };

  function applyStorageSnapshot(r) {
    if (!r) return;
    const p = r.collectorProfile;
    if (p && typeof p === 'object') {
      syncCache.collector = {
        collectorId: p.collectorId || '',
        accountLabel: p.accountLabel || '',
        accountSource: (p.collectorId || p.accountLabel) ? 'manual' : 'none',
      };
    }
    if ('keywordHint' in r) syncCache.keywordHint = r.keywordHint || null;
    if ('authorCache' in r && r.authorCache && typeof r.authorCache === 'object') {
      syncCache.authors = r.authorCache;
    }
    if ('selfUserId' in r) syncCache.selfUserId = r.selfUserId || '';
  }

  function initSyncCache() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get(['collectorProfile', 'keywordHint', 'authorCache', 'selfUserId'], (r) => applyStorageSnapshot(r));
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        const patch = {};
        if (changes.collectorProfile) patch.collectorProfile = changes.collectorProfile.newValue;
        if (changes.keywordHint) patch.keywordHint = changes.keywordHint.newValue;
        if (changes.authorCache) patch.authorCache = changes.authorCache.newValue;
        if (changes.selfUserId) patch.selfUserId = changes.selfUserId.newValue;
        applyStorageSnapshot(patch);
      });
    } catch (e) {
      // 忽略：非扩展环境
    }
  }

  // 作者资料缓存：粉丝数是时间敏感变量，必须持久化才能"看到主页时记下来、归档时用上"。
  // ponytail: 按 capturedAt 截断到 300 人，不做 LRU；真到几万人再加淘汰策略。
  const AUTHOR_CACHE_MAX = 300;

  function persistAuthorCache() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      const entries = Object.entries(syncCache.authors);
      if (entries.length > AUTHOR_CACHE_MAX) {
        entries.sort((a, b) => String(b[1].capturedAt || '').localeCompare(String(a[1].capturedAt || '')));
        syncCache.authors = Object.fromEntries(entries.slice(0, AUTHOR_CACHE_MAX));
      }
      chrome.storage.local.set({ authorCache: syncCache.authors });
    } catch (e) {
      // 忽略：写失败只影响下次归档能否补全，不影响当前归档
    }
  }

  // 检索词容错解码：XHS 有些入口会把已编码的串再编码一次，
  // 直接显示就是 %E8%AF%BB... 这种；解到解不动或解出非法序列为止。
  function decodeKeyword(v) {
    let out = String(v == null ? '' : v);
    for (let i = 0; i < 3 && /%[0-9a-fA-F]{2}/.test(out); i++) {
      let next = '';
      try { next = decodeURIComponent(out); } catch (e) { break; }
      if (next === out) break;
      out = next;
    }
    return out;
  }

  // 样本来源（抽样框架）：这篇笔记是从哪个入口拿到的。
  // 平台的 URL 里就带着线索：xsec_source=pc_search（搜索）/ pc_user（作者主页）/
  // pc_note_detail_r10（笔记内推荐）/ web_explore_feed（推荐流）……
  // ⚠ 检索词只在"确实从搜索进来"时才填：从主页或推荐流打开时用最近的检索提示去填，
  //   会把抽样框架标错——那正是最不该出错的地方。
  // ⚠ source=web_explore_feed 是版式水印，检索页地址栏也带着它（实测
  //   /search_result_ai?keyword=…&source=web_explore_feed），按它判会把检索页标成"推荐流"。
  //   所以 entry 的判据按可信度排：xsec_source → 检索页路径 / 地址栏 keyword → source。
  const SEARCH_PATH_RE = /^\/search_result/;
  function resolveSource() {
    const out = {
      type: 'unknown',
      label: '',
      raw: '',
      typeSource: 'none',
      keyword: null,
      keywordSource: 'none',
      keywordFromHintAt: null,
      sortOrder: null,
      sortOrderSource: 'none',
      resultRank: null,
      capturedAt: new Date().toISOString(),
    };
    try {
      const q = new URLSearchParams(location.search);
      const xs = q.get('xsec_source') || '';
      const src = q.get('source') || '';
      const raw = xs || src;
      const kw = q.get('keyword');
      const sch = S();
      out.raw = raw; // 平台原话，一律保留；判成什么由 typeSource 说明
      if (!xs && (SEARCH_PATH_RE.test(location.pathname) || kw)) {
        out.type = 'search';
        out.label = '搜索';
        out.typeSource = kw ? 'url_keyword' : 'url_path';
      } else if (raw) {
        const m = sch && sch.sourceTypeOf ? sch.sourceTypeOf(raw) : { type: 'unknown', label: '' };
        out.type = m.type;
        out.label = m.label;
        out.typeSource = xs ? 'xsec_source' : 'source';
      } else {
        out.type = 'direct';
        out.label = '直接打开';
      }
      if (kw) {
        out.keyword = decodeKeyword(kw);
        out.keywordSource = 'url_auto';
      }
    } catch (e) {
      // 忽略 URL 解析失败
    }
    if (!out.keyword && out.type === 'search') {
      const hint = syncCache.keywordHint;
      const sch = S();
      const ttl = sch && sch.KEYWORD_HINT_TTL_MS ? sch.KEYWORD_HINT_TTL_MS : 30 * 60 * 1000;
      if (hint && hint.keyword && hint.at && Date.now() - hint.at <= ttl) {
        out.keyword = decodeKeyword(hint.keyword);
        out.keywordSource = 'url_auto';
        out.keywordFromHintAt = new Date(hint.at).toISOString();
      }
    }
    return out;
  }

  initSyncCache();

  // ---------- 全局状态读取 ----------
  // 注意：window.__INITIAL_STATE__ 是**页面**的变量，内容脚本在隔离 world 里读不到它。
  // 直开链接的笔记页（SSR）数据只在那里，所以由 main world 的 network.js 读出来、
  // 写进 #xhs-note-state 桥节点，这里只消费桥节点（见 readStateIds）。

  // 读取 network.js(main world) 缓存到 DOM 的笔记 API 数据。
  // extract() 每次页面变动都会跑（MutationObserver + 300ms 去抖），而桥节点往往是
  // 几十上百 KB 的 JSON —— 内容没变就不重复 parse。
  let apiCardsCache = { text: null, value: [] };
  function readApiCards() {
    try {
      const node = document.getElementById('xhs-note-api');
      const text = node ? node.textContent : '';
      if (!text) return [];
      if (text === apiCardsCache.text) return apiCardsCache.value;
      const arr = JSON.parse(text);
      apiCardsCache = { text: text, value: Array.isArray(arr) ? arr : [] };
      return apiCardsCache.value;
    } catch (e) {
      return [];
    }
  }

  // ---------- 作者资料（机会性捕获 + 容错解析） ----------
  // 公开资料对这块字段路径互相矛盾（basicInfo / basic_info、粉丝数在 interactions 里），
  // 所以按语义匹配 + 多层回退；命中不了就返回 null，让字段继续留在 _fieldsMissing。
  const AUTHOR_KEYS = {
    userId: ['userId', 'user_id', 'id'],
    nickname: ['nickname', 'nickName', 'nick_name', 'name'],
    redId: ['redId', 'red_id', 'redID', 'redIdStr'],
    fansCount: ['fans', 'fansCount', 'fans_count', 'fansNum', 'fans_num', 'fansTotal'],
    followsCount: ['follows', 'followsCount', 'follows_count', 'following', 'followingCount', 'following_count'],
    noteCount: ['noteCount', 'note_count', 'notesCount', 'notes_count', 'noteNum'],
    interactionCount: ['interactionCount', 'interaction_count', 'interactionsCount', 'likedAndCollected', 'likedAndCollectedCount'],
    bio: ['desc', 'bio', 'description', 'introduction', 'summary'],
    ipLocation: ['ipLocation', 'ip_location'],
    verified: ['verified', 'isVerified', 'is_verified', 'verifyInfo', 'verify', 'officialVerified'],
  };
  const INTERACT_LABELS = {
    fansCount: ['fans', '粉丝'],
    followsCount: ['follow', '关注'],
    noteCount: ['note', '笔记'],
    interactionCount: ['interaction', '获赞', '赞与收藏'],
  };
  const COUNT_KEYS = ['fansCount', 'followsCount', 'noteCount', 'interactionCount'];

  function pickFirst(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) {
      const v = obj[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  function deepPick(o, keys, depth) {
    if (!o || typeof o !== 'object' || depth < 0) return undefined;
    const direct = pickFirst(o, keys);
    if (direct !== undefined) return direct;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v && typeof v === 'object') {
        const hit = deepPick(v, keys, depth - 1);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  }

  function collectInteractions(root, info) {
    const out = [];
    for (const obj of [info, root]) {
      for (const key of ['interactions', 'interaction', 'interactInfo', 'interact_info']) {
        const arr = obj && obj[key];
        if (Array.isArray(arr)) for (const it of arr) if (it && typeof it === 'object') out.push(it);
      }
    }
    return out;
  }

  function normalizeProfile(json, at) {
    const root = (json && typeof json === 'object' && json.data && typeof json.data === 'object') ? json.data : json;
    if (!root || typeof root !== 'object') return null;
    const info = pickFirst(root, ['basicInfo', 'basic_info', 'user']) || root;
    const userId = String(pickFirst(info, AUTHOR_KEYS.userId) || pickFirst(root, AUTHOR_KEYS.userId) || '');
    if (!userId) return null;

    const counts = {};
    for (const key of COUNT_KEYS) counts[key] = num(pickFirst(info, AUTHOR_KEYS[key]));
    for (const it of collectInteractions(root, info)) {
      const label = String(it.type || it.name || it.title || '').toLowerCase();
      const val = num(it.count != null ? it.count : (it.value != null ? it.value : it.num));
      if (val == null) continue;
      for (const key of COUNT_KEYS) {
        if (counts[key] != null) continue;
        if (INTERACT_LABELS[key].some((k) => label.includes(k))) { counts[key] = val; break; }
      }
    }
    for (const key of COUNT_KEYS) {
      if (counts[key] == null) counts[key] = num(deepPick(root, AUTHOR_KEYS[key], 4));
    }

    const bio = pickFirst(info, AUTHOR_KEYS.bio) || pickFirst(root, AUTHOR_KEYS.bio);
    const ipLocation = pickFirst(info, AUTHOR_KEYS.ipLocation) || pickFirst(root, AUTHOR_KEYS.ipLocation);
    const redId = pickFirst(info, AUTHOR_KEYS.redId) || pickFirst(root, AUTHOR_KEYS.redId);
    const verifiedRaw = pickFirst(info, AUTHOR_KEYS.verified) !== undefined
      ? pickFirst(info, AUTHOR_KEYS.verified)
      : pickFirst(root, AUTHOR_KEYS.verified);
    const verified = verifiedRaw === undefined ? null : !!verifiedRaw;
    // 认证文案单独留一份：只存布尔会把"什么认证"这条信息丢掉
    let verifyText = '';
    if (verifiedRaw && typeof verifiedRaw === 'object') {
      const t = pickFirst(verifiedRaw, ['name', 'title', 'desc', 'text', 'description']);
      verifyText = typeof t === 'string' ? t : '';
    } else if (typeof verifiedRaw === 'string') {
      verifyText = verifiedRaw;
    }

    // 四个计数、简介、认证全空 → 这个载荷没有分析价值，不缓存
    const anyCount = COUNT_KEYS.some((k) => counts[k] != null);
    if (!anyCount && !bio && verified == null) return null;

    return {
      userId: userId,
      nickname: String(pickFirst(info, AUTHOR_KEYS.nickname) || pickFirst(root, AUTHOR_KEYS.nickname) || ''),
      profileUrl: 'https://www.xiaohongshu.com/user/profile/' + userId,
      redId: redId == null ? null : String(redId),
      fansCount: counts.fansCount,
      followsCount: counts.followsCount,
      noteCount: counts.noteCount,
      interactionCount: counts.interactionCount,
      bio: bio ? String(bio).slice(0, 300) : null,
      verified: verified,
      verifyText: verifyText ? verifyText.slice(0, 100) : null,
      ipLocation: ipLocation ? String(ipLocation).slice(0, 40) : null,
      source: 'profile_api',
      capturedAt: at || new Date().toISOString(),
    };
  }

  // ---------- 作者主页：直接解析当前页面（按需调用，不进 2.5 秒循环） ----------
  // 主页是 SSR 直开也没关系：昵称、小红书号、IP 属地、关注/粉丝/获赞与收藏都在可见文本里，
  // 这条路径不依赖资料接口是否被拦到，所以比"缓存 + 兜圈子"直接得多。
  const PROFILE_COUNT_LABELS = ['关注', '粉丝', '获赞与收藏'];
  // 真实页面上是"数字 + 标签"（`59 关注`，见实测截图），但也容错解析"标签 + 数字"的排布
  const PROFILE_RE_NUM_FIRST = /([\d.,]+\s*[万亿wWkK]?)\s*(关注|粉丝|获赞与收藏)/g;
  const PROFILE_RE_LABEL_FIRST = /(关注|粉丝|获赞与收藏)\s*[:：]?\s*([\d.,]+\s*[万亿wWkK]?)/g;

  function currentProfileUserId() {
    try {
      const m = location.pathname.match(/\/user\/profile\/([0-9a-zA-Z]+)/);
      return m ? m[1] : '';
    } catch (e) {
      return '';
    }
  }

  function profileLinkExists(userId) {
    try {
      return !!document.querySelector('a[href*="/user/profile/' + userId + '"]');
    } catch (e) {
      return false;
    }
  }

  // 主页上下文：URL 在主页，或"笔记弹窗盖在主页之上"——后者 URL 会变成 /explore/<id>，
  // 但主页 DOM 还在（页面上仍有指向该作者主页的链接），此时仍应认定在看他/她的主页。
  function resolveProfileUserId() {
    const urlId = currentProfileUserId();
    if (urlId) {
      syncCache.lastProfileUserId = urlId;
      return urlId;
    }
    const last = syncCache.lastProfileUserId;
    if (last && profileLinkExists(last)) return last;
    return '';
  }

  // 找"命中全部关键词、且文本最短"的元素。
  // ⚠ 不要用 document.body.textContent 跑正则：textContent 会把相邻元素直接拼起来
  // （实测把"四川"和简介开头的"◇985法学博士"粘成了一个值），必须限定到具体元素里再解析。
  function smallestElContaining(needles) {
    const list = Array.isArray(needles) ? needles : [needles];
    let best = null;
    let bestLen = Infinity;
    let nodes = [];
    try { nodes = document.querySelectorAll('div, span, p, section'); } catch (e) { nodes = []; }
    for (const el of nodes) {
      const t = el.textContent || '';
      if (t.length >= bestLen) continue;
      if (list.every((n) => t.indexOf(n) >= 0)) {
        best = el;
        bestLen = t.length;
      }
    }
    return best;
  }

  function textOfContaining(needles) {
    const el = smallestElContaining(needles);
    return el ? (el.textContent || '') : '';
  }

  function readProfileFromDom() {
    const userId = resolveProfileUserId();
    if (!userId) return null;
    const box = smallestElContaining(['粉丝', '获赞']);
    const text = box ? box.textContent : '';
    const counts = { fansCount: null, followsCount: null, noteCount: null, interactionCount: null };
    const applyCount = (label, rawNum) => {
      const n = num(rawNum);
      if (n == null) return;
      if (label === '关注') { if (counts.followsCount == null) counts.followsCount = n; }
      else if (label === '粉丝') { if (counts.fansCount == null) counts.fansCount = n; }
      else if (counts.interactionCount == null) counts.interactionCount = n;
    };
    if (text) {
      // 两种排布不能同时跑：标签在前的文本里，"12 粉丝" 这种会被"数字在前"那遍误吃。
      // 用"第一个标签 vs 第一个数字"谁先出现来判断，只跑对应的一遍。
      const firstLabel = text.search(/关注|粉丝|获赞与收藏/);
      const firstDigit = text.search(/\d/);
      const labelFirst = firstLabel >= 0 && (firstDigit < 0 || firstLabel < firstDigit);
      let m;
      if (labelFirst) {
        PROFILE_RE_LABEL_FIRST.lastIndex = 0;
        while ((m = PROFILE_RE_LABEL_FIRST.exec(text))) applyCount(m[1], m[2]);
      } else {
        PROFILE_RE_NUM_FIRST.lastIndex = 0;
        while ((m = PROFILE_RE_NUM_FIRST.exec(text))) applyCount(m[2], m[1]);
      }
    }
    // 号与属地也限定在各自元素里解析（不能拿整页 textContent，相邻元素会被拼在一起）
    const redIdM = textOfContaining('小红书号').match(/小红书号[:：]\s*([A-Za-z0-9_.-]{2,40})/);
    const ipM = textOfContaining('IP属地').match(/IP属地[:：]\s*([\u4e00-\u9fa5A-Za-z]{2,12})/);
    const nickname = textOf(document.querySelector('.user-name, .user-nickname, [class*="user-name"], [class*="nickname"], h1'));
    const bio = textOf(document.querySelector('.user-desc, [class*="user-desc"], [class*="user-desc-text"]'));
    return {
      userId: userId,
      nickname: nickname || '',
      profileUrl: 'https://www.xiaohongshu.com/user/profile/' + userId,
      redId: redIdM ? redIdM[1] : null,
      fansCount: counts.fansCount,
      followsCount: counts.followsCount,
      noteCount: counts.noteCount,
      interactionCount: counts.interactionCount,
      bio: bio || null,
      verified: null,
      verifyText: null,
      ipLocation: ipM ? ipM[1] : null,
      source: 'profile_dom',
      capturedAt: new Date().toISOString(),
    };
  }

  // 保存"当前正在看的作者"：DOM 为主（页面上现在是什么就是什么），
  // 资料接口缓存的认证信息等 DOM 拿不到的字段作为补充。
  function flushCurrentAuthor() {
    const dom = readProfileFromDom();
    if (!dom) return null;
    const cached = syncCache.authors[dom.userId];
    const out = Object.assign({}, cached || {});
    for (const k of Object.keys(dom)) {
      const v = dom[k];
      if (v !== undefined && v !== null && v !== '') out[k] = v;
    }
    if (cached) {
      out.verified = cached.verified;
      out.verifyText = cached.verifyText;
      out.source = 'profile_dom+profile_api';
    } else {
      out.source = 'profile_dom';
    }
    out.capturedAt = dom.capturedAt;
    return out;
  }

  // 评论：main world 把当前笔记的评论写进 #xhs-note-comments（状态 + 评论接口两个来源合并后）
  let commentsCache = { text: null, value: null };
  function readComments() {
    try {
      const node = document.getElementById('xhs-note-comments');
      const text = node ? node.textContent : '';
      if (!text) return null;
      if (text === commentsCache.text) return commentsCache.value;
      const obj = JSON.parse(text);
      commentsCache = { text: text, value: obj && typeof obj === 'object' ? obj : null };
      return commentsCache.value;
    } catch (e) {
      return null;
    }
  }

  // 检索关键词：main world 从**检索接口的 URL** 里读出来的。
  // 比 main.js 那条"看地址栏"的路可靠：地址栏只在人停在检索页时才有 keyword，
  // 而接口请求发生在检索的那一刻，笔记还没打开就已经记下了。
  let searchHintCache = { text: null };
  function collectSearchHint() {
    try {
      const node = document.getElementById('xhs-search');
      const text = node ? node.textContent : '';
      if (!text || text === searchHintCache.text) return false;
      searchHintCache = { text: text };
      const obj = JSON.parse(text);
      if (!obj || !obj.keyword) return false;
      const prev = syncCache.keywordHint;
      if (prev && prev.keyword === obj.keyword && prev.at === obj.at) return false;
      syncCache.keywordHint = { keyword: obj.keyword, at: obj.at || Date.now() };
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ keywordHint: syncCache.keywordHint });
        }
      } catch (e) { /* 忽略 */ }
      return true;
    } catch (e) {
      return false;
    }
  }

  // 供「保存作者」按钮使用：先把桥上的资料收进缓存，再交出全部记录（排除登录者本人）
  function flushAuthorCache() {
    collectProfiles();
    const selfId = syncCache.selfUserId;
    return Object.values(syncCache.authors).filter((a) => a && a.userId && a.userId !== selfId);
  }

  // 登录者本人 id（来自 user/me、user/selfinfo）：只用来"排除自己"。
  // 这三个键名不含裸 'id'，避免深挖时撞上笔记/评论的 id。
  const SELF_ID_KEYS = ['user_id', 'userId', 'userid'];
  function pickSelfUserId(json) {
    const root = (json && typeof json === 'object' && json.data && typeof json.data === 'object') ? json.data : json;
    if (!root || typeof root !== 'object') return '';
    const info = pickFirst(root, ['basicInfo', 'basic_info', 'user']) || root;
    return String(pickFirst(info, SELF_ID_KEYS) || pickFirst(root, SELF_ID_KEYS) || deepPick(root, SELF_ID_KEYS, 2) || '');
  }

  let profileBridgeText = null;
  function collectProfiles() {
    try {
      const node = document.getElementById('xhs-user-profile');
      const text = node ? node.textContent : '';
      if (!text || text === profileBridgeText) return false;
      profileBridgeText = text;
      const list = JSON.parse(text);
      if (!Array.isArray(list)) return false;
      let changed = false;
      for (const entry of list) {
        // 身份接口：只记下"我是谁"，并清掉之前误收的自己的记录
        if (entry && entry.self) {
          const sid = pickSelfUserId(entry.json);
          if (sid && sid !== syncCache.selfUserId) {
            syncCache.selfUserId = sid;
            if (syncCache.authors[sid]) delete syncCache.authors[sid];
            try {
              if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({ selfUserId: sid });
              }
            } catch (e) { /* 忽略 */ }
            changed = true;
          }
          continue;
        }
        const p = normalizeProfile(entry && entry.json, entry && entry.at ? new Date(entry.at).toISOString() : null);
        if (!p) continue;
        if (syncCache.selfUserId && p.userId === syncCache.selfUserId) continue; // 自己的账号不是作者样本
        const prev = syncCache.authors[p.userId];
        if (!prev || String(prev.capturedAt || '') < p.capturedAt) {
          syncCache.authors[p.userId] = p;
          changed = true;
        }
      }
      if (changed) persistAuthorCache();
      return changed;
    } catch (e) {
      return false;
    }
  }

  // 统一取笔记 id（兼容 id / noteId / note_id）
  function noteIdOf(o) {
    return (o && (o.id || o.noteId || o.note_id)) || '';
  }

  // 来自页面状态（SSR 页面）的笔记卡片 id：用于如实标注抽取来源，不与 API 响应混淆
  let stateIdsCache = { text: null, value: [] };
  function readStateIds() {
    try {
      const node = document.getElementById('xhs-note-state');
      const text = node ? node.textContent : '';
      if (!text) return [];
      if (text === stateIdsCache.text) return stateIdsCache.value;
      const obj = JSON.parse(text);
      stateIdsCache = { text: text, value: Array.isArray(obj && obj.ids) ? obj.ids : [] };
      return stateIdsCache.value;
    } catch (e) {
      return [];
    }
  }

  // ---------- 工具 ----------
  function pickBestImageUrl(item) {
    if (!item) return '';
    if (typeof item === 'string') return item;
    if (Array.isArray(item.infoList) && item.infoList.length) {
      const byScene = {};
      const order = ['WB_DFT', 'WB_PRV', 'WB_PNG', 'CRT'];
      for (const info of item.infoList) if (info && info.url) byScene[info.imageScene] = info.url;
      for (const scene of order) if (byScene[scene]) return byScene[scene];
      return item.infoList[0].url;
    }
    return item.urlDefault || item.urlPre || item.url || item.url_default || '';
  }

  // 兜底：在整个 video 对象里递归找第一个视频 URL（优先 .mp4，避免抓到封面图）
  function findVideoUrlInObject(video) {
    let mp4 = '', generic = '';
    const imgRe = /\.(jpe?g|png|webp|gif)(\?|$)|!nd_dft|\/avatar\/|\/notes_pre_post\/|picasso/;
    const stack = [video];
    const seen = new WeakSet();
    while (stack.length) {
      const o = stack.pop();
      if (!o || typeof o !== 'object' || seen.has(o)) continue;
      seen.add(o);
      for (const v of Object.values(o)) {
        if (typeof v === 'string') {
          if (/^https?:\/\//i.test(v)) {
            if (/\.mp4|(\/|_)video|playurl/i.test(v)) { if (!mp4) mp4 = v; }
            else if (!generic && !imgRe.test(v)) generic = v;
          }
        } else if (Array.isArray(v)) {
          for (const x of v) if (x && typeof x === 'object') stack.push(x);
        } else if (v && typeof v === 'object') {
          stack.push(v);
        }
      }
    }
    return mp4 || generic || '';
  }

  function pickBestVideoUrl(note) {
    const video = note.video || {};
    const consumer = video.consumer;
    if (typeof consumer === 'string' && consumer) return consumer;
    if (consumer && consumer.originVideoKey && /^https?:/.test(consumer.originVideoKey)) return consumer.originVideoKey;

    // 从 media.stream 里找可播放 url：兼容 h264/av1 和 EF4/EF5/EF6/EF7 分档
    const stream = video.media && video.media.stream;
    if (stream) {
      const tryPick = (x) => {
        if (!x) return '';
        if (typeof x === 'string') return x;
        if (x.master_url) return x.master_url; // 主源（带签名）
        if (x.url) return x.url;
        if (Array.isArray(x.backup_urls) && x.backup_urls.length) return x.backup_urls[0];
        if (Array.isArray(x.backupUrls) && x.backupUrls.length) return x.backupUrls[0];
        return '';
      };
      const codecKeys = ['h264', 'av1', 'h265', 'EF4', 'EF5', 'EF6', 'EF7'];
      const candidates = [];
      for (const key of codecKeys) {
        const v = stream[key];
        const arr = Array.isArray(v) ? v : (v ? [v] : []);
        for (const item of arr) {
          const u = tryPick(item);
          if (u) candidates.push({ u, w: (item && item.weight) || 0 });
        }
      }
      if (candidates.length) {
        candidates.sort((a, b) => b.w - a.w); // 选画质最好（weight 最大）
        return candidates[0].u;
      }
      return findVideoUrlInObject(video);
    }
    if (consumer && consumer.originUrl) return consumer.originUrl;
    if (video.originVideoKey || video.url) return video.originVideoKey || video.url;
    return findVideoUrlInObject(video);
  }

  // 数值解析：取不到返回 null，与真实的 0 区分（"1.2万" 也能正确解析）
  function num(v) {
    const sch = S();
    // 对象/数组一律拒绝：把数组 join 成字符串再解析会得到"看着合理"的错值
    if (v && typeof v === 'object') return null;
    if (sch && sch.parseCount) return sch.parseCount(v);
    if (v == null || v === '') return null;
    const n = parseInt(String(v).replace(/[,\s]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  function rawOrNull(v) {
    return v == null || v === '' ? null : String(v);
  }

  function hasAnyStat(values) {
    return Object.keys(values || {}).some((k) => values[k] != null);
  }

  // 返回 { values, raw }：values 用于分析，raw 保留原始文本（如 "1.2万"）
  function readStats(note) {
    // 小红书常把统计数放在 interactInfo 嵌套对象里
    const info = note.interactInfo || note.note_interact_info || note.interact_info || {};
    const pick = (a, b) => (a != null && a !== '' ? a : b);
    function read(camelTop, snakeTop, infoCamel, infoSnake) {
      return pick(
        pick(camelTop, snakeTop),
        pick(infoCamel, infoSnake)
      );
    }
    const rawSrc = {
      likeCount: read(note.likedCount, note.liked_count, info.likedCount, info.liked_count),
      collectCount: read(note.collectedCount, note.collected_count, info.collectedCount, info.collected_count),
      commentCount: read(note.commentCount, note.comment_count, info.commentCount, info.comment_count),
      shareCount: read(note.shareCount, note.share_count, info.shareCount, info.share_count),
    };
    return {
      values: {
        likeCount: num(rawSrc.likeCount),
        collectCount: num(rawSrc.collectCount),
        commentCount: num(rawSrc.commentCount),
        shareCount: num(rawSrc.shareCount),
      },
      raw: {
        likeCount: rawOrNull(rawSrc.likeCount),
        collectCount: rawOrNull(rawSrc.collectCount),
        commentCount: rawOrNull(rawSrc.commentCount),
        shareCount: rawOrNull(rawSrc.shareCount),
      },
    };
  }

  function normalizeTime(note) {
    let t = note.time ?? note.createTime ?? note.publishTime;
    if (typeof t === 'number' && t < 1e12) t = t * 1000;
    if (typeof t === 'string' && /^\d+$/.test(t)) t = parseInt(t, 10);
    if (typeof t === 'number' && t < 1e12) t = t * 1000;
    if (!t) return '';
    const d = new Date(t);
    return isNaN(d.getTime()) ? String(t) : d.toISOString();
  }

  // 发布时间原值：相对时间（"6天前"）必须连同观测时刻一起留存，否则无法还原
  function readPublishTimeRaw(note) {
    const t = note.time ?? note.createTime ?? note.publishTime;
    return rawOrNull(t);
  }

  // 笔记 URL：旧实现会把 urlInfo 对象写进 url 字段，这里统一成可打开的链接
  function resolveNoteUrl(note) {
    const direct = typeof note.url === 'string' ? note.url : '';
    if (/^https?:\/\//.test(direct)) return direct;
    const id = note.noteId || note.note_id || note.id || URL_HELPERS.extractNoteId(location.href) || '';
    if (!id) return location.href;
    const token = note.xsecToken || note.xsec_token || '';
    const base = 'https://www.xiaohongshu.com/explore/' + id;
    if (!token) return base;
    // xsec_source 从当前页面 URL 取，取不到就不带——不要凭空写一个来源（那会让链接看起来比实际更可信）
    let src = '';
    try { src = new URLSearchParams(location.search).get('xsec_source') || ''; } catch (e) { src = ''; }
    return base + '?xsec_token=' + encodeURIComponent(token) + (src ? '&xsec_source=' + encodeURIComponent(src) : '');
  }

  // 话题标签：api 侧只保留 type === 'topic'，原始条目全量留在 _tagsRaw 便于审计
  function collectTags(note) {
    const tagList = note.tagList || note.tag_list;
    if (!Array.isArray(tagList)) return { names: [], raw: [] };
    const raw = tagList
      .map((t) => ({
        name: (t && (t.name ?? t.title)) || '',
        type: (t && (t.type || t.tagType)) || '',
      }))
      .filter((t) => t.name);
    const typed = raw.some((t) => t.type);
    const names = (typed ? raw.filter((t) => t.type === 'topic') : raw).map((t) => t.name);
    return { names, raw };
  }

  function normalizeImageList(note) {
    const list = note.imageList || note.image_list || note.images;
    if (!Array.isArray(list)) return [];
    return list
      .map((it) => ({
        url: pickBestImageUrl(it),
        width: (it && (it.width || it.w)) || 0,
        height: (it && (it.height || it.h)) || 0,
      }))
      .filter((x) => x.url); // 去掉空 url
  }

  // 收集所有可选视频档位（含各档宽/高/大小），供按画质选择下载
  function extractVideoStreams(note) {
    const stream = note.video && note.video.media && note.video.media.stream;
    if (!stream) return [];
    const out = [];
    const codecKeys = ['EF4', 'EF5', 'EF6', 'EF7', 'h264', 'av1', 'h265'];
    for (const key of codecKeys) {
      const v = stream[key];
      const arr = Array.isArray(v) ? v : (v ? [v] : []);
      for (const item of arr) {
        const url = item && (item.master_url || item.url || (Array.isArray(item.backup_urls) && item.backup_urls[0]));
        if (url) {
          out.push({
            url,
            width: item.width || 0,
            height: item.height || 0,
            weight: item.weight || 0,
            stream_type: item.stream_type || key,
            size: item.size || 0,
          });
        }
      }
    }
    return out;
  }

  // ---------- 从 STATE 归一化笔记 ----------
  function normalizeFromState(note) {
    const images = normalizeImageList(note);
    const hasVideo = !!(note.video && (pickBestVideoUrl(note) || (note.video.media && note.video.media.stream)));
    const type = note.type || (hasVideo ? 'video' : 'normal');
    const userId = (note.user && (note.user.userId || note.user.user_id)) || '';
    const nickname = (note.user && note.user.nickname) || '';
    const avatar = (note.user && (note.user.avatar || note.user.avatarDefault || note.user.avatar_url)) || '';
    const publishTime = normalizeTime(note);
    const tags = collectTags(note);
    const stats = readStats(note);
    return {
      noteId: note.noteId || note.note_id || note.id || URL_HELPERS.extractNoteId(location.href) || '',
      title: (note.title || '').trim(),
      desc: (note.desc || '').trim(),
      author: {
        userId: userId,
        nickname: nickname,
        avatar: avatar,
      },
      publishTime: publishTime,
      _publishTimeSource: publishTime ? 'api_timestamp' : 'missing',
      _publishTimeRaw: readPublishTimeRaw(note),
      _publishTimeObservedAt: new Date().toISOString(),
      ipLocation: note.ipLocation || note.ip_location || '',
      tags: tags.names,
      _tagSource: 'api_taglist',
      _tagsRaw: tags.raw,
      url: resolveNoteUrl(note),
      mediaType: hasVideo ? (images.length ? 'mixed' : 'video') : 'image',
      imageCount: images.length,
      imageList: images,
      hasVideo: hasVideo,
      video: hasVideo
        ? {
            url: pickBestVideoUrl(note),
            cover: (note.video && note.video.cover && note.video.cover.urlDefault) || (images[0] && images[0].url) || '',
            duration: (note.video && note.video.duration) || 0,
            streams: extractVideoStreams(note),
          }
        : null,
      stats: stats.values,
      _statsSource: hasAnyStat(stats.values) ? 'api' : 'missing',
      _statsRaw: stats.raw,
      // 作者侧统计（粉丝数/笔记数/简介/认证）不在笔记详情载荷中，见 docs/DESIGN.md
      _author: {
        userId: userId,
        nickname: nickname,
        avatar: avatar,
        profileUrl: userId ? 'https://www.xiaohongshu.com/user/profile/' + userId : '',
        fansCount: null,
        noteCount: null,
        bio: null,
        verified: null,
        source: 'note_card',
      },
    };
  }

  // ---------- DOM 侧：容器检测 ----------
  // 常见笔记详情容器对应的特征（选择器片段 + 用于诊断的标签）
  const CONTAINER_PATTERNS = [
    { sel: '#noteContainer', tag: 'id=noteContainer' },
    { sel: '.note-container', tag: 'class=note-container' },
    { sel: '[class*="note-detail"]', tag: 'class~=note-detail' },
    { sel: '[class*="noteDetail"]', tag: 'class~=noteDetail' },
    { sel: '.note-content', tag: 'class=note-content' },
    { sel: '#detail', tag: 'id=detail' },
    { sel: '.feed-detail', tag: 'class=feed-detail' },
    { sel: '.swiper-container', tag: 'class=swiper-container' },
    { sel: '.note-slider', tag: 'class=note-slider' },
  ];

  function findNoteContainers() {
    const found = [];
    for (const p of CONTAINER_PATTERNS) {
      try {
        document.querySelectorAll(p.sel).forEach((el) => {
          if (!found.some((c) => c.el === el)) found.push({ el, sel: p.sel, tag: p.tag });
        });
      } catch (e) {
        // 忽略无效选择器
      }
    }
    return found;
  }

  // 从容器评分：含标题 + 图片 的优先
  function scoreContainer(c) {
    let score = 0;
    const textLen = (c.el.textContent || '').trim().length;
    if (c.el.querySelector('.title, #detail-title, .note-content, h1, [class*="title"]')) score += 3;
    if (c.el.querySelector('img')) score += 2;
    if (textLen > 40) score += 1;
    if (c.el.querySelector('video, .swiper-slide')) score += 1;
    return score;
  }

  function pickBestContainer() {
    const list = findNoteContainers();
    if (!list.length) return null;
    list.sort((a, b) => scoreContainer(b) - scoreContainer(a));
    return list[0];
  }

  function textOf(el) {
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function getNoteIdFromDom(root) {
    const el =
      (root && root.querySelector && root.querySelector('[data-note-id], [data-noteid], [data-noteId]')) ||
      document.querySelector('[data-note-id], [data-noteid], [data-noteId]');
    if (el) return el.getAttribute('data-note-id') || el.getAttribute('data-noteid') || el.getAttribute('data-noteId') || '';
    return URL_HELPERS.extractNoteId(location.href) || '';
  }

  // 判断是一张"笔记内容图"（而非头像/评论图/UI 静态图）
  // 笔记图特征：URL 来自 notes_pre_post 且带 !nd_dft_ 这种格式标记；或大尺寸、来自 sns-webpic 的笔记资源
  function isNoteContentImage(src) {
    if (!src) return false;
    // 明确排除的
    if (/sns-avatar/.test(src)) return false;          // 头像
    if (/\/comment\//.test(src)) return false;          // 评论里的图
    if (/picasso-static/.test(src)) return false;       // UI 静态资源
    if (/fe-platform/.test(src)) return false;
    if (/!nc_n_/.test(src)) return false;               // 评论图格式标记
    // 保留的：带笔记图格式标记
    if (/!nd_dft|!nd_|notes_pre_post/.test(src)) return true;
    // 兜底：大尺寸笔记图
    if (/sns-webpic/.test(src) && !/avatar/.test(src)) return true;
    return false;
  }

  function extractImagesFromDom(root) {
    const raw = [];
    const seen = new Set();
    // 优先从笔记容器里取；容器取不到就全页取
    const scopes = root ? [root] : [pickBestContainer() && pickBestContainer().el, document].filter(Boolean);
    for (const scope of scopes) {
      try {
        scope.querySelectorAll('img').forEach((img) => {
          const src = img.getAttribute('src') || img.getAttribute('data-src') || img.currentSrc || '';
          if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
          if (!isNoteContentImage(src)) return;
          if (seen.has(src)) return;
          seen.add(src);
          raw.push({ url: src, width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
        });
      } catch (e) {
        // 忽略
      }
    }
    return raw;
  }

  function extractVideosFromDom(root) {
    const vids = [];
    const scope = root || document;
    scope.querySelectorAll('video, video source, [data-video-url]').forEach((v) => {
      const src = v.getAttribute('src') || v.getAttribute('data-video-url') || v.getAttribute('data-url') || '';
      if (src && src.startsWith('blob:')) return;
      if (src && src.startsWith('http') && !vids.includes(src)) vids.push(src);
    });
    return vids;
  }

  // 从正文解析话题标签：#xxx（清洗尾部标点，如 "#露营，" -> "露营"）
  function extractTagsFromDesc(desc) {
    if (!desc) return [];
    const matches = desc.match(/#([^\s#]+)/g) || [];
    return matches
      .map((m) => m.replace(/^#/, '').replace(/[，。！？、；：,.!?;:)\]】”"']+$/, ''))
      .filter(Boolean);
  }

  // DOM 侧作者 id：从作者主页链接反解
  function findUserIdInDom(root) {
    try {
      const scope = root && root.querySelector ? root : document;
      const a = scope.querySelector('a[href*="/user/profile/"]') || document.querySelector('a[href*="/user/profile/"]');
      const href = a ? a.getAttribute('href') || '' : '';
      const m = href.match(/\/user\/profile\/([0-9a-zA-Z]+)/);
      if (m) return m[1];
    } catch (e) {
      // 忽略
    }
    return '';
  }

  // DOM 侧绝对日期："2024-06-01" / "2024年6月1日" / 今年内只显示 "06-09"
  // 取当地正午，避免 UTC 转换后日期被推到前一天
  function parseAbsoluteDate(text, observedAt) {
    if (!text) return null;
    const t = String(text).trim();
    let y = 0, mo = 0, d = 0;
    const full = t.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
    if (full) {
      y = Number(full[1]);
      mo = Number(full[2]);
      d = Number(full[3]);
    } else {
      // "06-09" 这类缺年份的写法：按观测年份补，若落在未来（跨年）则退回上一年
      const md = t.match(/^(\d{1,2})[-/月](\d{1,2})/);
      if (!md) return null;
      mo = Number(md[1]);
      d = Number(md[2]);
      const obs = observedAt ? new Date(observedAt) : new Date();
      y = obs.getFullYear();
      const guess = new Date(y, mo - 1, d, 12, 0, 0);
      if (guess.getTime() - obs.getTime() > 24 * 3600 * 1000) y -= 1;
    }
    if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, mo - 1, d, 12, 0, 0);
    return isNaN(dt.getTime()) ? null : dt;
  }

  // 从 DOM 里抓交互统计数（兜底）：取不到返回 null，不再与真实的 0 混淆
  function extractStatsFromDom() {
    const values = { likeCount: null, collectCount: null, commentCount: null, shareCount: null };
    const raw = { likeCount: null, collectCount: null, commentCount: null, shareCount: null };
    const kw = {
      likeCount: ['like', 'likeCount', 'like-count', '点赞', '赞'],
      collectCount: ['collect', 'Collect', 'collectCount', '收藏'],
      commentCount: ['comment', 'Comment', 'commentCount', '评论'],
      shareCount: ['share', 'Share', 'shareCount', '分享', '转发'],
    };
    // 计数不会长成 "1/4"（图片序号）、"06-09"（日期）、"12:30"（时间），这里排除这类碎片；
    // 误抓一个非空错值比留下 null 危险得多（研究数据里错值不可事后发现）
    const getRaw = (s) => {
      if (!s) return null;
      const m = String(s).match(/(^|[^\d.,/:\-])(\d[\d,]*(?:\.\d+)?\s*[万亿wWkK]?)(?![\/:\-\d])/);
      return m ? m[2].replace(/\s+/g, '') : null;
    };
    const container = pickBestContainer();
    const scopes = container ? [container.el] : [document];
    for (const scope of scopes) {
      // 候选节点：类名 / aria-label / title 命中关键词，或其文本含数字
      const candidates = scope.querySelectorAll('[class*="like"],[class*="collect"],[class*="comment"],[class*="share"],[class*="count"],[class*="interact"],[class*="engag"],[aria-label],[title]');
      for (const node of candidates) {
        const label = (node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('title'))) || '';
        const t = textOf(node);
        for (const [key, needles] of Object.entries(kw)) {
          if (values[key] !== null) continue;
          const hit = needles.some((n) => label.indexOf(n) >= 0 || t.indexOf(n) >= 0);
          if (!hit) continue;
          // 优先取 label 里的数字，其次取文本数字
          const rawStr = getRaw(label) || getRaw(t);
          const val = num(rawStr);
          if (val != null) {
            values[key] = val;
            raw[key] = rawStr;
          }
        }
      }
    }
    return { values, raw };
  }

  function normalizeFromDom() {
    const container = pickBestContainer();
    const root = container ? container.el : document;

    const title =
      textOf(root.querySelector('#detail-title')) ||
      textOf(root.querySelector('[class*="title"]')) ||
      textOf(root.querySelector('h1'));
    const desc =
      textOf(root.querySelector('#detail-desc')) ||
      textOf(root.querySelector('[class*="desc"]')) ||
      textOf(root.querySelector('[class*="note-content"]'));
    const authorEl = root.querySelector('[class*="author"]');
    const nickname = authorEl
      ? textOf(authorEl.querySelector('.username, .name, .author-name, [class*="name"] span, span')) || ''
      : '';
    const userId = findUserIdInDom(root);
    const dateEl = root.querySelector('.date, [class*="time"], [class*="date"], [class*="publish"]');
    const publishHuman = textOf(dateEl);

    const noteId = getNoteIdFromDom(root);
    const images = extractImagesFromDom(root);
    const vids = extractVideosFromDom(root);
    const stats = extractStatsFromDom();

    // 拆出 IP 属地（"6天前 广东" / "2024-06-01 广东" -> 属地="广东"）
    let publishText = publishHuman;
    let ipLocation = '';
    if (publishHuman) {
      const parts = publishHuman.split(/\s+/);
      if (parts.length >= 2) {
        const last = parts[parts.length - 1];
        // 末段必须不像时间/日期（"12:30"、"2024-06-01"），才当作属地
        const looksNumeric = /^[\d:./\-年月日]+$/.test(last);
        if (last && !looksNumeric) {
          ipLocation = last;
          publishText = parts.slice(0, -1).join(' ');
        }
      }
    }
    // 绝对日期转 ISO；相对时间（"6天前"）只能保留原文 + 记录观测时刻
    const observedAt = new Date().toISOString();
    const absDate = parseAbsoluteDate(publishText, observedAt);
    const publishIso = absDate ? absDate.toISOString() : '';
    const domTags = extractTagsFromDesc(desc);

    return {
      noteId: noteId,
      title,
      desc,
      author: { userId: userId, nickname, avatar: '' },
      publishTime: publishIso || publishText,
      _publishTimeSource: publishIso ? 'dom_absolute' : (publishText ? 'dom_relative' : 'missing'),
      _publishTimeRaw: publishHuman || null,
      _publishTimeObservedAt: observedAt,
      ipLocation,
      tags: domTags,
      _tagSource: 'dom_hashtag',
      _tagsRaw: domTags.map((name) => ({ name: name, type: '' })),
      url: resolveNoteUrl({ noteId: noteId }),
      mediaType: vids.length ? (images.length ? 'mixed' : 'video') : 'image',
      imageCount: images.length,
      imageList: images,
      hasVideo: vids.length > 0,
      video: vids.length
        ? { url: vids[0], cover: (images[0] && images[0].url) || '', duration: 0 }
        : null,
      stats: stats.values,
      _statsSource: hasAnyStat(stats.values) ? 'dom' : 'missing',
      _statsRaw: stats.raw,
      // DOM 回退拿不到作者统计，如实标注
      _author: {
        userId: userId,
        nickname: nickname,
        avatar: '',
        profileUrl: userId ? 'https://www.xiaohongshu.com/user/profile/' + userId : '',
        fansCount: null,
        noteCount: null,
        bio: null,
        verified: null,
        source: 'dom',
      },
    };
  }

  // 读取 network.js 缓存的 API URL 记录
  function readApiUrls() {
    try {
      const node = document.getElementById('xhs-note-api-urls');
      if (!node || !node.textContent) return [];
      const arr = JSON.parse(node.textContent);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  // ---------- 诊断 ----------
  function buildDiagnostics() {
    const apiCards = readApiCards();
    const urlNoteId = URL_HELPERS.extractNoteId(location.href);
    const targetCard = apiCards.find((c) => noteIdOf(c) === urlNoteId) || apiCards[0] || null;
    const containers = findNoteContainers().map((c) => ({
      tag: c.tag,
      sel: c.sel,
      className: (c.el.className && String(c.el.className).slice(0, 60)) || '',
      id: c.el.id || '',
      textLen: (c.el.textContent || '').trim().length,
      anchorText: (c.el.textContent || '').trim().slice(0, 30),
    }));
    return {
      url: location.href,
      // 页面状态由 main world 桥接过来，这里能看到的是"哪些笔记卡片来自状态"
      stateNoteIds: readStateIds(),
      hasNoteInState: readStateIds().indexOf(urlNoteId) >= 0,
      isNotePageByUrl: URL_HELPERS.isNotePage(location.href),
      urlNoteId,
      apiCachedNotes: apiCards.length,
      apiHasCurrentNote: apiCards.some((c) => noteIdOf(c) === urlNoteId),
      apiNoteIds: apiCards.map((c) => noteIdOf(c)),
      apiCardKeys: targetCard ? Object.keys(targetCard) : [],
      apiCardPreview: targetCard ? JSON.stringify(targetCard).slice(0, 300) : '',
      videoPreview: targetCard && targetCard.video ? JSON.stringify(targetCard.video) : '',
      apiInterceptedUrls: readApiUrls(),
      containers,
      imgCountInPage: document.querySelectorAll('img').length,
      hasDataNoteId: !!document.querySelector('[data-note-id], [data-noteid], [data-noteId]'),
    };
  }

  // 若 API/STATE 拿不到图片，从 DOM 的笔记轮播区补图
  function enrichImagesFromDom(data) {
    if (data.imageList && data.imageList.length) return data;
    const slider = document.querySelector('.note-slider, .swiper-container, #noteContainer [class*="swiper"]');
    const imgs = extractImagesFromDom(slider);
    if (imgs.length) {
      data.imageList = imgs;
      data.imageCount = imgs.length;
      if (!data.mediaType || data.mediaType === 'unknown') data.mediaType = 'image';
      if (!data.hasVideo) data.hasVideo = false;
    }
    return data;
  }

  // ---------- 评论注入 ----------
  // 数据来自 main world 桥接（页面状态里的首屏评论 + 滚动时页面自己请求的评论接口）。
  // 不自动滚动：只采页面已经加载的部分，完整性与否如实标注，不假装是全量。
  function attachComments(data) {
    const cm = readComments();
    if (!cm || !cm.noteId || cm.noteId !== data.noteId) {
      data._comments = null;
      return data;
    }
    const list = Array.isArray(cm.list) ? cm.list : [];
    // "作者本人回复"除了平台的 showTags，还能直接按 userId 判定——比依赖那面旗子更可靠
    // （实测：接口返回的那份不带 showTags，只靠旗子会把作者回复标成 false）
    const authorId = (data._author && data._author.userId) || (data.author && data.author.userId) || '';
    if (authorId) {
      for (const c of list) {
        if (!c.isAuthor && c.userId && c.userId === authorId) c.isAuthor = true;
      }
    }
    const declared = data.stats && data.stats.commentCount != null ? data.stats.commentCount : null;
    const replies = list.filter((c) => c && c.parentId).length;
    const topLevel = list.length - replies;
    const hasMore = cm.hasMore === undefined ? null : cm.hasMore;
    data._comments = {
      meta: {
        capturedCount: list.length,
        topLevel: topLevel,
        replies: replies,
        declaredTotal: declared,
        hasMore: hasMore,
        // 完整性用"保守判据"，宁可标不完整也不假装采全：
        //  ① hasMore === false —— 平台自己的分页信号，但它可能只是初始默认值
        //  ② 且 扁平条数 ≥ 平台声明的总数
        // 两个都满足才敢说完整。实测教训：某笔记顶层只加载 5 条、平台却报 11 条
        //（平台的总数把回复也算进去，而回复要点开"展开 N 条回复"才会加载），
        // 只信分页信号会把这种"其实没采全"标成完整。
        complete: hasMore === false && (declared == null || list.length >= declared),
        sources: Array.isArray(cm.sources) ? cm.sources : [],
        capturedAt: cm.at ? new Date(cm.at).toISOString() : new Date().toISOString(),
      },
      list: list,
    };
    return data;
  }

  // ---------- 溯源自描述注入 ----------  // 单点注入：两条生效的写盘路径通过 { ...note } 自动继承，无需各自维护字段
  function attachProvenance(data, report, apiCard, noteId) {
    const sch = S();
    const diag = (report && report.diagnostics) || {};
    const container = (diag.containers && diag.containers[0]) || null;
    data._schemaVersion = sch ? sch.SCHEMA_VERSION : 2;
    data._pluginVersion = sch ? sch.pluginVersion() : '0.2.0';
    data._captureId = sch && sch.newCaptureId ? sch.newCaptureId() : 'cap_' + Date.now().toString(36);
    data._extraction = {
      strategy: (report && report.strategyUsed) || 'UNKNOWN',
      stateSourcePath: (report && report.stateSourcePath) || '',
      noteIdMismatch: !!(report && report.noteIdMismatch),
      urlNoteId: diag.urlNoteId || '',
      pickedNoteId: (report && report.pickedNoteId) || (apiCard ? noteIdOf(apiCard) : (data.noteId || noteId || '')),
      warnings: (report && report.warnings) || [],
      pageUrl: location.href,
      container: container ? container.tag : '',
      extractedAt: new Date().toISOString(),
    };
    if (!data._author) {
      data._author = {
        userId: (data.author && data.author.userId) || '',
        nickname: (data.author && data.author.nickname) || '',
        avatar: (data.author && data.author.avatar) || '',
        profileUrl: '',
        fansCount: null,
        noteCount: null,
        bio: null,
        verified: null,
        source: 'unknown',
      };
    }
    data._source = resolveSource();
    // 评论：正文另存 comments.json，metadata 里只留一份可索引的摘要
    attachComments(data);
    // 来源如实区分：统计数可能来自 API 响应，也可能来自页面状态（SSR 直开页）
    if (data._statsSource === 'api' && report && report.strategyUsed === 'INITIAL_STATE') {
      data._statsSource = 'state';
    }
    data._collection = {
      collectorId: syncCache.collector.collectorId || '',
      accountLabel: syncCache.collector.accountLabel || '',
      accountSource: syncCache.collector.accountSource || 'none',
    };
    // 作者层面变量用"看到过主页时"缓存下来的值补齐（粉丝数是时间敏感变量，过期不候）。
    // 字段清单复用 schema 的 AUTHOR_VALUE_FIELDS，避免这里和作者文件两处各列一份。
    const uid = data._author.userId || (data.author && data.author.userId) || '';
    const prof = uid ? syncCache.authors[uid] : null;
    if (prof) {
      const a = data._author;
      const fields = (sch && sch.AUTHOR_VALUE_FIELDS) || Object.keys(prof);
      for (const k of fields) {
        if (a[k] == null && prof[k] != null) a[k] = prof[k];
      }
      a.profileCapturedAt = prof.capturedAt;
      a.profileSource = prof.source;
      a.source = (a.source || 'unknown') + '+profile_cache';
    }
    data._fieldsMissing = sch && sch.missingFields ? sch.missingFields(data) : [];
    return data;
  }

  // ---------- 主入口 ----------
  function extract() {
    // 先把桥上看到的作者资料与检索关键词收进缓存（用户可能刚在作者主页/检索页待过）
    collectProfiles();
    collectSearchHint();
    const noteIdFromUrl = URL_HELPERS.extractNoteId(location.href) || '';
    const apiCards = readApiCards();
    // 当前笔记：优先 URL noteId 精确匹配；否则用「最近抓取」的一条（弹窗打开时才拉取，最新即当前）。
    // 不用 DOM 的 data-note-id 做匹配（可能残留上一笔记，导致归档到旧笔记）。
    const apiCard = noteIdFromUrl ? (apiCards.find((c) => noteIdOf(c) === noteIdFromUrl) || null) : null;
    const card = apiCard || (apiCards.length ? apiCards[apiCards.length - 1] : null);
    const stateIds = readStateIds();
    const noteId = noteIdFromUrl
      || (card && noteIdOf(card))
      || getNoteIdFromDom(document)
      || '';
    const report = { strategyUsed: '', warnings: [], diagnostics: buildDiagnostics() };
    report.expandedNoteId = noteId;
    // 唯一的"数据可能张冠李戴"信号：实际选中的笔记 id 与 URL 不一致 —— 不论它来自 API 响应
    // 还是页面状态，都会把 A 笔记的元数据写进 B 笔记的目录。
    // （旧代码另有一个 isStale，在"完全走 DOM 回退"时也为 true；那是噪音不是危险，已删除。）
    const pickedId = (card && noteIdOf(card)) || '';
    report.pickedNoteId = pickedId;
    report.noteIdMismatch = !!noteIdFromUrl && !!pickedId && pickedId !== noteIdFromUrl;

    let data = null;
    if (card) {
      data = normalizeFromState(card);
      // 来源如实区分：同一个管道，但卡片可能来自 API 响应，也可能来自页面状态（SSR 直开）
      const fromState = stateIds.indexOf(noteIdOf(card)) >= 0;
      report.strategyUsed = fromState ? 'INITIAL_STATE' : 'API';
      report.stateSourcePath = fromState
        ? 'window.__INITIAL_STATE__.note.noteDetailMap[<id>].note（经 main world 桥接）'
        : 'note API cache';
      if (report.noteIdMismatch) report.warnings.push('当前笔记 id 未匹配到对应缓存，暂展示最近抓取的笔记（可能为上一篇）。');
    } else {
      data = normalizeFromDom();
      report.strategyUsed = 'DOM';
      report.warnings.push('未拿到笔记数据（API 与页面状态都没有），已用 DOM 回退——统计数与属地会缺失。');
    }

    // 元数据来自 API/状态，但若缺图，用 DOM 轮播补
    data = enrichImagesFromDom(data);

    // 调试辅助：视频地址取不到时，把原始 video 对象带上，便于对照真实结构
    if (data.hasVideo && data.video && !data.video.url && card && card.video) {
      const rv = JSON.parse(JSON.stringify(card.video));
      delete rv.media_v2; // media_v2 是一个巨大的冗余 JSON 串，剔除避免撑爆数据
      data._rawVideo = rv;
    }

    if (!data.noteId) data.noteId = noteId;
    attachProvenance(data, report, card, noteId);
    const ok = !!(data && (data.noteId || data.title || data.imageCount));
    return { ok, strategy: report.strategyUsed, data, report, ts: Date.now() };
  }

  window.__XHS_EXTRACT__ = {
    extract,
    detectNoteVisible: () => !!(
      findNoteContainers().length
      || URL_HELPERS.isNotePage(location.href)
      || readApiCards().length
      || currentProfileUserId() // 作者主页也是可操作页面（保存当前作者），否则工具栏会在这里消失
    ),
    URL: URL_HELPERS,
    helpers: {
      readApiCards, readStateIds, readComments, resolveSource, attachProvenance,
      collectProfiles, collectSearchHint, flushAuthorCache, currentProfileUserId, resolveProfileUserId,
      readProfileFromDom, flushCurrentAuthor,
      syncCache,
    },
  };
})();
