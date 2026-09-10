/**
 * XHS Archive - 归档管理页（浏览 + 人工标注）
 *
 * 职责：
 *  ① 选择归档根目录（readwrite，用于写 annotation.json）并遍历所有已归档笔记（metadata.json）
 *  ② 搜索 / 按标签筛选 / 多选批量贴标签与排除
 *  ③ 编辑每篇笔记的人工标注，写入 <笔记目录>/annotation.json（永不修改 metadata.json）
 *  ④ 导出 metadata × annotation 合并后的 CSV / JSONL（写入 <根目录>/_meta/）
 *
 * 观测与标注的边界：本页只增不改 —— 归档路径写 metadata.json，本页只写 annotation.json。
 */
'use strict';

const SCH = window.XHS_SCHEMA;
const $ = (id) => document.getElementById(id);

const DB = 'xhs-archive';
const VER = 1;
const STORE = 'handles';

// ---------- IndexedDB：目录句柄持久化 ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VER);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbGet(key) { return openDB().then((db) => new Promise((res, rej) => { const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); })); }
function idbPut(key, val) { return openDB().then((db) => new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(val, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); })); }

// ---------- 状态 ----------
let rootHandle = null;
let notes = [];              // { dir, meta, anno, relPath }
let filtered = [];
let selected = new Set();    // relPath
let taxonomy = [];
let currentNote = null;
let annoDraft = null;
let lastAnnotator = '';

// ---------- 小工具 ----------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function setAnnoStatus(msg, kind) {
  const el = $('anno-status');
  el.textContent = msg || '';
  el.style.color = kind === 'err' ? '#d93025' : (kind === 'ok' ? '#188038' : '#999');
}
function sortLabel(v) {
  const hit = SCH.SORT_ORDER_OPTIONS.find((o) => o.value === v);
  return hit ? hit.label : v;
}

async function readJsonFile(dir, name) {
  const fh = await dir.getFileHandle(name);
  return JSON.parse(await (await fh.getFile()).text());
}
async function writeTextFile(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}
async function writeJsonFile(dir, name, obj) {
  await writeTextFile(dir, name, JSON.stringify(obj, null, 2));
}
async function resolveFile(dir, relPath) {
  const parts = String(relPath).split('/').filter(Boolean);
  let h = dir;
  for (let i = 0; i < parts.length - 1; i++) h = await h.getDirectoryHandle(parts[i]);
  return await h.getFileHandle(parts[parts.length - 1]);
}

// ---------- 目录与扫描 ----------
async function getUserKey(key, fallback) {
  try {
    const r = await chrome.storage.local.get(key);
    return (r && r[key]) || fallback;
  } catch (e) { return fallback; }
}
async function setUserKey(key, value) {
  try { await chrome.storage.local.set({ [key]: value }); } catch (e) { /* 忽略 */ }
}

async function loadRoot() {
  rootHandle = await idbGet('manageRoot');
  if (rootHandle) {
    $('pick-dir').textContent = '切换归档目录: ' + rootHandle.name;
    await refreshWriteMode();
  }
}

async function refreshWriteMode() {
  const el = $('dir-status');
  if (!rootHandle) { el.textContent = '未选择目录'; return false; }
  const read = await canRead(rootHandle);
  let state = 'unknown';
  try { state = await rootHandle.queryPermission({ mode: 'readwrite' }); } catch (e) { state = 'unknown'; }
  if (state === 'granted') {
    el.textContent = '已选: 📁 ' + rootHandle.name + ' · 可写（标注已启用）';
    return true;
  }
  el.textContent = read
    ? '已选: 📁 ' + rootHandle.name + ' · 只读（保存标注时会请求写入权限）'
    : '已选: 📁 ' + rootHandle.name + ' · 未授权（点「选择归档目录」重新授权）';
  return false;
}

// 读权限检查：目录句柄是持久的，但浏览器重启后授权会退回 'prompt'，
// 此时任何目录操作都会抛 NotAllowedError —— 必须先让用户点一次选目录重新授权。
async function canRead(handle) {
  try { return (await handle.queryPermission({ mode: 'read' })) === 'granted'; } catch (e) { return false; }
}

