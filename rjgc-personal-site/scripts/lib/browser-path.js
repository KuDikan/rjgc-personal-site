/**
 * browser-path.js — Hexo route 路径 ↔ 浏览器 location.pathname 的换算
 *
 * ## 为什么需要这个共享模块
 *
 * Waline 的访问量统计要求两条路径必须一致：
 *   - footer.pug 渲染的 `data-path`，取自 Hexo 的 `post.path`
 *   - comments.ts 传给 pageviewCount 的 `path`，取自 `window.location.pathname`
 *
 * 两者的**形态不同**：
 *   Hexo post.path:      about/index.html      （无前导斜杠，带 index.html）
 *   浏览器 pathname:     /about/               （有前导斜杠，目录式）
 *
 * 不一致时 Waline 客户端会把这个元素归到"只查不增"组，
 * 导致浏览量记在一个 key 上、按另一个 key 查 → 永远是 0。
 *
 * scripts/waline-path-fix.js 负责把产物里的 data-path 规范化，
 * tools/validate.mjs 负责断言规范化结果正确。
 * 两处必须用**同一套换算规则**，否则校验会和修复各说各话，
 * 所以抽成这个模块，单一来源。
 *
 * 注意：这里是 CommonJS，因为 Hexo 的 scripts/ 插件由 require() 加载，
 * 无法同步 import ESM。validate.mjs 是 ESM，用 createRequire 引它。
 */

'use strict';

/**
 * 把 Hexo 的 route 路径转成浏览器 `location.pathname` 的形态。
 *
 * @param {string} routePath 形如 'about/index.html' 或 '/about/index.html'
 * @returns {string} 形如 '/about/'
 *
 * 示例：
 *   about/index.html      → /about/
 *   posts/foo/index.html  → /posts/foo/
 *   index.html            → /
 *   404.html              → /404.html   （文件式页面，无 index.html 可剥）
 *   /about/               → /about/     （已是目标形态，原样返回）
 */
function toBrowserPath(routePath) {
  let p = String(routePath == null ? '' : routePath);
  if (!p) return '/';
  if (!p.startsWith('/')) p = '/' + p;
  // 只剥结尾的 index.html，且剥完后要保留目录斜杠
  p = p.replace(/\/index\.html$/i, '/');
  return p;
}

module.exports = { toBrowserPath };
