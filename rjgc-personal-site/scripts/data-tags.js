/**
 * data-tags.js — 构建期把 source/_data/*.json 渲染进页面
 *
 * 为什么需要这个文件：
 * 之前 papers/rss/status/wiki 四个页面里放的是客户端占位 div
 *（<p class="loading">正在加载…</p>），但站点里没有任何脚本会去填它们。
 * 而 Hexo 是静态生成器——source/_data/*.json 在构建期就可用，
 * 根本不需要前端 JS。正确做法是用标签在构建期渲染成静态 HTML。
 *
 * 为什么放在 scripts/ 而不是 tools/：
 * scripts/ 是 Hexo 的**插件目录**，Hexo 会把里面的文件当插件 require。
 * 因此这里必须用 CommonJS（require/module.exports），
 * 且文件名不能与 tools/ 下的 .mjs 构建脚本混用。
 * tools/ 里的脚本是我自己用 node 跑的，与 Hexo 无关。
 *
 * 安全边界（重要）：
 * papers 与 rss 的内容来自**外部不可信数据源**（arXiv API、第三方 RSS）。
 * 所有插入 HTML 的文本一律经escapeHtml 转义；
 * 所有 href 经 safeUrl 过滤，只允许 http/https，
 * 避免 "javascript:" 伪协议与属性注入。绝不将外部内容当 HTML 解析。
 */

'use strict';

const { escapeHTML, safeUrl, fmtDate } = require('./lib/render-helpers');

/** 读取 source/_data/<name>.json；不存在时返回 null而不是抛错 */
function loadData(hexo, name) {
  const data = hexo.locals.get('data');
  return data ? data[name] : null;
}

function missingHint(name, file) {
  return `<p class="data-empty">尚未生成 <code>${escapeHTML(file)}</code>，` +
    `请在项目根目录执行 <code>npm run data</code> 后重新构建。</p>`;
}

// ---------------------------------------------------------------------------
// {% status_panel %}
// ---------------------------------------------------------------------------
function statusPanel(hexo) {
  const status = loadData(hexo, 'status');
  if (!status) return missingHint('status', 'source/_data/status.json');

  const c = status.counts || {};
  const s = status.stack || {};

  const rows = [
    ['文章', c.posts, '/categories/'],
    ['分类', countCategories(hexo), '/categories/'],
    ['标签', countTags(hexo), '/tags/'],
    ['Wiki 词条', c.wikiPages, '/wiki/'],
    ['论文条目', c.papers, '/papers/'],
    ['订阅源', c.externalFeeds, '/rss/'],
    ['订阅条目', c.rssItems, '/rss/'],
  ];

  const items = rows.map(([label, value, href]) => `
      <li class="stat">
        <a class="stat-body" href="${safeUrl(href)}">
          <span class="stat-value">${escapeHTML(String(value ?? 0))}</span>
          <span class="stat-label">${escapeHTML(label)}</span>
        </a>
      </li>`).join('');

  const stack = Object.entries(s).map(([k, v]) => `
        <div class="stack-row">
          <span class="stack-key">${escapeHTML(k)}</span>
          <span class="stack-val">${escapeHTML(String(v))}</span>
        </div>`).join('');

  return `<section class="data-panel">
  <ul class="stat-grid">${items}
  </ul>
  <div class="panel-block">
    <h3>技术栈</h3>
    <div class="stack-list">${stack}
    </div>
  </div>
  <p class="panel-note">
    最近构建：<time datetime="${escapeHTML(String(status.lastBuild))}">${escapeHTML(String(status.lastBuild))}</time>
  </p>
  <p class="panel-note">${escapeHTML(status.notes || '')}</p>
</section>`;
}

function countCategories(hexo) {
  return hexo.locals.get('categories').filter((c) => c.length).length;
}
function countTags(hexo) {
  return hexo.locals.get('tags').filter((t) => t.length).length;
}