// 写权限：只读句柄提权可能被拒，必须有降级提示（需在用户手势中调用）
async function ensureWritable() {
  if (!rootHandle) { setAnnoStatus('请先选择归档目录', 'err'); return false; }
  try {
    if (await rootHandle.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
    if (await rootHandle.requestPermission({ mode: 'readwrite' }) === 'granted') {
      await refreshWriteMode();
      return true;
    }
  } catch (e) { /* 继续走失败分支 */ }
  await refreshWriteMode();
  setAnnoStatus('当前目录为只读：请点右上角「选择归档目录」重新授权，标注需要写入 annotation.json', 'err');
  return false;
}

async function pickRoot() {
  const h = await window.showDirectoryPicker({ mode: 'readwrite' });
  await idbPut('manageRoot', h);
  rootHandle = h;
  $('pick-dir').textContent = '切换归档目录: ' + h.name;
  await refreshWriteMode();
  await loadNotes();
}

async function walkDir(dir, depth, out, relPath) {
  if (depth > 5) return;
  try {
    for await (const entry of dir.values()) {
      if (entry.kind === 'file') {
        if (entry.name === SCH.META_FILE) {
          try {
            const meta = await readJsonFile(dir, SCH.META_FILE);
            let anno = null;
            try { anno = await readJsonFile(dir, SCH.ANNOTATION_FILE); } catch (e) { anno = null; }
            out.push({ dir, meta, anno, relPath });
          } catch (e) { /* 忽略损坏的 metadata */ }
        }
      } else if (entry.kind === 'directory' && depth < 5) {
        await walkDir(entry, depth + 1, out, relPath ? relPath + '/' + entry.name : entry.name);
      }
    }
  } catch (e) {
    // 打印 name/message：DOMException 直接 toString 只有 "[object DOMException]"，等于没报
    const name = (e && e.name) || '';
    console.error('[XHS manage] walk error:', name || e, (e && e.message) || '');
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      setAnnoStatus('读取目录被拒：浏览器重启后目录授权会重置，请点右上角「选择归档目录」重新授权', 'err');
    } else if (name === 'NotFoundError') {
      setAnnoStatus('归档目录已不存在（可能被移动或删除）→ 请点右上角「选择归档目录」重新选择', 'err');
    }
  }
}

async function loadNotes() {
  if (!rootHandle) return;
  notes = [];
  selected.clear();
  try {
    await walkDir(rootHandle, 0, notes, '');
  } catch (e) { console.error('[XHS manage] load error:', e); }
  notes.sort((a, b) => String(b.meta._archiveDate || '').localeCompare(String(a.meta._archiveDate || '')));
  renderTaxonomyOptions(true);
  applyFilter();
  await loadAuthors();   // 作者视图与笔记关联，跟着一起刷新
  updateTabCounts();
}

// ---------- 词表 ----------
async function loadTaxonomy() {
  let t = await getUserKey(SCH.STORAGE_KEYS.labelTaxonomy, null);
  if (!Array.isArray(t) || !t.length) t = [...SCH.DEFAULT_LABELS];
  taxonomy = t;
}

async function saveTaxonomy() {
  await setUserKey(SCH.STORAGE_KEYS.labelTaxonomy, taxonomy);
  renderTaxonomyOptions();
}

function usedLabels() {
  const set = new Set();
  for (const n of notes) for (const l of ((n.anno && n.anno.labels) || [])) set.add(l);
  return [...set];
}

function renderTaxonomyOptions(resetFilter) {
  $('label-list').innerHTML = taxonomy.map((l) => `<option value="${esc(l)}"></option>`).join('');

  const sel = $('filter-label');
  const prev = sel.value;
  const all = [...new Set([...taxonomy, ...usedLabels()])];
  sel.innerHTML = '<option value="">全部标签</option>'
    + all.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('')
    + '<option value="__none__">未打标签</option>';
  if (!resetFilter && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function mergeIntoTaxonomy(labels) {
  let changed = false;
  for (const l of labels || []) {
    if (l && !taxonomy.includes(l)) { taxonomy.push(l); changed = true; }
  }
  if (changed) await saveTaxonomy();
  return changed;
}

// ---------- 标注读写 ----------
function annoOf(n) {
  const base = SCH.emptyAnnotation(n.meta && n.meta.noteId);
  // 深拷贝：草稿与 n.anno 必须互不影响，否则未保存的编辑会立刻出现在列表上
  return cloneAnno(Object.assign(base, n.anno || {}));
}

function cloneAnno(a) {
  return {
    noteId: a.noteId || '',
    captureIds: [...(a.captureIds || [])],
    keywords: [...(a.keywords || [])],
    sortOrders: [...(a.sortOrders || [])],
    labels: [...(a.labels || [])],
    exclude: !!a.exclude,
    excludeReason: a.excludeReason || '',
    note: a.note || '',
    annotatorId: a.annotatorId || '',
    createdAt: a.createdAt || '',
    updatedAt: a.updatedAt || '',
  };
}

async function persistAnnotation(n, anno) {
  const now = new Date().toISOString();
  const next = cloneAnno(anno);
  next.noteId = (n.meta && n.meta.noteId) || '';
  next.updatedAt = now;
  if (!next.createdAt) next.createdAt = now;
  const capId = n.meta && n.meta._captureId;
  if (capId && !next.captureIds.includes(capId)) next.captureIds.push(capId);
  // 只保留契约声明的标注字段 + 元数据键，避免把 UI 草稿里的临时键写进文件
  const allowed = new Set([...SCH.ANNOTATION_FIELDS, 'noteId', 'captureIds', 'createdAt', 'updatedAt']);
  for (const k of Object.keys(next)) if (!allowed.has(k)) delete next[k];
  await writeJsonFile(n.dir, SCH.ANNOTATION_FILE, next);
  n.anno = next;
  return next;
}

// ---------- 列表与筛选 ----------
// 来源一行文字：入口 + 仅搜索下才有的检索词
function sourceLabelOf(meta) {
  const s = SCH.sourceOf(meta);
  const eff = SCH.effectiveKeyword(meta, null);
  const label = s.label || s.type || '未知';
  const kw = eff.keywords[0];
  return kw ? `${label} · ${kw}` : label;
}

function renderList() {
  const listEl = $('list');
  listEl.innerHTML = '';
  for (const n of filtered) {
    const meta = n.meta || {};
    const anno = n.anno;
    const eff = SCH.effectiveKeyword(meta, anno);
    const tags = (meta.tags || []).slice(0, 4).map((t) => `<span class="tag">#${esc(t)}</span>`).join('');
    const labels = ((anno && anno.labels) || []).map((l) => `<span class="label-chip">${esc(l)}</span>`).join('');
    const kws = eff.keywords.map((k) => `<span class="kw">${esc(k)}${eff.source === 'manual' ? '（人工）' : ''}</span>`).join('');
    const srcInfo = SCH.sourceOf(meta);
    const srcChip = (srcInfo.type && srcInfo.type !== 'unknown')
      ? `<span class="kw">来源:${esc(srcInfo.label || srcInfo.type)}</span>` : '';
    const flags = [];
    if (anno && anno.exclude) flags.push('<span class="flag-err">已排除</span>');
    if (meta._extraction && meta._extraction.noteIdMismatch) flags.push('<span class="flag-err">noteId 不一致</span>');
    if (!anno) flags.push('<span class="flag-warn">未标注</span>');

    const div = document.createElement('div');
    div.className = 'note' + (anno && anno.exclude ? ' excluded' : '');
    div.innerHTML = `<div class="row-top">
        <input type="checkbox" class="pick" ${selected.has(n.relPath) ? 'checked' : ''} title="选中以批量操作" />
        <span class="t">${esc(meta.title || '(无标题)')}</span>
      </div>
      <div class="a">${esc((meta.author && meta.author.nickname) || '?')} · ${esc(meta._archiveDate || '')} · ${(meta.imageList || []).length}图${meta.hasVideo ? '·视频' : ''}</div>
      <div class="badges">${srcChip}${kws}${labels}${flags.join('')}</div>
      <div class="tags">${tags}</div>`;

    div.querySelector('.pick').addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.checked) selected.add(n.relPath); else selected.delete(n.relPath);
      updateSelCount();
    });
    div.addEventListener('click', () => preview(n));
    listEl.appendChild(div);
  }
  $('count').textContent = `${filtered.length} / ${notes.length} 篇`;
  $('empty').style.display = notes.length ? 'none' : 'block';
  updateSelCount();
}

