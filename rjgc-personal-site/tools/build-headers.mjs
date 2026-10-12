/**
 * build-headers.mjs — 生成 Cloudflare Workers Static Assets 的 _headers
 *
 * ## 为什么需要这个脚本
 *
 * 站点跑在 Cloudflare Workers Static Assets 上，默认给所有资源发
 * `Cache-Control: public, max-age=0, must-revalidate`，
 * 于是每次加载每个资源都要跟边缘节点确认一次"没过期吧"（表现就是 304）。
 *
 * `_headers` 文件可以改写响应头（实测确认有效，见下方"实测记录"），
 * 但它有两条硬约束，决定了本脚本的形态：
 *
 *   1. **规则是叠加的，不是覆盖的。**
 *      多条规则命中同一文件时，同名头会逗号拼接：
 *        /js/chunk-*.js → 1 年   与   /js/* → 1 小时   同时命中
 *        → "public, max-age=31536000, immutable, public, max-age=3600, ..."
 *      浏览器对重复指令的取第一个还是最后一个并无保证，不可靠。
 *      **所以规则必须互斥。**
 *
 *   2. **通配符只支持一个 `*`，且不能做复杂匹配。**
 *      合法：`/assets/*`、`/js/chunk-*.js`
 *      无效：`/js/*-*.js`、`/js/*-????????.js`
 *      （`?` 不支持；一条规则里两个 `*` 会被判无效）
 *
 *      因此无法用一条规则表达"带内容哈希的那些文件"——
 *      哈希文件的命名是 `post-2X2GNGWO.js` 这种，无法用通配符和
 *      `siteInit.js` 区分开。只能**逐个文件列精确路径**。
 *
 *      而哈希文件名每次构建都会变（内容变 → 哈希变），手写维护不了，
 *      所以由本脚本在构建时扫描产物、自动生成。
 *
 * ## 实测记录（wrangler dev，本地验证过）
 *
 *   wrangler 启动时打印 `✨ Parsed N valid header rules`，
 *   `curl -sI` 能看到响应头被改写。注意：
 *   - 之前"Cache Rules 里配 Browser Cache TTL"的方案**无效**，
 *     响应头仍是 max-age=0（Cloudflare 不改 Workers Assets 的头）。
 *   - `_headers` 是 wrangler 原生支持的（wrangler-dist/cli.js 里有
 *     HEADERS_FILENAME = "_headers" 与上传逻辑），不需要 Worker 脚本。
 *
 * ## 与其它构建步骤的顺序
 *
 * 必须在 `hexo generate` **之后**运行：`hexo clean` 会清空 public/。
 * 也必须在 `pagefind --site public` 之后，这样 pagefind 的索引文件
 * 才能一并纳入缓存规则。
 */

import { readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// 复用 Waline 那个路径换算：HTML 的规则必须写在**浏览器请求的 URL** 上，
// 而不是文件路径。浏览器访问 /about/，而产物文件是 about/index.html。
// scripts/ 是 CommonJS（Hexo 用 require 加载），这里用 createRequire 引它。
const require = createRequire(import.meta.url);
const { toBrowserPath } = require('../scripts/lib/browser-path.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(root, 'public');
const OUT_FILE = join(PUBLIC_DIR, '_headers');
const SELF = '_headers';

/** 内容哈希命名：post-2X2GNGWO.js / comments-BML7VMCY.css / index.esm-GWFVKITM.js */
const HASHED = /-[A-Z0-9]{8}\.(js|css)$/;

/**
 * 缓存策略集中在此，调整 TTL 只改这一处。
 *
 * - html     普通页面。给 12hs 缓存，must-revalidate 保证过期后必校验。
 * - hashed   内容哈希命名的 js/css。文件名变=内容变，可放心长缓存。
 * - script   无版本号的 js/css（siteInit.js、app.css、page.css 等）。
 *            主题一升级内容就变、URL 不变，不能长缓存。
 * - asset    图片等静态素材，非哈希命名，30 天。
 * - pagefind 搜索索引，每次构建都变，24 小时。
 * - feed     RSS/Atom，供阅读器抓取，1 小时。
 * - text     .LEGAL.txt 等许可证文本，内容不变，30 天。
 * - fallback 未识别的类型，保守起见短缓存。
 */
const TTL = {
  asset: 'public, max-age=2592000',
  fallback: 'public, max-age=3600, must-revalidate',
  feed: 'public, max-age=3600',
  hashed: 'public, max-age=31536000, immutable',
  html: 'public, max-age=43200, must-revalidate',
  pagefind: 'public, max-age=86400, must-revalidate',
  script: 'public, max-age=86400, must-revalidate',
  text: 'public, max-age=2592000',
};

/** 递归收集 public/ 下所有文件（相对路径，统一用 / 分隔） */
function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, out);
    } else if (entry.isFile()) {
      out.push(relative(base, full).split('\\').join('/'));
    }
  }
  return out;
}

/** 判断文件属于哪一类 */
function categorize(relPath) {
  const name = relPath.split('/').pop();

  if (name === SELF) return null;                 // _headers 自身不参与
  if (relPath.startsWith('pagefind/')) return 'pagefind';

  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';

  if (ext === 'html') return 'html';
  if (ext === 'js' || ext === 'css') return HASHED.test(name) ? 'hashed' : 'script';
  if (ext === 'xml' || ext === 'json') return 'feed';
  if (ext === 'txt') return 'text';
  if (relPath.startsWith('assets/')) return 'asset';

  return 'fallback';
}

