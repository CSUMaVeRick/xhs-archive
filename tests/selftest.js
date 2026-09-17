/**
 * XHS Archive 自检脚本（无需 npm install）
 *
 *   node tests/selftest.js
 *
 * 覆盖：
 *  ① 全部 JS 语法解析
 *  ② popup.js / manage.js 引用的 DOM id 是否在 HTML 或动态模板中存在
 *  ③ schema 必需字段是否在写盘路径上覆盖
 *  ④ EXPORT_COLUMNS 与 buildExportRows() 的 key 是否一一对应
 *  ⑤ ANNOTATION_FIELDS 与 cloneAnno() 的 key 是否一致
 *  ⑥ 三条写盘路径是否都带上 _archiveRoot
 *  ⑦ schema 纯函数单测（parseCount / toCsv / effectiveKeyword）
 *  ⑧ 在 vm 沙箱里用假 DOM 跑通 extract() 的 DOM 与 __INITIAL_STATE__ 两条路径，
 *     校验时间来源、标签清洗、统计数空值语义、错标闸门
 *  ⑨ 检索结果通道与粗糙采集的数据契约：字段路径摘要、请求 body 捕获、隐私闸门、
 *     以及"检索命中不进笔记缓存"这条架构约束
 *
 * 改动 content/extract.js、content/schema.js、manage.js 之后请跑一遍。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 同步 thenable：让 hook 里的 p.then / clone().json().then 在当前栈内跑完，
// 免得为了测 hook 把整个自检改成异步
function syncThen(v) {
  return { then: (fn) => syncThen(fn(v)), catch: () => syncThen(null) };
}

const root = path.join(__dirname, '..');
const jsFiles = [
  'content/schema.js', 'content/network.js', 'content/card.js',
  'content/extract.js', 'content/search.js', 'content/archive.js', 'content/main.js',
  'popup.js', 'manage.js', 'background.js',
];

let bad = 0;
for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  try {
    new vm.Script(src, { filename: f });
    console.log('syntax OK   ' + f);
  } catch (e) {
    bad++;
    console.log('syntax FAIL ' + f + ' :: ' + e.message);
  }
}

function idsUsedInJs(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const ids = new Set();
  for (const m of src.matchAll(/\$\('([^']+)'\)/g)) ids.add(m[1]);
  return ids;
}
function idsDeclaredInHtml(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  return new Set([...src.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
}
function idsDeclaredInJsTemplates(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  return new Set([...src.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
}

const pairs = [['popup.js', 'popup.html'], ['manage.js', 'manage.html']];
for (const [js, html] of pairs) {
  const used = idsUsedInJs(js);
  const declared = idsDeclaredInHtml(html);
  const dynamic = idsDeclaredInJsTemplates(js);
  const missing = [...used].filter((id) => !declared.has(id) && !dynamic.has(id));
  console.log(`${js} -> ${html}: 引用 ${used.size} 个 id，缺失 ${missing.length}${missing.length ? ' :: ' + missing.join(', ') : ''}`);
  if (missing.length) bad++;
}

// 交叉检查：schema 必需键在两条生效写盘路径里都被覆盖
const schema = fs.readFileSync(path.join(root, 'content/schema.js'), 'utf8');
const required = [...schema.matchAll(/'(_[A-Za-z]+)'/g)].map((m) => m[1]);
const archive = fs.readFileSync(path.join(root, 'content/archive.js'), 'utf8');
const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const extract = fs.readFileSync(path.join(root, 'content/extract.js'), 'utf8');
const uniq = [...new Set(required)].filter((k) => ['_schemaVersion', '_pluginVersion', '_captureId', '_extraction', '_author', '_publishTimeSource', '_tagSource', '_statsSource', '_source', '_collection', '_fieldsMissing', '_archiveRoot'].includes(k));
for (const k of uniq) {
  const inExtract = extract.includes(k);
  const inArchive = archive.includes(k);
  const inPopup = popup.includes(k);
  const ok = inExtract || (inArchive && inPopup);
  console.log(`${ok ? 'field OK  ' : 'field MISS'} ${k} :: extract=${inExtract} archive=${inArchive} popup=${inPopup}`);
  if (!ok) bad++;
}

// 在沙箱中加载 schema.js，取其导出的常量
const sandbox = { window: {}, crypto: { randomUUID: () => 'x' } };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'content/schema.js'), 'utf8'), sandbox, { filename: 'schema.js' });
const SCHEMA = sandbox.XHS_SCHEMA;

// 交叉检查 1：EXPORT_COLUMNS 与 buildExportRows() 的 key 必须一致
const manageSrc = fs.readFileSync(path.join(root, 'manage.js'), 'utf8');
const rowsBlock = manageSrc.slice(manageSrc.indexOf('function buildExportRows'));
const rowKeys = new Set([...rowsBlock.slice(0, rowsBlock.indexOf('\n}')).matchAll(/^\s{6}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]));
const cols = SCHEMA.EXPORT_COLUMNS;
const colsMissingInRows = cols.filter((c) => !rowKeys.has(c));
const rowsMissingInCols = [...rowKeys].filter((k) => !cols.includes(k));
console.log(`export columns=${cols.length} rowKeys=${rowKeys.size} 列无数据=${JSON.stringify(colsMissingInRows)} 数据无列=${JSON.stringify(rowsMissingInCols)}`);
if (colsMissingInRows.length || rowsMissingInCols.length) bad++;

// 交叉检查 2：ANNOTATION_FIELDS 与 cloneAnno() 的 key 必须一致（排除元数据键）
const cloneBlock = manageSrc.slice(manageSrc.indexOf('function cloneAnno'));
const cloneKeys = new Set([...cloneBlock.slice(0, cloneBlock.indexOf('\n}')).matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]));
const annoFields = new Set(SCHEMA.ANNOTATION_FIELDS);
const fieldMissing = SCHEMA.ANNOTATION_FIELDS.filter((f) => !cloneKeys.has(f));
console.log(`annotation fields=${annoFields.size} cloneKeys=${cloneKeys.size} 缺失=${JSON.stringify(fieldMissing)}`);
if (fieldMissing.length) bad++;

// 交叉检查 3：两条生效写盘路径必须带上 _archiveRoot
// （background.js 的归档分支无调用方，已删除，不再参与）
for (const file of ['content/archive.js', 'popup.js']) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const ok = /_archiveRoot:\s*\{\s*context:\s*'/.test(src);
  console.log(`${ok ? 'root OK  ' : 'root MISS'} ${file}`);
  if (!ok) bad++;
}

// ---------- schema 助手单测 ----------
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? 'unit OK  ' : 'unit FAIL'} ${label} :: ${a}${ok ? '' : ' != ' + e}`);
  if (!ok) bad++;
}
eq('parseCount 1.2万', SCHEMA.parseCount('1.2万'), 12000);
eq('parseCount 1,234', SCHEMA.parseCount('1,234'), 1234);
eq('parseCount 3.5k', SCHEMA.parseCount('3.5k'), 3500);
eq('parseCount abc', SCHEMA.parseCount('abc'), null);
eq('parseCount null', SCHEMA.parseCount(null), null);
eq('parseCount 0', SCHEMA.parseCount(0), 0);
eq('parseCount 前导零碎片', SCHEMA.parseCount('06'), null);
eq('parseCount 空串', SCHEMA.parseCount(''), null);
eq('csv 转义', SCHEMA.toCsv(['a'], [{ a: 'x,"y"\nz' }]).split('\r\n')[1], '"x,""y"" z"');
eq('effectiveKeyword 人工优先', SCHEMA.effectiveKeyword({ _search: { keyword: 'auto词' } }, { keywords: ['人工词'] }).source, 'manual');
eq('effectiveKeyword 回落自动', SCHEMA.effectiveKeyword({ _search: { keyword: 'auto词' } }, null).keywords, ['auto词']);

// ---------- 搜索结果页粗糙采集：契约纯函数 ----------
// 位次、去重、字段取舍都在这里定型，所以这些断言就是数据契约本身
const at1617 = new Date(2026, 8, 17, 16, 17).getTime();
eq('批次文件名', SCHEMA.searchFileName('新传论文发表', at1617, 'general'), '新传论文发表_20260917-1617_general');
eq('批次文件名 去掉路径非法字符', SCHEMA.searchFileName('a/b:c*d', at1617, 'general'), 'a_b_c_d_20260917-1617_general');
eq('批次文件名 缺检索词时不留空段', SCHEMA.searchFileName('', at1617, ''), '未识别_20260917-1617_general');
eq('筛选标签', SCHEMA.filterLabelOf([{ type: 'sort_type', tags: ['time_descending'] }, { type: 'filter_note_type', tags: ['不限'] }]), '排序依据 最新 · 笔记类型 不限');
eq('筛选标签 空输入', SCHEMA.filterLabelOf(null), '');
eq('卡片日期 今年内月-日', SCHEMA.parseCardDate('06-23', '2026-09-17T08:17:00.000Z').toISOString().slice(0, 10), '2026-06-23');
eq('卡片日期 完整日期', SCHEMA.parseCardDate('2025-06-18', '2026-09-17T08:17:00.000Z').toISOString().slice(0, 10), '2025-06-18');
eq('卡片日期 相对时间不猜', SCHEMA.parseCardDate('4天前', '2026-09-17T08:17:00.000Z'), null);
eq('卡片日期 跨年补年份退回上一年', SCHEMA.parseCardDate('12-18', '2026-01-05T08:00:00.000Z').toISOString().slice(0, 10), '2025-12-18');
eq('https 归一', SCHEMA.httpsUrl('http://sns-webpic-qc.xhscdn.com/a.jpg'), 'https://sns-webpic-qc.xhscdn.com/a.jpg');

const reducedNote = {
  id: '6a39f801000000002100ac4c', model_type: 'note', xsec_token: 'AB2wAYeR=',
  note_card: {
    display_title: '今天当心软的审稿人', type: 'normal',
    user: { user_id: 'u1', nickname: '新传语料库', avatar: 'http://a/av.jpg' },
    interact_info: { liked_count: '1.2万', collected_count: '3', comment_count: '2', shared_count: '2' },
    cover: { url_default: 'http://sns-webpic-qc.xhscdn.com/c.jpg' },
    image_list: [
      { info_list: [{ image_scene: 'WB_DFT', url: 'http://sns-webpic-qc.xhscdn.com/1.jpg' }, { image_scene: 'WB_PRV', url: 'http://sns-webpic-qc.xhscdn.com/1p.jpg' }] },
      { info_list: [{ image_scene: 'WB_DFT', url: 'http://sns-webpic-qc.xhscdn.com/2.jpg' }] },
    ],
    corner_tag_info: [{ type: 'publish_time', text: '06-23' }],
  },
};
const hitNote = SCHEMA.buildSearchHit(reducedNote, { seq: 7, rank: 7, rankAmongNotes: 6, page: 1, indexInPage: 7, seenAtRound: 1, capturedAt: '2026-09-17T08:17:02.000Z', observedAt: '2026-09-17T08:17:00.000Z' });
eq('命中 类型', hitNote.itemKind, 'note');
eq('命中 位次与页码', [hitNote.rank, hitNote.rankAmongNotes, hitNote.page, hitNote.indexInPage, hitNote.seenAtRound], [7, 6, 1, 7, 1]);
eq('命中 计数解析（1.2万）', hitNote.stats.likeCount, 12000);
eq('命中 计数原始串保留', hitNote.statsRaw.likeCount, '1.2万');
eq('命中 浏览量字段不透出', Object.keys(hitNote).filter((k) => k === 'liked' || k === 'collected'), []);
// 时间只到"日"：卡片上没有时分秒，就不编一个出来
// 时间：笔记 id 前 8 位十六进制是生成时刻（Unix 秒），精确到秒；
// 卡片文字只到日，用来跟 id 交叉校验（id 的格式非官方，对不上必须看得见）
eq('命中 发布时刻来自笔记 id', hitNote.publishTimestamp, '2026-06-23T03:05:37.000Z');
eq('命中 发布日按东八区取', hitNote.publishDate, '2026-06-23');
eq('命中 时间来源标为 note_id', hitNote.publishDateSource, 'note_id');
eq('命中 卡片文字给出的日另存一列', hitNote.publishDateCard, '2026-06-23');
eq('命中 id 与卡片一致时不报冲突', hitNote.publishDateConflict, false);
eq('命中 发布时间原文', hitNote.publishTimeRaw, '06-23');
eq('命中 观测锚点用响应到达时刻', hitNote.publishTimeObservedAt, '2026-09-17T08:17:00.000Z');
eq('命中 图集取默认图并转 https', hitNote.images, ['https://sns-webpic-qc.xhscdn.com/1.jpg', 'https://sns-webpic-qc.xhscdn.com/2.jpg']);
eq('命中 图集数量与笔记总图数不是一回事', hitNote.hitImageCount, 2);
eq('命中 封面', hitNote.coverUrl, 'https://sns-webpic-qc.xhscdn.com/c.jpg');
eq('命中 链接带 xsec_token', hitNote.url, 'https://www.xiaohongshu.com/search_result/6a39f801000000002100ac4c?xsec_token=AB2wAYeR%3D');
eq('命中 封面未下载时为 null', hitNote.coverFile, null);

// id 解码器本身：含 OpenCLI PR #485 公布的三个测试向量（独立实现，用来互相校验）
eq('id 时间戳 1', SCHEMA.dayStringCST(SCHEMA.noteIdTimestamp('697f6c74000000002103de17')), '2026-02-01');
eq('id 时间戳 2', SCHEMA.dayStringCST(SCHEMA.noteIdTimestamp('68e90be80000000004022e66')), '2025-10-10');
eq('id 时间戳 跨日按东八区', SCHEMA.dayStringCST(SCHEMA.noteIdTimestamp('69b739f00000000000000000')), '2026-03-16');
eq('id 时间戳 我们夹具那条（卡片写的 06-23）', SCHEMA.dayStringCST(SCHEMA.noteIdTimestamp('6a39f801000000002100ac4c')), '2026-06-23');
eq('id 不是 24 位十六进制时不猜', SCHEMA.noteIdTimestamp('abcdef'), null);
eq('id 里出现非十六进制字符时不猜（格式变了）', SCHEMA.noteIdTimestamp('zz39f801000000002100ac4c'), null);
eq('id 全零（时间戳越界）时不给日期', SCHEMA.noteIdTimestamp('000000000000000000000000'), null);
eq('id 时间戳超出合理区间时不给日期', SCHEMA.noteIdTimestamp('ffffffff0000000000000000'), null);
eq('id 解不出时回落到卡片文字', SCHEMA.buildSearchHit(Object.assign({}, reducedNote, {
  id: 'zz39f801000000002100ac4c',
  note_card: Object.assign({}, reducedNote.note_card, { corner_tag_info: [{ type: 'publish_time', text: '2025-06-18' }] }),
}), { seq: 1, rank: 1, rankAmongNotes: 1 }).publishDateSource, 'card_full_date');

// 完整日期：与 id 解出的日期打架时，两边都留着并打标记
const hitFullDate = SCHEMA.buildSearchHit(Object.assign({}, reducedNote, {
  note_card: Object.assign({}, reducedNote.note_card, { corner_tag_info: [{ type: 'publish_time', text: '2025-06-18' }] }),
}), { seq: 1, rank: 1, rankAmongNotes: 1 });
eq('命中 冲突时两个日期都留', [hitFullDate.publishDate, hitFullDate.publishDateCard], ['2026-06-23', '2025-06-18']);
eq('命中 冲突被标记出来', [hitFullDate.publishDateConflict, hitFullDate.publishDateDiffDays], [true, 370]);
// 相对时间：有了 id 就不需要"换算"，直接读 id；原文与锚点仍保留供审计
const hitRelative = SCHEMA.buildSearchHit(Object.assign({}, reducedNote, {
  note_card: Object.assign({}, reducedNote.note_card, { corner_tag_info: [{ type: 'publish_time', text: '4天前' }] }),
}), { seq: 2, rank: 2, rankAmongNotes: 2, capturedAt: '2026-09-17T08:17:02.000Z', observedAt: '2026-09-17T08:17:00.000Z' });
eq('命中 相对时间由 id 直接解出', [hitRelative.publishDate, hitRelative.publishDateSource], ['2026-06-23', 'note_id']);
eq('命中 相对时间没有卡片日可对，不算冲突', [hitRelative.publishDateCard, hitRelative.publishDateConflict], [null, false]);
eq('命中 相对时间留住原文与锚点', [hitRelative.publishTimeRaw, hitRelative.publishTimeObservedAt], ['4天前', '2026-09-17T08:17:00.000Z']);
eq('dayString 只到日（本地时区）', SCHEMA.dayString(new Date(2026, 5, 23, 12, 34, 56)), '2026-06-23');
eq('dayStringCST 固定东八区', SCHEMA.dayStringCST(new Date(Date.UTC(2026, 2, 15, 23, 0, 0))), '2026-03-16');

const hitQuery = SCHEMA.buildSearchHit({ id: 'q1#1', model_type: 'hot_query', hot_query: { title: '大家都在搜', queries: [{ name: '露营', search_word: '露营' }] } }, { seq: 7, rank: 7, rankAmongNotes: 7, page: 1, indexInPage: 7 });
eq('热词条目 类型', hitQuery.itemKind, 'hot_query');
eq('热词条目 不占笔记位次', hitQuery.rankAmongNotes, null);
eq('热词条目 不当成笔记 id', hitQuery.noteId, '');
eq('热词条目 保留题名与推荐词', [hitQuery.title, hitQuery.queries.length], ['大家都在搜', 1]);

const seenMap = {};
eq('去重 首次收录', SCHEMA.mergeSearchHit(seenMap, hitNote).status, 'added');
eq('去重 第二次判为重复', SCHEMA.mergeSearchHit(seenMap, SCHEMA.buildSearchHit(reducedNote, { seq: 30, rank: 30 })).status, 'repeat');
eq('去重 保留首次那条', SCHEMA.mergeSearchHit(seenMap, SCHEMA.buildSearchHit(reducedNote, { seq: 31, rank: 31 })).hit.rank, 7);
eq('去重 非笔记条目不参与 noteId 去重', SCHEMA.mergeSearchHit(seenMap, hitQuery).status, 'added');

const hitExportRow = SCHEMA.searchHitRow(hitNote, { sessionId: 's1', keyword: '露营', searchId: 'sid1', filtersLabel: '排序依据 综合' });
eq('导出列与数据行一一对应', Object.keys(hitExportRow).sort(), SCHEMA.SEARCH_HIT_COLUMNS.slice().sort());
eq('导出列带上批次属性', [hitExportRow.sessionId, hitExportRow.keyword, hitExportRow.searchId], ['s1', '露营', 'sid1']);
eq('jsonl 一行一条', SCHEMA.toJsonl([{ a: 1 }, { a: 2 }]).split('\n').filter(Boolean).length, 2);

// ---------- extract.js 端到端冒烟（DOM 回退路径） ----------
function fakeEl(text, extra) {
  return Object.assign({
    textContent: text || '',
    className: '',
    id: '',
    naturalWidth: 0,
    naturalHeight: 0,
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  }, extra || {});
}
function makeDoc(dateText, profile, profileDom, bridge) {
  const countBox = profileDom && profileDom.counts ? fakeEl(profileDom.counts) : null;
  // 模拟真实 DOM：多个容器并存，解析必须落到"命中关键词且文本最短"的那个元素上
  const smallEls = [];
  if (countBox) smallEls.push(countBox);
  if (profileDom && profileDom.redEl) smallEls.push(fakeEl(profileDom.redEl));
  if (profileDom && profileDom.ipEl) smallEls.push(fakeEl(profileDom.ipEl));
  if (profileDom && profileDom.wrapperText) smallEls.push(fakeEl(profileDom.wrapperText));
  return {
    body: { textContent: (profileDom && profileDom.bodyText) || '' },
    getElementById: (id) => {
      // main world 写进来的两个桥节点
      if (id === 'xhs-note-api' && bridge && bridge.cards) return fakeEl(JSON.stringify(bridge.cards));
      if (id === 'xhs-note-state' && bridge && bridge.stateIds) {
        return fakeEl(JSON.stringify({ ids: bridge.stateIds, at: Date.now() }));
      }
      if (id === 'xhs-note-comments' && bridge && bridge.comments) return fakeEl(JSON.stringify(bridge.comments));
      if (id === 'xhs-search' && bridge && bridge.search) return fakeEl(JSON.stringify(bridge.search));
      if (id === 'xhs-user-profile' && profile) return fakeEl(JSON.stringify(profile));
      return null;
    },
    querySelectorAll: (sel) => (/\b(div|span|p|section)\b/.test(sel) ? smallEls : []),
    querySelector: (sel) => {
      // 泛化选择器（笔记页取作者 id 用）：'a[href*="/user/profile/"]'
      if (/user\/profile\/"\]/.test(sel)) return fakeEl('', { getAttribute: () => '/user/profile/abc999' });
      // 指定 id 的选择器（主页上下文判定用）：'a[href*="/user/profile/u1"]'
      if (sel.indexOf('/user/profile/') >= 0) return (profileDom && profileDom.profileLink) ? fakeEl('') : null;
      if (profileDom) {
        if (sel.indexOf('user-name') >= 0 || sel.indexOf('nickname') >= 0) return fakeEl(profileDom.nickname || '');
        if (sel.indexOf('user-desc') >= 0) return fakeEl(profileDom.bio || '');
      }
      if (sel.indexOf('detail-title') >= 0) return fakeEl('测试标题');
      if (sel.indexOf('detail-desc') >= 0 || sel.indexOf('desc') >= 0 || sel.indexOf('note-content') >= 0) {
        return fakeEl('正文内容 #露营， #徒步 结束');
      }
      if (sel.indexOf('author') >= 0) return fakeEl('', { querySelector: () => fakeEl('测试作者') });
      if (sel.indexOf('date') >= 0 || sel.indexOf('time') >= 0 || sel.indexOf('publish') >= 0) return fakeEl(dateText);
      return null;
    },
  };
}
let uuidSeq = 0;
function buildExtractEnv(opts) {
  const sandbox2 = {
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    Date,
    JSON,
    Number,
    Object,
    Array,
    String,
    Boolean,
    Math,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    crypto: { randomUUID: () => 'uuid-' + (++uuidSeq) },
    location: (() => {
      const href = (opts && opts.href) || 'https://www.xiaohongshu.com/explore/noteX';
      let p = '/explore/noteX';
      try { p = new URL(href).pathname; } catch (e) { /* 忽略 */ }
      return { href: href, search: (opts && opts.search) || '', pathname: p };
    })(),
    document: makeDoc((opts && opts.dateText) || '2024-06-01 广东', opts && opts.profile, opts && opts.profileDom, opts && opts.bridge),
  };
  sandbox2.window = sandbox2;
  vm.createContext(sandbox2);
  vm.runInContext(fs.readFileSync(path.join(root, 'content/schema.js'), 'utf8'), sandbox2, { filename: 'schema.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'content/extract.js'), 'utf8'), sandbox2, { filename: 'extract.js' });
  return sandbox2;
}
function runExtract(opts) {
  return buildExtractEnv(opts).__XHS_EXTRACT__.extract();
}

const domRes = runExtract({ dateText: '2024-06-01 广东' }).data;
eq('DOM 路径 strategy', domRes._extraction.strategy, 'DOM');
eq('DOM 路径 schemaVersion', domRes._schemaVersion, 3);
eq('DOM 路径 绝对日期', String(domRes.publishTime).slice(0, 10), '2024-06-01');
eq('DOM 路径 时间来源', domRes._publishTimeSource, 'dom_absolute');
eq('DOM 路径 时间原文', domRes._publishTimeRaw, '2024-06-01 广东');
eq('DOM 路径 属地', domRes.ipLocation, '广东');
eq('DOM 路径 标签清洗', domRes.tags, ['露营', '徒步']);
eq('DOM 路径 标签来源', domRes._tagSource, 'dom_hashtag');
eq('DOM 路径 作者昵称', domRes._author.nickname, '测试作者');
eq('DOM 路径 作者 id', domRes._author.userId, 'abc999');
eq('DOM 路径 作者来源', domRes._author.source, 'dom');
eq('DOM 路径 统计来源', domRes._statsSource, 'missing');
eq('DOM 路径 统计为空值', domRes.stats.likeCount, null);
eq('DOM 路径 缺失含 resultRank', domRes._fieldsMissing.includes('source.resultRank'), true);
eq('DOM 路径 来源类型（无参数=直接打开）', domRes._source.type, 'direct');
eq('DOM 路径 直接打开时不带检索词', domRes._source.keyword, null);
eq('DOM 路径 captureId', String(domRes._captureId).slice(0, 4), 'cap_');

const relRes = runExtract({ dateText: '6天前 广东' }).data;
eq('相对时间来源', relRes._publishTimeSource, 'dom_relative');
eq('相对时间保留原文', relRes.publishTime, '6天前');

// 今年的笔记只显示 "06-09"（无年份）：按观测年份补全，并排除日期碎片被误当统计数
const mdRes = runExtract({ dateText: '06-09' }).data;
eq('缺年份日期来源', mdRes._publishTimeSource, 'dom_absolute');
eq('缺年份日期补全', String(mdRes.publishTime).slice(0, 7), new Date().getFullYear() + '-06');
eq('日期碎片未误当统计数', mdRes.stats.commentCount, null);

// API / INITIAL_STATE 路径
const apiNote = {
  note_id: 'noteX',
  title: 'API 标题',
  desc: '正文 #话题',
  time: 1717200000000,
  ipLocation: '上海',
  user: { user_id: 'u1', nickname: 'API 作者', avatar: 'http://a/b.jpg' },
  tagList: [{ name: '话题', type: 'topic' }, { name: '某人', type: 'user' }],
  interactInfo: { liked_count: '1.2万', collected_count: '88', comment_count: '0', share_count: null },
  imageList: [{ urlDefault: 'https://sns-webpic.xhscdn.com/a.jpg!nd_dft_wlteh_webp_3' }],
};
const apiRes = runExtract({
  bridge: { cards: [apiNote], stateIds: ['noteX'] },
}).data;
eq('API 路径 strategy', apiRes._extraction.strategy, 'INITIAL_STATE');
eq('API 路径 作者来源', apiRes._author.source, 'note_card');
eq('API 路径 profileUrl', apiRes._author.profileUrl, 'https://www.xiaohongshu.com/user/profile/u1');
eq('API 路径 时间来源', apiRes._publishTimeSource, 'api_timestamp');
eq('API 路径 标签过滤 topic', apiRes.tags, ['话题']);
eq('API 路径 标签原始保留', apiRes._tagsRaw.length, 2);
eq('状态来源的统计数标注为 state', apiRes._statsSource, 'state');
eq('API 路径 万位解析', apiRes.stats.likeCount, 12000);
eq('API 路径 零值保留', apiRes.stats.commentCount, 0);
eq('API 路径 空值不假装零', apiRes.stats.shareCount, null);
eq('API 路径 统计原文', apiRes._statsRaw.likeCount, '1.2万');
eq('API 路径 缺失字段', apiRes._fieldsMissing.includes('stats.shareCount'), true);
eq('API 路径 图片计数', apiRes.imageCount, 1);
eq('API 路径 url 规范化', apiRes.url, 'https://www.xiaohongshu.com/explore/noteX');

// 错标闸门：缓存里的卡片与 URL noteId 不一致
const mismatchRes = runExtract({
  bridge: { cards: [Object.assign({}, apiNote, { note_id: 'otherNote' })], stateIds: ['otherNote'] },
});
eq('错标 标记 noteIdMismatch', mismatchRes.data._extraction.noteIdMismatch, true);
eq('错标 字段已无 isStale', 'isStale' in mismatchRes.data._extraction, false);

// 契约：两次抽取除"易变字段"外必须逐字相同。
// 这是面板"调试信息点开即收起 / 控制台刷屏"那个 bug 的回归测试：
// 只要有人新增了一个每次抽取都会变的字段，stableSig 就会不等，这条断言立刻失败。
const sigA = runExtract({ dateText: '2024-06-01 广东' });
const sigB = runExtract({ dateText: '2024-06-01 广东' });
eq('易变字段确实在变（前提成立）', sigA.data._captureId !== sigB.data._captureId, true);
eq('两次抽取 stableSig 相同', SCHEMA.stableSig(sigA.data, 'DOM') === SCHEMA.stableSig(sigB.data, 'DOM'), true);
// 确定性版本：不依赖两次调用之间的时间差
const probe1 = { _captureId: 'a', _publishTimeObservedAt: 'T1', _extraction: { extractedAt: 'T1' }, _source: { capturedAt: 'T1' }, title: 'x' };
const probe2 = { _captureId: 'b', _publishTimeObservedAt: 'T2', _extraction: { extractedAt: 'T2' }, _source: { capturedAt: 'T2' }, title: 'x' };
eq('stableSig 忽略全部已声明易变字段', SCHEMA.stableSig(probe1, 'DOM') === SCHEMA.stableSig(probe2, 'DOM'), true);
eq('stableSig 仍能区分真实变化', SCHEMA.stableSig(probe1, 'DOM') === SCHEMA.stableSig(Object.assign({}, probe1, { title: 'y' }), 'DOM'), false);

// ---------- 作者资料（机会性捕获）容错解析 ----------
function profileEntry(json) {
  return [{ url: 'https://edith.xiaohongshu.com/api/sns/web/v1/user/otherinfo?target_user_id=u1', at: Date.now(), json: json }];
}
const profCamel = runExtract({
  bridge: { cards: [apiNote], stateIds: ['noteX'] },
  profile: profileEntry({ data: { basicInfo: { user_id: 'u1', nickname: 'API 作者', desc: '研究选题', fans: '1.2万', noteCount: '37', red_id: '12345', ip_location: '上海' }, verifyInfo: { type: 1, name: '学术博主' } } }),
}).data;
eq('资料 camelCase 粉丝数', profCamel._author.fansCount, 12000);
eq('资料 camelCase 笔记数', profCamel._author.noteCount, 37);
eq('资料 简介', profCamel._author.bio, '研究选题');
eq('资料 认证', profCamel._author.verified, true);
eq('资料 认证文案', profCamel._author.verifyText, '学术博主');
eq('资料 小红书号', profCamel._author.redId, '12345');
eq('资料 作者属地', profCamel._author.ipLocation, '上海');
eq('资料 来源已标注', profCamel._author.source.indexOf('profile_cache') > 0, true);
eq('资料 补齐后不再缺失', profCamel._fieldsMissing.includes('author.fansCount'), false);

const profSnake = runExtract({
  bridge: { cards: [apiNote], stateIds: ['noteX'] },
  profile: profileEntry({ data: { basic_info: { user_id: 'u1', nick_name: 'API 作者', description: '简介B' }, interactions: [{ type: 'fans', count: '2.5万' }, { type: 'note', count: 88 }, { type: 'follows', count: '312' }, { type: 'interaction', count: '9.9万' }] } }),
}).data;
eq('资料 interactions 粉丝数', profSnake._author.fansCount, 25000);
eq('资料 interactions 笔记数', profSnake._author.noteCount, 88);
eq('资料 interactions 关注数', profSnake._author.followsCount, 312);
eq('资料 interactions 获赞收藏', profSnake._author.interactionCount, 99000);
eq('资料 部分补齐仍标缺失', profSnake._fieldsMissing.includes('author.verified'), true);

const profJunk = runExtract({
  bridge: { cards: [apiNote], stateIds: ['noteX'] },
  profile: profileEntry({ data: { foo: 'bar' } }),
}).data;
eq('无效载荷不污染缓存', profJunk._author.fansCount, null);
eq('无效载荷仍标缺失', profJunk._fieldsMissing.includes('author.fansCount'), true);

// ---------- authors.json 合并逻辑单测 ----------
const recA = { userId: 'u1', nickname: '作者甲', profileUrl: 'p/u1', fansCount: 12000, noteCount: 37, bio: '简介', verified: true, source: 'profile_api' };
const m1 = SCHEMA.mergeAuthors(null, [recA], 'T1');
eq('作者 首次保存计数', [m1.added, m1.changed, m1.confirmed], [1, 0, 0]);
eq('作者 首次 capturedAt', m1.authors.u1.capturedAt, 'T1');
eq('作者 首次 history 为空', m1.authors.u1.history, []);

const m2 = SCHEMA.mergeAuthors(m1, [recA], 'T2');
eq('作者 数值未变算确认', [m2.added, m2.changed, m2.confirmed], [0, 0, 1]);
eq('作者 未变则保留首次 capturedAt', m2.authors.u1.capturedAt, 'T1');
eq('作者 未变则刷新 checkedAt', m2.authors.u1.checkedAt, 'T2');
eq('作者 未变不写 history', m2.authors.u1.history.length, 0);

const m3 = SCHEMA.mergeAuthors(m2, [Object.assign({}, recA, { fansCount: 13500 })], 'T3');
eq('作者 数值变化计入 changed', [m3.added, m3.changed, m3.confirmed], [0, 1, 0]);
eq('作者 变化后 history 存旧快照', m3.authors.u1.history[0].fansCount, 12000);
eq('作者 变化后 history 不嵌套', m3.authors.u1.history[0].history, undefined);
eq('作者 变化后重置 capturedAt', m3.authors.u1.capturedAt, 'T3');
eq('作者 新值已写入', m3.authors.u1.fansCount, 13500);

const human = { schemaVersion: 2, myRootNote: '根目录手工字段', authors: { u1: Object.assign({}, m1.authors.u1, { myLabel: '重点作者' }) } };
const m4 = SCHEMA.mergeAuthors(human, [Object.assign({}, recA, { fansCount: 14000 })], 'T4');
eq('作者 保留人工加的字段', m4.authors.u1.myLabel, '重点作者');
const shell = SCHEMA.authorsFileShell(human, m4.authors, 'T4');
eq('作者 保留根目录人工字段', shell.myRootNote, '根目录手工字段');
eq('作者 根目录带 schemaVersion', shell.schemaVersion, SCHEMA.SCHEMA_VERSION);
const shellOld = SCHEMA.authorsFileShell({ _readme: '旧版写进去的说明', keepMe: 1 }, {}, 'T');
eq('作者 清掉旧版 _readme', '_readme' in shellOld, false);
eq('作者 清 _readme 时别的根字段不动', shellOld.keepMe, 1);

const m5 = SCHEMA.mergeAuthors(m4, [{ userId: 'u1', nickname: '作者甲' }], 'T5');
eq('作者 残缺载荷不抹掉已知值', m5.authors.u1.fansCount, 14000);
eq('作者 无 userId 的记录被忽略', SCHEMA.mergeAuthors(null, [{ nickname: 'x' }], 'T6').added, 0);

const row = SCHEMA.authorExportRow(m4.authors.u1);
eq('作者导出 列键齐全', SCHEMA.AUTHOR_EXPORT_COLUMNS.filter((c) => !(c in row)), []);
eq('作者导出 historyCount', row.historyCount >= 1, true);
eq('作者导出 verified 转 1/0', row.verified, 1);

// ---------- 登录者本人绝不能被当成"作者"存下来 ----------
// 事故背景：user/me、user/selfinfo 返回的是登录者本人，早前被当成作者资料收进了 authors.json。
const selfEntry = {
  url: 'https://edith.xiaohongshu.com/api/sns/web/v2/user/selfinfo',
  at: Date.now(),
  self: true,
  json: { data: { user_id: 'me1', nickname: '我自己' } },
};
const otherEntry = {
  url: 'https://edith.xiaohongshu.com/api/sns/web/v1/user/otherinfo?target_user_id=u1',
  at: Date.now(),
  json: { data: { basic_info: { user_id: 'u1', nick_name: '某作者' }, interactions: [{ type: 'fans', count: 12000 }] } },
};

const env1 = buildExtractEnv({ bridge: { cards: [apiNote], stateIds: ['noteX'] }, profile: [selfEntry, otherEntry] });
env1.__XHS_EXTRACT__.extract();
eq('身份接口 记下本人 id', env1.__XHS_EXTRACT__.helpers.syncCache.selfUserId, 'me1');
eq('本人不进作者缓存', 'me1' in env1.__XHS_EXTRACT__.helpers.syncCache.authors, false);
eq('他人正常进作者缓存', 'u1' in env1.__XHS_EXTRACT__.helpers.syncCache.authors, true);

// 浏览自己的主页（otherinfo?target_user_id=自己）同样不收
const env2 = buildExtractEnv({
  profile: [selfEntry, { url: 'https://edith.xiaohongshu.com/api/sns/web/v1/user/otherinfo?target_user_id=me1', at: Date.now(), json: { data: { basic_info: { user_id: 'me1', nick_name: '我自己' }, interactions: [{ type: 'fans', count: 5 }] } } }],
});
env2.__XHS_EXTRACT__.extract();
eq('自己的主页不进缓存', Object.keys(env2.__XHS_EXTRACT__.helpers.syncCache.authors).length, 0);

// 历史遗留：缓存里已经躺着本人记录时，交给按钮之前必须过滤掉
const env3 = buildExtractEnv({ profile: [selfEntry] });
env3.__XHS_EXTRACT__.helpers.syncCache.authors.me1 = { userId: 'me1', fansCount: 5, capturedAt: 'T0' };
eq('flush 前本人记录被清理', env3.__XHS_EXTRACT__.helpers.flushAuthorCache().length, 0);

const rm1 = SCHEMA.removeAuthor({ u1: { userId: 'u1' }, me1: { userId: 'me1' } }, 'me1');
eq('移除本人记录', Object.keys(rm1.authors), ['u1']);
eq('移除标记', rm1.removed, true);
eq('移除不存在的 id 不报错', SCHEMA.removeAuthor({ u1: {} }, 'nope').removed, false);

// ---------- 作者主页 DOM 解析（不依赖资料接口是否被拦到） ----------
// 取自真实页面形态："59 关注 6980 粉丝 3万 获赞与收藏"
const envDom = buildExtractEnv({
  href: 'https://www.xiaohongshu.com/user/profile/56e021eaa9b2ed46ef7c84cc',
  profileDom: {
    counts: '59 关注 6980 粉丝 3万 获赞与收藏',
    nickname: '我的退稿日常',
    bio: '985法学博士 写作、投稿经验分享',
    bodyText: '我的退稿日常 小红书号：x2011755050 IP属地：四川',
    // 真实形态：号与属地各有自己的小元素，同时外层还有一个把相邻元素拼起来的容器
    redEl: '小红书号：x2011755050',
    ipEl: 'IP属地：四川',
    wrapperText: '我的退稿日常小红书号：x2011755050IP属地：四川◇985法学博士 ◇写作、投稿经验分享',
  },
});
const recDom = envDom.__XHS_EXTRACT__.helpers.flushCurrentAuthor();
eq('主页 DOM 昵称', recDom.nickname, '我的退稿日常');
eq('主页 DOM 关注数', recDom.followsCount, 59);
eq('主页 DOM 粉丝数', recDom.fansCount, 6980);
eq('主页 DOM 获赞收藏（万位）', recDom.interactionCount, 30000);
eq('主页 DOM 小红书号', recDom.redId, 'x2011755050');
// 回归：textContent 会把相邻元素拼起来，属地不能把简介开头的"◇985法学博士"粘进来
eq('主页 DOM IP 属地不粘连', recDom.ipLocation, '四川');
eq('主页 DOM 简介', recDom.bio, '985法学博士 写作、投稿经验分享');
eq('主页 DOM userId 取自 URL', recDom.userId, '56e021eaa9b2ed46ef7c84cc');
eq('主页 DOM 来源', recDom.source, 'profile_dom');

eq('非主页 flushCurrentAuthor 返回 null', buildExtractEnv({}).__XHS_EXTRACT__.helpers.flushCurrentAuthor(), null);
eq('非主页 currentProfileUserId 为空', buildExtractEnv({}).__XHS_EXTRACT__.helpers.currentProfileUserId(), '');

// 另一种排布（标签在前）也要能解析
const envDom2 = buildExtractEnv({
  href: 'https://www.xiaohongshu.com/user/profile/u9',
  profileDom: { counts: '关注：12 粉丝：3456 获赞与收藏：7.8万', nickname: '乙', bodyText: '' },
});
const recDom2 = envDom2.__XHS_EXTRACT__.helpers.flushCurrentAuthor();
eq('标签在前 关注', recDom2.followsCount, 12);
eq('标签在前 粉丝', recDom2.fansCount, 3456);
eq('标签在前 获赞收藏', recDom2.interactionCount, 78000);

// DOM 与接口缓存合并：DOM 为准，认证信息这类 DOM 拿不到的用缓存补
const envMix = buildExtractEnv({
  href: 'https://www.xiaohongshu.com/user/profile/u1',
  profileDom: { counts: '5 关注 100 粉丝 200 获赞与收藏', nickname: '甲', bodyText: '' },
  profile: [{ url: 'https://edith.xiaohongshu.com/api/sns/web/v1/user/otherinfo?target_user_id=u1', at: Date.now(), json: { data: { basic_info: { user_id: 'u1', nick_name: '甲' }, verifyInfo: { name: '学术博主' }, interactions: [{ type: 'fans', count: 99 }] } } }],
});
envMix.__XHS_EXTRACT__.extract();
const recMix = envMix.__XHS_EXTRACT__.helpers.flushCurrentAuthor();
eq('合并 认证文案来自接口', recMix.verifyText, '学术博主');
eq('合并 粉丝数取 DOM 现值', recMix.fansCount, 100);
eq('合并 来源已标注', recMix.source, 'profile_dom+profile_api');

// 检索词容错解码（XHS 有些入口会二次编码，面板上显示成 %E8%AF%BB...）
const envKw = buildExtractEnv({ search: '?keyword=%25E8%25AF%25BB%25E5%258D%259A' });
eq('检索词二次编码被解开', envKw.__XHS_EXTRACT__.helpers.resolveSource().keyword, '读博');

// 作者主页也是可操作页面：否则工具栏会在主页上消失（实测 bug）
eq('作者主页 工具栏可见', buildExtractEnv({ href: 'https://www.xiaohongshu.com/user/profile/u1' }).__XHS_EXTRACT__.detectNoteVisible(), true);

// 笔记弹窗盖在作者主页之上：URL 变成 /explore/<id>，但主页 DOM 还在
const envModal = buildExtractEnv({
  href: 'https://www.xiaohongshu.com/user/profile/u1',
  profileDom: { counts: '59 关注 6980 粉丝 3万 获赞与收藏', nickname: '我的退稿日常', profileLink: true, bodyText: '小红书号：x2011755050' },
});
eq('主页上下文先记住作者', envModal.__XHS_EXTRACT__.helpers.resolveProfileUserId(), 'u1');
envModal.location.pathname = '/explore/noteX'; // 模拟点开笔记弹窗
eq('弹窗打开仍认得当前作者', envModal.__XHS_EXTRACT__.helpers.resolveProfileUserId(), 'u1');
eq('弹窗打开 flushCurrentAuthor 仍可用', envModal.__XHS_EXTRACT__.helpers.flushCurrentAuthor().userId, 'u1');
eq('弹窗下解析到的粉丝数', envModal.__XHS_EXTRACT__.helpers.flushCurrentAuthor().fansCount, 6980);
envModal.document.querySelector = () => null; // 主页 DOM 已卸载（真的离开了主页）
eq('离开主页后不再误判', envModal.__XHS_EXTRACT__.helpers.resolveProfileUserId(), '');

// ---------- 页面状态桥接（network.js，MAIN world） ----------
// 直开链接的笔记页是 SSR：数据只在 window.__INITIAL_STATE__ 里，隔离 world 读不到，
// 所以由 main world 读出来并写进 DOM 桥。这里验证这条链路。
function buildNetEnv(opts) {
  const els = {};
  const sandbox = {
    console, JSON, Object, Array, String, Number, Date, Boolean, Math, RegExp, Error,
    parseInt, parseFloat, isNaN, Set, WeakSet, encodeURIComponent, URL,
    document: {
      createElement: () => ({ id: '', style: {}, textContent: '' }),
      getElementById: (id) => els[id] || null,
      documentElement: { appendChild: (el) => { els[el.id] = el; } },
    },
    location: {
      href: 'https://www.xiaohongshu.com' + (opts.path || ('/explore/' + opts.noteId)),
      pathname: opts.path || ('/explore/' + opts.noteId),
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    XMLHttpRequest: function () {},
  };
  sandbox.XMLHttpRequest.prototype = {
    open() {},
    send() {},
    addEventListener(type, fn) {
      const l = this.__listeners || (this.__listeners = {});
      (l[type] = l[type] || []).push(fn);
    },
  };
  sandbox.window = sandbox;
  if (opts.fetch) sandbox.fetch = opts.fetch;
  if (opts.state) sandbox.__INITIAL_STATE__ = opts.state;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'content/network.js'), 'utf8'), sandbox, { filename: 'network.js' });
  return { sandbox, els };
}

