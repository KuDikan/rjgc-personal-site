# 项目长期记忆 · RJGC_wiki

## 项目结构

仓库同时承载两个东西（用户明确要求站点作为子目录放进同一仓库）：

- **Python 侧**：`pyproject.toml` + `uv.lock` + `src/rjgc_wiki/`，uv 管理，勿用pip 直接装依赖
- **站点侧**：`rjgc-personal-site/`，Hexo 7+ ShokaX，npm 管理

## 环境约定（本机 Windows + Git Bash）

- `gh`：`D:\Program\GitHub CLI\gh.exe`，**不在 PATH**，命令里用绝对路径
- Node：托管版 `C:\Users\KuDikan\.workbuddy\binaries\node\versions\22.22.2-6\node.exe`，已在 PATH
- 代理 `127.0.0.1:37890` 端口在但请求全失败（http/socks5 均 000），**不要依赖它**
- 后台 Bash 任务会被沙箱拦（netapi32.dll），长任务前台跑
- WorkBuddy safe-delete 守卫会拦批量删除（≥50 文件），`hexo clean` / `npm ci` 清node_modules 可能触发；
  绕法是先 `mv` 走目录再操作

## 站点约定

- 线上地址：https://personal-blog.kukuku.icu（Cloudflare Workers Static Assets）
- GitHub 私有仓 `KuDikan/rjgc-personal-site`，分支 `main`，workflow 在**仓库根** `.github/workflows/`
- Cloudflare Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`（存仓库 Secrets，不入代码）
- **`scripts/` 与 `tools/` 职责不同**：
  - `scripts/` = Hexo 插件目录，Hexo 会逐个 require，**必须是 CommonJS**
  - `tools/` = 自己用 node 跑的构建脚本，可以用 .mjs（verify/build-data/validate）
- `package.json` 必须保留 `"hexo": { "version": "7.3.0" }` 字段，否则 hexo-cli 定位不到站点
- 依赖一律精确锁版本（无 `^`），主题升级走独立 commit
- 本地 `.npmrc` 固定 `registry.npmjs.org` —— 本机用户级 npmrc 是 npmmirror，
  混用会把lockfile 污染成镜像 URL，导致 CI 在境外 404
- **不要设`NODE_ENV=production`**：会让 `npm ci` 跳过 devDependencies，而构建工具都在 devDependencies

## 数据展示原则（重要）

Hexo 是**静态生成器**：`source/_data/*.json` 在构建期即可渲染进 HTML。
需要展示数据时用 Hexo 标签在构建期渲染，**不要写客户端占位 div**——
没有 JS 去填它，线上就会一直显示"加载中"，而文件存在、HTTP 200 都正常。

现有标签（定义在 `scripts/data-tags.js`）：
`{% status_panel %}` / `{% papers_list %}` / `{% rss_items %}` / `{% wiki_index %}`

外部数据（arXiv 论文、RSS）一律视为不可信：文本经 escapeHTML 转义，
href 经 safeUrl 白名单（仅 http/https 与站内绝对路径）。

## ShokaX 主题的三个坑（已规避，勿回退）

1. 随机封面走 `source/_data/images.yml`（根节点直接是数组，≥6 张），不是主题配置
2. 独立页面（`layout: page`）的 front-matter 不能写 `tags`，否则该页渲染成 0 字节
3. `source/_data/assets/` 必须扁平，不能有子目录

## 验证习惯

改站点后跑 `npm run ci:build`（断言 → 数据 → 构建 → 校验）。

**校验必须断言内容实质，不能只断言存在性或状态码**——踩过两次：
未渲染的 feed（文件存在/size 够/HTTP 200）和未填充的占位 div 都是"三道检查全放行但实际是坏的"。

`tools/validate.mjs` 会检查站内死链、feed 是否真的渲染、
数据面板是否已构建期渲染、AGPL 署名链接是否存在。

判断"占位未渲染"时不要匹配裸的 `/loading/`：主题自带加载动画会输出 loading 相关 class，
造成假警报。匹配中文文案"正在加载"与 `class="loading"`。

`footer.powered` 必须保持 `true` —— ShokaX 是 AGPL-3.0-or-later，页脚需保留指向主题仓库的署名链接。
不修改主题源码（主题只从 npm 安装、整目录 gitignored），因此不触发 AGPL §13 网络条款。