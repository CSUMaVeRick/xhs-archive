/**
 * XHS Archive - 归档管理页
 * 选择归档根目录，遍历所有已归档笔记（读取 metadata.json），支持搜索与离线预览。
 */
'use strict';

const DB = 'xhs-archive';
const VER = 1;
const STORE = 'handles';
const $ = (id) => document.getElementById(id);

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

let rootHandle = null;
let notes = []; // { dir, meta, ... }
let filtered = [];

async function loadRoot() {
  rootHandle = await idbGet('manageRoot');
  if (rootHandle) $('pick-dir').textContent = '切换归档目录: ' + rootHandle.name;
}

async function pickRoot() {
  const h = await window.showDirectoryPicker({ mode: 'read' });
  await idbPut('manageRoot', h);
  rootHandle = h;
  $('pick-dir').textContent = '切换归档目录: ' + h.name;
  await loadNotes();
}

async function resolveFile(dir, relPath) {
  const parts = String(relPath).split('/').filter(Boolean);
  let h = dir;
  for (let i = 0; i < parts.length - 1; i++) h = await h.getDirectoryHandle(parts[i]);
  return await h.getFileHandle(parts[parts.length - 1]);
}

async function walkDir(dir, depth, out) {
  if (depth > 5) return;
  try {
    const iter = dir.values();
    for await (const entry of iter) {
      if (entry.kind === 'file') {
        if (entry.name === 'metadata.json') {
          try {
            const f = await dir.getFileHandle('metadata.json');
            const meta = JSON.parse(await (await f.getFile()).text());
            out.push({ dir, meta });
          } catch (e) {}
        }
      } else if (entry.kind === 'directory' && depth < 5) {
        await walkDir(entry, depth + 1, out);
      }
    }
  } catch (e) {
    console.error('[XHS manage] walk error:', e);
  }
}

async function loadNotes() {
  if (!rootHandle) return;
  notes = [];
  try {
    await walkDir(rootHandle, 0, notes);
  } catch (e) { console.error('[XHS manage] load error:', e); }
  notes.sort((a, b) => String(b.meta._archiveDate || '').localeCompare(String(a.meta._archiveDate || '')));
  applyFilter();
}

function renderList() {
  const listEl = $('list');
  listEl.innerHTML = '';
  for (const n of filtered) {
    const meta = n.meta;
    const tags = (meta.tags || []).slice(0, 5).map((t) => `<span class="tag">#${esc(t)}</span>`).join('');
    const div = document.createElement('div');
    div.className = 'note';
    div.innerHTML = `<div class="t">${esc(meta.title || '(无标题)')}</div>
      <div class="a">${esc((meta.author && meta.author.nickname) || '?')} · ${esc(meta._archiveDate || '')} · ${(meta.imageList || []).length}图${meta.hasVideo ? '·视频' : ''}</div>
      <div class="tags">${tags}</div>`;
    div.addEventListener('click', () => preview(n));
    listEl.appendChild(div);
  }
  $('count').textContent = `${filtered.length} / ${notes.length} 篇`;
  $('empty').style.display = notes.length ? 'none' : 'block';
}

function applyFilter() {
  const q = $('search').value.trim().toLowerCase();
  filtered = notes.filter((n) => {
    if (!q) return true;
    const meta = n.meta;
    return (meta.title || '').toLowerCase().includes(q)
      || ((meta.author && meta.author.nickname) || '').toLowerCase().includes(q)
      || (meta.tags || []).some((t) => t.toLowerCase().includes(q));
  });
  renderList();
}

async function preview(n) {
  const meta = n.meta;
  const box = $('preview-content');
  const stats = meta.stats || {};
  // 读取图片/视频为 objectURL
  let imgsHtml = '';
  const imgUrls = [];
  try {
    for (const p of (meta._imageFiles || [])) {
      const f = await resolveFile(n.dir, p);
      imgUrls.push(URL.createObjectURL(f));
    }
  } catch (e) {}
  imgsHtml = imgUrls.map((u) => `<img src="${u}" />`).join('');
  let videoHtml = '';
  if (meta._videoFile) {
    try {
      const f = await resolveFile(n.dir, meta._videoFile);
      videoHtml = `<video src="${URL.createObjectURL(f)}" controls></video>`;
    } catch (e) {}
  }
  const tags = (meta.tags || []).map((t) => `<span>#${esc(t)}</span>`).join('');
  box.innerHTML = `
    <h2 class="pv-title">${esc(meta.title || '(无标题)')}</h2>
    <div class="pv-meta">${esc((meta.author && meta.author.nickname) || '?')} · ${esc(meta.publishTime || '')}${meta.ipLocation ? ' · ' + esc(meta.ipLocation) : ''}</div>
    <div class="pv-stats"><span>👍 <b>${stats.likeCount || 0}</b></span><span>⭐ <b>${stats.collectCount || 0}</b></span><span>💬 <b>${stats.commentCount || 0}</b></span><span>↗ <b>${stats.shareCount || 0}</b></span></div>
    ${tags ? `<div class="pv-tags">${tags}</div>` : ''}
    ${meta.desc ? `<div class="pv-desc">${esc(meta.desc)}</div>` : ''}
    ${imgsHtml}
    ${videoHtml}
    ${meta.url ? `<div style="margin-top:16px;font-size:12px"><a href="${esc(meta.url)}" target="_blank" rel="noopener">查看小红书原帖</a></div>` : ''}
  `;
  $('preview').hidden = false;
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

document.addEventListener('DOMContentLoaded', async () => {
  await loadRoot();

  $('pick-dir').addEventListener('click', async () => {
    try {
      // 若已存句柄，先用手势重新授权即可复用；否则重新选目录
      if (rootHandle) {
        try {
          const p = await rootHandle.requestPermission({ mode: 'read' });
          if (p === 'granted') { await loadNotes(); return; }
        } catch (e) {}
      }
      const h = await window.showDirectoryPicker({ mode: 'read' });
      await idbPut('manageRoot', h);
      rootHandle = h;
      $('pick-dir').textContent = '切换归档目录: ' + h.name;
      await loadNotes();
    } catch (e) {
      if (e && e.name !== 'AbortError') alert('加载失败: ' + (e.message || e));
    }
  });

  $('search').addEventListener('input', applyFilter);
  $('close-preview').addEventListener('click', () => { $('preview').hidden = true; });
  $('preview').addEventListener('click', (e) => { if (e.target === $('preview')) $('preview').hidden = true; });
});
