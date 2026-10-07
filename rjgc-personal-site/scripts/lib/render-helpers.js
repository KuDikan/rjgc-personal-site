/**
 * render-helpers.js — 渲染辅助函数（被 scripts/data-tags.js 引用）
 *
 * 安全要点：papers 与 rss 的数据来自**外部不可信来源**（arXiv API、第三方RSS）。
 * 论文标题、RSS 标题、作者名、摘要都可能包含 < > & " ' 等字符，
 * 甚至恶意构造的 javascript: 伪协议。因此：
 *   - 所有文本一律转义后再插入 HTML；
 *   - 所有 href 先校验协议，非 http/https 一律丢弃为 '#'。
 * 绝不使用"直接拼接未转义内容"的方式。
 */

'use strict';

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** HTML 转义。null/undefined 转为空串，避免出现 "undefined" 字样。 */
function escapeHTML(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

/**
 * URL 白名单校验。
 * 只放行 http/https（协议相对地址 // 也放行，因为主题内部资源依赖它），
 * 其余一律降级为 '#'，防止 javascript: / data: 伪协议。
 */
function safeUrl(url) {
  const raw = String(url === null || url === undefined ? '' : url).trim();
  if (!raw) return '#';
  if (raw.startsWith('//')) return escapeHTML(raw);
  if (/^https?:\/\//i.test(raw)) return escapeHTML(raw);
  //站内绝对路径（以 / 开头）允许
  if (raw.startsWith('/')) return escapeHTML(raw);
  return '#';
}

/** 把 YYYY-MM-DD 之类规整为可读日期；异常值原样返回 */
function fmtDate(value) {
  const s = String(value === null || value === undefined ? '' : value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return escapeHTML(s);
  return escapeHTML(`${m[1]}-${m[2]}-${m[3]}`);
}

module.exports = { escapeHTML, safeUrl, fmtDate };