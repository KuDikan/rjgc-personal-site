/**
 * validate.mjs — 构建产物与数据校验
 *
 * 校验目标：
 *   1. source/_data/*.json 结构合法（必填字段、类型、URL 协议）
 *   2. public/ 下七个分区入口页均已生成
 *   3. feed 三件套存在且非空，且**没有**多余的重复 feed
 *   4. 站内链接无死链
 *   5. **ShokaX 署名链接存在**（AGPL-3.0 §7(b) 的署名义务）
 *   6. 无占位内容残留
 *
 * 退出码非 0 = CI 失败。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// scripts/ 下的插件是 CommonJS（Hexo 用 require 加载），
// 本文件是 ESM，用 createRequire 引共享的路径换算规则。
// 修复（waline-path-fix.js）与校验必须用同一套规则，否则会各说各话。
const require = createRequire(import.meta.url);
const browserPath = require('../scripts/lib/browser-path.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(root, 'source', '_data');
const PUBLIC_DIR = join(root, 'public');

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

// ---------- 1. 数据校验 ----------

function validatePapers() {
  const f = join(DATA_DIR, 'papers.json');
  if (!existsSync(f)) { warn('papers.json 不存在（执行 npm run data 生成）'); return; }
  const d = readJson(f);
  if (!d) { err('papers.json 不是合法 JSON'); return; }
  if (!Array.isArray(d.papers)) { err('papers.json 缺少 papers 数组'); return; }

  const seen = new Set();
  for (const [i, p] of d.papers.entries()) {
    for (const k of ['id', 'title', 'url', 'published']) {
      if (!p?.[k]) { err(`papers[${i}] 缺少字段 ${k}`); continue; }
    }
    if (!/^https:\/\//i.test(p.url ?? '')) err(`papers[${i}] url 非 HTTPS：${p.url}`);
    if (seen.has(p.id)) err(`papers[${i}] id 重复：${p.id}`);
    seen.add(p.id);
    if (!Array.isArray(p.authors)) err(`papers[${i}] authors 应为数组`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.published ?? '')) {
      err(`papers[${i}] published 需为 YYYY-MM-DD，实际 ${p.published}`);
    }
  }
  if (!errors.length) console.log(`  [ok] papers.json  ${d.papers.length} 条`);
}

function validateRss() {
  const f = join(DATA_DIR, 'rss-items.json');
  if (!existsSync(f)) { warn('rss-items.json 不存在（执行 npm run data 生成）'); return; }
  const d = readJson(f);
  if (!d) { err('rss-items.json 不是合法 JSON'); return; }
  if (!Array.isArray(d.items) || !Array.isArray(d.feeds)) { err('rss-items.json 结构错误：需含 items 与 feeds 数组'); return; }

  const seen = new Set();
  for (const [i, it] of d.items.entries()) {
    for (const k of ['id', 'title', 'link', 'feedId']) {
      if (!it?.[k]) err(`rss[${i}] 缺少字段 ${k}`);
    }
    if (!/^https:\/\//i.test(it?.link ?? '')) err(`rss[${i}] link 非 HTTPS：${it?.link}`);
    if (seen.has(it?.id)) err(`rss[${i}] id 重复：${it.id}`);
    seen.add(it?.id);
  }
  // 订阅源地址也必须是 HTTPS
  for (const [i, fd] of d.feeds.entries()) {
    if (!/^https:\/\//i.test(fd?.url ?? '')) err(`feed[${i}] url 非 HTTPS：${fd?.url}`);
  }
  if (!errors.length) console.log(`  [ok] rss-items.json  ${d.feeds.length} 源 / ${d.items.length} 条`);
}

function validateStatus() {
  const f = join(DATA_DIR, 'status.json');
  if (!existsSync(f)) { err('status.json 不存在（执行 npm run data 生成）'); return; }
  const d = readJson(f);
  if (!d) { err('status.json 不是合法 JSON'); return; }
  if (!d.lastBuild || d.lastBuild === 'unknown') err('status.json 的 lastBuild 未能确定');
  for (const k of ['posts', 'papers', 'wikiPages', 'sections']) {
    if (typeof d.counts?.[k] !== 'number') err(`status.json counts.${k} 应为数字`);
  }
  if (!errors.length) console.log(`  [ok] status.json   lastBuild=${d.lastBuild}`);
}

// ---------- 2. 构建产物校验 ----------

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const REQUIRED_PAGES = [
  ['index.html', '首页'],
  ['about/index.html', '关于我'],
  ['categories/index.html', '博客列表'],
  ['archives/index.html', '归档'],
  ['tags/index.html', '标签'],
  ['papers/index.html', 'Research Papers'],
  ['rss/index.html', 'RSS 订阅'],
  ['wiki/index.html', 'Wiki'],
  ['status/index.html', '状态面板'],
  ['404.html', '404 页面'],
];

function validatePages() {
  if (!existsSync(PUBLIC_DIR)) {
    err('public/ 不存在 —— 请先执行 hexo generate');
    return;
  }
  let missing = 0;
  for (const [rel, label] of REQUIRED_PAGES) {
    if (!existsSync(join(PUBLIC_DIR, rel))) { err(`缺少页面：${label} (public/${rel})`); missing++; }
  }
  if (!missing) console.log(`  [ok] 页面齐全${REQUIRED_PAGES.length} 个入口`);

  // feed 三件套
  for (const f of ['rss.xml', 'atom.xml', 'feed.json']) {
    const p = join(PUBLIC_DIR, f);
    if (!existsSync(p)) { err(`缺少订阅文件：public/${f}`); continue; }
    const body = readFileSync(p, 'utf8');
    if (body.length < 50) { err(`订阅文件过小，疑似生成失败：public/${f}`); continue; }

    // 关键：不能只查"文件存在且非空"。
    // 缺 hexo-renderer-ejs 时，Hexo 会把 .ejs 模板当作静态资源原样拷贝，
    // 产出的 rss.xml 里全是<%= config.title %> 这类未渲染的模板语句——
    // 文件存在、size 也够，但订阅器拿到后完全无法解析。
    const unrendered = body.match(/<%[-_=]?[\s\S]{0,40}?%>/);
    if (unrendered) {
      err(`public/${f} 含未渲染的模板语句（如 ${unrendered[0].replace(/\s+/g, ' ').slice(0, 30)}）` +
          '—— 该文件是 .ejs 模板被当作静态文件拷贝了。请确认已安装 hexo-renderer-ejs。');
    }
    // rss/atom 还应包含真实文章条目，而不只是模板骨架
    if ((f === 'rss.xml' && !/<item[\s>]/.test(body)) ||
        (f === 'atom.xml' && !/<entry[\s>]/.test(body))) {
      err(`public/${f} 中没有任何文章条目（可能是空博客，或模板未被渲染）`);
    }
  }
  // 防重复 feed：hexo-feed 若与其它 generator 同时启用可能多产出 feed.xml
  if (existsSync(join(PUBLIC_DIR, 'feed.xml'))) {
    warn('检测到额外的 public/feed.xml —— 可能有 generator 与主题 feed 模板重复输出，请核对 feed 配置');
  }
  console.log('  [ok] feed 文件检查完成');
}

// ---------- 3. 死链检查 ----------

function validateLinks() {
  const files = walk(PUBLIC_DIR).filter((f) => f.endsWith('.html'));
  if (!files.length) { err('public/ 下没有 HTML 文件'); return; }

  // 收集实际存在的产物（URL 形式）。
  // 必须包含**所有**静态资源类型，不能只看 HTML —— 否则 css/js/assets/feed
  // 会被误判为死链，产生大量假警报。
  // 中文目录在磁盘上是原名（如 categories/技术/），而页面里是百分号编码
  // （%E6%8A%80%E6%9C%AF），所以两种形式都要登记，否则误报。
  const known = new Set();
  for (const f of walk(PUBLIC_DIR)) {
    const rel = relative(PUBLIC_DIR, f).replace(/\\/g, '/');
    const encoded = rel.split('/').map(encodeURIComponent).join('/');
    for (const r of new Set([rel, encoded])) {
      known.add('/' + r);
      if (r.endsWith('index.html')) known.add('/' + r.replace(/index\.html$/, ''));
    }
  }
  known.add('/');

  const dead = new Map();
  for (const f of files) {
    const html = readFileSync(f, 'utf8');
    for (const m of html.matchAll(/(?:href|src)=["'](\/[^"'#?]*)/g)) {
      const url = m[1];
      if (known.has(url)) continue;
      if (known.has(url + '/')) continue;
      // 页面里可能是编码形式，磁盘上是原名，反向再比一次
      let decoded = null;
      try { decoded = decodeURIComponent(url); } catch { /* 非法编码则忽略 */ }
      if (decoded && (known.has(decoded) || known.has(decoded + '/'))) continue;
      if (!dead.has(url)) dead.set(url, relative(PUBLIC_DIR, f));
    }
  }

  // 忽略外部域名与协议相对地址（本检查只关心站内链接）
  const real = [...dead.entries()].filter(([u]) => !u.startsWith('//'));

  if (real.length) {
    for (const [url, from] of real.slice(0, 15)) err(`站内死链：${url}（引用自 ${from}）`);
    if (real.length > 15) err(`…… 另有 ${real.length - 15} 处站内死链未列出`);
  } else {
    console.log(`  [ok] 无站内死链（扫描 ${files.length} 个 HTML）`);
  }
}

