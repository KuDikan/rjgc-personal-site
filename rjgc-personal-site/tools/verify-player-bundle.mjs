/**
 * verify-player-bundle.mjs — 断言播放器数据真的进了产物 JS
 *
 * ## 为什么单独一个脚本
 *
 * 只检查 `_config.shokax.yml` 里有没有 `audio` 是**不够**的：
 * 数据可能停在配置文件里没被打进 bundle，运行时 `CONFIG.audio` 仍是 undefined，
 * 前端会抛 `TypeError: Cannot read properties of undefined (reading 'forEach')`
 * 然后静默失效——按钮渲染出来了，点了没反应。
 *
 * 这个脚本直接从 `public/js/*.js` 里把配置数组抠出来并求值，
 * 确认「配置 → bundle → 运行时」这条链路的最后一环是通的。
 * CI 与本地 `npm run verify:player` 共用同一份实现，避免两处逻辑漂移。
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

let count = 0;
let first = '';
let noSrc = 0;

for (const f of readdirSync(jsDir)) {
  if (!f.endsWith('.js')) continue;
  const src = readFileSync(join(jsDir, f), 'utf8');
  const literal = extractAudio(src);
  if (!literal) continue;

  let list;
  try {
    // 压缩产物是 JS 字面量而非合法 JSON，用 Function 求值
    list = new Function(`return ${literal}`)();
  } catch {
    continue; // 不是配置数组（可能是别的 audio 键）
  }
  if (!Array.isArray(list) || !list.length) continue;

  count = list.length;
  first = String(list[0]?.title ?? '');
  noSrc = list.filter((t) => !t.list || !t.list[0]).length;
  break;
}

if (!count) {
  console.error('✗ 产物 JS 中没有 audio 配置 —— 播放器运行时会抛 TypeError 并静默失效。');
  console.error('  检查 _config.shokax.yml 顶层 audio 是否已生成（npm run music）且构建时被打包。');
  process.exit(1);
}

if (!first) {
  console.error('✗ audio 条目缺少 title');
  process.exit(1);
}

if (noSrc === count) {
  console.error(`✗ ${count} 条 audio 全部缺少 list[0] —— 播放器有列表但放不出声。`);
  process.exit(1);
}

if (noSrc) {
  console.warn(`  ! 有 ${noSrc} 条缺少 list[0]，这些曲目无法播放`);
}

console.log(`  [ok] 播放器数据已进产物：${count} 首，首曲「${first}」`);
