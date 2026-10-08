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
  ['music/index.html', '音乐播放器'],
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

// ---------- 5b. 数据面板必须已渲染（构建期，不能留占位） ----------

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

// 音乐播放器：主题内置的 {% media audio %} + nyx-player。
// 必须同时满足：player 模块已启用、音乐页存在、页面含 .player 容器、
// 且容器内播放列表非空并带音频地址——否则播放器"渲染出来也是哑的"。
{
  const shokaxYml = readFileSync(join(root, '_config.shokax.yml'), 'utf8');
  const playerOn = /modules:[\s\S]{0,200}?player:\s*true/.test(shokaxYml);
  const musicPage = join(PUBLIC_DIR, 'music/index.html');

  if (!existsSync(musicPage)) {
    warn('未找到 public/music/index.html，音乐播放器不会渲染（可执行 npm run music 生成）');
  } else if (!playerOn) {
    err('存在音乐页但 modules.player 为 false —— 主题不会加载 nyx-player，播放器无功能。');
  } else {
    const html = readFileSync(musicPage, 'utf8');

    // 关键：播放器读的是 CONFIG.audio（来自 page.audio front-matter），
    // 不是正文里的 {% media %} 标签。只检查 media 标签会漏掉
    // "按钮出现但点了没反应"这种故障——因为 CONFIG.audio 是 undefined。
    // CONFIG.audio 是完整 JSON 数组，内含的音频地址里带 `]`（如 ?id=287398），
    // 因此不能用 [\s\S]*?\] 之类"匹配到第一个右括号"的写法。
    // 改为：从 '[' 起做括号计数，找到真正配对的 ']'。
    const audioStart = html.indexOf('audio:');
    let audioJson = null;
    if (audioStart >= 0 && !/audio:\s*undefined/.test(html.slice(audioStart, audioStart + 20))) {
      const from = html.indexOf('[', audioStart);
      if (from >= 0) {
        let depth = 0;
        let inStr = false;
        for (let i = from; i < html.length; i++) {
          const ch = html[i];
          if (inStr) {
            if (ch === '\\') { i++; continue; }
            if (ch === '"') inStr = false;
            continue;
          }
          if (ch === '"') { inStr = true; continue; }
          if (ch === '[') depth++;
          else if (ch === ']') { depth--; if (depth === 0) { audioJson = html.slice(from, i + 1); break; } }
        }
      }
    }

    if (!audioJson) {
      err('音乐页 front-matter 缺少 audio 字段（产物中 CONFIG.audio 为 undefined）—— ' +
          '主题播放器读不到播放列表，工具栏按钮会可点但无反应。' +
          '可执行 npm run music 重新生成音乐页。');
    } else {
      let list = [];
      try {
        list = JSON.parse(audioJson);
      } catch (e) {
        err(`CONFIG.audio 不是合法 JSON：${e.message}`);
      }
      if (Array.isArray(list) && list.length) {
        // initAudioPlayer 取 item.list[0]，缺 list 或空list 都会导致无声音
        const bad = list.filter((t) => !Array.isArray(t.list) || !t.list[0]);
        if (bad.length === list.length) {
          err('CONFIG.audio 中没有任何条目带 list[0] 音频地址 —— 播放器有列表但放不出声。');
        } else if (bad.length) {
          warn(`CONFIG.audio 有 ${bad.length} 条缺少 list[0]，这些曲目无法播放`);
        }
        // 工具栏按钮由 domInit 在 __shokax_player__ 为 true 时注入，
        // 按钮本身是 JS 创建的，产物 HTML 里不会有，故只校验数据侧。
        console.log(`  [ok] 音乐播放器已就绪（CONFIG.audio ${list.length} 首，${list.length - bad.length} 首可播放）`);
      } else {
        err('CONFIG.audio 为空数组 —— 播放器无内容。');
      }
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