// ---------- 4. AGPL 署名链接（强制） ----------

function validateAttribution() {
  const indexFile = join(PUBLIC_DIR, 'index.html');
  if (!existsSync(indexFile)) { err('public/index.html 不存在，无法校验署名链接'); return; }
  const html = readFileSync(indexFile, 'utf8');

  // ShokaX 在 footer.pug 中输出指向主题仓库的链接（AGPL-3.0 §7(b) 要求保留）
  const hasLink = /theme-shoka-x\/hexo-theme-shokax/i.test(html);
  const hasPowered = /powered-by/i.test(html);

  if (!hasLink) {
    err('AGPL 义务未履行：页面中未找到指向 hexo-theme-shokax 的署名链接。' +
        '请确认 _config.shokax.yml 中 footer.powered 为 true（不可关闭）。');
  } else if (!hasPowered) {
    warn('找到了主题仓库链接但缺少 powered-by 容器，请人工确认页脚显示正常');
  } else {
    console.log('  [ok] ShokaX 署名链接存在（AGPL §7(b)）');
  }
}

// ---------- 5b. custom.styl 的规则必须真的进了产物 ----------
//
// custom.styl 是被主题在构建期读进来编译的（不是运行时链接），
// 一旦编译失败或被跳过，里面所有自定义样式会**静默消失**——
// 页面照常渲染、HTTP 200、无任何报错。
// 这里用一组"哨兵规则"验证产物里确实有 custom.styl 的内容。
{
  const cssDir = join(PUBLIC_DIR, 'css');
  const stylFile = join(root, 'source', '_data', 'custom.styl');

  if (!existsSync(stylFile)) {
    warn('source/_data/custom.styl 不存在，站点将完全使用主题默认样式');
  } else if (!existsSync(cssDir)) {
    err('public/css 目录不存在，样式未构建');
  } else {
    // 哨兵：custom.styl 里特征性的、不会与主题默认样式混淆的片段
    const sentinels = [
      ['.wl-content .vemoji', 'Waline 表情尺寸（正文）'],
      ['.wl-emoji-popup .wl-emoji', 'Waline 表情尺寸（选择弹窗）'],
      ['#brand .logo .artboard', '首页大标题字体'],
      ['mp-breathe', '播放器呼吸动画'],
      ['.data-panel', '数据面板'],
    ];

    const cssFiles = readdirSync(cssDir).filter((f) => f.endsWith('.css'));
    const all = cssFiles.map((f) => readFileSync(join(cssDir, f), 'utf8')).join('\n');
    const missing = sentinels.filter(([needle]) => !all.includes(needle)).map(([, label]) => label);

    if (missing.length) {
      err(`custom.styl 的部分规则未出现在产物 CSS 中：${missing.join('、')}。` +
          '可能 styl 编译失败或被跳过，页面会静默丢失这些样式。');
    } else {
      console.log(`  [ok] custom.styl 规则已进产物（${sentinels.length} 组哨兵全部命中）`);
    }
  }
}

