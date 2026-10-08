/**
 * font-inject.js — 注入 web 字体声明
 *
 * ## 字体来源
 *
 * Yozai Medium（站点大标题）与 LXGW WenKai Medium（正文）来自 ZeoSeven 的
 * cn-font-split 分片服务：
 *   https://fontsapi.zeoseven.com/192/medium/result.css
 *   https://fontsapi.zeoseven.com/292/medium/result.css
 *
 * 它们的 result.css 里每个 @font-face 都带 `unicode-range` 切片，
 * 单片约 5 KB，浏览器只下载页面实际用到的区间，不会拉整套字体
 * （Yozai Medium 完整 TTF 有 15 MB、LXGW WenKai 有 25 MB）。
 *
 * ## 为什么用 <link> 而不是 @import 或 fetch后注入
 *
 * - `@import` 在 CSS 里会阻塞渲染，且必须写在最前；
 * - fetch + 手工注入属于运行时阻塞字体，要等 JS 执行完才生效，会闪一下默认字体；
 * - `<link rel="stylesheet">` 是浏览器原生支持的并行加载路径，
 *   且带 `media="print" onload` 之类的非阻塞技巧可以进一步优化。
 *
 * 这里直接注入 <link>，并保留系统字体作为 fallback：
 * 字体服务不可达时（部分网络环境）会优雅回退到系统字体，
 * 而不是像纯 web font 那样出现不可预期的排版。
 *
 * ## 加载失败的回退
 *
 * @font-face 全部声明了 `local()` 优先，浏览器本机装了这套字也会直接用，
 * 不产生任何网络请求。
 */

'use strict';

const { transformRoute } = require('./lib/route-transform');

/** 需要注入的字体；family 名需与 CSS 里 font-family 写法完全一致 */
const FONTS = [
  {
    family: 'Yozai Medium',
    href: 'https://fontsapi.zeoseven.com/192/medium/result.css',
  },
  {
    family: 'LXGW WenKai Medium',
    href: 'https://fontsapi.zeoseven.com/292/medium/result.css',
  },
];

function buildLinkTags() {
  return FONTS.map(
    (f) =>
      `  <link rel="stylesheet" href="${f.href}" crossorigin="anonymous">` +
      `<!-- ${f.family} -->`
  ).join('\n');
}

/**
 * 额外注入一条 @font-face-less 的 body font-family 兜底规则？
 * 不需要——font-family 由 _config.shokax.yml 的
 * font.global.family / font.logo.family 生成到主题样式里。
 * 但主题的 font.global 只影响 $font-family-base，
 * 而标题走 $font-family-logo，所以两处配置都要设（见 _config.shokax.yml 注释）。
 */

hexo.extend.filter.register('after_generate', function () {
  const links = buildLinkTags();
  const marker = 'fontsapi.zeoseven.com';

  const { attached } = transformRoute(
    hexo,
    (html) => {
      if (html.includes(marker)) return html;   // 已注入过，不重复
      // 插到 </head> 前。只替换最后一个 </head>（页面里可能有其它插件注入的内容）。
      return /<\/head>(?![\s\S]*<\/head>)/i.test(html)
        ? html.replace(/<\/head>(?![\s\S]*<\/head>)/i, links + '\n</head>')
        : html;
    },
    undefined,
    'font-inject'
  );

  if (attached) {
    hexo.log.info(`[font-inject] 已向 ${attached} 个页面注入 ${FONTS.length} 个字体声明`);
  }
});

module.exports = { FONTS };
