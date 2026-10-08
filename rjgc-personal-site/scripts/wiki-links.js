/**
 * wiki-links.js — 把 [[页面标题]] 渲染成双向链接
 *
 * 背景：Wiki 约定用 [[标题]] 互链，但**没有任何渲染器支持这个语法**，
 * markdown 会原样输出方括号，页面上就是一堆 [[如何给需求分级]] 噪音。
 * （站点文档曾写"Hexo 会把它渲染成可点击的链接"，那是错的，已修正。）
 *
 * 时机选择（踩过两个坑，见 lib/route-transform.js 的说明）：
 *   - after_post_render 太早：locals 只含已处理的那几篇，索引不完整；
 *   - 直接改 public/ 文件无效：after_generate 时文件尚未落盘。
 * 正确做法是在 after_generate 包装 route 的惰性 data，
 * 在 flush 时机改写最终 HTML。
 *
 * 匹配策略：原始标题 → 去首尾空白 → 忽略全部空白。
 * 中文标题常有肉眼看不出的空格差异，最后一条很关键。
 *
 * 匹配不到时不静默消失，而是渲染成带 title 的 span 并在构建日志列出，
 * 否则标题写错很难排查。
 *
 * 安全：标题来自本仓库内容，但统一走 escapeHTML / safeUrl，
 * 避免将来若有外部数据经此路径进入时引入注入。
 */

'use strict';

const { escapeHTML, safeUrl } = require('./lib/render-helpers');
const { transformRoute } = require('./lib/route-transform');

const LINK_RE = /\[\[([^\]\n]+)\]\]/g;

/** 归一化：去掉所有空白，用于宽松匹配 */
function normalize(text) {
  return String(text === null || text === undefined ? '' : text).replace(/\s+/g, '');
}

function buildIndex(hexo) {
  const index = new Map();
  const add = (title, path) => {
    if (!title || !path) return;
    const raw = String(title).trim();
    if (!index.has(raw)) index.set(raw, path);
    const flat = normalize(raw);
    if (!index.has(flat)) index.set(flat, path);
  };

  hexo.locals.get('posts').toArray().forEach((p) => add(p.title, p.path));
  hexo.locals.get('pages').toArray().forEach((p) => {
    if (p.type === '404') return; // 404 不作为互链目标
    add(p.title, p.path);
  });

  return index;
}

function toUrl(hexo, path) {
  try {
    return hexo.extend.helper.get('url_for').call({ config: hexo.config }, path);
  } catch {
    return path.startsWith('/') ? path : '/' + path;
  }
}

hexo.extend.filter.register('after_generate', function () {
  const index = buildIndex(hexo);

  const stats = { links: 0 };
  const missing = new Set();

  const { attached } = transformRoute(
    hexo,
    (html) =>
      html.replace(LINK_RE, (match, rawTitle) => {
        const title = rawTitle.trim();
        const hit = index.get(title) ?? index.get(normalize(title));

        if (!hit) {
          missing.add(title);
          return `<span class="wiki-missing" title="未找到对应页面：${escapeHTML(title)}">${escapeHTML(title)}</span>`;
        }
        stats.links++;
        return `<a class="wiki-link" href="${safeUrl(toUrl(hexo, hit))}" title="${escapeHTML(title)}">${escapeHTML(title)}</a>`;
      }),
    undefined,
    'wiki-links'
  );

  if (attached) {
    hexo.log.info(`[wiki-links] 已挂载互链改写，涉及 ${attached} 个页面，实际替换 ${stats.links} 处`);
  }
  if (missing.size) {
    hexo.log.warn(
      `[wiki-links] 有 ${missing.size} 个 [[...]] 未匹配到页面：` +
      [...missing].join('、') +
      '。请让标题与文章 front-matter 的 title 一致（忽略空格差异）。'
    );
  }
});
