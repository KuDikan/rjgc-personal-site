---
title: 用 Hexo 与 ShokaX 搭建静态博客
date: 2026-10-07 21:00:00
tags:
  - Hexo
  - 静态站点
  - Cloudflare
categories:
  - 技术
description: 从零搭建一个 Hexo 站点并部署到 Cloudflare Workers 的完整记录，包含几个容易踩的坑。
---

搭这个站点时踩到了几个坑，记下来以免下次重踩。

## 坑一：主题的版本约束藏在 dependencies 里

ShokaX 的 `package.json` 里写着：

```json
"dependencies": {
  "hexo": "^7.3.0"
}
```

这意味着**不能装 Hexo 8**。而 `hexo@latest` 现在是 8.x，
按"装最新的"这个直觉走就会踩雷。

保险做法是双保险：

```json
{
  "devDependencies": {
    "hexo": "7.3.0"
  },
  "overrides": {
    "hexo": "7.3.0"
  }
}
```

`overrides` 会对整棵依赖树生效，从物理上杜绝 npm 嵌套出第二份 Hexo。

## 坑二：不要假设 npm 包已预构建

很多现代前端主题用 TypeScript 编写，发布前需要编译。
从 Git 装源码要跑编译命令，从 npm 装 tarball 则应该自带产物。

npm 出于安全策略**不会执行 registry 依赖的 `prepare`/`postinstall` 脚本**。
如果 tarball 恰好没带产物，你的 `hexo generate` 会报一堆看不懂的错误。

所以我加了一个前置断言脚本：

```text
[ok] hexo 7.3.0
[ok] 依赖树中只有一份 hexo
[ok] 主题版本 0.5.4
[ok] scripts/ 存在（7 个条目）
[ok] layout/ 存在（9 个条目）
```

安装完立刻跑，失败就fail fast。这比"生成出白屏再回头查"快一个数量级。

顺带一提，判断主题是否预构建**不要看 `package.json` 的 `main` 字段**——
ShokaX 声明了 `main: index.js` 但这个文件根本不存在，而主题运行完全正常。
Hexo 加载主题靠的是 `scripts/` 目录，不是 `main`。

## 坑三：minify 配置会让 CI 部署的产物坏掉

文档明确警告了两个配置项：

- `minify.html`：底层压缩器有已知 bug，可能产出错误的 HTML
- `minify.image`：会把图片 URL 改写成图片处理服务的地址，
  但 CI 构建时你的图片从未上传到那个服务 → **线上图片全部 404**

v1 的做法是全部关掉，等站点稳定后再一次开一个，每开一个就对产物做一次 diff。

## 坑四：本地能跑不代表 CI 能跑

Windows 文件系统大小写不敏感，Linux 敏感。主题里如果以大小写敏感的方式
`require('./Foo')`，本地一路绿灯，CI 直接挂。

还有换行符。Git Bash 配了 `core.autocrlf=true` 的话，
Markdown/EJS/YAML 都会是 CRLF，产物字节和 CI 不一样。

对策是 `.gitattributes` 全局 `eol=lf`，并且**以 CI 的首次构建为权威判据**。

## 部署：Workers 而不是 Pages

Cloudflare Pages 需要在控制台手动连 GitHub 仓库，无法脚本化。
Workers 可以全流程自动化：

```jsonc
{
  "name": "rjgc-personal-site",
  "compatibility_date": "2026-01-15",
  "assets": {
    "directory": "./public",
    "not_found_handling": "none",
    "html_handling": "auto-trailing-slash"
  }
}
```

两个细节：

- `not_found_handling` 千万别设成 `single-page-application`，
  那会把所有 404 都回退到 `index.html`，多页站点的链接会全部错乱
- `html_handling` 必须和 Hexo 的 `permalink` 匹配，否则全站 404

相关阅读：[[用 Git 记录 Agent 的改动]]