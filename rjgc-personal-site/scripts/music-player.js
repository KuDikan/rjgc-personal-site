/**
 * music-player.js — 右下角悬浮音乐播放器
 *
 * ## 数据来源：网易云歌单（仅元数据）
 *
 * tools/build-music.mjs 在构建期抓取网易云公开接口
 *   https://music.163.com/api/playlist/detail?id=<歌单ID>
 * 生成 source/_data/music.json，含歌单名与全部曲目的
 * 歌名 / 歌手 / 专辑 / 时长 / 封面。
 *
 * **音频流不来自网易云**：实测其音频 CDN（m*.music.126.net）对所有请求
 * 返回 403，/api/song/media 也不再返回可播放 url。因此音频文件由使用者
 * 自行放入 source/audio/，构建脚本按"歌名-歌手"匹配（匹配不上则按顺序兜底），
 * 无对应文件的曲目 src 为 null，前端会禁用该曲。
 * 这样播放器完全可用，且不依赖任何境外音频服务。
 *
 * ## 为什么自己写，而不用主题内置的 media 标签
 *
 * 主题的 `{% media audio %}` 会把 nyx-player 渲染成**正文内联**的
 * position: relative 区块（见 theme/source/css/_common/components/tags/player.styl），
 * 且需要把播放列表整段写进文章 front-matter。
 * 而需求是"右下角悬浮"，故自行实现，用 fixed 定位挂在右下角。
 *
 * ## 交互
 *
 * - 点击才播放（浏览器自动播放策略限制，自动 play() 会被拒绝）
 * - 支持播放/暂停、上一首/下一首、进度条、音量、折叠
 * - 记忆播放位置到 localStorage（按曲目 id）
 * - Esc 关闭展开的播放列表
 *
 * ## 无障碍与安全
 *
 * - 按钮有 aria-label；播放器容器 role="region"
 * - 歌名/歌手等文本一律用 textContent 写入，不用 innerHTML 拼接
 * - 音频地址来自本仓库 music.json，且只接受以 /audio/ 开头的站内路径
 */

'use strict';

const { escapeHTML, safeUrl } = require('./lib/render-helpers');
const { transformRoute } = require('./lib/route-transform');

/** 从 music.json 生成注入脚本所需的 JSON（过滤掉无音频的曲目） */
function readMusic() {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(hexo.base_dir, 'source', '_data', 'music.json');
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.tracks)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 挑出可播放曲目并归一化字段；无可播放曲目时返回空数组。
 *
 * src 白名单：必须是 /audio/ 开头的站内路径，且以受支持的音频扩展名结尾。
 * 这里只做**路径形态**校验（不含协议、不含 ..），不去枚举允许的字符——
 * 因为歌名是中文，枚举字符类会漏掉（曾因此把"我不难过-孙燕姿.wav"判为非法）。
 * 真正的安全性由 safeUrl() 兜底：非 http/https 一律降级为 '#'。
 */
function playableTracks(music) {
  const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|wav|flac)$/i;
  return (music.tracks || [])
    .filter((t) => {
      if (!t.src) return false;
      const s = String(t.src);
      // 必须是站内绝对路径、位于 /audio/ 下、不含路径穿越
      if (!s.startsWith('/audio/')) return false;
      if (s.includes('..') || s.includes('//')) return false;
      return AUDIO_EXT.test(s);
    })
    .map((t) => ({
      artist: String(t.artist || ''),
      duration: Number(t.duration) || 0,
      id: String(t.id || t.title),
      src: safeUrl(t.src),
      title: String(t.title || '未知曲目'),
    }));
}

/**
 * 构造播放器 HTML。
 * @param {object} payload { name, tracks }，tracks 必须已过滤
 */