// ---------- 5c. Waline 访问量的 data-path 必须与浏览器路径一致 ----------
//
// 历史教训：ShokaX 有两个地方给 Waline 传路径，来源不同——
//   footer.pug 的 data-path ← post.path（构建期，形如 /about/index.html）
//   comments.ts 的 path     ← window.location.pathname（运行时，形如 /about/）
// Waline 客户端发现两者不一致时，该元素只查不增：
// 浏览量记到 /about/ 名下，展示时却查 /about/index.html → 永远是 0。
// 由 scripts/waline-path-fix.js 把 data-path 规范化成浏览器路径。
//
// 断言方式：拿每个页面的 data-path 与"该页 canonical 浏览器路径"逐一比对，
// 而不是简单要求"必须以 / 结尾"——404.html 这类文件式页面
// 的浏览器路径本来就是 /404.html，那样会误报。
{
  const { toBrowserPath } = browserPath;

  const htmlFiles = [];
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.html')) htmlFiles.push(p);
    }
  };
  walk(PUBLIC_DIR);

  const bad = [];
  let checked = 0;
  for (const f of htmlFiles) {
    const html = readFileSync(f, 'utf8');
    // 该页面对应的 route 路径（相对 public/）
    const route = f.slice(PUBLIC_DIR.length + 1).replace(/\\/g, '/');
    const want = toBrowserPath(route);

    for (const m of html.matchAll(/class="[^"]*\bwaline-pageview-count\b[^"]*"[^>]*\sdata-path="([^"]*)"/gi)) {
      checked++;
      if (m[1] !== want) bad.push(`${route} → data-path="${m[1]}"，应为 "${want}"`);
    }
  }

  if (bad.length) {
    err(`Waline 访问量的 data-path 与浏览器路径不一致（会导致计数与显示对不上、永远是 0）：\n` +
        bad.map((b) => `      ${b}`).join('\n') +
        '\n      检查 scripts/waline-path-fix.js 是否被加载。');
  } else if (checked) {
    console.log(`  [ok] Waline 访问量路径规范（${checked} 处，均与 location.pathname 一致）`);
  }
}

