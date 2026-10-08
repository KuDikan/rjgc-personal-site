/**
 * verify-player-bundle.mjs — 断言播放器数据真的进了产物 JS，且地址形态正确
 *
 * ## 为什么单独一个脚本
 *
 * 只检查 `_config.shokax.yml` 里有没有 `audio` 是**不够**的：
 * 数据可能停在配置文件里没被打进 bundle，运行时 `CONFIG.audio` 仍是 undefined，
 * 前端抛 `TypeError: Cannot read properties of undefined (reading 'forEach')`
 * 然后静默失效——按钮渲染出来了，点了没反应。
 *
 * 这个脚本直接从 `public/js/*.js` 里把配置数组抠出来并求值，
 * 确认「配置 → bundle → 运行时」这条链路的最后一环是通的。
 * CI 与本地 `npm run verify:player` 共用同一实现，避免逻辑漂移。
 *
 * ## 检查三件事
 *
 * 1. 产物 JS 里有 audio 配置且非空；
 * 2. 每组都有 list[0]（initAudioPlayer 取它作为播放地址，缺了就放不出声）；
 * 3. **地址形态被播放器支持** —— nyx-player 内置的 parserURL 只认
 *    `music.163.com` / `y.qq.com` 等平台**页面链接**，
 *    填 meting 之类解析出来的音频直链会抛 `Unsupported URL`，播放器整个挂掉。
 *
 * ## 两个解析细节（都踩过）
 *
 * 1. 音频地址里含 `]`（如 `?id=287398`），不能用惰性匹配找数组结尾，
 *    必须做括号计数。
 * 2. 压缩后是 JS 对象字面量（`{title:"..."}`，键无引号），
 *    **不是合法 JSON**，JSON.parse 会失败，要用 Function 求值。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = join(root, 'public', 'js');

if (!existsSync(jsDir)) {
  console.error('✗ public/js 不存在 —— 请先构建');
  process.exit(1);
}

/** 从 JS 源码里提取 audio: 后面的数组字面量 */
function extractAudio(source) {
  const i = source.indexOf('audio:');
  if (i < 0) return null;
  const from = source.indexOf('[', i);
  if (from < 0) return null;

  let depth = 0;
  let inStr = false;
  for (let k = from; k < source.length; k++) {
    const c = source[k];
    if (inStr) {
      if (c === '\\') { k++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return source.slice(from, k + 1);
    }
  }
  return null;
}

let groups = null;
for (const f of readdirSync(jsDir)) {
  if (!f.endsWith('.js')) continue;
  const src = readFileSync(join(jsDir, f), 'utf8');
  const literal = extractAudio(src);
  if (!literal) continue;
  try {
    // 压缩产物是 JS 字面量而非合法 JSON，用 Function 求值
    const list = new Function(`return ${literal}`)();
    if (Array.isArray(list) && list.length) { groups = list; break; }
  } catch { /* 不是配置数组 */ }
}

if (!groups) {
  console.error('✗ 产物 JS 中没有 audio 配置 —— 播放器运行时会抛 TypeError 并静默失效。');
  console.error('  检查 _config.shokax.yml 顶层 audio 是否已生成（npm run music）且构建时被打包。');
  process.exit(1);
}

const first = String(groups[0]?.title ?? '');
if (!first) {
  console.error('✗ audio 条目缺少 title');
  process.exit(1);
}

const noSrc = groups.filter((t) => !t.list || !t.list[0]);
if (noSrc.length === groups.length) {
  console.error(`✗ ${groups.length} 组 audio 全部缺少 list[0] —— 播放器有列表但放不出声。`);
  process.exit(1);
}
if (noSrc.length) {
  console.warn(`  ! 有 ${noSrc.length} 组缺少 list[0]，这些歌单无法播放`);
}

// nyx-player 的 parserURL 只匹配平台页面链接
const SUPPORTED = /music\.163\.com|y\.qq\.com/;
const urls = groups.map((t) => String(t.list?.[0] ?? '')).filter(Boolean);
const bad = urls.filter((u) => !SUPPORTED.test(u));

if (bad.length === urls.length) {
  console.error(`✗ ${urls.length} 条地址都不被播放器支持 —— 运行时会抛 Unsupported URL。`);
  console.error('  需要 music.163.com/#/playlist?id=... 或 y.qq.com 形式的市场链接，');
  console.error('  不能填 meting 之类解析出来的音频直链。');
  process.exit(1);
}
if (bad.length) {
  console.warn(`  ! ${bad.length} 条地址不被播放器支持，这些歌单会加载失败`);
}

console.log(`  [ok] 播放器数据已进产物：${groups.length} 组，首组「${first}」`);
console.log(`       播放源: ${urls[0]}`);