// ---------------------------------------------------------------------------
// {% papers_list [limit] %}
// ---------------------------------------------------------------------------
function papersList(hexo, args) {
  const data = loadData(hexo, 'papers');
  if (!data) return missingHint('papers', 'source/_data/papers.json');

  const limit = parseInt(args && args[0], 10);
  const all = data.papers || [];
  const list = Number.isFinite(limit) && limit > 0 ? all.slice(0, limit) : all;

  if (!list.length) {
    return `<p class="data-empty">本次抓取没有取到论文（${escapeHTML(data.notes || '')}）</p>`;
  }

  const items = list.map((p) => {
    const authors = (p.authors || []).slice(0, 3).map(escapeHTML).join('、');
    const more = (p.authors || []).length > 3 ? ' 等' : '';
    return `<li class="paper">
  <div class="paper-head">
    <a class="paper-title" href="${safeUrl(p.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(p.title)}</a>
  </div>
  <div class="paper-meta">
    <span class="paper-id">${escapeHTML(String(p.id || ''))}</span>
    <span class="paper-date">${escapeHTML(fmtDate(p.published))}</span>
    <span class="paper-authors">${authors}${more}</span>
  </div>
  ${p.summary ? `<p class="paper-abstract">${escapeHTML(p.summary)}</p>` : ''}
</li>`;
  }).join('');

  return `<section class="data-panel">
  <h3>最新论文 <span class="panel-count">${list.length} 篇</span></h3>
  <ul class="paper-list">${items}
  </ul>
  <p class="panel-note">${escapeHTML(data.notes || '')}</p>
</section>`;
}

// ---------------------------------------------------------------------------
// {% rss_items %}
// ---------------------------------------------------------------------------
function rssItems(hexo) {
  const data = loadData(hexo, 'rss-items');
  if (!data) return missingHint('rss-items', 'source/_data/rss-items.json');

  const feeds = data.feeds || [];
  const items = data.items || [];

  if (!items.length) {
    return `<p class="data-empty">尚未抓取到外部订阅内容，请执行 <code>npm run data</code>。</p>`;
  }

  const groups = feeds.map((f) => {
    const list = items.filter((i) => i.feedId === f.id);
    if (!list.length) return '';
    const rows = list.map((i) => `
    <li class="rss-item">
      <a class="rss-link" href="${safeUrl(i.link)}" target="_blank" rel="noopener noreferrer">${escapeHTML(i.title)}</a>
      ${i.published ? `<span class="rss-date">${escapeHTML(i.published)}</span>` : ''}
      ${i.summary ? `<p class="rss-summary">${escapeHTML(i.summary)}</p>` : ''}
    </li>`).join('');
    return `<div class="feed-group">
  <h3>${escapeHTML(f.title)}<span class="panel-count">${list.length}</span></h3>
  <ul class="rss-list">${rows}
  </ul>
</div>`;
  }).join('');

  return `<section class="data-panel">${groups}
  <p class="panel-note">${escapeHTML(data.notes || '')}</p>
</section>`;
}

// ---------------------------------------------------------------------------
// {% wiki_index %}
// ---------------------------------------------------------------------------
function wikiIndex(hexo) {
  const pages = hexo.locals.get('pages').toArray()
    .filter((p) => p.path && p.path.startsWith('wiki/') && p.path.endsWith('index.html'));

  if (!pages.length) return `<p class="data-empty">Wiki 还没有词条。</p>`;

  const rows = pages.map((p) => `
    <li class="wiki-entry">
      <a href="${safeUrl(p.path.replace(/index\.html$/, ''))}">${escapeHTML(p.title)}</a>
      ${p.updated ? `<span class="wiki-updated">更新于 ${escapeHTML(String(p.updated).slice(0, 10))}</span>` : ''}
    </li>`).join('');

  return `<section class="data-panel">
  <ul class="wiki-list">${rows}
  </ul>
</section>`;
}

// ---------------------------------------------------------------------------
// 注册标签
// ---------------------------------------------------------------------------
hexo.extend.tag.register('status_panel', () => statusPanel(hexo));
hexo.extend.tag.register('papers_list', (args) => papersList(hexo, args));
hexo.extend.tag.register('rss_items', () => rssItems(hexo));
hexo.extend.tag.register('wiki_index', () => wikiIndex(hexo));