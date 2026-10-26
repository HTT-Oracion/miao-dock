#!/usr/bin/env node
/**
 * 「公共组件抽离到 src/components/units/」结构断言 —— 且必须**可反证**。
 *
 * 为什么需要它：
 *   把一批组件搬进 `units/` 这件事，验收标准不是「文件建好了」，而是三件互不覆盖的
 *   事实同时成立——少任何一件，抽离就只是「看起来干净」：
 *
 *     LAYOUT   清单齐、旧路径消失、桶文件能解析 —— 少一个文件，调用点在打包时才炸。
 *     PURITY   单元不得依赖业务数据层（store/ipc/types/platform/@hooks/nav）
 *              —— 这是「该不该放 units」的**唯一硬判据**，靠人自觉必然漏。
 *              import 说明符同时覆盖**相对路径与路径别名**（@components/@music/@/…）：
 *              引用全面别名化之后，只认相对路径的判据等于对一半的 import 失明。
 *     NAMING   类名迁移到 `ui-` 前缀、历史中性名（.btn/.badge/...）不被顺手改名
 *              —— 命名写错不报错，只在视觉上悄悄错位。
 *     CALLERS  调用点真的从 units 引、且原文件不再重复定义那些控件
 *              —— 定义还在、import 也补了，会出现"两个 Select"，编译能过、行为看运气。
 *     KEEP     **反向**断言：没抽过头 —— 音乐语义件/设置页排版件/应用级组件必须留下。
 *              只断言"该走的走了"，会奖励把所有东西都搬进 units 的过度抽离。
 *
 *   因此本脚本逐组断言，并配一次可反证的破坏轮：破坏后对应断言**必须变红**，否则
 *   它测的不是它声称的东西（D-31：假阳性比没测试更危险）。
 *
 * 用法：
 *   node e2e/units-structure-check.mjs            正向跑（期望 LAYOUT/PURITY/NAMING/CALLERS/KEEP/HOOKS/ALIAS/STATE 全绿）
 *   node e2e/units-structure-check.mjs --refute   反证轮（破坏源文件 → 断言必须变红 → 按字节恢复）
 *
 * 约束：纯 Node、零依赖；只读 `src/**`（--refute 轮临时破坏并保证按字节还原）。
 * 本脚本源码里刻意**不出现**任何被禁的历史品牌标识（需要提及时一律写「参考实现」）。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { readStyleSource } from './_styles-source.mjs';
import { cachedReadText, cachedReadBytes, overrideFile, clearOverrides } from './_file-cache.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = ROOT;
const SRC = path.join(APP, 'src');

const F = {
  units: path.join(SRC, 'components', 'units'),
  components: path.join(SRC, 'components'),
  app: path.join(SRC, 'App.tsx'),
  viteConfig: path.join(APP, 'vite.config.ts'),
  tsconfig: path.join(APP, 'tsconfig.json'),
  queueScreen: path.join(SRC, 'screens', 'manga', 'QueueScreen.tsx'),
  rightPanel: path.join(SRC, 'screens', 'music', 'RightPanel.tsx'),
  queueDrawer: path.join(SRC, 'screens', 'music', 'QueueDrawer.tsx'),
  // D-150：`sections.tsx` 已拆到 `sections/*.tsx`，本表见下方 CALLER_IMPORT_FILES。
  quitConfirm: path.join(SRC, 'components', 'QuitConfirm.tsx'),
  parts: path.join(SRC, 'screens', 'settings', 'parts.tsx'),
  shared: path.join(SRC, 'screens', 'music', 'shared.tsx'),
  loginModal: path.join(SRC, 'screens', 'music', 'LoginModal.tsx'),
  legacyAtoms: path.join(SRC, 'components', 'atoms.tsx'),
  legacyVirtualList: path.join(SRC, 'screens', 'music', 'VirtualList.tsx'),
  hooksDir: path.join(SRC, 'hooks'),
  hooksFile: path.join(SRC, 'hooks.ts'),
  hooksIndex: path.join(SRC, 'hooks', 'index.ts'),
  platformMenu: path.join(SRC, 'screens', 'music', 'PlatformMenu.tsx'),
  // ── 灵动岛（拍板第 4 项）
  island: path.join(SRC, 'components', 'DynamicIsland.tsx'),
  toastBus: path.join(SRC, 'stores', 'toastBus.ts'),
  musicToast: path.join(SRC, 'screens', 'music', 'Toast.tsx'),
  tooltip: path.join(SRC, 'components', 'units', 'Tooltip.tsx'),
  library: path.join(SRC, 'screens', 'manga', 'LibraryScreen.tsx'),
  // D-148：`LibraryScreen.tsx` 拆出「看图/对照」簇；ZOOM 组的锚点随之落到 viewer.tsx
  libraryViewer: path.join(SRC, 'screens', 'manga', 'viewer.tsx'),
  // 断言读到的 s.appCss 是全分片拼接（见下方 readStyleSource 调用处）；
  // 下面这个 musicScss **只给反证机制用**（按 file 路径临时改源文件）。
  // 灵动岛的样式在 music.scss 里（.di-capsule 等），故反证指向它。
  musicScss: path.join(SRC, 'styles', 'music.scss'),
  stylesDir: path.join(SRC, 'styles'),
  // B1 起屏由路由表维护，屏装配件的分派表是"哪一屏渲染哪个组件"的落点
  routerPanes: path.join(SRC, 'router', 'panes', 'index.tsx'),
};

// ── 冻结的契约（负责人冻结，本脚本照抄，不改口径） ────────────────────────
/** units 目录应恰有的 24 个文件（多一个/少一个都判红；useEsc 已迁 src/hooks，D-41）
 *  Tooltip / ContextMenu 是 2026-10-11 漫画右键菜单一并入册的可复用件（D-124）
 *  Modal 是 2026-10-11 收敛 5 处手写模态壳（D-143）
 *  ProgressRing 是 2026-10-14 引擎下载进度环（工具条/下载视图共用，D-150）
 *  SideDrawer 是 2026-10-22 ver3 设置页「运行日志」抽屉（右侧滑入的通用浮层，D-279）
 *  Segmented 是 2026-10-23 收敛设计稿 `.seg`（设置页两档选择 + 桌面歌词行数各写过一套，D-353） */
const MANIFEST = [
  'atoms.tsx',
  'Btn.tsx',
  'Skeleton.tsx',
  'ErrorState.tsx',
  'Select.tsx',
  'Segmented.tsx',
  'ViewTabs.tsx',
  'SideDrawer.tsx',
  'Switch.tsx',
  'Range.tsx',
  'Swatches.tsx',
  'ColorPicker.tsx',
  'IconButton.tsx',
  'MenuButton.tsx',
  'ContextMenu.tsx',
  'Modal.tsx',
  'Tooltip.tsx',
  'Notice.tsx',
  'PlayModeButton.tsx',
  'ProgressRing.tsx',
  'NumberInput.tsx',
  'Empty.tsx',
  'Mascot.tsx',
  'LogBlock.tsx',
  'OverlayScrollbar.tsx',
  'VirtualList.tsx',
  'index.ts',
];
/** 桶文件应统一出口的名字（useEsc 的出口在 @hooks/useEsc，不再经 units 桶） */
const BARREL_EXPORTS = [
  'Badge',
  'Btn',
  'ContextMenu',
  'Dot',
  'MagicCircle',
  'MenuSeparator',
  'Pill',
  'ColorPicker',
  'Empty',
  'IconButton',
  'LogBlock',
  'MenuButton',
  'MenuItem',
  'Modal',
  'Notice',
  'NumberInput',
  'ProgressRing',
  'Range',
  'Select',
  'SideDrawer',
  'Swatches',
  'Switch',
  'Tooltip',
  'ViewTabs',
  'ROW_GAP',
  'ROW_H',
  'VirtualList',
];
/** src/hooks/ 应恰有的文件（hooks 唯一收口，D-41） */
const HOOKS_MANIFEST = [
  'index.ts',
  'useEsc.ts',
  'useCoverColor.ts',
  'useMusicHotkeys.ts',
  'useDebouncedValue.ts',
  'useLibraryModel.ts',
  'useEngineDownload.ts',
  'useAnimePlayback.ts',
  'useNav.ts',
  'useAppVersion.ts',
  'useOverlayScrollbar.ts',
];
/** hooks/index.ts 业务桶应出口的业务 hook 名 */
const HOOKS_BARREL_EXPORTS = [
  'useService',
  'useTasks',
  'useLibrary',
  'useQuitRequest',
  'useToasts',
  'useEngineDownload',
  'useAnimePlayback',
  'useNav',
];
/** 允许被 units import 的裸包（其余裸包一律判红：新依赖需负责人确认） */
const PKG_ALLOW = [/^react(\/.+)?$/, /^react-dom(\/.+)?$/, /^lucide-react$/];
/** 允许的 scoped 包前缀 */
const PKG_ALLOW_SCOPE = ['@radix-ui/'];
/** 相对导入唯一允许"越出 units"的目标（themes/tokens 是设计令牌，纯数据）。
 *  对别名形式（`@/themes/tokens`）同样成立：正则只看"以 themes/tokens 结尾"。 */
const THEME_TOKENS_RE = /(^|\/)themes\/tokens(\.\w+)?$/;

/** 路径别名 → 真实目录（与 vite.config.ts、tsconfig.json **三处保持一致**）。
 *  前缀互不重叠（匹配要求「相等 或 前缀后紧跟 /」），'@tauri' 不会吃掉 '@tauri-apps/*' 包。 */
const ALIASES = {
  '@tauri': path.join(APP, 'src-tauri'),
  '@components': path.join(SRC, 'components'),
  '@screens': path.join(SRC, 'screens'),
  '@music': path.join(SRC, 'modules', 'music'),
  '@anime': path.join(SRC, 'modules', 'anime'),
  '@hooks': path.join(SRC, 'hooks'),
  '@': SRC,
};

/** 把 import 说明符解析为仓库内绝对路径；裸包（react、@radix-ui/…、@tauri-apps/…）返回 null */
function resolveSpec(baseDir, spec) {
  if (/^\.\.?(\/|$)/.test(spec)) return path.resolve(baseDir, spec);
  const keys = Object.keys(ALIASES).sort((a, b) => b.length - a.length); // 长前缀先试，防御性
  for (const k of keys) {
    if (spec === k) return ALIASES[k];
    if (spec.startsWith(k + '/')) return path.join(ALIASES[k], spec.slice(k.length + 1));
  }
  return null;
}

/** 调用点必须真的从 units 引 */
const CALLER_IMPORT_FILES = {
  'App.tsx': F.app,
  'screens/manga/QueueScreen.tsx': F.queueScreen,
  'screens/music/RightPanel.tsx': F.rightPanel,
  'screens/music/QueueDrawer.tsx': F.queueDrawer,
  // D-150：`sections.tsx` 已拆成 `sections/*.tsx` ⇒ 取其中引 units 最多的 TranslateSection 作代表
  // （`ResourceSection` / `AboutSection` 用 parts + 专用块，本就不引 units，不能一概而论）。
  'screens/settings/sections/TranslateSection.tsx': path.join(
    SRC,
    'screens',
    'settings',
    'sections',
    'TranslateSection.tsx',
  ),
  'components/QuitConfirm.tsx': F.quitConfirm,
};

// ── 读文件 ───────────────────────────────────────────────────────────────
const readMaybe = cachedReadText;
const readBytes = cachedReadBytes;
const listFiles = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
    : [];
/** 递归收集**全路径**（`listFiles` 只给一层文件名，扫断言语料要跨目录） */
const walkPaths = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walkPaths(p) : [p];
      })
    : [];

/**
 * 去掉 // 与 /\\* *\\/ 注释（带字符串状态机）——**必须在取字符串字面量/导入语句前先做**。
 *
 * 为什么要状态机而不是简单正则：units 文件的注释里就出现了带引号的片段，
 * 例如 Range.tsx 的注释写了 `` `.music-prog-bar` ``。若直接扫全文找 `music-`，
 * 注释会让 NAMING 断言在**完全合法**的源码上误红（这也是本类脚本最容易犯的假阳性）。
 */
function stripComments(src) {
  let out = '';
  let state = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '*') {
        state = 'block';
        out += '  ';
        i++;
        continue;
      }
      if (c === '/' && c2 === '/') {
        state = 'line';
        out += '  ';
        i++;
        continue;
      }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      out += c;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') {
        state = 'code';
        out += '  ';
        i++;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += '\n';
        continue;
      }
      out += ' ';
      continue;
    }
    // 字符串内：转义后整体保留
    if (c === '\\') {
      out += c + (c2 ?? '');
      i++;
      continue;
    }
    if (state === 'sq' && c === "'") state = 'code';
    else if (state === 'dq' && c === '"') state = 'code';
    else if (state === 'tpl' && c === '`') state = 'code';
    out += c;
  }
  return out;
}

