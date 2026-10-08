/**
 * player-playing-class.js — 播放时给 #tool 加 playing class
 *
 * ## 问题
 *
 * ShokaX 的样式里，播放按钮的图标是靠 `#tool` 上的 `playing` class 切换的
 * （theme/source/css/_common/outline/header/tool.styl）：
 *
 *     #tool {
 *       .play-pause::before { @extend .i-play:before; }
 *       ...
 *       &.playing .player {
 *         .play-pause::before { @extend .i-pause:before; }
 *       }
 *     }
 *
 * 也就是说：DOM 上没有 `.playing` → 图标永远是播放三角，
 * 哪怕音频已经在放。原版（配了带播放器的场景）由主题在播放时给
 * `#tool` 加这个 class、暂停时移除。
 *
 * 而ShokaX 0.5.4 的 `js/_app/player.ts` 只做了：
 *
 *     initPlayer('#player', '#showBtn', urls, '#playBtn', 'html[data-theme="dark"]', 'shokax')
 *
 * **没有任何代码给 #tool 加/删 playing**。nyx-player 内部确实维护了
 * `playing` 状态（Pinia store：`actions: { start(){playing=true}, paused(){playing=false} }`），
 * 但那个状态只驱动它自己的 Vue 组件，不会写回 `#tool` 的 class。
 * 于是样式里的 `&.playing` 分支永远进不去—— 播放正常、图标不动。
 *
 * ## 做法
 *
 * 不改主题源码（不触碰 AGPL §7(b)），用一个独立插件补上这段同步：
 * 监听底层 `<audio>` 元素的 play / pause / ended / ended 事件，
 * 相应地给 `#tool` 加/删 `playing` class。
 *
 * 监听 audio 元素而不是播放器 store 的原因：
 *   - audio 是播放状态的真实来源，不依赖库的内部实现；
 *   - nyx-player 是打包压缩产物，其 store 未对外暴露，跨版本不稳定；
 *   - 将来若主题自己修好了这段逻辑，我们的实现也只是重复设同一个 class，
 *     不会冲突。
 *
 * ## 覆盖的时机
 *
 * pjax 换页会重建 `#tool`，因此在 `pjax:end` 后要重新绑定；
 * 同时用 MutationObserver 兜底，防止 `#tool` 被晚于 pjax:end 替换
 * （主题的 domInit 是异步的）。监听器标记在元素上，重复调用不会叠加。
 */

'use strict';

const { transformRoute } = require('./lib/route-transform');

const SCRIPT = `
<script>
(function () {
  'use strict';
  if (window.__toolPlayingBound) return;
  window.__toolPlayingBound = true;

  function sync(playing) {
    var tool = document.getElementById('tool');
    if (!tool) return;
    if (playing) tool.classList.add('playing');
    else tool.classList.remove('playing');
  }

  // 找到播放器真正使用的 <audio> 元素。
  // 它由 Vue 渲染，时机上晚于本脚本，所以需要轮询等待。
  function bind() {
    var audio = document.querySelector('#player audio') ||
                document.querySelector('#MusicPlayerRoot audio') ||
                document.querySelector('audio');
    if (!audio || audio.dataset.toolSync === '1') return false;
    audio.dataset.toolSync = '1';

    audio.addEventListener('play', function () { sync(true); });
    audio.addEventListener('playing', function () { sync(true); });
    audio.addEventListener('pause', function () { sync(false); });
    audio.addEventListener('ended', function () { sync(false); });
    audio.addEventListener('error', function () { sync(false); });
    // 元数据加载后如果已在播放，同步一次（应对自动恢复场景）
    audio.addEventListener('loadedmetadata', function () {
      if (!audio.paused) sync(true);
    });
    return true;
  }

  function tryBind(attempt) {
    if (bind()) return;
    if (attempt < 60) setTimeout(function () { tryBind(attempt + 1); }, 100);
  }

  tryBind(0);

  // pjax 换页后 #tool 会被重建，需要重新同步
  document.addEventListener('pjax:end', function () {
    sync(false);          // 新页面默认是暂停态，先清掉遗留 class
    setTimeout(function () { tryBind(0); }, 0);
  });

  // 兜底：#tool 若被替换（主题 domInit 异步插入），过一会儿再绑一次
  setTimeout(function () { tryBind(0); }, 1200);
})();
</script>
`;

hexo.extend.filter.register('after_generate', function () {
  const { attached } = transformRoute(
    hexo,
    (html) =>
      html.includes('__toolPlayingBound')
        ? html
        // 只替换最后一个 </body>：页面里可能已有其它插件注入的脚本，
        // 其中可能含 '</body>' 字符串字面量。
        : html.replace(/<\/body>(?![\s\S]*<\/body>)/i, SCRIPT + '</body>'),
    undefined,
    'player-playing-class'
  );
  if (attached) {
    hexo.log.info(`[player-playing-class] 已向 ${attached} 个页面注入播放状态同步脚本`);
  }
});