function updateSelCount() {
  $('sel-count').textContent = `已选 ${selected.size} 篇`;
}

function applyFilter() {
  const q = $('search').value.trim().toLowerCase();
  const labelFilter = $('filter-label').value;
  const hideExcluded = $('hide-excluded').checked;
  const onlyUnannotated = $('only-unannotated').checked;

  filtered = notes.filter((n) => {
    const meta = n.meta || {};
    const anno = n.anno;
    if (hideExcluded && anno && anno.exclude) return false;
    if (onlyUnannotated && anno) return false;
    if (labelFilter === '__none__') {
      if (anno && (anno.labels || []).length) return false;
    } else if (labelFilter) {
      if (!(anno && (anno.labels || []).includes(labelFilter))) return false;
    }
    if (!q) return true;
    const eff = SCH.effectiveKeyword(meta, anno);
    const hay = [
      meta.title, (meta.author || {}).nickname, (meta.tags || []).join(' '),
      eff.keywords.join(' '), (anno && (anno.labels || []).join(' ')) || '',
      (anno && anno.note) || '', meta.noteId,
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });
  renderList();
}

// ---------- 标注表单 ----------
function chipBlock(key, title, values, listId, placeholder) {
  const chips = (values || []).map((v) =>
    `<span class="chip" data-chip-key="${key}" data-chip-val="${esc(v)}">${esc(key === 'sortOrders' ? sortLabel(v) : v)}<b class="chip-x">×</b></span>`
  ).join('');
  return `<div class="anno-field">
    <div class="anno-label">${esc(title)}</div>
    <div class="chips" data-chips="${key}">${chips || '<span class="muted">（空）</span>'}</div>
    <div class="anno-add">
      <input class="mini-input" data-add-input="${key}" list="${listId}" placeholder="${esc(placeholder)}" />
      <button class="btn-mini" data-add-btn="${key}">添加</button>
    </div>
  </div>`;
}

// 把表单里的自由文本同步进草稿，避免重渲染丢输入
function syncDraftFromInputs() {
  if (!annoDraft) return;
  const noteEl = $('anno-note');
  if (noteEl) annoDraft.note = noteEl.value;
  const an = $('anno-annotator');
  if (an) annoDraft.annotatorId = an.value.trim();
}

function renderAnnoSection() {
  const el = $('anno-section');
  if (!el || !currentNote) return;
  const a = annoDraft;
  const srcInfo = SCH.sourceOf(currentNote.meta);
  const auto = SCH.effectiveKeyword(currentNote.meta, null).keywords[0] || '';
  el.innerHTML = `
    <div class="anno-head">
      <span class="anno-title">人工标注</span>
      <span class="anno-hint">来源：${esc(srcInfo.label || '未知')}${auto ? ' · 检索词：' + esc(auto) : ''}</span>
    </div>
    ${chipBlock('labels', '标签', a.labels, 'label-list', '输入标签后回车')}
    <div class="anno-field">
      <div class="anno-label">备注</div>
      <textarea id="anno-note" class="anno-note" rows="3" placeholder="编码备注">${esc(a.note || '')}</textarea>
    </div>
    <div class="anno-field anno-inline">
      <span class="anno-label">标注人</span>
      <input class="mini-input" id="anno-annotator" placeholder="标注者 ID" value="${esc(a.annotatorId || lastAnnotator || '')}" />
    </div>
    <div class="anno-actions">
      <button class="btn" id="anno-save">保存标注</button>
      <button class="btn-mini" id="taxo-manage">管理标签词表</button>
    </div>
    <div id="taxo-panel" class="taxo-panel" hidden></div>
  `;
  bindAnnoEvents();
}

function addChipValues(key, raw) {
  const values = String(raw || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!values.length) return;
  for (const v of values) {
    if (!annoDraft[key].includes(v)) annoDraft[key].push(v);
  }
  syncDraftFromInputs();
  renderAnnoSection();
}

function removeChipValue(key, val) {
  annoDraft[key] = (annoDraft[key] || []).filter((v) => v !== val);
  syncDraftFromInputs();
  renderAnnoSection();
}

function bindAnnoEvents() {
  const sec = $('anno-section');
  // 注意：#anno-section 的元素在多次重渲染之间是同一个，委托监听只能挂一次
  if (sec.dataset.bound === '1') return;
  sec.dataset.bound = '1';

  sec.addEventListener('click', async (e) => {
    const target = e.target;
    if (!target || !target.closest) return;

    // 词表面板内部
    if (target.closest('#taxo-panel')) {
      const taxoChip = target.closest('.chip.taxo');
      if (taxoChip && target.closest('.chip-x')) {
        taxonomy = taxonomy.filter((l) => l !== taxoChip.getAttribute('data-taxo-val'));
        await saveTaxonomy();
        renderTaxoPanel();
        return;
      }
      if (target.id === 'taxo-add-btn') {
        const v = ($('taxo-add').value || '').trim();
        if (v) { await mergeIntoTaxonomy([v]); renderTaxoPanel(); }
      }
      return;
    }

    const x = target.closest('.chip-x');
    if (x) {
      const chip = x.closest('.chip');
      removeChipValue(chip.getAttribute('data-chip-key'), chip.getAttribute('data-chip-val'));
      return;
    }
    const addBtn = target.closest('[data-add-btn]');
    if (addBtn) {
      const key = addBtn.getAttribute('data-add-btn');
      const input = sec.querySelector(`[data-add-input="${key}"]`);
      addChipValues(key, input ? input.value : '');
      return;
    }
    if (target.id === 'anno-save') saveCurrentAnnotation();
    if (target.id === 'taxo-manage') toggleTaxoPanel();
  });

  sec.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest && e.target.closest('[data-add-input]');
    if (!input || input.tagName === 'SELECT') return;
    e.preventDefault();
    addChipValues(input.getAttribute('data-add-input'), input.value);
  });
}

