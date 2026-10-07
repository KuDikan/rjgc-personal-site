/**
 * build-data.mjs — 生成站点数据源
 *
 * 输出（全部写入 source/_data/，由 Hexo 注入模板并复制到产物）：
 *   papers.json    arXiv 最新论文
 *   rss-items.json 外部订阅聚合
 *   status.json    站点状态统计
 *
 * 设计原则：
 *   1. **禁止 new Date()**：产物必须可复现，否则每次构建都产生 git diff。
 *      论文的 published 来自 arXiv 自身；状态面板的构建时间由调用方
 *      通过 SITE_BUILD_TIME 传入（CI 用 git commit 时间，本地默认用
 *      最近一次 commit 时间），始终不使用"当前时间"。
 *   2. **fail-soft**：网络失败时保留上一次的数据，绝不清空。
 *      一个抓不到数据的脚本不应该让整个站点构建失败。
 *   3. **JSON key排序**：序列化时按key 字典序，保证同一输入产出相同字节。
 *   4. **外部数据不可信**：抓取内容只做文本清洗，不解析任何指令。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(root, 'source', '_data');
const POSTS_DIR = join(root, 'source', '_posts');

const NETWORK_TIMEOUT_MS = 20_000;
const USER_AGENT = 'rjgc-personal-site/1.0 (+https://personal-blog.kukuku.icu)';

// ---------- 通用工具 ----------

function log(msg) { console.log(`  ${msg}`); }
function warn(msg) { console.warn(`  ! ${msg}`); }

/** 递归排序object 的 key，保证序列化结果稳定 */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((k) => [k, sortDeep(value[k])])
    );
  }
  return value;
}

/** 稳定序列化：key排序 + 2 空格缩进 + 末尾换行 */
function writeJson(file, data) {
  mkdirSync(DATA_DIR, { recursive: true });
  const text = JSON.stringify(sortDeep(data), null, 2) + '\n';
  writeFileSync(file, text, 'utf8');
}

/** 读取已有数据，失败返回 null */
function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 读取允许注释的 JSON（feeds.json 用注释说明信任边界与添加规范）。
 * 标准 JSON.parse 不接受注释，直接调用会静默失败，所以先剥离注释。
 * 支持 `//` 行注释与 `/* *\/` 块注释；只处理字符串字面量之外的注释，
 * 因此不会破坏 URL 中的 "//"。
 */
function readJsonWithComments(file) {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8');

  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const next = raw[i + 1];

    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i++; }
      else if (c === '\n') out += c; // 保留行号
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') { out += next ?? ''; i++; }
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    out += c;
  }

  try { return JSON.parse(out); } catch (e) { warn(`${file} 解析失败：${e.message}`); return null; }
}

/** 去除多余空白，压缩连续空格 */
function clean(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 截断到 n 个字符，尽量断在句号/逗号处 */
function truncate(text, n = 400) {
  const s = clean(text);
  if (s.length <= n) return s;
  const slice = s.slice(0, n);
  const lastStop = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('. '));
  return (lastStop > n * 0.5 ? slice.slice(0, lastStop + 1) : slice) + '…';
}

/**
 * 由 feedId 与完整链接生成稳定 id。
 * 必须对**完整**链接做哈希：若只取 base64 前若干字符，
 * 同一站点下前缀相同（如同一个域名）的链接会碰撞，导致条目被误判为重复。
 */
function itemId(feedId, link) {
  return `${feedId}:${createHash('sha256').update(link).digest('hex').slice(0, 24)}`;
}