/**
 * 文件在产物里的相对路径 → 规则要匹配的 URL。
 *
 * 关键：**HTML 必须转换，其余不用。**
 *
 * 浏览器访问的是 `/about/`，而产物文件是 `about/index.html`。
 * 缓存规则写在文件路径上的话，请求 `/about/` 根本匹配不到，
 * 页面照样每次 304。wrangler 的 html_handling=auto-trailing-slash
 * 负责把 `/about/` 映射到 `about/index.html`，但那是服务端的事，
 * 缓存规则看到的是请求 URL。
 *
 *   about/index.html      → /about/
 *   index.html            → /
 *   404.html              → /404.html
 *   js/post-xxx.js        → /js/post-xxx.js   （非 HTML，原样）
 */
function toRuleUrl(relPath, category) {
  if (category === 'html') return toBrowserPath(relPath);
  return '/' + relPath;
}

/**
 * 生成规则。能合并成通配符的合并，减少规则条数
 * （Cloudflare 对 _headers 的规则数有上限）。
 *
 * 合并原则：只合并**同一目录下、同一类别**的文件，绝不跨类别——
 * 跨类别合并会让规则重叠，触发"叠加"问题。
 */
function buildRules(files) {
  /** @type {Map<string, string[]>} category -> URL 列表 */
  const byCat = new Map();

  for (const f of files) {
    const cat = categorize(f);
    if (!cat) continue;
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(toRuleUrl(f, cat));
  }

  const rules = [];

  for (const [cat, list] of byCat) {
    const value = TTL[cat];
    const sorted = [...new Set(list)].sort();

    // assets/ 是扁平目录，可用一条 /assets/* 覆盖
    if (cat === 'asset' && sorted.every((u) => u.startsWith('/assets/'))) {
      rules.push({ pattern: '/assets/*', value });
      continue;
    }
    // pagefind/ 含子目录（fragment/、index/）。实测确认 _headers 的 *
    // **可以跨 / 匹配**，所以一条 /pagefind/* 即可覆盖嵌套路径，
    // 不需要（也不能）再加 /pagefind/*/*——那会让同一文件命中两条规则。
    if (cat === 'pagefind') {
      rules.push({ pattern: '/pagefind/*', value });
      continue;
    }
    // 其余逐个列精确路径，保证互斥
    for (const url of sorted) rules.push({ pattern: url, value });
  }

  return rules;
}

/**
 * 校验：每个文件必须被**恰好一条**规则覆盖。
 *
 * 这是本脚本的核心保证——规则一旦重叠，就会出现前面说的
 * "同名头逗号拼接"，浏览器行为不可控。
 *
 * 注意比对时要用**规则 URL**（HTML 已转换为浏览器路径），
 * 而不是文件路径，否则会误报"无规则覆盖"。
 */
function verifyCoverage(files, rules) {
  const problems = [];

  /**
   * 判断 URL 是否匹配某规则。
   *
   * 复现 _headers 的通配符语义（已用 wrangler dev 实测确认）：
   * `*` **可以跨 `/` 匹配**，即 `/pagefind/*` 能命中
   * `/pagefind/fragment/xxx.pf_fragment`。所以按"前缀 + 任意后缀"处理。
   * 一条规则里只能有一个 `*`（两个会被判无效）。
   */
  const matches = (pattern, url) => {
    if (pattern === url) return true;
    if (!pattern.includes('*')) return false;
    const prefix = pattern.slice(0, pattern.indexOf('*'));
    return url.startsWith(prefix);
  };

  for (const f of files) {
    if (f === SELF) continue;
    const cat = categorize(f);
    if (!cat) continue;
    const url = toRuleUrl(f, cat);
    const hits = rules.filter((r) => matches(r.pattern, url));
    if (hits.length === 0) problems.push(`无规则覆盖：${f}（URL ${url}）`);
    else if (hits.length > 1) {
      problems.push(`被 ${hits.length} 条规则覆盖：${f}（URL ${url}）→ ${hits.map((h) => h.pattern).join(' + ')}`);
    }
  }

  return problems;
}

function main() {
  if (!existsSync(PUBLIC_DIR)) {
    console.error('✗ public/ 不存在 —— 请先执行 hexo generate');
    process.exit(1);
  }

  const files = walk(PUBLIC_DIR);
  const rules = buildRules(files);
  const problems = verifyCoverage(files, rules);

  if (problems.length) {
    console.error(`✗ _headers 规则存在覆盖问题（${problems.length} 处）：`);
    problems.slice(0, 10).forEach((p) => console.error(`    ${p}`));
    console.error('  规则重叠会导致同名响应头被逗号拼接，浏览器行为不可控。');
    process.exit(1);
  }

  const header = [
    '# 本文件由 tools/build-headers.mjs 自动生成，请勿手改。',
    '#',
    '# 作用：给 Cloudflare Workers Static Assets 的资源设置 Cache-Control。',
    '# 背景与约束见 tools/build-headers.mjs 顶部注释。',
    '# 重新生成：npm run headers',
    '',
  ].join('\n');

  const body = rules
    .map((r) => `${r.pattern}\n  Cache-Control: ${r.value}`)
    .join('\n\n');

  writeFileSync(OUT_FILE, header + body + '\n', 'utf8');

  // 按类别统计，便于核对
  const counts = {};
  for (const r of rules) {
    const cat = Object.keys(TTL).find((k) => TTL[k] === r.value) || 'other';
    counts[cat] = (counts[cat] || 0) + 1;
  }
  const summary = Object.entries(counts).map(([k, v]) => `${k}×${v}`).join('  ');

  console.log(`  _headers  ${rules.length} 条规则，覆盖 ${files.length - 1} 个文件（${summary}）`);
}

main();
