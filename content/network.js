/**
 * XHS Archive - 网络响应拦截（MAIN world, document_start）
 * 目的：小红书笔记详情是通过 API 拉取的，这里 hook fetch/XHR，
 * 捕获包含笔记数据的响应（note_card / note），存入 window.__XHS_NOTE_API__，
 * 并同步写到一个隐藏 DOM 节点，供隔离 world 的抽取模块读取。
 */
(function () {
  'use strict';
  if (window.__XHS_NETWORK_INSTALLED__) return;
  window.__XHS_NETWORK_INSTALLED__ = true;

  // 供隔离 world 读取的缓存容器
  const MAP = {}; // noteId -> note_card

  function isXhsApiUrl(url) {
    if (!url) return false;
    return /xiaohongshu\.com\/api\//.test(url) || /xiaohongshu\.com\//.test(url);
  }

  // 判断一个对象是否是"笔记"：具备 id/noteId + 标题/正文/图片 任一特征
  function looksLikeNote(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    const hasId = !!(o.id || o.noteId || o.note_id);
    const hasTitle = typeof o.title === 'string' && o.title.length > 0;
    const hasDesc = typeof o.desc === 'string' && o.desc.length > 0;
    const hasImages = Array.isArray(o.imageList) && o.imageList.length > 0;
    return hasId && (hasTitle || hasDesc || hasImages);
  }

  // 递归找出所有"像笔记"的对象（不固定结构，抗改版）
  function collectNoteCards(j) {
    const cards = [];
    const seenIds = new Set();
    const seenObjs = new WeakSet();
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 6) return;
      if (seenObjs.has(o)) return;
      seenObjs.add(o);
      if (looksLikeNote(o)) {
        const id = o.id || o.noteId || o.note_id;
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          cards.push(o);
        }
        return; // 笔记对象内部不再深入找子笔记
      }
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (v && typeof v === 'object') walk(v, depth + 1);
      }
    };
    walk(j, 0);
    return cards;
  }

  function flushToDom() {
    try {
      let node = document.getElementById('xhs-note-api');
      if (!node) {
        node = document.createElement('div');
        node.id = 'xhs-note-api';
        node.style.display = 'none';
        document.documentElement.appendChild(node);
      }
      node.textContent = JSON.stringify(Object.values(MAP));
      let u = document.getElementById('xhs-note-api-urls');
      if (!u) {
        u = document.createElement('div');
        u.id = 'xhs-note-api-urls';
        u.style.display = 'none';
        document.documentElement.appendChild(u);
      }
      u.textContent = JSON.stringify(URLS);
    } catch (e) {
      // 忽略
    }
  }

  const URLS = []; // 拦截到的 xhs api url

  function ingest(json, url) {
    try {
      if (url) URLS.push(url);
      const cards = collectNoteCards(json);
      if (!cards.length) return;
      let changed = false;
      for (const c of cards) {
        const id = c.id || c.noteId || c.note_id;
        if (id && !MAP[id]) {
          MAP[id] = c;
          changed = true;
        }
      }
      if (changed) {
        window.__XHS_NOTE_API__ = MAP;
        flushToDom();
      } else {
        // 即便没有新笔记，也更新 URL 记录
        flushToDom();
      }
    } catch (e) {
      // 忽略解析失败
    }
  }

  // hook fetch
  const _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      const p = _fetch.call(this, input, init);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (isXhsApiUrl(url)) {
          p.then((resp) => {
            try {
              const ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
              if (ct.indexOf('json') >= 0) {
                const cloned = resp.clone();
                cloned.json().then((j) => ingest(j, url)).catch(() => {});
              }
            } catch (e) {}
          }).catch(() => {});
        }
      } catch (e) {}
      return p;
    };
  }

  // hook XMLHttpRequest
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__xhs_url = url; } catch (e) {}
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      this.addEventListener('load', function () {
        try {
          if ((this.status === 200 || this.status === 304) && grepXhs(this.__xhs_url) && this.responseText) {
            const j = JSON.parse(this.responseText);
            ingest(j, this.__xhs_url);
          }
        } catch (e) {}
      });
    } catch (e) {}
    return _send.apply(this, arguments);
  };
  function grepXhs(url) {
    return isXhsApiUrl(url);
  }
})();
