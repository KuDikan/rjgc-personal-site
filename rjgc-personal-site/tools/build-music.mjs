/**
 * build-music.mjs — 构建期抓取网易云歌单，生成 source/_data/music.json
 *
 * ## 为什么是"只取元数据、不取音频"
 *
 * 网易云的音频 CDN（m*.music.126.net）对所有请求返回 **403**，
 * /api/song/media 接口也不再返回可播放的 url（实测确认）。
 * 也就是说：歌单信息可以公开拿到，但音频流拿不到。
 *
 * 所以本脚本只负责取歌单元数据（歌单名、单曲名、歌手、专辑、时长、封面），
 * 音频文件由使用者自行放入 source/audio/，两者按顺序对应。
 * 这样播放器完全可用，且不依赖任何境外音频服务。
 *
 * ## 接口说明
 *
 *   GET https://music.163.com/api/playlist/detail?id=<歌单ID>
 *
 * 这是网易云的旧版公开接口，返回结构是 { result: { name, tracks: [...] } }
 * （注意不是新版接口的 { playlist: ... }）。tracks 里每项含：
 *   id / name / duration(ms) / artists[] / album.name / album.picUrl
 *
 * 该接口无需登录与签名，但为稳妥起见仍带 User-Agent 并设置超时。
 *
 * ## 产物
 *
 * source/_data/music.json：
 *   { playlist: { id, name, cover }, tracks: [{ id, title, artist, album, duration, src }] }
 *
 * 其中 src 指向 source/audio/<文件名>，若该文件不存在则 src 为 null，
 * 前端会跳过没有音频的曲目。这样"歌单 200 首、本地只有 3 个文件"也能正常工作。
 *
 * ## 可复现性
 *
 * 与 build-data.mjs 同样的约定：**不使用 new Date()**，不写抓取时间戳，
 * 同一歌单在内容不变时产出相同字节，不产生无意义git diff。
 * 歌单会随时间变化，这是网易云侧的客观变化，与"时间戳漂移"不同。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(root, 'source', '_data');
const AUDIO_DIR = join(root, 'source', 'audio');
const OUT_FILE = join(DATA_DIR, 'music.json');

const PLAYLIST_ID = process.env.NETEASE_PLAYLIST_ID || '3778678'; // 热歌榜
const MAX_TRACKS = Number(process.env.NETEASE_MAX_TRACKS || 200);
const TIMEOUT_MS = 20_000;

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.wav', '.flac']);

function log(m) { console.log(`  ${m}`); }

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  }
  return v;
}

/** 扫描本地音频，按文件名自然排序（cover-1 < cover-2 < cover-10） */
function scanLocalAudio() {
  if (!existsSync(AUDIO_DIR)) return [];
  const files = readdirSync(AUDIO_DIR)
    .filter((f) => AUDIO_EXTS.has(f.slice(f.lastIndexOf('.')).toLowerCase()))
    .sort((a, b) =>
      a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })
    );
  // 文件名去掉扩展名后与歌单曲名做匹配，匹配不上的按顺序兜底
  return files.map((f) => ({
    file: f,
    base: f.replace(/\.[^.]+$/, '').trim(),
  }));
}

/** 规范化字符串，用于宽松匹配（忽略大小写/空白/标点） */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-_()（）【】\[\]、,，.。!！?？'"'""]/g, '');
}

async function fetchPlaylist(id) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = `https://music.163.com/api/playlist/detail?id=${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: 'https://music.163.com/',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    // 旧接口返回 {result:{...}}；为兼容新版也接受 {playlist:{...}}
    const pl = json.result || json.playlist;
    if (!pl || !Array.isArray(pl.tracks)) {
      throw new Error('返回结构异常：未找到 tracks 数组');
    }
    return pl;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  let pl;
  try {
    pl = await fetchPlaylist(PLAYLIST_ID);
    log(`歌单「${pl.name}」抓取成功，共 ${pl.tracks.length} 首`);
  } catch (err) {
    // fail-soft：保留上一次数据，不让构建因外部接口失败而中断
    warn(`歌单抓取失败（${err.message}）`);
    if (existsSync(OUT_FILE)) {
      log('保留 source/_data/music.json 的上一次内容');
      return;
    }
    writeFileSync(
      OUT_FILE,
      JSON.stringify(
        sortDeep({
          playlist: { id: PLAYLIST_ID, name: '（未获取）', cover: null },
          notes: '首次抓取失败，暂无数据。可执行 node tools/build-music.mjs 重试。',
          tracks: [],
        }),
        null,
        2
      ) + '\n',
      'utf8'
    );
    return;
  }

  const local = scanLocalAudio();
  const byBase = new Map(local.map((f) => [norm(f.base), f.file]));
  const used = new Set();

  const tracks = pl.tracks.slice(0, MAX_TRACKS).map((t, i) => {
    const title = String(t.name || '').trim();
    const artist = (t.artists || []).map((a) => a.name).filter(Boolean).join(' / ');

    // 优先按"歌名-歌手"匹配本地文件，其次按序号兜底
    let file =
      byBase.get(norm(`${title}-${artist}`)) ||
      byBase.get(norm(title)) ||
      null;

    if (!file && local[i] && !used.has(local[i].file)) {
      file = local[i].file; // 顺序兜底
    }
    if (file) used.add(file);

    return {
      album: t.album?.name || '',
      artist,
      cover: t.album?.picUrl || null,
      duration: Math.round((t.duration || 0) / 1000), // 秒
      id: String(t.id),
      index: i + 1,
      // 无对应本地音频时 src 为 null，前端会禁用该曲
      src: file ? `/audio/${file}` : null,
      title,
    };
  });

  const playable = tracks.filter((t) => t.src).length;
  const payload = {
    notes:
      '歌单元数据来自网易云公开接口 https://music.163.com/api/playlist/detail。' +
      '音频文件由使用者放在 source/audio/，src 为 null 表示尚无本地音频。' +
      '（网易云音频 CDN 已返回 403，无法直接取流，故不依赖其播放地址。）',
    playlist: {
      cover: pl.picUrl || null,
      id: PLAYLIST_ID,
      name: pl.name || '',
    },
    tracks,
  };

  writeFileSync(OUT_FILE, JSON.stringify(sortDeep(payload), null, 2) + '\n', 'utf8');
  log(`music.json  ${tracks.length} 首，其中 ${playable} 首有本地音频`);

  if (playable === 0) {
    log(`提示：把音频文件（${[...AUDIO_EXTS].join('/')}）放进 ${AUDIO_DIR} 即可播放`);
  }
}

function warn(m) { console.warn(`  ! ${m}`); }

await main();
