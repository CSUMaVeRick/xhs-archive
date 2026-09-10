/**
 * XHS Archive - 共享卡片模板
 * 生成离线可看的 index.html（引用本地图片/视频）。被 content script / popup / background 共用。
 * 暴露 global.XHS_CARD.render(note, meta)。
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function statRow(note) {
    const s = note.stats || {};
    const items = [
      ['赞', s.likeCount], ['收藏', s.collectCount], ['评论', s.commentCount], ['分享', s.shareCount],
    ];
    // 统计数缺失时显示 "—"：0 与"没抓到"在研究场景里含义完全不同
    return items.map(([k, v]) => `<div class="stat"><span class="n">${v == null ? '—' : esc(v)}</span><span class="k">${k}</span></div>`).join('');
  }

  function imagesHtml(imageFiles) {
    if (!imageFiles || !imageFiles.length) return '';
    const imgs = imageFiles.map((f) => `<img src="${esc(f)}" loading="lazy" />`).join('');
    return `<section class="gallery">${imgs}</section>`;
  }

  function videosHtml(videoFile) {
    if (!videoFile) return '';
    return `<section class="video"><video src="${esc(videoFile)}" controls playsinline></video></section>`;
  }

  function render(note, meta) {
    meta = meta || {};
    const author = note.author || {};
    const tags = (note.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join('');
    const time = note.publishTime ? esc(String(note.publishTime).slice(0, 10).replace('T', ' ')) : '';
    const loc = note.ipLocation ? esc(note.ipLocation) : '';

    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(note.title || '小红书笔记')}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #f7f7f7; color: #333; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.6; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 20px 16px 60px; }
  .card { background: #fff; border-radius: 14px; overflow: hidden; box-shadow: 0 2px 14px rgba(0,0,0,0.06); }
  .head { padding: 18px 18px 0; }
  .title { font-size: 20px; font-weight: 700; margin: 0 0 12px; }
  .author { display: flex; align-items: center; gap: 10px; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: #eee; }
  .aname { font-size: 14px; font-weight: 600; }
  .ameta { font-size: 12px; color: #999; }
  .stats { display: flex; gap: 18px; margin-top: 14px; padding: 12px 0; border-top: 1px solid #f2f2f2; border-bottom: 1px solid #f2f2f2; }
  .stat { text-align: center; }
  .stat .n { display: block; font-size: 16px; font-weight: 700; color: #ff2442; }
  .stat .k { font-size: 12px; color: #999; }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; padding: 14px 18px 0; }
  .tag { font-size: 12px; color: #ff2442; background: #fff0f2; padding: 3px 9px; border-radius: 12px; }
  .desc { padding: 14px 18px; white-space: pre-wrap; }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; padding: 0 18px 6px; }
  .gallery img { width: 100%; display: block; border-radius: 8px; }
  .video { padding: 6px 18px; }
  .video video { width: 100%; border-radius: 8px; } 
  .orig { padding: 16px 18px 20px; font-size: 12px; }
  .orig a { color: #ff2442; word-break: break-all; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="head">
      <h1 class="title">${esc(note.title || '(无标题)')}</h1>
      <div class="author">
        ${author.avatar ? `<img class="avatar" src="${esc(author.avatar)}" />` : '<div class="avatar"></div>'}
        <div>
          <div class="aname">${esc(author.nickname || '—')}</div>
          <div class="ameta">${time}${loc ? ' · ' + loc : ''}</div>
        </div>
      </div>
      <div class="stats">${statRow(note)}</div>
    </div>
    ${tags ? `<div class="tags">${tags}</div>` : ''}
    ${note.desc ? `<div class="desc">${esc(note.desc)}</div>` : ''}
    ${imagesHtml(meta._imageFiles)}
    ${videosHtml(meta._videoFile)}
    <div class="orig">原帖：<a href="${esc(note.url || '#')}" target="_blank" rel="noopener">${esc(note.url || '')}</a></div>
  </div>
</div>
</body>
</html>`;
  }

  global.XHS_CARD = { render };
})(typeof window !== 'undefined' ? window : self);