const stateNote = {
  noteId: 'n1', title: '状态里的标题', desc: '正文',
  interactInfo: { likedCount: '90', collectedCount: '88', commentCount: '11', shareCount: '10' },
  imageList: [{ urlDefault: 'https://sns-webpic.xhscdn.com/a.jpg!nd_dft' }],
};
const netEnv = buildNetEnv({ noteId: 'n1', state: { note: { noteDetailMap: { n1: { note: stateNote, comments: [] } } } } });
eq('状态桥接 卡片进入笔记缓存', netEnv.sandbox.__XHS_NOTE_API__.n1.interactInfo.likedCount, '90');
eq('状态桥接 记录来源 id', JSON.parse(netEnv.els['xhs-note-state'].textContent).ids, ['n1']);
const bridgeTextBefore = netEnv.els['xhs-note-api'].textContent;
eq('状态桥接 状态未变则不重复写 DOM', netEnv.sandbox.__XHS_STATE_INGEST__(), false);
eq('状态桥接 未变时内容原样', netEnv.els['xhs-note-api'].textContent === bridgeTextBefore, true);

// 只认"当前 URL 那一篇"：旧实现会退而取第一条，那正是"把 A 的元数据写进 B 目录"的来源
const netEnvOther = buildNetEnv({
  noteId: 'n1',
  state: { note: { noteDetailMap: { other: { note: { noteId: 'other', title: '别的笔记' } } } } },
});
eq('状态桥接 不取无关笔记', Object.keys(netEnvOther.sandbox.__XHS_NOTE_API__ || {}).length, 0);