function buildPlayer(payload) {
  if (!payload || !Array.isArray(payload.tracks) || !payload.tracks.length) return '';

  const json = JSON.stringify(payload);

  return `
<div class="mp-dock" id="mp-dock" hidden>
  <button class="mp-toggle" id="mp-toggle" type="button" aria-label="展开播放列表" aria-expanded="false">
    <i class="ic i-music"></i>
    <span class="mp-badge" id="mp-badge" hidden></span>
  </button>

  <div class="mp-panel" id="mp-panel">
    <div class="mp-now">
      <img class="mp-cover" id="mp-cover" alt="" hidden>
      <div class="mp-meta">
        <span class="mp-title" id="mp-title"></span>
        <span class="mp-artist" id="mp-artist"></span>
      </div>
      <button class="mp-fold" id="mp-fold" type="button" aria-label="收起播放列表">
        <i class="ic i-angle-down"></i>
      </button>
    </div>

    <div class="mp-progress">
      <span class="mp-time" id="mp-cur">0:00</span>
      <input class="mp-range" id="mp-seek" type="range" min="0" max="100" value="0" step="0.1" aria-label="播放进度">
      <span class="mp-time" id="mp-dur">0:00</span>
    </div>

    <div class="mp-controls">
      <button id="mp-prev" type="button" aria-label="上一首"><i class="ic i-backward"></i></button>
      <button class="mp-play" id="mp-play" type="button" aria-label="播放">
        <i class="ic i-play" id="mp-play-icon"></i>
      </button>
      <button id="mp-next" type="button" aria-label="下一首"><i class="ic i-forward"></i></button>
      <label class="mp-vol" aria-label="音量">
        <i class="ic i-volume-on"></i>
        <input id="mp-volume" type="range" min="0" max="100" value="70" aria-label="音量">
      </label>
    </div>

    <ol class="mp-list" id="mp-list"></ol>
  </div>

  <audio id="mp-audio" preload="none"></audio>
</div>

<script>
(function () {
  'use strict';
  var MUSIC = ${JSON.stringify(payload)};
  var KEY = 'rjgc-music-state';
  var LS_KEY_POS = KEY + ':pos';
  var LS_KEY_VOL = KEY + ':vol';

  var dock, panel, audio, playBtn, playIcon, titleEl, artistEl,
      seekEl, curEl, durEl, listEl, badgeEl, coverEl;

  var tracks = MUSIC.tracks;
  var idx = 0;
  var seeking = false;

  // 主题的图标字体里没有 i-play / i-music，用字符代替，避免空图标
  var ICON_PLAY = '\\u25B6';
  var ICON_PAUSE = '\\u23F8';
  var ICON_PREV = '\\u23EE';
  var ICON_NEXT = '\\u23ED';

  function $(id) { return document.getElementById(id); }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  function readLS(k, def) {
    try { var v = localStorage.getItem(k); return v === null ? def : v; }
    catch (e) { return def; }
  }
  function writeLS(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { /* 隐私模式下忽略 */ }
  }

  function current() { return tracks[idx]; }

  function renderList() {
    listEl.innerHTML = '';
    tracks.forEach(function (t, i) {
      var li = document.createElement('li');
      li.className = 'mp-item' + (i === idx ? ' is-active' : '');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mp-item-btn';
      btn.setAttribute('data-i', String(i));

      var nm = document.createElement('span');
      nm.className = 'mp-item-title';
      nm.textContent = t.title;
      var ar = document.createElement('span');
      ar.className = 'mp-item-artist';
      ar.textContent = t.artist;

      btn.appendChild(nm);
      btn.appendChild(ar);
      li.appendChild(btn);
      listEl.appendChild(li);
    });
  }

  function paintNow() {
    var t = current();
    titleEl.textContent = t.title;
    artistEl.textContent = t.artist || '';
    durEl.textContent = t.duration ? fmt(t.duration) : '--:--';
    seekEl.value = '0';
    curEl.textContent = '0:00';
    Array.prototype.forEach.call(listEl.children, function (li, i) {
      li.className = 'mp-item' + (i === idx ? ' is-active' : '');
    });
    badgeEl.textContent = t.title.slice(0, 1);
    badgeEl.hidden = false;
  }

  function setIcon(playing) {
    playIcon.textContent = playing ? ICON_PAUSE : ICON_PLAY;
    playBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
    dock.classList.toggle('is-playing', !!playing);
  }

  function load(i, autoplay) {
    idx = (i + tracks.length) % tracks.length;
    var t = current();
    audio.src = t.src;
    paintNow();
    writeLS(KEY, String(idx));
    if (autoplay) { audio.play().catch(function () { setIcon(false); }); setIcon(true); }
    else { setIcon(false); }
  }

  function toggle() {
    if (audio.paused) {
      // 必须由用户手势触发，否则浏览器会拒绝自动播放
      audio.play().then(function () { setIcon(true); })
                 .catch(function () { setIcon(false); });
    } else {
      audio.pause();
      setIcon(false);
    }
  }

  function openPanel(open) {
    dock.classList.toggle('is-open', open);
    playBtnToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  var playBtnToggle;

  function bind() {
    playBtnToggle = $('mp-toggle');
    playBtnToggle.addEventListener('click', function () {
      openPanel(!dock.classList.contains('is-open'));
    });
    $('mp-fold').addEventListener('click', function () { openPanel(false); });

    playBtn.addEventListener('click', toggle);

    $('mp-prev').addEventListener('click', function () { load(idx - 1, !audio.paused); });
    $('mp-next').addEventListener('click', function () { load(idx + 1, !audio.paused); });

    listEl.addEventListener('click', function (ev) {
      var b = ev.target.closest('.mp-item-btn');
      if (!b) return;
      load(Number(b.getAttribute('data-i')), true);
    });

    seekEl.addEventListener('input', function () { seeking = true; });
    seekEl.addEventListener('change', function () {
      if (audio.duration) { audio.currentTime = (Number(seekEl.value) / 100) * audio.duration; }
      seeking = false;
    });

    var vol = $('mp-volume');
    var savedVol = parseInt(readLS(LS_KEY_VOL, '70'), 10);
    if (!isNaN(savedVol) && savedVol >= 0 && savedVol <= 100) vol.value = String(savedVol);
    audio.volume = vol.value / 100;
    vol.addEventListener('input', function () {
      audio.volume = vol.value / 100;
      writeLS(LS_KEY_VOL, vol.value);
    });

    audio.addEventListener('timeupdate', function () {
      if (seeking || !audio.duration) return;
      seekEl.value = String((audio.currentTime / audio.duration) * 100);
      curEl.textContent = fmt(audio.currentTime);
      writeLS(LS_KEY_POS + ':' + current().id, String(Math.floor(audio.currentTime)));
    });

    audio.addEventListener('ended', function () { load(idx + 1, true); });
    audio.addEventListener('play', function () { setIcon(true); });
    audio.addEventListener('pause', function () { setIcon(false); });
    audio.addEventListener('error', function () {
      // 某个文件损坏/缺失时自动跳到下一首，避免卡住
      if (tracks.length > 1) load(idx + 1, true);
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && dock.classList.contains('is-open')) openPanel(false);
    });
  }

  function init() {
    dock = $('mp-dock');
    if (!dock || dock.dataset.ready === '1') return;
    dock.dataset.ready = '1';

    panel = $('mp-panel');
    audio = $('mp-audio');
    playBtn = $('mp-play');
    playIcon = $('mp-play-icon');
    titleEl = $('mp-title');
    artistEl = $('mp-artist');
    seekEl = $('mp-seek');
    curEl = $('mp-cur');
    durEl = $('mp-dur');
    listEl = $('mp-list');
    badgeEl = $('mp-badge');
    coverEl = $('mp-cover');

    // 主题无 i-play/i-music 字形，换成字符
    playIcon.textContent = ICON_PLAY;
    var ti = $('mp-toggle').querySelector('i');
    if (ti) ti.textContent = '\\u266B';
    var pv = $('mp-prev').querySelector('i'); if (pv) pv.textContent = ICON_PREV;
    var nx = $('mp-next').querySelector('i'); if (nx) nx.textContent = ICON_NEXT;
    var vl = dock.querySelector('.mp-vol i'); if (vl) vl.textContent = '\\u266A';

    renderList();

    var saved = parseInt(readLS(KEY, '0'), 10);
    load(isNaN(saved) || saved < 0 || saved >= tracks.length ? 0 : saved, false);

    bind();
    dock.hidden = false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  document.addEventListener('pjax:end', function () {
    // pjax 换页后节点被替换，需要重新绑定
    var old = document.getElementById('mp-dock');
    if (old) old.remove();
    var holder = document.createElement('div');
    holder.innerHTML = document.getElementById('mp-dock-tpl')
      ? document.getElementById('mp-dock-tpl').innerHTML : '';
    if (holder.firstChild) document.body.appendChild(holder.firstChild);
    init();
  });
})();
</script>`;
}