function renderTaxoPanel() {
  const p = $('taxo-panel');
  if (!p) return;
  p.innerHTML = `<div class="anno-label">标签词表（保证编码一致性）</div>
    <div class="chips">${taxonomy.map((l) => `<span class="chip taxo" data-taxo-val="${esc(l)}">${esc(l)}<b class="chip-x">×</b></span>`).join('') || '<span class="muted">（空）</span>'}</div>
    <div class="anno-add">
      <input class="mini-input" id="taxo-add" placeholder="新增词表标签" />
      <button class="btn-mini" id="taxo-add-btn">加入词表</button>
    </div>`;
}

function toggleTaxoPanel() {
  const p = $('taxo-panel');
  if (!p) return;
  if (!p.hidden) { p.hidden = true; return; }
  p.hidden = false;
  renderTaxoPanel();
}

async function saveCurrentAnnotation() {
  if (!currentNote || !annoDraft) return;
  syncDraftFromInputs();
  if (!(await ensureWritable())) return;
  try {
    await persistAnnotation(currentNote, annoDraft);
    lastAnnotator = annoDraft.annotatorId || lastAnnotator;
    await setUserKey('annotatorId', lastAnnotator);
    await mergeIntoTaxonomy(annoDraft.labels);
    annoDraft = cloneAnno(currentNote.anno);
    renderAnnoSection();
    renderTaxonomyOptions();
    applyFilter();
    setAnnoStatus('已保存标注 ' + new Date().toLocaleTimeString(), 'ok');
  } catch (e) {
    setAnnoStatus('保存失败: ' + (e && e.message || e), 'err');
  }
}

