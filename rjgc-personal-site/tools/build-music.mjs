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

  syncThemeAudio(tracks);
}

/**
 * 把播放列表写进 **站点主题配置** `_config.shokax.yml` 的 `audio` 字段。
 *
 * ## 为什么是 theme.audio 而不是页面 front-matter
 *
 * 播放器最终读的是 `CONFIG.audio`，而 `CONFIG = shokax_CONFIG`，
 * 由 theme/scripts/generaters/script.js 生成的 siteInit 内联数据提供：
 *
 *     const siteConfig = { audio: void 0, ... }
 *     if (theme?.audio) siteConfig.audio = theme.audio
 *     define: { shokax_CONFIG: JSON.stringify(siteConfig) }
 *
 * 也就是说 `audio` 取自 **`_config.shokax.yml` 的顶层 audio**（站点级），
 * 对所有页面生效；页面 front-matter 的 `page.audio` 只会进
 * `LOCAL.audio`（另一个变量），**播放器根本不读它**。
 *
 * 这点踩过两次坑：
 *   1. 第一次只写正文 {% media %} 标签→ CONFIG.audio undefined；
 *   2. 改成写 front-matter 的 audio → 仍然 undefined，
 *      报TypeError: Cannot read properties of undefined (reading 'forEach')。
 * 页面级根本不是正确位置，只有 theme.audio 是。
 *
 * 格式（theme/_config.yml 的默认注释即此形状）：
 *     audio:
 *       - title: 列表名
 *         list:
 *           - https://.../audio.mp3
 * initAudioPlayer 取 item.list[0] 作为音频地址，故每组放一首即可。
 */
function syncThemeAudio(tracks) {
  const themeYml = join(root, '_config.shokax.yml');
  if (!existsSync(themeYml)) {
    warn(`未找到 ${themeYml}，跳过 theme.audio 写入`);
    return;
  }

  const list = tracks.slice(0, PLAYLIST_LIMIT).map((t) => ({
    title: t.name,
    list: [t.url],
  }));

  let text = readFileSync(themeYml, 'utf8');

  // 整块替换已有的顶层 audio:（可能不存在），保持其余内容原样。
  // 不用 js-yaml dump 整个文件——那会重排键顺序并丢掉所有注释。
  const block =
    'audio:\n' + list.map((t) => `  - title: ${JSON.stringify(t.title)}\n    list:\n      - ${JSON.stringify(t.list[0])}`).join('\n');

  /**
   * 替换整个 audio 块，而不是只替换 `audio:` 那一行。
   *
   * 踩过的坑：先前只 replace(/^audio:\s*$/m, block)，
   * 结果旧的 30 条列表仍留在文件里、新的 30 条又追加在后面 → 变成 60 条，
   * 每次 npm run music 还会继续翻倍。必须连同后续所有
   * 以 `  - ` 开头的列表项一起删掉。
   */
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^audio:\s*$/.test(l));
  if (start >= 0) {
    let end = start + 1;
    // 列表项形如 `  - title: ...` / `    list:` / `      - <url>`
    while (end < lines.length && /^(\s+-\s|\s{4}\S)/.test(lines[end])) end++;
    lines.splice(start, end - start, ...block.split('\n'));
  } else {
    // 没有 audio 段：插到 modules: 之前
    const at = lines.findIndex((l) => /^modules:/.test(l));
    lines.splice(at < 0 ? 0 : at, 0, ...block.split('\n'), '');
  }
  text = lines.join('\n');

  writeFileSync(themeYml, text, 'utf8');
  log(`已写入 _config.shokax.yml 的 theme.audio（${list.length} 首，站点级生效）`);
}

await main();