// ---------- 5d. 数据面板必须已渲染（构建期，不能留占位） ----------

// 历史教训：papers/rss/status/wiki 曾用客户端占位 div
//（<p class="loading">正在加载…</p>），但站点里没有任何脚本会去填它们。
// Hexo 是静态生成器，source/_data/*.json 在构建期就能渲染，
// 因此占位符永远不会消失——线上直接显示"正在加载"。
// 这里断言这些页面必须含真实数据，且不得残留占位文案。
const DATA_PAGES = [
  ['status/index.html', 'stat-grid', '状态面板'],
  ['papers/index.html', 'paper-list', '论文列表'],
  ['rss/index.html', 'rss-list', '外部订阅'],
  ['wiki/index.html', 'wiki-list', 'Wiki 索引'],
];

for (const [rel, marker, label] of DATA_PAGES) {
  const p = join(PUBLIC_DIR, rel);
  if (!existsSync(p)) continue; // 缺页已由 validatePages 报告
  const html = readFileSync(p, 'utf8');

  // 只匹配中文占位文案。注意不能匹配裸的 "loading" —— 主题自带的加载动画
  // 会输出 loading 相关的 class/属性，误判会导致假警报。
  if (/正在加载/.test(html)) {
    err(`${label} 页面仍含"正在加载"占位内容 —— 数据面板未在构建期渲染。` +
        '检查 source/对应页面是否使用了 {% status_panel %} 等标签。');
  }
  if (html.includes('class="loading"')) {
    err(`${label} 页面仍含 class="loading" 占位元素 —— 应在构建期渲染为真实数据。`);
  }
  if (!html.includes(marker)) {
    err(`${label} 页面缺少数据标记 ${marker} —— 标签可能未生效或数据源为空。`);
  }
  // 数据面板依赖 scripts/data-tags.js（CommonJS，Hexo 插件）
  if (!existsSync(join(root, 'scripts', 'data-tags.js'))) {
    err('缺少 scripts/data-tags.js —— Hexo 插件目录下的该文件提供数据渲染标签');
    break;
  }
}
if (!errors.length) console.log(`  [ok] 数据面板 ${DATA_PAGES.length} 个页面均已渲染`);