// ---------- 预览 ----------
async function preview(n) {
  currentNote = n;
  annoDraft = annoOf(n);
  const meta = n.meta || {};
  const stats = meta.stats || {};
  const ex = meta._extraction || {};

  let imgsHtml = '';
  try {
    const urls = [];
    for (const p of (meta._imageFiles || [])) {
      const f = await resolveFile(n.dir, p);
      urls.push(URL.createObjectURL(f));
    }
    imgsHtml = urls.map((u) => `<img src="${u}" />`).join('');
  } catch (e) { /* 图片缺失不影响标注 */ }

  let videoHtml = '';
  if (meta._videoFile) {
    try {
      const f = await resolveFile(n.dir, meta._videoFile);
      videoHtml = `<video src="${URL.createObjectURL(f)}" controls></video>`;
    } catch (e) { /* 忽略 */ }
  }

  const tags = (meta.tags || []).map((t) => `<span>#${esc(t)}</span>`).join('');
  const flags = [];
  if (ex.noteIdMismatch) flags.push(`<span class="flag-err">noteId 不一致</span>`);
  if (meta._fieldsMissing && meta._fieldsMissing.length) {
    flags.push(`<span class="flag-warn" title="${esc(meta._fieldsMissing.join(', '))}">缺失字段 ${meta._fieldsMissing.length} 项</span>`);
  }
  if (meta._statsSource && meta._statsSource !== 'api') flags.push(`<span class="flag-warn">统计数来源:${esc(meta._statsSource)}</span>`);
  if (meta._commentsMeta) {
    const cm = meta._commentsMeta;
    flags.push(cm.complete
      ? `<span class="kw">评论 ${cm.capturedCount} 条（完整）</span>`
      : `<span class="flag-warn">评论 ${cm.capturedCount}${cm.declaredTotal != null ? ' / 共 ' + cm.declaredTotal : ''} 条（不完整）</span>`);
  }
  if (meta._publishTimeSource && meta._publishTimeSource !== 'api_timestamp') flags.push(`<span class="flag-warn">时间来源:${esc(meta._publishTimeSource)}</span>`);

  if (n.anno && n.anno.exclude) flags.push(`<span class="flag-err">已排除</span>`);

  // 左右两栏：左边是笔记卡片，右边是简易标注面板（标注时不用在长内容里找表单）
  $('preview-content').innerHTML = `
    <div class="pv-cols">
      <div class="pv-left">
        <h2 class="pv-title">${esc(meta.title || '(无标题)')}</h2>
        <div class="pv-meta">${esc((meta.author && meta.author.nickname) || '?')} · ${esc(meta.publishTime || '')}${meta.ipLocation ? ' · ' + esc(meta.ipLocation) : ''}
          · 来源:${esc(sourceLabelOf(meta))} · 抽取:${esc(ex.strategy || '?')} · schema v${esc(String(meta._schemaVersion == null ? '?' : meta._schemaVersion))}</div>
        <div class="pv-flags">${flags.join('')}</div>
        <div class="pv-stats"><span>👍 <b>${stats.likeCount == null ? '未知' : stats.likeCount}</b></span><span>⭐ <b>${stats.collectCount == null ? '未知' : stats.collectCount}</b></span><span>💬 <b>${stats.commentCount == null ? '未知' : stats.commentCount}</b></span><span>↗ <b>${stats.shareCount == null ? '未知' : stats.shareCount}</b></span></div>
        ${tags ? `<div class="pv-tags">${tags}</div>` : ''}
        ${meta.desc ? `<div class="pv-desc">${esc(meta.desc)}</div>` : ''}
        ${imgsHtml}
        ${videoHtml}
        <div class="pv-path">归档路径: <code>${esc(n.relPath)}</code> · 采集时间: ${esc(meta._archiveTime || '')} · captureId: <code>${esc(meta._captureId || '无')}</code></div>
        ${meta.url ? `<div class="pv-link"><a href="${esc(meta.url)}" target="_blank" rel="noopener">查看小红书原帖</a></div>` : ''}
      </div>
      <div class="pv-right">
        <div id="anno-section" class="anno-section"></div>
      </div>
    </div>
  `;
  renderAnnoSection();
  $('preview').hidden = false;
}

// ---------- 批量操作 ----------
async function batchApply(mutator, label) {
  if (!selected.size) { setAnnoStatus('请先在列表里勾选笔记', 'err'); return; }
  if (!(await ensureWritable())) return;
  let ok = 0, fail = 0;
  const touchedLabels = [];
  for (const n of notes) {
    if (!selected.has(n.relPath)) continue;
    try {
      const next = mutator(annoOf(n), n);
      if (next.labels) touchedLabels.push(...next.labels);
      await persistAnnotation(n, next);
      ok++;
    } catch (e) {
      fail++;
      console.error('[XHS manage] batch error:', e);
    }
  }
  await mergeIntoTaxonomy(touchedLabels);
  renderTaxonomyOptions();
  applyFilter();
  setAnnoStatus(`批量${label}: 成功 ${ok} / 失败 ${fail}`, fail ? 'err' : 'ok');
}

// ---------- 导出 ----------
// 导出用：关键词来源收敛为 manual / auto / auto_edited / none 四种
function keywordSourceOf(meta, anno) {
  const eff = SCH.effectiveKeyword(meta, anno);
  const s = meta._source || meta._search || {};
  const auto = s.keyword || '';
  if (eff.source !== 'manual') return eff.keywords.length ? 'auto' : 'none';
  if (!auto) return 'manual';
  return (anno.keywords.length === 1 && anno.keywords[0] === auto) ? 'auto' : 'auto_edited';
}

