/**
 * waline-path-fix.js — 让访问量统计的 data-path 与浏览器实际路径一致
 *
 * ## Bug 现象
 *
 * 页面访问量一直是 0。抓请求发现两条路径对不上：
 *
 *   显示时请求（来自 footer.pug 的 data-path）：/api/article?path=/about/index.html
 *   计数时请求（来自 comments.ts）：            /api/article?path=/about/
 *
 * ## 根因
 *
 * ShokaX 有**两个**地方给 Waline 传路径，取值来源不同：
 *
 *   1. layout/_partials/post/footer.pug
 *        - var prefixedPath = post.path.startsWith('/') ? post.path : '/' + post.path
 *        span(class="waline-pageview-count" data-path=prefixedPath)
 *      → 用的是 Hexo **构建期**的 post.path，形如 `about/index.html`
 *
 *   2. js/_app/components/comments.ts 的 walinePageview()
 *        pageviewCount({ serverURL, path: window.location.pathname })
 *      → 用的是**浏览器运行时**的 pathname，形如 `/about/`
 *
 * 而 Waline 客户端 pageviewCount 的逻辑是（见其 dist 源码）：
 *
 *   const isDifferent = (el) => {
 *     const p = getPath(el)            // 读 data-path
 *     return p != null && path !== p   // 有 data-path 且与传入 path 不同
 *   }
 *   // 一致的：既查又增（Gn 会 +1）
 *   // 不一致的：只查不增（u(c)）
 *
 * 我们的元素 data-path=`/about/index.html`，传入 path=`/about/`，
 * 两者不等 → 该元素落进"只查不增"那一组：
 *   - 浏览量 +1 记到了 `/about/` 名下（没人展示它）
 *   - 展示时查的是 `/about/index.html`（从没被记过）→ 永远 0
 *
 * ## 修复
 *
 * 把 `data-path` 规范成浏览器实际访问的路径形态，与
 * `window.location.pathname` 对齐。这样两条路径合一，
 * 元素落进"既查又增"那组，计数与显示都用同一个 key。
 *
 * 转换规则（Hexo route path → 浏览器 pathname）：
 *   about/index.html      → /about/
 *   posts/foo/index.html  → /posts/foo/
 *   index.html            → /
 *
 * ## 为什么不直接删掉 data-path
 *
 * 删掉也能让 Waline 回退用 window.location.pathname（行为上等价），
 * 但保留属性并写正确值更稳妥：将来若主题改为用别的路径来源，
 * 或有人想给单个页面指定自定义统计路径，属性还在、语义清楚。
 *
 * 不改主题源码（不触碰 AGPL §7(b) 署名义务），用 after_generate 改写产物。
 */

'use strict';

const { transformRoute } = require('./lib/route-transform');
const { toBrowserPath } = require('./lib/browser-path');

/** 只匹配带 waline-pageview-count 类的 span，避免误伤别的 data-path */
const COUNT_SPAN = /(<span\b[^>]*\bclass="[^"]*\bwaline-pageview-count\b[^"]*"[^>]*\sdata-path=")([^"]*)(")/gi;

hexo.extend.filter.register('after_generate', function () {
  // 注意：transformRoute 的改写回调是在 route flush 时才求值的
  // （见 lib/route-transform.js 的说明），所以这里拿不到"改了几处"。
  // 只报挂载了多少个页面；实际是否正确由 validate.mjs 断言产物。
  const { attached } = transformRoute(
    hexo,
    (html, path) => {
      if (!html.includes('waline-pageview-count')) return html;

      const want = toBrowserPath(path);
      return html.replace(COUNT_SPAN, (whole, pre, cur, post) =>
        cur === want ? whole : pre + want + post
      );
    },
    undefined,
    'waline-path-fix'
  );

  if (attached) {
    hexo.log.info(
      `[waline-path-fix] 已挂载 data-path 规范化（${attached} 个页面，flush 时生效）`
    );
  }
});

// toBrowserPath 已移入 scripts/lib/browser-path.js（与 validate.mjs 共用同一套规则）
