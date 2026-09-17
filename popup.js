/**
 * XHS Archive - Popup
 * 用 File System Access API 把当前笔记静默写进用户选的归档目录（不弹浏览器下载任务栏）。
 */
'use strict';

const DB_NAME = 'xhs-archive';
const DB_VERSION = 1;
const STORE = 'handles';

// ---------- IndexedDB：句柄持久化 ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(key, val) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getRootHandle() {
  return await idbGet('root');
}
async function setRootHandle(h) {
  await idbPut('root', h);
}

async function ensureWritePermission(handle) {
  try {
    const q = await handle.queryPermission({ mode: 'readwrite' });
    if (q === 'granted') return handle;
  } catch (e) {}
  const r = await handle.requestPermission({ mode: 'readwrite' });
  if (r === 'granted') return handle;
  throw new Error('未授予归档目录写权限，请重新选择目录');
}

// ---------- 工具 ----------
function sanitize(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'untitled';
}
function pad(n) { return String(n).padStart(2, '0'); }
function dateParts(d) {
  return { month: d.getFullYear() + '-' + pad(d.getMonth() + 1), day: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) };
}
function extFromUrl(url, fallback) {
  const m = (url || '').match(/\.([A-Za-z0-9]+)(?:\?|$)/);
  return (m && m[1]) || fallback || 'jpg';
}

async function getDir(parent, name) {
  return await parent.getDirectoryHandle(name, { create: true });
}
async function writeFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