function buildExportRows() {
  return notes.map((n) => {
    const m = n.meta || {};
    const a = n.anno;
    const eff = SCH.effectiveKeyword(m, a);
    const s = m.stats || {};
    const st = m._source || m._search || {};
    const src = SCH.sourceOf(m);
    const ex = m._extraction || {};
    return {
      captureId: m._captureId || '',
      noteId: m.noteId || '',
      folder: n.relPath || '',
      archiveDate: m._archiveDate || '',
      title: m.title || '',
      authorNickname: (m.author && m.author.nickname) || '',
      authorUserId: (m.author && m.author.userId) || '',
      publishTime: m.publishTime || '',
      publishTimeSource: m._publishTimeSource || '',
      publishTimeRaw: m._publishTimeRaw || '',
      ipLocation: m.ipLocation || '',
      tags: (m.tags || []).join(' '),
      mediaType: m.mediaType || '',
      imageCount: m.imageCount == null ? '' : m.imageCount,
      hasVideo: m.hasVideo ? 1 : 0,
      likeCount: s.likeCount == null ? '' : s.likeCount,
      collectCount: s.collectCount == null ? '' : s.collectCount,
      commentCount: s.commentCount == null ? '' : s.commentCount,
      shareCount: s.shareCount == null ? '' : s.shareCount,
      statsSource: m._statsSource || '',
      keyword: eff.keywords.join(' | '),
      keywordSource: keywordSourceOf(m, a),
      autoKeyword: st.keyword || '',
      sourceType: src.type || '',
      sourceLabel: src.label || '',
      sourceRaw: src.raw || '',
      resultRank: st.resultRank == null ? '' : st.resultRank,
      sortOrders: ((a && a.sortOrders) || []).join(' | '),
      labels: ((a && a.labels) || []).join(' | '),
      exclude: a && a.exclude ? 1 : 0,
      excludeReason: (a && a.excludeReason) || '',
      annoNote: (a && a.note) || '',
      annotatorId: (a && a.annotatorId) || '',
      annoUpdatedAt: (a && a.updatedAt) || '',
      extractStrategy: ex.strategy || '',
      noteIdMismatch: ex.noteIdMismatch ? 1 : 0,
      imageFiles: (m._imageFiles || []).join(' '),
      videoFile: m._videoFile || '',
      imageOk: m._imageOk == null ? '' : m._imageOk,
      imageFail: m._imageFail == null ? '' : m._imageFail,
      videoOk: m._videoOk == null ? '' : (m._videoOk ? 1 : 0),
      commentsCaptured: (m._commentsMeta && m._commentsMeta.capturedCount) || 0,
      commentsTotal: (m._commentsMeta && m._commentsMeta.declaredTotal != null) ? m._commentsMeta.declaredTotal : '',
      commentsComplete: (m._commentsMeta && m._commentsMeta.complete) ? 1 : 0,
      pluginVersion: m._pluginVersion || '',
      schemaVersion: m._schemaVersion == null ? '' : m._schemaVersion,
      missingFields: (m._fieldsMissing || []).join(' '),
      url: m.url || '',
    };
  });
}

// 作者导出（宽表：一人一行，数据来自根目录的 authors.json）
async function exportAuthors() {
  if (!(await ensureWritable())) return;
  try {
    let file = null;
    try { file = await readJsonFile(rootHandle, SCH.AUTHORS_FILE); } catch (e) { file = null; }
    const rows = Object.values((file && file.authors) || {}).map(SCH.authorExportRow);
    if (!rows.length) {
      setAnnoStatus('authors.json 里还没有作者记录（先在笔记页点面板里的「保存作者」）', 'err');
      return;
    }
    const dir = await rootHandle.getDirectoryHandle(SCH.EXPORT_DIR, { create: true });
    await writeTextFile(dir, 'authors.csv', '\uFEFF' + SCH.toCsv(SCH.AUTHOR_EXPORT_COLUMNS, rows));
    setAnnoStatus(`已导出 ${rows.length} 位作者到 ${SCH.EXPORT_DIR}/authors.csv`, 'ok');
  } catch (e) {
    setAnnoStatus('导出作者失败: ' + (e && e.message || e), 'err');
  }
}

// ---------- 作者视图 ----------
// 数据来自根目录的 authors.json（笔记页的「保存作者」写入），与已加载笔记按 userId 关联。
let authors = [];        // buildAuthorRows 的产物
let authorsFiltered = [];
let activeTab = 'notes';

async function loadAuthors() {
  if (!rootHandle) return;
  let file = null;
  try { file = await readJsonFile(rootHandle, SCH.AUTHORS_FILE); } catch (e) { file = null; }
  authors = SCH.buildAuthorRows((file && file.authors) || {}, notes);
  applyAuthorFilter();
}

function applyAuthorFilter() {
  const q = ($('author-search').value || '').trim().toLowerCase();
  const onlyWithNotes = $('author-only-with-notes').checked;
  const mode = $('author-sort').value;
  authorsFiltered = authors.filter((a) => {
    if (onlyWithNotes && !a.archivedNotes) return false;
    if (!q) return true;
    return [a.nickname, a.redId, a.bio, a.ipLocation, a.verifyText, a.userId]
      .join(' ').toLowerCase().indexOf(q) >= 0;
  });
  const num = (v) => (v == null || v === '' ? -1 : Number(v));
  authorsFiltered.sort((a, b) => {
    if (mode === 'fans') return num(b.fansCount) - num(a.fansCount);
    if (mode === 'notes') return b.archivedNotes - a.archivedNotes;
    if (mode === 'recent') return String(b.checkedAt || '').localeCompare(String(a.checkedAt || ''));
    if (mode === 'archived') return String(b.firstArchivedAt || '').localeCompare(String(a.firstArchivedAt || ''));
    return String(a.nickname || '').localeCompare(String(b.nickname || ''), 'zh');
  });
  renderAuthors();
}

