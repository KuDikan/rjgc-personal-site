/**
 * build-music.mjs — 构建期抓取网易云歌单，生成 source/_data/music.json
 *
 * ## 为什么用 meting 而不是直接打网易云
 *
 * 网易云的音频 CDN（m*.music.126.net）对所有请求返回 **403**，
 * /api/song/media 接口也不再返回可播放 url —— 也就是说歌单元数据拿得到、
 * 音频流拿不到。这是第一次实现时"播放器没有声音"的根因。
 *
 * meting（https://github.com/MoeGaming/meting 或其自建实例）是 APlayer
 * 常用的元数据解析后端，它代理网易云并返回**可播放的音频地址**：
 *   歌单元数据：?server=netease&type=playlist&id=<歌单ID>
 *   单曲音频：  ?server=netease&type=url&id=<歌曲ID>   ← 返回 audio/mpeg
 *
 * 自建实例示例：https://meting.mikus.ink/api
 * 可用环境变量 METING_API 覆盖（换实例或改用官方源）。
 *
 * ## 曲目字段
 *
 * meting 返回的字段名与主题内置播放器（nyx-player）所需的一致：
 *   name / author / pic / url / lrc
 * 主题播放器要的是 name / url / artist，这里统一转成主题的命名，
 * 让 {% media audio %} 直接可用。
 *
 * ## 可复现性
 *
 * 与 build-data.mjs 同样约定：不用 new Date()，不写抓取时间戳。
 * 注意歌单内容本身会随网易云更新而变化，这是外部数据的客观变化，
 * 不属于"时间戳漂移"导致的假diff。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(root, 'source', '_data');
const OUT_FILE = join(DATA_DIR, 'music.json');

const METING_API = process.env.METING_API || 'https://meting.mikus.ink/api';
const PLAYLIST_ID = process.env.NETEASE_PLAYLIST_ID || '3778678'; // 热歌榜
const MAX_TRACKS = Number(process.env.NETEASE_MAX_TRACKS || 200);
// 页面里只列前若干首，避免单个页面的 HTML 过大
const PLAYLIST_LIMIT = Number(process.env.MUSIC_PAGE_LIMIT || 30);
const TIMEOUT_MS = 25_000;

const log = (m) => console.log(`  ${m}`);
const warn = (m) => console.warn(`  ! ${m}`);

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  }
  return v;
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: METING_API,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  const api = `${METING_API}?server=netease&type=playlist&id=${encodeURIComponent(PLAYLIST_ID)}`;

  let raw;
  try {
    raw = await fetchJson(api);
    if (!Array.isArray(raw) || !raw.length) {
      throw new Error('返回结构异常：期望非空数组');
    }
    log(`meting 返回 ${raw.length} 首（歌单 ${PLAYLIST_ID}）`);
  } catch (err) {
    // fail-soft：保留上一次数据，不让构建因外部服务失败而中断
    warn(`meting 抓取失败（${err.message}）`);
    if (existsSync(OUT_FILE)) {
      log('保留 source/_data/music.json 的上一次内容');
      return;
    }
    writeFileSync(
      OUT_FILE,
      JSON.stringify(
        sortDeep({
          notes: '首次抓取失败，暂无数据。可执行 node tools/build-music.mjs 重试。',
          playlist: { id: PLAYLIST_ID, name: '（未获取）' },
          tracks: [],
        }),
        null,
        2
      ) + '\n',
      'utf8'
    );
    return;
  }

  // meting 字段 -> 主题内置播放器字段（name/url/artist）
  const tracks = raw.slice(0, MAX_TRACKS).map((t, i) => ({
    album: t.album || '',
    artist: t.author || t.artist || '',
    cover: t.pic || null,
    duration: t.length ? Math.round(t.length) : 0,
    id: String(t.id || i),
    index: i + 1,
    lyric: t.lrc || null,
    name: t.name || t.title || '未知曲目',
    // 主题 nyx-player 用 url 字段
    url: t.url || '',
  }));

  // 抽样校验：第一个音频地址是否真的可播
  //（meting 偶尔会返回空 url 或已失效的地址，早发现早修）
  const probe = tracks.find((t) => t.url);
  let playable = tracks.filter((t) => t.url).length;
  if (probe) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      const res = await fetch(probe.url, {
        signal: ctrl.signal,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: METING_API, Range: 'bytes=0-1024' },
      });
      clearTimeout(timer);
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !/^audio\//i.test(type)) {
        warn(`音频探测异常：${probe.name} → HTTP ${res.status} ${type}（不影响元数据，仅提示）`);
      } else {
        log(`音频探测通过：${probe.name} → ${type}`);
      }
    } catch (err) {
      warn(`音频探测失败：${err.message}（不影响元数据）`);
    }
  }

  const payload = {
    notes:
      '音频地址与元数据来自 meting（' + METING_API + '），由它代理网易云。' +
      '网易云官方音频 CDN 直连返回 403，无法直接取流，故必须经 meting 代理。' +
      '换实例请设环境变量 METING_API。',
    playlist: {
      id: PLAYLIST_ID,
      name: '网易云歌单 ' + PLAYLIST_ID,
    },
    tracks,
  };

  writeFileSync(OUT_FILE, JSON.stringify(sortDeep(payload), null, 2) + '\n', 'utf8');
  log(`music.json  ${tracks.length} 首，其中 ${playable} 首有音频地址`);
  const shown = writeMusicPage(tracks);
  log(`已生成 source/music/index.md（页面列出 ${shown} 首）`);
}

await main();

/**
 * 生成音乐页面：把播放列表写进 {% media audio %} 标签。
 *
 * 为什么单独生成页面而不是手写：播放列表有 200 首、每首的 url 都是
 * meting 的长链接，手写进 markdown 会又长又难维护；由脚本从 music.json
 * 生成，改歌单只需重跑 `npm run music`。
 *
 * 注意 media 是 **ends 标签**：{% media audio %} ... {% endmedia %}
 * 标签体内是 YAML 数组，主题会 JSON.stringify 后塞进 src 属性，
 * 前端再解析出 name / url / artist / cover。
 */
