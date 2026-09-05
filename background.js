/**
 * XHS Archive - Background Service Worker
 * 职责：① 带防盗链下载（保留）；② 直接归档到用户选的目录（File System Access）。
 * 归档不需要弹窗：后台用 IndexedDB 里的目录句柄 + host_permissions 抓图，静默写盘。
 */
'use strict';
importScripts('content/card.js');
console.log('[XHS Archive] background v3 loaded');

// ---------------- IndexedDB（目录句柄持久化，与 popup 同源共享） ----------------
const DB_NAME = 'xhs-archive';
const DB_VERSION = 1;
const STORE = 'handles';
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
function idbGet(key) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
async function getRootHandle() {
  return await idbGet('root');
}

// ---------------- 工具 ----------------
function sanitize(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled';
}
function pad(n) { return String(n).padStart(2, '0'); }
function dateParts(d) {
  return { month: d.getFullYear() + '-' + pad(d.getMonth() + 1), day: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) };
}
function extFromUrl(url, fb) {
  const m = (url || '').match(/\.([A-Za-z0-9]+)(?:\?|$)/);
  return (m && m[1]) || fb || 'jpg';
}
async function getDir(parent, name) { return await parent.getDirectoryHandle(name, { create: true }); }
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
async function ensureWritePermission(handle) {
  try {
    const q = await handle.queryPermission({ mode: 'readwrite' });
    if (q === 'granted') return handle;
  } catch (e) {}
  // 后台无法弹权限请求（需要用户手势），直接报错，引导去弹窗重新选目录
  throw new Error('归档目录写权限已失效，请点击扩展图标重新选择目录');
}

async function getVideoQuality() {
  try {
    const r = await chrome.storage.local.get('videoQuality');
    return (r && r.videoQuality) || 'autobest';
  } catch (e) { return 'autobest'; }
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

// ---------------- 归档到磁盘 ----------------
async function archiveNoteToDisk(note) {
  const handle = await getRootHandle();
  if (!handle) throw new Error('尚未选择归档目录，请点击扩展图标→选择归档目录');
  await ensureWritePermission(handle);

  const d = dateParts(new Date());
  const titlePart = (note.title && note.title.trim()) ? '_' + note.title : '';
  const noteFolderName = sanitize((note.noteId || 'note') + titlePart);
  const monthDir = await getDir(handle, d.month);
  const dayDir = await getDir(monthDir, d.day);
  const noteDir = await getDir(dayDir, noteFolderName);

  const quality = await getVideoQuality();
  const streams = (note.hasVideo && note.video && note.video.streams) ? note.video.streams : null;
  const videoUrl = note.hasVideo ? (streams ? pickVideoUrl(streams, quality) : (quality === 'cover' ? '' : note.video.url)) : '';

  const meta = {
    ...note,
    _archiveTime: new Date().toISOString(),
    _archiveDate: d.day,
    _videoQuality: quality,
    _imageFiles: (note.imageList || []).map((img, i) => `images/${String(i + 1).padStart(2, '0')}.${extFromUrl(img.url, 'jpg')}`),
    _videoFile: videoUrl ? 'video/video.mp4' : null,
  };
  await writeFile(noteDir, 'metadata.json', JSON.stringify(meta, null, 2));
  // 离线可看的卡片页
  try {
    if (typeof XHS_CARD !== 'undefined' && XHS_CARD.render) {
      await writeFile(noteDir, 'index.html', XHS_CARD.render(note, meta));
    }
  } catch (e) {}

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
    } catch (e) { fail++; }
  }

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

// ---------------- 旧：防盗链下载（保留） ----------------
async function fetchImageBytes(url) {
  const safeUrl = url.replace(/^http:\/\//i, 'https://');
  const resp = await fetch(safeUrl, { credentials: 'omit' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + resp.statusText + ' for ' + safeUrl.slice(0, 80));
  const buf = await resp.arrayBuffer();
  return { buf, type: resp.headers.get('content-type') || '' };
}
function extFromType(type) {
  if (!type) return 'jpg';
  if (/png/i.test(type)) return 'png';
  if (/webp/i.test(type)) return 'webp';
  if (/gif/i.test(type)) return 'gif';
  if (/jpeg|jpg/i.test(type)) return 'jpg';
  if (/video\/mp4/i.test(type)) return 'mp4';
  const m = type.match(/^image\/(\w+)/);
  return m ? m[1] : 'jpg';
}
function bufToDataUrl(buf, type) {
  const base64 = btoa(new Uint8Array(buf).reduce((acc, byte) => acc + String.fromCharCode(byte), ''));
  return 'data:' + (type || 'image/jpeg') + ';base64,' + base64;
}
async function downloadImage(url, filename) {
  const { buf, type } = await fetchImageBytes(url);
  const dataUrl = bufToDataUrl(buf, type);
  const name = filename || 'xhs_archive_img_' + Date.now() + '.' + extFromType(type);
  const id = await chrome.downloads.download({ url: dataUrl, filename: name });
  return { ok: true, downloadId: id, size: buf.byteLength, type: type || 'unknown' };
}

// ---------------- 消息 ----------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'downloadImage') {
    downloadImage(msg.url, msg.filename)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg && msg.type === 'openPopup') {
    chrome.action.openPopup()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg && msg.type === 'archiveNote') {
    archiveNoteToDisk(msg.note)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
});