function renderAuthors() {
  const box = $('author-list');
  box.innerHTML = '';
  if (!authors.length) {
    $('author-empty').style.display = 'block';
    $('author-count').textContent = '';
    return;
  }
  $('author-empty').style.display = 'none';

  const head = document.createElement('div');
  head.className = 'author-row author-head';
  head.innerHTML = '<span class="a-name">作者</span><span>小红书号</span><span class="a-num">粉丝</span>'
    + '<span class="a-num">关注</span><span class="a-num">笔记</span><span class="a-num">获赞与收藏</span>'
    + '<span>认证</span><span>属地</span><span class="a-num">已归档</span><span>最近观测</span>';
  box.appendChild(head);

  for (const a of authorsFiltered) {
    const row = document.createElement('div');
    row.className = 'author-row';
    const recent = String(a.checkedAt || '').slice(0, 16).replace('T', ' ');
    row.innerHTML = `<span class="a-name">${esc(a.nickname || '(无昵称)')}${a.historyCount ? ` <b class="a-hist" title="数值变过 ${a.historyCount} 次">↻${a.historyCount}</b>` : ''}</span>`
      + `<span class="a-dim">${esc(a.redId || '—')}</span>`
      + `<span class="a-num">${a.fansCount == null ? '—' : a.fansCount}</span>`
      + `<span class="a-num">${a.followsCount == null ? '—' : a.followsCount}</span>`
      + `<span class="a-num">${a.noteCount == null ? '—' : a.noteCount}</span>`
      + `<span class="a-num">${a.interactionCount == null ? '—' : a.interactionCount}</span>`
      + `<span>${a.verified ? esc(a.verifyText || '已认证') : '—'}</span>`
      + `<span class="a-dim">${esc(a.ipLocation || '—')}</span>`
      + `<span class="a-num">${a.archivedNotes || 0}</span>`
      + `<span class="a-dim">${esc(recent || '—')}</span>`;
    row.addEventListener('click', () => showAuthor(a));
    box.appendChild(row);
  }
  $('author-count').textContent = `${authorsFiltered.length} / ${authors.length} 位作者`;
}

// 作者详情：本人的画像 + 我们归档了他/她的哪些笔记（点笔记进原有预览）
function showAuthor(a) {
  const mine = notes.filter((n) => {
    const meta = n.meta || {};
    const uid = (meta._author && meta._author.userId) || (meta.author && meta.author.userId) || '';
    return uid && uid === a.userId;
  });
  const rows = [
    ['昵称', a.nickname || '—'],
    ['小红书号', a.redId || '—'],
    ['粉丝 / 关注', `${a.fansCount == null ? '—' : a.fansCount} / ${a.followsCount == null ? '—' : a.followsCount}`],
    ['平台笔记数', a.noteCount == null ? '—' : String(a.noteCount)],
    ['获赞与收藏', a.interactionCount == null ? '—' : String(a.interactionCount)],
    ['认证', a.verified ? (a.verifyText || '已认证') : '—'],
    ['IP 属地', a.ipLocation || '—'],
    ['简介', a.bio || '—'],
    ['数值变化', a.historyCount ? `记录到 ${a.historyCount} 次变化` : '未变过'],
    ['观测时间', `${String(a.capturedAt || '').slice(0, 16).replace('T', ' ')} → ${String(a.checkedAt || '').slice(0, 16).replace('T', ' ')}`],
    ['数据来源', a.source || '—'],
  ];
  const info = rows.map(([k, v]) => `<div class="xr-row"><span class="xr-k">${esc(k)}</span><span class="xr-v">${esc(v)}</span></div>`).join('');
  const listHtml = mine.length
    ? mine.map((n, i) => `<div class="author-note" data-idx="${i}"><b>${esc(n.meta.title || '(无标题)')}</b><span>${esc(n.meta._archiveDate || '')}</span></div>`).join('')
    : '<div class="muted">我们没有归档这位作者的笔记</div>';

  $('preview-content').innerHTML = `
    <h2 class="pv-title">${esc(a.nickname || '(无昵称)')}</h2>
    <div class="pv-meta">作者档案 · userId <code>${esc(a.userId)}</code></div>
    <div class="anno-section">${info}</div>
    <div class="anno-field"><div class="anno-label">我们归档的笔记（${mine.length} 篇）</div>${listHtml}</div>
    ${a.profileUrl ? `<div class="pv-link"><a href="${esc(a.profileUrl)}" target="_blank" rel="noopener">打开小红书主页</a></div>` : ''}
  `;
  $('preview-content').querySelectorAll('.author-note').forEach((el) => {
    el.addEventListener('click', () => preview(mine[Number(el.getAttribute('data-idx'))]));
  });
  $('preview').hidden = false;
}

