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
    if (statSync(p).size < 50) err(`订阅文件过小，疑似生成失败：public/${f}`);
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

// ---------- 5. 占位内容检查 ----------

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