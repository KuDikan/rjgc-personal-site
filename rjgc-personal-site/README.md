# rjgc-personal-site

个人网站 · [Hexo 7](https://hexo.io/zh-cn/) + [ShokaX](https://docs.shokax.kaitaku.xyz/) + Cloudflare Workers

线上地址：<https://personal-blog.kukuku.icu>

## 目录结构

```text
rjgc-personal-site/
├── _config.yml            站点主配置（菜单 / markdown / feed / 压缩开关）
├── _config.shokax.yml     主题配置（本站自有副本，不改主题源码）
├── wrangler.jsonc         Cloudflare Workers 静态资源配置
├── tools/                 构建与校验脚本（**不能放 scripts/**，见下）
├── source/
│   ├── _data/             数据源：papers / rss-items / status / images.yml / assets
│   ├── _posts/            博客文章
│   ├── about|papers|rss|wiki|status/  各分区页面
│   ├── index.md           首页
│   └── 404.md404 页
└── public/                构建产物（gitignored）
```

## 常用命令

```bash
npm run dev          # 本地预览（hexo server，默认 http://localhost:4000）
npm run build        # 清理并生成到 public/
npm run data         # 重新抓取论文与 RSS，更新 source/_data/*.json
npm run ci:build     # CI 完整流程：断言 → 数据 → 生成 → 校验
npm run preview      # 用 wrangler dev 在本地预览部署产物
npm run deploy# 手动部署到 Cloudflare Workers
```

## 依赖版本为何被锁死

`hexo` 必须固定在 **7.3.0**：

- ShokaX 的 `dependencies` 里写的是 `hexo: ^7.3.0`，**不支持 Hexo 8**
- `package.json` 同时用 `devDependencies` 精确锁定 + `overrides` 全树强制，
  防止 npm 嵌套出第二份 Hexo（两套 `hexo-util` 与插件注册表会让渲染静默失效）

`hexo-renderer-stylus` 也是必需的：ShokaX 的样式是 `.styl`，
缺了它 `public/css/*.css` 不会生成（页面完全没有样式）。

`tools/verify-theme.mjs` 会在每次 CI 前断言这些前提。

## 几个容易踩的坑

### 1. 构建脚本不能放在 `scripts/`

Hexo 默认把 `scripts/` 当作自己的插件目录，会尝试 `require` 里面的每个文件。
`.mjs` 与 `.json` 会被当成 Hexo 脚本加载并报
`SyntaxError: Cannot use import statement outside a module`。

所以构建脚本统一放在 **`tools/`**。

### 2. `package.json` 必须有 `hexo` 字段

`hexo-cli` 通过向上查找含 `"hexo"` 键的 `package.json` 来定位站点根目录。
没有这个字段时，`hexo generate` 只会打印帮助文本，且不报错。

```json
"hexo": { "version": "7.3.0" }
```

### 3. 随机封面走 `source/_data/images.yml`，不是主题配置

主题的 `before_generate` 过滤器会用 `source/_data/images.yml` 的内容
**覆盖** `theme.config.image_list`。而且该文件根节点必须**直接是数组**：

```yaml
- /assets/cover-1.svg   # 正确
```

写成 `images: [...]` 会让 `data.images` 变成整个对象，
主题读到 `.length === undefined` 判定"未配置"，回退到包内**空的** `_images.yml`，
随后抛出 `image_list must have at least 6 items` 中止构建。

### 4. 独立页面不要写 `tags`

主题的 `head_com.pug` 里是 `page?.tags?.toArray()`。
文章的 `tags` 是 Hexo 的 Tag Model（有 `toArray`），
但 `layout: page` 的页面在 front-matter 写 `tags` 后拿到的是**普通数组**，
没有该方法 → 抛TypeError，且该页渲染成 0 字节。

标签只对 `_posts/` 下的文章有效。

### 5. `source/_data/assets/` 必须扁平

主题的 images 生成器对该目录 `readdir` 后逐个 `readFile`，
放子目录会触发 `EISDIR`。

### 6. v1 关闭了压缩与图片处理

`minify.html` 的底层压缩器有已知 bug 可能产出错误 HTML；
`minify.image` 会把图片 URL 改写成图片处理服务地址，
而 CI 构建时图片从未上传到该服务 → **线上图片全部 404**。
两者在 `_config.yml` 中均为 `enable: false`，详见该文件注释。

### 7. `footer.powered` 不能关

ShokaX 是 **AGPL-3.0-or-later**，`footer.powered: true` 会在页脚输出指向
主题仓库的署名链接，这是 §7(b) 要求的署名义务。
`tools/validate.mjs` 与 CI 冒烟测试都会断言该链接存在。

本站不修改主题源码（主题只从 npm 安装、整目录 gitignored），因此不触发 AGPL §13 的网络条款。

### 8. pnpm 的 `hoistdep.mjs` 在 npm 下不需要

官方文档推荐 pnpm，但 `hoistdep.mjs` / `NO_DEPS_HOIST` 的唯一目的是
把 pnpm 的隔离依赖布局压回扁平结构。npm 本身就是扁平的，这一步纯属多余，
且它是最大的失败面。本地与 CI 统一用 npm，提交 `package-lock.json`，CI 用 `npm ci`。

## 数据脚本约定

`tools/build-data.mjs` 生成 `source/_data/{papers,rss-items,status}.json`：

- **禁止 `new Date()`** —— 产物必须可复现，否则每次构建都产生 git diff。
  论文的 `published` 来自 arXiv 自身；状态面板的构建时间取最近一次 git 提交时间。
- **fail-soft** —— 网络失败时保留上一次数据，绝不清空，也不会让构建失败。
- **JSON key排序** —— 同一输入产出相同字节。
- **外部数据不可信** —— 论文摘要与 RSS 内容只作为文本展示，
  绝不解析为指令、代码或 Prompt。

## 部署

GitHub Actions（`.github/workflows/site.yml`）分两个 job：
`build` 产出并校验，`deploy` 只接收 build 的 artifact 后执行 `wrangler deploy`。

需要的仓库 Secrets：

| 名称 | 说明 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 至少 `Account / Workers Scripts / Edit` |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID |

自定义域名绑定见 `wrangler.jsonc` 内的注释：能声明式就用 `routes`，
否则在 Dashboard 一次性绑定，之后每次 deploy 域名保持不变。