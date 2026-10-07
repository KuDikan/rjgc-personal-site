---
title: RSS 订阅
layout: page
comments: false
date: 2026-10-07
---

## 本站发布订阅源

本站文章对外以机器可读格式发布：

| 格式 | 地址 |
|---|---|
| RSS 2.0 | [/rss.xml](/rss.xml) |
| Atom 1.0 | [/atom.xml](/atom.xml) |
| JSON Feed | [/feed.json](/feed.json) |

三者均由主题自带的 `hexo-feed` 生成，包含每篇文章的标题、发布时间、
链接与摘要，并按日期倒序排列。

## 站内聚合的外部订阅

下表是本站聚合的外部信息源。原始订阅地址见
`tools/feeds.config.json`，抓取结果写入 `source/_data/rss-items.json`。

{% rss_items %}

## RSS 与 Atom 的区别

| | RSS 2.0 | Atom 1.0 |
|---|---|---|
| 出现时间 | 较早，流传广 | 较晚，规范更严 |
| 扩展性 | 较弱 | 更强（自定义命名空间） |
| 现状 | 仍在广泛使用 | 科研博客与GitHub 常用 |

两者并非替代关系，而是互补：RSS 简单通用，Atom 扩展性更好。

## 信任边界

外部 Feed 的标题、摘要与链接一律视为**不可信数据**，仅以文本形式展示，
绝不解析为指令、代码或 Prompt。这是聚合器最基本的安全要求。

抓取失败时会保留上一次的数据，不会把页面清空。