// 非笔记页不读状态
const netEnvProfile = buildNetEnv({
  noteId: 'n1',
  path: '/user/profile/u1',
  state: { note: { noteDetailMap: { n1: { note: stateNote } } } },
});
eq('状态桥接 非笔记页不误收', Object.keys(netEnvProfile.sandbox.__XHS_NOTE_API__ || {}).length, 0);

// 走状态来的卡片，抽取时要如实标注来源（不能冒充 API）
const bridged = runExtract({ bridge: { cards: [stateNote], stateIds: ['n1'] }, href: 'https://www.xiaohongshu.com/explore/n1' }).data;
eq('状态桥接 来源标注为 INITIAL_STATE', bridged._extraction.strategy, 'INITIAL_STATE');
eq('状态桥接 统计数已进入 metadata', bridged.stats.likeCount, 90);
eq('状态桥接 来源路径可追', bridged._extraction.stateSourcePath.indexOf('noteDetailMap') > 0, true);
const viaApi = runExtract({ bridge: { cards: [stateNote], stateIds: [] }, href: 'https://www.xiaohongshu.com/explore/n1' }).data;
eq('同形状卡片但来自 API 时不标成状态', viaApi._extraction.strategy, 'API');
eq('API 来源的统计数标注为 api', viaApi._statsSource, 'api');