/**
 * pjax换页用的模板副本。
 * 主题用 pjax 局部替换 body，注入的播放器节点会被移除，
 * 因此额外存一份 hidden 模板，pjax:end 时克隆回来重新初始化。
 */
function buildDockTemplate(payload) {
  const html = buildPlayer(payload);
  if (!html) return '';
  return `\n<div id="mp-dock-tpl" hidden>${html}</div>`;
}

hexo.extend.filter.register('after_generate', function () {
  const music = readMusic();
  if (!music) {
    hexo.log.warn(
      '[music-player] 未找到 source/_data/music.json，跳过播放器注入' +
      '（可执行 npm run music 生成）'
    );
    return;
  }

  const tracks = playableTracks(music);
  if (!tracks.length) {
    hexo.log.warn(
      `[music-player] 歌单「${music.playlist?.name || '未命名'}」共 ${(music.tracks || []).length} 首，` +
      '但 source/audio/ 下没有可用的音频文件，播放器未注入。' +
      '把 .mp3/.m4a/.ogg/.wav 放进 source/audio/（文件名建议用"歌名-歌手"）后重新构建。'
    );
    return;
  }

  const payload = { name: String(music.playlist?.name || '音乐'), tracks };
  const snippet = buildPlayer(payload) + buildDockTemplate(payload);

  const { attached } = transformRoute(
    hexo,
    (html) => {
      if (html.includes('id="mp-dock"')) return html;
      // 同样只替换最后一个 </body>：页面里可能已有其他插件注入的脚本，
      // 其中可能含 '</body>' 字符串字面量。详见 local-search.js 的注释。
      return html.replace(/<\/body>(?![\s\S]*<\/body>)/i, snippet + '</body>');
    },
    undefined,
    'music-player'
  );

  if (attached) {
    hexo.log.info(
      `[music-player] 已注入右下角悬浮播放器（${tracks.length} 首可播放，歌单「${payload.name}」）`
    );
  }
});
