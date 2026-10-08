/**
 * local-search.js — 用本地 search.xml 实现站内搜索
 *
 * 为什么不用主题自带的搜索：
 * 主题的 page/search.ts 硬依赖 Algolia（instantsearch.js + algoliasearch/lite），
 * 需要 appID / apiKey / indexName 三项凭据。缺任何一项，
 * 搜索弹窗能打开但**永远出不了结果**，而按钮看起来完全正常——
 * 属于典型的"能点但没用"。
 *
 * 而 hexo-generator-search 已经在产物里生成了 public/search.xml，
 * 内含每篇文章的 title / url / categories / tags / 全文 content。
 * 这些数据本地就有，完全够用，且不依赖任何境外服务。
 *
 * 本插件在页面底部注入一段脚本：
 *   - 接管主题搜索按钮的点击（阻止它加载 Algolia）
 *   - 首次打开时拉取 search.xml，在浏览器内做标题/正文/标签匹配
 *   - 结果渲染进主题自带的 #search-hits 容器，样式沿用主题，无需额外 CSS
 *
 * 触发时机：after_post_render 注入 <script> 到页面尾部，
 * 保证 DOM 就绪后绑定；pjax 切换由主题自身的 siteInit 处理。
 *
 * 安全：搜索词来自用户输入，用 textContent 而非 innerHTML 写入结果，
 * 避免 XSS。索引内容虽是本站生成，仍按不可信处理（只做纯文本匹配）。
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
  var entries = null;      // null=未加载, []=已加载但为空
  var loading = null;

  // 去掉标签，得到纯文本，再做大小写与空白归一化
  function stripTags(html) {
    if (!html) return '';
    var d = document.createElement('div');
    d.innerHTML = html;
    return (d.textContent || '').replace(/\\s+/g, ' ').trim();
  }

  function loadIndex() {
    if (entries) return Promise.resolve(entries);
    if (loading) return loading;
    loading = fetch(INDEX_URL)
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
          var c = n.getElementsByTagName('content')[0];
          if (!t || !u) continue;
          var cats = Array.prototype.map.call(
            n.getElementsByTagName('category'), function (e) { return e.textContent.trim(); }
          );
          var tags = Array.prototype.map.call(
            n.getElementsByTagName('tag'), function (e) { return e.textContent.trim(); }
          );
          entries.push({
            title: t.textContent.trim(),
            url: u.textContent.trim(),
            cats: cats,
            tags: tags,
            // 正文只留纯文本用于匹配，避免每次检索都遍历大量标签
            body: stripTags(c ? c.textContent : '').toLowerCase(),
            hay: ''
          });
        }
        // 预拼检索串：标题权重高，分类/标签次之，正文最后
        entries.forEach(function (e) {
          e.hay = (e.title + ' ' + e.title + ' ' + e.cats.join(' ') + ' ' +
                   e.tags.join(' ') + ' ' + e.body).toLowerCase();
        });
        return entries;
      })
      .catch(function (err) {
        entries = [];
        console.error('[local-search] 索引加载失败：', err);
        return entries;
      });
    return loading;
  }

  function query(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    // 多关键词按空格切分，要求全部命中（AND）
    var terms = q.split(/\\s+/);
    return entries.filter(function (e) {
      return terms.every(function (t) { return e.hay.indexOf(t) !== -1; });
    }).map(function (e) { return e; });
  }

  function highlight(text, terms) {
    // 仅用于生成 <mark>，text 本身已由 escape 处理
    var out = document.createElement('span');
    out.textContent = text;
    if (!terms || !terms.length) return out;
    var html = out.innerHTML.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    terms.forEach(function (t) {
      if (!t) return;
      html = html.replace(new RegExp('(' + t.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + ')', 'gi'), '<mark>$1</mark>');
    });
    return html;
  }

  function render(list, q) {
    var box = document.querySelector('#search-hits');
    if (!box) return;
    box.innerHTML = '';
    if (!q.trim()) return;

    if (!list.length) {
      box.innerHTML = '<div class="item" id="hits-empty">没有找到与“' +
        q.replace(/[<>&]/g, '') + '”相关的内容</div>';
      return;
    }

    var terms = q.trim().toLowerCase().split(/\\s+/);
    list.forEach(function (e) {
      var a = document.createElement('a');
      a.href = e.url;
      a.className = 'item';

      var cats = e.cats.length
        ? '<span>' + e.cats.join('<i class="ic i-angle-right"></i>') + '</span>'
        : '';
      var titleHtml = highlight(e.title, [terms[0]]).innerHTML;

      a.innerHTML = cats + titleHtml;
      box.appendChild(a);
    });
  }

  function attach() {
    var trigger = document.querySelector('#nav li.item.search');
    if (!trigger) return;

    // 主题原本绑定了 Algolia 搜索，这里阻止它，改用本地索引
    trigger.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopImmediatePropagation();

      // 触发主题创建 #search 弹窗容器
      var search = document.getElementById('search');
      if (search) search.classList.add('show');

      var input = document.querySelector('.search-input');
      if (!input) {
        // 主题的弹窗里容器由 Algolia 的 searchBox 填充，
        // 这里自己建一个输入框，避免依赖其渲染。
        var box = document.querySelector('.search-input-container');
        if (box && !box.querySelector('.search-input')) {
          var inp = document.createElement('input');
          inp.className = 'search-input';
          inp.type = 'search';
          inp.placeholder = '搜索文章…';
          box.appendChild(inp);
        }
        input = document.querySelector('.search-input');
      }
      if (!input) return;
      if (input.dataset.localBound !== '1') {
        input.dataset.localBound = '1';
        input.addEventListener('input', function () {
          var q = input.value;
          loadIndex().then(function () { render(query(q), q); });
        });
      }
      input.focus();
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }

  // pjax 换页后重新绑定
  document.addEventListener('pjax:end', attach);
})();
</script>
`;

hexo.extend.filter.register('after_generate', function () {
  const { attached } = transformRoute(
    hexo,
    (html) => (html.includes('__localSearchInstalled') ? html : html.replace('</body>', SCRIPT + '</body>')),
    undefined,
    'local-search'
  );
  if (attached) hexo.log.info(`[local-search] 已向 ${attached} 个页面注入本地搜索脚本`);
});