// 私信/埋点/风控/搜索历史一律不处理：插件没理由去读用户的聊天与搜索历史
const noteLike = { id: 'x1', title: '看起来像笔记', imageList: [{ urlDefault: 'http://a/b.jpg' }] };
const netSkip = buildNetEnv({ noteId: 'n1' });
netSkip.sandbox.__XHS_INGEST__(noteLike, 'https://t2.xiaohongshu.com/api/v2/collect');
netSkip.sandbox.__XHS_INGEST__(noteLike, '//edith.xiaohongshu.com/api/im/web/chats/group?limit=100');
netSkip.sandbox.__XHS_INGEST__(noteLike, '//edith.xiaohongshu.com/api/sns/web/search/history/sync');
eq('跳过私信与埋点接口', Object.keys(netSkip.sandbox.__XHS_NOTE_API__ || {}).length, 0);
// 桥节点此时根本不该被创建（没有任何东西可写）
eq('跳过时不写任何桥节点', netSkip.els['xhs-note-api-urls'], undefined);
netSkip.sandbox.__XHS_INGEST__(noteLike, '//edith.xiaohongshu.com/api/sns/web/v1/feed');
eq('笔记接口仍然处理', Object.keys(netSkip.sandbox.__XHS_NOTE_API__).length, 1);
// 身份接口必须仍然放行（只用来排除自己）
netSkip.sandbox.__XHS_INGEST__({ data: { user_id: 'me1' } }, '//edith.xiaohongshu.com/api/sns/web/v2/user/me');
eq('身份接口仍被记录', JSON.parse(netSkip.els['xhs-note-api-urls'].textContent).some((u) => u.indexOf('user/me') > 0), true);
// URL 列表去重且有上限
for (let i = 0; i < 120; i++) netSkip.sandbox.__XHS_INGEST__(noteLike, '//edith.xiaohongshu.com/api/sns/web/v1/feed?p=' + i);
const urls = JSON.parse(netSkip.els['xhs-note-api-urls'].textContent);
eq('URL 列表有上限', urls.length <= 60, true);
eq('URL 列表无重复', urls.length, new Set(urls).size);