function writeMusicPage(tracks) {
  const list = tracks.slice(0, PLAYLIST_LIMIT);

  /**
   * 播放列表必须写进 **front-matter 的 audio 字段**，而不是页面正文。
   *
   * 依据主题源码：
   *   - layout/_partials/layout.pug：`if page.audio → CONFIG.audio = JSON.stringify(page.audio)`
   *   - js/_app/player.ts 的 initAudioPlayer()：遍历 `CONFIG.audio`，
   *     取 `item.title` 与 `item.list[0]` 组装 { name, url } 传给 nyx-player
   *   - js/_app/pjax/domInit.ts：`if (__shokax_player__) await initAudioPlayer()`
   *
   * 也就是说：正文里的 `{% media %}` 标签与此**完全无关**——
   * 它只是把数据塞进一个无人读取的 <div class="player">。
   * 之前只写了 media 标签，CONFIG.audio 是 undefined，
   * 于是 initPlayer 收到空列表，工具栏按钮出现但点了没反应。
   */
  const audioYaml = list
    .map((t) => `  - title: ${JSON.stringify(t.name)}\n    list:\n      - ${JSON.stringify(t.url)}`)
    .join('\n');

  const yamlText = list.map((t) => `  - name: ${JSON.stringify(t.name)}
    artist: ${JSON.stringify(t.artist)}
    url: ${JSON.stringify(t.url)}
    cover: ${JSON.stringify(t.cover)}`).join('\n');

  const page = `---
title: 音乐
layout: page
comments: false
date: 2026-10-08
audio:
${audioYaml}
---

## 播放列表

使用主题内置播放器（nyx-player）。工具栏的播放/列表按钮即由本页
front-matter 的 \`audio\` 字段驱动——播放器读的是 \`CONFIG.audio\`，
与正文里的 media 标签无关（那个标签只是把数据放进一个无人读取的 div）。

{% media audio %}
${yamlText}
{% endmedia %}

## 说明

- 音源：网易云歌单 \`${PLAYLIST_ID}\`，经 \`${METING_API}\` 解析。
- **网易云官方音频 CDN 直连返回 403**，音频必须经 meting 代理才能播放；
  换实例请设环境变量 \`METING_API\`。
- 播放器位置遵循主题默认行为：工具栏右侧的播放按钮 + 列表按钮。
- 共 ${tracks.length} 首，本页收录前 ${list.length} 首。

## 信任边界

歌名、歌手、封面 URL 均来自第三方 meting 服务，按**不可信外部数据**处理：
仅作为文本与播放地址使用，不解析为指令或代码。
`;
  mkdirSync(join(root, 'source', 'music'), { recursive: true });
  writeFileSync(join(root, 'source', 'music', 'index.md'), page, 'utf8');
  return list.length;
}
