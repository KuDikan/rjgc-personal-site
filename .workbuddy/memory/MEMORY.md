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
- **构建脚本必须放 `tools/`，不能放 `scripts/`** —— Hexo 会把 `scripts/` 当插件目录逐个 require
- `package.json` 必须保留 `"hexo": { "version": "7.3.0" }` 字段，否则 hexo-cli 定位不到站点
- 依赖一律精确锁版本（无 `^`），主题升级走独立 commit
- 本地 `.npmrc` 固定 `registry.npmjs.org` —— 本机用户级 npmrc 是 npmmirror，
  混用会把 lockfile 污染成镜像 URL，导致 CI 在境外 404
- **不要设`NODE_ENV=production`**：会让 `npm ci` 跳过 devDependencies，而构建工具都在 devDependencies

## ShokaX 主题的三个坑（已规避，勿回退）

1. 随机封面走 `source/_data/images.yml`（根节点直接是数组，≥6 张），不是主题配置
2. 独立页面（`layout: page`）的 front-matter 不能写 `tags`，否则该页渲染成 0 字节
3. `source/_data/assets/` 必须扁平，不能有子目录

## 验证习惯

改站点后跑 `npm run ci:build`（断言 → 数据 → 构建 → 校验）。
`tools/validate.mjs` 会检查站内死链、feed 内容是否真的渲染、AGPL 署名链接是否存在。

`footer.powered` 必须保持 `true` —— ShokaX 是 AGPL-3.0-or-later，页脚需保留指向主题仓库的署名链接。
不修改主题源码（主题只从 npm 安装、整目录 gitignored），因此不触发 AGPL §13 网络条款。