// ---------- 非笔记条目：平台自报的 model_type 就是判据 ----------
// 热词/推荐词条目：实测形状是标题嵌在 hot_query 里，本来就不满足 looksLikeNote。
// 下面这条用"外层带 title"的假想形状验证 isNonNoteItem 这道防御——平台只要把 model_type
// 标成非 note，就不该被当成笔记收进候选池。
const netQuery = buildNetEnv({ noteId: 'n1' });
netQuery.sandbox.__XHS_INGEST__({ id: 'q1', model_type: 'hot_query', title: '露营' }, '//edith.xiaohongshu.com/api/sns/web/v1/search/notes?keyword=x');
eq('非 note 的 model_type 一律不收（防御）', Object.keys(netQuery.sandbox.__XHS_NOTE_API__ || {}).length, 0);
netQuery.sandbox.__XHS_INGEST__({ id: 'n9', model_type: 'note', title: '真笔记' }, '//edith.xiaohongshu.com/api/sns/web/v1/search/notes?keyword=x');
eq('标为 note 的条目仍然收', Object.keys(netQuery.sandbox.__XHS_NOTE_API__ || {}).length, 1);

// ---------- 检索结果通道（搜索结果页粗糙采集的数据来源） ----------
// 与笔记缓存是两条通道：检索响应里的薄卡片既不进 MAP，也不该被当作"当前笔记"
const searchNotesUrl = 'https://so.xiaohongshu.com/api/sns/web/v2/search/notes';
const searchNotesPayload = {
  code: 0, success: true,
  data: {
    has_more: true,
    items: [
      { id: 'n1', model_type: 'note', xsec_token: 'tok1', note_card: {
        display_title: '露营装备清单', type: 'normal',
        user: { user_id: 'u1', nickname: '甲', avatar: 'http://a/av.jpg' },
        interact_info: { liked_count: '17', collected_count: '3', comment_count: '2', shared_count: '2', liked: true, collected: true },
        cover: { url_default: 'http://sns-webpic-qc.xhscdn.com/c.jpg' },
        image_list: [{ info_list: [{ image_scene: 'WB_DFT', url: 'http://a/1.jpg' }] }],
        corner_tag_info: [{ type: 'publish_time', text: '06-23' }],
      } },
      { id: 'q1', model_type: 'hot_query', hot_query: { title: '大家都在搜', queries: [{ name: '露营', search_word: '露营' }] } },
    ],
  },
};
const envSearch = buildNetEnv({ noteId: 'n1' });
const sxhrSearch = new envSearch.sandbox.XMLHttpRequest();
sxhrSearch.open('POST', searchNotesUrl);
sxhrSearch.send(JSON.stringify({ keyword: '露营', page: 1, page_size: 20, search_id: 'sid1', sort: 'general', note_type: 0, filters: [{ type: 'sort_type', tags: ['time_descending'] }] }));
sxhrSearch.status = 200; sxhrSearch.responseType = ''; sxhrSearch.responseText = JSON.stringify(searchNotesPayload);
for (const fn of (sxhrSearch.__listeners && sxhrSearch.__listeners.load) || []) fn.call(sxhrSearch);

