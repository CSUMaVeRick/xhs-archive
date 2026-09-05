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

// ---------- 归档 ----------
async function archiveNote(rootHandle, note) {
  const d = dateParts(new Date()); // 归档日期（保存当天）
  const titlePart = (note.title && note.title.trim()) ? '_' + note.title : '';
  const noteFolderName = sanitize((note.noteId || 'note') + titlePart);
  const monthDir = await getDir(rootHandle, d.month);
  const dayDir = await getDir(monthDir, d.day);
  const noteDir = await getDir(dayDir, noteFolderName);

  // metadata.json
  const meta = {
    ...note,
    _archiveTime: new Date().toISOString(),
    _archiveDate: d.day,
    _imageFiles: (note.imageList || []).map((img, i) => `images/${String(i + 1).padStart(2, '0')}.${extFromUrl(img.url, 'jpg')}`),
    _videoFile: note.hasVideo && note.video && note.video.url ? 'video/video.mp4' : null,
  };
  await writeFile(noteDir, 'metadata.json', JSON.stringify(meta, null, 2));
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
  const quality = await getVideoQuality();
  const streams = (note.hasVideo && note.video && note.video.streams) ? note.video.streams : null;
  const videoUrl = note.hasVideo ? (streams ? pickVideoUrl(streams, quality) : (quality === 'cover' ? '' : note.video.url)) : '';
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

  return { ok, fail, noteFolderName, videoOk, videoErr, videoCoverOnly };
}

// ---------- UI ----------
const $ = (id) => document.getElementById(id);

function showNote(note) {
  const el = $('note-info');
  if (!note) {
    el.textContent = '（尚未在本页面抓到笔记）';
    $('archive').disabled = true;
    return;
  }
  const imgs = (note.imageList || []).length;
  el.innerHTML = `${note.title || '（无标题）'}<br>作者: ${(note.author && note.author.nickname) || '?'} · 图片: ${imgs} 张<br><span style="color:#999">noteId: ${note.noteId || '?'}</span>`;
  $('archive').disabled = false;
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
      setStatus(
        `完成 ✅\n目录: 归档/${res.noteFolderName}\n图片: 成功 ${res.ok} / 失败 ${res.fail}${videoMsg}\nmetadata.json 已写入`,
        'ok'
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