// ---------- 5c. 导航菜单：中文文案 + 单入口项不应有下箭头 ----------

// 背景：主题 menu.pug 用 `__('menu.' + name)` 取文案，自定义键
// （papers/rss/wiki/status）不在语言包里就显示英文；且菜单值写成对象时，
// 即使只有 default 一个子项也会渲染成 li.item.dropdown 并带下箭头，
// 点开却是同一个页面——纯视觉噪音。
const navIndexFile = join(PUBLIC_DIR, 'index.html');
const indexHtml = existsSync(navIndexFile) ? readFileSync(navIndexFile, 'utf8') : '';

const MENU_EXPECT = [
  ['/papers/', '论文', false],
  ['/rss/', '订阅', false],
  ['/wiki/', '知识库', false],
  ['/status/', '状态', false],
  ['/about/', '关于', false],
];

if (!indexHtml) {
  err('public/index.html 不存在，无法校验导航栏');
} else {
for (const [href, label, expectArrow] of MENU_EXPECT) {
    // 必须精确匹配**同一个** <li>：类名之后不允许跨越 </li>，
    // 否则惰性匹配会从更早的普通 <li class="item"> 开始，拿到错误的 class。
    // 类名允许含 dropdown，故用 [^\"]* 捕获后另行判断。
    const liRe = new RegExp(
      '<li class="(item[^"]*)">((?:(?!</li>)[\\s\\S]){0,400}?)</li>', 'i'
    );
    let cls = null;
    let text = '';
    let re = new RegExp(
      `<li class="(item[^"]*)">((?:(?!</li>)[\\s\\S]){0,400}?${href.replace(/\//g, '\\/')}(?:(?!</li>)[\\s\\S]){0,200}?)</li>`,
      'i'
    );
    let m = re.exec(indexHtml);
    if (!m) {
      // 回退：逐个 <li> 扫描，避免正则跨块
      const liAll = indexHtml.match(/<li class="item[^"]*">[\s\S]*?<\/li>/gi) || [];
      for (const li of liAll) {
        if (li.includes(`href="${href}"`)) { m = [li, (li.match(/class="(item[^"]*)"/i) || [])[1], li]; break; }
      }
    }
    if (!m) {
      err(`导航栏缺少指向 ${href} 的菜单项`);
      continue;
    }
    cls = (m[1] || '') + ' ' + ((m[2] || '').match(/class="(item[^"]*)"/i) || [])[1];
    const liHtml = m[0];
    text = liHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
    if (!text.includes(label)) {
      err(`导航 ${href} 的文案不是"${label}"（实际含：${text.slice(0, 40)}）—— ` +
          '检查 source/_data/languages.yml 的结构：语种键必须在顶层，不能多包一层 languages:');
    }
    const hasArrow = cls.includes('dropdown');
    if (hasArrow !== expectArrow) {
      err(`导航 ${label}（${href}）下箭头状态不符：期望 ${expectArrow ? '有' : '无'}，实际 ${hasArrow ? '有' : '无'}` +
          '——单入口的菜单项在 _config.shokax.yml 里必须用单值写法而非对象。');
    }
  }
  if (!errors.length) console.log(`  [ok] 导航栏 ${MENU_EXPECT.length} 项中文文案与箭头状态正确`);
}

// ---------- 5d. 双向链接必须已渲染 ----------

// [[标题]] 语法需要 scripts/wiki-links.js 支持，主题本身不认。
// 若插件失效，页面会原样显示方括号——文件正常、HTTP 200，校验若只看这些就会漏。
{
  const wikiPages = ['wiki/index.html', 'how-to-prioritize/index.html', 'agent-requirements/index.html'];
  let total = 0;
  let leftover = 0;

  for (const rel of wikiPages) {
    const p = join(PUBLIC_DIR, rel);
    if (!existsSync(p)) continue;
    const html = readFileSync(p, 'utf8');
    total += (html.match(/class="wiki-link"/g) || []).length;
    // 文档正文里说明语法用的方括号不在 <a> 中，需排除 code/pre 内的示例
    const outside = html.replace(/<code[\s\S]*?<\/code>/g, '').replace(/<pre[\s\S]*?<\/pre>/g, '');
    leftover += (outside.match(/\[\[[^\]\n]+\]\]/g) || []).length;
  }

  if (leftover) {
    err(`仍有 ${leftover} 处 [[...]] 未被渲染成链接 —— scripts/wiki-links.js 可能未生效。`);
  }
  if (!errors.length) {
    console.log(`  [ok] 双向链接已渲染（抽查 ${wikiPages.length} 页，命中 ${total} 处）`);
  }
}

// ---------- 5e. 站内搜索必须可用（Pagefind） ----------
//
// 用主题内置的 Pagefind 引擎（本地、无第三方凭据）。
// 关键：Pagefind 是**构建后**索引，不在 hexo generate 里跑，
// 所以 public/pagefind/ 目录由 `npm run search:index` 生成。
// 漏掉这一步 → 搜索按钮可点但永远无结果，且不报错。
{
  const shokaxYml = readFileSync(join(root, '_config.shokax.yml'), 'utf8');
  const enabled = /pagefind:[\s\S]{0,80}?enable:\s*true/.test(shokaxYml);
  const pfDir = join(PUBLIC_DIR, 'pagefind');

  if (enabled && !existsSync(pfDir)) {
    err('已启用 pagefind.enable: true，但产物中缺少 public/pagefind/ 索引目录 —— ' +
        '搜索会可点但无结果。请确认构建命令包含 `npm run search:index`（即用 build:search）。');
  } else if (enabled) {
    const pf = join(pfDir, 'pagefind.js');
    if (!existsSync(pf) || statSync(pf).size < 100) {
      err('public/pagefind/pagefind.js 缺失或过小，索引未正确生成。');
    } else {
      console.log('  [ok] Pagefind 搜索索引已生成（主题内置引擎）');
    }
  } else {
    warn('未启用 pagefind，站内搜索不可用（_config.shokax.yml 里设 pagefind.enable: true）');
  }
}

// ---------- 5f. 封面图与音乐播放器 ----------

// 封面：images.yml 声明的每一张都必须真实存在于 public/assets/。
// 主题的 randomBG 不会检查文件是否存在，缺图只会显示空白封面。
{
  const imgYml = join(root, 'source', '_data', 'images.yml');
  if (!existsSync(imgYml)) {
    warn('source/_data/images.yml 不存在，封面将回退到主题默认（可能是空）');
  } else {
    const list = readFileSync(imgYml, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim());

    if (list.length < 6) {
      err(`images.yml 只声明了 ${list.length} 张封面，少于 6 张会导致构建中止` +
          '（主题 randomBG 的硬性要求）。');
    }
    const missing = list.filter((p) => !existsSync(join(PUBLIC_DIR, p.replace(/^\//, ''))));
    if (missing.length) {
      err(`images.yml 声明的封面在产物中不存在：${missing.slice(0, 5).join('、')}` +
          (missing.length > 5 ? ` 等 ${missing.length} 张` : ''));
    }
    if (!errors.length) console.log(`  [ok] 封面 ${list.length} 张均存在于产物`);

    // 顺带校验侧栏头像
    const avatar = 'assets/avatar.jpg';
    if (!existsSync(join(PUBLIC_DIR, avatar))) {
      err(`缺少侧栏头像 ${avatar}（_config.shokax.yml 的 sidebar.avatar 指向它）`);
    }
  }
}

// 音乐播放器：主题内置 nyx-player。
// 数据源是 _config.shokax.yml 的**顶层 audio**（站点级，对所有页面生效），
// 由 theme/scripts/generaters/script.js 打进 siteConfig → shokax_CONFIG → CONFIG.audio。
// 这点踩过两次坑：正文 {% media %} 标签与页面 front-matter 的 audio 字段
// 播放器**都不读**，只认 theme.audio。
// 校验要点：theme.audio 存在 → 已打进产物 JS → 至少一条带 list[0]。
{
  const shokaxYml = readFileSync(join(root, '_config.shokax.yml'), 'utf8');
  const playerOn = /modules:[\s\S]{0,200}?player:////s*true/.test(shokaxYml);
  const hasThemeAudio = /^audio:////s*$/m.test(shokaxYml);

  if (!playerOn) {
    err('modules.player 未开启 —— 主题不会加载 nyx-player，播放器无功能。');
  } else if (!hasThemeAudio) {
    err('_config.shokax.yml 缺少顶层 audio 配置 —— CONFIG.audio 为 undefined，' +
        '播放器会报 TypeError: Cannot read properties of undefined。可执行 npm run music 生成。');
  } else {
    // 必须确认它真的进了产物 JS，否则数据只停留在配置文件里。
    const jsDir = join(PUBLIC_DIR, 'js');
    let found = 0;
    let sample = '';
    if (existsSync(jsDir)) {
      for (const f of readdirSync(jsDir)) {
        if (!f.endsWith('.js')) continue;
        const s = readFileSync(join(jsDir, f), 'utf8');
        const i = s.indexOf('audio:');
        if (i < 0) continue;
        const seg = s.slice(i, i + 80);
        if (seg.includes('undefined')) continue;
        // 括号计数取完整数组（地址里含 ]，不能用惰性匹配）
        const from = s.indexOf('[', i);
        if (from < 0) continue;
        let depth = 0, inStr = false, json = null;
        for (let k = from; k < s.length; k++) {
          const c = s[k];
          if (inStr) {
            if (c === '\\') { k++; continue; }
            if (c === '"') inStr = false;
            continue;
          }
          if (c === '"') { inStr = true; continue; }
          if (c === '[') depth++;
          else if (c === ']') { depth--; if (depth === 0) { json = s.slice(from, k + 1); break; } }
        }
        if (!json) continue;
        try {
          // 产物里是 JS 对象字面量（键无引号），不是合法 JSON，必须用 Function 求值
          const list = new Function('return ' + json)();
          if (Array.isArray(list) && list.length) { found = list.length; sample = String(list[0]?.title ?? ''); }
        } catch { /* 不是配置数组，跳过 */ }
        if (found) break;
      }
    }

    if (!found) {
      err('theme.audio 已在配置里，但未出现在产物 JS 中—— CONFIG.audio 运行时仍是 undefined，' +
          '播放器会抛 TypeError。请检查 _config.shokax.yml 的 audio 缩进是否正确。');
    } else {
      // initAudioPlayer 取 item.list[0]，缺失则放不出声
      const jsFiles = readdirSync(jsDir).filter((f) => f.endsWith('.js'));
      let bad = 0;
      for (const f of jsFiles) {
        const s = readFileSync(join(jsDir, f), 'utf8');
        const i = s.indexOf('audio:');
        if (i < 0) continue;
        const from = s.indexOf('[', i);
        if (from < 0) continue;
        let depth = 0, json = null;
        for (let k = from; k < s.length; k++) {
          const c = s[k];
          if (c === '[') depth++;
          else if (c === ']') { depth--; if (depth === 0) { json = s.slice(from, k + 1); break; } }
        }
        if (!json) continue;
        try {
          const list = new Function('return ' + json)();
          if (Array.isArray(list) && list.length) bad = list.filter((t) => !t.list || !t.list[0]).length;
        } catch { /* ignore */ }
        if (found) break;
      }
      if (bad === found) {
        err(`theme.audio 的 ${found} 条全部缺少 list[0] 音频地址 —— 播放器有列表但放不出声`);
      } else {
        console.log(`  [ok] 音乐播放器已就绪（theme.audio ${found} 首，首曲「${sample}」，已进产物 JS）`);
      }
    }
  }
}



// 播放/暂停图标切换：主题靠 #tool.playing 这个 class 换图标
// （#tool.playing .player .play-pause::before），但 ShokaX 0.5.4 自身
// 不给 #tool 加这个 class，需由 scripts/player-playing-class.js 补上。
// 缺了它：音频能正常播放暂停，但按钮图标恒为播放三角。
{
  const sample = join(PUBLIC_DIR, 'index.html');
  let ok = false;
  if (existsSync(sample)) {
    const html = readFileSync(sample, 'utf8');
    ok = html.includes('__toolPlayingBound') &&
         html.includes("classList.add('playing')") &&
         html.includes("classList.remove('playing')");
    if (!ok) {
      err('播放状态同步脚本未注入 —— 播放时按钮图标不会在播放/暂停间切换' +
          '（主题靠 #tool.playing 这个 class 换图标，但 0.5.4 自身不加）。');
    }
  }
  // CSS 侧的图标规则必须存在，否则加了 class 也没用
  const cssDir = join(PUBLIC_DIR, 'css');
  if (existsSync(cssDir)) {
    const hasRule = readdirSync(cssDir)
      .filter((f) => f.endsWith('.css'))
      .some((f) => /#tool.playing[^{]*.play-pause/.test(readFileSync(join(cssDir, f), 'utf8')));
    if (!hasRule) {
      err('CSS 中缺少 `#tool.playing .player .play-pause::before` 规则 —— ' +
          '播放图标无法切换。');
    } else if (!errors.length) {
      console.log('  [ok] 播放状态同步脚本已注入且 CSS 图标规则存在');
    }
  }
}

// ---------- 6. 占位内容检查 ----------

function validatePlaceholders() {
  const files = walk(PUBLIC_DIR).filter((f) => f.endsWith('.html'));
  const bad = [/lorem ipsum/i, /TODO[:：]/, /yourname\.com/i, /example\.com\/[^"\s]*/i];
  const hits = [];
  for (const f of files) {
    const html = readFileSync(f, 'utf8');
    for (const re of bad) {
      if (re.test(html)) { hits.push(`${relative(PUBLIC_DIR, f)} 命中 ${re}`); break; }
    }
  }
  if (hits.length) {
    for (const h of hits.slice(0, 10)) warn(`疑似占位内容未替换：${h}`);
  } else {
    console.log('  [ok] 无占位内容残留');
  }
}

// ---------- 主流程 ----------

console.log('校验站点数据与构建产物：');
validatePapers();
validateRss();
validateStatus();

if (existsSync(PUBLIC_DIR)) {
  validatePages();
  validateLinks();
  validateAttribution();
  validatePlaceholders();
} else {
  warn('public/ 不存在，跳过产物校验（先执行 npm run build）');
}

if (warnings.length) {
  console.log('\n警告（不阻塞构建）：');
  for (const w of warnings) console.log(`  ! ${w}`);
}

if (errors.length) {
  console.error('\n校验失败：');
  for (const e of errors) console.error(`  x ${e}`);
  process.exit(1);
}

console.log('\n校验通过。');