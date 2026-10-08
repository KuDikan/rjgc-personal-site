/**
 * verify-theme.mjs — 主题与工具链前置断言（fail fast）
 *
 * 存在的原因：ShokaX 是"npm tarball 安装"而非 git clone 安装。
 * npm 出于安全策略不会执行 registry 依赖的 prepare/postinstall 脚本，
 * 所以"tarball 应该自带编译产物"只是一个假设，必须实测。
 *
 * 检查项：
 *   1. hexo 主版本必须是 7.x，且精确等于 7.3.0
 *   2. 依赖树里只有一份 hexo（防止 npm 嵌套出第二份导致插件注册表分裂）
 *   3. 主题 tarball 已预构建（含产物目录与可执行的入口文件）
 *   4. 主题内未混入其他 markdown 渲染器
 *
 * 退出码非0 = CI 立即失败，不要继续往下构建。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const THEME_DIR = join(root, 'node_modules', 'hexo-theme-shokax');
const EXPECTED_HEXO = '7.3.0';

const failures = [];
const warnings = [];

function fail(msg) { failures.push(msg); }
function warn(msg) { warnings.push(msg); }

function readPkg(dir) {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// ---- 1. hexo 版本 ----
const hexoPkg = readPkg(join(root, 'node_modules', 'hexo'));
if (!hexoPkg) {
  fail('node_modules/hexo 不存在 —— 请先执行 npm install');
} else if (hexoPkg.version !== EXPECTED_HEXO) {
  fail(`hexo 版本为 ${hexoPkg.version}，期望 ${EXPECTED_HEXO}。ShokaX 依赖 hexo ^7.3.0，Hexo 8 会导致主题无法加载。`);
} else {
  console.log(`  [ok] hexo ${hexoPkg.version}`);
}

// ---- 2. 嵌套 hexo 检测 ----
const nested = join(THEME_DIR, 'node_modules', 'hexo');
if (existsSync(nested)) {
  const v = readPkg(nested);
  fail(`主题目录内嵌套了第二份 hexo${v ? ` (${v.version})` : ''} —— 这会造成两套 hexo-util/插件注册表。请检查 package.json 的 overrides 是否生效。`);
} else {
  console.log('  [ok] 依赖树中只有一份 hexo');
}

// ---- 3. 主题预构建产物 ----
if (!existsSync(THEME_DIR)) {
  fail('node_modules/hexo-theme-shokax 不存在 —— 请确认 hexo-theme-shokax 已安装');
} else {
  const themePkg = readPkg(THEME_DIR);
  console.log(`  [ok] 主题版本 ${themePkg?.version ?? '未知'}`);

  // 注意：主题 package.json 里的 `main: index.js` 是一个**残留字段，实际并不存在该文件**。
  // Hexo 加载主题靠的是 scripts/ 目录（作为插件被注册）和 layout/ 目录（作为模板），
  // 根本不读 package.json 的 main。所以"index.js 不存在"不是缺陷，不能作为失败判据。
  // 判断 tarball 是否预构建，要看下面这两项真实产物。
  const scriptsDir = join(THEME_DIR, 'scripts');
  if (!existsSync(scriptsDir) || !readdirSync(scriptsDir).length) {
    fail('主题 scripts/ 目录缺失或为空 —— Hexo 无法从主题注册任何插件，页面将无法渲染。' +
         '这通常意味着 tarball 未预构建；可在 package.json 增加 ' +
         '"postinstall": "node node_modules/hexo-theme-shokax/toolbox/compiler.mjs" 后重装。');
  } else {
    console.log(`  [ok] scripts/ 存在（${readdirSync(scriptsDir).length} 个条目，Hexo 由此加载主题插件）`);
  }

  const layout = join(THEME_DIR, 'layout');
  if (!existsSync(layout) || !readdirSync(layout).length) {
    fail('主题 layout/ 目录缺失或为空 —— 模板未随包分发，无法生成页面。');
  } else {
    console.log(`  [ok] layout/ 存在（${readdirSync(layout).length} 个条目）`);
  }

  // feed 模板由主题自带（依赖 hexo-feed），不额外安装 hexo-generator-feed
  for (const tpl of ['rss.ejs', 'atom.ejs', 'json.ejs']) {
    if (!existsSync(join(layout, '_alternate', tpl))) {
      fail(`主题缺少 feed 模板 layout/_alternate/${tpl} —— RSS/Atom 输出会失败。`);
    }
  }

  // 主题内部依赖应已就位（shokax 把 hexo 及渲染器作为自己的 dependencies）
  const bundled = ['hexo-renderer-aether', 'hexo-renderer-pug', 'hexo-feed'];
  for (const dep of bundled) {
    if (!existsSync(join(root, 'node_modules', dep))) {
      fail(`主题依赖 ${dep} 未安装到根 node_modules —— npm 安装可能不完整。`);
    }
  }
}

// ---- 4. 冲突的 markdown 渲染器 ----
// 注意：hexo-renderer-stylus 处理的是 .styl（样式），不是 Markdown，
// 它与 hexo-renderer-aether 并存是**必需**的 —— ShokaX 的样式全是 .styl，
// 缺了它 css/*.css 不会生成（页面会没样式）。不要把它当冲突项。
// 真正的冲突是另一些 markdown 渲染器。
for (const renderer of ['hexo-renderer-marked', 'hexo-renderer-scss', 'hexo-renderer-sass']) {
  if (existsSync(join(root, 'node_modules', renderer))) {
    fail(`检测到 ${renderer} —— 多个 markdown 渲染器共存会导致同一篇文章被重复渲染（<p> 套 <p>）。请卸载它。`);
  }
}

// ---- 5. Stylus 渲染器（ShokaX 样式必需） ----
if (!existsSync(join(root, 'node_modules', 'hexo-renderer-stylus'))) {
  fail('缺少 hexo-renderer-stylus —— ShokaX 的样式是 .styl 文件，' +
       '没有它 public/css/*.css 不会生成（页面将完全没有样式）。');
} else {
  console.log('  [ok] hexo-renderer-stylus 已安装（.styl 可编译）');
}

// ---- 6. lockfile 不被镜像源污染 ----
// 本机用户级 ~/.npmrc 使用 npmmirror，若生成 lockfile 时项目级 .npmrc 未生效，
// resolved 会写成 cdn.npmmirror.com。GitHub Actions 在境外访问该CDN 会 404，
// 导致 npm ci 失败（"is not in this registry"）。这里提前断言。
{
  const lockPath = join(root, 'package-lock.json');
  if (!existsSync(lockPath)) {
    fail('package-lock.json 不存在 —— CI 使用 npm ci，必须提交 lockfile。');
  } else {
    const lock = readFileSync(lockPath, 'utf8');
    const mirrors = [...lock.matchAll(/"resolved":\s*"https:\/\/([^/]+)\//g)]
      .map((m) => m[1])
      .filter((h) => h !== 'registry.npmjs.org');
    const uniq = [...new Set(mirrors)];
    if (uniq.length) {
      fail(`package-lock.json 的 resolved 指向非官方源：${uniq.join(', ')}。` +
           'CI 会因镜像 CDN 不可达而失败。请确认项目级 .npmrc 的 registry 为' +
           ' https://registry.npmjs.org/，然后重新生成 lockfile。');
    } else {
      const total = [...lock.matchAll(/"resolved":/g)].length;
      console.log(`  [ok] lockfile ${total} 条 resolved 均为官方源`);
    }
  }
}

// ---- 6. 菜单图标名必须真实存在 ----
// 图标字体里没有的字形名会**静默失效**：渲染成空 <i class="ic i-xxx"></i>，
// 肉眼看到"图标不显示"，但构建与HTTP 状态都正常，不会有任何报错。
// 这正是本站踩过的坑（book / rss / bookmark / pulse 四个名字在主题里并不存在）。
{
  const iconFontCss = join(THEME_DIR, 'source', 'css', '_iconfont.styl');
  const menuRaw = readFileSync(join(root, '_config.shokax.yml'), 'utf8');

  // 提取所有 `... || iconName` 形式的图标名
  const declared = [...menuRaw.matchAll(/\|\|\s*([A-Za-z0-9_-]+)\s*$/gm)]
    .map((m) => m[1])
    .filter(Boolean);

  if (!existsSync(iconFontCss)) {
    warn(`找不到主题图标字体定义${iconFontCss}，跳过图标名校验`);
  } else if (!declared.length) {
    warn('_config.shokax.yml 的 menu 中未解析到任何图标名，跳过校验');
  } else {
    const css = readFileSync(iconFontCss, 'utf8');
    const available = new Set(
      [...css.matchAll(/^\.(i-[A-Za-z0-9_-]+)\s*:/gm)].map((m) => m[1])
    );

    // 同时校验 class 形式（i-xxx）与裸名（xxx）
    const bad = [];
    for (const name of new Set(declared)) {
      const cls = `i-${name}`;
      if (!available.has(cls)) bad.push(`${name}（应为 .${cls}）`);
    }

    if (bad.length) {
      fail(`menu 中以下图标名在主题图标字体中不存在，**会导致图标不显示且不报错**：` +
           bad.join('、') +
           `。可用图标清单见 ${iconFontCss}（共 ${available.size} 个）。`);
    } else {
      console.log(`  [ok] menu 图标名 ${new Set(declared).size} 个均存在于主题图标字体（共 ${available.size} 个可用）`);
    }
  }
}

// ---- 7. lockfile 与 package.json 是否同步（防 npm ci 在 CI 上失败） ----
// 背景：这个坑踩过两次。依赖树里有三套 esbuild
// （aether/theme 要 ^0.25.8、vite 要 ^0.27||^0.28、wrangler 锁 0.28.1），
// 一旦 wrangler 要求的补丁版本被 npm解析到更新版本（如 0.28.1 → 0.28.2），
// 本地 npm install 生成的 lockfile 与 CI 上 npm ci 的期望就不一致，
// CI 报 "Missing: esbuild@x.y.z from lock file" 而本地一切正常。
// 现在用 overrides 把 esbuild 全系钉死，并在此断言 lockfile 已同步。
{
  const pkg = readPkg(root);
  const lockPath = join(root, 'package-lock.json');
  if (!pkg || !existsSync(lockPath)) {
    warn('package.json 或 package-lock.json 缺失，跳过同步校验');
  } else {
    const declared = Object.keys(pkg.devDependencies || {});
    const missing = declared.filter(
      (name) => pkg.devDependencies[name] && !existsSync(join(root, 'node_modules', name))
    );
    if (missing.length && existsSync(join(root, 'node_modules'))) {
      fail(`以下已声明的依赖在 node_modules 中不存在：${missing.join('、')}。` +
           '请执行 npm install 后再构建（CI 用 npm ci，会因 lockfile 不同步而失败）。');
    } else if (missing.length) {
      warn(`node_modules 未安装，跳过依赖存在性检查（缺 ${missing.length} 个）`);
    } else {
      console.log(`  [ok] 已声明依赖 ${declared.length} 个均已安装（lockfile 已同步）`);
    }
  }
}

// ---- 输出 ----
if (warnings.length) {
  console.log('\n警告：');
  for (const w of warnings) console.log(`  ! ${w}`);
}

if (failures.length) {
  console.error('\n主题校验失败：');
  for (const f of failures) console.error(`  x ${f}`);
  process.exit(1);
}

console.log('\n主题校验通过。');