async function fetchBytes(url) {
  const resp = await fetch(url, { credentials: 'omit' });
  if (resp.ok) return await resp.arrayBuffer();
  if (/^http:\/\//i.test(url)) {
    const resp2 = await fetch(url.replace(/^http:\/\//i, 'https://'), { credentials: 'omit' });
    if (resp2.ok) return await resp2.arrayBuffer();
    throw new Error('HTTP ' + resp2.status);
  }
  throw new Error('HTTP ' + resp.status);
}

async function getVideoQuality() {
  try { const r = await chrome.storage.local.get('videoQuality'); return (r && r.videoQuality) || 'autobest'; } catch (e) { return 'autobest'; }
}
function pickVideoUrl(streams, quality) {
  if (!streams || !streams.length) return '';
  if (quality === 'cover') return '';
  if (quality === 'autobest') return [...streams].sort((a, b) => (b.width || 0) - (a.width || 0))[0].url;
  const target = quality === '1080p' ? 1080 : 720;
  const eligible = streams.filter((s) => (s.width || 0) <= target);
  const pool = eligible.length ? eligible : streams;
  return [...pool].sort((a, b) => (b.width || 0) - (a.width || 0))[0].url;
}

async function getCollectorProfile() {
  try {
    const r = await chrome.storage.local.get('collectorProfile');
    const p = (r && r.collectorProfile) || {};
    return { collectorId: p.collectorId || '', accountLabel: p.accountLabel || '' };
  } catch (e) {
    return { collectorId: '', accountLabel: '' };
  }
}

// ---------- 归档 ----------
async function archiveNote(rootHandle, note) {
  // 数据完整性闸门：API 卡片与页面 noteId 不一致时写下去就是错标样本
  if (note && note._extraction && note._extraction.noteIdMismatch) {
    throw new Error(
      '中止归档：抓到的是 noteId ' + (note._extraction.pickedNoteId || '未知') +
      '，与页面 ' + (note._extraction.urlNoteId || '未知') + ' 不一致，请稍候重试或刷新页面。'
    );
  }

  const sch = window.XHS_SCHEMA || null;
  const d = dateParts(new Date()); // 归档日期（保存当天）
  const titlePart = (note.title && note.title.trim()) ? '_' + note.title : '';
  const noteFolderName = sanitize((note.noteId || 'note') + titlePart);
  const monthDir = await getDir(rootHandle, d.month);
  const dayDir = await getDir(monthDir, d.day);
  const noteDir = await getDir(dayDir, noteFolderName);

  // 视频画质在这里先算，metadata 的 _videoFile 必须与真实下载结果一致
  const quality = await getVideoQuality();
  const streams = (note.hasVideo && note.video && note.video.streams) ? note.video.streams : null;
  const videoUrl = note.hasVideo ? (streams ? pickVideoUrl(streams, quality) : (quality === 'cover' ? '' : note.video.url)) : '';

  // 采集者信息以归档时刻的设置为准（用户可能在页面抽完之后才填）
  const profile = await getCollectorProfile();

  // metadata.json
  const meta = {
    ...note,
    _schemaVersion: sch ? sch.SCHEMA_VERSION : 2,
    _pluginVersion: sch ? sch.pluginVersion() : '0.2.0',
    _archiveRoot: { context: 'extension', name: (rootHandle && rootHandle.name) || '' },
    _collection: {
      collectorId: profile.collectorId,
      accountLabel: profile.accountLabel,
      accountSource: (profile.collectorId || profile.accountLabel)
        ? 'manual'
        : ((note._collection && note._collection.accountSource) || 'none'),
    },
    _archiveTime: new Date().toISOString(),
    _archiveDate: d.day,
    _videoQuality: quality,
    _imageFiles: (note.imageList || []).map((img, i) => `images/${String(i + 1).padStart(2, '0')}.${extFromUrl(img.url, 'jpg')}`),
    _videoFile: videoUrl ? 'video/video.mp4' : null,
  };
  // 评论正文另存 comments.json，metadata 只留摘要
  const cm = sch && sch.splitComments ? sch.splitComments(note) : { meta: null, list: [] };
  meta._commentsMeta = cm.meta;
  delete meta._comments;
  await writeFile(noteDir, 'metadata.json', JSON.stringify(meta, null, 2));
  if (cm.list.length) {
    await writeFile(noteDir, sch.COMMENTS_FILE, JSON.stringify({
      noteId: note.noteId || '',
      // 写入时刻；评论本身是什么时候看到的，看 meta.capturedAt
      archivedAt: new Date().toISOString(),
      meta: cm.meta,
      comments: cm.list,
    }, null, 2));
  }
  // 离线可看的卡片页
  try {
    if (window.XHS_CARD && window.XHS_CARD.render) {
      await writeFile(noteDir, 'index.html', window.XHS_CARD.render(note, meta));
    }
  } catch (e) {}

  // 图片
  const imagesDir = await getDir(noteDir, 'images');
  const list = note.imageList || [];
  let ok = 0, fail = 0;
  for (let i = 0; i < list.length; i++) {
    const img = list[i];
    if (!img || !img.url) { fail++; continue; }
    try {
      const bytes = await fetchBytes(img.url);
      const name = String(i + 1).padStart(2, '0') + '.' + extFromUrl(img.url, 'jpg');
      await writeFile(imagesDir, name, bytes);
      ok++;
    } catch (e) {
      fail++;
    }
  }

  // 视频（按画质设置）
  let videoOk = false, videoErr = '', videoCoverOnly = false;
  if (note.hasVideo) {
    if (quality === 'cover' || !videoUrl) {
      videoCoverOnly = true;
      if (quality !== 'cover' && !videoUrl) videoErr = '未获取到可下载的视频地址';
    } else {
      try {
        const bytes = await fetchBytes(videoUrl);
        const videoDir = await getDir(noteDir, 'video');
        await writeFile(videoDir, 'video.mp4', bytes);
        videoOk = true;
      } catch (e) { videoErr = String(e && e.message || e); }
    }
  }

  // 归档质量落盘：metadata.json 先写（媒体下载中途失败时记录仍在），结束时补写实际成败
  Object.assign(meta, {
    _imageOk: ok,
    _imageFail: fail,
    _videoOk: videoOk,
    _videoCoverOnly: videoCoverOnly,
    _videoError: videoErr || null,
  });
  await writeFile(noteDir, 'metadata.json', JSON.stringify(meta, null, 2));

  // 漂移自检：字段清单与实际写入的 metadata 对比，缺键说明某条路径没同步改
  const missingKeys = sch && sch.checkMetaKeys ? sch.checkMetaKeys(meta) : [];

  return { ok, fail, noteFolderName, videoOk, videoErr, videoCoverOnly, missingKeys };
}

// ---------- UI ----------
const $ = (id) => document.getElementById(id);

function showNote(note) {
  const el = $('note-info');
  const q = $('note-quality');
  if (!note) {
    el.textContent = '（尚未在本页面抓到笔记）';
    if (q) q.textContent = '';
    $('archive').disabled = true;
    return;
  }
  const imgs = (note.imageList || []).length;
  el.innerHTML = `${note.title || '（无标题）'}<br>作者: ${(note.author && note.author.nickname) || '?'} · 图片: ${imgs} 张<br><span style="color:#999">noteId: ${note.noteId || '?'}</span>`;
  if (q) {
    const sch = window.XHS_SCHEMA;
    const src = sch && sch.sourceOf ? sch.sourceOf(note) : { label: '未知' };
    const kw = (note._source || note._search || {}).keyword || '';
    const missing = Array.isArray(note._fieldsMissing) ? note._fieldsMissing : [];
    const lines = ['来源: ' + (src.label || '未知') + (kw ? ' · ' + kw : '')];
    if (note._extraction && note._extraction.noteIdMismatch) {
      lines.push('⚠ 数据与页面 noteId 不一致（' + (note._extraction.pickedNoteId || '?') + ' ≠ ' + (note._extraction.urlNoteId || '?') + '），已禁止归档');
    }
    if (missing.length) lines.push('缺失字段: ' + missing.join(', '));
    q.textContent = lines.join('\n');
  }
  $('archive').disabled = !!(note._extraction && note._extraction.noteIdMismatch);
}

async function loadRootStatus() {
  const h = await getRootHandle();
  const s = $('dir-status');
  if (h && h.name) {
    s.textContent = '已选: 📁 ' + h.name;
    $('pick-dir').textContent = '切换归档目录';
  } else {
    s.textContent = '未选择';
  }
}

function setStatus(msg, kind) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadRootStatus();
  // 视频画质设置
  const qselect = $('video-quality');
  const storedQ = await chrome.storage.local.get('videoQuality');
  if (storedQ && storedQ.videoQuality) qselect.value = storedQ.videoQuality;
  qselect.addEventListener('change', async () => {
    await chrome.storage.local.set({ videoQuality: qselect.value });
    setStatus('视频画质已设为: ' + qselect.options[qselect.selectedIndex].text, 'ok');
  });

  // 页面按钮形态设置
  const pselect = $('panel-mode');
  const storedP = await chrome.storage.local.get('panelMode');
  if (storedP && storedP.panelMode) pselect.value = storedP.panelMode;
  pselect.addEventListener('change', async () => {
    await chrome.storage.local.set({ panelMode: pselect.value });
    setStatus('页面按钮已设为: ' + pselect.options[pselect.selectedIndex].text, 'ok');
  });

  // 采集者 / 账号标识：写入每条归档的 _collection，供事后区分是谁、用哪个账号采的
  const storedProfile = (await chrome.storage.local.get('collectorProfile')).collectorProfile || {};
  $('collector-id').value = storedProfile.collectorId || '';
  $('account-label').value = storedProfile.accountLabel || '';
  const saveProfile = async () => {
    await chrome.storage.local.set({
      collectorProfile: {
        collectorId: $('collector-id').value.trim(),
        accountLabel: $('account-label').value.trim(),
      },
    });
    setStatus('采集者信息已保存', 'ok');
  };
  $('collector-id').addEventListener('change', saveProfile);
  $('account-label').addEventListener('change', saveProfile);

  // 评论采集开关（默认关闭）：开启后页面面板才提供「展开评论」
  const cSelect = $('collect-comments');
  const storedC = await chrome.storage.local.get('collectComments');
  cSelect.value = (storedC && storedC.collectComments) ? 'on' : 'off';
  cSelect.addEventListener('change', async () => {
    await chrome.storage.local.set({ collectComments: cSelect.value === 'on' });
    setStatus(cSelect.value === 'on'
      ? '评论采集已开启：笔记页面板会出现「展开评论」按钮'
      : '评论采集已关闭', 'ok');
  });

  const stored = await chrome.storage.local.get('currentNote');
  showNote(stored && stored.currentNote && stored.currentNote.data);

  $('pick-dir').addEventListener('click', async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await setRootHandle(handle);
      await loadRootStatus();
      setStatus('已选择归档目录: ' + handle.name, 'ok');
    } catch (e) {
      if (e && e.name !== 'AbortError') setStatus('选择目录失败: ' + (e.message || e), 'err');
    }
  });

  async function performArchive() {
    const stored = await chrome.storage.local.get('currentNote');
    const note = stored && stored.currentNote && stored.currentNote.data;
    if (!note) { setStatus('没有可归档的笔记', 'err'); return; }
    let root = await getRootHandle();
    if (!root) { setStatus('请先选择归档目录', 'err'); return; }
    try {
      root = await ensureWritePermission(root);
    } catch (e) {
      setStatus(e.message, 'err');
      return;
    }
    $('archive').disabled = true;
    setStatus('归档中...（下载图片并写入目录）');
    try {
      const res = await archiveNote(root, note);
      const videoMsg = note.hasVideo
        ? (res.videoOk ? `，视频已下载` : `，视频失败: ${res.videoErr || '未知'}`)
        : '';
      const missWarn = (res.missingKeys && res.missingKeys.length)
        ? `\n⚠ metadata 缺少字段: ${res.missingKeys.join(', ')}（说明写盘路径未同步）`
        : '';
      setStatus(
        `完成 ✅\n目录: 归档/${res.noteFolderName}\n图片: 成功 ${res.ok} / 失败 ${res.fail}${videoMsg}\nmetadata.json 已写入${missWarn}`,
        missWarn ? 'err' : 'ok'
      );
      await new Promise((r) => setTimeout(r, 800));
      $('archive').disabled = false;
    } catch (e) {
      setStatus('归档失败: ' + (e.message || e), 'err');
      $('archive').disabled = false;
    }
  }

  $('archive').addEventListener('click', performArchive);

  // ---------- 搜索结果页粗糙采集 ----------
  // 分工：采集与缓冲在内容脚本（弹窗关掉也继续），落盘在这里。
  // 所以本弹窗每次打开都会先"补救"——把 storage 里还没写盘的分片写进批次文件。
  const SEARCH_DIR = 'searches';

  function searchSchema() { return window.XHS_SCHEMA || null; }

  async function activeTabId() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    return tab && tab.id ? tab.id : null;
  }

  function sendToTab(tabId, msg) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error('页面没有响应，请刷新检索页后重试（' + (err.message || '') + '）'));
        else if (!res) reject(new Error('页面没有返回数据，请刷新检索页后重试'));
        else resolve(res);
      });
    });
  }

  async function listSearchStorage() {
    const all = await chrome.storage.local.get(null);
    const chunks = [];
    const sessions = {};
    for (const k of Object.keys(all)) {
      if (k.indexOf('searchChunk:') === 0) chunks.push(Object.assign({ key: k }, all[k]));
      else if (k.indexOf('searchSession:') === 0 && all[k] && all[k].sessionId) sessions[all[k].sessionId] = all[k];
    }
    return { all, chunks, sessions };
  }

  // 批次文件名只定一次；同名已存在就加序号，绝不覆盖已有文件。
  // 文件名里的排序方式取 filters 里的 sort_type（用户实际应用的筛选），
  // 而不是请求体里那个旧的 sort 标量——实测两者会矛盾（sort=general 而 filters 说 time_descending）。
  async function ensureSearchFile(dir, sid, header) {
    const key = 'searchFile:' + sid;
    const saved = (await chrome.storage.local.get(key))[key];
    if (saved && saved.name) return saved.name;
    const sch = searchSchema();
    let sortValue = header.sort || '';
    const filters = Array.isArray(header.filters) ? header.filters : [];
    const sortFilter = filters.find((f) => f && f.type === 'sort_type');
    if (sortFilter && Array.isArray(sortFilter.tags) && sortFilter.tags.length) sortValue = sortFilter.tags[0];
    const base = (sch && sch.searchFileName)
      ? sch.searchFileName(header.keyword, header.startedAt, sortValue)
      : ('batch_' + Date.now());
    let name = base;
    for (let i = 2; i <= 20; i++) {
      let exists = false;
      try {
        await dir.getFileHandle(name + '.jsonl');
        exists = true;
      } catch (e) { exists = false; }
      if (!exists) break;
      name = base + '-' + i;
    }
    await chrome.storage.local.set({ [key]: { name: name } });
    return name;
  }

  // 封面在写行之前下：这样行里的 coverFile 当场就是确定的，不留"以后补"
  async function downloadCovers(dir, batchName, hits) {
    const targets = hits.filter((h) => h.itemKind === 'note' && h.coverUrl && !h.coverFile);
    const stat = { ok: 0, fail: 0 };
    if (!targets.length) return stat;
    const imgDir = await getDir(dir, batchName);
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const h = targets[cursor];
        cursor += 1;
        const fname = String(h.seq).padStart(3, '0') + '_' + (h.noteId || 'note') + '.' + extFromUrl(h.coverUrl, 'jpg');
        try {
          const bytes = await fetchBytes(h.coverUrl);
          await writeFile(imgDir, fname, bytes);
          h.coverFile = fname;
          stat.ok += 1;
        } catch (e) {
          stat.fail += 1; // 下不到就留 null，不假装有图
        }
      }
    };
    const n = Math.min(6, targets.length);
    await Promise.all(Array.from({ length: n }, worker));
    return stat;
  }

  // 把 storage 里所有待写分片写进对应的批次文件
  async function drainSearchBuffer(root) {
    const { chunks, sessions, all } = await listSearchStorage();
    if (!chunks.length) return { hits: 0, sessions: 0, pending: 0 };
    const bySession = {};
    for (const c of chunks) {
      if (!c.sessionId) continue;
      (bySession[c.sessionId] = bySession[c.sessionId] || []).push(c);
    }
    const dir = await getDir(root, SEARCH_DIR);
    let wroteHits = 0, wroteSessions = 0, leftPending = 0;
    for (const sid of Object.keys(bySession)) {
      const header = sessions[sid];
      // 没有会话头就不写：宁可留在缓冲里，也不写进一份来源不明的文件
      if (!header) { leftPending += bySession[sid].length; continue; }
      // 还不知道检索词就先别建文件：会话头在采集开始那一刻就写了，那时 keyword 还是空的。
      // 文件名一旦定下就不再改（会被缓存），所以必须等到第一个批次把 keyword 填进来。
      // 采集已结束时不再等（避免永远写不出去），那时是真的没抓到检索词。
      const capturing = all.searchProgress && all.searchProgress.sessionId === sid && all.searchProgress.active;
      if (!header.keyword && capturing) { leftPending += bySession[sid].length; continue; }
      const list = bySession[sid].slice().sort((a, b) => (a.index || 0) - (b.index || 0));
      const name = await ensureSearchFile(dir, sid, header);
      const fh = await dir.getFileHandle(name + '.jsonl', { create: true });
      const file = await fh.getFile();
      let text = await file.text();
      if (!text) text = JSON.stringify(header) + '\n';
      const hits = [];
      for (const c of list) for (const h of (c.hits || [])) hits.push(h);
      const coverStat = await downloadCovers(dir, name, hits);
      const lines = hits.map((h) => JSON.stringify(h)).join('\n');
      if (lines) text += lines + '\n';
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
      // 写成功了才删分片：中途失败时数据仍在，下次打开接着写
      await chrome.storage.local.remove(list.map((c) => c.key));
      // 封面成败累加到会话头（文件里的头在收尾时统一重写）
      const coverBefore = (all['searchCover:' + sid] || { ok: 0, fail: 0 });
      await chrome.storage.local.set({
        ['searchCover:' + sid]: { ok: (coverBefore.ok || 0) + coverStat.ok, fail: (coverBefore.fail || 0) + coverStat.fail },
        ['searchWritten:' + sid]: { hits: ((all['searchWritten:' + sid] || {}).hits || 0) + hits.length, updatedAt: new Date().toISOString() },
      });
      wroteHits += hits.length;
      wroteSessions += 1;
    }
    return { hits: wroteHits, sessions: wroteSessions, pending: leftPending };
  }

  // 收尾：采集已结束且分片都写完了，才把会话头（第一行）重写成终值。
  // 用 flag 防止每次轮询都重写一遍。
  async function finalizeSearchSessions(root) {
    const { chunks, sessions, all } = await listSearchStorage();
    const pendingBy = {};
    for (const c of chunks) pendingBy[c.sessionId] = (pendingBy[c.sessionId] || 0) + 1;
    const prog = all.searchProgress || {};
    // 只找不建：没有批次文件时不该因为一次收尾就在归档目录里建出 searches
    let dir = null;
    try { dir = await root.getDirectoryHandle(SEARCH_DIR); } catch (e) { dir = null; }
    if (!dir) return 0;
    let done = 0;
    for (const sid of Object.keys(sessions)) {
      if (pendingBy[sid]) continue;                                  // 还有分片没写
      if (!prog || prog.sessionId !== sid || prog.active) continue;   // 采集还没结束
      if (all['searchFinal:' + sid]) continue;                        // 已经收过尾
      const saved = (all['searchFile:' + sid] || {}).name;
      if (!saved) continue;
      let fh;
      try { fh = await dir.getFileHandle(saved + '.jsonl'); } catch (e) { continue; }
      const text = await (await fh.getFile()).text();
      const nl = text.indexOf('\n');
      if (nl < 0) continue;
      const written = text.slice(nl + 1).split('\n').filter(Boolean).length;
      const cover = all['searchCover:' + sid] || { ok: 0, fail: 0 };
      const head = Object.assign({}, sessions[sid], {
        endedAt: prog.endedAt || sessions[sid].endedAt || null,
        cover: { ok: cover.ok || 0, fail: cover.fail || 0 },
        coverage: Object.assign({}, sessions[sid].coverage || {}, { writtenHits: written, complete: false }),
      });
      const w = await fh.createWritable();
      await w.write(JSON.stringify(head) + text.slice(nl));
      await w.close();
      await chrome.storage.local.set({ ['searchFinal:' + sid]: { at: new Date().toISOString() } });
      done += 1;
    }
    return done;
  }

  async function searchStatusLine() {
    const all = await chrome.storage.local.get(null);
    const prog = all.searchProgress || null;
    let pending = 0;
    for (const k of Object.keys(all)) if (k.indexOf('searchChunk:') === 0) pending += ((all[k] && all[k].hits) || []).length;
    const written = prog && prog.sessionId ? ((all['searchWritten:' + prog.sessionId] || {}).hits || 0) : 0;
    if (!prog) return { text: pending ? ('有 ' + pending + ' 条已采但未写盘，点「开始采集」或重新打开本弹窗会自动写入') : '尚未采集', active: false };
    const lines = [];
    if (prog.active) lines.push('采集中：已滚 ' + (prog.roundsDone || 0) + '/' + (prog.rounds || 0) + ' 次');
    else lines.push('已结束' + (prog.stopReason ? '（' + prog.stopReason + '）' : ''));
    lines.push('已采 ' + (prog.hitCount || 0) + ' 条（笔记 ' + (prog.noteCount || 0) + (prog.duplicateCount ? '，剔除重复 ' + prog.duplicateCount : '') + '）');
    lines.push('已写盘 ' + written + ' 条' + (pending ? '，待写 ' + pending + ' 条' : ''));
    if (prog.keyword) lines.push('检索词：' + prog.keyword);
    if (prog.intervalWarning) lines.push('⚠ 间隔偏短（低于 1 秒不会更快拿到数据，只会更像自动化）');
    if (prog.onSearchPage === false) lines.push('⚠ 当前地址不像搜索结果页；如果是从结果点进了笔记，滚动通常已经无效，建议回到检索页再采');    return { text: lines.join(' · '), active: !!prog.active };
  }

  let draining = false;
  async function drainAndShow(root) {
    if (draining) return;
    draining = true;
    try {
      const res = await drainSearchBuffer(root);
      await finalizeSearchSessions(root);
      const st = await searchStatusLine();
      const line = $('search-status');
      if (line) line.textContent = st.text + (res.hits ? ('　（本次写入 ' + res.hits + ' 条）') : '');
      $('search-start').disabled = st.active;
      $('search-stop').disabled = !st.active;
    } catch (e) {
      const line = $('search-status');
      if (line) line.textContent = '写入失败：' + String(e && e.message || e) + '（数据仍在，重新打开本弹窗会重试）';
    } finally {
      draining = false;
    }
  }

  async function ensureSearchRoot() {
    let root = await getRootHandle();
    if (!root) throw new Error('请先选择归档目录');
    root = await ensureWritePermission(root);
    return root;
  }

  const storedRounds = await chrome.storage.local.get(['searchRounds', 'searchIntervalMs']);
  const sch = searchSchema();
  $('search-rounds').value = (storedRounds && storedRounds.searchRounds) || (sch ? sch.SEARCH_DEFAULT_ROUNDS : 5);
  $('search-interval').value = (storedRounds && storedRounds.searchIntervalMs) || (sch ? sch.SEARCH_DEFAULT_INTERVAL_MS : 2000);
  const saveSearchOpts = () => {
    chrome.storage.local.set({
      searchRounds: parseInt($('search-rounds').value, 10) || (sch ? sch.SEARCH_DEFAULT_ROUNDS : 5),
      searchIntervalMs: parseInt($('search-interval').value, 10) || (sch ? sch.SEARCH_DEFAULT_INTERVAL_MS : 2000),
    });
  };
  $('search-rounds').addEventListener('change', saveSearchOpts);
  $('search-interval').addEventListener('change', saveSearchOpts);

  $('search-start').addEventListener('click', async () => {
    saveSearchOpts();
    try {
      await ensureSearchRoot(); // 目录与权限先确认，免得采完才发现写不了
      const tabId = await activeTabId();
      if (!tabId) throw new Error('没有活动标签页');
      const res = await sendToTab(tabId, {
        type: 'searchCaptureStart',
        rounds: parseInt($('search-rounds').value, 10),
        intervalMs: parseInt($('search-interval').value, 10),
      });
      if (!res.ok) throw new Error(res.error || '启动失败');
      const root = await getRootHandle();
      await drainAndShow(root);
    } catch (e) {
      $('search-status').textContent = '启动失败：' + String(e && e.message || e);
    }
  });

  $('search-stop').addEventListener('click', async () => {
    try {
      const tabId = await activeTabId();
      if (tabId) await sendToTab(tabId, { type: 'searchCaptureStop' });
      const root = await getRootHandle();
      await drainAndShow(root);
    } catch (e) {
      $('search-status').textContent = '停止失败：' + String(e && e.message || e);
    }
  });

  // 打开就补救一次，之后每秒跟一次：弹窗关着的时候采集照跑，重开继续写
  try {
    const root0 = await getRootHandle();
    if (root0) await drainAndShow(root0);
    else {
      const st = await searchStatusLine();
      $('search-status').textContent = st.text;
    }
  } catch (e) { /* 忽略 */ }
  setInterval(async () => {
    try {
      const root = await getRootHandle();
      if (root) await drainAndShow(root);
    } catch (e) { /* 忽略 */ }
  }, 1000);

  $('open-manage').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // 面板按钮触发的"自动归档"：带 autoArchive 标记，打开弹窗即自动归档
  const flags = await chrome.storage.local.get('autoArchive');
  if (flags && flags.autoArchive) {
    await chrome.storage.local.set({ autoArchive: false });
    await performArchive();
  }
});