const batches = envSearch.sandbox.__XHS_SEARCH_BATCHES__();
eq('检索通道 收到一批', batches.length, 1);
eq('检索通道 条目数', batches[0].items.length, 2);
eq('检索通道 记下请求参数（页码在 body 里）', [batches[0].req.page, batches[0].req.keyword, batches[0].req.searchId], [1, '露营', 'sid1']);
eq('检索通道 筛选数组原样保留', batches[0].req.filters, [{ type: 'sort_type', tags: ['time_descending'] }]);
eq('检索通道 浏览者状态字段在桥上就被丢掉', batches[0].items[0].note_card.interact_info, { liked_count: '17', collected_count: '3', comment_count: '2', shared_count: '2' });
eq('检索通道 热词条目按 model_type 分类', batches[0].items[1].model_type, 'hot_query');
eq('检索通道 检索卡片不进笔记缓存', Object.keys(envSearch.sandbox.__XHS_NOTE_API__ || {}).length, 0);
// 内容脚本取走后写回 ack；下一次刷新时已消费的批次被丢掉
envSearch.els['xhs-search-hits-ack'] = { id: 'xhs-search-hits-ack', style: {}, textContent: JSON.stringify({ consumed: 1 }) };
envSearch.sandbox.__XHS_INGEST__({ id: 'x9', model_type: 'note', title: 'x' }, '//edith.xiaohongshu.com/api/sns/web/v1/feed');
eq('检索通道 ack 后丢弃已消费批次', envSearch.sandbox.__XHS_SEARCH_BATCHES__().length, 0);
// 隐私边界：检索历史在 SKIP 列表里，即便 URL 里有 search 也不该进检索通道
envSearch.sandbox.__XHS_INGEST__({ data: { items: [{ id: 'x', model_type: 'note', note_card: { display_title: 'x' } }] } }, '//edith.xiaohongshu.com/api/sns/web/search/history/sync');
eq('检索通道 不读检索历史', envSearch.sandbox.__XHS_SEARCH_BATCHES__().length, 0);

// fetch 也是页面可能用的传输方式：请求体的页码与筛选参数同样要能读到
const fetched = [];
const envFetch = buildNetEnv({
  noteId: 'n1',
  fetch: (url, init) => {
    fetched.push({ url: String(url), body: init && init.body });
    return syncThen({
      headers: { get: () => 'application/json' },
      clone: () => ({ json: () => syncThen(searchNotesPayload) }),
    });
  },
});
envFetch.sandbox.fetch('https://so.xiaohongshu.com/api/sns/web/v2/search/notes', { body: JSON.stringify({ page: 2, page_size: 20, keyword: '露营' }) });
const fetchBatches = envFetch.sandbox.__XHS_SEARCH_BATCHES__();
eq('检索通道 fetch 路径 收到一批', fetchBatches.length, 1);
eq('检索通道 fetch 路径 记下页码', fetchBatches[0].req.page, 2);

// ---------- 评论采集（状态首屏 + 滚动时页面自己发的评论接口） ----------
const stateWithComments = {
  note: {
    noteDetailMap: {
      n1: {
        note: stateNote,
        comments: {
          list: [
            {
              id: 'c1', content: '顶', likeCount: '3', createTime: 1, ipLocation: '上海',
              userInfo: { userId: 'u1', nickname: '甲' },
              subComments: [{ id: 'c1s', content: '回复', likeCount: '0', userInfo: { userId: 'u2', nickname: '乙' }, showTags: ['is_author'] }],
            },
            { id: 'c2', content: '第二条', likeCount: '0', userInfo: { userId: 'u3', nickname: '丙' } },
          ],
          cursor: 'cur1', hasMore: true,
        },
      },
    },
  },
};
const netC = buildNetEnv({ noteId: 'n1', state: stateWithComments });
const cm1 = JSON.parse(netC.els['xhs-note-comments'].textContent);
eq('评论 状态首屏采集（含子评论）', cm1.list.length, 3);
eq('评论 子评论带 parentId', cm1.list.filter((c) => c.id === 'c1s')[0].parentId, 'c1');
eq('评论 作者回复被标记', cm1.list.filter((c) => c.id === 'c1s')[0].isAuthor, true);
eq('评论 顶层评论不带 parentId', cm1.list.filter((c) => c.id === 'c1')[0].parentId, '');
eq('评论 hasMore 如实记录', cm1.hasMore, true);
eq('评论 来源标注 state', cm1.sources, ['state']);
netC.sandbox.__XHS_STATE_INGEST__();
eq('评论 重复采集会去重', JSON.parse(netC.els['xhs-note-comments'].textContent).list.length, 3);

// 滚动时页面自己请求的评论接口（普通页）
netC.sandbox.__XHS_INGEST__(
  { data: { comments: [{ id: 'c3', content: '第三条', userInfo: { userId: 'u4', nickname: '丁' } }], cursor: 'cur2', has_more: true } },
  'https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=n1&cursor=cur1&top_comment_id=&image_formats=jpg'
);
const cm2 = JSON.parse(netC.els['xhs-note-comments'].textContent);
eq('评论 接口页合并', cm2.list.length, 4);
eq('评论 来源含 api', cm2.sources.indexOf('api') >= 0, true);
eq('评论 cursor 前进', cm2.cursor, 'cur2');
// 子评论页：靠 root_comment_id 认父
netC.sandbox.__XHS_INGEST__(
  { data: { comments: [{ id: 'c1s2', content: '另一条回复', userInfo: { userId: 'u5', nickname: '戊' } }], has_more: false } },
  'https://edith.xiaohongshu.com/api/sns/web/v2/comment/sub/page?note_id=n1&root_comment_id=c1&cursor=&num=10'
);
const cm3 = JSON.parse(netC.els['xhs-note-comments'].textContent);
eq('评论 子评论页带 parentId', cm3.list.filter((c) => c.id === 'c1s2')[0].parentId, 'c1');
eq('评论 拿到 has_more=false', cm3.hasMore, false);

