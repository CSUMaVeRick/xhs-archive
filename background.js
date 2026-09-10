/**
 * XHS Archive - Background Service Worker
 *
 * 归档不在这里做：实际生效的两条写盘路径是 content/archive.js（页面工具栏，主路径）
 * 与 popup.js（弹窗），两者都在有用户手势的上下文里，可直接用 File System Access 写盘。
 * 本文件只保留消息中继。
 */
'use strict';
console.log('[XHS Archive] background v4 loaded');

// ponytail: 下面的 downloadImage 没有任何调用方（全仓库搜 type:'downloadImage' 无结果），
// 属于 v0.1.0 之前的旧路径，作者有意保留；确认无用后可连同 manifest 的 downloads 权限一起删。
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
});
