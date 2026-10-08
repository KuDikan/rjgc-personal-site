/**
 * local-search.js — 自包含的站内搜索（不依赖 Algolia）
 *
 * ## 为什么必须自己写
 *
 * 主题的搜索按钮能否点击，取决于构建期常量 __shokax_algolia_search__
 * （见 theme/scripts/generaters/script.js）：
 *
 *     __shokax_algolia_search__: config?.algolia ? "true" : "false"
 *
 * 而 siteInit.ts 里是：
 *
 *     if (__shokax_algolia_search__) {
 *       document.querySelector('li.item.search > i').addEventListener('click', ...)
 *     } else if (__shokax_pagefind_search__) { ...pagefind... }
 *     // 两者都 false → 没有任何分支绑定点击
 *
 * 这些常量是**构建期被 Vite 的 define 内联**的字符串，不出现在产物里。
 * 没有 Algolia 凭据时它们都是 "false"，打包器会把该分支连同
 * 动态 import 的 algolia 代码整段 tree-shake 掉——
 * 结果是按钮**渲染出来了，却没有任何监听器**，点了毫无反应，也不报错。
 *
 * ## 本插件的策略
 *
 * 完全自建弹窗，不复用主题的 #search 容器（那个由 Algolia 分支动态创建，
 * 在本场景下根本不存在）。因此：
 *   - 自己创建 #search DOM 与类名，沿用主题 CSS 保持观感一致；
 *   - 自己创建输入框，不依赖 instantsearch 的 searchBox 渲染；
 *   - 在**捕获阶段**监听点击，阻止默认行为，并用 stopImmediatePropagation
 *     防止将来用户自行开启 pagefind 时与本插件重复响应。
 *
 * ## 数据来源
 *
 * 复用 hexo-generator-search 产出的 public/search.xml，
 * 内含每篇文章的 title / url / categories / tags / 全文 content。
 * 本地 fetch，无第三方依赖，无境外请求。
 *
 * ## 安全
 *
 * 搜索词来自用户输入。结果渲染时先用 textContent 落文本，
 * 再仅对命中片段插入 <mark>，不用 innerHTML 拼接用户输入，避免 XSS。
 */

'use strict';

const { transformRoute } = require('./lib/route-transform');