// ---------- 评论摘要与 metadata 拆分 ----------
const cmBridge = {
  noteId: 'n1', at: Date.now(), cursor: 'c', hasMore: true, sources: ['state', 'api'],
  list: [
    { id: 'c1', parentId: '', content: 'a', nickname: '甲', likeCount: '3' },
    { id: 'c2', parentId: 'c1', content: 'b', nickname: '乙' },
  ],
};
const withCm = runExtract({ bridge: { cards: [stateNote], stateIds: ['n1'], comments: cmBridge }, href: 'https://www.xiaohongshu.com/explore/n1' }).data;
eq('评论摘要 采集条数', withCm._comments.meta.capturedCount, 2);
eq('评论摘要 顶层与回复分开统计', [withCm._comments.meta.topLevel, withCm._comments.meta.replies], [1, 1]);
eq('评论摘要 声明总数取自统计数', withCm._comments.meta.declaredTotal, 11);
eq('评论 有下一页则标为不完整', withCm._comments.meta.complete, false);
eq('评论不完整也不算缺失字段', withCm._fieldsMissing.includes('comments'), false);

const withCmDone = runExtract({ bridge: { cards: [stateNote], stateIds: ['n1'], comments: Object.assign({}, cmBridge, { hasMore: false }) }, href: 'https://www.xiaohongshu.com/explore/n1' }).data;
eq('评论 只有分页信号、条数不够时仍标不完整', withCmDone._comments.meta.complete, false);

const cmMismatch = runExtract({ bridge: { cards: [stateNote], stateIds: ['n1'], comments: Object.assign({}, cmBridge, { noteId: 'other' }) }, href: 'https://www.xiaohongshu.com/explore/n1' }).data;
eq('评论 归属不符则不采用', cmMismatch._comments, null);
eq('评论 完全没采到时登记为缺失', cmMismatch._fieldsMissing.includes('comments'), true);

const sp = SCHEMA.splitComments({ _comments: { meta: { capturedCount: 2 }, list: [{ id: 'c1' }] } });
eq('拆分 摘要与正文分开', [sp.meta.capturedCount, sp.list.length], [2, 1]);
eq('拆分 无评论时安全', SCHEMA.splitComments({}).list.length, 0);

// 完整性回归（实测教训）：
// 某笔记顶层只加载 5 条、状态 hasMore=false，但平台声明 11 条（总数含回复，回复要展开才加载）
// → 这种"其实没采全"绝不能被标成完整。
const partial = { noteId: 'n1', at: Date.now(), hasMore: false, sources: ['state'], list: [] };
for (let i = 0; i < 5; i++) partial.list.push({ id: 'p' + i, parentId: '', content: '顶层' + i });
const cmPartial = runExtract({ bridge: { cards: [stateNote], stateIds: ['n1'], comments: partial }, href: 'https://www.xiaohongshu.com/explore/n1' }).data;
eq('完整性 分页说没了但条数不够 → 仍不完整', cmPartial._comments.meta.complete, false);
eq('完整性 如实给出声明总数', cmPartial._comments.meta.declaredTotal, 11);
eq('完整性 顶层与回复分别计数', [cmPartial._comments.meta.topLevel, cmPartial._comments.meta.replies], [5, 0]);

// 分页信号 + 条数都满足才算完整
const fully = { noteId: 'n1', at: Date.now(), hasMore: false, sources: ['state', 'api'], list: [] };
for (let i = 0; i < 11; i++) fully.list.push({ id: 'f' + i, parentId: '', content: '顶层' + i });
const cmFull = runExtract({ bridge: { cards: [stateNote], stateIds: ['n1'], comments: fully }, href: 'https://www.xiaohongshu.com/explore/n1' }).data;
eq('完整性 两个条件都满足 → 完整', cmFull._comments.meta.complete, true);

const unknownMore = { noteId: 'n1', at: Date.now(), hasMore: null, sources: ['state'], list: [] };
for (let i = 0; i < 11; i++) unknownMore.list.push({ id: 'u' + i, parentId: '', content: '顶层' + i });
const cmUnknown = runExtract({ bridge: { cards: [stateNote], stateIds: ['n1'], comments: unknownMore }, href: 'https://www.xiaohongshu.com/explore/n1' }).data;
eq('完整性 分页未知时保守标不完整', cmUnknown._comments.meta.complete, false);

// 去重必须"补齐字段"，不能"先到先得"：
// 实测事故——评论接口那份不带 showTags，先到；状态那份带 showTags，被丢掉，
// 结果作者本人的回复被标成 isAuthor=false。
const netUp = buildNetEnv({ noteId: 'n1' });
netUp.sandbox.__XHS_INGEST__(
  { data: { comments: [{ id: 'x1', content: '作者回复', userInfo: { userId: 'author1', nickname: '作者' } }], has_more: false } },
  'https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=n1&cursor='
);
eq('去重 接口版本先到时 isAuthor 为 false', JSON.parse(netUp.els['xhs-note-comments'].textContent).list[0].isAuthor, false);
netUp.sandbox.__XHS_INGEST__(
  { data: { comments: [{ id: 'x1', content: '作者回复', showTags: ['is_author'], ipLocation: '四川', likeCount: '2', userInfo: { userId: 'author1', nickname: '作者' } }] } },
  'https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=n1&cursor=x'
);
const upgraded = JSON.parse(netUp.els['xhs-note-comments'].textContent).list;
eq('去重 后到的 isAuthor 被补齐', upgraded[0].isAuthor, true);
eq('去重 后到的 ipLocation 被补齐', upgraded[0].ipLocation, '四川');
eq('去重 后到的 likeCount 被补齐', upgraded[0].likeCount, '2');
eq('去重 不会因此多出一条', upgraded.length, 1);
// 页面状态那份也进来后，两个来源都要记下来
netUp.sandbox.__INITIAL_STATE__ = {
  note: { noteDetailMap: { n1: { note: stateNote, comments: { list: [{ id: 'x1', content: '作者回复', showTags: ['is_author'], userInfo: { userId: 'author1', nickname: '作者' } }], hasMore: false } } } },
};
netUp.sandbox.__XHS_STATE_INGEST__();
eq('去重 两个来源都被记录', JSON.parse(netUp.els['xhs-note-comments'].textContent).sources, ['api', 'state']);

// 作者回复也可以直接按 userId 判定，不依赖平台那面旗子
const cmAuthor = {
  noteId: 'n1', at: Date.now(), hasMore: false, sources: ['api'],
  list: [
    { id: 'a1', parentId: '', content: '作者自己回', userId: '56e021eaa9b2ed46ef7c84cc', isAuthor: false },
    { id: 'a2', parentId: '', content: '路人回', userId: 'someone-else', isAuthor: false },
  ],
};
const cmAuthorData = runExtract({
  bridge: { cards: [{ noteId: 'n1', title: 't', user: { user_id: '56e021eaa9b2ed46ef7c84cc', nickname: '作者' }, imageList: [{ urlDefault: 'http://a/b.jpg' }] }, Object.assign({}, apiNote, { noteId: 'n1' })], stateIds: ['n1'], comments: cmAuthor },
  href: 'https://www.xiaohongshu.com/explore/n1',
}).data;
eq('作者回复 按 userId 判定', cmAuthorData._comments.list.filter((c) => c.id === 'a1')[0].isAuthor, true);
eq('路人回复 不误标', cmAuthorData._comments.list.filter((c) => c.id === 'a2')[0].isAuthor, false);

// ---------- 展开评论：按钮文本识别 ----------
eq('展开按钮 标准文案', SCHEMA.isExpandLabel('展开4条回复'), true);
eq('展开按钮 带空格', SCHEMA.isExpandLabel(' 展开 12 条回复 '), true);
// 实测事故：还有"展开更多回复"这种没有数字的文案，第一版只认带数字的 → 评论链展开一层就停
eq('展开按钮 展开更多回复', SCHEMA.isExpandLabel('展开更多回复'), true);
eq('展开按钮 查看更多回复', SCHEMA.isExpandLabel('查看更多回复'), true);
eq('展开按钮 加载更多回复', SCHEMA.isExpandLabel('加载更多回复'), true);
eq('展开按钮 不是展开', SCHEMA.isExpandLabel('回复'), false);
eq('展开按钮 展开全文不算', SCHEMA.isExpandLabel('展开全文'), false);
eq('展开按钮 收起不算', SCHEMA.isExpandLabel('收起'), false);
eq('展开按钮 空值安全', SCHEMA.isExpandLabel(null), false);
eq('展开按钮 顺序不能反', SCHEMA.isExpandLabel('4条回复展开'), false);
eq('展开按钮 过长的文本不算（避免命中整段正文）', SCHEMA.isExpandLabel('展开更多回复去看看别人怎么说'), false);
eq('展开上限 有硬上限', SCHEMA.EXPAND_MAX_CLICKS > 0 && SCHEMA.EXPAND_MAX_MS > 0, true);
eq('展开范围 默认前 5 条', SCHEMA.DEFAULT_EXPAND_SCOPE, '5');
eq('展开范围 每个选项都合法', SCHEMA.EXPAND_SCOPES.every((s) => SCHEMA.expandLimitOf(s.value, 60) > 0), true);
eq('展开范围 具体条数', SCHEMA.expandLimitOf('3', 60), 3);
eq('展开范围 全部走硬上限', SCHEMA.expandLimitOf('all', 60), 60);
eq('展开范围 超出硬上限会被夹住', SCHEMA.expandLimitOf('999', 60), 60);
eq('展开范围 非法值回落默认', SCHEMA.expandLimitOf('bogus', 60), 5);
eq('展开设置键 已登记', [SCHEMA.STORAGE_KEYS.collectComments, SCHEMA.STORAGE_KEYS.expandScope], ['collectComments', 'expandScope']);