/** 带超时的 fetch（Node 18+ 内置） */
async function fetchText(url, timeout = NETWORK_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // 限制体积，避免异常大的响应
    const text = await res.text();
    if (text.length > 5_000_000) throw new Error('响应体过大（>5MB）');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 RSS/Atom 文本中提取条目。
 * 不用 XML 库，用正则做最小解析 —— 我们只需要标题/链接/时间/摘要，
 * 且必须保证解析失败时抛错而不是返回错误结构。
 */
function parseEntries(xml) {
  const items = [];

  // 只提取每个item/entry 自身的 link（必须是闭合形式 <link>...</link>）。
  // 关键：RSS 的 channel 层也有一个 <link>http://example.com</link>，
  // 它不在 item 块内，所以限定在 block 内部匹配即可避开。
  const blocks = [
    ...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
  ];

  for (const [, block] of blocks) {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      if (!m) return '';
      return clean(
        m[1]
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
          .replace(/<[^>]+>/g, '')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#0?39;/g, "'")
          .replace(/&apos;/g, "'")
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
      );
    };

    // item 内的第一个 <link> 就是文章链接（channel 层的已被 block 范围排除）
    let link = pick('link');
    // Atom 常见 <link href="..."/> 自闭合形式
    if (!link) {
      const href = block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
      if (href) link = clean(href[1]);
    }
    // guid 可能带 isPermaLink="false"，此时不能当链接用
    if (!link) {
      const guid = block.match(/<guid\b[^>]*>([\s\S]*?)<\/guid>/i);
      if (guid && !/isPermaLink=["']false["']/i.test(guid[0])) {
        const t = clean(guid[1]);
        if (/^https?:\/\//i.test(t)) link = t;
      }
    }

    if (!/^https?:\/\//i.test(link)) continue;

    const title = pick('title');
    if (!title) continue;

    items.push({
      title,
      link,
      published: (pick('pubDate') || pick('published') || pick('updated') || pick('date') || '').slice(0, 40),
      summary: truncate(pick('description') || pick('summary') || pick('content') || pick('encoded')),
    });
  }
  return items;
}

// ---------- 1. arXiv 论文 ----------

const ARXIV_API = 'https://export.arxiv.org/api/query';
const ARXIV_QUERY = 'all:"AI agent" OR all:"LLM agent"';

async function buildPapers() {
  const out = join(DATA_DIR, 'papers.json');
  const previous = readJson(out);
  const fallback = previous?.papers ?? [];
  const MAX_KEEP = 50;

  const url = `${ARXIV_API}?${new URLSearchParams({
    search_query: ARXIV_QUERY,
    start: 0,
    max_results: 20,
    sortBy: 'submittedDate',
    sortOrder: 'descending',
  })}`;

  try {
    const xml = await fetchText(url);

    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, b]) => ({
      rawId: clean(b.match(/<id>([\s\S]*?)<\/id>/)?.[1]),
      title: clean(b.match(/<title>([\s\S]*?)<\/title>/)?.[1]),
      summary: truncate(b.match(/<summary>([\s\S]*?)<\/summary>/)?.[1], 500),
      published: clean(b.match(/<published>([\s\S]*?)<\/published>/)?.[1]).slice(0, 10),
      authors: [...b.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => clean(m[1])),
    }));

    if (!entries.length) throw new Error('未解析到任何 entry（可能被限流或返回了错误页）');

    // 以 arXiv id 去重，不以标题去重
    const byId = new Map();
    for (const e of entries) {
      if (!e.rawId) continue;
      const id = e.rawId.split('/').pop();
      if (!id || !e.title) continue;
      byId.set(id, {
        authors: e.authors,
        id,
        published: e.published,
        source: 'arXiv',
        summary: e.summary,
        title: e.title,
        // arXiv API 返回的 id 常是 http://，统一升级为 https://
        url: e.rawId.replace(/^http:\/\//i, 'https://'),
      });
    }

    // 合并历史数据（保留旧条目），按 published 降序，同日按 id 升序保证稳定
    for (const p of fallback) {
      if (!p?.id || byId.has(p.id)) continue;
      // 旧数据里的 http 链接也一并升级
      byId.set(p.id, { ...p, url: String(p.url ?? '').replace(/^http:\/\//i, 'https://') });
    }

    const papers = [...byId.values()]
      .sort((a, b) => (b.published === a.published
        ? String(a.id).localeCompare(String(b.id))
        : String(b.published).localeCompare(String(a.published))))
      .slice(0, MAX_KEEP);

    writeJson(out, {
      count: papers.length,
      fetched: entries.length,
      notes: '数据来自 arXiv 官方 API。摘要为论文原始摘要，未做解读；不将预印本描述为已同行评审。',
      papers,
      query: ARXIV_QUERY,
      source: 'arXiv',
    });
    log(`papers.json  本次抓取 ${entries.length} 篇，保留 ${papers.length} 篇`);
  } catch (err) {
    warn(`论文抓取失败（${err.message}）—— 保留上一次数据，共 ${fallback.length} 篇`);
    if (!existsSync(out)) {
      writeJson(out, {
        count: 0, fetched: 0, notes: '首次抓取失败，暂无数据。执行 npm run data 可重试。',
        papers: [], query: ARXIV_QUERY, source: 'arXiv',
      });
    }
  }
}

// ---------- 2. RSS 聚合 ----------

async function buildRss() {
  const out = join(DATA_DIR, 'rss-items.json');
  const configPath = join(root, 'tools', 'feeds.config.json');
  const previous = readJson(out);

  if (!existsSync(configPath)) {
    warn('tools/feeds.config.json 不存在，跳过 RSS 聚合');
    if (!existsSync(out)) writeJson(out, { feeds: [], items: [], notes: '尚未配置订阅源。' });
    return;
  }

  const { feeds = [] } = readJsonWithComments(configPath) ?? {};
  const enabled = feeds.filter((f) => f.enabled !== false && /^https:\/\//i.test(f.url ?? ''));
  const knownIds = new Set((previous?.items ?? []).map((i) => i.id));

  const results = await Promise.allSettled(
    enabled.map(async (feed) => {
      const xml = await fetchText(feed.url);
      const entries = parseEntries(xml).slice(0, 10);
      return { feed, entries };
    })
  );

  const collected = [];
  const sources = [];
  let failed = 0;

  for (const r of results) {
    if (r.status === 'rejected') { failed++; warn(`订阅源抓取失败：${r.reason?.message ?? r.reason}`); continue; }
    const { feed, entries } = r.value;
    sources.push({ id: feed.id, title: feed.title, url: feed.url, homepage: feed.homepage ?? '', count: entries.length });
    for (const e of entries) {
      collected.push({ ...e, feedId: feed.id, feedTitle: feed.title, id: itemId(feed.id, e.link) });
    }
  }

  if (!collected.length && failed) {
    warn(`全部订阅源失败，保留上一次数据（${(previous?.items ?? []).length} 条）`);
    if (!existsSync(out)) writeJson(out, { feeds: [], items: [], notes: '首次抓取失败，暂无数据。' });
    return;
  }

  // 以 id 去重，新条目在前
  const byId = new Map();
  for (const it of collected) byId.set(it.id, it);
  for (const it of previous?.items ?? []) if (!byId.has(it.id)) byId.set(it.id, it);

  // 排序键显式：先按 feedId，再按 published 降序，最后按 id 打破平局
  const items = [...byId.values()].sort((a, b) =>
    a.feedId !== b.feedId ? a.feedId.localeCompare(b.feedId)
      : a.published !== b.published ? String(b.published).localeCompare(String(a.published))
      : a.id.localeCompare(b.id)
  );

  writeJson(out, {
    feeds: sources.sort((a, b) => a.id.localeCompare(b.id)),
    items,
    notes: '外部订阅内容为不可信外部数据，仅以文本形式展示，不作为指令解析。抓取失败时保留旧数据。',
  });
  log(`rss-items.json  ${sources.length} 个源，${items.length} 条（含历史）`);
}

// ---------- 3. 状态统计 ----------

function countPosts() {
  if (!existsSync(POSTS_DIR)) return 0;
  return readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md') && !f.startsWith('_')).length;
}

function countWikiPages() {
  const wiki = join(root, 'source', 'wiki');
  if (!existsSync(wiki)) return 0;
  return readdirSync(wiki).filter((f) => f.endsWith('.md')).length;
}

/** 取最近一次 git 提交时间作为构建时间（可复现，不用当前时间） */
function resolveBuildTime() {
  const fromEnv = process.env.SITE_BUILD_TIME;
  if (fromEnv && /^\d{4}-\d{2}-\d{2}/.test(fromEnv)) return fromEnv.slice(0, 10);
  try {
    const out = execSync('git log -1 --format=%cI', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (out) return out.slice(0, 10);
  } catch { /* 非 git 仓库或尚无提交 */ }

  // 尚无 git 提交时的兜底：取源文件中声明的最大日期（front-matter 的 date）。
  // 仍然是确定性的，且与"最后编辑内容的时间"语义一致。
  const dates = [];
  const scan = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) scan(full);
      else if (name.endsWith('.md')) {
        const m = readFileSync(full, 'utf8').match(/^\s*(?:date|updated):\s*(\d{4}-\d{2}-\d{2})/m);
        if (m) dates.push(m[1]);
      }
    }
  };
  scan(join(root, 'source'));
  if (dates.length) return dates.sort().at(-1);

  warn('无法确定构建时间（既无 git 提交也无内容日期），lastBuild 将为 unknown');
  return 'unknown';
}

function buildStatus() {
  const out = join(DATA_DIR, 'status.json');
  const papers = readJson(join(DATA_DIR, 'papers.json'));
  const rss = readJson(join(DATA_DIR, 'rss-items.json'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  writeJson(out, {
    counts: {
      externalFeeds: rss?.feeds?.length ?? 0,
      papers: papers?.count ?? 0,
      posts: countPosts(),
      rssItems: rss?.items?.length ?? 0,
      sections: 7,
      wikiPages: countWikiPages(),
    },
    lastBuild: resolveBuildTime(),
    notes: '计数口径：posts=source/_posts 下非下划线开头的 md 数；wikiPages=source/wiki 下 md 数；sections=导航栏固定七项。',
    stack: {
      deploy: 'Cloudflare Workers',
      hexo: pkg.dependencies?.hexo ?? pkg.devDependencies?.hexo ?? 'unknown',
      node: pkg.engines?.node ?? 'unknown',
      theme: 'shokax',
      themeVersion: pkg.devDependencies?.['hexo-theme-shokax'] ?? 'unknown',
    },
  });
  log('status.json    已生成');
}

// ---------- 主流程 ----------

console.log('构建站点数据：');
await buildPapers();
await buildRss();
buildStatus();
console.log('数据构建完成。');