function switchTab(tab) {
  activeTab = tab;
  $('tab-notes').classList.toggle('active', tab === 'notes');
  $('tab-authors').classList.toggle('active', tab === 'authors');
  $('notes-view').hidden = tab !== 'notes';
  $('authors-view').hidden = tab !== 'authors';
}

function updateTabCounts() {
  $('count-notes').textContent = notes.length ? String(notes.length) : '';
  $('count-authors').textContent = authors.length ? String(authors.length) : '';
}

async function doExport(kind) {  if (!notes.length) { setAnnoStatus('没有可导出的笔记', 'err'); return; }
  if (!(await ensureWritable())) return;
  try {
    const dir = await rootHandle.getDirectoryHandle(SCH.EXPORT_DIR, { create: true });
    if (kind === 'csv') {
      const csv = '\uFEFF' + SCH.toCsv(SCH.EXPORT_COLUMNS, buildExportRows());
      await writeTextFile(dir, SCH.EXPORT_CSV, csv);
      setAnnoStatus(`已导出 ${notes.length} 行到 ${SCH.EXPORT_DIR}/${SCH.EXPORT_CSV}`, 'ok');
    } else {
      const lines = notes.map((n) => JSON.stringify({ folder: n.relPath, metadata: n.meta, annotation: n.anno || null }));
      await writeTextFile(dir, SCH.EXPORT_JSONL, lines.join('\n') + '\n');
      setAnnoStatus(`已导出 ${notes.length} 行到 ${SCH.EXPORT_DIR}/${SCH.EXPORT_JSONL}`, 'ok');
    }
  } catch (e) {
    setAnnoStatus('导出失败: ' + (e && e.message || e), 'err');
  }
}

// ---------- 启动 ----------
document.addEventListener('DOMContentLoaded', async () => {
  lastAnnotator = await getUserKey('annotatorId', '');
  await loadTaxonomy();
  $('batch-sort').innerHTML = SCH.SORT_ORDER_OPTIONS
    .map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  await loadRoot();
  if (rootHandle && await canRead(rootHandle)) {
    await loadNotes();
  } else if (rootHandle) {
    // 句柄还在但没授权（浏览器重启后授权会重置）：不要硬扫，那只会抛 NotAllowedError
    $('empty').textContent = '已记住归档目录「' + rootHandle.name + '」，但浏览器重启后授权会重置 → 点右上角「选择归档目录」重新授权即可加载';
    $('empty').style.display = 'block';
  }
  renderTaxonomyOptions(true);

  $('pick-dir').addEventListener('click', async () => {
    try {
      await pickRoot();
    } catch (e) {
      if (e && e.name !== 'AbortError') setAnnoStatus('加载失败: ' + (e.message || e), 'err');
    }
  });

  $('search').addEventListener('input', applyFilter);
  $('filter-label').addEventListener('change', applyFilter);
  $('hide-excluded').addEventListener('change', applyFilter);
  $('only-unannotated').addEventListener('change', applyFilter);

  // 作者视图
  $('tab-notes').addEventListener('click', () => switchTab('notes'));
  $('tab-authors').addEventListener('click', () => switchTab('authors'));
  $('author-search').addEventListener('input', applyAuthorFilter);
  $('author-sort').addEventListener('change', applyAuthorFilter);
  $('author-only-with-notes').addEventListener('change', applyAuthorFilter);

  $('select-all').addEventListener('click', () => {
    for (const n of filtered) selected.add(n.relPath);
    renderList();
  });
  $('select-none').addEventListener('click', () => {
    selected.clear();
    renderList();
  });

  $('batch-label-add').addEventListener('click', () => {
    const v = ($('batch-label').value || '').trim();
    if (!v) { setAnnoStatus('请填写标签名', 'err'); return; }
    batchApply((a) => { if (!a.labels.includes(v)) a.labels.push(v); return a; }, '加标签「' + v + '」');
  });
  $('batch-label-remove').addEventListener('click', () => {
    const v = ($('batch-label').value || '').trim();
    if (!v) { setAnnoStatus('请填写标签名', 'err'); return; }
    batchApply((a) => { a.labels = a.labels.filter((l) => l !== v); return a; }, '去标签「' + v + '」');
  });
  $('batch-sort-apply').addEventListener('click', () => {
    const v = $('batch-sort').value;
    batchApply((a) => { if (!a.sortOrders.includes(v)) a.sortOrders.push(v); return a; }, '设排序「' + sortLabel(v) + '」');
  });
  $('batch-exclude').addEventListener('click', () => batchApply((a) => { a.exclude = true; return a; }, '排除'));
  $('batch-include').addEventListener('click', () => batchApply((a) => { a.exclude = false; return a; }, '取消排除'));

  $('export-csv').addEventListener('click', () => doExport('csv'));
  $('export-jsonl').addEventListener('click', () => doExport('jsonl'));
  $('export-authors').addEventListener('click', () => exportAuthors());

  $('close-preview').addEventListener('click', () => { $('preview').hidden = true; currentNote = null; annoDraft = null; });
  $('preview').addEventListener('click', (e) => {
    if (e.target === $('preview')) { $('preview').hidden = true; currentNote = null; annoDraft = null; }
  });
});