// ---------- 作者视图装配（authors.json × 已归档笔记） ----------
const authorRows = SCHEMA.buildAuthorRows(
  {
    u1: { userId: 'u1', nickname: '甲', fansCount: 100, history: [{ capturedAt: 'T0' }] },
    u2: { userId: 'u2', nickname: '乙' },
    u3: { userId: 'u3', nickname: '丙' },
  },
  [
    { meta: { _author: { userId: 'u1' }, _archiveTime: '2026-09-02T00:00:00.000Z' } },
    { meta: { _author: { userId: 'u1' }, _archiveTime: '2026-09-05T00:00:00.000Z' } },
    { meta: { author: { userId: 'u2' }, _archiveTime: '2026-09-03T00:00:00.000Z' } },
    { meta: {} }, // 没记到作者的笔记不该算到任何人头上
  ]
);
const byId = {};
for (const r of authorRows) byId[r.userId] = r;
eq('作者视图 关联笔记数', [byId.u1.archivedNotes, byId.u2.archivedNotes, byId.u3.archivedNotes], [2, 1, 0]);
eq('作者视图 首次归档时间取最早', byId.u1.firstArchivedAt, '2026-09-02T00:00:00.000Z');
eq('作者视图 最近归档时间取最晚', byId.u1.lastArchivedAt, '2026-09-05T00:00:00.000Z');
eq('作者视图 历史次数', byId.u1.historyCount, 1);
eq('作者视图 无笔记作者也保留', byId.u3.nickname, '丙');
eq('作者视图 空输入安全', SCHEMA.buildAuthorRows(null, null).length, 0);
eq('作者视图 键缺失时回落到键名', SCHEMA.buildAuthorRows({ x9: { nickname: '无id' } }, []).map((r) => r.userId), ['x9']);

// ---------- 样本来源（抽样框架） ----------
// 平台在 URL 里给的 xsec_source 就是入口线索；这里断言映射，以及"不能标错"的那条规矩
eq('来源映射 搜索', SCHEMA.sourceTypeOf('pc_search').type, 'search');
eq('来源映射 作者主页', SCHEMA.sourceTypeOf('pc_user').type, 'profile');
eq('来源映射 笔记内推荐', SCHEMA.sourceTypeOf('pc_note_detail_r10').type, 'related');
eq('来源映射 推荐流', SCHEMA.sourceTypeOf('web_explore_feed').type, 'feed');
eq('来源映射 无参数=直接打开', SCHEMA.sourceTypeOf('').type, 'direct');
eq('来源映射 认不出的归入其他入口', SCHEMA.sourceTypeOf('pc_weird_thing').type, 'other');
// 老记录（schema v2 只有 _search）要能继续读
eq('兼容老记录 有关键词即视为搜索', SCHEMA.sourceOf({ _search: { keyword: '论文' } }).type, 'search');
eq('兼容老记录 无任何线索则未知', SCHEMA.sourceOf({}).type, 'unknown');

const envProf = buildExtractEnv({ search: '?xsec_source=pc_user' });
envProf.__XHS_EXTRACT__.helpers.syncCache.keywordHint = { keyword: '论文写作', at: Date.now() };
const srcProf = envProf.__XHS_EXTRACT__.helpers.resolveSource();
eq('从作者主页进来 → profile', srcProf.type, 'profile');
eq('主页来源不套用最近的检索词（抽样框架不能标错）', srcProf.keyword, null);

const envSrch = buildExtractEnv({ search: '?xsec_source=pc_search' });
envSrch.__XHS_EXTRACT__.helpers.syncCache.keywordHint = { keyword: '论文写作', at: Date.now() };
const srcSrch = envSrch.__XHS_EXTRACT__.helpers.resolveSource();
eq('从搜索进来 → search', srcSrch.type, 'search');
eq('搜索来源才回填检索词', srcSrch.keyword, '论文写作');
eq('并标注该词来自提示而非 URL', typeof srcSrch.keywordFromHintAt, 'string');

const envKwUrl = buildExtractEnv({ search: '?xsec_source=pc_search&keyword=%E8%AE%BA%E6%96%87' });
eq('URL 自带检索词优先', envKwUrl.__XHS_EXTRACT__.helpers.resolveSource().keyword, '论文');

// 缺失字段的口径：只有"搜索进来却没拿到词"才算缺；主页/推荐流本来就没有词
const missSearch = runExtract({ bridge: { cards: [stateNote], stateIds: ['n1'] }, href: 'https://www.xiaohongshu.com/explore/n1', search: '?xsec_source=pc_search' }).data;
eq('搜索来源缺检索词 → 登记缺失', missSearch._fieldsMissing.includes('source.keyword'), true);
const missProfile = runExtract({ bridge: { cards: [stateNote], stateIds: ['n1'] }, href: 'https://www.xiaohongshu.com/explore/n1', search: '?xsec_source=pc_user' }).data;
eq('主页来源不报检索词缺失', missProfile._fieldsMissing.includes('source.keyword'), false);
eq('主页来源已如实记录', missProfile._source.type, 'profile');

// 检索关键词应从"检索接口的 URL"里来（实测事故：笔记页地址栏没有 keyword，
// 只在地址栏取会导致归档时还不知道检索词，39 秒后才补上）
const netSearch = buildNetEnv({ noteId: 'n1' });
netSearch.sandbox.__XHS_INGEST__({}, 'https://edith.xiaohongshu.com/api/sns/web/v1/search/filter?keyword=%E6%9C%9F%E5%88%8A%E5%8F%91%E8%A1%A8&search_id=x');
eq('检索接口 关键词被抓到', JSON.parse(netSearch.els['xhs-search'].textContent).keyword, '期刊发表');
netSearch.sandbox.__XHS_INGEST__({}, 'https://edith.xiaohongshu.com/api/sns/web/v1/feed');
eq('非检索接口不动关键词', JSON.parse(netSearch.els['xhs-search'].textContent).keyword, '期刊发表');

// 抽取侧：地址栏只有 xsec_source=pc_search、没有 keyword 时，用桥上抓到的检索词补上
const envHint = buildExtractEnv({
  href: 'https://www.xiaohongshu.com/explore/n1',
  search: '?xsec_source=pc_search',
  bridge: { cards: [stateNote], stateIds: ['n1'], search: { keyword: '期刊发表推荐', at: Date.now() } },
});
eq('检索提示被收进同步缓存', envHint.__XHS_EXTRACT__.helpers.collectSearchHint(), true);
const srcFromBridge = envHint.__XHS_EXTRACT__.helpers.resolveSource();
eq('地址栏无关键词时用接口抓到的词', srcFromBridge.keyword, '期刊发表推荐');
eq('该词来自提示而非地址栏', typeof srcFromBridge.keywordFromHintAt, 'string');
eq('并写回同步缓存', envHint.__XHS_EXTRACT__.helpers.syncCache.keywordHint.keyword, '期刊发表推荐');
// 但如果是作者主页来源，仍然不许套用
envHint.location.search = '?xsec_source=pc_user';
eq('主页来源依旧不套用', envHint.__XHS_EXTRACT__.helpers.resolveSource().keyword, null);

// 实测事故：检索页地址栏是 /search_result_ai?keyword=…&source=web_explore_feed
// —— source 只是版式水印（点进笔记后它和 xsec_source=pc_search 同时存在），
//    按它判会把检索页标成"推荐流"，检索词却还挂在旁边。判据按可信度排序。
const envAi = buildExtractEnv({
  href: 'https://www.xiaohongshu.com/search_result_ai',
  search: '?keyword=%25E6%259C%259F%25E5%2588%258A%25E5%258F%2591%25E8%25A1%25A8%25E6%258E%25A8%25E8%258D%2590&source=web_explore_feed',
});
const srcAi = envAi.__XHS_EXTRACT__.helpers.resolveSource();
eq('检索页的 source 只是版式水印 → search', srcAi.type, 'search');
eq('判据记在 typeSource（keyword 在地址栏）', srcAi.typeSource, 'url_keyword');
eq('平台原话仍留在 raw :: "web_explore_feed"', srcAi.raw, 'web_explore_feed');
eq('二次编码的检索词解开 :: "期刊发表推荐"', srcAi.keyword, '期刊发表推荐');

// 从检索页点进笔记：两个参数打架时以 xsec_source 为准
const envNote2 = buildExtractEnv({
  href: 'https://www.xiaohongshu.com/explore/6a6432d40000000014006f8e',
  search: '?xsec_token=AB&xsec_source=pc_search&source=web_explore_feed',
});
const srcNote2 = envNote2.__XHS_EXTRACT__.helpers.resolveSource();
eq('笔记页两个参数打架时 xsec_source 优先', srcNote2.type, 'search');
eq('raw 取的是判据那个参数', srcNote2.raw, 'pc_search');
eq('判据标为 xsec_source', srcNote2.typeSource, 'xsec_source');

// 检索页但地址栏没带 keyword → 仍判 search，判据是路径
const envPath = buildExtractEnv({ href: 'https://www.xiaohongshu.com/search_result', search: '?source=web_explore_feed&type=51' });
const srcPath = envPath.__XHS_EXTRACT__.helpers.resolveSource();
eq('检索页无 keyword 也判 search', srcPath.type, 'search');
eq('此时判据是路径', srcPath.typeSource, 'url_path');

// 反例一：推荐流打开、无任何搜索线索 → 仍是 feed（不能为了修检索页把推荐流也吞了）
const envFeed = buildExtractEnv({ href: 'https://www.xiaohongshu.com/explore/n2', search: '?source=web_explore_feed' });
eq('推荐流笔记不受影响', envFeed.__XHS_EXTRACT__.helpers.resolveSource().type, 'feed');

// 反例二：权威参数存在时不参与抢判（搜索→主页→笔记 这条路不能被标成搜索）
const envUser2 = buildExtractEnv({ href: 'https://www.xiaohongshu.com/explore/n3', search: '?xsec_source=pc_user&source=web_explore_feed' });
eq('xsec_source=pc_user 不被路径或水印抢走', envUser2.__XHS_EXTRACT__.helpers.resolveSource().type, 'profile');

console.log(bad ? `\n${bad} problem(s)` : '\nall checks passed');
process.exit(bad ? 1 : 0);
