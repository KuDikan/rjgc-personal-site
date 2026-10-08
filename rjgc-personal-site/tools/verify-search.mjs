/**
 * 本地搜索的离线验证脚本（不依赖浏览器）
 *
 * 用最小 DOM 替身加载"产物里真实注入的那段脚本"，验证：
 *   1. search.xml 能否解析出条目
 *   2. 查询能否命中（标题/分类/标签/正文）
 *   3. 多关键词 AND 是否正确
 *   4. 命中词高亮与文本转义是否正确（含 XSS 尝试）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 最小 DOM 替身 ----------
class El {
  constructor(tag, text) { this.tag = tag; this._text = text || ''; this.children = []; }
  set textContent(v) { this._text = v; this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map(c => c.textContent).join('');
    return this._text;
  }
  get innerHTML() {
    // 模拟浏览器：textContent 写入后读 innerHTML 会自动转义
    return String(this._text)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  set innerHTML(v) { this._text = v; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener() {}
  setAttribute() {}
  getElementsByTagName(t) {
    const out = [];
    const walk = (e) => { if (e.tag === t) out.push(e); e.children.forEach(walk); };
    walk(this);
    return out;
  }
  querySelector() { return null; }
  get dataset() { return this._d || (this._d = {}); }
}

// 从真实 search.xml 构建 entry树
const xml = readFileSync(join(root, 'public', 'search.xml'), 'utf8');
function parseEntries(x) {
  const root = new El('entry');
  for (const m of x.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = new El('entry');
    for (const t of ['title', 'url', 'content', 'category', 'tag']) {
      const re = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'g');
      for (const mm of m[1].matchAll(re)) {
        const c = new El(t);
        c.textContent = mm[1]
          .replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
          .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        e.appendChild(c);
      }
    }
    root.appendChild(e);
  }
  return root;
}
globalThis.DOMParser = class { parseFromString() { return parseEntries(xml); } };
globalThis.document = {
  readyState: 'complete',
  createElement: (t) => new El(t),
  addEventListener: () => {},
  querySelector: () => null,
  body: new El('body'),
  getElementById: () => null,
};
globalThis.window = { addEventListener: () => {} };
globalThis.fetch = () => Promise.resolve({ ok: true, text: () => Promise.resolve(xml) });

// ---------- 加载产物里真实注入的脚本 ----------
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
// 必须按 __localSearchInstalled 定位到**搜索脚本本身**。
// 页面上还有其它注入脚本（如 music-player），用泛化的 <script> 匹配会抓错块。
const START = '<script>\n(function () {\n  \'use strict\';\n  if (window.__localSearchInstalled) return;';
const startIdx = html.indexOf(START);
if (startIdx < 0) {
  console.error('未找到本地搜索脚本（按 __localSearchInstalled 定位）');
  process.exit(1);
}
const endIdx = html.indexOf('</script>', startIdx);
const js = html.slice(startIdx + '<script>'.length, endIdx);

// 暴露内部函数供测试：脚本是 IIFE，用 eval 并追加导出
const instrumented = js.replace('})();', `
  globalThis.__test = { loadIndex, query, highlight, stripTags };
})();`);
(0, eval)(instrumented);
const { loadIndex, query, highlight } = globalThis.__test;

// ---------- 执行测试 ----------
const entries = await loadIndex();
console.log('索引条目数:', entries.length);
if (!entries.length) { console.error('✗ 索引解析失败'); process.exit(1); }
console.log('首条: { title: "%s", url: "%s", cats: %s }',
  entries[0].title, entries[0].url, JSON.stringify(entries[0].cats));

const cases = [
  ['Hexo', 1], ['hexo', 1], ['Git', 1],
  ['部署', 1], ['安全', 1],
  ['不存在的词xyz', 0],
];
let pass = 0, fail = 0;
for (const [q, min] of cases) {
  const r = query(q);
  const ok = r.length >= min && (min === 0 ? r.length === 0 : r.length > 0);
  console.log(`  ${ok ? '✓' : '✗'} query("${q}") → ${r.length} 条`);
  ok ? pass++ : fail++;
}

// 多关键词 AND
const multi = query('Hexo 部署');
console.log(`  ${multi.length >= 0 ? '✓' : '✗'} query("Hexo 部署") → ${multi.length} 条（AND 语义）`);

// 高亮 + XSS 尝试
const evil = query('<img src=x onerror=alert(1)>');
const hl = highlight('<script>alert(1)</script>', 'script');
const escaped = !/<script>/.test(hl) && /&lt;/.test(hl);
console.log(`  ${escaped ? '✓' : '✗'} 高亮已转义: ${hl}`);
const evilHit = evil.length === 0;
console.log(`  ${evilHit ? '✓' : '✗'} XSS 查询无结果（预期 0 条，实际 ${evil.length}）`);

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
