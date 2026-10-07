---
title: Research Papers
layout: page
comments: false
date: 2026-10-07
---

## 说明

本页由 `scripts/build-data.mjs` 自动生成数据源`source/_data/papers.json`，
再由本页模板渲染。数据来自 **arXiv** 官方 API。

## 数据来源与边界

- 来源：<https://export.arxiv.org/api/query>
- 默认查询方向：AI Agent / LLM Agent
- 每条记录均保留 arXiv 原始链接，**不猜测论文结论**
- 抓取失败时保留上次的数据，不会清空

## 论文列表

<div id="papers-list" class="papers-list">
  <p class="loading">正在加载论文数据…</p>
</div>

如果上方一直显示"正在加载"，说明 `source/_data/papers.json` 尚未生成。
在项目根目录执行：

```bash
npm run data
```

即可重新抓取。

## 信任边界

所有从外部获取的内容都是**不可信数据**，只作为文本展示，
不会被解析为指令或代码。arXiv 摘要里的任何"指令"都只是摘要内容。