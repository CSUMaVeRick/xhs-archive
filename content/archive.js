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

  // 共享常量（content/schema.js 在 manifest 中先于本文件加载）
  const schema = () => globalThis.XHS_SCHEMA || null;
  const authorsFileName = () => (schema() && schema().AUTHORS_FILE) || 'authors.json';

  // 数据完整性闸门：API 卡片与当前 URL 的 noteId 不一致时，写下去就是错标样本。
  // 标记 code，避免 archive() 的「重新选目录」兜底把它当成权限问题吞掉。
  function guardNote(note) {
    if (note && note._extraction && note._extraction.noteIdMismatch) {
      const err = new Error(
        '中止归档：抓到的是 noteId ' + (note._extraction.pickedNoteId || '未知') +
        '，与页面 ' + (note._extraction.urlNoteId || '未知') + ' 不一致（可能仍停留在上一篇）。请稍候重试。'
      );
      err.code = 'NOTE_ID_MISMATCH';
      throw err;
    }
  }

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
    guardNote(note);

    const sch = schema();
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
      _schemaVersion: sch ? sch.SCHEMA_VERSION : 2,
      _pluginVersion: sch ? sch.pluginVersion() : '0.2.0',
      _archiveRoot: { context: 'page', name: (root && root.name) || '' },
      _archiveTime: new Date().toISOString(),
      _archiveDate: d.day,
      _videoQuality: quality,
      _imageFiles: (note.imageList || []).map((img, i) => `images/${String(i + 1).padStart(2, '0')}.${extFromUrl(img.url, 'jpg')}`),
      _videoFile: videoUrl ? 'video/video.mp4' : null,
    };
    // 评论正文另存 comments.json，metadata 里只留摘要（管理页要遍历所有 metadata.json）
    const cm = sch && sch.splitComments ? sch.splitComments(note) : { meta: null, list: [] };
    meta._commentsMeta = cm.meta;
    delete meta._comments;
    await writeFile(noteDir, 'metadata.json', JSON.stringify(meta, null, 2));
    if (cm.list.length) {
      await writeFile(noteDir, sch.COMMENTS_FILE, JSON.stringify({
        noteId: note.noteId || '',
        // 写入时刻；评论本身是什么时候看到的，看 meta.capturedAt（两者含义不同，别混）
        archivedAt: new Date().toISOString(),
        meta: cm.meta,
        comments: cm.list,
      }, null, 2));
    }
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

    // 归档质量落盘：metadata.json 先写（媒体下载中途失败时记录仍在），
    // 结束时把实际成败补写回去——否则"这条其实缺 3 张图"事后查不出来。
    Object.assign(meta, {
      _imageOk: ok,
      _imageFail: fail,
      _videoOk: videoOk,
      _videoCoverOnly: videoCoverOnly,
      _videoError: videoErr || null,
    });
    await writeFile(noteDir, 'metadata.json', JSON.stringify(meta, null, 2));

    return { ok, fail, noteFolderName, videoOk, videoErr, videoCoverOnly };
  }

  async function archive(note) {
    guardNote(note); // 先挡数据问题，避免被下面的目录兜底流程误当成权限错误
    let root = await getRootHandle();
    if (!root) {
      // 第一次：让用户选一次归档目录
      root = await pickRoot();
      return await writeNoteAndMark(root, note);
    }
    // 已有句柄：先用点击手势重新授权并写入，避免每次都重新弹目录选择框
    try { await root.requestPermission({ mode: 'readwrite' }); } catch (e) {}
    try {
      return await writeNoteAndMark(root, note);
    } catch (e) {
      if (e && e.code === 'NOTE_ID_MISMATCH') throw e;
      // 写失败（权限变了）才重新选目录兜底
      root = await pickRoot();
      return await writeNoteAndMark(root, note);
    }
  }

  // 每次归档顺手把清单里的"已归档"标记刷新一下（一个作者一个小文件，代价可忽略）。
  // 这样"作者主页上就能看到还差哪几篇"，且**不需要遍历数千个 metadata.json** —— 页面源句柄
  // 不能读扩展源选的目录（见 docs/DESIGN.md 的双句柄域），遍历不可行。
  async function writeNoteAndMark(root, note) {
    const res = await writeNote(root, note);
    try { await markArchivedInManifest(root, note); } catch (e) { /* 对账信息是附加的，失败不影响归档 */ }
    return res;
  }

  async function markArchivedInManifest(root, note) {
    const sch = schema();
    if (!sch || !sch.mergeAuthorNotes) return null;
    const userId = (note && note._author && note._author.userId) || (note && note.author && note.author.userId) || '';
    const noteId = sch.normalizeNoteId ? sch.normalizeNoteId(note && note.noteId) : String((note && note.noteId) || '');
    if (!userId || !noteId) return null;
    const dir = await getDir(await getDir(root, '_meta'), 'authors');
    const fileName = userId + '.json';
    let manifest = null;
    try {
      const fh = await dir.getFileHandle(fileName);
      manifest = JSON.parse(await (await fh.getFile()).text());
    } catch (e) { return null; } // 还没抓到这位作者的清单：不用凭空造一个
    const list = Array.isArray(manifest && manifest.notes) ? manifest.notes : [];
    if (!list.some((n) => n && n.noteId === noteId)) return null; // 不在清单里就不动（避免把清单变成"归档流水"）
    const merged = sch.mergeAuthorNotes(manifest, list.map((n) => Object.assign({}, n, n.noteId === noteId ? { archived: true } : null)), new Date().toISOString());
    const notes = Object.values(merged.notes).map((n) => Object.assign({}, n, { archived: n.noteId === noteId ? true : !!n.archived }));
    const out = Object.assign({}, manifest, {
      notes: notes,
      coverage: Object.assign({}, manifest.coverage || {}, { archivedAt: new Date().toISOString() }),
    });
    await writeFile(dir, fileName, JSON.stringify(out, null, 2));
    return out;
  }

  // 读某位作者的清单（供面板在作者主页直接显示对账），带一份内存缓存
  let notesManifestCache = {};   // userId -> manifest
  async function readAuthorNotes(userId, force) {
    const sch = schema();
    if (!userId) return null;
    const cached = notesManifestCache[userId];
    if (cached && !force) return cached;
    const root = await getRootHandle();
    if (!root) return cached || null;
    try {
      const dir = await getDir(await getDir(root, '_meta'), 'authors');
      const fh = await dir.getFileHandle(userId + '.json');
      const obj = JSON.parse(await (await fh.getFile()).text());
      notesManifestCache[userId] = obj;
      return obj;
    } catch (e) {
      // 文件不存在：可能是还没抓到过清单，也可能是权限过期 —— 都不打扰用户，返回缓存或 null
      notesManifestCache[userId] = cached || null;
      return cached || null;
    }
  }

  // ---------- 作者归档（单文件 authors.json，键为 userId） ----------
  // ponytail: 读-改-写整个文件；两个标签同时点「保存作者」有极小概率丢记录
  // （单用户手工点按，窗口只有毫秒级）。真要并发再改成每作者一个文件。
  async function readAuthorsFile(root) {
    try {
      const fh = await root.getFileHandle(authorsFileName());
      return JSON.parse(await (await fh.getFile()).text());
    } catch (e) {
      return null; // 文件不存在或损坏都按"从空开始"，不能因此阻断归档
    }
  }

  async function saveAuthors(root, records, excludeUserId) {
    const sch = schema();
    if (!sch || !sch.mergeAuthors) throw new Error('schema 模块未加载，无法合并作者数据');
    const existing = await readAuthorsFile(root);
    const merged = sch.mergeAuthors(existing, records, new Date().toISOString());
    // 登录者本人不是作者样本：此前误收的记录在这里一并清掉
    const pruned = sch.removeAuthor(merged.authors, excludeUserId);
    const out = sch.authorsFileShell(existing, pruned.authors);
    await writeFile(root, authorsFileName(), JSON.stringify(out, null, 2));
    return {
      file: authorsFileName(),
      added: merged.added,
      changed: merged.changed,
      confirmed: merged.confirmed,
      removedSelf: pruned.removed,
      total: Object.keys(pruned.authors).length,
    };
  }

  async function archiveAuthors(records, excludeUserId) {
    if (!records || !records.length) {
      return { added: 0, changed: 0, confirmed: 0, total: 0, empty: true };
    }
    let root = await getRootHandle();
    if (!root) {
      root = await pickRoot();
      return await saveAuthors(root, records, excludeUserId);
    }
    try { await root.requestPermission({ mode: 'readwrite' }); } catch (e) {}
    try {
      return await saveAuthors(root, records, excludeUserId);
    } catch (e) {
      root = await pickRoot();
      return await saveAuthors(root, records, excludeUserId);
    }
  }

  // ---------- 作者笔记清单（对账用，写 _meta/authors/<userId>.json） ----------
  // 只写清单，不碰笔记目录；管理页拿它跟"已归档的 metadata.json"对账，回答"还差哪几篇"。
  // 注意：清单里的链接（含 xsec_token）是页面加载那一刻抓到的，会过期 —— 它只是路标，不承诺可直开。
  const AUTHORS_DIR = '_meta/authors';
  const AUTHOR_NOTES_SCHEMA = 1;

  async function writeJsonFile(root, dirPath, name, obj) {
    const parts = String(dirPath).split('/').filter(Boolean);
    let dir = root;
    for (const p of parts) dir = await getDir(dir, p);
    await writeFile(dir, name, JSON.stringify(obj, null, 2));
  }

  async function saveAuthorNotes(manifest, authorInfo) {
    const sch = schema();
    if (!manifest || !manifest.userId) return { ok: false, error: '缺少作者 userId' };
    if (!sch || !sch.mergeAuthorNotes) return { ok: false, error: 'schema 模块未加载' };

    let root = await getRootHandle();
    if (!root) { root = await pickRoot(); return await doSaveAuthorNotes(root, manifest, authorInfo); }
    try { await root.requestPermission({ mode: 'readwrite' }); } catch (e) {}
    try {
      return await doSaveAuthorNotes(root, manifest, authorInfo);
    } catch (e) {
      root = await pickRoot();
      return await doSaveAuthorNotes(root, manifest, authorInfo);
    }
  }

  async function doSaveAuthorNotes(root, manifest, authorInfo) {
    const sch = schema();
    const dir = await getDir(await getDir(root, '_meta'), 'authors');
    const fileName = manifest.userId + '.json';
    let existing = null;
    try {
      const fh = await dir.getFileHandle(fileName);
      existing = JSON.parse(await (await fh.getFile()).text());
    } catch (e) { existing = null; } // 不存在或损坏都按"从空开始"

    const now = new Date().toISOString();
    const merged = sch.mergeAuthorNotes(existing, manifest.notes, now);
    // 平台声明的篇数：只增不减（后端有时不返回 note_count，别把已知值覆盖成 null）
    const declared = manifest.declaredNoteCount != null
      ? manifest.declaredNoteCount
      : ((existing && existing.author && existing.author.declaredNoteCount) || null);
    const out = {
      _type: 'authorNotes',
      schemaVersion: AUTHOR_NOTES_SCHEMA,
      pluginVersion: sch.pluginVersion ? sch.pluginVersion() : '',
      author: Object.assign({}, (existing && existing.author) || {}, authorInfo || {}, {
        userId: manifest.userId,
        declaredNoteCount: declared,
        capturedAt: now,
      }),
      coverage: {
        notes: merged.total,
        hasMore: manifest.hasMore === undefined ? null : manifest.hasMore,
        cursorLast: manifest.cursorLast || null,
        source: manifest.source || 'unknown',
        droppedBatches: manifest.droppedBatches || 0,
        capturedAt: now,
      },
      notes: Object.values(merged.notes).sort((a, b) => String(a.firstSeenAt || '').localeCompare(String(b.firstSeenAt || ''))),
      _note: '清单只用于对账（平台上有几篇 / 我们见过哪几篇 / 还差哪几篇）；详情仍由人工逐篇归档。链接里的 xsec_token 会过期。',
    };
    await writeFile(dir, fileName, JSON.stringify(out, null, 2));
    return { ok: true, file: AUTHORS_DIR + '/' + fileName, added: merged.added, total: merged.total, declared: declared };
  }

  window.__XHS_ARCHIVE__ = {
    archive, archiveAuthors, saveAuthorNotes, readAuthorNotes, markArchivedInManifest,
    hasRoot: () => getRootHandle().then(Boolean),
  };
})();