const SCRIPT = `
<script>
(function () {
  'use strict';
  if (window.__localSearchInstalled) return;
  window.__localSearchInstalled = true;

  var INDEX_URL = '/search.xml';
  var entries = null;      // null = 未加载

  function stripTags(html) {
    if (!html) return '';
    var d = document.createElement('div');
    d.innerHTML = html;
    return (d.textContent || '').replace(/\\s+/g, ' ').trim();
  }

  function loadIndex() {
    if (entries) return Promise.resolve(entries);
    return fetch(INDEX_URL)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (xml) {
        var doc = new DOMParser().parseFromString(xml, 'text/xml');
        var nodes = doc.getElementsByTagName('entry');
        entries = [];
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          var t = n.getElementsByTagName('title')[0];
          var u = n.getElementsByTagName('url')[0];
          if (!t || !u) continue;
          var cats = [].map.call(n.getElementsByTagName('category'), function (e) {
            return e.textContent.trim();
          });
          var tags = [].map.call(n.getElementsByTagName('tag'), function (e) {
            return e.textContent.trim();
          });
          var c = n.getElementsByTagName('content')[0];
          var title = t.textContent.trim();
          var body = stripTags(c ? c.textContent : '').toLowerCase();
          entries.push({
            title: title,
            url: u.textContent.trim(),
            cats: cats,
            tags: tags,
            // 标题重复两次以提高命中权重
            hay: (title + ' ' + title + ' ' + cats.join(' ') + ' ' +
                  tags.join(' ') + ' ' + body).toLowerCase()
          });
        }
        return entries;
      })
      .catch(function (err) {
        entries = [];
        console.error('[local-search] 索引加载失败：', err);
        return entries;
      });
  }

  function query(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    var terms = q.split(/\\s+/);      // 多关键词取交集
    return entries.filter(function (e) {
      return terms.every(function (t) { return e.hay.indexOf(t) !== -1; });
    });
  }

  /** 只把命中词包成 <mark>。
   *  做法：先按命中词把文本切成"命中/未命中"片段，
   *  逐段用 textContent 落文本（浏览器会自动转义 < > &），
   *  只有 <mark> 标签本身是字符串拼接。这样即便文本含标签也不会注入。
   */
  function highlight(text, term) {
    var src = String(text);
    if (!term) {
      var plain = document.createElement('span');
      plain.textContent = src;
      return plain.innerHTML;
    }
    // 注意转义层级：此处是 JS 模板字面量，反斜杠需写四个才能在产物里留两个，
    // 正则的字符类里要的是 \\ （一个转义反斜杠 + 一个终止符）。
    var escapedTerm = term.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    var re = new RegExp('(' + escapedTerm + ')', 'gi');
    var out = '';
    var last = 0;
    var m;
    while ((m = re.exec(src)) !== null) {
      if (m.index === re.lastIndex) { re.lastIndex++; continue; }  // 防零宽死循环
      out += escapeHtmlSlice(src.slice(last, m.index));
      out += '<mark>' + escapeHtmlSlice(m[0]) + '</mark>';
      last = m.index + m[0].length;
    }
    out += escapeHtmlSlice(src.slice(last));
    return out;
  }

  function escapeHtmlSlice(s) {
    var d = document.createElement('span');
    d.textContent = s;
    return d.innerHTML;
  }

  function render(list, q) {
    var box = document.getElementById('search-hits');
    if (!box) return;
    box.innerHTML = '';
    if (!q.trim()) return;

    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'item';
      empty.id = 'hits-empty';
      empty.textContent = '没有找到与“' + q.trim() + '”相关的内容';
      box.appendChild(empty);
      return;
    }

    var first = q.trim().toLowerCase().split(/\\s+/)[0];
    list.forEach(function (e) {
      var a = document.createElement('a');
      a.href = e.url;
      a.className = 'item';

      if (e.cats.length) {
        var span = document.createElement('span');
        span.textContent = e.cats.join(' › ');
        a.appendChild(span);
      }
      var titleHtml = document.createElement('span');
      titleHtml.innerHTML = highlight(e.title, first);
      a.appendChild(titleHtml);

      box.appendChild(a);
    });
  }

  function ensurePopup() {
    var search = document.getElementById('search');
    if (search) return search;

    search = document.createElement('div');
    search.id = 'search';
    search.innerHTML =
      '<div class="inner">' +
        '<div class="header">' +
          '<span class="icon"><i class="ic i-search"></i></span>' +
          '<input class="search-input" type="search" placeholder="搜索文章…" autocomplete="off">' +
          '<span class="close-btn"><i class="ic i-times-circle"></i></span>' +
        '</div>' +
        '<div class="results"><div class="inner">' +
          '<div id="search-stats"></div><div id="search-hits"></div>' +
        '</div></div>' +
      '</div>';
    document.body.appendChild(search);

    var input = search.querySelector('.search-input');
    input.addEventListener('input', function () {
      var q = input.value;
      loadIndex().then(function () {
        var list = query(q);
        var stats = document.getElementById('search-stats');
        if (stats) {
          stats.textContent = q.trim()
            ? '找到 ' + list.length + ' 条结果（关键词：' + q.trim() + '）'
            : '';
        }
        render(list, q);
      });
    });

    search.querySelector('.close-btn').addEventListener('click', closePopup);
    search.addEventListener('click', function (ev) {
      if (ev.target === search) closePopup();
    });
    document.addEventListener('keyup', function (ev) {
      if (ev.key === 'Escape') closePopup();
    });

    return search;
  }

  function openPopup() {
    var search = ensurePopup();
    search.classList.add('show');
    document.body.style.overflow = 'hidden';
    var input = search.querySelector('.search-input');
    if (input) input.focus();
    loadIndex();   // 预热，第二次输入就不用等
  }

  function closePopup() {
    var search = document.getElementById('search');
    if (search) search.classList.remove('show');
    document.body.style.overflow = '';
  }

  function attach() {
    var icon = document.querySelector('li.item.search > i') ||
               document.querySelector('li.item.search');
    if (!icon || icon.dataset.localBound === '1') return;
    icon.dataset.localBound = '1';

    icon.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      openPopup();
    }, true);   // 捕获阶段，抢在主题可能的监听器之前
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }
  // pjax 换页后 DOM 重建，需重新绑定
  document.addEventListener('pjax:end', attach);
  window.addEventListener('load', attach);
})();
</script>
`;

hexo.extend.filter.register('after_generate', function () {
  const { attached } = transformRoute(
    hexo,
    (html) => {
      if (html.includes('__localSearchInstalled')) return html;
      // 必须替换**最后一个** </body>：本页面的其他插件脚本里可能含有
      // 字符串字面量 '</body>'（例如 music-player 的注入片段），
      // 用 String.replace(字符串) 只会替换第一处，会把脚本插到错误位置。
      return html.replace(/<\/body>(?![\s\S]*<\/body>)/i, SCRIPT + '</body>');
    },
    undefined,
    'local-search'
  );
  if (attached) {
    hexo.log.info(`[local-search] 已向 ${attached} 个页面注入本地搜索脚本`);
  }
});
