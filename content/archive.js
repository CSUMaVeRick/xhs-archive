/**
 * XHS Archive - 页面内直接归档（content script 隔离 world）
 * 面板按钮的点击即用户手势，可在此处调用 File System Access 授权并直接写盘，
 * 从而实现"无弹窗"归档。写权限句柄存在页面源 IndexedDB。
 */
(function () {
  'use strict';
  if (window.__XHS_ARCHIVE__) return;

  const DB = 'xhs-archive';
  const VER = 1;
  const STORE = 'handles';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, VER);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
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
  function idbPut(key, val) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  async function getRootHandle() { return await idbGet('root'); }
  async function setRootHandle(h) { await idbPut('root', h); }

  async function pickRoot() {
    const h = await window.showDirectoryPicker({ mode: 'readwrite' });
    await setRootHandle(h);
    return h;
  }
  async function ensurePerm(handle) {
    try { const q = await handle.queryPermission({ mode: 'readwrite' }); if (q === 'granted') return handle; } catch (e) {}
    const r = await handle.requestPermission({ mode: 'readwrite' });
    if (r === 'granted') return handle;
    return await pickRoot(); // 兜底：重新选目录
  }

  function sanitize(s) { return String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled'; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function dateParts(d) { return { month: d.getFullYear() + '-' + pad(d.getMonth() + 1), day: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }; }
  function extFromUrl(url, fb) { const m = (url || '').match(/\.([A-Za-z0-9]+)(?:\?|$)/); return (m && m[1]) || fb || 'jpg'; }
  async function getDir(p, n) { return await p.getDirectoryHandle(n, { create: true }); }
  async function writeFile(dir, name, data) { const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(data); await w.close(); }
  async function fetchBytes(url) {
    // 先按原样抓（视频 master_url 带签名，转 https 会破坏签名）；host_permissions 已覆盖 http+https
    const resp = await fetch(url, { credentials: 'omit' });
    if (resp.ok) return await resp.arrayBuffer();
    // 失败再退回 https 版本重试
    if (/^http:\/\//i.test(url)) {
      const resp2 = await fetch(url.replace(/^http:\/\//i, 'https://'), { credentials: 'omit' });
      if (resp2.ok) return await resp2.arrayBuffer();
      throw new Error('HTTP ' + resp2.status);
    }
    throw new Error('HTTP ' + resp.status);
  }

  async function getVideoQuality() {
    try {
      const r = await chrome.storage.local.get('videoQuality');
      return (r && r.videoQuality) || 'autobest';
    } catch (e) { return 'autobest'; }
  }
  function pickVideoUrl(streams, quality) {
    if (!streams || !streams.length) return '';
    if (quality === 'cover') return ''; // 仅封面，不下载视频
    if (quality === 'autobest') return [...streams].sort((a, b) => (b.width || 0) - (a.width || 0))[0].url;
    const target = quality === '1080p' ? 1080 : 720;
    const eligible = streams.filter((s) => (s.width || 0) <= target);
    const pool = eligible.length ? eligible : streams;
    return [...pool].sort((a, b) => (b.width || 0) - (a.width || 0))[0].url;
  }

  async function writeNote(root, note) {
    const d = dateParts(new Date());
    const titlePart = (note.title && note.title.trim()) ? '_' + note.title : '';
    const noteFolderName = sanitize((note.noteId || 'note') + titlePart);
    const monthDir = await getDir(root, d.month);
    const dayDir = await getDir(monthDir, d.day);
    const noteDir = await getDir(dayDir, noteFolderName);

    // 按画质设置选视频地址（cover=仅封面）
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
      if (globalThis.XHS_CARD && globalThis.XHS_CARD.render) {
        await writeFile(noteDir, 'index.html', globalThis.XHS_CARD.render(note, meta));
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
        await writeFile(imagesDir, String(i + 1).padStart(2, '0') + '.' + extFromUrl(img.url, 'jpg'), bytes);
        ok++;
      } catch (e) { fail++; }
    }

    let videoOk = false, videoErr = '', videoCoverOnly = false;
    if (note.hasVideo) {
      if (quality === 'cover' || !videoUrl) {
        videoCoverOnly = true; // 仅封面或不存视频
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

  async function archive(note) {
    let root = await getRootHandle();
    if (!root) {
      // 第一次：让用户选一次归档目录
      root = await pickRoot();
      return await writeNote(root, note);
    }
    // 已有句柄：先用点击手势重新授权并写入，避免每次都重新弹目录选择框
    try { await root.requestPermission({ mode: 'readwrite' }); } catch (e) {}
    try {
      return await writeNote(root, note);
    } catch (e) {
      // 写失败（权限变了）才重新选目录兜底
      root = await pickRoot();
      return await writeNote(root, note);
    }
  }

  window.__XHS_ARCHIVE__ = { archive, hasRoot: () => getRootHandle().then(Boolean) };
})();