/** 收集源码里全部字符串字面量的内容（注释已剔除，故不会误收注释里的引号片段） */
function stringLiterals(stripped) {
  const out = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const m of stripped.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** 把字符串字面量切成"类名样式"的 token（music-empty / ui-range-fill / btn …） */
function classTokens(stripped) {
  const set = new Set();
  for (const lit of stringLiterals(stripped)) {
    for (const m of lit.matchAll(/[A-Za-z_][A-Za-z0-9_-]*/g)) set.add(m[0]);
  }
  return set;
}

/** 收集源码里所有 `from '<spec>'` 与副作用 `import '<spec>'` 的模块说明符 */
function importSpecifiers(stripped) {
  const out = [];
  for (const m of stripped.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of stripped.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

/** 是否"声明"了某顶层名字（function/const/let/var/class）—— 与参数名/变量名解耦 */
function declaresName(stripped, name) {
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|const|let|var|class)\\s+${esc(name)}\\b`,
  );
  return re.test(stripped);
}

/** 是否"导出"了某顶层名字 */
function exportsName(stripped, name) {
  const re = new RegExp(`(?:^|\\n)\\s*export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${esc(name)}\\b`);
  // 桶文件允许 `export { x } from './x'` 这种**再导出**形态；只认 `export function` 会把它误判成缺件。
  const reexport = new RegExp(`(?:^|\\n)\\s*export\\s*(?:type\\s*)?\\{[^}]*\\b${esc(name)}\\b[^}]*\\}`);
  return re.test(stripped) || reexport.test(stripped);
}

const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 解析一个 import 说明符（相对或别名）是否命中真实文件 */
function resolvesToFile(baseDir, spec) {
  const p = resolveSpec(baseDir, spec);
  if (!p) return false;
  const cands = [p, `${p}.tsx`, `${p}.ts`, `${p}.jsx`, `${p}.js`, path.join(p, 'index.tsx'), path.join(p, 'index.ts')];
  return cands.some((c) => existsSync(c));
}

/** 某一 units 文件里出现的违规 import（越出 units 且非 themes/tokens，或非法裸包）。
 *  别名按 ALIASES 还原成真实路径后判定 —— 否则 '@music/store' 会被当成"未知裸包"，口径就错了。 */
function badImportsOf(absFile, text) {
  const stripped = stripComments(text);
  const dir = path.dirname(absFile);
  const bad = [];
  for (const spec of importSpecifiers(stripped)) {
    const resolved = resolveSpec(dir, spec);
    if (resolved != null) {
      const inside = resolved === F.units || resolved.startsWith(F.units + path.sep);
      if (!inside && !THEME_TOKENS_RE.test(spec)) bad.push(spec);
    } else {
      const ok = PKG_ALLOW.some((re) => re.test(spec)) || PKG_ALLOW_SAFE_SCOPE(spec);
      if (!ok) bad.push(spec);
    }
  }
  return bad;
}
const PKG_ALLOW_SAFE_SCOPE = (spec) => PKG_ALLOW_SCOPE.some((p) => spec.startsWith(p));

// ── 载入快照 ─────────────────────────────────────────────────────────────
function loadSources() {
  const s = {};
  s.unitsDirMissing = !existsSync(F.units);
  s.unitsFiles = listFiles(F.units); // 全量（含非 ts 文件，便于抓"改名残留"）
  s.units = new Map(); // 仅 .ts/.tsx → 注释已剥 + 原文
  for (const name of s.unitsFiles) {
    if (!/\.(ts|tsx)$/.test(name)) continue;
    const text = readMaybe(path.join(F.units, name));
    s.units.set(name, {
      raw: text,
      stripped: stripComments(text),
      abs: path.join(F.units, name),
    });
  }
  s.index = s.units.get('index.ts')?.raw ?? '';
  s.parts = readMaybe(F.parts);
  s.shared = readMaybe(F.shared);
  s.loginModal = readMaybe(F.loginModal);
  s.callers = Object.fromEntries(Object.entries(CALLER_IMPORT_FILES).map(([k, p]) => [k, readMaybe(p)]));
  s.componentsFiles = listFiles(F.components);
  s.legacyAtomsExists = existsSync(F.legacyAtoms);
  s.legacyVirtualListExists = existsSync(F.legacyVirtualList);
  // hooks 收口（D-41）：目录清单 + 旧单文件必须不存在 + 业务桶原文
  s.hooksDirFiles = listFiles(F.hooksDir);
  s.hooksFileExists = existsSync(F.hooksFile);
  s.hooksIndex = readMaybe(F.hooksIndex);
  s.platformMenu = readMaybe(F.platformMenu);
  // 灵动岛（拍板第 4 项）
  s.island = readMaybe(F.island);
  s.toastBus = readMaybe(F.toastBus);
  s.musicToast = readMaybe(F.musicToast);
  // 悬停提示（Tooltip 宽限期）
  s.tooltip = readMaybe(F.tooltip);
  // 屏装配件分派表（B1）
  s.routerPanes = readMaybe(F.routerPanes);
  // ZOOM：全屏看图缩放（Lightbox 在 viewer.tsx —— 屏本体已拆分，D-148）。
  // 判据读「屏本体 + `screens/manga/*.tsx`」的**拼接源码**，只关心"关键字在不在"。
  // 🔴 **逐文件单独 `stripComments` 再拼**：`stripComments` 是带状态机的（反引号 ≠ 字符串/正则
  //    字面量都可能让它跑偏，见 D-110）。直接拼原文再 strip，前一个文件的失同步会**污染**
  //    后一个文件（实测：viewer.tsx 的块注释因此没被剥掉 ⇒ ZOOM.wheelNonPassive 假阳性）。
  //    逐文件 strip 后每个文件都从 `code` 态起步，互不牵连；再 strip 一次是幂等的。
  // 🔴 投放/队列两屏搬进 manga 目录后**必须排除**：它们与看图缩放无关，拼进语料等于
  //    给关键字断言多开一个来源（关键词恰巧命中别的屏 = 假阳性）。排除后语料与搬迁前等价。
  const MANGA_DIR = path.join(SRC, 'screens', 'manga');
  const NON_LIBRARY_SCREENS = new Set(['DropScreen.tsx', 'QueueScreen.tsx']);
  s.library = [
    F.library,
    ...listFiles(MANGA_DIR)
      .filter((n) => n.endsWith('.tsx') && !NON_LIBRARY_SCREENS.has(n))
      .map((n) => path.join(MANGA_DIR, n)),
  ]
    .map((p) => stripComments(readMaybe(p)))
    .join('\n');
  // 全分片拼接（顺序 = index.scss 的 @use 顺序 = 层叠顺序）。
  // app.css 已按模块拆成六个分片，读单文件会集体变红（读不到 ≠ 真回归），故走拼接。
  s.appCss = readStyleSource(F.stylesDir);
  // STYLE（样式分层）：入口的 @use 声明 + 各分片剥注释后的代码 + 目录里实际存在的分片
  s.styleIndex = readMaybe(path.join(F.stylesDir, 'index.scss'));
  s.styleShards = listFiles(F.stylesDir)
    .filter((f) => f.endsWith('.scss') && f !== 'index.scss')
    .map((f) => f.replace(/\.scss$/, ''))
    .sort();
  s.styleShardCode = {};
  for (const f of listFiles(F.stylesDir).filter((f) => f.endsWith('.scss'))) {
    s.styleShardCode[f] = stripComments(readMaybe(path.join(F.stylesDir, f)));
  }
  // ALIAS（D-40）：两处别名声明 + 全 src 的"相对上跳"引用
  s.viteConfig = readMaybe(F.viteConfig);
  s.tsconfig = readMaybe(F.tsconfig);
  s.srcRelativeUp = [];
  // STATE（D-42）：全 src 的 React Context 用法
  s.srcReactContext = [];
  // ALIAS：误用 @tauri/… 别名的 import（前端不该 import src-tauri；多为把 @tauri-apps/* 写错）
  s.srcTauriAliasSpecs = [];
  // STATE：zustand 引用（证明状态库确实是 zustand，而不是"没 Context 也没 store"）
  s.srcZustandImports = [];
  // STATE：各域 store（`src/modules/<域>/store.ts`）—— 逐个都得引 zustand，
  // 只数"全仓有没有人引"会让"某个域换掉状态库"静默溜过去（反证 M 曾经就是假阳性）
  s.srcModuleStores = [];
  // HOOKS：全 src 里 use* 命名的文件若不在 hooks/ 内即违规（D-41）
  s.srcMisplacedHooks = [];
  // 需要全量扫描的三件事：旧位置深引 useEsc / 相对上跳引用 / React Context
  s.srcUnitsEscImports = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const rel = path.relative(ROOT, p);
        const st = stripComments(readMaybe(p));
        for (const spec of importSpecifiers(st)) {
          if (/units\/useEsc$/.test(spec)) s.srcUnitsEscImports.push(`${rel} → ${spec}`);
          // 相对上跳：'..' 或 '../...'。同目录 './x' 是允许的（见《09》§2.3.1）
          if (/^\.\.(\/|$)/.test(spec)) s.srcRelativeUp.push(`${rel} → ${spec}`);
          // 注意正则：'@tauri-apps/…' 不含 '@tauri/'，故不会误报（npm 包与别名必须区分开）
          if (/^@tauri\//.test(spec)) s.srcTauriAliasSpecs.push(`${rel} → ${spec}`);
          if (spec === 'zustand') s.srcZustandImports.push(rel);
        }
        // 每个域 store 都要单独点名：只统计"全仓有人引 zustand"会让单个域换库时全绿
        // （`rel` 是平台相关分隔符，Windows 上是反斜杠）
        if (/^src[\\/]modules[\\/][^\\/]+[\\/]store\.ts$/.test(rel)) s.srcModuleStores.push(rel);
        if (/\b(?:createContext|useContext)\s*\(/.test(st)) s.srcReactContext.push(rel);
        // use* 命名的文件必须住在 src/hooks/ 内（否则 D-41 只是句口号）
        if (/^use[A-Z]/.test(e.name) && path.basename(dir) !== 'hooks') s.srcMisplacedHooks.push(rel);
      }
    }
  };
  walk(SRC);
  return s;
}

// ── 断言表 ───────────────────────────────────────────────────────────────
const A = [];
const add = (id, group, run) => A.push({ id, group, run });

// ============================ LAYOUT ============================
add('LAYOUT.files', 'LAYOUT', (s) => {
  if (s.unitsDirMissing) return { ok: false, detail: `目录不存在：${path.relative(ROOT, F.units)}` };
  const got = new Set(s.unitsFiles);
  const want = new Set(MANIFEST);
  const missing = MANIFEST.filter((n) => !got.has(n));
  const extra = s.unitsFiles.filter((n) => !want.has(n));
  return {
    ok: missing.length === 0 && extra.length === 0,
    detail: [missing.length ? `缺件：${missing.join(', ')}` : '', extra.length ? `多余：${extra.join(', ')}` : '']
      .filter(Boolean)
      .join('；'),
  };
});

add('LAYOUT.barrelResolves', 'LAYOUT', (s) => {
  const idx = s.units.get('index.ts');
  if (!idx) return { ok: false, detail: 'units/index.ts 缺失，无法校验桶文件' };
  const specs = [...stripComments(idx.raw).matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const broken = specs.filter((sp) => !resolvesToFile(F.units, sp));
  return {
    ok: specs.length > 0 && broken.length === 0,
    detail: broken.length
      ? `桶文件指向不存在的模块：${broken.join(', ')}`
      : specs.length
        ? ''
        : '桶文件没有任何 re-export',
  };
});

add('LAYOUT.barrelExports', 'LAYOUT', (s) => {
  const idx = s.units.get('index.ts')?.raw ?? '';
  const named = [...stripComments(idx).matchAll(/export\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)]
    .map((m) => m[1])
    .join(',');
  const missing = BARREL_EXPORTS.filter((n) => !new RegExp(`\\b${esc(n)}\\b`).test(named));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `桶文件未出口：${missing.join(', ')}` : '',
  };
});

add('LAYOUT.legacyAbsent', 'LAYOUT', (s) => {
  const alive = [];
  if (s.legacyAtomsExists) alive.push('components/atoms.tsx');
  if (s.legacyVirtualListExists) alive.push('screens/music/VirtualList.tsx');
  return {
    ok: alive.length === 0,
    detail: alive.length ? `旧路径未删除（不保留兼容再导出）：${alive.join('、')}` : '',
  };
});

// ============================ PURITY ============================
add('PURITY.noBusinessImports', 'PURITY', (s) => {
  if (s.unitsDirMissing) return { ok: false, detail: 'units 目录不存在' };
  const offenders = [];
  for (const [name, u] of s.units) {
    const bad = badImportsOf(u.abs, u.raw);
    if (bad.length) offenders.push(`${name} → ${bad.join(', ')}`);
  }
  return {
    ok: offenders.length === 0,
    detail: offenders.length ? `units 文件 import 了业务数据层（硬判据）：${offenders.join('；')}` : '',
  };
});

// ============================ NAMING ============================
add('NAMING.noMusic', 'NAMING', (s) => {
  const hits = [];
  for (const [name, u] of s.units) {
    for (const t of classTokens(u.stripped)) if (t.startsWith('music-')) hits.push(`${name}:${t}`);
  }
  return {
    ok: hits.length === 0,
    detail: hits.length ? `units 类名仍带 music- 前缀：${hits.join(', ')}` : '',
  };
});

add('NAMING.noSet', 'NAMING', (s) => {
  const hits = [];
  for (const [name, u] of s.units) {
    for (const t of classTokens(u.stripped)) if (t.startsWith('set-')) hits.push(`${name}:${t}`);
  }
  return {
    ok: hits.length === 0,
    detail: hits.length ? `units 类名仍带 set- 前缀：${hits.join(', ')}` : '',
  };
});

add('NAMING.uiPrefix', 'NAMING', (s) => {
  const want = [
    'ui-select',
    'ui-select-menu',
    'ui-select-item',
    'ui-select-ico',
    'ui-select-ok',
    'ui-range',
    'ui-range-val',
    'ui-num',
    'ui-num-suffix',
    'ui-swatch',
    'ui-swatches',
    'ui-color',
    'ui-cbtn',
    'ui-empty',
    'ui-vlist',
    'ui-vlist-inner',
    'ui-vlist-item',
  ];
  const all = new Set();
  for (const [, u] of s.units) for (const t of classTokens(u.stripped)) all.add(t);
  const missing = want.filter((t) => !all.has(t));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `units 未出现约定的 ui- 类名：${missing.join(', ')}` : '',
  };
});

add('NAMING.neutralKept', 'NAMING', (s) => {
  const want = ['btn', 'badge', 'pill', 'dot', 'magic', 'switch'];
  const all = new Set();
  for (const [, u] of s.units) for (const t of classTokens(u.stripped)) all.add(t);
  const missing = want.filter((t) => !all.has(t));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `历史中性类名被改名/丢失：${missing.join(', ')}` : '',
  };
});

// ============================ CALLERS ============================
add('CALLERS.partsNoControls', 'CALLERS', (s) => {
  const st = stripComments(s.parts);
  const banned = ['Select', 'Range', 'Switch', 'Swatches', 'ColorPicker'];
  const still = banned.filter((n) => declaresName(st, n));
  return {
    ok: still.length === 0,
    detail: still.length ? `settings/parts.tsx 仍在定义控件：${still.join(', ')}` : '',
  };
});

add('CALLERS.sharedNoUnits', 'CALLERS', (s) => {
  const st = stripComments(s.shared);
  const banned = ['IconButton', 'Empty', 'useEsc'];
  const still = banned.filter((n) => declaresName(st, n));
  return {
    ok: still.length === 0,
    detail: still.length ? `music/shared.tsx 仍在定义 units 件：${still.join(', ')}` : '',
  };
});

add('CALLERS.importsUnits', 'CALLERS', (s) => {
  const missing = [];
  for (const [label, text] of Object.entries(s.callers)) {
    if (!/(?:from|import)\s+['"][^'"]*units['"]/.test(stripComments(text))) missing.push(label);
  }
  return {
    ok: missing.length === 0,
    detail: missing.length ? `这些调用点未从 units 引：${missing.join('、')}` : '',
  };
});

add('CALLERS.loginNoRawCbtn', 'CALLERS', (s) => {
  const has = s.loginModal.includes('music-cbtn');
  return {
    ok: !has,
    detail: has ? 'LoginModal.tsx 又出现绕过组件直接写的 music-cbtn 类名' : '',
  };
});

// ============================ KEEP（反向：没抽过头） ============================
add('KEEP.sharedExports', 'KEEP', (s) => {
  const st = stripComments(s.shared);
  const need = ['SongRow', 'Cover'];
  const missing = need.filter((n) => !exportsName(st, n));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `music/shared.tsx 丢了音乐语义件：${missing.join(', ')}（抽过头）` : '',
  };
});

add('KEEP.partsExports', 'KEEP', (s) => {
  const st = stripComments(s.parts);
  const need = ['Row', 'PendingRow'];
  const missing = need.filter((n) => !exportsName(st, n));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `settings/parts.tsx 丢了设置页排版件：${missing.join(', ')}（抽过头）` : '',
  };
});

add('KEEP.appComponents', 'KEEP', (s) => {
  const need = ['Sidebar.tsx', 'Toolbar.tsx', 'ViewTabs.tsx', 'QuitConfirm.tsx'];
  const missing = need.filter((n) => !s.componentsFiles.includes(n));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `components/ 丢了应用级组件：${missing.join(', ')}（不该进 units）` : '',
  };
});

// ============================ HOOKS（src/hooks 唯一收口，D-41） ============================
add('HOOKS.layout', 'HOOKS', (s) => {
  if (!existsSync(F.hooksDir)) return { ok: false, detail: 'src/hooks/ 目录不存在' };
  const got = new Set(s.hooksDirFiles);
  const want = new Set(HOOKS_MANIFEST);
  const missing = HOOKS_MANIFEST.filter((n) => !got.has(n));
  const extra = s.hooksDirFiles.filter((n) => !want.has(n));
  const legacy = s.hooksFileExists
    ? 'src/hooks.ts 旧单文件仍存在 —— 与 hooks/ 并存时 TS/Vite 的模块解析会静默二选一'
    : '';
  return {
    ok: missing.length === 0 && extra.length === 0 && !s.hooksFileExists,
    detail: [
      missing.length ? `缺件：${missing.join(', ')}` : '',
      extra.length ? `多余：${extra.join(', ')}` : '',
      legacy,
    ]
      .filter(Boolean)
      .join('；'),
  };
});

add('HOOKS.barrelExports', 'HOOKS', (s) => {
  const st = stripComments(s.hooksIndex);
  const missing = HOOKS_BARREL_EXPORTS.filter((n) => !exportsName(st, n));
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `hooks/index.ts 业务桶丢了 hook：${missing.join(', ')}（App.tsx 在 import，丢了编译才炸）`
      : '',
  };
});

add('HOOKS.callers', 'HOOKS', (s) => {
  const st = stripComments(s.platformMenu);
  const okImport = /from\s+['"]@hooks\/useEsc['"]/.test(st);
  const stale = s.srcUnitsEscImports;
  return {
    ok: okImport && stale.length === 0,
    detail: [
      okImport ? '' : 'PlatformMenu 未从 @hooks/useEsc 引 useEsc',
      stale.length ? `仍有文件从旧位置深引 useEsc：${stale.join('；')}` : '',
    ]
      .filter(Boolean)
      .join('；'),
  };
});

add('HOOKS.noMisplacedUse', 'HOOKS', (s) => {
  // 判据：文件名以 use + 大写字母开头的文件必须住在 src/hooks/ 内。
  // 这条是**补出来**的 —— 上一轮收口只迁了 useEsc，漏了 screens/music/useCoverColor.ts，
  // 而原有三条 HOOKS 断言只认"已迁移的那个"，对新长出来的 hook 完全失明。
  const bad = s.srcMisplacedHooks;
  return {
    ok: bad.length === 0,
    detail: bad.length
      ? `这些 use* 文件不在 src/hooks/ 内：${bad.join('、')}（D-41：use* 一律住 hooks，否则同一个概念会被两处持有）`
      : '',
  };
});

// ============================ ALIAS（路径别名与引用规范，D-40） ============================
/**
 * 从 `vite.config.ts` 抽别名键 —— 形如 `"@hooks": aliasPath("./src/hooks")`。
 *
 * 为什么用正则而不是 eval/import 配置：配置是 TS，脚本要零依赖、且不该执行构建配置。
 * 正则只认"键 + aliasPath(" 这一种写法 —— 换写法会让断言变红（提示同步脚本），
 * 这比"静默漏检"好：**断言宁可因为写法变化而红，也不要因为认不出而绿**。
 */
function viteAliasKeys(text) {
  return [
    ...new Set([...stripComments(text).matchAll(/["'](@[a-zA-Z0-9_-]*)["']\s*:\s*aliasPath\(/g)].map((m) => m[1])),
  ];
}

/** 从 `tsconfig.json` 的 compilerOptions.paths 抽键并归一化（`@x/*` 与 `@x` 是同一别名） */
function tsAliasKeys(text) {
  const block = text.match(/"paths"\s*:\s*\{([\s\S]*?)\n\s*\}/);
  if (!block) return [];
  return [...new Set([...block[1].matchAll(/["'](@[a-zA-Z0-9_/-]*)["']\s*:/g)].map((m) => m[1].replace(/\/\*$/, '')))];
}

/** 契约：六个别名（《09》§2.3.1） */
const ALIAS_KEYS = ['@', '@tauri', '@components', '@screens', '@music', '@anime', '@hooks'];

add('ALIAS.keysComplete', 'ALIAS', (s) => {
  const vite = viteAliasKeys(s.viteConfig);
  const ts = tsAliasKeys(s.tsconfig);
  const missV = ALIAS_KEYS.filter((k) => !vite.includes(k));
  const missT = ALIAS_KEYS.filter((k) => !ts.includes(k));
  return {
    ok: missV.length === 0 && missT.length === 0,
    detail: [
      missV.length ? `vite.config.ts 缺：${missV.join('、')}` : '',
      missT.length ? `tsconfig.json 缺：${missT.join('、')}` : '',
    ]
      .filter(Boolean)
      .join('；'),
  };
});

add('ALIAS.twoPlaceSync', 'ALIAS', (s) => {
  const vite = new Set(viteAliasKeys(s.viteConfig));
  const ts = new Set(tsAliasKeys(s.tsconfig));
  const onlyVite = [...vite].filter((k) => !ts.has(k));
  const onlyTs = [...ts].filter((k) => !vite.has(k));
  return {
    ok: onlyVite.length === 0 && onlyTs.length === 0,
    detail:
      onlyVite.length || onlyTs.length
        ? `两处不同步 —— 仅 vite 有：${onlyVite.join('、') || '无'}；仅 tsconfig 有：${onlyTs.join('、') || '无'}（少改一处是**静默漂移**：dev 能跑 build 报错，或编辑器报红但能跑）`
        : '',
  };
});

add('ALIAS.subPathMaps', 'ALIAS', (s) => {
  /*
   * 每个别名在 tsconfig 里必须**同时**声明 `@x` 与 `@x/*` 两条：
   * 只有精确项 → `@music/store` 解析不到；只有通配项 → 裸 `@music` 解析不到。
   * 缺哪条都要等某处 import 恰好踩中才暴露，故静态断死。
   *
   * 这条是**反证轮逼出来的**：原本设计的破坏是"删 tsconfig 的 `@music/*` 一行"，
   * 结果两条断言都没红 —— 因为 `@music` 精确项还在，别名确实仍存在。
   * 那次"假阳性"不是断言错，而是**破坏没做到位**；但它顺带暴露了真实缺口：
   * 只删通配项这种**配置退化**当时无人拦（要等 tsc 才炸）。于是补上本条。
   *
   * ⚠️ vite 侧不需要对应断言：vite 的 alias 是**前缀匹配**，天然覆盖子路径；
   * 而 TS 的 `paths` 是**逐条精确匹配**，必须两条都写。这个差异是别名最容易踩的坑。
   */
  const block = s.tsconfig.match(/"paths"\s*:\s*\{([\s\S]*?)\n\s*\}/);
  if (!block) return { ok: false, detail: 'tsconfig.json 里找不到 compilerOptions.paths' };
  const hits = [...block[1].matchAll(/["'](@[a-zA-Z0-9_-]*)(\/\*)?["']\s*:/g)];
  const exact = new Set(hits.filter((m) => !m[2]).map((m) => m[1]));
  const wild = new Set(hits.filter((m) => m[2]).map((m) => m[1]));
  const missing = ALIAS_KEYS.filter((k) => !exact.has(k) || !wild.has(k));
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `这些别名在 tsconfig 里缺项：${missing
          .map((k) => `${k}${exact.has(k) ? '' : '（缺精确项）'}${wild.has(k) ? '' : '（缺 @${k.slice(1)}/* 通配项）'}`)
          .join('、')} —— 缺哪一侧，那一类 import 就解析不到`
      : '',
  };
});

add('ALIAS.noRelativeUp', 'ALIAS', (s) => {
  const bad = s.srcRelativeUp;
  return {
    ok: bad.length === 0,
    detail: bad.length
      ? `src 内仍有相对上跳引用（应写别名；同目录 './' 允许）：${bad.slice(0, 5).join('；')}${bad.length > 5 ? ` …共 ${bad.length} 处` : ''}`
      : '',
  };
});

add('ALIAS.pkgNotShadowed', 'ALIAS', (s) => {
  // 别名 `@tauri`（→ src-tauri，预留）与 npm 包 `@tauri-apps/*` 字形极近。
  // 判据刻意不用"包引用数 > 0"：那种只数总量，单个文件被改错时测不出来。
  // 改为——**前端不得出现 `@tauri/…` 的 import**：它要么是把 `@tauri-apps/api/core`
  // 误写成 `@tauri/api/core`，要么是前端越界 import Rust 目录，两种都是错的。
  const bad = s.srcTauriAliasSpecs;
  return {
    ok: bad.length === 0,
    detail: bad.length
      ? `前端出现了 @tauri/… 的 import：${bad.join('；')} —— 别名 @tauri 指向 src-tauri（前端不该 import 它）；是不是把 npm 包 @tauri-apps/* 写错了？`
      : '',
  };
});

// ============================ STATE（状态管理统一 zustand，D-42） ============================
add('STATE.noReactContext', 'STATE', (s) => {
  const bad = s.srcReactContext;
  return {
    ok: bad.length === 0,
    detail: bad.length
      ? `这些文件用了 React Context：${bad.join('、')} —— 跨组件共享状态一律 zustand（Context 里的 state 在 provider 之外读不到，而播放内核/IPC 回调都在组件树外改状态）`
      : '',
  };
});

add('STATE.zustandInUse', 'STATE', (s) => {
  // 反向兜底：只断言"没有 Context"是不够的 —— 把某个域的 store 换成别的东西（或删掉）
  // 也会让上一条变绿，而"统一 zustand"这条规则在那个域其实已经不成立。
  // 判据落在**每个域 store** 上：只数全仓"有没有人引 zustand"，删掉一个域照样全绿。
  const missing = s.srcModuleStores.filter((rel) => !s.srcZustandImports.includes(rel));
  return {
    ok: s.srcZustandImports.length > 0 && s.srcModuleStores.length > 0 && missing.length === 0,
    detail: missing.length
      ? `这些域 store 没引 zustand：${missing.join('、')}`
      : s.srcModuleStores.length
        ? ''
        : '一个 modules/*/store.ts 都没扫到 —— 判据本身失效',
  };
});

// ============================ ROUTER（B1：屏装配件分派表）============================
// B1 起"哪一屏渲染哪个组件"由 `router/panes/index.tsx` 的 SCREEN_PANES 决定。
// 要防的是**静默退化**：把某一屏从表里摘掉、或换成空组件，`tsc` 不会报
// （Record 的键仍是穷尽的，值仍是合法组件），而那一屏从此消失且没有任何门会响。
add('ROUTER.panesWired', 'ROUTER', (s) => {
  const src = stripComments(s.routerPanes ?? '');
  const missing = [];
  if (!/translate:\s*TranslatePane,/.test(src)) missing.push('translate 没有指向 TranslatePane');
  if (!/music:\s*MusicPane,/.test(src)) missing.push('music 没有指向 MusicPane');
  if (!/settings:\s*SettingsPane,/.test(src)) missing.push('settings 没有指向 SettingsPane');
  if (!/const Pane = SCREEN_PANES\[pane\];/.test(src)) missing.push('ScreenPane 没有按 pane 取组件');
  if (!/return <Pane \/>;/.test(src)) missing.push('ScreenPane 没有渲染取到的组件');
  return {
    ok: missing.length === 0,
    detail: missing.length ? `屏装配件分派表不全：${missing.join('、')}` : '',
  };
});

// ============================ ISLAND（灵动岛 · 拍板第 4 项）============================
// 灵动岛要防的是「两套提示并存」与「退场动画时长两处不一致」——
// 两者都不报错，只是用户看到同一条提示出现两次或胶囊突然消失。
/** App.tsx 原文（多处断言要用，故提到组级作用域） */
const appSourceOf = (s) => stripComments(s.callers['App.tsx'] ?? '');

add('ISLAND.mountedAtRoot', 'ISLAND', (s) => {
  if (!s.island) return { ok: false, detail: 'components/DynamicIsland.tsx 不存在' };
  const appSrc = appSourceOf(s);
  // ⚠️ 必须判「**真的渲染了**」，不能只判「出现过 DynamicIsland」——
  // 只判字面量时，删掉 JSX 节点但留着 import 行仍为真（反证轮实测假阳性）。
  // 判据取 JSX 自闭合标签形态 `<DynamicIsland` + `/>`。
  if (!/<DynamicIsland\s*\/>/.test(appSrc))
    return { ok: false, detail: 'App.tsx 未真正渲染 <DynamicIsland />（可能只剩 import）' };
  return { ok: true, detail: '' };
});
add('ISLAND.singleSource', 'ISLAND', (s) => {
  // ⚠️ 本条是本组最关键的一条：原先 App 与 MusicScreen 各有一份 toast 队列
  //（useState 每次调用各得一份），灵动岛只订阅其中一份 → 另一份推的提示永远收不到。
  // 反过来若两处都自己渲染，同一条提示会**出现两次**。
  if (!s.toastBus) return { ok: false, detail: 'src/stores/toastBus.ts 不存在' };
  const bus = stripComments(s.toastBus);
  const hooks = stripComments(s.hooksIndex);
  const missing = [];
  if (!/toastBus/.test(hooks)) missing.push('hooks/useToasts 未转发到 toastBus');
  // 旧的两处渲染层必须都已撤掉
  if (/className="toasts"/.test(appSourceOf(s))) missing.push('App 仍在渲染 .toasts（旧层未撤）');
  if (/<div className=\{musicToast/.test(stripComments(s.musicToast ?? '')))
    missing.push('music/Toast 仍在自己渲染（会与灵动岛重复）');
  // 反向兜底：总线必须真的只有一个队列实现（防止有人另起一套 state 又忘了接）。
  // ⚠️ 判据不锁 `const`/`let` —— 单例队列需要**可变**绑定，写成 `const queue` 会在
  // 合法实现（`let queue`）上误红。与变量声明形式解耦，只认"有队列 + 有订阅"。
  if (!/\bqueue\b\s*(:|=)/.test(bus) || !/\bsubscribe\b/.test(bus))
    missing.push('toastBus 不是单例队列实现（缺少队列或 subscribe）');
  return { ok: missing.length === 0, detail: missing.length ? `吐司单一事实源：${missing.join('、')}` : '' };
});
add('ISLAND.musicToastForwards', 'ISLAND', (s) => {
  // 音乐屏那套必须**转发**并清空源 store，否则同一条被灵动岛与它各渲染一次
  if (!s.musicToast) return { ok: false, detail: 'screens/music/Toast.tsx 不存在' };
  const t = stripComments(s.musicToast);
  const missing = [];
  if (!/toastBus/.test(t)) missing.push('未转发到 toastBus');
  if (!/clearToast/.test(t)) missing.push('转发后未清空 musicToast（会重复渲染）');
  if (/<div/.test(t)) missing.push('仍在渲染 DOM');
  return { ok: missing.length === 0, detail: missing.length ? `music/Toast 转发：${missing.join('、')}` : '' };
});
add('ISLAND.morphDurationSync', 'ISLAND', (s) => {
  // 形变时长两处必须一致：CSS 的 .di-capsule width 0.32s ↔ TS 的 MORPH_MS 320。
  // 慢的没走完快的那段就开始 → 胶囊在动画半途被内联宽高"瞬移"。
  // （2026-10-11 起岛不再承载轻提示、没有"退场"了，原来对 0.26s ↔ requestClose
  //   的比对随退场机制一起退役，改为守形变时长。）
  const css = stripComments(s.appCss ?? '');
  const ts = stripComments(s.island ?? '');
  // ⚠️ 时长写在 **.di-capsule 的 transition 简写里**，要从 .di-capsule 上取 width 那段。
  const mCss = css.match(/\.di-capsule\s*\{[^}]*?width\s+([\d.]+)s/);
  const mTs = ts.match(/const MORPH_MS = (\d+);/);
  if (!mCss) return { ok: false, detail: '样式里找不到 .di-capsule 的 width transition 时长' };
  if (!mTs) return { ok: false, detail: 'DynamicIsland.tsx 找不到 MORPH_MS' };
  const cssMs = Math.round(parseFloat(mCss[1]) * 1000);
  const tsMs = Number(mTs[1]);
  return {
    ok: cssMs === tsMs,
    detail: cssMs === tsMs ? '' : `形变时长不一致：CSS ${mCss[1]}s(${cssMs}ms) ↔ TS ${tsMs}ms`,
  };
});
add('ISLAND.idleRendersNothing', 'ISLAND', (s) => {
  // 无播放中的歌时**不占位** —— 空气里挂个空胶囊比不显示更怪
  //（2026-10-11 起岛上只有音乐播放态：轻提示已剥离给 NotificationStack）
  if (!s.island) return { ok: false, detail: 'DynamicIsland.tsx 不存在' };
  const isl = stripComments(s.island);
  if (!/if \(!hasQueue\) return null/.test(isl)) return { ok: false, detail: '空闲态未早退（会一直挂着一个空胶囊）' };
  return { ok: true, detail: '' };
});
add('ISLAND.noToastChannel', 'ISLAND', (s) => {
  // 2026-10-11 改版：轻提示的**唯一**渲染层是 components/NotificationStack.tsx（topRight）。
  // 灵动岛若再接回 toastBus（哪怕只是 import 后没用），同一队列就有两个渲染层 ——
  // 同一条提示既出现在右上角、又出现在岛顶，用户会以为按了两次（与 .toasts 时代同病）。
  if (!s.island) return { ok: false, detail: 'DynamicIsland.tsx 不存在' };
  const isl = stripComments(s.island);
  const hits = [];
  if (/toastBus|useToastList|useToastsFromBus|BusToast|ToastKind/.test(isl))
    hits.push('DynamicIsland 仍引用 toastBus 通道');
  // 岛上只剩音乐播放态：类名必须是 is-music（is-toast 的 CSS 已随提示一起退役）
  if (!/is-music/.test(isl)) hits.push('岛未按音乐态渲染（缺 is-music）');
  return { ok: hits.length === 0, detail: hits.join('；') };
});

// ============================ TOOLTIP（悬停提示 · 宽限期）============================
// 守「hover 到气泡上气泡先没了」（用户 2026-10-11 报）：气泡悬在宿主上方 6px，
// 指针从宿主挪进气泡必然先触发宿主 mouseleave —— 立即收就永远追不上。
// 宿主离开必须走宽限期 scheduleHide，气泡 mouseEnter 取消之（Tooltip.tsx 的 GRACE_MS）。
add('TOOLTIP.graceHide', 'TOOLTIP', (s) => {
  if (!s.tooltip) return { ok: false, detail: 'units/Tooltip.tsx 不存在' };
  const t = stripComments(s.tooltip);
  const missing = [];
  if (!/onMouseLeave=\{scheduleHide\}/.test(t)) missing.push('宿主离开不是宽限期（立即收）');
  if (!/onBlur=\{scheduleHide\}/.test(t)) missing.push('聚焦离开不是宽限期');
  if (!/GRACE_MS/.test(t)) missing.push('没有宽限期常量');
  if (!/onMouseEnter=\{keep\}/.test(t)) missing.push('气泡进入没有取消收起');
  return { ok: missing.length === 0, detail: missing.join('；') };
});

// ============================ ZOOM（全屏看图缩放）============================
// 缩放这一块的六条约束，每条都对应一个"看起来实现了、其实没生效"的坑：
//
//   PASSIVE   wheel 必须**非 passive** 手动挂。React 的 onWheel 是被动的，
//             在里面 preventDefault 无效 ⇒ 页面跟着滚、Mac 上可能被当成页面缩放。
//   DIRECTION 滚轮**向上**必须是放大（因子取 `1 - deltaY·k`）。写成加号方向就反了，
//             图能缩能放、类型也过 ⇒ 只有源码钉子拦得住（2026-10-08 用户实测报出来的）。
//   ANCHOR    必须**锚点缩放**（以光标为原点）。改成"总是归零/以中心缩放"手感立刻变差，
//             但代码照样跑、类型照样过 ⇒ 只有源码钉子拦得住。
//   FALLBACK  必须存在**不依赖手势**的 −/+ 按钮。macOS 触控板捏合被 WebKit 自己吃成
//             页面缩放、事件根本到不了 JS，而 wry 的 macOS 后端没接 zoom_hotkeys_enabled
//             ⇒ 没有按钮就等于 mac 上完全没法缩放。
//   FIT       开图必须「整张可见」：默认落在 ZOOM_FIT，且容器 flex 居中 + `img{max-*:100%}`。
//             实测 `grid + place-items` 会让百分比 max-height 失效 ⇒ 图溢出被裁。
//   TWOFINGER 裸滚轮只在**溢出态（> 100%）**才平移。≤100% 也平移 ⇒ 用户滚轮"失灵"。
//
// 判据一律先 stripComments：本组多条在注释里主动写出了反面写法
// （`onWheel`、`passive`、捏合被吃等），不剥注释会恒红或恒绿 —— 两种都是假信号。
add('ZOOM.wheelNonPassive', 'ZOOM', (s) => {
  if (!s.library) return { ok: false, detail: 'screens/manga/LibraryScreen.tsx 不存在' };
  const lib = stripComments(s.library);
  const missing = [];
  if (!/addEventListener\('wheel'/.test(lib))
    missing.push("没有手动 addEventListener('wheel')（说明靠 React onWheel，被动）");
  if (!/passive:\s*false/.test(lib)) missing.push('wheel 监听未声明 passive: false（preventDefault 无效）');
  if (!/removeEventListener\('wheel'/.test(lib)) missing.push('wheel 监听没有对称的 removeEventListener（卸载泄漏）');
  // 反向：不能同时挂一个 React onWheel 干同样的事，否则一次滚轮被处理两遍
  if (/onWheel=/.test(lib)) missing.push('同时挂了 React onWheel（会与手动监听重复处理）');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

add('ZOOM.anchorZoom', 'ZOOM', (s) => {
  if (!s.library) return { ok: false, detail: 'screens/manga/LibraryScreen.tsx 不存在' };
  const lib = stripComments(s.library);
  const from = lib.indexOf('const zoomAt = (');
  const to = lib.indexOf('useEffect', from);
  const seg = from >= 0 && to > from ? lib.slice(from, to) : '';
  if (!seg) return { ok: false, detail: '未定位到 zoomAt 段' };
  const missing = [];
  // 锚点算式必须在：用 stage（未变换容器）的矩形取光标相对中心的位置
  if (!/stageRef\.current/.test(seg)) missing.push('zoomAt 未经 stageRef 取舞台元素');
  if (!/getBoundingClientRect/.test(seg)) missing.push('zoomAt 未量光标位置（退化成中心缩放）');
  // 偏移必须按比例换算，而不是直接重置
  if (!/\(ax\s*-\s*cur\.offset\.x\)\s*\*/.test(seg)) missing.push("偏移未按 s'/s 比例换算（未做锚点缩放）");
  // ⚠️ 反向：缩到「恰好铺满」及以内（≤ ZOOM_FIT）没有可平移的余量，必须归位居中。
  //    少了这条，从放大态缩回 ≤100% 时旧偏移会把图顶出画面（"图歪在一边 / 跑没了"）。
  //    它同时兜住另一种退化：把归位写成**无条件**（连放大态也每次归零 ⇒ 退回中心缩放）。
  if (!/next\s*<=\s*ZOOM_FIT/.test(seg))
    missing.push('未在缩到「恰好铺满」及以内（≤ ZOOM_FIT）时归位（旧偏移会把图推出画面）');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

add('ZOOM.buttonFallback', 'ZOOM', (s) => {
  if (!s.library) return { ok: false, detail: 'screens/manga/LibraryScreen.tsx 不存在' };
  const lib = stripComments(s.library);
  const missing = [];
  if (!/className="lightbox-zoom-btn"/.test(lib))
    missing.push('工具栏没有 .lightbox-zoom-btn（缺不依赖手势的缩放入口）');
  // 无障碍名两种写法都成立：裸 `aria-label` 与走 `Btn` 单元的 `ariaLabel`
  // （单元内部落成同一个 aria 属性，判据看的是"有没有这个名字"）
  if (!/aria-label="放大"|ariaLabel="放大"/.test(lib)) missing.push('缺「放大」按钮');
  if (!/aria-label="缩小"|ariaLabel="缩小"/.test(lib)) missing.push('缺「缩小」按钮');
  // 按钮必须真的调了缩放，而不是摆在那儿
  if (!/stepZoom/.test(lib)) missing.push('按钮没有接缩放逻辑 stepZoom');
  // 样式也得**齐**：只查「有 .lightbox-zoom-btn」会让「只有基础块、悬停/禁用态全缺」
  // 也能过关，而那正是"按钮裸奔"的样子 ⇒ 判据必须与它声称的内容一致
  //（反证轮实测：只查类名时，把 :hover 规则改名的变异不会变红 —— 假阳性）。
  const css = stripComments(s.appCss ?? '');
  if (!/\.lightbox-zoom-btn\b/.test(css)) missing.push('manga.scss 里没有 .lightbox-zoom-btn 样式');
  // ⚠️ 伪类后必须带 `(?![\w-])` 负向后瞻：否则把规则改成 `:hover-x` 时，
  //    `.lightbox-zoom-btn:hover-x` 仍**包含** `.lightbox-zoom-btn:hover` 子串 ⇒ 假绿。
  if (!/\.lightbox-zoom-btn:hover(?![\w-])/.test(css)) missing.push('缩放按钮没有悬停态样式');
  if (!/\.lightbox-zoom-btn:disabled(?![\w-])/.test(css))
    missing.push('缩放按钮没有禁用态样式（到顶/到底会显得仍可点）');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

add('ZOOM.twoFingerPan', 'ZOOM', (s) => {
  if (!s.library) return { ok: false, detail: 'screens/manga/LibraryScreen.tsx 不存在' };
  const lib = stripComments(s.library);
  // ⚠️ 段首锚点必须在 `addEventListener('wheel'` **之前** —— 裸滚轮平移的分支写在
  //    onWheel 函数体里（注册语句在函数之后），从注册语句起算会把要判的代码切掉。
  const from = lib.indexOf('const onWheel = (e: WheelEvent)');
  // ⚠️ 段尾锚点必须落在**代码**上，不能用注释（本函数已 stripComments，
  //    拿注释当段尾会永远找不到 ⇒ 恒红。这正是「着力点撞上注释 ⇒ 假红」）。
  const to = lib.indexOf("addEventListener('wheel'", from);
  const seg = from >= 0 && to > from ? lib.slice(from, to) : '';
  if (!seg) return { ok: false, detail: '未定位到 wheel 监听段' };
  const missing = [];
  // 必须有「溢出才平移」的门控：≤100%（恰好铺满及以内）没有可平移余量，
  // 此时若吞掉裸滚轮，用户会觉得滚轮失灵。
  if (!/zoom\s*>\s*ZOOM_FIT/.test(seg)) missing.push('裸滚轮平移未门控在溢出态（≤100% 时滚轮会失灵）');
  if (!/preventDefault/.test(seg)) missing.push('平移未 preventDefault（页面会跟着滚）');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

// DIRECTION —— 滚轮**向上**必须是放大。
// 取 `1 - deltaY·k`；写成 `1 + deltaY·k` 方向就反了。图能缩能放、类型也过，
// 只有源码钉子拦得住 —— 2026-10-08 就是用户报「ctrl+↓ 才是放大」才发现写反的。
add('ZOOM.wheelDirection', 'ZOOM', (s) => {
  if (!s.library) return { ok: false, detail: 'screens/manga/LibraryScreen.tsx 不存在' };
  const lib = stripComments(s.library);
  const from = lib.indexOf('const onWheel = (e: WheelEvent)');
  const to = lib.indexOf("addEventListener('wheel'", from);
  const seg = from >= 0 && to > from ? lib.slice(from, to) : '';
  if (!seg) return { ok: false, detail: '未定位到 wheel 监听段' };
  const missing = [];
  // 正向：缩放因子 = 1 - deltaY·k（减号）⇒ 向上滚（deltaY<0）为放大
  if (!/1\s*-\s*e\.deltaY\s*\*\s*ZOOM_WHEEL_K/.test(seg))
    missing.push('滚轮缩放因子不是 1 - deltaY·k（向上滚不为放大）');
  // ⚠️ 反向：不许出现加号形态（那就是方向反了）
  if (/1\s*\+\s*e\.deltaY\s*\*\s*ZOOM_WHEEL_K/.test(seg))
    missing.push('滚轮用了 1 + deltaY·k（方向反了：向上滚反而缩小）');
  return { ok: missing.length === 0, detail: missing.length ? missing.join('、') : '' };
});

// FIT —— 打开全屏即「整张可见、不需要滚动」。
//
// 这条守的是一个**实测出来的**坑（2026-10-08，无头 Chrome 量过，见 D-91）：
//   `.lightbox-stage` 用 `grid + place-items:center` 时，grid 的单条 auto 轨道会按**内容**
//   （图的原始尺寸）撑开，而百分比 `max-height:100%` 正是对着这条轨道算的 ⇒ 约束等于没生效
//   ⇒ 舞台 347×352、图被渲染成 345×517，纵向溢出 165px 并被 `overflow:hidden` 裁掉。
//   换 flex 居中后是 233×350 —— 恰好铺满。故判据里必须钉住 flex 居中。
add('ZOOM.fitToWindow', 'ZOOM', (s) => {
  if (!s.library) return { ok: false, detail: 'screens/manga/LibraryScreen.tsx 不存在' };
  const lib = stripComments(s.library);
  const missing = [];
  // 初始 / 换页复位都必须落在「恰好铺满」档（不是缩放下限，否则开图小一半）
  if (!/useState\(ZOOM_FIT\)/.test(lib)) missing.push('初始比例不是 ZOOM_FIT（开图不是"整张可见"）');
  if (!/zoom:\s*ZOOM_FIT/.test(lib)) missing.push('view 镜像的初始 zoom 不是 ZOOM_FIT');
  if (!/applyView\(ZOOM_FIT,\s*\{\s*x:\s*0\s*,\s*y:\s*0\s*\}\)/.test(lib)) missing.push('换页未复位到 ZOOM_FIT');
  // 取一条规则的声明体（`sel {` 到其后第一个 `}`；这两条块内无嵌套）
  const pick = (src, sel) => {
    const i = src.indexOf(sel + ' {');
    if (i < 0) return '';
    const j = src.indexOf('}', i);
    return j > i ? src.slice(i, j) : '';
  };
  const css = stripComments(s.appCss ?? '');
  for (const [sel, hint] of [
    ['.lightbox-stage', '全屏舞台'],
    ['.pane-body', '对照视图'],
  ]) {
    const block = pick(css, sel);
    if (!block) {
      missing.push(`manga.scss 里没有 ${sel} 规则（${hint}）`);
      continue;
    }
    if (!/display:\s*flex/.test(block))
      missing.push(`${sel} 不是 flex 居中（grid 的 auto 轨道会让 max-height:100% 失效）`);
    if (!/align-items:\s*center/.test(block)) missing.push(`${sel} 缺 align-items: center`);
    if (!/justify-content:\s*center/.test(block)) missing.push(`${sel} 缺 justify-content: center`);
  }
  const stage = pick(css, '.lightbox-stage');
  if (stage && !/overflow:\s*hidden/.test(stage))
    missing.push('.lightbox-stage 不是 overflow: hidden（放大后图会溢出到遮罩外）');
  const img = pick(css, '.lightbox-stage img');
  if (!img) missing.push('manga.scss 里没有 .lightbox-stage img 规则');
  else {
    if (!/max-width:\s*100%/.test(img)) missing.push('.lightbox-stage img 缺 max-width: 100%');
    if (!/max-height:\s*100%/.test(img)) missing.push('.lightbox-stage img 缺 max-height: 100%（图会超出可视区）');
  }
  return { ok: missing.length === 0, detail: missing.join('、') };
});

// ══════════════════════════════════════════════════════════════════════════
// STYLE —— 样式分层（app.css 拆成 base/app/manga/settings/components/music 六个分片）
// ══════════════════════════════════════════════════════════════════════════
// 这一组防的是「样式慢慢又长回一个文件 / 放错分片 / 开始用 SCSS 语法」这三类退化。
// 之所以要有它们：app.css 曾是 3716 行单文件，拆完之后**没有任何机制**阻止它重新膨胀 ——
// 没人会主动去翻六个文件看新样式该放哪，于是默认答案永远是"加到最大的那个文件里"。
//
// 判据一律先 stripComments：本组多条规则在注释里主动写出了被禁的写法
// （如 index.scss 解释「不用 SCSS 嵌套」时提到 mixin 与 &，components.scss 注释里
// 提到 .set-row），不剥注释会恒红 —— 而恒红比恒绿更隐蔽（它看起来像"覆盖到位"）。

/** 约定的 @use 顺序。**顺序即层叠**：同特异性下靠后定义者胜，改它等于改视觉结果。 */
const STYLE_USE_ORDER = ['base', 'app', 'manga', 'settings', 'components', 'music', 'anime'];

/** 从 index.scss 取出 @use 目标（去扩展名），剥注释以免举例被当真声明 */
function useList(indexSrc) {
  const code = stripComments(indexSrc || '');
  return [...code.matchAll(/@use\s+['"]([^'"]+)['"]/g)].map((m) => m[1].replace(/\.scss$/, ''));
}

add('STYLE.shardsRegistered', 'STYLE', (s) => {
  // 双向一致：目录里存在的分片必须被 @use；@use 声明的也必须真实存在。
  // 只查单向会漏 ——「新建了分片但忘了在入口注册」是**最可能发生的错**（文件在、样式不生效），
  // 而「注册了但文件不存在」连构建都过不了，readStyleSource 也会当场抛错。
  const declared = useList(s.styleIndex);
  const onDisk = s.styleShards || [];
  const missing = [];
  for (const f of onDisk) {
    if (!declared.includes(f)) missing.push(`${f}.scss 未在 index.scss 的 @use 里注册（文件在、样式不生效）`);
  }
  for (const d of declared) {
    if (!onDisk.includes(d)) missing.push(`index.scss @use 了 '${d}'，但 styles/ 下没有 ${d}.scss`);
  }
  return { ok: missing.length === 0, detail: missing.length ? missing.join('；') : '' };
});

add('STYLE.useOrder', 'STYLE', (s) => {
  // @use 顺序必须等于约定顺序。这条是**层叠正确性**的守卫：当前顺序与拆分前
  // app.css 的分区顺序逐段对齐，所以拆分不改变层叠语义；一旦调换，语义即变。
  const declared = useList(s.styleIndex);
  if (declared.length !== STYLE_USE_ORDER.length || declared.some((d, i) => d !== STYLE_USE_ORDER[i])) {
    return {
      ok: false,
      detail: `@use 顺序被改：实际 ${declared.join(' → ')}，约定 ${STYLE_USE_ORDER.join(' → ')}（顺序即层叠）`,
    };
  }
  return { ok: true, detail: '' };
});

add('STYLE.entryIsScss', 'STYLE', (s) => {
  // 入口只许 @use .scss。旧 app.css / base.css 若复活并被引回入口，分层就名存实亡。
  const code = stripComments(s.styleIndex || '');
  const bad = [...code.matchAll(/@use\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).filter((t) => !t.endsWith('.scss'));
  return {
    ok: bad.length === 0,
    detail: bad.length ? `index.scss 引用了非 .scss：${bad.join('、')}（旧的 app.css/base.css 不该复活）` : '',
  };
});

add('STYLE.shardOwnership', 'STYLE', (s) => {
  // 单向禁列表：某分片里**绝不该出现**别的模块的强专属前缀。
  // 为什么只禁这几个、且只单向：既有实现里存在合法跨模块组合 ——
  // music.scss 有 `.di-… .ui-cbtn`（灵动岛里的公共按钮）、components.scss 有
  // `.set-row / .set-state`（设置页专用但由 units 组件实现）。双向禁会误报它们。
  // 反向自查已验证：把另一分片喂进来均会报红，判据确实能抓住放错。
  const FORBID = {
    // `.ui-vtab*` 是**通用单元**的样式（住 components.scss）⇒ 其余分片一律禁，
    // 包括漫画与音乐两屏 —— 2026-10-26 起它们共用同一个 PageTabs 单元，
    // 谁再在自己分片里写一份，就是"两处各一份、必然漂移"的老路。
    'manga.scss': [/\.music-/, /\.di-/, /\.pf-/, /\.ac-/, /\.sk-/, /\.skin-/, /\.kara-/, /\.ui-vtab/],
    'music.scss': [
      /\.qt-/,
      /\.lib-/,
      /\.notready/,
      /\.logbox/,
      /\.magic-/,
      /\.compare-/,
      /\.dropzone/,
      /\.filelist/,
      /\.ui-vtab/,
    ],
    'settings.scss': [/\.music-/, /\.di-/, /\.qt-/, /\.lib-/, /\.ui-vtab/],
    'app.scss': [/\.music-/, /\.di-/, /\.qt-/, /\.lib-/, /\.set-/, /\.settings/],
    'components.scss': [/\.music-/, /\.di-/, /\.qt-/, /\.lib-/],
  };
  const hits = [];
  for (const [file, pats] of Object.entries(FORBID)) {
    const code = (s.styleShardCode || {})[file];
    if (code === undefined) {
      hits.push(`${file} 不存在（分片缺失）`);
      continue;
    }
    for (const p of pats) {
      const m = code.match(p);
      if (m) {
        const line = code.slice(0, code.indexOf(m[0])).split('\n').length;
        hits.push(`${file}:${line} 含他模块选择器 ${m[0]}`);
      }
    }
  }
  return { ok: hits.length === 0, detail: hits.length ? hits.join('；') : '' };
});

add('STYLE.tokensDefined', 'STYLE', (s) => {
  /*
   * 用掉的语义令牌必须真的被定义 —— 自定义属性没定义时不是"没颜色"，
   * 而是**整条声明按规范失效（IACVT）**，属性回落到继承值：CSS 里那行还在、看着没错，
   * 效果为零，且浏览器不报任何东西。
   * 实测抓到过：`--miao-accent-ink` 被 5 条规则使用，而 `themes/tokens.ts` 里从没写过它
   * （见 D-357）—— 其中一处还挂了 `var(--miao-accent-ink, var(--miao-muted))` 兜底，
   * 把"令牌缺失"这件事盖成了"看起来是灰的"。
   */
  const defined = new Set();
  const tokPath = path.join(SRC, 'themes', 'tokens.ts');
  if (!existsSync(tokPath)) return { ok: false, detail: '读不到 themes/tokens.ts（判据失去对象）' };
  const tok = cachedReadText(tokPath);
  // 两层令牌都要查：`--miao-*` 是 ver3 语义层、`--md-*` 是被 400+ 处使用的调色板层
  // （`--md-*` 里也有整族循环生成的，见下面的前缀处理）
  for (const m of tok.matchAll(/'(--(?:miao|md)-[\w-]+)'/g)) defined.add(m[1]);
  /*
   * 令牌不只有字面量写法：半径一族是 `out[`--miao-r-${k}`] = ...` **循环生成**的，
   * 调色板一族是 `out[`--md-${k}`] = v` 同样如此。
   * 判据若只认引号字面量，就会把这些族全部误报成"未定义"（第一版正是这样红了 9 处）。
   * 处理方式：记下模板前缀 ⇒ 命中前缀的算已定义；同时**再拿对象键兜一层**，
   * 这样 `--miao-r-xlarge` 这种拼错的仍然红 —— 放宽一处，必须有另一处收紧。
   */
  const prefixes = [];
  for (const m of tok.matchAll(/out\[\s*`(--(?:miao|md)-(?:[\w-]*?))\$\{/g)) prefixes.push(m[1]);
  const keyBlocks = [...tok.matchAll(/export const [A-Z_]+ = \{([\s\S]*?)\} as const/g)].map((m) =>
    [...m[1].matchAll(/^\s*'?([\w-]+)'?\s*:/gm)].map((k) => k[1]),
  );
  const allKeys = new Set(keyBlocks.flat());
  // CSS 里自己定义的也算（`--ui-scale` 就住在 base.scss，不在 tokens.ts）
  let usedCount = 0;
  const miss = [];
  for (const [file, code] of Object.entries(s.styleShardCode || {})) {
    const body = code.replace(/\/\*[\s\S]*?\*\//g, ' '); // 注释里举例写的 var() 不算使用
    for (const m of body.matchAll(/^\s*(--(?:miao|md)-[\w-]+)\s*:/gm)) defined.add(m[1]);
  }
  const isDefined = (name) => {
    if (defined.has(name)) return true;
    for (const p of prefixes) {
      if (name.startsWith(p)) {
        const suffix = name.slice(p.length);
        return allKeys.size === 0 || allKeys.has(suffix);
      }
    }
    return false;
  };
  for (const [file, code] of Object.entries(s.styleShardCode || {})) {
    const body = code.replace(/\/\*[\s\S]*?\*\//g, ' ');
    for (const m of body.matchAll(/var\((--(?:miao|md)-[\w-]+)[,)]/g)) {
      usedCount += 1;
      if (!isDefined(m[1]) && !miss.includes(`${file} → ${m[1]}`)) miss.push(`${file} → ${m[1]}`);
    }
  }
  /*
   * 第二道口径：**TSX 里的字符串令牌名**同样要查。`<Dot colorVar="--md-blu" />` 这种拼错
   * 不会被 tsc 抓到（它就是个字面量），运行期表现是"那个点没颜色"，同样不报错 ——
   * 与本轮修掉的 `--miao-accent-ink` 是同一类静默失效，只是换了一层。
   */
  const walkTs = (dir, acc = []) => {
    if (!existsSync(dir)) return acc;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkTs(p, acc);
      else if (/\.(ts|tsx)$/.test(e.name)) acc.push(p);
    }
    return acc;
  };
  for (const f of walkTs(SRC)) {
    if (/[\\/]themes[\\/]tokens\.ts$/.test(f)) continue;
    const src = stripComments(readMaybe(f));
    for (const m of src.matchAll(/['"](--(?:miao|md)-[\w-]+)['"]/g)) {
      usedCount += 1;
      if (!isDefined(m[1])) {
        const rel = path.relative(ROOT, f);
        if (!miss.includes(`${rel} → ${m[1]}`)) miss.push(`${rel} → ${m[1]}`);
      }
    }
  }
  return {
    // 分母兜底：一条没用都没扫到 = 读空了，那不能算绿
    ok: usedCount > 50 && miss.length === 0,
    detail: miss.length
      ? `未定义的令牌：${miss.join('、')}`
      : usedCount > 50
        ? ''
        : `只扫到 ${usedCount} 处 var() 使用（疑似读空）`,
  };
});

add('STYLE.noSilentTokenFallback', 'STYLE', (s) => {
  /*
   * 语义令牌**不许挂兜底值**：`var(--miao-x, var(--miao-muted))` 这种写法会把
   * "令牌没定义"盖成"颜色看着偏灰"，正是上面那条判据要抓的事最好的掩体。
   * （非语义的第三方变量兜底不在禁列内 —— 只禁 `--miao-*` 吃兜底。）
   */
  const hits = [];
  for (const [file, code] of Object.entries(s.styleShardCode || {})) {
    const body = code.replace(/\/\*[\s\S]*?\*\//g, ' ');
    for (const m of body.matchAll(/var\(--miao-[\w-]+\s*,/g)) hits.push(`${file}: ${m[0].trim()}`);
  }
  return { ok: hits.length === 0, detail: hits.length ? `语义令牌带了兜底值：${hits.join('、')}` : '' };
});

add('STYLE.sharedControlGeometry', 'STYLE', (s) => {
  /*
   * 两个**全站共用**的控件形状钉：图标按钮（模态框关闭钮）与色点（歌词配色）。
   * 之所以要钉：`.icon-btn` 全仓只有一个使用者，改小了没人会发现 ——
   * 之前它正是把设计稿的"小档"（28 / r8）当成了默认档（设计稿默认 34 / r10），
   * 而 `.ui-swatch` 则是 16 / r9 / 1px 描边，与设计稿的 17 / 正圆 / 2px 抠边差三处。
   * 这两处都不会红在任何现有断言上，靠人眼比对才会发现 —— 值不给钉就一定会再漂。
   */
  const want = {
    'components.scss': [
      {
        sel: '.icon-btn',
        decls: [
          ['width', /(^|\n)\s*width:\s*34px\s*;/],
          ['height', /(^|\n)\s*height:\s*34px\s*;/],
          ['border-radius', /(^|\n)\s*border-radius:\s*10px\s*;/],
        ],
      },
      {
        sel: '.ui-swatch',
        decls: [
          ['width', /(^|\n)\s*width:\s*17px\s*;/],
          ['height', /(^|\n)\s*height:\s*17px\s*;/],
          ['border-radius', /(^|\n)\s*border-radius:\s*50%\s*;/],
          ['border', /(^|\n)\s*border:\s*2px solid var\(--miao-surface\)\s*;/],
        ],
      },
    ],
  };
  const bad = [];
  let checked = 0;
  for (const [file, rules] of Object.entries(want)) {
    const code = s.styleShardCode?.[file];
    if (!code) {
      bad.push(`${file} 读不到（判据失去对象）`);
      continue;
    }
    const body = code.replace(/\/\*[\s\S]*?\*\//g, ' ');
    for (const { sel, decls } of rules) {
      const at = body.search(new RegExp(`(^|\\n)${sel.replace('.', '\\.')}\\s*\\{`));
      if (at < 0) {
        bad.push(`${sel} 没有规则了`);
        continue;
      }
      // 块体：从 { 到第一个 }（分片内保持扁平写法，见 STYLE.noScssSyntax）
      const block = body.slice(at, body.indexOf('}', at));
      for (const [prop, re] of decls) {
        checked += 1;
        if (!re.test(block)) bad.push(`${sel} 的 ${prop} 与设计稿不符`);
      }
    }
  }
  // 分母自守：一条都没量到也算绿是最常见的死法
  if (checked < 7) bad.push(`只量到 ${checked} 条声明（应 ≥ 7）`);
  return { ok: bad.length === 0, detail: bad.length ? bad.join('、') : '' };
});

add('STYLE.setCtlNoteSingleSource', 'STYLE', (s) => {
  /*
   * `.set-ctl-note`（控件旁 9.5px 注解）必须**只有一个分片在定义**，而且必须是 settings.scss。
   * 起因：它曾在 components.scss 与 settings.scss 里各有一份，而 components 分片在 settings 之后
   * ⇒ **后到者胜**：改 settings 里那份，界面纹丝不动（本轮就是这么撞上的）。
   * 这类"改对了文件却不见效"的缺陷，只读单个文件永远看不出来。
   * 顺带钉住两条**生效值**（设计稿 theme-music.css 那一层的 `9.5px + muted`，与 110 宽的数字框）。
   */
  const bad = [];
  const shards = s.styleShardCode || {};
  const has = (code) => /(^|\n)\.set-ctl-note\s*\{/.test(stripComments(code || ''));
  const owners = Object.keys(shards).filter((f) => has(shards[f]));
  if (owners.length !== 1) bad.push(`.set-ctl-note 被 ${owners.length} 个分片定义（${owners.join(' / ') || '无'}）`);
  else if (owners[0] !== 'settings.scss') bad.push(`.set-ctl-note 定义在 ${owners[0]}（应在 settings.scss）`);
  const settings = stripComments(shards['settings.scss'] || '');
  let checked = 0;
  const want = [
    ['注解字号 9.5px', /\.set-ctl-note\s*\{[^}]*\n\s*font-size:\s*9\.5px\s*;/],
    ['注解色 muted', /\.set-ctl-note\s*\{[^}]*\n\s*color:\s*var\(--miao-muted\)\s*;/],
    ['数字框 110 宽', /\.set-idle-line\s+\.ui-num\s*\{[^}]*\n\s*width:\s*110px\s*;/],
  ];
  for (const [label, re] of want) {
    checked += 1;
    if (!re.test(settings)) bad.push(`${label} 不符（没量到，或值与设计稿不同）`);
  }
  if (checked < 3) bad.push(`只量到 ${checked} 条（应 >= 3）`);
  return { ok: bad.length === 0, detail: bad.length ? bad.join('；') : '' };
});

add('STYLE.tierLabelSingleSource', 'STYLE', () => {
  /*
   * 档位文案（`Tiny · 轻快` / `Small · 均衡` / `Medium · 精细`）只许在 engine-api.ts 定义一次。
   * 起因：投放屏与设置屏**各写过一份** —— 投放屏那份是设计稿的写法，设置屏那份是光秃秃的
   * `Small`，于是同一台机器上「投放屏显示 Small · 均衡、设置页显示 Small」。
   * 后半截那个词是档位的性格，不是装饰；两份定义迟早只改一处。
   */
  const bad = [];
  const apiPath = path.join(SRC, 'screens', 'settings', 'engine-api.ts');
  if (!existsSync(apiPath)) return { ok: false, detail: '读不到 engine-api.ts（判据失去对象）' };
  const api = cachedReadText(apiPath);
  const want = [
    ['tiny', 'Tiny · 轻快'],
    ['small', 'Small · 均衡'],
    ['medium', 'Medium · 精细'],
  ];
  let checked = 0;
  for (const [key, label] of want) {
    checked += 1;
    if (!api.includes(`${key}: '${label}'`)) bad.push(`档位 ${key} 的文案不是「${label}」`);
  }
  for (const rel of ['screens/settings/sections/TranslateSection.tsx', 'screens/manga/DropScreen.tsx']) {
    checked += 1;
    const abs = path.join(SRC, rel);
    if (!existsSync(abs)) {
      bad.push(`${rel} 不存在`);
      continue;
    }
    if (/const TIER_LABEL/.test(stripComments(cachedReadText(abs)))) bad.push(`${rel} 又自带了一份 TIER_LABEL`);
  }
  if (checked < 5) bad.push(`只量到 ${checked} 条（应 >= 5）`);
  return { ok: bad.length === 0, detail: bad.length ? bad.join('；') : '' };
});

add('STYLE.motionTokensOnly', 'STYLE', (s) => {
  /*
   * 动效参数只走令牌。设计稿的三档时长与三条曲线（140 / 240 / 380ms + spring / spring-soft / out）
   * 已经逐值对进 `MIAO_MOTION`，所以**写死数字就是绕开令牌**：改令牌时它不会跟着动，
   * 而界面上表现成"个别地方快一拍/慢一拍"，肉眼很难指认是哪一条。
   * 本轮清掉 13 条（0.15s / 0.18s / 0.25s / 0.28s / 0.3s + 一条非设计稿曲线 0.22,0.61,0.36,1）。
   * 例外只留**连续量指示器**（进度条 / 电平条）：它们追的是音频/进度，不是交互反馈，
   * `linear` 是正确选择，硬套 240ms 反而会让指示器迟滞。例外逐条列明，不用通配。
   */
  const METER_SELECTORS = new Set(['.ed-bar span', '.di-wave i', '.di-bar i']);
  const bad = [];
  let checked = 0;
  for (const [file, code] of Object.entries(s.styleShardCode || {})) {
    if (file === 'anime.scss') continue; // 番剧分片不在本任务范围
    const body = stripComments(code || '');
    for (const rule of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = rule[1].trim().split('\n').pop().trim();
      for (const m of rule[2].matchAll(/transition\s*:\s*([^;]+);/g)) {
        const value = m[1].replace(/\s+/g, ' ').trim();
        if (value === 'none' || METER_SELECTORS.has(sel)) continue;
        checked += 1;
        const usesToken = /var\(--miao-(dur|ease)/.test(value);
        const hardDuration = /\b\d+(?:\.\d+)?m?s\b/.test(value);
        if (hardDuration && !usesToken) bad.push(`${file} ${sel} → ${value}`);
      }
    }
  }
  // 令牌本身也要对得上设计稿（写错值同样"很安静"）
  const tokPath = path.join(SRC, 'themes', 'tokens.ts');
  if (!existsSync(tokPath)) return { ok: false, detail: '读不到 themes/tokens.ts（判据失去对象）' };
  const tok = cachedReadText(tokPath);
  const motion = [
    ["fast: '140ms'", '基础档 140ms'],
    ["base: '240ms'", '中间档 240ms'],
    ["slow: '380ms'", '慢档 380ms'],
    ["spring: 'cubic-bezier(.22, 1.3, .36, 1)'", '弹簧曲线'],
    ["springSoft: 'cubic-bezier(.34, 1.4, .64, 1)'", '软弹簧曲线'],
    ["out: 'cubic-bezier(.16, 1, .3, 1)'", '出向曲线'],
  ];
  for (const [needle, label] of motion) {
    checked += 1;
    if (!tok.includes(needle)) bad.push(`${label}与设计稿不一致`);
  }
  if (checked < 40) bad.push(`只量到 ${checked} 条 transition（应 >= 40）`);
  return { ok: bad.length === 0, detail: bad.length ? bad.join('；') : '' };
});

add('STYLE.modalCardParity', 'STYLE', (s) => {
  /*
   * 弹窗卡片的**生效值**来自设计稿的后加载层（`theme.css` 覆盖基础表）：
   * 32 圆角 / 单层弥散阴影 / 实底 / 蒙层 .28 + blur 9 + saturate 1.1 / 760·440 两档。
   * 只读基础表会照抄一套界面上不存在的数字（.34 / blur 5 / 680 / 420 / 玻璃底 + --shadow-2），
   * 本轮就是靠运行时量出来的偏差才发现的 —— 源码级判据必须钉**生效值**。
   */
  const css = stripComments(s.styleShardCode?.['components.scss'] || '');
  const need = [
    ['border-radius: var(--miao-r-2xl);', '卡片 32 圆角'],
    ['box-shadow: 0 36px 80px -36px rgba(33, 47, 58, 0.5);', '单层弥散阴影'],
    ['background: var(--miao-surface);', '实底（不再是玻璃底）'],
    ['border: 1px solid var(--miao-line);', '实线边框'],
    ['background: rgba(33, 47, 58, 0.28);', '蒙层底色 .28'],
    ['  backdrop-filter: blur(9px) saturate(1.1);', '蒙层 blur 9 + saturate（前缀两空格：`-webkit-` 那行不算）'],
    ['width: min(760px, calc(100vw - 40px));', 'is-wide 档'],
    ['width: min(440px, 100%);', 'is-narrow 档'],
  ];
  const bad = [];
  const cardBlock = (css.match(/\.modal-card\s*\{[^}]*\}/) || [''])[0];
  const maskBlock = (css.match(/\.modal-mask\s*\{[^}]*\}/) || [''])[0];
  const wideBlock = (css.match(/\.modal-card\.is-wide\s*\{[^}]*\}/) || [''])[0];
  const narrowBlock = (css.match(/\.modal-card\.is-narrow\s*\{[^}]*\}/) || [''])[0];
  const scopes = [cardBlock, maskBlock, wideBlock, narrowBlock];
  if (scopes.some((b) => !b)) return { ok: false, detail: '四段规则里有读不到的（判据失去对象）' };
  for (const [needle, label] of need) {
    if (!scopes.some((b) => b.includes(needle))) bad.push(`${label} 不在设计稿生效值上`);
  }
  // 被覆盖掉的旧值不许还留着（留着就说明有人拿基础表当准绳又抄回来）
  for (const stale of ['rgba(30, 32, 36, 0.34)', 'blur(5px)', 'min(680px', 'min(420px']) {
    if (cardBlock.includes(stale) || maskBlock.includes(stale)) bad.push(`残留旧值 ${stale}`);
  }
  return { ok: bad.length === 0, detail: bad.join('；') };
});

add('DIALOG.useSharedModal', 'DIALOG', (s) => {
  /*
   * 两个手写浮层（登录 / 桌面歌词设置）曾各自实现一遍"蒙层 + 卡片 + 头部 + 动作条"，
   * 结果是宽度、圆角、阴影各差一档、蒙层没有模糊、退场动画缺失。
   * 判据：两个弹窗都必须消费通用 `Modal` 单元，且样式分片里不许再出现那套手写外壳类名。
   */
  const files = {
    login: path.join(SRC, 'screens', 'music', 'LoginModal.tsx'),
    dlset: path.join(SRC, 'screens', 'music', 'DesktopLyricsSettingsModal.tsx'),
  };
  const bad = [];
  let checked = 0;
  for (const [label, p] of Object.entries(files)) {
    if (!existsSync(p)) return { ok: false, detail: `读不到 ${label}` };
    const code = cachedReadText(p);
    checked += 1;
    if (!/<Modal\b/.test(code)) bad.push(`${label} 没有用通用 Modal 单元`);
    if (!/from '@components\/units'/.test(code)) bad.push(`${label} 没从 units 桶导入`);
  }
  const musicCss = stripComments(s.styleShardCode?.['music.scss'] || '');
  for (const dead of ['.music-login-overlay', '.music-dlset-overlay', '.music-dlset-hd', '.music-login-hd']) {
    checked += 1;
    if (musicCss.includes(dead)) bad.push(`样式分片里还留着 ${dead}（手写外壳的残骸）`);
  }
  // 登录弹窗页脚那句"凭证在哪"是设计稿 `.login-foot` 的原话，本轮之前整句缺失
  if (!cachedReadText(files.login).includes('登录凭证仅保存在本机；喵坞不会获取你的密码')) {
    checked += 1;
    bad.push('登录弹窗缺少设计稿页脚说明');
  }
  if (checked < 6) bad.push(`只量到 ${checked} 项（应 >= 6）`);
  return { ok: bad.length === 0, detail: bad.join('；') };
});

add('DIALOG.logBlockCopy', 'DIALOG', (s) => {
  /*
   * 日志块：**一处实现、两处复用**，且复制按钮三要素齐备（图标-only + 无障碍名 + 悬停与聚焦都能拿到）。
   *
   * 🔴 分母写死（`checked >= 13`）：只判"文件存在"是最容易变成空断言的一种判据 ——
   *    把组件删了它照样绿。所以逐条量到具体要素，少一项就红。
   */
  const logBlock = s.units.get('LogBlock.tsx');
  if (!logBlock) return { ok: false, detail: 'units/LogBlock.tsx 不存在' };
  const code = logBlock.stripped;
  const css = stripComments(s.styleShardCode?.['components.scss'] || '');
  const bad = [];
  let checked = 0;

  // ① 必须走通用 `Btn`（工程纪律第 12 条：不在各屏自造同类 DOM）
  checked += 1;
  if (!/<Btn\b/.test(code)) bad.push('复制按钮没有走通用 Btn 单元');
  checked += 1;
  if (/<button\b/.test(code)) bad.push('LogBlock 里仍有裸 <button>');

  // ② 图标-only + 无障碍名 + title（可见文字为空时两者都必填）
  checked += 1;
  if (!/ariaLabel="复制全部日志"/.test(code)) bad.push('复制按钮缺 aria-label');
  checked += 1;
  if (!/title="复制全部日志"/.test(code)) bad.push('复制按钮缺 title');

  // ③ 复制的是**全文**，且走**注入的接缝**（桌面由宿主插件执行）
  checked += 1;
  if (!/if \(copy\) await copy\(text\);|await copy\(text\)/.test(code)) bad.push('复制没有走注入的接缝');
  checked += 1;
  if (!/await copy\(text\);/.test(code) || !/else await navigator\.clipboard/.test(code)) {
    bad.push('复制缺少"接缝优先、浏览器回退"的两条路');
  }

  // ④ 样式：默认隐藏 + 悬停**与聚焦**都能浮现（只写 :hover 等于键盘拿不到）
  checked += 1;
  if (!/\.log-copy\s*\{[^}]*opacity:\s*0/.test(css)) bad.push('.log-copy 默认不是隐藏的');
  checked += 1;
  if (!/\.log-block:hover \.log-copy/.test(css)) bad.push('悬停不浮现复制按钮');
  checked += 1;
  if (!/\.log-block:focus-within \.log-copy/.test(css)) bad.push('聚焦不浮现复制按钮（键盘用户拿不到）');

  // ⑤ 两处调用点都必须真的用它（不是"单元在、页面还手写着老样子"）
  const callers = [
    path.join(SRC, 'screens', 'manga', 'notready', 'AssemblyForm.tsx'),
    path.join(SRC, 'screens', 'manga', 'notready', 'ServiceForm.tsx'),
    path.join(SRC, 'screens', 'engine', 'DownloadPanel.tsx'),
  ];
  for (const f of callers) {
    checked += 2;
    const src = cachedReadText(f);
    if (!/<LogBlock\b/.test(src)) bad.push(`${path.basename(f)} 没有用 LogBlock`);
    if (/className="(?:nr-log|ed-log)"/.test(src)) bad.push(`${path.basename(f)} 仍手写旧日志块`);
    // 🔴 只判"用了 LogBlock"不够：漏掉注入时按钮在、点了走回浏览器 API，打包后静默失败
    if (!/copy=\{copyText\}/.test(src)) bad.push(`${path.basename(f)} 没有注入 copyText`);
  }

  if (checked < 13) bad.push(`只量到 ${checked} 项（应 >= 13）`);
  return { ok: bad.length === 0, detail: bad.join('；') };
});

add('DIALOG.queueDrawerParity', 'DIALOG', (s) => {
  /*
   * 播放队列抽屉：容器必须复用通用 `SideDrawer`（原先手写了一套 348 宽、无圆角、
   * 蒙层不模糊、横穿一屏进场的 `.music-drawer`），内容按设计稿的 `.qd-*` 三层。
   * 数值钉设计稿的**生效值**：362 宽 / 左侧 24 圆角 / 头 18 20 12 / 正文 0 12 16 / 行 r9 / 封面 32·r7。
   */
  const tsx = cachedReadText(path.join(SRC, 'screens', 'music', 'QueueDrawer.tsx'));
  const css = stripComments(s.styleShardCode?.['music.scss'] || '');
  const base = stripComments(tsx);
  const bad = [];
  let checked = 0;
  const need = [
    ['<SideDrawer', '必须复用通用抽屉单元'],
    ['drawerClass="queue-drawer"', '必须挂队列抽屉的修饰类'],
    ['playModeLabel(playMode)', '副标题要带播放模式（设计稿 `N 首 · 模式`）'],
    ['kind="text"', '「清空」是文字按钮（设计稿 `.text-btn`）'],
  ];
  for (const [needle, label] of need) {
    checked += 1;
    if (!base.includes(needle)) bad.push(label);
  }
  const cssNeed = [
    ['.queue-drawer {', '缺少 `.queue-drawer` 修饰类'],
    ['width: min(362px, 100vw);', '宽度应为 362'],
    ['border-radius: 24px 0 0 24px;', '左侧 24 圆角'],
    ['padding: 18px 20px 12px;', '头部内边距'],
    ['padding: 0 12px 16px;', '正文内边距'],
    ['@block:.qd-row.is-current@:background: var(--miao-primary-soft);', '选中行取 `--primary-soft`'],
    ['border-radius: 9px;', '行的 9 圆角'],
    ['width: 32px;', '行封面 32'],
    ['border-radius: 7px;', '行封面 7 圆角'],
  ];
  for (const [needle, label] of cssNeed) {
    checked += 1;
    if (needle.startsWith('@block:')) {
      // `@block:<sel>@:<decl>` —— 只在那个规则块内找。同一令牌在别处也出现时，全片 includes 等于没测
      const [sel, decl] = needle.slice('@block:'.length).split('@:');
      const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m);
      const block = (css.match(new RegExp(esc + '\\s*\\{[^}]*\\}')) || [''])[0];
      if (!block || !block.includes(decl)) bad.push(label);
    } else if (!css.includes(needle)) {
      bad.push(label);
    }
  }
  // 手写外壳的残骸不许回来
  for (const dead of ['.music-drawer {', '.music-drawer-bd', '.music-qrow']) {
    checked += 1;
    if (css.includes(dead)) bad.push(`手写外壳残留 ${dead}`);
  }
  if (checked < 15) bad.push(`只量到 ${checked} 项（应 >= 15）`);
  return { ok: bad.length === 0, detail: bad.join('；') };
});

add('DIALOG.queueToasts', 'DIALOG', (s) => {
  /*
   * 设计稿清空队列是**两行**提示（`播放已关闭` / `队列已清空`），移除最后一项是**一行**；
   * 而内部兜底清空（播放失败 / 启动恢复失败）不该冒充用户操作 ⇒ 必须有 `silent` 开关。
   * 这两件事一起钉：只钉文案会把"兜底也弹提示"这种骚扰放过去。
   */
  const queue = stripComments(cachedReadText(path.join(SRC, 'modules', 'music', 'actions', 'queue.ts')));
  const toast = stripComments(cachedReadText(path.join(SRC, 'screens', 'music', 'Toast.tsx')));
  const bad = [];
  let checked = 0;
  const need = [
    ["get().toast('播放已关闭', 'info', '队列已清空')", '清空队列的两行提示'],
    ["get().toast('队列已清空', 'info')", '移除最后一项的一行提示'],
    ['clearQueue: (silent = false)', '清空必须带 silent 开关'],
    ['if (!silent) get().toast(', '只有非静默才提示'],
  ];
  for (const [needle, label] of need) {
    checked += 1;
    if (!queue.includes(needle)) bad.push(label);
  }
  // 转发器必须把说明行透传出去（否则第二行永远不出现）
  checked += 1;
  if (!toast.includes('toastBus.push(musicToast.message, kind, musicToast.sub)')) {
    bad.push('转发器没把说明行传给总线');
  }
  checked += 1;
  if (!toast.includes("musicToast.type === 'info' ? 'info'")) bad.push('info 语义没映射');
  if (checked < 6) bad.push(`只量到 ${checked} 项（应 >= 6）`);
  return { ok: bad.length === 0, detail: bad.join('；') };
});

add('STYLE.drawerAndTextBtn', 'STYLE', (s) => {
  /*
   * 抽屉单元与文字按钮的**生效值**：蒙层同弹窗（`theme.css` 的 .28 + blur 9 + saturate 1.1），
   * 进场是 `drawer-in` 的"只滑 24px 并从 .6 淡入"，`.text-btn` 是 28 高 / 0 8 / 12px。
   * 三条都是实测出来的偏差（蒙层 2px、滑 18px 且从 0 淡入、文字按钮 23 高）。
   * ⚠️ 字号随全局阶梯调整（11.5 → 12，2026-10-24），判据同步；同时按钮统一不加粗。
   */
  const css = stripComments(s.styleShardCode?.['components.scss'] || '');
  const mask = (css.match(/\.ui-drawer-mask\s*\{[^}]*\}/) || [''])[0];
  const btn = (css.match(/\.text-btn\s*\{[^}]*\}/) || [''])[0];
  const anim = (css.match(/@keyframes ui-drawer-in\s*\{[\s\S]*?\n\}/) || [''])[0];
  const bad = [];
  let checked = 0;
  if (!mask) return { ok: false, detail: '读不到 `.ui-drawer-mask`' };
  if (!btn) return { ok: false, detail: '读不到 `.text-btn`' };
  if (!anim) return { ok: false, detail: '读不到 `ui-drawer-in`' };
  const need = [
    [mask, 'background: rgba(33, 47, 58, 0.28);', '抽屉蒙层底色'],
    [mask, '  backdrop-filter: blur(9px) saturate(1.1);', '抽屉蒙层模糊（前缀两空格：`-webkit-` 那行不算）'],
    [btn, 'height: 28px;', '文字按钮 28 高'],
    [btn, 'padding: 0 8px;', '文字按钮左右 8'],
    [btn, 'font-size: 12px;', '文字按钮 12px'],
    [btn, 'font-weight: 400;', '文字按钮不加粗'],
    [anim, 'translateX(24px)', '进场位移 24px'],
    [anim, 'opacity: 0.6;', '进场起始透明度 .6'],
  ];
  for (const [block, needle, label] of need) {
    checked += 1;
    if (!block.includes(needle)) bad.push(label);
  }
  if (checked < 7) bad.push(`只量到 ${checked} 项（应 >= 7）`);
  return { ok: bad.length === 0, detail: bad.join('；') };
});

add('STYLE.noScssSyntax', 'STYLE', (s) => {
  // 分片内保持**扁平写法**：本阶段不用 SCSS 语法糖。
  // 理由不是审美，是断言：本仓检查脚本大量用 `[^}]*` 取块，嵌套会改变块结构 →
  // 判据静默失效或恒红。（开 nesting 的前置条件是给脚本装 SCSS AST 解析器，
  //  留待后续单独评估 —— 见 docs/internal/style-scss-plan.md。）
  // 同时禁 SCSS 变量承载颜色：令牌只走 var(--md-*) / var(--miao-*)，否则「深色模式只换变量」不成立。
  const hits = [];
  for (const [file, code] of Object.entries(s.styleShardCode || {})) {
    const mixin = code.match(/@(mixin|include)\b/g);
    if (mixin) hits.push(`${file} 用了 @${mixin[0].slice(1)}`);
    const svar = code.match(/\$[a-zA-Z_][\w-]*\s*:/g);
    if (svar) hits.push(`${file} 用了 SCSS 变量 ${svar[0].trim()}（令牌只走 var(--md-*) / var(--miao-*)）`);
    const amp = code.match(/(^|[{,\n])\s*&(?![\w-])/m);
    if (amp) hits.push(`${file} 用了嵌套选择器 &`);
  }
  return { ok: hits.length === 0, detail: hits.length ? hits.join('；') : '' };
});

/*
 * STYLE.noRetiredSelectors —— **退役类名不许再被断言引用**。
 *
 * 为什么需要这条：类名一改，断言里的 `querySelector('.旧名')` 就选不到东西，
 * 而多数判据的写法是「选不到就跳过」⇒ **永久假绿**。这个坑本仓踩了两次：
 *   · `spec-check.ts` 的 C9：`.viewtabs .viewtab` 在页签改成 `.ui-vtab` 后选空，
 *     C9 从此没在检查任何东西（D-408）；
 *   · `ia-structure-check` 的 C9：同一个选择器，同样是"空集合 return true"。
 *
 * 判据是**禁用词**而不是"扫描所有选择器是否都存在"：后者要区分"合成夹具自造的类名"
 * 与"产品真实类名"，误报面太大；而退役名单是**有限且明确**的，零误报。
 * 新增退役类名时把它加进 RETIRED 即可。
 */
add('STYLE.noRetiredSelectors', 'STYLE', () => {
  const RETIRED = [
    'viewtab', // → ui-vtab（通用单元）
    'tab-ink', // 分段控件不用滑动下划线
    'lightbox-x', // 关闭键并入头带
    'lightbox-hint', // 提示并入 34px 脚带
    'view-tab-aside', // → ui-vtab-aside
    'ms-tabs', // → ui-vtabs
    'ms-tab', // → ui-vtab
  ];
  const roots = [path.join(APP, 'e2e'), path.join(SRC, 'tools')];
  const files = roots.flatMap((r) => walkPaths(r)).filter((f) => !f.endsWith('units-structure-check.mjs'));
  const hits = [];
  for (const f of files) {
    if (!/\.(mjs|ts)$/.test(f)) continue;
    const code = stripComments(readMaybe(f));
    /*
     * 只扫**选择器实参**（`querySelector*` / `closest` / `matches` 的第一个字符串字面量），
     * 不扫整个文件：`stripComments` 是状态机（反引号会让它失同步，见 D-110），
     * 全文件扫会把**说明文字里的旧名**也算进来 —— 那是合理的历史叙述，不该判红。
     */
    const args = [...code.matchAll(/(?:querySelector(?:All)?|closest|matches)\(\s*(['"`])([^'"`]*)\1/g)].map(
      (m) => m[2],
    );
    for (const name of RETIRED) {
      // 词边界：`.viewtabs` 不能命中 `viewtab`
      const re = new RegExp(`\\.${name}(?![\\w-])`);
      if (args.some((a) => re.test(a))) hits.push(`${path.relative(APP, f)} 的选择器仍引用退役类名 .${name}`);
    }
  }
  return { ok: hits.length === 0, detail: hits.length ? hits.join('；') : '' };
});

// ── 执行器 ────────────────────────────────────────────────────────────────
function runAll(s, ids) {
  const res = {};
  for (const a of A) {
    if (ids && !ids.includes(a.id)) continue;
    try {
      const r = a.run(s);
      res[a.id] = { ok: !!r.ok, detail: r.detail || '' };
    } catch (e) {
      res[a.id] = { ok: false, detail: `断言抛错：${e.message}` };
    }
  }
  return res;
}
const GROUPS = [
  'LAYOUT',
  'PURITY',
  'NAMING',
  'CALLERS',
  'KEEP',
  'HOOKS',
  'ALIAS',
  'STATE',
  'ROUTER',
  'ISLAND',
  'TOOLTIP',
  'ZOOM',
  'STYLE',
  'DIALOG',
];
function printGrouped(res) {
  let pass = 0;
  let fail = 0;
  for (const g of GROUPS) {
    const items = A.filter((a) => a.group === g);
    if (!items.length) continue;
    const gp = items.filter((a) => res[a.id].ok).length;
    console.log(`\n【${g}】 ${gp}/${items.length}`);
    for (const a of items) {
      const r = res[a.id];
      if (r.ok) {
        pass++;
        console.log(`  ✓ ${a.id}`);
      } else {
        fail++;
        console.log(`  ✗ ${a.id}${r.detail ? `\n      ${r.detail}` : ''}`);
      }
    }
  }
  return { pass, fail };
}

// ── 反证用例 ──────────────────────────────────────────────────────────────
// 三种破坏动作：edit（改文本）/ rename（改名，模拟清单缺件）/ create（复活旧路径）
const MUTATIONS = [
  {
    name: 'LogBlock 的复制按钮退回裸 <button>（绕过通用 Btn 单元）',
    file: F.units + '/LogBlock.tsx',
    find: '<Btn',
    replace: '<button',
    expect: ['DIALOG.logBlockCopy'],
  },
  {
    name: '摘掉 .log-block:hover 的复制按钮浮现（按钮在，但永远看不见）',
    file: path.join(SRC, 'styles', 'components.scss'),
    find: '.log-block:hover .log-copy,',
    replace: '.log-block-hover-disabled .log-copy,',
    expect: ['DIALOG.logBlockCopy'],
  },
  {
    name: '把 units/VirtualList.tsx 改名（模拟清单缺件）',
    from: F.units + '/VirtualList.tsx',
    to: F.units + '/VirtualList.bak',
    expect: ['LAYOUT.files', 'LAYOUT.barrelResolves'],
  },
  {
    name: '往 units/Empty.tsx 顶部注入业务 store import',
    file: F.units + '/Empty.tsx',
    find: "import type { ReactNode } from 'react';",
    replace: "import { useMusicStore } from '../../music/store';\nimport type { ReactNode } from 'react';",
    expect: ['PURITY.noBusinessImports'],
  },
  {
    name: '往 units/Select.tsx 注入根 types import（另一条被禁来源）',
    file: F.units + '/Select.tsx',
    find: "import * as RSelect from '@radix-ui/react-select';",
    replace: "import type { SongLike } from '../types';\nimport * as RSelect from '@radix-ui/react-select';",
    expect: ['PURITY.noBusinessImports'],
  },
  {
    name: '往 units/Range.tsx 注入别名形式的业务 store import（@music/store）',
    file: F.units + '/Range.tsx',
    find: "import type { CSSProperties } from 'react';",
    replace: "import { useMusicStore } from '@music/store';\nimport type { CSSProperties } from 'react';",
    expect: ['PURITY.noBusinessImports'],
  },
  {
    name: '往 units/IconButton.tsx 注入别名形式的根类型 import（@/types）',
    file: F.units + '/IconButton.tsx',
    find: "import type { MouseEvent, ReactNode } from 'react';",
    replace: "import type { TaskRow } from '@/types';\nimport type { MouseEvent, ReactNode } from 'react';",
    expect: ['PURITY.noBusinessImports'],
  },
  {
    name: '把 units/Empty.tsx 的 ui-empty 改回 music-empty',
    file: F.units + '/Empty.tsx',
    find: "'ui-empty'",
    replace: "'music-empty'",
    expect: ['NAMING.noMusic', 'NAMING.uiPrefix'],
  },
  {
    name: '往 units/Select.tsx 塞一个 set-select 类名',
    file: F.units + '/Select.tsx',
    find: 'className="ui-select-item"',
    replace: 'className="ui-select-item set-select"',
    expect: ['NAMING.noSet'],
  },
  {
    name: '把 settings/parts.tsx 里重新加回 export function Select',
    file: F.parts,
    find: 'export function SubTitle(',
    replace: 'export function Select() { return null; }\nexport function SubTitle(',
    expect: ['CALLERS.partsNoControls'],
  },
  {
    name: '把 music/shared.tsx 里的 SongRow 删掉（模拟抽过头）',
    file: F.shared,
    find: 'export function SongRow({',
    replace: 'export function SongRowGone({',
    expect: ['KEEP.sharedExports'],
  },
  {
    name: '把 music/shared.tsx 里重新加回 export function Empty',
    file: F.shared,
    find: 'export function providerName(',
    replace: 'export function Empty() { return null; }\nexport function providerName(',
    expect: ['CALLERS.sharedNoUnits'],
  },
  {
    name: '把 screens/music/RightPanel.tsx 的 units import 改路径',
    file: F.rightPanel,
    find: "from '@components/units';",
    replace: "from '@components/unitz';",
    expect: ['CALLERS.importsUnits'],
  },
  {
    name: '把 LoginModal.tsx 改回 <button className="music-cbtn">',
    file: F.loginModal,
    find: '退出登录',
    replace: '<button type="button" className="music-cbtn">退出登录</button>',
    expect: ['CALLERS.loginNoRawCbtn'],
  },
  {
    name: '把 settings/parts.tsx 的 PendingRow 改名（模拟抽过头）',
    file: F.parts,
    find: 'export function PendingRow(',
    replace: 'export function PendingRowGone(',
    expect: ['KEEP.partsExports'],
  },
  {
    name: '把 components/Sidebar.tsx 改名（应用级组件不该消失）',
    from: F.components + '/Sidebar.tsx',
    to: F.components + '/Sidebar.bak',
    expect: ['KEEP.appComponents'],
  },
  {
    name: '复活旧路径 components/atoms.tsx（模拟保留兼容再导出）',
    create: F.legacyAtoms,
    content: 'export {};\n',
    expect: ['LAYOUT.legacyAbsent'],
  },
  {
    name: '把 index.ts 桶文件里 Badge 的出口摘掉（模拟漏出口）',
    file: F.units + '/index.ts',
    find: "export { Badge, Btn, Dot, MagicCircle, Pill } from '@components/units/atoms';",
    replace: "export { Btn, Dot, MagicCircle, Pill } from '@components/units/atoms';",
    expect: ['LAYOUT.barrelExports'],
  },
  {
    name: '把 atoms.tsx 的历史中性类名 .pill 改成 .ui-pill',
    file: F.units + '/atoms.tsx',
    find: '<span className="pill">',
    replace: '<span className="ui-pill">',
    expect: ['NAMING.neutralKept'],
  },
  {
    name: '把 src/hooks/useEsc.ts 改名（模拟收口缺件）',
    from: F.hooksDir + '/useEsc.ts',
    to: F.hooksDir + '/useEsc.bak',
    expect: ['HOOKS.layout'],
  },
  {
    name: '复活 src/hooks.ts 旧单文件（模拟 hooks.ts 与 hooks/ 并存）',
    create: F.hooksFile,
    content: 'export {};\n',
    expect: ['HOOKS.layout'],
  },
  {
    name: '把 src/hooks/index.ts 的 useToasts 改名（模拟业务 hook 丢失）',
    file: F.hooksDir + '/index.ts',
    find: 'export function useToasts()',
    replace: 'export function useToastsGone()',
    expect: ['HOOKS.barrelExports'],
  },
  {
    name: '把 PlatformMenu 的 useEsc 引用改回旧位置（@components/units/useEsc）',
    file: F.platformMenu,
    // 锚点必须与 PlatformMenu.tsx 当前的真实字节一致：本项目**统一单引号**，
    // 编辑器保存时的重排会把引号换成双引号（纯噪声），此时锚点失配 ——
    // 后果不是变红而是本条被静默跳过，故回退噪声时**必须同步锚点**（本仓库踩过这个坑）。
    find: "from '@hooks/useEsc';",
    replace: "from '@components/units/useEsc';",
    expect: ['HOOKS.callers'],
  },
  {
    name: '把 hooks/useCoverColor.ts 移回 screens/music（模拟 use* 未收口）',
    from: F.hooksDir + '/useCoverColor.ts',
    to: path.join(SRC, 'screens', 'music', 'useCoverColor.ts'),
    /*
     * 移动后真正会红的是两条：散落的 use*（`HOOKS.noMisplacedUse`）与
     * hooks 目录缺项（`HOOKS.layout`）。
     * ⚠️ 不要再把 `CALLERS.importsUnits` 列进来 —— 那条查的是"UI 调用点是否从 units 引"，
     * 与 use* 放哪儿无关；列进来会变成"该红没红"的假失败。
     */
    expect: ['HOOKS.noMisplacedUse', 'HOOKS.layout'],
  },
  {
    name: '从 vite.config.ts 删掉 @hooks 别名（模拟两处漏改一处）',
    file: F.viteConfig,
    find: "@hooks': aliasPath('./src/hooks')",
    replace: '',
    expect: ['ALIAS.keysComplete', 'ALIAS.twoPlaceSync'],
  },
  {
    name: '从 tsconfig.json 删掉 @music 别名（两条一起删，反向漂移：tsc 不认识而 vite 认识）',
    file: F.tsconfig,
    find: '      "@music": ["src/modules/music"],\n      "@music/*": ["src/modules/music/*"],\n',
    replace: '',
    expect: ['ALIAS.keysComplete', 'ALIAS.twoPlaceSync'],
  },
  {
    name: '只删 tsconfig 的 @music/* 通配项（配置退化：别名还在，但 @music/store 解析不到）',
    file: F.tsconfig,
    find: '      "@music/*": ["src/modules/music/*"],\n',
    replace: '',
    expect: ['ALIAS.subPathMaps'],
  },
  {
    name: '把 RightPanel 的一处别名引用改回相对上跳',
    file: F.rightPanel,
    find: "from '@components/units';",
    replace: "from '../../components/units';",
    expect: ['ALIAS.noRelativeUp'],
  },
  {
    name: '把 ipc.ts 的 npm 包 @tauri-apps/api/core 误写成别名 @tauri/api/core',
    file: path.join(SRC, 'ipc', 'index.ts'),
    find: "from '@tauri-apps/api/core';",
    replace: "from '@tauri/api/core';",
    expect: ['ALIAS.pkgNotShadowed'],
  },
  {
    name: '往 parts.tsx 塞一个 React Context（模拟绕过 zustand）',
    file: F.parts,
    find: "import type { ReactNode } from 'react';",
    replace: "import type { ReactNode } from 'react';\nconst Ctx = createContext(null);\n",
    expect: ['STATE.noReactContext'],
  },
  {
    name: '把 store.ts 的 zustand 依赖换掉（模拟状态库不再是 zustand）',
    file: path.join(SRC, 'modules', 'music', 'store.ts'),
    find: "from 'zustand';",
    replace: "from 'zustand-gone';",
    expect: ['STATE.zustandInUse'],
  },

  // ── ROUTER 屏装配件分派表（B1）──────────────────────────────────────────────
  {
    name: '把音乐屏从分派表里摘掉（/music 从此不渲染任何东西，而没有任何门会响）',
    file: F.routerPanes,
    find: '  music: MusicPane,\n',
    replace: '',
    expect: ['ROUTER.panesWired'],
  },
  {
    name: '让 ScreenPane 不再按 pane 取组件（三个屏都渲染同一个东西）',
    file: F.routerPanes,
    find: '  const Pane = SCREEN_PANES[pane];\n',
    replace: '  const Pane = TranslatePane;\n',
    expect: ['ROUTER.panesWired'],
  },
  // ── ISLAND 灵动岛（拍板第 4 项）──────────────────────────────────────
  {
    name: '把 App.tsx 里的 <DynamicIsland /> 删掉（实现了但没人挂）',
    file: F.app,
    find: '      <DynamicIsland />',
    replace: '      {null /* 反证：灵动岛未挂载 */}',
    expect: ['ISLAND.mountedAtRoot'],
  },
  {
    name: '把 App 里的灵动岛换回旧的 .toasts 渲染层（两套并存 → 同一条提示出现两次）',
    file: F.app,
    find: '      <DynamicIsland />',
    replace: '      <div className="toasts" />',
    expect: ['ISLAND.singleSource'],
  },
  {
    name: '让 music/Toast 重新自己渲染（与灵动岛重复显示同一条提示）',
    file: F.musicToast,
    // 锚点用 `return null;`（转发器不渲染任何 DOM）→ 改成一个 div。
    // 不用"删掉转发代码"当破坏：那会让本组另一条断言先红，掩盖要测的东西。
    find: '  return null;\n}',
    replace: '  return <div className="music-toast">x</div>;\n}',
    expect: ['ISLAND.musicToastForwards'],
  },
  {
    name: '把胶囊形变时长改成 CSS 0.4s ↔ TS 380ms 不一致（动画半途被内联宽高瞬移）',
    file: F.musicScss,
    // 锚点取 transition 里的 width 段。判据取的是同一处，故改它必然触发红
    find: '    width 0.38s var(--miao-ease-spring),',
    replace: '    width 0.4s var(--miao-ease-spring),',
    expect: ['ISLAND.morphDurationSync'],
  },
  {
    name: '去掉灵动岛的空闲态早退（会一直挂着一个空胶囊）',
    file: F.island,
    find: '  if (!hasQueue) return null;',
    replace: '  // 反证：空闲态不再早退',
    expect: ['ISLAND.idleRendersNothing'],
  },
  {
    name: '让灵动岛重新接回 toastBus（轻提示出现两个渲染层，同一条显示两次）',
    file: F.island,
    // D-156：`coverProxyUrl`/`fmtTime` 已随纯函数搬到 @music/convert，此处只剩 useMusicStore
    find: "import { useMusicStore } from '@music/store';",
    replace:
      "import { useMusicStore } from '@music/store';\nimport { useToastList } from '@/stores/toastBus'; // 反证：提示通道重新接入",
    expect: ['ISLAND.noToastChannel'],
  },

  // ── TOOLTIP（悬停提示）──────────────────────────────────────────────
  // 守的是「hover 到气泡上气泡先没了」：气泡悬在宿主上方 6px，宿主 mouseleave
  // 必须走宽限期（scheduleHide），不能立即收 —— 否则指针还在半路上气泡就销毁了。
  {
    name: '宿主离开改回立即收起（指针跨间隙时气泡先销毁，hover 不进气泡）',
    file: F.tooltip,
    find: '      onMouseLeave={scheduleHide}',
    replace: '      onMouseLeave={hide}',
    expect: ['TOOLTIP.graceHide'],
  },

  // ── ZOOM（全屏看图缩放）──────────────────────────────────────────────────
  // 这一组守的是「缩放看起来有、实际不生效」的三种形态：被动监听（滚轮没反应且页面乱滚）、
  // 中心缩放（能放大但手感差）、只有手势没有按钮（macOS 上完全没法缩放）。
  {
    // 最典型的退化：嫌手动挂监听麻烦，改回 React 的 onWheel ⇒ passive，preventDefault 失效
    name: '把 wheel 监听改回被动的 React onWheel（preventDefault 失效 + 页面跟着滚）',
    file: F.libraryViewer,
    find: "    window.addEventListener('wheel', onWheel, { passive: false });",
    replace: '    // 反证：改回 React onWheel（被动监听）\n    void onWheel;',
    expect: ['ZOOM.wheelNonPassive'],
  },
  {
    // 只挂不卸 ⇒ 浮层开关多次后旧监听仍在跑，一次滚轮被处理 N 次
    name: '删掉 wheel 监听的 removeEventListener（卸载泄漏 ⇒ 一次滚轮缩放多次）',
    file: F.libraryViewer,
    find: "    return () => window.removeEventListener('wheel', onWheel);",
    replace: '    return undefined;',
    expect: ['ZOOM.wheelNonPassive'],
  },
  {
    // 锚点缩放退化成"缩放就回中心"：能跑、类型过，但每滚一下图都往中间跳
    name: '把锚点缩放改成直接重置偏移（等价于中心缩放，手感退化）',
    file: F.libraryViewer,
    find: '    applyView(next, { x: ax - (ax - cur.offset.x) * k, y: ay - (ay - cur.offset.y) * k });',
    replace: '    applyView(next, { x: 0, y: 0 });',
    expect: ['ZOOM.anchorZoom'],
  },
  {
    // 不量光标位置 ⇒ 没有锚点可言（退化成中心缩放，但仍走 zoomAt，看着"有实现"）
    name: '让 zoomAt 不再量光标位置（失去锚点，仍有 zoomAt 函数 ⇒ 半绿假象）',
    file: F.libraryViewer,
    find: '    const rect = stage.getBoundingClientRect();',
    replace: '    const rect = { left: 0, top: 0, width: 0, height: 0 };',
    expect: ['ZOOM.anchorZoom'],
  },
  {
    // 去掉按钮 = macOS 上完全没法缩放（捏合被 WebKit 吃掉，事件到不了 JS）
    name: '删掉工具栏的缩小按钮（macOS 上失去唯一的非手势缩放路径）',
    file: F.libraryViewer,
    // 锚点只取属性行本身，不带缩进 —— 工具栏从"条件渲染"改成"常驻淡出"后整体缩进变过一层，
    // 带缩进的锚点会直接失配（跳过 ≠ 通过）。
    // 属性名跟着实现走：按钮改走 `Btn` 单元后是无障碍名走 `ariaLabel` 而不是裸 `aria-label`。
    find: 'ariaLabel="缩小"\n',
    replace: '',
    expect: ['ZOOM.buttonFallback'],
  },
  {
    name: '删掉工具栏缩放按钮的样式（按钮裸奔，无禁用态/悬停态）',
    file: path.join(F.stylesDir, 'manga.scss'),
    find: '.lightbox-zoom-btn:hover:not(:disabled) {',
    replace: '.lightbox-zoom-btn:hover-x:not(:disabled) {',
    expect: ['ZOOM.buttonFallback'],
  },
  {
    // 裸滚轮平移不门控溢出态 ⇒ ≤100% 时滚轮被吞，用户以为失灵
    name: '把裸滚轮平移移出溢出态门控（≤100% 时滚轮被吞，失灵）',
    file: F.libraryViewer,
    find: '      if (view.current.zoom > ZOOM_FIT) {',
    replace: '      if (true) {',
    expect: ['ZOOM.twoFingerPan'],
  },
  {
    // 方向反了：滚轮向上反而缩小 —— 能缩能放、类型也过，只有钉子拦得住
    name: '把滚轮缩放因子改成 1 + deltaY·k（向上滚反而缩小，方向反了）',
    file: F.libraryViewer,
    find: 'zoomAt(e.clientX, e.clientY, 1 - e.deltaY * ZOOM_WHEEL_K);',
    replace: 'zoomAt(e.clientX, e.clientY, 1 + e.deltaY * ZOOM_WHEEL_K);',
    expect: ['ZOOM.wheelDirection'],
  },
  {
    // 缩回「铺满」及以内不归位 ⇒ 旧偏移把图顶出画面
    name: '删掉「≤ ZOOM_FIT 归位」分支（缩回铺满后图歪在一边、跑出画面）',
    file: F.libraryViewer,
    find: `    if (next <= ZOOM_FIT) {
      if (cur.zoom !== next || cur.offset.x !== 0 || cur.offset.y !== 0) applyView(next, { x: 0, y: 0 });
      return;
    }
`,
    replace: '',
    expect: ['ZOOM.anchorZoom'],
  },
  {
    // 开图默认落到缩放下限（50%）：图小一半，且丢掉"整张铺满"语义
    name: '把初始比例改成 ZOOM_MIN（开图不是整张铺满）',
    file: F.libraryViewer,
    find: 'useState(ZOOM_FIT)',
    replace: 'useState(ZOOM_MIN)',
    expect: ['ZOOM.fitToWindow'],
  },
  {
    // 退回 grid：auto 轨道按内容撑开 ⇒ max-height:100% 失效 ⇒ 图溢出被裁（实测 345×517）
    name: '把 .lightbox-stage 改回 grid + place-items（max-height:100% 失效，图溢出被裁）',
    file: path.join(F.stylesDir, 'manga.scss'),
    find: `.lightbox-stage {
  flex: 1;
  min-height: 0;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;`,
    replace: `.lightbox-stage {
  flex: 1;
  min-height: 0;
  width: 100%;
  display: grid;
  place-items: center;`,
    expect: ['ZOOM.fitToWindow'],
  },
  {
    name: '删掉 .lightbox-stage img 的 max-height: 100%（图片溢出可视区）',
    file: path.join(F.stylesDir, 'manga.scss'),
    find: `.lightbox-stage img {
  max-width: 100%;
  max-height: 100%;`,
    replace: `.lightbox-stage img {
  max-width: 100%;`,
    expect: ['ZOOM.fitToWindow'],
  },
  {
    name: '把 .pane-body 改回 grid + place-items（对照视图同样溢出、要滚动）',
    file: path.join(F.stylesDir, 'manga.scss'),
    find: `.pane-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;`,
    replace: `.pane-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: grid;
  place-items: center;`,
    expect: ['ZOOM.fitToWindow'],
  },

  // ── STYLE（样式分层）─────────────────────────────────────────────────────
  // 这一组反证守的是「拆完之后没人守规矩，样式又长回一个文件 / 放错分片 /
  // 开始用 SCSS 语法」。没有它们，分层只是目录 aesthetics。
  {
    // 新建了分片却忘了在入口注册 —— 文件在、样式不生效，且**不会报任何错**
    name: '从 index.scss 删掉 manga 的 @use（分片存在但没注册 → 整模块样式不生效）',
    file: path.join(F.stylesDir, 'index.scss'),
    find: "@use 'manga.scss';\n",
    replace: '',
    expect: ['STYLE.shardsRegistered'],
  },
  {
    // 顺序即层叠：调换 base/app 就可能改变同特异性规则的胜负
    name: '把 @use 顺序里的 music 提到 manga 之前（顺序即层叠，被悄悄改掉）',
    file: path.join(F.stylesDir, 'index.scss'),
    find: "@use 'manga.scss';\n@use 'settings.scss';\n@use 'components.scss';\n@use 'music.scss';",
    replace: "@use 'music.scss';\n@use 'manga.scss';\n@use 'settings.scss';\n@use 'components.scss';",
    expect: ['STYLE.useOrder'],
  },
  {
    name: '把入口的 @use 指回 .css（旧 app.css/base.css 复活，分层名存实亡）',
    file: path.join(F.stylesDir, 'index.scss'),
    find: "@use 'base.scss';",
    replace: "@use 'base.css';",
    expect: ['STYLE.entryIsScss'],
  },
  {
    // 放错分片的真实动机是「懒得翻文件」，所以反证就模拟这个动作
    name: '把音乐的选择器塞进 manga.scss（模块私有样式放错分片）',
    file: path.join(F.stylesDir, 'manga.scss'),
    find: '/* ================================================================ X-C1 任务队列\n',
    replace:
      '.music-queue-fake { color: red; }\n/* ================================================================ X-C1 任务队列\n',
    expect: ['STYLE.shardOwnership'],
  },
  {
    // 这正是本轮真修掉的缺陷：CSS 用了 `--miao-accent-ink`，tokens 里却没有它
    name: '把 --miao-accent-ink 的定义删掉（CSS 五处还在用 ⇒ 声明整条失效、颜色静默回落）',
    file: path.join(SRC, 'themes', 'tokens.ts'),
    find: "  out['--miao-accent-ink'] = mode === 'dark' ? '#EFC4A4' : '#BE7F57';\n",
    replace: '',
    expect: ['STYLE.tokensDefined'],
  },
  {
    // 同一类缺陷的另一层：TSX 里的令牌名是**字符串字面量**，tsc 抓不到（本轮判据特意扩到这一层）
    name: '把 manga 状态色写成 --md-sucess（少一个 s；tsc 不报、Dot 只是没颜色）',
    file: path.join(SRC, 'screens', 'manga', 'chapters.tsx'),
    find: "  done: '--md-success',",
    replace: "  done: '--md-sucess',",
    expect: ['STYLE.tokensDefined'],
  },
  {
    name: '给语义令牌挂一个兜底值（把"令牌没定义"盖成"颜色偏灰"，正是上一条判据的掩体）',
    file: path.join(F.stylesDir, 'settings.scss'),
    find: '  color: var(--miao-accent-ink);\n',
    replace: '  color: var(--miao-accent-ink, var(--miao-muted));\n',
    expect: ['STYLE.noSilentTokenFallback'],
  },
  {
    // 这正是本轮真修掉的：`.icon-btn` 曾把设计稿的"小档"（28 / r8）当成默认档
    name: '把图标按钮退回 28×28（设计稿默认是 34×34 / r10，`.icon-btn-sm` 才是 28）',
    file: path.join(F.stylesDir, 'components.scss'),
    find: '  width: 34px;\n  height: 34px;\n  border: none;\n  border-radius: 10px;',
    replace: '  width: 28px;\n  height: 28px;\n  border: none;\n  border-radius: 8px;',
    expect: ['STYLE.sharedControlGeometry'],
  },
  {
    // 同上：色点曾是小 1px、还不是正圆、也没有那层 2px 抠边
    name: '把色点退回 16 / r9 / 1px 描边（设计稿是 17 / 正圆 / 2px 抠边）',
    file: path.join(F.stylesDir, 'components.scss'),
    find: '  width: 17px;\n  height: 17px;\n  padding: 0;\n  border: 2px solid var(--miao-surface);\n  border-radius: 50%;',
    replace:
      '  width: 16px;\n  height: 16px;\n  padding: 0;\n  border: 1px solid var(--miao-line);\n  border-radius: 9px;',
    expect: ['STYLE.sharedControlGeometry'],
  },
  {
    // 本轮真撞上的缺陷：同一选择器在两个分片各有一份，后到的 components 静默盖住 settings
    name: '把 .set-ctl-note 的第二份定义加回 components.scss（改 settings 里那份就再也不生效）',
    file: path.join(F.stylesDir, 'components.scss'),
    find: '.ui-vlist-item {\n  position: absolute;',
    replace:
      '.set-ctl-note {\n  font-size: 9px;\n  color: var(--miao-faint);\n}\n.ui-vlist-item {\n  position: absolute;',
    expect: ['STYLE.setCtlNoteSingleSource'],
  },
  {
    name: '把控件旁注解从 9.5px 改成 9px（设计稿设置在 theme-music 那层的生效值就是 9.5）',
    file: path.join(F.stylesDir, 'settings.scss'),
    find: '.set-ctl-note {\n  font-size: 9.5px;',
    replace: '.set-ctl-note {\n  font-size: 9px;',
    expect: ['STYLE.setCtlNoteSingleSource'],
  },
  {
    name: '把某条 hover 过渡的时长写回 0.15s（绕开 --miao-dur-fast，改令牌时它不会跟着动）',
    file: path.join(F.stylesDir, 'settings.scss'),
    find: '  transition:\n    background var(--miao-dur-fast),\n    color var(--miao-dur-fast);',
    replace: '  transition:\n    background 0.15s,\n    color 0.15s;',
    expect: ['STYLE.motionTokensOnly'],
  },
  {
    name: '把中间档时长从 240ms 改成 200ms（界面上只是"快一拍"，没有任何东西会报错）',
    file: path.join(SRC, 'themes', 'tokens.ts'),
    find: "  base: '240ms',",
    replace: "  base: '200ms',",
    expect: ['STYLE.motionTokensOnly'],
  },
  {
    name: '把弹窗卡片圆角改回 26（基础表的值，设计稿生效值是 32）',
    file: path.join(F.stylesDir, 'components.scss'),
    find: '  border-radius: var(--miao-r-2xl);',
    replace: '  border-radius: var(--miao-r-xl);',
    expect: ['STYLE.modalCardParity'],
  },
  {
    name: '把蒙层模糊改回 blur(5px)（基础表的旧值，界面只是"糊得不够"）',
    file: path.join(F.stylesDir, 'components.scss'),
    find: '  backdrop-filter: blur(9px) saturate(1.1);',
    replace: '  backdrop-filter: blur(5px);',
    within: '.modal-mask {',
    expect: ['STYLE.modalCardParity'],
  },
  {
    name: '把登录弹窗退回手写外壳（复制一张卡片，改一处不会同步）',
    file: path.join(F.stylesDir, 'music.scss'),
    find: '.login-card {',
    replace: '.music-login-overlay {\n  position: fixed;\n  inset: 0;\n}\n.login-card {',
    expect: ['DIALOG.useSharedModal'],
  },
  {
    name: '把队列抽屉的宽度改回手写版 348（比例看不出，数值能）',
    file: path.join(F.stylesDir, 'music.scss'),
    find: '  width: min(362px, 100vw);',
    replace: '  width: 348px;',
    expect: ['DIALOG.queueDrawerParity'],
  },
  {
    name: '把队列抽屉的选中底色换回暖橙（令牌用错，肉眼"更符合品牌"）',
    file: path.join(F.stylesDir, 'music.scss'),
    find: '  background: var(--miao-primary-soft);',
    replace: '  background: var(--miao-accent-soft);',
    within: '.qd-row.is-current {',
    expect: ['DIALOG.queueDrawerParity'],
  },
  {
    name: '把文字按钮改回 23 高（旁边 34×34 的关闭键会显得它塌下去）',
    file: path.join(F.stylesDir, 'components.scss'),
    find: '  height: 28px;\n  padding: 0 8px;',
    replace: '  padding: 3px 7px;',
    expect: ['STYLE.drawerAndTextBtn'],
  },
  {
    name: '把抽屉蒙层改回 blur(2px)（基础表的旧值）',
    file: path.join(F.stylesDir, 'components.scss'),
    find: '  backdrop-filter: blur(9px) saturate(1.1);',
    replace: '  backdrop-filter: blur(2px);',
    within: '.ui-drawer-mask {',
    expect: ['STYLE.drawerAndTextBtn'],
  },
  {
    name: '把清空队列退回"没有反馈"（用户点了不知道发生了什么）',
    file: path.join(SRC, 'modules', 'music', 'actions', 'queue.ts'),
    find: "    if (!silent) get().toast('播放已关闭', 'info', '队列已清空');",
    replace: '    void silent;',
    expect: ['DIALOG.queueToasts'],
  },
  {
    name: '把档位文案退回光秃秃的 Small（设计稿是 Small · 均衡，后半截是这档的性格）',
    file: path.join(SRC, 'screens', 'settings', 'engine-api.ts'),
    find: "  small: 'Small · 均衡',",
    replace: "  small: 'Small',",
    expect: ['STYLE.tierLabelSingleSource'],
  },
  {
    name: '让设置屏重新自带一份 TIER_LABEL（投放屏与设置屏各一份，迟早只改一处）',
    file: path.join(SRC, 'screens', 'settings', 'sections', 'TranslateSection.tsx'),
    find: '\nexport function TranslateSection',
    replace:
      "\nconst TIER_LABEL = { tiny: 'Tiny', small: 'Small', medium: 'Medium' };\n\nexport function TranslateSection",
    expect: ['STYLE.tierLabelSingleSource'],
  },
  {
    name: '在分片里用 SCSS 变量承载颜色（令牌只走 var(--md-*) / var(--miao-*)，否则深色模式就不成立了）',
    file: path.join(F.stylesDir, 'music.scss'),
    find: '/* ================================================================ 音乐屏',
    replace: '$brand: #ffe066;\n/* ================================================================ 音乐屏',
    expect: ['STYLE.noScssSyntax'],
  },
  {
    name: '在分片里写嵌套选择器（会改块结构 → 检查脚本的正则取块判据失效）',
    file: path.join(F.stylesDir, 'music.scss'),
    find: '/* ================================================================ 音乐屏',
    replace:
      '.music-exp { &:hover { color: red; } }\n/* ================================================================ 音乐屏',
    expect: ['STYLE.noScssSyntax'],
  },
];

// ── 主流程 ────────────────────────────────────────────────────────────────
const refute = process.argv.includes('--refute');

console.log('公共组件抽离（components/units）结构断言' + (refute ? ' · 反证轮' : ''));
console.log(`根目录：${ROOT}`);
console.log(`断言总数：${A.length}（LAYOUT/PURITY/NAMING/CALLERS/KEEP/HOOKS/ALIAS/STATE/ISLAND/TOOLTIP/ZOOM）`);

/**
 * 在 `within` 标记之后替换第一处出现（不给 within 则从文件头找）。
 *
 * 为什么需要它：设计稿生效值会在多个块里重复（蒙层底色 / 模糊在抽屉与弹窗各一份），
 * 只按"第一处"换会改错块 —— 于是断言看着不灵，其实是变异打错了地方。
 * 找不到标记或找不到锚点时原样返回，由调用方的 `includes` 预检兜住（跳过 ≠ 通过）。
 */
function replaceWithin(text, find, repl, within) {
  const start = within ? text.indexOf(within) : 0;
  if (start < 0) return text;
  const at = text.indexOf(find, start);
  if (at < 0) return text;
  return text.slice(0, at) + repl + text.slice(at + find.length);
}

if (!refute) {
  const res = runAll(loadSources());
  const { pass, fail } = printGrouped(res);
  console.log('\n' + '─'.repeat(56));
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) {
    console.log('\n下一步：逐条看上面 ✗ 的 detail —— 是脚本写错还是真实抽离缺口，勿为转绿而放宽断言。');
  }
  process.exitCode = fail === 0 ? 0 : 1;
} else {
  const base = runAll(loadSources());
  const wasGreenBase = {};
  for (const a of A) wasGreenBase[a.id] = base[a.id].ok;

  // 分母固定：应执行的破坏条数在脚本里写死。理由——比率型指标会吞掉分母变化：
  // 「13/13」与「12/12」肉眼都是全绿，而后者已永久少一条覆盖（锚点随重构漂移时会这样静默降级）。
  const expectedTotal = MUTATIONS.reduce((n, m) => n + m.expect.length, 0);

  let total = 0;
  let red = 0;
  let skipped = 0;
  const falsePositives = [];
  const applied = []; // {kind, ...} 用于最终恢复校验
  const restoreErrors = []; // 恢复动作本身失败（不许抛，见下面的 finally）

  console.log(`\n破坏源文件 → 断言必须变红 → 按字节恢复（应执行 ${expectedTotal} 条）\n`);

  for (const mut of MUTATIONS) {
    let okApply = true;
    let record = null;
    try {
      if (mut.from) {
        // 改名
        if (!existsSync(mut.from)) {
          console.log(`⚠ ${mut.name}\n    源文件不存在：${path.relative(ROOT, mut.from)} —— 本条无法反证`);
          okApply = false;
          skipped += mut.expect.length;
        } else {
          const original = readBytes(mut.from);
          record = { kind: 'rename', from: mut.from, to: mut.to, original };
          renameSync(mut.from, mut.to);
        }
      } else if (mut.create) {
        if (existsSync(mut.create)) {
          console.log(`⚠ ${mut.name}\n    ${path.relative(ROOT, mut.create)} 已存在 —— 本条无法反证`);
          okApply = false;
          skipped += mut.expect.length;
        } else {
          record = { kind: 'create', file: mut.create };
          writeFileSync(mut.create, mut.content);
        }
      } else {
        const original = readBytes(mut.file);
        if (original == null) {
          console.log(`⚠ ${mut.name}\n    文件不存在：${path.relative(ROOT, mut.file)} —— 本条无法反证`);
          okApply = false;
          skipped += mut.expect.length;
        } else {
          const txt = original.toString('utf8');
          // 🔴 EOL 折算：本仓 `core.autocrlf=true`（且无 `.gitattributes` 归一），工作区是 **CRLF**，
          //    而下面的锚点字面量写的是 **LF**。不折算时，**任何跨行锚点**都会"锚点未找到" →
          //    该条静默不反证（跳过 ≠ 通过）。2026-10-07 实测：Windows 上因此有 9 条长期被跳过
          //    （vite/tsconfig 的别名、index.scss 的 @use、music/Toast 的多行锚点），
          //    而"能跑绿的 26 条"掩盖了这件事 —— 正是本项目最警惕的「覆盖率幻觉」。
          const eol = txt.includes('\r\n') ? '\r\n' : '\n';
          const find = mut.find.split('\n').join(eol);
          const repl = mut.replace.split('\n').join(eol);
          if (!txt.includes(find) || (mut.within && !txt.includes(mut.within))) {
            console.log(`⚠ ${mut.name}\n    破坏锚点未找到（源文件已变？）—— 本条无法反证`);
            okApply = false;
            skipped += mut.expect.length;
          } else {
            record = { kind: 'edit', file: mut.file, original };
            // `nth`：同一串值在多个块里重复出现（蒙层在抽屉与弹窗各一份），
            // 用第 n 处定位，避免"改错了块"被记成"断言不灵"
            overrideFile(mut.file, replaceWithin(txt, find, repl, mut.within)); // 内存破坏，不写磁盘
          }
        }
      }

      if (okApply) {
        const res = runAll(loadSources(), mut.expect);
        console.log(`🔴 ${mut.name}`);
        for (const id of mut.expect) {
          total++;
          const isRed = res[id] && res[id].ok === false;
          if (isRed) {
            red++;
            console.log(`  ✓ ${id} 按预期变红`);
          } else {
            falsePositives.push(id);
            console.log(`  ✗ ${id} 该红没红 ← 假阳性（断言测不到它声称捕捉的改错）`);
          }
          if (!wasGreenBase[id]) console.log(`     注：${id} 基线本就是红，无法据此判定断言有效性`);
        }
      }
    } finally {
      // 精确按字节恢复。
      //
      // 🔴 **恢复动作一律不许抛出** —— 这一条是实测换来的：`unlinkSync` 在被宿主的删除守卫
      //   拦下时（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）会直接抛，而 `finally` 里抛出的异常
      //   会掀翻**整个反证轮**，后果有两个、且都是最难查的那种：
      //     (a) 后面所有改错**一条都不跑**（本轮"应执行 44 条"实际只跑了一半）；
      //     (b) 源码树被留在**被改坏**的状态 —— 于是**下一次 `check:units` 正向轮**
      //         莫名其妙少一条（实测 37 → 36），而报错只说"文档写 37、脚本实际 36"，
      //         **完全指不到这里**（`check:docs` 正是拿正向轮的自报条数去比文档的）。
      //   所以：失败的恢复只**登记**，由下面的「恢复校验」段统一判红（那里本来就会读盘复核）。
      if (record) {
        try {
          if (record.kind === 'rename' && existsSync(record.to)) renameSync(record.to, record.from);
          else if (record.kind === 'create' && existsSync(record.file)) unlinkSync(record.file);
          else if (record.kind === 'edit') overrideFile(record.file, null); // 清除内存覆盖（磁盘从未被写）
        } catch (err) {
          restoreErrors.push({ ...record, error: String(err).slice(0, 200) });
          console.log(
            `  ⚠ 恢复失败（已登记，稍后统一判红）：${path.relative(ROOT, record.file ?? record.from)}` +
              ` —— ${String(err).slice(0, 160)}`,
          );
        }
        applied.push(record);
      }
    }
  }

  // 恢复校验：改过的按字节比对；改名的确认回位；新建的确认已删除
  console.log('\n恢复校验');
  let restoreFail = 0;
  for (const r of applied) {
    if (r.kind === 'edit') {
      const back = existsSync(r.file) ? readFileSync(r.file) : null; // 直接读磁盘，确认从未被污染
      const same = back != null && back.equals(r.original);
      if (!same) restoreFail++;
      console.log(`  ${same ? '✓' : '✗'} ${path.relative(ROOT, r.file)} 字节${same ? '一致' : '不一致！'}`);
    } else if (r.kind === 'rename') {
      const back = existsSync(r.from) ? readFileSync(r.from) : null;
      const same = back != null && back.equals(r.original) && !existsSync(r.to);
      if (!same) restoreFail++;
      console.log(`  ${same ? '✓' : '✗'} ${path.relative(ROOT, r.from)} 已回位且字节${same ? '一致' : '不一致！'}`);
    } else if (r.kind === 'create') {
      const gone = !existsSync(r.file);
      if (!gone) restoreFail++;
      console.log(`  ${gone ? '✓' : '✗'} ${path.relative(ROOT, r.file)} 临时新建已清除`);
    }
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红（应执行 ${expectedTotal} 条）`);
  if (total !== expectedTotal) console.log(`✗ 实际执行 ${total} 条 ≠ 写死的 ${expectedTotal} 条（有破坏被静默跳过）`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证（锚点未找到/源文件缺席）—— 跳过 ≠ 通过`);
  if (restoreFail) console.log(`✗ 有 ${restoreFail} 个文件未恢复到原始字节`);
  if (restoreErrors.length)
    console.log(
      `✗ 有 ${restoreErrors.length} 个**恢复动作本身**失败（多半是宿主的删除守卫/权限）—— 源码树可能未复原，` +
        `请先手工核对再重跑：\n    ${restoreErrors
          .map((r) => `${path.relative(ROOT, r.file ?? r.from)}：${r.error}`)
          .join('\n    ')}`,
    );
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(', ')}`);
  process.exitCode = red === total && total === expectedTotal && skipped === 0 && restoreFail === 0 ? 0 : 1;
}
