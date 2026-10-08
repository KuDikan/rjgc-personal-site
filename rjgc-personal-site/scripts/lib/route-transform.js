/**
 * route-transform.js — 让 after_generate 能改写最终产物内容
 *
 * ## 为什么需要这个工具
 *
 * 目标是在构建最后阶段（after_generate）改写**最终 HTML**，
 * 例如把 [[标题]] 变成超链接、给页面注入搜索脚本。
 *
 * 但 Hexo 7 的 route 有两个坑，让这件事不能想当然：
 *
 * 1. **after_generate 时文件尚未落盘**。
 *    该 filter 在 `_routerRefresh()` 之后执行，此时 public/ 目录都可能不存在。
 *    直接 readFileSync/writeFileSync 改 public/ 等于什么都没做——
 *    典型症状是日志打印"已改写 5 个文件"，产物里一个改动都没有。
 *
 * 2. **不能就地改 RouteStream**。
 *    route.get(path) 返回 RouteStream，其 `_data`（可能是一个惰性函数）
 *    在**构造函数里就赋值并捕获**。之后再改 `stream._data` 不会被读取，
 *    因为 flush 时用的是另一个 Route 实例包装原始 data。
 *    实测：改 _data 后日志显示成功，产物毫无变化。
 *
 * ## 解法
 *
 * 用 `route.set(path, { data, modified: true })` 写入新的包装对象。
 * set() 是 Hexo 官方替换 route 内容的接口，会构造新的 RouteStream，
 * 因此 data 必须是一个**函数**——在 flush 时求值并返回改写后的 HTML。
 *
 * 用法：
 *   const { transformRoute } = require('./lib/route-transform');
 *   hexo.extend.filter.register('after_generate', function () {
 *     transformRoute(hexo, (html) => html.replace(...));
 *   });
 */

'use strict';

/** 只处理 HTML，避免动css/js/图片 */
function isHtmlPath(path) {
  return /\.html?$/i.test(String(path));
}

/** 把任意形态的输出统一成字符串；非文本返回 null */
function toText(data) {
  if (data == null) return null;
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
  return null;
}

/** 看起来像 HTML 才处理，避免误伤二进制资源 */
function looksLikeHtml(text) {
  return typeof text === 'string' && text.trimStart().startsWith('<');
}

/**
 * 给匹配到的 route 挂上内容改写。
 *
 * @param {object} hexo Hexo 实例（route 与 log 都挂在它上面）
 * @param {(html: string, path: string) => string} fn 返回改写后的 HTML
 * @param {(path: string) => boolean} [match] 路径过滤器，默认只处理 .html
 * @param {string} [label] 日志前缀
 * @returns {{ attached: number }} attached = 已挂载改写的 route 数量
 */
function transformRoute(hexo, fn, match = isHtmlPath, label = 'route-transform') {
  const routes = hexo.route;
  const list = routes.list();
  if (!list.length) return { attached: 0 };

  let attached = 0;

  for (const path of list) {
    if (!match(path)) continue;

    const entry = routes.get(path);
    if (!entry) continue;

    // route.get() 返回的是 RouteStream（包装器），真正的内容在 entry._data，
    // 它可能是具体值，也可能是惰性函数。直接包装 get() 的结果会得到
    // stream套stream，flush 时读出来仍是未改写的内容。
    const original = entry._data;
    if (original === undefined) continue;

    const resolve = typeof original === 'function' ? original : () => original;

    routes.set(path, {
      data: async () => {
        const value = await resolve();
        const text = toText(value);
        if (!looksLikeHtml(text)) return value;
        try {
          return fn(text, path);
        } catch (err) {
          hexo.log.error(`[${label}] 处理 ${path} 失败：${err.message}`);
          return value;
        }
      },
      modified: true,
    });

    attached++;
  }

  return { attached };
}

module.exports = { transformRoute, isHtmlPath, toText, looksLikeHtml };
