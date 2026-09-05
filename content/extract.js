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

  // ---------- 全局状态读取 ----------
  function readInitialState() {
    try {
      return window.__INITIAL_STATE__;
    } catch (e) {
      return undefined;
    }
  }

  // 读取 network.js(main world) 缓存到 DOM 的笔记 API 数据
  function readApiCards() {
    try {
      const node = document.getElementById('xhs-note-api');
      if (!node || !node.textContent) return [];
      const arr = JSON.parse(node.textContent);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  // 统一取笔记 id（兼容 id / noteId / note_id）
  function noteIdOf(o) {
    return (o && (o.id || o.noteId || o.note_id)) || '';
  }

  function resolveNoteFromState(rawState, noteId) {
    if (!rawState) return null;
    try {
      const key = noteId || URL_HELPERS.extractNoteId(location.href);
      const detailMap = rawState.note && rawState.note.noteDetailMap;
      if (detailMap) {
        if (key && detailMap[key]) return { note: detailMap[key].note, source: 'note.noteDetailMap[key].note' };
        const firstKey = Object.keys(detailMap)[0];
        if (firstKey && detailMap[firstKey] && detailMap[firstKey].note) {
          return { note: detailMap[firstKey].note, source: 'note.noteDetailMap[first].note' };
        }
      }
      if (rawState.note && rawState.note.note) return { note: rawState.note.note, source: 'note.note' };
      if (rawState.noteDetailMap) {
        const entry = (key && rawState.noteDetailMap[key]) || rawState.noteDetailMap[Object.keys(rawState.noteDetailMap)[0]];
        if (entry && entry.note) return { note: entry.note, source: 'noteDetailMap[key].note' };
      }
    } catch (e) {
      // 忽略，走 DOM
    }
    return null;
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

  const num = (v) => (typeof v === 'number' ? v : v == null ? 0 : parseInt(v, 10) || 0);
  function readStats(note) {
    // 小红书常把统计数放在 interactInfo 嵌套对象里
    const info = note.interactInfo || note.note_interact_info || note.interact_info || {};
    const pick = (a, b) => (a != null ? a : b);
    function read(camelTop, snakeTop, infoCamel, infoSnake) {
      return pick(
        pick(camelTop, snakeTop),
        pick(infoCamel, infoSnake)
      );
    }
    return {
      likeCount: num(read(note.likedCount, note.liked_count, info.likedCount, info.liked_count)),
      collectCount: num(read(note.collectedCount, note.collected_count, info.collectedCount, info.collected_count)),
      commentCount: num(read(note.commentCount, note.comment_count, info.commentCount, info.comment_count)),
      shareCount: num(read(note.shareCount, note.share_count, info.shareCount, info.share_count)),
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

  function normalizeTags(note) {
    const tagList = note.tagList || note.tag_list;
    if (!Array.isArray(tagList)) return [];
    return tagList.map((t) => (t && (t.name ?? t.title)) || '').filter(Boolean);
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
    return {
      noteId: note.noteId || note.note_id || note.id || URL_HELPERS.extractNoteId(location.href) || '',
      title: (note.title || '').trim(),
      desc: (note.desc || '').trim(),
      author: {
        userId: (note.user && (note.user.userId || note.user.user_id)) || '',
        nickname: (note.user && note.user.nickname) || '',
        avatar: (note.user && (note.user.avatar || note.user.avatarDefault || note.user.avatar_url)) || '',
      },
      publishTime: normalizeTime(note),
      ipLocation: note.ipLocation || note.ip_location || '',
      tags: normalizeTags(note),
      url: note.url || note.urlInfo || location.href,
      mediaType: hasVideo ? (images.length ? 'mixed' : 'video') : 'image',
      imageCount: images.length,
      imageList: images,
      hasVideo,
      video: hasVideo
        ? {
            url: pickBestVideoUrl(note),
            cover: (note.video && note.video.cover && note.video.cover.urlDefault) || (images[0] && images[0].url) || '',
            duration: (note.video && note.video.duration) || 0,
            streams: extractVideoStreams(note),
          }
        : null,
      stats: readStats(note),
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

  // 从正文解析话题标签：#xxx
  function extractTagsFromDesc(desc) {
    if (!desc) return [];
    const matches = desc.match(/#([^\s#]+)/g) || [];
    return matches.map((m) => m.replace(/^#/, '')).filter(Boolean);
  }

  // 从 DOM 里抓交互统计数：点赞/收藏/评论/分享（兜底）
  function extractStatsFromDom() {
    const res = { likeCount: 0, collectCount: 0, commentCount: 0, shareCount: 0 };
    const kw = {
      likeCount: ['like', 'likeCount', 'like-count', '点赞', '赞'],
      collectCount: ['collect', 'Collect', 'collectCount', '收藏'],
      commentCount: ['comment', 'Comment', 'commentCount', '评论'],
      shareCount: ['share', 'Share', 'shareCount', '分享', '转发'],
    };
    const getNum = (s) => {
      const m = (s || '').match(/[\d,]+/);
      return m ? parseInt(m[0].replace(/,/g, ''), 10) || 0 : 0;
    };
    const scopes = (pickBestContainer() && [pickBestContainer().el]) || [document];
    for (const scope of scopes) {
      // 候选节点：类名 / aria-label / title 命中关键词，或其文本含数字
      const candidates = scope.querySelectorAll('[class*="like"],[class*="collect"],[class*="comment"],[class*="share"],[class*="count"],[class*="interact"],[class*="engag"],[aria-label],[title]');
      for (const node of candidates) {
        const label = (node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('title'))) || '';
        const t = textOf(node);
        for (const [key, needles] of Object.entries(kw)) {
          if (res[key] !== 0) continue;
          const hit = needles.some((n) => label.indexOf(n) >= 0 || t.indexOf(n) >= 0);
          if (!hit) continue;
          // 优先取 label 里的数字，其次取文本数字
          const val = getNum(label) || getNum(t);
          if (val > 0) { res[key] = val; }
        }
      }
    }
    return res;
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
    const dateEl = root.querySelector('.date, [class*="time"], [class*="date"], [class*="publish"]');
    const publishHuman = textOf(dateEl);

    const images = extractImagesFromDom(root);
    const vids = extractVideosFromDom(root);
    const stats = extractStatsFromDom();

    // 拆出 IP 属地（如 "6天前 广东" -> time="6天前" 属地="广东"）
    let publishTime = publishHuman;
    let ipLocation = '';
    if (publishHuman) {
      const parts = publishHuman.split(/\s+/);
      // 常见："x天前"，"x小时前"，"刚刚"，"x分钟前"，后跟属地
      if (parts.length >= 2 && !/^\d{4}-\d{2}-\d{2}/.test(publishHuman)) {
        ipLocation = parts[parts.length - 1];
        publishTime = parts.slice(0, -1).join(' ');
      }
    }

    return {
      noteId: getNoteIdFromDom(root),
      title,
      desc,
      author: { userId: '', nickname, avatar: '' },
      publishTime,
      ipLocation,
      tags: extractTagsFromDesc(desc),
      url: location.href,
      mediaType: vids.length ? (images.length ? 'mixed' : 'video') : 'image',
      imageCount: images.length,
      imageList: images,
      hasVideo: vids.length > 0,
      video: vids.length
        ? { url: vids[0], cover: (images[0] && images[0].url) || '', duration: 0 }
        : null,
      stats,
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
      hasInitialState: !!readInitialState(),
      hasNoteInState: !!(readInitialState() && resolveNoteFromState(readInitialState(), urlNoteId)),
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

  // ---------- 主入口 ----------
  function extract() {
    const noteIdFromUrl = URL_HELPERS.extractNoteId(location.href) || '';
    const apiCards = readApiCards();
    // 当前笔记：优先 URL noteId 精确匹配；否则用「最近抓取」的一条（弹窗打开时才拉取，最新即当前）。
    // 不用 DOM 的 data-note-id 做匹配（可能残留上一笔记，导致归档到旧笔记）。
    let apiCard = noteIdFromUrl ? (apiCards.find((c) => noteIdOf(c) === noteIdFromUrl) || null) : null;
    if (!apiCard && apiCards.length) apiCard = apiCards[apiCards.length - 1];
    const noteId = noteIdFromUrl || (apiCard && noteIdOf(apiCard)) || getNoteIdFromDom(document) || '';
    const state = readInitialState();
    const resolved = resolveNoteFromState(state, noteId);
    const report = { strategyUsed: '', warnings: [], diagnostics: buildDiagnostics() };
    report.expandedNoteId = noteId;
    report.isStale = !apiCard || (!!noteId && noteIdOf(apiCard) !== noteId);

    let data = null;
    if (apiCard) {
      data = normalizeFromState(apiCard);
      report.strategyUsed = 'API';
      report.stateSourcePath = 'note API cache';
      if (report.isStale) report.warnings.push('当前笔记 id 未匹配到对应缓存，暂展示最近抓取的笔记（可能为上一篇）。');
    } else if (resolved && resolved.note) {
      data = normalizeFromState(resolved.note);
      report.strategyUsed = 'INITIAL_STATE';
      report.stateSourcePath = resolved.source;
    } else {
      data = normalizeFromDom();
      report.strategyUsed = 'DOM';
      report.warnings.push('未拿到 API / __INITIAL_STATE__ 的笔记数据，已用 DOM 回退。');
    }

    // 元数据来自 API/STATE，但若缺图，用 DOM 轮播补
    data = enrichImagesFromDom(data);

    // 调试辅助：视频地址取不到时，把原始 video 对象带上，便于对照真实结构
    if (data.hasVideo && data.video && !data.video.url && apiCard && apiCard.video) {
      const rv = JSON.parse(JSON.stringify(apiCard.video));
      delete rv.media_v2; // media_v2 是一个巨大的冗余 JSON 串，剔除避免撑爆数据
      data._rawVideo = rv;
    }

    if (!data.noteId) data.noteId = noteId;
    const ok = !!(data && (data.noteId || data.title || data.imageCount));
    return { ok, strategy: report.strategyUsed, data, report, ts: Date.now() };
  }

  window.__XHS_EXTRACT__ = {
    extract,
    detectNoteVisible: () => !!(findNoteContainers().length || URL_HELPERS.isNotePage(location.href) || readApiCards().length),
    URL: URL_HELPERS,
    helpers: { readInitialState, readApiCards },
  };
})();
