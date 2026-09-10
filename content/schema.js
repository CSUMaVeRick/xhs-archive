/**
 * XHS Archive - 共享常量与溯源自描述助手（schema v2）
 * 加载位置：isolated world content script（manifest）、popup.html、manage.html。
 * 注意：MAIN world 脚本（content/network.js）没有 chrome.* 权限，不要在那里引用本文件。
 */
(function (global) {
  'use strict';

  const SCHEMA_VERSION = 3;
  const FALLBACK_PLUGIN_VERSION = '0.2.0';

  // 文件与目录约定
  const META_FILE = 'metadata.json';
  const ANNOTATION_FILE = 'annotation.json';
  const COMMENTS_FILE = 'comments.json';
  const AUTHORS_FILE = 'authors.json';
  const AUTHORS_HISTORY_MAX = 50; // 每位作者最多保留多少个历史快照
  const EXPORT_DIR = '_meta';
  const EXPORT_CSV = 'export.csv';
  const EXPORT_JSONL = 'export.jsonl';

  // chrome.storage.local 键
  const STORAGE_KEYS = {
    collectorProfile: 'collectorProfile', // { collectorId, accountLabel, accountSource }
    keywordHint: 'keywordHint',           // { keyword, pageUrl, at }
    labelTaxonomy: 'labelTaxonomy',       // string[]
    collectComments: 'collectComments',   // bool：是否在面板上提供「展开评论」（默认 false）
    expandScope: 'expandScope',           // '3' | '5' | '10' | '20' | 'all'：展开范围
  };

  // 「展开评论」的默认与硬上限（这是插件里唯一一处刻意自动化，必须可停、可限）
  // 范围用一个下拉表达，避免"勾选框 + 输入框"两个控件争同一个语义
  const EXPAND_SCOPES = [
    { value: '3', label: '前 3 条回复' },
    { value: '5', label: '前 5 条回复' },
    { value: '10', label: '前 10 条回复' },
    { value: '20', label: '前 20 条回复' },
    { value: 'all', label: '全部展开' },
  ];
  const DEFAULT_EXPAND_SCOPE = '5';
  const EXPAND_MAX_CLICKS = 60;
  const EXPAND_MAX_MS = 3 * 60 * 1000;

  // 范围 → 实际点击上限（'all' 走硬上限）
  function expandLimitOf(scope, maxClicks) {
    if (scope === 'all') return maxClicks || EXPAND_MAX_CLICKS;
    const n = parseInt(scope, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, maxClicks || EXPAND_MAX_CLICKS) : 5;
  }

  // 靠文本识别"展开回复"，不记类名（抗改版）。
  // ⚠ 实测有两种文案：「展开 4 条回复」和「展开更多回复」（后者没有数字）——
  // 第一版只认带数字的，导致评论链展开一层后就停住了。
  // 锚定整串文本，避免误伤笔记正文的「展开全文」或评论框的「回复」按钮。
  function isExpandLabel(text) {
    const t = String(text || '').replace(/\s+/g, '');
    return /^(展开|查看更多|加载更多).{0,8}回复$/.test(t);
  }

  // 检索页关键词提示的有效期：超过则不回填，避免把上一次检索错记到新笔记上
  const KEYWORD_HINT_TTL_MS = 30 * 60 * 1000;

  const DEFAULT_LABELS = ['重点样本', '对照组', '疑似广告', '内容质量低', '待复核'];

  // schema v2 下"必然缺失"的字段：不是抓取失败，而是设计上不采集或平台不给。
  // 面板用它把恒亮的告警压成"本次真正没抓到的"，否则 10 项里 8 项是噪音。
  const STRUCTURAL_MISSING = [
    'source.sortOrder', 'source.resultRank',
    'author.fansCount', 'author.noteCount', 'author.bio', 'author.verified',
  ];

  // 归档时若缺少这些键，说明某条写盘路径漏了字段（弹窗会告警）
  const REQUIRED_META_KEYS = [
    '_schemaVersion', '_pluginVersion', '_captureId',
    '_extraction', '_author', '_publishTimeSource', '_tagSource', '_statsSource',
    '_source', '_collection', '_fieldsMissing', '_archiveRoot',
  ];

  // 管理页可编辑的标注字段
  const ANNOTATION_FIELDS = [
    'keywords', 'sortOrders', 'labels', 'exclude', 'excludeReason', 'note', 'annotatorId',
  ];

  // 排序方式取值候选（检索请求参数，人工补录用）
  const SORT_ORDER_OPTIONS = [
    { value: 'general', label: '综合' },
    { value: 'time_descending', label: '最新' },
    { value: 'popularity_descending', label: '最多点赞' },
    { value: 'comment_descending', label: '最多评论' },
    { value: 'collect_descending', label: '最多收藏' },
  ];

  // 作者记录字段：一处定义，extract.js 用它产出、archive.js 用它合并、导出用它出列
  const AUTHOR_FIELDS = [
    'userId', 'nickname', 'profileUrl', 'redId',
    'fansCount', 'followsCount', 'noteCount', 'interactionCount',
    'bio', 'verified', 'verifyText', 'ipLocation', 'source',
  ];
  // 构成"一次观测"的字段：只有这些变了才算真变化，才写 history
  const AUTHOR_VALUE_FIELDS = [
    'nickname', 'redId', 'fansCount', 'followsCount',
    'noteCount', 'interactionCount', 'bio', 'verified', 'verifyText', 'ipLocation',
  ];

  function sameAuthorValues(a, b) {
    return AUTHOR_VALUE_FIELDS.every((k) => {
      const x = a && a[k] != null ? a[k] : null;
      const y = b && b[k] != null ? b[k] : null;
      return x === y;
    });
  }

  function authorSnapshot(src) {
    const out = {};
    for (const k of AUTHOR_FIELDS) if (src && src[k] !== undefined) out[k] = src[k];
    out.capturedAt = (src && src.capturedAt) || null;
    return out;
  }

  // 合并进 authors.json。两条规矩：
  //  ① 程序只覆盖自己认识的键 —— 你手工加的字段（领域、备注…）一律保留；
  //  ② 传入的 null/undefined 不覆盖已有的非 null 值 —— 一份残缺载荷不该抹掉已知数据。
  function mergeAuthors(existing, incoming, now) {
    const iso = now || new Date().toISOString();
    const authors = Object.assign({}, (existing && existing.authors) || {});
    let added = 0, changed = 0, confirmed = 0;
    for (const rec of incoming || []) {
      if (!rec || !rec.userId) continue;
      const old = authors[rec.userId] || null;
      const next = Object.assign({}, old || {});
      for (const k of AUTHOR_FIELDS) {
        if (k === 'userId') continue;
        const v = rec[k];
        if (v === undefined || v === null) continue;
        next[k] = v;
      }
      next.userId = rec.userId;
      next.checkedAt = iso;
      if (!old) {
        next.capturedAt = iso;
        next.history = [];
        added++;
      } else if (sameAuthorValues(old, next)) {
        next.capturedAt = old.capturedAt || iso;
        next.history = old.history || [];
        confirmed++;
      } else {
        next.capturedAt = iso;
        next.history = (old.history || []).concat([authorSnapshot(old)]).slice(-AUTHORS_HISTORY_MAX);
        changed++;
      }
      authors[rec.userId] = next;
    }
    return { authors: authors, added: added, changed: changed, confirmed: confirmed };
  }

  // 从作者表里移除某个 userId（用于清掉误收的"登录者本人"记录）
  function removeAuthor(authors, userId) {
    const out = Object.assign({}, authors || {});
    if (!userId || !out[userId]) return { authors: out, removed: false };
    delete out[userId];
    return { authors: out, removed: true };
  }

  // 作者视图的数据装配：把 authors.json 与已加载的笔记做关联（纯函数，便于单测）。
  // 关联键一律用 userId —— 昵称会改，id 不会。
  function buildAuthorRows(authorsMap, notes) {
    const agg = {};
    for (const n of notes || []) {
      const meta = (n && n.meta) || {};
      const uid = (meta._author && meta._author.userId) || (meta.author && meta.author.userId) || '';
      if (!uid) continue;
      const at = meta._archiveTime || '';
      const cur = agg[uid] || (agg[uid] = { count: 0, first: '', last: '' });
      cur.count++;
      if (at && (!cur.first || at < cur.first)) cur.first = at;
      if (at && at > cur.last) cur.last = at;
    }
    return Object.keys(authorsMap || {}).map((id) => {
      const a = authorsMap[id] || {};
      const uid = a.userId || id;
      const s = agg[uid] || { count: 0, first: '', last: '' };
      return Object.assign({}, a, {
        userId: uid,
        archivedNotes: s.count,
        firstArchivedAt: s.first,
        lastArchivedAt: s.last,
        historyCount: (a.history || []).length,
      });
    });
  }

  function authorsFileShell(existing, authors, now) {
    const out = Object.assign({}, existing || {}, {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: now || new Date().toISOString(),
      authors: authors,
    });
    // 清掉早期版本写进文件里的说明字段：数据文件里不该有注释（规则写在 README 里）
    delete out._readme;
    return out;
  }

  const AUTHOR_EXPORT_COLUMNS = [
    'userId', 'nickname', 'redId', 'fansCount', 'followsCount',
    'noteCount', 'interactionCount', 'bio', 'verified', 'verifyText',
    'ipLocation', 'profileUrl', 'source', 'capturedAt', 'checkedAt', 'historyCount',
  ];

  function authorExportRow(rec) {
    const r = rec || {};
    const row = {};
    for (const k of AUTHOR_EXPORT_COLUMNS) {
      if (k === 'historyCount') { row[k] = (r.history || []).length; continue; }
      if (k === 'verified') { row[k] = r.verified == null ? '' : (r.verified ? 1 : 0); continue; }
      row[k] = r[k] == null ? '' : r[k];
    }
    return row;
  }

  // 导出 CSV 列（顺序即列顺序）
  const EXPORT_COLUMNS = [
    'captureId', 'noteId', 'folder', 'archiveDate', 'title',
    'authorNickname', 'authorUserId', 'publishTime', 'publishTimeSource', 'publishTimeRaw',
    'ipLocation', 'tags', 'mediaType', 'imageCount', 'hasVideo',
    'likeCount', 'collectCount', 'commentCount', 'shareCount', 'statsSource',
    'keyword', 'keywordSource', 'autoKeyword', 'resultRank', 'sortOrders', 'labels',
    'sourceType', 'sourceLabel', 'sourceRaw',
    'exclude', 'excludeReason', 'annoNote', 'annotatorId', 'annoUpdatedAt',
    'extractStrategy', 'noteIdMismatch', 'imageFiles', 'videoFile',
    'imageOk', 'imageFail', 'videoOk',
    'commentsCaptured', 'commentsTotal', 'commentsComplete',
    'pluginVersion', 'schemaVersion', 'missingFields', 'url',
  ];

  function pluginVersion() {
    try {
      const m = global.chrome && global.chrome.runtime && global.chrome.runtime.getManifest
        ? global.chrome.runtime.getManifest()
        : null;
      if (m && m.version) return m.version;
    } catch (e) {
      // 忽略：非扩展环境
    }
    return FALLBACK_PLUGIN_VERSION;
  }

  function newCaptureId() {
    try {
      if (global.crypto && global.crypto.randomUUID) return 'cap_' + global.crypto.randomUUID();
    } catch (e) {
      // 忽略，走兜底
    }
    return 'cap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function emptyAnnotation(noteId) {
    const now = new Date().toISOString();
    return {
      noteId: noteId || '',
      captureIds: [],
      keywords: [],
      sortOrders: [],
      labels: [],
      exclude: false,
      excludeReason: '',
      note: '',
      annotatorId: '',
      createdAt: now,
      updatedAt: now,
    };
  }

  // 把来源不明的数值文本解析为整数：兼容 "1234" / "1,234" / "1.2万" / "3.5k"
  // 拒绝多位前导零（"06" 这类日期/编号碎片）：计数不可能长这样，误抓成 6 比 null 危险
  function parseCount(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).replace(/[,\s]/g, '');
    if (!s || /^0\d/.test(s)) return null;
    const m = s.match(/^([0-9]*\.?[0-9]+)\s*([万亿wWkK]?)/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    const unit = m[2];
    if (unit === '万' || unit === 'w' || unit === 'W') n *= 10000;
    else if (unit === '亿') n *= 100000000;
    else if (unit === 'k' || unit === 'K') n *= 1000;
    return Math.round(n);
  }

  // 逐个判断缺失字段，供 metadata._fieldsMissing 使用
  function missingFields(data) {
    const miss = [];
    const d = data || {};
    // 来源（抽样框架）：只有"从搜索进来但没拿到检索词"才算缺；从主页/推荐流进来的本就没有关键词
    const src = d._source || d._search || {};
    if (!src.type || src.type === 'unknown') miss.push('source.type');
    if (src.type === 'search' && !src.keyword) miss.push('source.keyword');
    if (src.sortOrder == null) miss.push('source.sortOrder');
    if (src.resultRank == null) miss.push('source.resultRank');

    const a = d._author;
    if (!a) {
      miss.push('author');
    } else {
      if (!a.userId) miss.push('author.userId');
      if (a.fansCount == null) miss.push('author.fansCount');
      if (a.noteCount == null) miss.push('author.noteCount');
      if (a.bio == null) miss.push('author.bio');
      if (a.verified == null) miss.push('author.verified');
    }

    if (!d.publishTime || d._publishTimeSource === 'dom_relative' || d._publishTimeSource === 'missing') {
      miss.push('publishTime.iso');
    }
    if (!d.ipLocation) miss.push('ipLocation');
    if (!Array.isArray(d.tags) || !d.tags.length) miss.push('tags');

    const s = d.stats || {};
    for (const k of ['likeCount', 'collectCount', 'commentCount', 'shareCount']) {
      if (s[k] == null) miss.push('stats.' + k);
    }

    if (!d.imageCount) miss.push('images');

    // 评论：只有"完全没采到评论区"才算缺失；采到了但一条都没有，说明这篇本来就没评论
    if (!d._comments || !d._comments.meta) miss.push('comments');
    return miss;
  }

  // metadata 保持轻量（管理页要遍历所有 metadata.json），评论正文另存 comments.json。
  // 写盘前用它把 _comments 拆成两部分。
  function splitComments(note) {
    const c = note && note._comments;
    return {
      meta: (c && c.meta) || null,
      list: (c && Array.isArray(c.list)) ? c.list : [],
    };
  }

  // 样本来源（抽样框架）：这篇笔记是从哪个入口拿到的。
  // 平台自己在 URL 里就给了线索：xsec_source=pc_search / pc_user / pc_note_detail_r10 …
  // 认不出来的原样保留在 raw 里，绝不猜。
  const SOURCE_TYPES = [
    { test: /search/i, type: 'search', label: '搜索' },
    { test: /user|creator|profile/i, type: 'profile', label: '作者主页' },
    { test: /note_detail|related/i, type: 'related', label: '笔记内推荐' },
    { test: /feed|homepage|recommend|explore/i, type: 'feed', label: '推荐流' },
  ];

  function sourceTypeOf(raw) {
    const r = String(raw || '').trim();
    if (!r) return { type: 'direct', label: '直接打开' };
    for (const s of SOURCE_TYPES) {
      if (s.test.test(r)) return { type: s.type, label: s.label };
    }
    return { type: 'other', label: '其他入口' };
  }

  // 抽取结果签名：忽略"每次抽取都会变"的字段。
  // 不这么做，调用方（页面面板）会因时间戳不停变而每几百毫秒整体重渲染，
  // 表现就是「调试信息点开立刻收起」+ 控制台刷屏。
  // 新增易变字段时必须加进这两个清单，并让 tests/selftest.js 的双次抽取断言继续通过。
  const VOLATILE_KEYS = ['_captureId', '_publishTimeObservedAt'];
  const VOLATILE_PATHS = [['_extraction', 'extractedAt'], ['_source', 'capturedAt']];

  function stableSig(data, strategy) {
    const d = Object.assign({}, data || {});
    for (const k of VOLATILE_KEYS) delete d[k];
    for (const [obj, key] of VOLATILE_PATHS) {
      if (d[obj]) d[obj] = Object.assign({}, d[obj], { [key]: '' });
    }
    return JSON.stringify(d) + '|' + (strategy || '');
  }

  function checkMetaKeys(meta) {
    const m = meta || {};
    return REQUIRED_META_KEYS.filter((k) => !(k in m));
  }

  // 关键词取值：人工标注优先，其次自动捕获。
  // 兼容 schema v2 的老记录（那时叫 _search、没有 source.type）
  function effectiveKeyword(meta, anno) {
    const manual = anno && Array.isArray(anno.keywords) ? anno.keywords.filter(Boolean) : [];
    if (manual.length) return { keywords: manual, source: 'manual' };
    const s = (meta && (meta._source || meta._search)) || {};
    const auto = s.keyword ? [s.keyword] : [];
    if (auto.length) return { keywords: auto, source: s.keywordSource || 'auto' };
    return { keywords: [], source: 'none' };
  }

  // 来源类型/标签：兼容老记录（老记录只有 keywordSource）
  function sourceOf(meta) {
    const s = (meta && (meta._source || meta._search)) || {};
    if (s.type) return { type: s.type, label: s.label || '', raw: s.raw || '' };
    if (s.keyword) return { type: 'search', label: '搜索', raw: '' };
    return { type: 'unknown', label: '未知', raw: '' };
  }

  function csvCell(v) {
    if (v == null) return '""';
    const s = String(v).replace(/\r\n|\r|\n/g, ' ').replace(/"/g, '""');
    return '"' + s + '"';
  }

  function toCsv(columns, rows) {
    const cols = columns || EXPORT_COLUMNS;
    const head = cols.map(csvCell).join(',');
    const body = (rows || []).map((r) => cols.map((c) => csvCell(r[c])).join(',')).join('\r\n');
    return head + '\r\n' + body + (rows && rows.length ? '\r\n' : '');
  }

  global.XHS_SCHEMA = {
    SCHEMA_VERSION,
    META_FILE,
    ANNOTATION_FILE,
    COMMENTS_FILE,
    AUTHORS_FILE,
    AUTHORS_HISTORY_MAX,
    splitComments,
    AUTHOR_FIELDS,
    AUTHOR_VALUE_FIELDS,
    AUTHOR_EXPORT_COLUMNS,
    mergeAuthors,
    removeAuthor,
    buildAuthorRows,
    authorsFileShell,
    authorExportRow,
    EXPORT_DIR,
    EXPORT_CSV,
    EXPORT_JSONL,
    STORAGE_KEYS,
    EXPAND_SCOPES,
    DEFAULT_EXPAND_SCOPE,
    expandLimitOf,
    EXPAND_MAX_CLICKS,
    EXPAND_MAX_MS,
    isExpandLabel,
    KEYWORD_HINT_TTL_MS,
    DEFAULT_LABELS,
    REQUIRED_META_KEYS,
    STRUCTURAL_MISSING,
    ANNOTATION_FIELDS,
    SORT_ORDER_OPTIONS,
    EXPORT_COLUMNS,
    pluginVersion,
    newCaptureId,
    emptyAnnotation,
    parseCount,
    missingFields,
    stableSig,
    sourceTypeOf,
    sourceOf,
    checkMetaKeys,
    effectiveKeyword,
    csvCell,
    toCsv,
  };
})(typeof window !== 'undefined' ? window : self);
