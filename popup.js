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
