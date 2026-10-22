#!/usr/bin/env node
/**
 * 设置页的**验收断言**（设置页是唯一一屏"服务没起来也照常显示"的界面，见《09》§3.2）——
 * 且必须**可反证**。
 *
 * 覆盖两组，因为它们的失效形态是同一类（**编译得过、不抛错、界面就是不对**）：
 *   ③ 播放·媒体 ——「能实现 / 不能实现」重新裁定（EXCLUDED…CACHE 八组）
 *   ② 翻译服务 —— 十三项全部接真实能力 + 引擎诊断视图（ENGINE 一组）
 *
 * ## 为什么需要它
 *
 * ③ 那次改动的本质是「把 5 项做不到的剔除、把 8 项能做到的补全」，它同时横跨五层，
 * 每层的静默失败各不相同：
 *
 *   CATALOG  src/screens/settings/catalog.ts        数据源（剔除了吗 / 补进了吗 / 项数对得上吗）
 *   WIRING   src/screens/settings/sections.tsx      设置页是否真的渲染控件、是否遍历三小节
 *   STORE    src/modules/music/store.ts                     六个偏好字段（默认值 / setter / 持久化）
 *   PLAYER   src/screens/music/ExpandedPlayer.tsx   偏好是否真的落到播放器（CSS 变量 / 条件类名）
 *   OPTIONS  src/modules/music/player-options.ts            选项常量的单一事实源（防设置页/播放器两套皮肤名）
 *
 * 最危险的两种假绿，本脚本专门防：
 *   ① 「只在数据里标 live、UI 不渲染控件」—— 于是分四层断言：catalog 有 live 项、
 *      sections.tsx 真的遍历三小节且每项都有取项/分派点、每项对应的 store setter 被真正取用。
 *   ② 「算出了 CSS 变量/类名却没挂到节点上」—— 只查字面量 `--lyr-hl` 是否存在会被骗，
 *      必须追到「这个变量所在的对象/数组确实被 `style={…}` / `className={…}` 消费」。
 *
 * 同一把尺子也适用于剔除：`catalog.ts` 的 note 里**故意用中文**记录了被剔除项的理由
 * （「剔除『音频输出』：…」），这是文档而非数据。所以剔除判据落在「**设置项条目**」
 * 上（迭代出来的 `items[].id/label` 与引号包裹的 id/label 字面量），
 * 不会把 note 里那句说明误判成「剔除项又回来了」。
 *
 * ## ENGINE 组的两条通用手法（新增判据时优先复用）
 *   · `stripComments()`：注释里能写、代码里不能写（或反过来）的判据必须先剥注释。
 *     本仓注释密度高且大量引用类名/组件名，不剥会把"说明"当成"违规"（假红），
 *     也会把注释里的举例当成实现（假绿）。
 *   · **反向**取类名：从组件源码里抽出用到的类，逐个要求样式里有规则 ——
 *     正向写清单测不到"组件用了新类但忘了写 CSS"，而那正是新增一整块 UI 时的常见空缺。
 *
 * 用法：
 *   node e2e/settings-media-check.mjs            正向跑（期望全绿）
 *   node e2e/settings-media-check.mjs --refute   反证轮（破坏源文件 → 断言必须变红 → 按字节还原）
 *
 * 注意：本脚本禁止出现某个历史品牌标识的字面量（项目已清除该品牌词），需要提及时写「参考实现」。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readStyleSource } from './_styles-source.mjs';
import { clearFileCache } from './_file-cache.mjs';
import { mergedScripts } from './_commands.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = ROOT;

const F = {
  catalog: path.join(APP, 'src', 'screens', 'settings', 'catalog.ts'),
  // D-150：`sections.tsx` 已按 Section 拆到 `sections/*.tsx`（含 index 桶与 shared）。
  sectionsDir: path.join(APP, 'src', 'screens', 'settings', 'sections'),
  // 变异锚的落点（各 Section 各自一件）
  secGeneral: path.join(APP, 'src', 'screens', 'settings', 'sections', 'GeneralSection.tsx'),
  secTranslate: path.join(APP, 'src', 'screens', 'settings', 'sections', 'TranslateSection.tsx'),
  secMedia: path.join(APP, 'src', 'screens', 'settings', 'sections', 'MediaSection.tsx'),
  secAbout: path.join(APP, 'src', 'screens', 'settings', 'sections', 'AboutSection.tsx'),
  store: path.join(APP, 'src', 'modules', 'music', 'store.ts'),
  // D-156：music/store.ts 的 action 段已按切片切到 music/actions/*.ts。
  actionsDir: path.join(APP, 'src', 'modules', 'music', 'actions'),
  options: path.join(APP, 'src', 'modules', 'music', 'player-options.ts'),
  expanded: path.join(APP, 'src', 'screens', 'music', 'ExpandedPlayer.tsx'),
  musicScreen: path.join(APP, 'src', 'screens', 'MusicScreen.tsx'),
  main: path.join(APP, 'src', 'main.tsx'),
  // 🔴 桌面守卫的**实现**在 `tools/desktopGards.ts`（2026-10-16 由 038dc7d 从 main.tsx 搬出）。
  //    main.tsx 只剩 `installDesktopGuards();` 这一行调用 —— 断言若继续只读 main.tsx，
  //    就变成"只钉住调用、没钉住实现"：把 contextmenu 那段从 desktopGards.ts 删掉它照样绿。
  //    两处必须**都**读：调用在 main.tsx，实现在这里。
  desktopGuards: path.join(APP, 'src', 'tools', 'desktopGards.ts'),
  // 「音乐缓存」通栏四格的实现（放 screens/settings/ 而非 components/units/ ——
  // 后者的文件清单被 units-structure-check 的 MANIFEST 锁死为 12 个，多一个即红）
  cacheBlock: path.join(APP, 'src', 'screens', 'settings', 'CacheBlock.tsx'),
  // ② 翻译服务（S6）的四个新文件 + 两个被它复用的排版件
  engineApi: path.join(APP, 'src', 'screens', 'settings', 'engine-api.ts'),
  engineState: path.join(APP, 'src', 'screens', 'settings', 'engine-state.ts'),
  engineDiag: path.join(APP, 'src', 'screens', 'settings', 'EngineDiag.tsx'),
  modelManage: path.join(APP, 'src', 'screens', 'settings', 'ModelManageBlock.tsx'),
  numberInput: path.join(APP, 'src', 'components', 'units', 'NumberInput.tsx'),
  parts: path.join(APP, 'src', 'screens', 'settings', 'parts.tsx'),
  specCheck: path.join(APP, 'src', 'screens', 'settings', 'SpecCheck.tsx'),
  settingsScreen: path.join(APP, 'src', 'screens', 'SettingsScreen.tsx'),
  // X-C3「准备中」屏（S6 的「L1–L4 文案 + 首张稍慢」）。它不在设置页里，
  // 但它与设置页共享同一条事实源（Rust 的 StatusView），所以放同一轮断言。
  notReady: path.join(APP, 'src', 'screens', 'manga', 'NotReadyScreen.tsx'),
  // D-233：五段常量与纯函数（assembly.ts）+ 时间线渲染（AssemblyTimeline.tsx）
  assembly: path.join(APP, 'src', 'screens', 'manga', 'assembly.ts'),
  timeline: path.join(APP, 'src', 'screens', 'manga', 'AssemblyTimeline.tsx'),
  // 未就绪屏「使用在线翻译」卡片里的内嵌表单（同一屏的另一半，判据同源）
  ipc: path.join(APP, 'src', 'ipc', 'index.ts'),
  nav: path.join(APP, 'src', 'stores', 'nav.ts'),
  // 断言读到的 css 是全分片拼接（见 loadSources）。
  // `mangaStyle` 是 X-C3 那组规则所在的分片，仅在"反证要定点破坏某条 CSS 规则"时用
  // （`stylesDir` 是目录，没法直接改）。
  stylesDir: path.join(APP, 'src', 'styles'),
  mangaStyle: path.join(APP, 'src', 'styles', 'manga.scss'),
  // ② 分组简洁化（组说明折叠 / 空闲卸载合卡 / 三处警告统一）的规则都在 settings.scss；
  // 状态 chip 与令牌输入框在 components.scss（那是"通用控件"分片）。
  // 反证要**定点破坏某条 CSS 规则**时必须有具体文件，`stylesDir` 是目录改不了。
  settingsStyle: path.join(APP, 'src', 'styles', 'settings.scss'),
  componentsStyle: path.join(APP, 'src', 'styles', 'components.scss'),
  // D-84 · 功能梳理落地的四个接入点：
  //   def 渲染（parts 的 DefaultChip）· 侧栏标签偏好（shell-prefs + Sidebar + App）
  //   · 存储占用三行（StorageBlock）· 第三方许可（生成物 + 块 + 生成脚本）
  shellPrefs: path.join(APP, 'src', 'stores', 'shell-prefs.ts'),
  sidebar: path.join(APP, 'src', 'components', 'Sidebar.tsx'),
  tokens: path.join(APP, 'src', 'themes', 'tokens.ts'),
  // 随仓字体根目录（每个子目录 = 一份 `<dir>/font.css` 清单 + 其字体文件）。
  // FONT 组按目录**扫描**而不写死具体字体名 —— 字体更替（GenJyuu → LXGW / Yozai / Swei）
  // 不该逼着断言跟着改名（2026-10-10 那次替换踩过：三条断言写死 GenJyuu，删字体时全红）。
  // 随仓字体根目录（每个子目录 = 一份 `<dir>/font.css` 清单 + 其字体文件）。
  // 🔴 2026-10-16 起它们在 `public/assets/fonts/`（公共资源，不经过构建）——
  //    判据随搬家改写为"入口 HTML 有没有 link 它"，见 FONT 组。
  fontsDir: path.join(APP, 'public', 'assets', 'fonts'),
  entryHtml: path.join(APP, 'templates', 'index.html'),
  appMain: path.join(APP, 'src', 'App.tsx'),
  // B1 起设置屏是**路由表里的屏装配件**，壳层 → 设置页那三个 prop 的接线落在它身上
  settingsPane: path.join(APP, 'src', 'router', 'panes', 'SettingsPane.tsx'),
  storageBlock: path.join(APP, 'src', 'screens', 'settings', 'StorageBlock.tsx'),
  licensesBlock: path.join(APP, 'src', 'screens', 'settings', 'LicensesBlock.tsx'),
  licensesJson: path.join(APP, 'src', 'generated', 'licenses.json'),
  genScript: path.join(APP, 'scripts', 'gen-licenses.mjs'),
  // 生成物与来源文件的对账需要它们（同 `ROOT` 下的 package.json / 命令清单 / app 下的 lock）
  pkgJson: path.join(ROOT, 'package.json'),
  // 命令收束后 `gen:licenses` 登记在命令清单里（`npm run task -- gen:licenses`），不再在 package.json
  e2eScripts: path.join(ROOT, 'e2eScripts.json'),
  npmLock: path.join(APP, 'package-lock.json'),
  cargoLock: path.join(APP, 'src-tauri', 'Cargo.lock'),
  // C5：引擎资产清单 —— 许可段的第三处来源，也要参与过期对账
  engineManifest: path.join(ROOT, 'engine', 'models.manifest.json'),
};

// ── 冻结的契约（负责人冻结，本脚本照抄，不改口径） ──────────────────────────

/** ① 已剔除、不得再出现在设置页数据源里的 5 项（id ↔ 中文标签） */
const EXCLUDED = [
  { id: 'audio-output', label: '音频输出' },
  { id: 'equalizer', label: '均衡器' },
  { id: 'media-keys', label: '媒体键' },
  { id: 'lyrics-default', label: '桌面歌词默认值' },
  { id: 'audio-cache', label: '音频缓存目录' },
];

/** ①b 已**整条删除**、不得再回到设置页数据源里的 2 项。
 *  与 EXCLUDED 的区别：EXCLUDED 是「参考实现里有、本移植决定不做」；
 *  RETIRED 是「**我们曾经列进设置页、后经拍板整条删掉**」。
 *  catalog.ts:20-23 的纪律是「做不到的项宁可整条删掉，也不要留一条永远待接入」，
 *  所以这两项一旦回来，是规格倒退而不是"功能补齐"。 */
const RETIRED = [
  { id: 'cache-clean', label: '缓存清理' },
  { id: 'check-update', label: '检查更新' },
];

/** ② MEDIA 组里必须存在且为 live 的 12 项（id ↔ 中文标签）
 *  后两项是桌面歌词（P3 落地后恢复）—— 此前它们以"需独立置顶窗口，延后"为由被剔除，
 *  该前提已不成立（《09》§5.6 第 1 项拍板要做独立窗口），故恢复。
 *  「音乐缓存」是通栏四格（`layout: 'block'`），不是标准两栏行。
 *  「歌词高亮方式」是逐字/整行开关（本项目新增，参考实现无此开关），用 Select。 */
const ADDED = [
  { id: 'quality', label: '音质档位' },
  { id: 'skin', label: '展开播放器皮肤' },
  { id: 'dynamic-bg', label: '动态背景' },
  { id: 'disc-mode', label: '碟片模式' },
  { id: 'lyrics-mode', label: '歌词高亮方式' },
  { id: 'lyrics-size', label: '歌词字号' },
  { id: 'lyrics-color', label: '歌词高亮色' },
  { id: 'lyrics-window', label: '桌面歌词窗口' },
  { id: 'lyrics-locked', label: '锁定歌词窗口' },
  { id: 'vinyl-color-mode', label: '彩胶配色' },
  { id: 'vinyl-color', label: '彩胶自定义色' },
  { id: 'music-cache', label: '音乐缓存' },
];

/** ③ MEDIA 的三小节 id（顺序即渲染顺序） */
const MEDIA_GROUPS = ['playback', 'lyrics', 'vinyl'];

/** ③ 全表项数自校常量应等于的合计
 *  26（初版）→ 29（③ 组 5 项 pending → 8 项 live）→ 31（P3 桌面歌词恢复 2 项）
 *  → 32（加「音乐缓存」1 项）→ 33（加「歌词高亮方式」1 项）
 *  → 31（整条剔除「缓存清理」「检查更新」2 项，见 RETIRED）
 *  → **32**（② 服务与配对加「自动启动翻译服务」1 项，台账 D-94：让"不翻译就别把
 *     引擎拉起来"成为可配置项，关掉后改由未就绪屏的「启动本地服务」手动拉起）
 *  → **33**（② 推理引擎加「翻译方向」1 项，ver2.1：把"方向逐任务下发、英译中走离线 nllb"
 *     写进界面 —— 否则引擎诊断里的「源语言：按任务方向」没有一处能自答）
 *  → **34**（② 加「翻译来源」小节 1 项，ver2.2：在线翻译并入 ② 作为第一个小节（P-D2）
 *     —— 来源二选一（本地引擎 / 在线 API），是服务的设置不是任务属性（P-D1）） */
const SPEC_TOTAL = 34;

/** ④ 设置页必须真正取用的 store setter（逐项对应的控件回写） */
const MEDIA_SETTERS = [
  'setPlaybackQuality',
  'setSkin',
  'setDynamicEnabled',
  'setDiscMode',
  'setLyricsMode',
  'setLyricsFontSize',
  'setLyricsHighlightColor',
  'setVinylColorMode',
  'setVinylCustomColor',
];

/** ⑤ store 侧七个偏好字段 ↔ 各自 setter（判据只认实现体，不认 interface 声明） */
const STORE_FIELDS = [
  { field: 'lyricsFontSize', setter: 'setLyricsFontSize' },
  { field: 'lyricsHighlightColor', setter: 'setLyricsHighlightColor' },
  { field: 'lyricsMode', setter: 'setLyricsMode' },
  { field: 'dynamicEnabled', setter: 'setDynamicEnabled' },
  { field: 'discMode', setter: 'setDiscMode' },
  { field: 'vinylColorMode', setter: 'setVinylColorMode' },
  { field: 'vinylCustomColor', setter: 'setVinylCustomColor' },
];

/** ⑦ 选项常量单一事实源应导出的常量 */
const OPTION_EXPORTS = [
  'SKINS',
  'QUALITY_OPTIONS',
  'LYRICS_SIZE',
  'LYRICS_COLORS',
  'LYRICS_MODE_OPTIONS',
  'LYRICS_MODE_DEF',
  'VINYL_COLOR_DEF',
  'LYRICS_COLOR_DEF',
];

// ── 读文件 ───────────────────────────────────────────────────────────────
const readMaybe = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const readBytes = (p) => (existsSync(p) ? readFileSync(p) : null);

function loadSources() {
  return {
    catalog: readMaybe(F.catalog),
    // D-150：设置页 5 个 Section 已拆成 `sections/*.tsx`。判据读**拼接源码**（只关心
    // "关键字/函数体在不在"）。🔴 **逐文件单独 `stripComments` 再拼** —— `stripComments`
    // 带状态机，直接拼原文会让前一个文件的失同步污染后一个（D-148/D-149 同类坑）。
    sections: readdirSync(F.sectionsDir)
      .filter((n) => n.endsWith('.tsx'))
      .map((n) => stripComments(readMaybe(path.join(F.sectionsDir, n))))
      .join('\n'),
    // D-156：`store.ts` 的 action 段已切到 `music/actions/*.ts`（setter / hydratePrefs 等）。
    // 读「store.ts + 全部切片」的逐文件 strip 拼接 —— 否则 STORE.setter.* / STORE.hydrate.*
    // 会因切片而假红（本次实测 8 条）。目录动态列举 ⇒ 以后每切一段自动覆盖。
    store: [
      F.store,
      ...readdirSync(F.actionsDir)
        .filter((n) => n.endsWith('.ts'))
        .map((n) => path.join(F.actionsDir, n)),
    ]
      .map((p) => stripComments(readMaybe(p)))
      .join('\n'),
    options: readMaybe(F.options),
    expanded: readMaybe(F.expanded),
    musicScreen: readMaybe(F.musicScreen),
    main: readMaybe(F.main),
    desktopGuards: readMaybe(F.desktopGuards),
    entryHtml: readMaybe(F.entryHtml),
    cacheBlock: readMaybe(F.cacheBlock),
    engineApi: readMaybe(F.engineApi),
    engineState: readMaybe(F.engineState),
    engineDiag: readMaybe(F.engineDiag),
    modelManage: readMaybe(F.modelManage),
    numberInput: readMaybe(F.numberInput),
    parts: readMaybe(F.parts),
    specCheck: readMaybe(F.specCheck),
    settingsScreen: readMaybe(F.settingsScreen),
    notReady: readMaybe(F.notReady),
    assembly: readMaybe(F.assembly),
    timeline: readMaybe(F.timeline),
    ipc: readMaybe(F.ipc),
    nav: readMaybe(F.nav),
    shellPrefs: readMaybe(F.shellPrefs),
    sidebar: readMaybe(F.sidebar),
    tokens: readMaybe(F.tokens),
    appMain: readMaybe(F.appMain),
    settingsPane: readMaybe(F.settingsPane),
    storageBlock: readMaybe(F.storageBlock),
    licensesBlock: readMaybe(F.licensesBlock),
    licensesJson: readMaybe(F.licensesJson),
    genScript: readMaybe(F.genScript),
    pkgJson: readMaybe(F.pkgJson),
    npmLock: readMaybe(F.npmLock),
    cargoLock: readMaybe(F.cargoLock),
    engineManifest: readMaybe(F.engineManifest),
    // 全分片拼接（顺序 = index.scss 的 @use 顺序 = 层叠顺序），
    // 不是读单个 app.css —— 样式已按模块拆分，读单文件会集体变红（读不到 ≠ 真回归）
    css: readStyleSource(F.stylesDir),
  };
}

/**
 * 直接**导入** catalog.ts（Node 22 的类型擦除），拿到的是**真实数据结构**而不是字符串。
 *
 * 为什么不用正则数项数：③ 要求「真的把 5 个分组 + 各小节 items 数出来求和」，
 * 正则数 `{` 会被字符串/注释干扰。导入后 `SETTINGS_SECTIONS` 就是数组本身，
 * `.reduce(...items.length)` 是货真价实的求和。反证轮写入破坏后再导入时必须绕过
 * ESM 模块缓存 —— 用自增的 `?v=` 查询串即可强制重新求值（已验证不同查询串 → 不同实例）。
 */
let importSeq = 0;
async function loadCatalog() {
  try {
    const url = `${pathToFileURL(F.catalog).href}?v=${++importSeq}`;
    const mod = await import(url);
    return { mod, err: null };
  } catch (e) {
    return { mod: null, err: e && e.message ? e.message : String(e) };
  }
}

// ── 小工具 ───────────────────────────────────────────────────────────────
const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const q = (s) => `['"]${esc(s)}['"]`;

/** 从 src[i]（应为 { [ (）起，读到配对的收括号，返回**含括号**的子串；跳过字符串与注释 */
function readBalanced(src, i) {
  const open = src[i];
  const close = { '{': '}', '[': ']', '(': ')' }[open];
  if (!close) return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') {
      j = skipString(src, j);
      continue;
    }
    if (c === '/' && src[j + 1] === '/') {
      j = skipLineComment(src, j);
      continue;
    }
    if (c === '/' && src[j + 1] === '*') {
      j = skipBlockComment(src, j);
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return null;
}
function skipString(src, i) {
  const quote = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') {
      j++;
      continue;
    }
    if (src[j] === quote) return j;
  }
  return src.length - 1;
}
function skipLineComment(src, i) {
  const n = src.indexOf('\n', i);
  return n < 0 ? src.length - 1 : n;
}
function skipBlockComment(src, i) {
  const n = src.indexOf('*/', i + 2);
  return n < 0 ? src.length - 1 : n + 1;
}

/**
 * 剥掉注释，保留其余字节 —— 用于「**注释里能写、代码里不能写**」这类判据。
 *
 * 为什么需要它：本仓的注释密度很高（每个非显然的决定都带一段说明），于是
 * 「源码里出现过 xxx」这种判据会被注释里的举例骗过（假绿），
 * 而「源码里不许出现 xxx」又会被注释里的引用误伤（假红）。
 * 两个方向都有真实案例，所以需要一个**按语法剥注释**的版本，而不是用正则凑合。
 *
 * 字符串内容**保留**（不剥）：JSX 里 `{'**'}` 与属性值同样会渲染到界面上，
 * 它们和裸文本一样属于"用户看得见的地方"。
 *
 * 实现直接复用上面的 `skipString` / `skipLineComment` / `skipBlockComment` ——
 * 三份扫描逻辑若有分歧，判据就会在"某一种注释"上开始漂移。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const j = skipString(src, i);
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      i = skipLineComment(src, i); // 停在 `\n` 上，下一轮把它原样收进去
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i = skipBlockComment(src, i) + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 取 `const|let|var <name> = <{...}|[...]>` 的初始化区（对象/数组字面量） */
function declRegion(src, name) {
  const m = new RegExp(`(?:const|let|var)\\s+${esc(name)}\\b`).exec(src);
  if (!m) return null;
  const eq = src.indexOf('=', m.index + m[0].length);
  if (eq < 0) return null;
  let k = eq + 1;
  while (k < src.length && /\s/.test(src[k])) k++;
  if (src[k] !== '{' && src[k] !== '[') return null;
  return readBalanced(src, k);
}

/**
 * 某个标记是否**真的被 JSX 属性消费**（而不是「算出来了却没人用」）。
 *
 * 判据：遍历所有 `<attr>={…}`；取出其表达式；若表达式是一个标识符，
 * 再顺着该标识符的 `const X = {…}/[…]` 声明下钻一层。任一处文本满足 pred 即算消费。
 * 刻意**不写死变量名**（rootStyle / rootClass / …），因为它随时可能被重构改名。
 */
function appliedWhere(src, attr, pred) {
  const re = new RegExp(`${attr}=\\{`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const brace = src.indexOf('{', m.index + attr.length);
    const slice = readBalanced(src, brace);
    if (!slice) continue;
    const inner = slice.slice(1, -1).trim();
    const texts = [inner];
    if (/^[A-Za-z_$][\w$]*$/.test(inner)) {
      const region = declRegion(src, inner);
      if (region) texts.push(region);
    }
    if (texts.some((t) => pred(t))) return true;
  }
  return false;
}

/** 标记是否出现在「同一行的三元/短路」里（即「按条件加」），与变量名解耦 */
function tokenConditional(src, token) {
  let idx = -1;
  while ((idx = src.indexOf(token, idx + 1)) >= 0) {
    const lineStart = src.lastIndexOf('\n', idx) + 1;
    if (/[?]|&&/.test(src.slice(lineStart, idx))) return true;
  }
  return false;
}

/** 取 zustand store 里 `name: (…) => { … }` 的实现体（花括号计数）；只认实现体，不认 interface 声明 */
function methodBody(src, name) {
  const re = new RegExp(`\\n\\s*${esc(name)}:\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`, 'g');
  const all = [...src.matchAll(re)];
  if (!all.length) return null;
  const m = all[all.length - 1];
  const start = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 取 `function <name>(…) { … }` 的函数体。
 *
 * 两处必须讲究，否则判据会**恒红或恒绿**：
 *
 * ① `export` 前缀可选：屏内私有件（`Group` / `formatBytes`）本来就不导出，
 *    而判据要看的恰恰是它们。强制 `export` 会让断言找不到函数体。
 *    可选化不改变已有用法的结果：`export function X` 仍先于 `function X` 匹配。
 *
 * ② **必须先跳过形参表再找 `{`**：`Group({ group, render }: { … })` 的第一个
 *    `{` 是**解构模式**，不是函数体。从它开始数括号会得到"形参解构"这一段，
 *    于是函数体判据全部落空（表现为"分支不存在"的假红）。
 */
function fnBody(src, name) {
  const m = new RegExp(`(?:export\\s+)?function\\s+${esc(name)}\\b`).exec(src);
  if (!m) return null;
  // 形参表：从函数名之后第一个 `(` 起做括号配对（跳过字符串与注释）
  const parenAt = src.indexOf('(', m.index + m[0].length);
  if (parenAt < 0) return null;
  const params = readBalanced(src, parenAt);
  if (!params) return null;
  // 形参表之后（可能隔着返回类型标注）的第一个 `{` 才是函数体
  const start = src.indexOf('{', parenAt + params.length);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/** 展平一个 section 的所有 item */
function flatItems(section) {
  const out = [];
  for (const g of section?.groups ?? []) for (const it of g?.items ?? []) out.push(it);
  return out;
}

// ── 断言表：{ id, group, run(ctx) -> {ok, detail} } ───────────────────────
const A = [];
const add = (id, group, run) => A.push({ id, group, run });

const CAT_ERR = (cat) => (cat?.err ? `catalog.ts 导入失败（无法验证数据结构）：${cat.err}` : null);

// ============================ ① EXCLUDED ============================
for (const ex of EXCLUDED) {
  add(`EXCLUDED.${ex.id}`, 'EXCLUDED', (ctx) => {
    const { s, cat } = ctx;
    const problems = [];
    // 原始文本里不得再有该 id 字面量（id 从不出现在 note 的说明里，故可严格判）
    if (new RegExp(q(ex.id)).test(s.catalog)) problems.push(`catalog.ts 文本里仍有 id 字面量 ${ex.id}`);
    // 引号包裹的中文标签：note 里用的是「」中文书名号，不会命中
    if (new RegExp(q(ex.label)).test(s.catalog)) problems.push(`catalog.ts 文本里仍有标签字面量「${ex.label}」`);
    // 真实数据结构里不得再有该 item（覆盖注释/非迭代结构之外的一切）
    const dataErr = CAT_ERR(cat);
    if (dataErr) problems.push(dataErr);
    else {
      const items = (cat.mod.SETTINGS_SECTIONS ?? []).flatMap(flatItems);
      if (items.some((i) => i.id === ex.id)) problems.push(`SETTINGS_SECTIONS 里仍有项 id=${ex.id}`);
      if (items.some((i) => i.label === ex.label)) problems.push(`SETTINGS_SECTIONS 里仍有项 label=${ex.label}`);
    }
    return { ok: problems.length === 0, detail: problems.join('；') };
  });
}

// ============================ ①b RETIRED ============================
for (const r of RETIRED) {
  add(`RETIRED.${r.id}`, 'RETIRED', (ctx) => {
    const { cat } = ctx;
    const dataErr = CAT_ERR(cat);
    if (dataErr) return { ok: false, detail: dataErr };
    const items = (cat.mod.SETTINGS_SECTIONS ?? []).flatMap(flatItems);
    const problems = [];
    if (items.some((i) => i.id === r.id)) problems.push(`SETTINGS_SECTIONS 里又有项 id=${r.id}（已拍板整条删除）`);
    if (items.some((i) => i.label === r.label))
      problems.push(`SETTINGS_SECTIONS 里又有项 label=${r.label}（已拍板整条删除）`);
    return { ok: problems.length === 0, detail: problems.join('；') };
  });
}

// ============================ ② ADDED ============================
for (const a of ADDED) {
  add(`ADDED.${a.id}`, 'ADDED', (ctx) => {
    const { cat } = ctx;
    const dataErr = CAT_ERR(cat);
    if (dataErr) return { ok: false, detail: dataErr };
    const items = flatItems(cat.mod.MEDIA);
    const hit = items.find((i) => i.id === a.id);
    if (!hit) return { ok: false, detail: `MEDIA 里缺项 id=${a.id}（应补进来）` };
    const problems = [];
    if (hit.state !== 'live') problems.push(`state=${hit.state}，应为 live（live 才会渲染真实控件）`);
    if (hit.label !== a.label) problems.push(`label=${hit.label}，应为「${a.label}」`);
    return { ok: problems.length === 0, detail: problems.join('；') };
  });
}
add('ADDED.groups', 'ADDED', (ctx) => {
  const { cat } = ctx;
  const dataErr = CAT_ERR(cat);
  if (dataErr) return { ok: false, detail: dataErr };
  const ids = (cat.mod.MEDIA?.groups ?? []).map((g) => g.id);
  const exact = ids.length === MEDIA_GROUPS.length && MEDIA_GROUPS.every((g, i) => ids[i] === g);
  return {
    ok: exact,
    detail: exact ? '' : `MEDIA 小程序应为 [${MEDIA_GROUPS.join(', ')}]（按此顺序），实为 [${ids.join(', ')}]`,
  };
});
add('ADDED.total', 'ADDED', (ctx) => {
  const { cat } = ctx;
  const dataErr = CAT_ERR(cat);
  if (dataErr) return { ok: false, detail: dataErr };
  const n = flatItems(cat.mod.MEDIA).length;
  return { ok: n === ADDED.length, detail: n === ADDED.length ? '' : `MEDIA 项数 ${n}，应为 ${ADDED.length}` };
});

// ============================ ③ COUNT ============================
add('COUNT.sections', 'COUNT', (ctx) => {
  const { cat } = ctx;
  const dataErr = CAT_ERR(cat);
  if (dataErr) return { ok: false, detail: dataErr };
  const n = (cat.mod.SETTINGS_SECTIONS ?? []).length;
  return { ok: n === 5, detail: n === 5 ? '' : `SETTINGS_SECTIONS 有 ${n} 个分组，应为 5` };
});
add('COUNT.total', 'COUNT', (ctx) => {
  const { cat } = ctx;
  const dataErr = CAT_ERR(cat);
  if (dataErr) return { ok: false, detail: dataErr };
  // 真的逐分组、逐小节把 items 数出来求和（不是查字符串里有没有 "29"）
  const perSection = (cat.mod.SETTINGS_SECTIONS ?? []).map(
    (sec) => `${sec.id}=${(sec.groups ?? []).reduce((n, g) => n + (g.items ?? []).length, 0)}`,
  );
  const total = (cat.mod.SETTINGS_SECTIONS ?? []).reduce(
    (n, sec) => n + (sec.groups ?? []).reduce((m, g) => m + (g.items ?? []).length, 0),
    0,
  );
  return {
    ok: total === SPEC_TOTAL,
    detail: total === SPEC_TOTAL ? '' : `实际合计 ${total}（${perSection.join(', ')}），应为 ${SPEC_TOTAL}`,
  };
});
add('COUNT.specMatches', 'COUNT', (ctx) => {
  const { cat } = ctx;
  const dataErr = CAT_ERR(cat);
  if (dataErr) return { ok: false, detail: dataErr };
  const computed = (cat.mod.SETTINGS_SECTIONS ?? []).reduce(
    (n, sec) => n + (sec.groups ?? []).reduce((m, g) => m + (g.items ?? []).length, 0),
    0,
  );
  const spec = cat.mod.SPEC_ITEM_TOTAL;
  return {
    ok: spec === computed,
    detail: spec === computed ? '' : `SPEC_ITEM_TOTAL=${spec} 与实际合计 ${computed} 不一致（自校常量已漂移）`,
  };
});

// ============================ ③b NOTE 正文数字 ============================
add('NOTE.count', 'NOTE', (ctx) => {
  /*
   * 各分组 note 里写的「本组 N 项」「共 N 项」必须等于**数据实算**的项数。
   *
   * 为什么要它：`MEDIA.note` 曾长期写「本组 11 项 / 共 11 项」，而数据实为 12 ——
   * 左栏由 `sectionItemCount()` 算出的计数就显示 12，**同一屏两个数字互相打架**，
   * 用户不读源码就能看出页面自相矛盾。这类"正文数字与数据脱节"编译不报错、
   * 断言之外无人察觉，正是本门该覆盖的形态。判据取数据、不取字符串：
   * note 是可以随便写的散文，唯一可信的项数只有 `items.length` 的和。
   */
  const { cat } = ctx;
  const dataErr = CAT_ERR(cat);
  if (dataErr) return { ok: false, detail: dataErr };
  const problems = [];
  for (const sec of cat.mod.SETTINGS_SECTIONS ?? []) {
    const note = typeof sec?.note === 'string' ? sec.note : '';
    const actual = (sec.groups ?? []).reduce((n, g) => n + (g.items ?? []).length, 0);
    for (const re of [/本组\s*(\d+)\s*项/g, /共\s*(\d+)\s*项/g]) {
      for (const m of note.matchAll(re)) {
        const claimed = Number(m[1]);
        if (claimed !== actual) {
          problems.push(`${sec.id}: note 写「${m[0]}」，数据实算 ${actual} 项`);
        }
      }
    }
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

// ============================ ④ WIRING ============================
add('WIRING.groups.traverse', 'WIRING', (ctx) => ({
  ok: /MEDIA\.groups\.(?:map|forEach|reduce)\s*\(/.test(ctx.s.sections),
  detail: 'sections.tsx 的 MediaSection 应遍历 MEDIA.groups（三小节都渲染）',
}));
add('WIRING.groups.noFirst', 'WIRING', (ctx) => {
  const hit = /MEDIA\.groups\s*\[\s*0\s*\]/.test(ctx.s.sections);
  return {
    ok: !hit,
    detail: hit ? 'sections.tsx 出现 MEDIA.groups[0]：只取第一小节，会静默漏掉「歌词 / 透明彩胶」' : '',
  };
});
add('WIRING.itemRefs.exist', 'WIRING', (ctx) => {
  /*
   * `sections.tsx` 里每一处 `itemOf(<组>, '<id>')` 指向的 id 都必须在 catalog 里真的存在。
   *
   * 为什么必须单列一条：`itemOf` 查不到就**抛错**（那道守卫本身是对的 ——
   * 它防的就是"catalog 与组件不同步"）。但"删掉一个数据项、忘了删引用它的那一行"
   * 这个方向 `tsc` 抓不到（id 是字符串字面量），别的断言也抓不到
   * （`ENGINE.wiring.failLoud` 只确认"用了 itemOf"，不确认指向的 id 存在）。
   * 实测：拍板删掉「检查更新」之后，`AboutSection` 里那一行引用留了整整一轮，
   * 五道门全绿，只有"人点开『关于』"这一条路径能发现 —— 而那正是最晚被发现的地方。
   *
   * 反向（新增项忘了挂渲染点）不在这里管：那是 `WIRING.item.<id>` 那组逐项覆盖的事。
   */
  const dataErr = CAT_ERR(ctx.cat);
  if (dataErr) return { ok: false, detail: dataErr };
  const ids = new Set((ctx.cat.mod.SETTINGS_SECTIONS ?? []).flatMap(flatItems).map((i) => i.id));
  const refs = [...ctx.s.sections.matchAll(/itemOf\(\s*[\w$]+\s*,\s*'([\w-]+)'\s*\)/g)].map((m) => m[1]);
  const problems = [];
  for (const id of new Set(refs)) {
    if (!ids.has(id)) problems.push(`itemOf('${id}') 指向一个不存在的项 —— 渲染到那一组会直接抛错`);
  }
  // 分母 > 0：抽不到任何引用说明正则失配了，那是"判据空转"，不是"没有坏引用"
  if (refs.length === 0) problems.push('一处 itemOf 引用都没抽到（判据空转）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
for (const a of ADDED) {
  add(`WIRING.item.${a.id}`, 'WIRING', (ctx) => {
    const src = ctx.s.sections;
    // 取项/分派点：itemOf(…, '<id>') 或 switch 的 case '<id>'。
    // 刻意**不锁死**具体写法（itemOf 与 switch/case 都是合法实现，锁死会在重构时误红）。
    const viaItemOf = new RegExp(`itemOf\\s*\\([^)]*${q(a.id)}`).test(src);
    // case 分支还必须真的**产出控件**（含 JSX），否则 `case 'x': return null` 这类挂空会假绿。
    let viaCase = false;
    const cm = new RegExp(`case\\s+${q(a.id)}\\s*:`).exec(src);
    if (cm) {
      const rest = src.slice(cm.index + cm[0].length);
      const ends = ['case ', 'default:'].map((k) => {
        const i = rest.indexOf(k);
        return i < 0 ? rest.length : i;
      });
      const body = rest.slice(0, Math.min(...ends));
      // 产出控件的判据：内联 JSX（含 `<`）或返回一个大写开头的组件调用（PascalCase）。
      // 这样 `case 'x': return null` 会红，而 `return QualityControl(item)` 这类合法写法不会误红。
      viaCase = body.includes('<') || /\breturn\s+[A-Z][\w$]*\s*\(/.test(body);
    }
    const ok = viaItemOf || viaCase;
    return {
      ok,
      detail: ok
        ? ''
        : `sections.tsx 里找不到项 ${a.id} 的**有效**取项/分派点（itemOf(…, '${a.id}')，或产出控件的 case '${a.id}':）`,
    };
  });
}
for (const name of MEDIA_SETTERS) {
  add(`WIRING.setter.${name}`, 'WIRING', (ctx) => {
    // 必须是**从 store 取用**：useMusicStore((任意形参名) => 形参.name)。
    // 只查 `name` 是否出现会被骗 —— 本地别名 (onChange={name}) 即使摘掉 store 选择器也仍在。
    const re = new RegExp(`useMusicStore\\s*\\(\\s*\\(?[^)]*\\)?\\s*=>\\s*[A-Za-z_$][\\w$]*\\.${esc(name)}\\b`);
    return {
      ok: re.test(ctx.s.sections),
      detail: re.test(ctx.s.sections) ? '' : `sections.tsx 未从 store 取用 ${name}`,
    };
  });
}
add('WIRING.failLoud', 'WIRING', (ctx) => {
  const body = fnBody(ctx.s.sections, 'MediaSection') ?? '';
  // 「id 对不上」时必须抛错而不是静默渲染空行：itemOf 自身会抛，或 switch 的 default 抛。
  const ok = /\bthrow\b/.test(body) || /itemOf\s*\(/.test(body);
  return { ok, detail: ok ? '' : 'MediaSection 缺少 fail-loud（未知 id 既不抛错也不经 itemOf，会静默漏项）' };
});

// ============================ ⑤ STORE ============================
for (const { field } of STORE_FIELDS) {
  add(`STORE.default.${field}`, 'STORE', (ctx) => {
    const src = ctx.s.store;
    // 状态对象里形如 `  field: <值>,`（interface 声明以 `;` 结尾，不会命中）
    const m = new RegExp(`^  ${esc(field)}:\\s*(.+),\\s*$`, 'm').exec(src);
    if (!m) return { ok: false, detail: `store.ts 初始状态里找不到 ${field} 的默认值（形如 "  ${field}: <值>,"）` };
    const val = m[1].trim();
    if (!val || val === 'undefined') return { ok: false, detail: `${field} 的默认值为空/undefined` };
    return { ok: true, detail: '' };
  });
}
for (const { field, setter } of STORE_FIELDS) {
  add(`STORE.setter.${field}`, 'STORE', (ctx) => {
    const body = methodBody(ctx.s.store, setter);
    if (body == null) return { ok: false, detail: `store.ts 没有 ${setter} 的实现体（只有 interface 声明不算）` };
    // savePrefs 的 patch 键必须就是该字段：既证明调用了合并写偏好，也证明写对了键
    const ok = new RegExp(`savePrefs\\s*\\(\\s*\\{\\s*${esc(field)}\\s*:`).test(body);
    return { ok, detail: ok ? '' : `${setter} 未调用 savePrefs({ ${field}: … })（偏好不会持久化）` };
  });
}

// 偏好水合：设置页要在**不开音乐屏**的前提下显示上次存的值。
// 只断言「有 hydratePrefs」不够 —— 真正的失效形态是"实现了但没人调"
// （完整 init 只在音乐屏挂载时跑），所以必须断言启动处（main.tsx）确实调了它。
add('STORE.hydrate.defined', 'STORE', (ctx) => {
  const body = methodBody(ctx.s.store, 'hydratePrefs');
  if (body == null) return { ok: false, detail: 'store.ts 没有 hydratePrefs 的实现体' };
  const missing = STORE_FIELDS.filter(({ field }) => !new RegExp(`\\b${esc(field)}\\b`).test(body));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `hydratePrefs 未恢复：${missing.map((x) => x.field).join(', ')}` : '',
  };
});
add('STORE.hydrate.atBoot', 'STORE', (ctx) => {
  const boot = ctx.s.main;
  const ok = /hydratePrefs\s*\(/.test(boot);
  return {
    ok,
    detail: ok ? '' : 'main.tsx 未在启动时调用 hydratePrefs()（冷启动直接进设置页会显示默认值而不是上次存的值）',
  };
});

// 桌面应用守卫（2026-10-16 用户要求"当作一个桌面应用"）：禁刷新/查找快捷键 + 取消默认右键。
// 装在 main.tsx 入口是唯一收口处（装屏里换屏失效，装 App 里每次渲染重挂）。
add('DESKTOP.guards', 'DESKTOP', (ctx) => {
  const main = stripComments(ctx.s.main);
  // 🔴 守卫的**实现**在 `tools/desktopGards.ts`，main.tsx 只剩一行调用（038dc7d 起）。
  //    ②–④ 必须判在实现文件上：判在 main.tsx 上时，把 contextmenu 那段从实现里删掉
  //    断言照样绿 —— 那正是"守卫没人守"的形态，2026-10-16 真机基线红里实测踩到过。
  const guard = stripComments(ctx.s.desktopGuards);
  const missing = [];
  if (!ctx.s.desktopGuards) missing.push('读不到 src/tools/desktopGards.ts（守卫实现不在？文件被搬走了？）');
  // ① 真的装了守卫，且装在启动处（只定义不调用 = 没装）。
  //    锚定**行首的调用语句**：写成 /installDesktopGuards\s*\(/ 会同时匹配函数定义
  //    （`function installDesktopGuards(): void {`），摘掉调用后仍然绿 —— 假阳性，实测踩过。
  if (!/^installDesktopGuards\(\);/m.test(main))
    missing.push('main.tsx 未调用 installDesktopGuards()（定义了没装等于没装）');
  // ② 开发态必须放行：否则 dev 里 Ctrl+R 失效，排障时会被误判成"代码没生效"
  if (!/import\.meta\.env\.DEV/.test(guard))
    missing.push('守卫没有开发态放行（import.meta.env.DEV）—— dev 里禁刷新会妨碍排障');
  // ③ 四类快捷键一个都不能漏：R（刷新）/ F5（刷新）/ F（页内查找）/ U（查看源码）
  for (const [id, re] of [
    ['Ctrl/Cmd+R', /k === 'r'/],
    ['F5', /'F5'/],
    ['Ctrl/Cmd+F', /k === 'f'/],
    ['Ctrl/Cmd+U', /k === 'u'/],
  ]) {
    if (!re.test(guard)) missing.push(`守卫未覆盖 ${id}`);
  }
  // ④ 右键菜单取消（可编辑元素例外：那里要留剪切/复制/粘贴）
  if (!/contextmenu/.test(guard)) missing.push('守卫未处理 contextmenu（默认右键菜单还在）');
  if (!/input, textarea, \[contenteditable/.test(guard))
    missing.push('右键菜单没有给可编辑元素留例外（粘贴会只剩快捷键一条路）');
  return { ok: missing.length === 0, detail: missing.length ? `桌面守卫：${missing.join('、')}` : '' };
});

// ============================ ⑥ PLAYER ============================
const CSS_VARS = [
  { id: 'lyrSize', name: '--lyr-size' },
  { id: 'lyrHl', name: '--lyr-hl' },
  { id: 'vinylAccent', name: '--vinyl-accent' },
];
for (const v of CSS_VARS) {
  add(`PLAYER.inject.${v.id}`, 'PLAYER', (ctx) => {
    const pred = (t) => new RegExp(`${q(v.name)}\\s*:`).test(t);
    const ok = appliedWhere(ctx.s.expanded, 'style', pred);
    return {
      ok,
      detail: ok ? '' : `ExpandedPlayer.tsx 未把 ${v.name} 注入到真正被 style={…} 消费的对象上（只定义不挂载也会缺）`,
    };
  });
}
const CLS = [
  { id: 'isDynamic', name: 'is-dynamic' },
  { id: 'isDisc', name: 'is-disc' },
  { id: 'isPaused', name: 'is-paused' },
];
for (const c of CLS) {
  add(`PLAYER.class.${c.id}`, 'PLAYER', (ctx) => {
    const src = ctx.s.expanded;
    const applied = appliedWhere(src, 'className', (t) => new RegExp(q(c.name)).test(t));
    const conditional = tokenConditional(src, `'${c.name}'`) || tokenConditional(src, `"${c.name}"`);
    const ok = applied && conditional;
    const detail = !applied
      ? `ExpandedPlayer.tsx 未把 ${c.name} 并入真正被 className={…} 消费的类名集合`
      : !conditional
        ? `${c.name} 不是按条件添加的（无条件加会让该视觉态常亮）`
        : '';
    return { ok, detail };
  });
}
add('PLAYER.mounted', 'PLAYER', (ctx) => ({
  /*
   * ⚠️ 挂载点在 **App.tsx**，不是 MusicScreen —— `ExpandedPlayer` 是全屏 fixed 浮层、
   * 不读本屏 DOM，D-156 起已搬到应用根。老断言一直盯着 `MusicScreen.tsx`，
   * 于是从搬家那天起**再也绿不了**（而且看起来像"实现没做"）。判据改成挂载点本身。
   */
  ok: /<ExpandedPlayer\b/.test(ctx.s.appMain),
  detail: 'ExpandedPlayer 没有被挂载（挂载了偏好才可能生效）—— 它是全屏浮层，挂载点在应用根 App.tsx',
}));
add('PLAYER.cssConsumes', 'PLAYER', (ctx) => {
  const need = ['var(--lyr-size', 'var(--lyr-hl', 'var(--vinyl-accent', 'is-dynamic', 'is-disc', 'is-paused'];
  const missing = need.filter((n) => !ctx.s.css.includes(n));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `样式未消费这些注入：${missing.join('、')}（注入了却没样式消费 = 不生效）` : '',
  };
});

// ============================ ⑦ OPTIONS ============================
for (const name of OPTION_EXPORTS) {
  add(`OPTIONS.export.${name}`, 'OPTIONS', (ctx) => {
    const ok = new RegExp(`export\\s+const\\s+${esc(name)}\\b`).test(ctx.s.options);
    return { ok, detail: ok ? '' : `player-options.ts 未导出 ${name}（选项常量的单一事实源缺项）` };
  });
}
add('OPTIONS.expandedImportsSkins', 'OPTIONS', (ctx) => {
  const ok = /import\s*\{[^}]*\bSKINS\b[^}]*\}\s*from\s*['"][^'"]*player-options['"]/.test(ctx.s.expanded);
  return { ok, detail: ok ? '' : 'ExpandedPlayer.tsx 未从 player-options 引入 SKINS（应从单一事实源引入）' };
});
add('OPTIONS.expandedNoLocalSkins', 'OPTIONS', (ctx) => {
  const hit = /^\s*(?:const|let|var)\s+SKINS\b/m.test(ctx.s.expanded);
  return {
    ok: !hit,
    detail: hit ? 'ExpandedPlayer.tsx 又自己定义了一份 SKINS —— 设置页与播放器会漂移成两套皮肤名' : '',
  };
});
add('OPTIONS.sectionsImportsSkins', 'OPTIONS', (ctx) => {
  const ok = /import\s*\{[^}]*\bSKINS\b[^}]*\}\s*from\s*['"][^'"]*player-options['"]/.test(ctx.s.sections);
  return { ok, detail: ok ? '' : 'sections.tsx 未从 player-options 引入 SKINS（设置页也应共用同一份）' };
});

// ============================ ⑧ CACHE（「音乐缓存」通栏四格） ============================
/*
 * 这一组守的是**通栏形态**这条新分支。
 *
 * 为什么它需要自己的断言组（而不是并进 WIRING）：`WIRING.item.<id>` 判的是
 * 「sections.tsx 里有产出控件的 case」—— 它**不关心**这一项最终被不被 `Row` 包住。
 * 而「音乐缓存」存在的全部理由就是「塞不进 `Row` 的窄右列」：
 * 哪天有人把 `layout:'block'` 删掉、或者把 `Group` 里那条新分支删了，
 * WIRING 全绿、项数全对，而页面上那一项被压成一条读不了的细缝 —— 四格没了，
 * 断言却说什么都没发生。所以形态本身必须被钉住。
 */
add('CACHE.layoutFlag', 'CACHE', (ctx) => {
  const { cat } = ctx;
  const dataErr = CAT_ERR(cat);
  if (dataErr) return { ok: false, detail: dataErr };
  const hit = flatItems(cat.mod.MEDIA).find((i) => i.id === 'music-cache');
  if (!hit) return { ok: false, detail: 'MEDIA 里缺项 id=music-cache' };
  return {
    ok: hit.layout === 'block',
    detail:
      hit.layout === 'block'
        ? ''
        : `music-cache 的 layout=${JSON.stringify(hit.layout)}，应为 'block'` +
          '（否则会被包进 Row 的窄右列，四格被压扁）',
  };
});
add('CACHE.groupSkipsRow', 'CACHE', (ctx) => {
  // Group 里那条新分支：见到 layout==='block' 直接渲染 children，不包 Row。
  // 判据锚在 `item.layout === 'block'` 上 —— 只查"出现了 block 字样"会被注释骗过。
  const body = fnBody(ctx.s.sections, 'Group');
  if (!body) return { ok: false, detail: 'sections.tsx 里找不到 Group 的实现体' };
  const branch = /item\.layout\s*===\s*['"]block['"]/.test(body);
  // 且这条分支必须**在 Row 之前 return**，否则包 Row 的那行会先执行
  const layoutAt = body.search(/item\.layout\s*===\s*['"]block['"]/);
  const rowAt = body.search(/<Row\b/);
  const ordered = layoutAt >= 0 && rowAt >= 0 && layoutAt < rowAt;
  return {
    ok: branch && ordered,
    detail: !branch
      ? "Group 里没有 layout==='block' 的分支（通栏项会被包进 Row）"
      : !ordered
        ? 'Group 的 block 分支排在 <Row 之后（包 Row 的分支会先执行，四格失效）'
        : '',
  };
});
add('CACHE.blockRendersFourCells', 'CACHE', (ctx) => {
  /*
   * 四格的四个格子必须都在：文案 / 目录路径 / 总大小 / 两个按钮。
   *
   * 判据取 `CacheBlock` 的**组件源码**并数关键类名 —— 而不是查 `sections.tsx`
   * 里有没有那几段文字：组件搬文件时引用关系会变，源码里的类名不会。
   */
  const src = ctx.s.cacheBlock;
  if (!src) return { ok: false, detail: '找不到 CacheBlock.tsx（四格实现不在预期位置）' };
  const need = ['set-cache-head', 'set-cache-total', 'set-cache-rows', 'set-cache-acts', 'set-cache-path'];
  const missing = need.filter((n) => !new RegExp(`${q(n)}`).test(src));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `四格里缺：${missing.join('、')}（少一格就不是规格里的四格）` : '',
  };
});
add('CACHE.openDirGuarded', 'CACHE', (ctx) => {
  /*
   * 「打开目录」必须有存在性守卫。
   *
   * `open_path` 会先判 `p.exists()`，不存在直接 `Err`（`commands.rs`）——
   * 而「全部清除」只删目录内容、保留根目录，所以正常流程下不会踩到；
   * 但目录被手工删掉 / 换机迁移后就会。**症状是点一下报错**，
   * 所以必须判「按钮被禁用」或「调用有兜底」，二者至少居其一。
   */
  const src = ctx.s.cacheBlock;
  if (!src) return { ok: false, detail: '找不到 CacheBlock.tsx' };
  const disabled = /disabled=\{[^}]*root/.test(src);
  const caught = /openPath\([^)]*\)[\s\S]{0,120}?\.catch\(/.test(src);
  return {
    ok: disabled && caught,
    detail: !disabled
      ? '「打开目录」没有按 root 禁用（路径不可用时点了只会报错）'
      : !caught
        ? 'openPath 没有 .catch（目录被手工删掉时用户只看到一次报错，且不知道发生了什么）'
        : '',
  };
});
add('CACHE.confirmBeforeClear', 'CACHE', (ctx) => {
  /*
   * 清缓存不可撤销 ⇒ 必须有二次确认，且确认必须**先于**清除动作。
   *
   * 判据取「确认弹层的组件」与「调用清除的位置」两处：
   * 只有弹层没有确认、或有确认但清除绕过了它，都判红。
   */
  const src = ctx.s.cacheBlock;
  if (!src) return { ok: false, detail: '找不到 CacheBlock.tsx' };
  // D-143：模态壳已收口到通用单元 `units/Modal`（`.modal-mask` + `role="dialog"` 在单元里），
  // 故这里改判「用 Modal 渲染确认层」，而不是再要求本文件内联那段 DOM。
  const hasModal = /<Modal\b/.test(src);
  const clearAt = src.indexOf('musicCacheClear(');
  // 确认状态必须是清除的前置：pending 非空时才渲染弹层，点确认后才调清除
  const gateByPending = /pending\s*\?/.test(src) && /setPending\(/.test(src);
  return {
    ok: hasModal && clearAt > 0 && gateByPending,
    detail: !hasModal
      ? '没有二次确认弹层（清缓存不可撤销）'
      : clearAt <= 0
        ? '找不到 musicCacheClear 调用'
        : !gateByPending
          ? '清除动作没有经过确认状态门控'
          : '',
  };
});
add('CACHE.reloadAfterClear', 'CACHE', (ctx) => {
  /*
   * 清完必须重拉统计。
   *
   * `music_cache_clear` 返回 `()`（Rust 侧刻意不抛：清缓存失败没有可执行的下一步），
   * 所以前端**不能靠 catch 判断成败**，只能靠"清完再读一次数字看它变没变"。
   * 漏了这一步的症状是：清除确实发生了，但界面上的大小纹丝不动 —— 用户会以为没生效。
   */
  const body = fnBody(ctx.s.cacheBlock, 'CacheBlock') ?? '';
  const clearAt = body.indexOf('musicCacheClear');
  const reloadAfter = clearAt >= 0 && body.indexOf('reload()', clearAt) > clearAt;
  return {
    ok: reloadAfter,
    detail: !reloadAfter ? '清除后没有再次拉统计（数字不会变化，用户以为清除没生效）' : '',
  };
});
add('CACHE.unitsBase1024', 'CACHE', (ctx) => {
  /*
   * 容量换算必须是 **1024 进制 + 2 位小数**（拍板规格）。
   *
   * 判据盯三件事，各有其失效形态：
   *   ① 换算基数是 1024 而不是 1000 —— 否则"缓存 1.5 M"与系统显示的量对不上；
   *   ② `toFixed(2)` 存在 —— 否则 `1.5 M` 与 `1.00 M` 宽度不一，且丢掉两位精度；
   *   ③ 单位阶梯爬到 G —— 只有 K/M 两级时 1G 以上的缓存会被显示成 `1024.00 M`。
   *
   * ⚠️ 刻意**不数 1024 出现了几次**：多级换算可以写成递归、循环或查表，
   * 次数与正确性无关（第一版判据说"至少两处"就误报了一个正确的循环实现）。
   * 真正要钉的是"基数是 1024"与"格式是两位小数"这两件**规格事实**。
   */
  const src = ctx.s.cacheBlock;
  if (!src) return { ok: false, detail: '找不到 CacheBlock.tsx' };
  const body = fnBody(src, 'formatBytes') ?? '';
  const base1024 = /\b1024\b/.test(body);
  const notBase1000 = !/\b1000\b/.test(body);
  const fixed2 = /\.toFixed\(\s*2\s*\)/.test(body);
  const hasG = /['"]G['"]/.test(body);
  return {
    ok: base1024 && notBase1000 && fixed2 && hasG,
    detail: !base1024
      ? 'formatBytes 没有 1024 进制（规格要求 1024，与系统容量口径一致）'
      : !notBase1000
        ? 'formatBytes 出现了 1000（规格是 1024 进制，用 1000 会与系统显示的量对不上）'
        : !fixed2
          ? 'formatBytes 没有 toFixed(2)（规格要求保留 2 位小数，如 1.50 M）'
          : !hasG
            ? "formatBytes 的单位阶梯里没有 'G'（超过 1G 的缓存会被显示成 1024.00 M）"
            : '',
  };
});
add('CACHE.providerLabelMap', 'CACHE', (ctx) => {
  // 四个平台的中文名映射。写错一个，用户就会看到「清除XX音乐」这种占位名。
  const src = ctx.s.cacheBlock ?? '';
  const missing = ['netease', 'kugou', 'qqmusic', 'migu'].filter(
    (k) => !new RegExp(`${k}\\s*:\\s*['"][^'"]+['"]`).test(src),
  );
  return {
    ok: missing.length === 0,
    detail: missing.length ? `平台中文名映射缺：${missing.join('、')}` : '',
  };
});
add('CACHE.zeroDisabled', 'CACHE', (ctx) => {
  /*
   * 某平台 0 缓存时该项必须**置灰不可点**（拍板规格）。
   *
   * 只查"有 disabled"会假绿：整体禁用或按钮禁用都能骗过它。
   * 所以要求 disabled 的判据表达式里**出现该项的字节数变量**，
   * 即"这个平台的字节数为 0 时才禁"。
   */
  const src = ctx.s.cacheBlock ?? '';
  // 判据：disabled 的表达式必须以「这个平台的字节数 <= 0」打头（后面可以再 || busy || failed）
  const ok = /disabled=\{\s*bytes\s*<=\s*0/.test(src);
  return {
    ok,
    detail: ok ? '' : '某平台 0 缓存时没有置灰（无可删之物却给可点的入口，点了像坏了）',
  };
});

// ============================ ⑨ ENGINE（② 翻译服务：翻译来源 / 服务与配对 / 推理引擎 / 模型与诊断） ============================
/*
 * 这一组守的是 ② 翻译服务**十三项全部接真实能力**（《09》§4.3 / 《02》§5；
 * 原「十项」自 D-94 起 +1（服务与配对加「自动启动翻译服务」）、ver2.1 再 +1
 * （推理引擎加「翻译方向」，只读说明项）、ver2.2 再 +1（第一个小节「翻译来源」，
 * 在线翻译并入 ② 的落点，P-D2））
 * 与「引擎诊断视图」（《09》§6.2）。
 *
 * 为什么它值得一整组断言：这十三项的失效形态**全都不会报错** ——
 *   · catalog 里标了 `live`、sections.tsx 里也写了控件，但控件绑的不是服务端字段
 *     （渲染出来永远停在"读取中…"，或显示一个前端自己编的默认值）；
 *   · 「已配置」与「已生效」被合成一个值（保存成功后下拉跳回旧值，用户只能得出"没存上"）；
 *   · 数字框逐字符提交（想把 5 改成 30，中途那一下会先写成 3 —— 那是**真实生效**的写入）；
 *   · 诊断面板的内部小标题复用了 `.set-subtitle`（规格自检 C11 的"恰好 4 个"从
 *     "4"变成"4+5"，那条断言红得莫名其妙，等于废掉）；
 *   · JSX 文本里漏出 markdown 的 `**`（界面上原样显示两个星号）。
 * 每一条都编译得过、类型检查过、不抛错。只能靠断言钉住。
 */

/** ② 的四小节 id（顺序即渲染顺序，也是 C11 判据「恰 4 个 `.set-subtitle`」的来源） */
const ENGINE_GROUPS = ['source', 'pairing', 'inference', 'model'];
/** 四小节标题字面量 —— C11 同时校验文字，这里必须逐字同源 */
// 首节标题按设计稿是「翻译链路」（卡片副标题「二选一 · 下一次翻译生效」）——
// 它取代了旧名「翻译来源」：这一节里除了来源二选一，还有在线 API 的密钥与连通性。
const ENGINE_SUBTITLES = ['翻译链路', '服务与配对', '推理引擎', '模型与诊断'];
/** 折叠区里剩下的三个区块标题（第 4 个「最近阶段日志」在 ver2.1 被**摘出**折叠范围，
 *  成为常驻日志区 —— 见《03》§3。它一旦回到折叠区，`ENGINE.run.noDupeLogSection` 变红） */
const DIAG_SECTIONS = ['进程状态', '生效配置', '模型状态'];
/** 诊断面板的三个操作按钮文案 */
const DIAG_OPS = ['重启引擎', '重新下载模型', '强制释放模型'];

/** ② 全组项数 —— 与 catalog 的 `SECTION_ITEM_TOTAL` 独立数出来（互为质证） */
const ENGINE_ITEMS_TOTAL = 13;

/** 取 ② 的十三项（真实数据结构，不是字符串） */
function translateItems(ctx) {
  const err = CAT_ERR(ctx.cat);
  if (err) return { err, items: null, sec: null };
  const sec = ctx.cat.mod.TRANSLATE;
  return { err: null, items: flatItems(sec), sec };
}

/*
 * 有意**不把项数写进断言 id**（原 id 是 `ENGINE.items.tenAllLive`）：
 * 项数进 id 就得随每次增删改 id，改漏一处（如反证轮的 `expect`）就成了假覆盖 ——
 * 名字会随规格腐坏，而"全部 live"这个**风险点**从不腐坏。项数只在断言内部与
 * `ENGINE_ITEMS_TOTAL` 比对。
 */
add('ENGINE.items.allLive', 'ENGINE', (ctx) => {
  const { err, items, sec } = translateItems(ctx);
  if (err) return { ok: false, detail: err };
  const per = (sec.groups ?? []).map((g) => `${g.id}=${(g.items ?? []).length}`);
  const problems = [];
  if (items.length !== ENGINE_ITEMS_TOTAL)
    problems.push(`项数 ${items.length}，应为 ${ENGINE_ITEMS_TOTAL}（${per.join(', ')}）`);
  // 每项都必须 live —— 十三项里剩一项 pending，就意味着《09》§4.3 的能力清单没落地
  const notLive = items.filter((i) => i.state !== 'live').map((i) => i.id);
  if (notLive.length) problems.push(`仍是 pending/其它态：${notLive.join(', ')}`);
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.groups.order', 'ENGINE', (ctx) => {
  const { err, sec } = translateItems(ctx);
  if (err) return { ok: false, detail: err };
  const ids = (sec.groups ?? []).map((g) => g.id);
  const exact = ids.length === ENGINE_GROUPS.length && ENGINE_GROUPS.every((g, i) => ids[i] === g);
  const titles = (sec.groups ?? []).map((g) => g.title);
  const titlesOk = ENGINE_SUBTITLES.every((t, i) => titles[i] === t);
  return {
    ok: exact && titlesOk,
    detail: !exact
      ? `② 小节应为 [${ENGINE_GROUPS.join(', ')}]（按此顺序），实为 [${ids.join(', ')}]`
      : !titlesOk
        ? `小节标题应为 [${ENGINE_SUBTITLES.join(' / ')}]，实为 [${titles.join(' / ')}]（C11 校验文字，须逐字一致）`
        : '',
  };
});
for (const [id, group] of [
  ['ENGINE.layout.manageBlock', 'model-manage'],
  ['ENGINE.layout.diagBlock', 'engine-diag'],
]) {
  add(id, 'ENGINE', (ctx) => {
    const { err, items } = translateItems(ctx);
    if (err) return { ok: false, detail: err };
    const hit = items.find((i) => i.id === group);
    if (!hit) return { ok: false, detail: `② 里缺项 id=${group}` };
    return {
      ok: hit.layout === 'block',
      detail:
        hit.layout === 'block'
          ? ''
          : `${group} 的 layout=${JSON.stringify(hit.layout)}，应为 'block'（否则会被包进 Row 的窄右列）`,
    };
  });
}

// —— 接线：sections.tsx 的 TranslateSection ——
const tsBody = (ctx) => fnBody(ctx.s.sections, 'TranslateSection');

add('ENGINE.wiring.fourSubTitles', 'ENGINE', (ctx) => {
  const raw = tsBody(ctx);
  if (!raw) return { ok: false, detail: 'sections.tsx 里找不到 TranslateSection 的实现体' };
  /*
   * ⚠️ 必须**先剥注释**再数 —— 与 `ENGINE.diag.notSubTitle` 同一条理由，且这里翻过车：
   * 合卡那段注释里写了「卡内标题**不用** `<SubTitle>`」，字面量 `<SubTitle>` 于是被计成
   * 第 4 个，判据报「有 4 个」——而组件里真的只有 3 个。
   * 那是一次**假红**：解红的最快办法是把注释删掉，也就是把"为什么不能用"这条说明删掉，
   * 判据反而把维护者引向最坏的方向。剥注释后，数出来的才是**真的会被渲染的**小节标题。
   *
   * ver2.2（P-D2）起是 4 个：在线翻译并入 ② 作为第一个小节「翻译来源」。
   */
  const body = stripComments(raw);
  // 判据按 `<SubTitle` 前缀数（不要求紧跟 `>`）：小节标题现在带 `head` 卡片副标题，
  // 写成 `<SubTitle>` 全等会漏数 —— 那正是锚点跟实现一起漂的假绿来源。
  const n = (body.match(/<SubTitle[\s>]/g) ?? []).length;
  if (n !== 4) return { ok: false, detail: `TranslateSection 里有 ${n} 个 <SubTitle>，应恰为 4（C11 判据）` };
  const missing = ENGINE_SUBTITLES.filter((t) => !new RegExp(`<SubTitle[^>]*>${t}</SubTitle>`).test(body));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `小节标题缺字面量：${missing.join('、')}（C11 按文字校验）` : '',
  };
});
add('ENGINE.wiring.tierConfiguredVsEffective', 'ENGINE', (ctx) => {
  const body = tsBody(ctx) ?? '';
  const problems = [];
  // 控件显示的是**已配置**（用户在这里改"下次启动用哪档"）
  // 允许可选链形态 `tier?.configured`：取数边界已补齐子块，但渲染点写成可选链同样满足契约
  if (!/tier\??\.configured/.test(body)) problems.push('没读 tier.configured（控件会显示不出已配置的那一档）');
  // 旁边小字报的是**已生效**（引擎此刻在跑哪档）
  if (!/tier\??\.effective/.test(body)) problems.push('没读 tier.effective（用户看不到改动是否已生效）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.wiring.tierKeepsConfigured', 'ENGINE', (ctx) => {
  const body = tsBody(ctx) ?? '';
  /*
   * 判据是「已配置档**即使不在候选清单里也必须出现在选项里**」这条兜底分支。
   * 只查"有 tierValue"会假绿 —— 兜底写了但没人用、或用了但没推进 options，都测不到。
   * 这里锚在**渲染出来的那句标注**上（它同时也是用户能看见的证据）。
   *
   * ⚠️ 标注必须带后缀「 · 权重不在清单」：ver2.2 平台下拉也有一处「（当前配置）」兜底
   * （platformOptions），只搜「（当前配置」会分不清两处兜底 —— 破坏 tier 那处时
   * 平台那处仍能让断言绿，反证随之失效。
   */
  const ok = /tierOptions\.push\(/.test(body) && body.includes('（当前配置 · 权重不在清单）');
  return {
    ok,
    detail: ok ? '' : '缺「已配置档不在清单里也要出现在选项里」的兜底（控件会显示成空白/裸 id）',
  };
});
add('ENGINE.wiring.tierWarnFromServer', 'ENGINE', (ctx) => {
  const body = tsBody(ctx) ?? '';
  // 强警告条的**文案本身**必须来自服务端（`tierInfo.warning`），不是前端另编一句
  const ok = body.includes('set-warn') && /tierInfo\.warning/.test(body);
  return {
    ok,
    detail: ok ? '' : '「不推荐」档缺通栏强警告条，或警告文案不是取服务端的 `tierInfo.warning`',
  };
});
add('ENGINE.wiring.accelMismatch', 'ENGINE', (ctx) => {
  const body = tsBody(ctx) ?? '';
  // 红条既可以写成裸 `<div className="notice is-bad">`，也可以是封装后的 `<Notice kind="bad">`；两者渲染等价。
  const ok =
    body.includes('accel.mismatch') && /(?:notice is-bad|<Notice kind="bad")/.test(body) && /accel\.reason/.test(body);
  return {
    ok,
    detail: ok ? '' : '「用户指定的后端本机没有」没显示（或没说清实际按什么在跑）—— 用户会以为选的 CUDA 真的生效了',
  };
});
add('ENGINE.wiring.idleNumberInputs', 'ENGINE', (ctx) => {
  const body = tsBody(ctx) ?? '';
  const n = (body.match(/<NumberInput/g) ?? []).length;
  const problems = [];
  if (n !== 2) problems.push(`<NumberInput> 有 ${n} 个，应为 2（两个空闲卸载阈值）`);
  if (!/idleLlmMin:/.test(body)) problems.push('没有一项写 idleLlmMin');
  if (!/idleVisionMin:/.test(body)) problems.push('没有一项写 idleVisionMin');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.wiring.idleNeverUnload', 'ENGINE', (ctx) => {
  /*
   * 「0 = 从不卸载」必须写在界面上 —— 否则用户遇到 0 会当成 bug 而不是设计。
   *
   * ⚠️ 2026-10-07（R3 合卡）判据换了说法，理由不是"原来那条太严"，而是**形态真的变了**：
   * 原来是两行各写一遍（"两档都要写"），合卡后这一句升成**卡片级共用说明**（写一遍）。
   * 所以锚点从「出现 ≥2 次」改成「**在卡片共用的那一格上**出现」—— 前者在新形态下
   * 只有靠注释里的引用才能凑够 2 次（本文件注释里正好引了这句），那等于判据被注释撑着，
   * 真实文案删了它也照绿。现在锚在 `.set-idle-sub` 这个元素上，**先剥注释**再判。
   */
  const code = stripComments(tsBody(ctx) ?? '');
  const problems = [];
  if (!/className="set-idle-sub">0 = 从不卸载</.test(code)) {
    problems.push('「0 = 从不卸载」不是卡片级共用说明（缺 .set-idle-sub 上那一句）');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.wiring.visionNeedsRestart', 'ENGINE', (ctx) => {
  /*
   * 两档待遇不同（LLM 即时 / 视觉需重启）必须**在界面上说出来**，否则用户无法理解为何只有一条提示。
   * ⚠️ 先剥注释：本组件这段的注释里**恰好引用了这五个字**（「"必须重启引擎"五个字必须留着」），
   * 不剥的话删掉真实文案、留下注释，断言照样绿 —— 判据就被注释撑着了。
   */
  const body = stripComments(tsBody(ctx) ?? '');
  const ok = body.includes('必须重启引擎');
  return { ok, detail: ok ? '' : '视觉档没写明「必须重启引擎才生效」（与 LLM 档待遇不同，必须说出来）' };
});
add('ENGINE.wiring.restartHint', 'ENGINE', (ctx) => {
  const body = tsBody(ctx) ?? '';
  const ok = /<RestartHint\b/.test(body) && /set-hint/.test(ctx.s.sections);
  return { ok, detail: ok ? '' : '缺「改完要重启」提示条（《09》§4.3 末句要求小节下方给提示）' };
});
add('ENGINE.wiring.modelDirGuarded', 'ENGINE', (ctx) => {
  const body = tsBody(ctx) ?? '';
  const disabled = /disabled=\{!o\.modelDir\.exists\}/.test(body);
  const caught = /openPath\([^)]*\)[\s\S]{0,120}?\.catch\(/.test(ctx.s.sections);
  return {
    ok: disabled && caught,
    detail: !disabled
      ? '「打开」按钮没按 modelDir.exists 禁用（路径不存在时点了只会报错）'
      : !caught
        ? 'openPath 没有 .catch（失败时用户只看到一次静默的报错）'
        : '',
  };
});
add('ENGINE.wiring.accelLabelFallback', 'ENGINE', (ctx) => {
  const body = tsBody(ctx) ?? '';
  // 后端候选缺失时也要能显示已配置的那一个，不能露出 `mps` 这种裸 id
  const ok = /ACCEL_LABEL\[/.test(body);
  return { ok, detail: ok ? '' : '后端显示没有 ACCEL_LABEL 兜底（候选缺失时会露出 mps/cuda 这种裸 id）' };
});
add('ENGINE.wiring.failLoud', 'ENGINE', (ctx) => {
  const body = tsBody(ctx) ?? '';
  // catalog 与本组件不同步时必须抛错，而不是静默渲染成空行
  const ok = /itemOf\(/.test(body);
  return { ok, detail: ok ? '' : 'TranslateSection 未经 itemOf 取项（id 写错会静默渲染成空行）' };
});

// —— 接口收口 engine-api.ts ——
add('ENGINE.api.sixEndpoints', 'ENGINE', (ctx) => {
  const src = ctx.s.engineApi;
  const need = [
    '/engine/options',
    '/engine/status',
    '/engine/settings',
    '/engine/unload',
    '/engine/models/verify',
    '/engine/models/download',
  ];
  const missing = need.filter((p) => !src.includes(`'${p}'`));
  return { ok: missing.length === 0, detail: missing.length ? `② 的端点缺：${missing.join(', ')}` : '' };
});

// —— 数据源 hook engine-state.ts ——
const hookBody = (ctx) => fnBody(ctx.s.engineState, 'useEngineState');

add('ENGINE.hook.clearsOnError', 'ENGINE', (ctx) => {
  const body = hookBody(ctx);
  if (!body) return { ok: false, detail: 'engine-state.ts 里找不到 useEngineState 的实现体' };
  const problems = [];
  /*
   * 拉取失败时必须把**两份数据都清成 null**。这是本项目典型的静默假绿：
   * 服务重启的瞬间留着旧值，界面会显示"引擎 running"，而事实是服务都连不上 ——
   * 用户对着一份过期快照排查，比什么都不显示更糟。
   */
  if (!/setOptions\(null\)/.test(body)) problems.push('失败时没 setOptions(null)（会显示上一次的旧值）');
  if (!/setStatus\(null\)/.test(body)) problems.push('失败时没 setStatus(null)（会显示上一次的旧值）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.hook.pollOnlyWhenDownloading', 'ENGINE', (ctx) => {
  const body = hookBody(ctx) ?? '';
  const guarded = /if\s*\(\s*!downloadRunning\s*\)\s*return\b/.test(body);
  const hasInterval = /setInterval\(/.test(body) && /clearInterval\(/.test(body);
  return {
    ok: guarded && hasInterval,
    detail: !hasInterval
      ? '下载进度不会自动刷新（没有 setInterval/clearInterval）'
      : !guarded
        ? '轮询没有「只在下载中」的守卫 —— 会常挂一个 2s 定时器（风扇转起来而用户不知道为什么）'
        : '',
  };
});
add('ENGINE.hook.verifyNotFailedWhenNotOk', 'ENGINE', (ctx) => {
  const src = ctx.s.engineState;
  const problems = [];
  // `ok:false` 是"校验完成、发现不符"，不是操作失败 ⇒ 文案必须区分
  if (!src.includes('校验完成')) problems.push('没有「校验完成」这一类文案（ok:false 会被说成失败）');
  if (src.includes('校验失败')) problems.push('engine-state.ts 里出现了「校验失败」（该措辞属于 verifyError 分支）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('ENGINE.hook.strictModeAliveGuard', 'ENGINE', (ctx) => {
  /*
   * 「自取消守卫」必须**成对**：挂载置 true、卸载置 false。
   *
   * 🔴 只写卸载那一半（`useEffect(() => () => { alive.current = false; }, [])`）是**错的**，
   * 而且错得极像"后端慢"：`main.tsx` 开着 `React.StrictMode`，开发模式下 mount 的 effect
   * 会跑两遍（effect₁ → cleanup₁ → effect₂），ref 又是同一个对象 ⇒ cleanup₁ 把 alive
   * 永久钉成 false，两次 reload 的 promise 都走 `if (!alive.current) return`，
   * **数据不落地、错误也不落地** ⇒ 界面永久停在「读取中…」（服务端实测 1ms 就答完了）。
   * 生产构建没有双调用，所以它只在 dev 与截图取证里发作 —— 这是 05 号取证图照出来的缺陷。
   */
  const src = ctx.s.engineState;
  const problems = [];
  if (!/alive\.current\s*=\s*true;/.test(src)) {
    problems.push('挂载时没有把 alive 置回 true —— StrictMode 双调用后守卫永久为 false（界面会停在「读取中…」）');
  }
  if (!/alive\.current\s*=\s*false;/.test(src)) {
    problems.push('卸载时没有置 false（会在已卸载组件上 setState，且"读不到就不显示"的纪律落空）');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

// —— 诊断面板 EngineDiag.tsx ——
add('ENGINE.diag.notSubTitle', 'ENGINE', (ctx) => {
  /*
   * 面板内部小标题**不能**复用 `.set-subtitle` / `SubTitle`：
   * 那个类名是规格自检 C11 数"② 有几个小节"的判据（恰 4 个）。
   * ⚠️ 必须先剥注释再判 —— 本文件的注释里**就在讨论这件事**（写着 `SubTitle` 与 `.set-subtitle`），
   * 直接搜字面量会把说明当成违规（而且删掉说明才能变绿，正好把判据引向错误的方向）。
   */
  const code = stripComments(ctx.s.engineDiag);
  const problems = [];
  if (code.includes('set-subtitle')) problems.push('面板里用了 .set-subtitle（C11 的"恰 4 个"会失效）');
  if (/\bSubTitle\b/.test(code)) problems.push('面板里用了 SubTitle 组件');
  if (!code.includes('set-diag-h')) problems.push('面板内部标题没有用 .set-diag-h');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.diag.fromCatalog', 'ENGINE', (ctx) => {
  /*
   * 面板的标题与 why 必须来自 catalog 的 `engine-diag` 项，**不能在组件里再写一份**。
   *
   * 为什么会漏：这是最容易"顺手硬写"的两行（标题就五个字、why 就一句话），
   * 而硬写之后 catalog 里那一份**永远不会被渲染** —— 于是"改口径"要改两处、
   * 漏一处没人发现，界面上还是旧话。这不是假设：拍板把诊断面板从「不折叠」
   * 改成「默认折叠（方案 B）」时，catalog 里那句「默认可见、不折叠」
   * 留了整整一轮没被任何门照出来，是靠人读设计稿的"必须回写"清单才发现的。
   */
  const problems = [];
  const d = stripComments(ctx.s.engineDiag);
  if (!d.includes('{item.label}')) problems.push('面板标题不是取自 catalog 项（item.label）');
  if (!/emphasis\(item\.why\)/.test(d)) problems.push('面板 why 不是取自 catalog 项（emphasis(item.why)）');
  if (!/item=\{itemOf\(model, 'engine-diag'\)\}/.test(ctx.s.sections)) {
    problems.push('sections.tsx 没把 engine-diag 项传给面板（标题/why 会退回硬写）');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.diag.sectionsAndOps', 'ENGINE', (ctx) => {
  const src = ctx.s.engineDiag;
  const problems = [];
  const missingSections = DIAG_SECTIONS.filter((t) => !src.includes(`<DiagSection title="${t}"`));
  if (missingSections.length) problems.push(`区块缺：${missingSections.join('、')}`);
  if (!src.includes('set-diag-ops')) problems.push('缺操作区（.set-diag-ops）');
  const missingOps = DIAG_OPS.filter((t) => !src.includes(t));
  if (missingOps.length) problems.push(`操作缺：${missingOps.join('、')}`);
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.diag.restartIsServiceRestart', 'ENGINE', (ctx) => {
  const src = ctx.s.engineDiag;
  /*
   * 「重启引擎」必须真的调 `service_restart`（整条 ①②③ 链路），
   * 不能是一个"只改状态/只刷界面"的假动作。② 由 Box 壳 spawn，
   * manga-service 是兄弟进程管不到它 —— 所以这个动作诚实的表述就是"重启整条链路"。
   */
  const ok = /await\s+serviceRestart\(\)/.test(src);
  return { ok, detail: ok ? '' : '「重启引擎」没有调用 serviceRestart()（那就是一个点了不出事的假按钮）' };
});
add('ENGINE.diag.downloadDisabled', 'ENGINE', (ctx) => {
  const src = ctx.s.engineDiag;
  /*
   * ⚠️ 字段名是 A3d 之后的 `runnerExists`（执行体从 `node fetch-models.mjs` 换成了 `mangasvc`）。
   * 老断言判的是 `scriptExists` —— 产品早就改对了，而断言从那天起**再也绿不了**。
   * 一条基线就红的断言比没有更坏：它占着"这条已经覆盖了"的位置，实际什么都没在测
   * （反证轮还会把"仍然红"当成"按预期变红"）。§2 第 2 条：台账/断言与实际不符时以实际为准。
   */
  const ok = /runnerExists\s*===\s*false/.test(src) && /disabled=/.test(src);
  return {
    ok,
    detail: ok ? '' : '「重新下载模型」没按 runnerExists===false 置灰（执行体不在盘上时点了只会换一条报错）',
  };
});
// D4：设置页「模型与诊断」必须扩到**运行时** —— 装没装 / 占多少盘 / 什么时候落的。
add('ENGINE.diag.diskRow', 'ENGINE', (ctx) => {
  const src = stripComments(ctx.s.engineDiag);
  const problems = [];
  /*
   * 判据落在**服务端字段的引用**上，不落在文案上：
   * 文案会改，而"这条事实到底有没有被渲染出来"不会因为换词而改变。
   * 三个字段缺任一个 ⇒ 用户就少知道一件事（缺 `bytes` = 不知道占多少盘，
   * 缺 `assembledAt` = 不知道什么时候装的，缺 `readyEntries` = 不知道装全没有）。
   */
  if (!/models\?\.disk/.test(src)) problems.push('没有渲染 `models.disk`（运行时实况在界面上不存在）');
  if (!/disk\.bytes/.test(src)) problems.push('没有显示占用字节');
  if (!/disk\.readyEntries/.test(src)) problems.push('没有显示已就绪条目数');
  if (!/disk\.assembledAt/.test(src)) problems.push('没有显示最近落盘时间');
  /*
   * 🔴 「组件里写了」与「组件被渲染了」是两件事 —— 上面三条判的都是**组件体**，
   *    把调用点摘掉之后它们照样绿（反证轮实测到的假阳性，2026-10-14）。
   *    这正是本项目栽过的那个形态（`ExpandedPlayer` 定义了却没挂载）。
   */
  if (!/<ModelDiskRow\b[^>]*disk=\{s\?\.models\?\.disk\}/.test(src))
    problems.push('`ModelDiskRow` 没有被渲染（组件定义了却不挂载 = 界面上没有这一行）');
  /*
   * 🔴 换算函数必须**只有一处**（`parts.tsx`）。本文件与「模型管理」块显示的是同一个量，
   * 各留一份换算就会出现"同一个数在两处显示成不同单位"——那类偏差没人能一眼看出。
   */
  if (!/humanBytes/.test(src) || !/from '@screens\/settings\/parts'/.test(src))
    problems.push('字节换算不是从 parts 取的（各自算一份 ⇒ 同一个数可能显示成两种单位）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.diag.unknownStateSafe', 'ENGINE', (ctx) => {
  const src = ctx.s.engineDiag;
  /*
   * ②/③ 的 state 是**引擎自己**报的字符串，四态机之外迟早会多出第五种。
   * 若直接把它喂给 nav.ts 的 `stateView()`（签名收 `ServiceState`），
   * 遇到未知态会返回 `undefined` ⇒ 读 `view.colorVar` 直接把整块面板渲染崩。
   * 诊断视图崩在"最需要它的时候"是不可接受的，所以这里必须显式容忍未知态。
   */
  const mapped = /Record<string,\s*\{[^}]*colorVar[^}]*\}\s*\|\s*undefined>/.test(src);
  const safe = /view\?\.text\s*\?\?\s*state/.test(src);
  /*
   * ⚠️ 光判"有一处安全写法"不够 —— 本文件里有**两处**取 `view?.text`：
   * 摘要行的 chip 映射（`chipText`）与展开态的进程行。只把其中一处写安全，
   * 另一处遇到第五种态照样崩，而断言是绿的（实测过：chip 那一处引入后，
   * 只改进程行的那条反证变成**假阳性**）。所以要求**每一处**都带 `?? state` 兜底。
   */
  const all = [...src.matchAll(/view\?\.text/g)].length;
  const guarded = [...src.matchAll(/view\?\.text\s*\?\?\s*state/g)].length;
  const allGuarded = all > 0 && all === guarded;
  return {
    ok: mapped && safe && allGuarded,
    detail: !mapped
      ? '进程态映射表没有显式声明"可能不认识"（Record<string, … | undefined>）'
      : !safe
        ? '未知进程态回了 undefined 兜底（`view?.text ?? state` 缺失 ⇒ 遇到第五种态会整块崩）'
        : !allGuarded
          ? `有 ${all - guarded} 处 view?.text 没有 ?? state 兜底（那一处遇到第五种态就白屏）`
          : '',
  };
});
add('ENGINE.diag.stageLogReversed', 'ENGINE', (ctx) => {
  const code = stripComments(ctx.s.engineDiag);
  /*
   * 最新在上（引擎按发生顺序写入）。`logs` 取自 `s.recentStageLog`，
   * `allLogs = [...logs].reverse()` —— 常驻区与抽屉共用同一份顺序，不各自 reverse 一遍。
   */
  const ok = /\[\.\.\.logs\]\.reverse\(\)/.test(code) && /s\?\.recentStageLog/.test(code);
  return { ok, detail: ok ? '' : '阶段日志没逆序（最新的应该在最上面，否则用户要滚到底才看见刚发生的事）' };
});

// —— 运行状态卡（ver2.1《03》：日志从折叠范围里摘出来，成为 ② 组的常驻卡） ——
/*
 * 这一组的主线判据只有一条：**不看任何折叠控件，就能读到最近几行真实日志**。
 * 它的失效形态全是"编译得过、类型检查过、界面就是不对"，所以每条断言都配一次破坏。
 */
add('ENGINE.run.logOutsideFold', 'ENGINE', (ctx) => {
  /*
   * 日志区必须在**折叠之外**。判据落在代码里的**位置关系**上：`{open ? (` 是折叠体的开关，
   * 日志区与状态头行都必须排在它**之前**（即不受它门住）。
   * 只查"有没有 set-run-log"会被骗 —— 把日志塞回折叠分支里，那个类名照样在。
   */
  const code = stripComments(ctx.s.engineDiag);
  const problems = [];
  const foldAt = code.indexOf('{open ? (');
  const logAt = code.indexOf('set-run-log');
  const headAt = code.indexOf('set-run-head');
  if (foldAt < 0) problems.push('找不到折叠体的开关（open ? (）—— 判据失去着力点');
  if (headAt < 0) problems.push('找不到运行状态卡的头行（.set-run-head）');
  if (logAt < 0) problems.push('找不到常驻日志区（.set-run-log）');
  if (foldAt >= 0 && logAt >= 0 && logAt > foldAt) {
    problems.push('日志区排在折叠体之后（等于又被折叠门住了 —— 本版要修的就是这件事）');
  }
  if (foldAt >= 0 && headAt >= 0 && headAt > foldAt) {
    problems.push('状态头行排在折叠体之后（摘要 chip 也跟着被折叠了）');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.run.logNotConditional', 'ENGINE', (ctx) => {
  /*
   * 折叠态下日志也必须在（《03》§7.2 A2）。这里查的是**样式**那一半：
   * 只要有一条规则能让日志区在某种状态下 `display:none`，"零点击可见"这条承诺就作废了。
   * （组件那一半由 `ENGINE.run.logOutsideFold` 守着 —— 两半缺一不可。）
   */
  const css = stripComments(ctx.s.css);
  const hidden = /\.set-run-log[^{]*\{[^}]*display:\s*none/.test(css);
  return {
    ok: !hidden,
    detail: hidden ? '.set-run-log 在某种状态下被 display:none 隐藏（折叠态就看不到日志了）' : '',
  };
});
add('ENGINE.run.noDupeLogSection', 'ENGINE', (ctx) => {
  /*
   * 「最近阶段日志」在折叠区里**不得再有第二个实例**（《03》§7.2 A3）。
   * 留着旧区块就是"日志既常驻、又被折进去"：两份渲染、两处维护，
   * 且用户会以为自己看到的已经是全部。
   */
  const code = stripComments(ctx.s.engineDiag);
  const dup = code.includes('<DiagSection title="最近阶段日志"');
  return {
    ok: !dup,
    detail: dup ? '折叠区里仍有「最近阶段日志」区块（日志被渲染了两遍）' : '',
  };
});
add('ENGINE.run.noTimestamp', 'ENGINE', (ctx) => {
  /*
   * 🔴 日志与「最后更新」里**不得出现时间戳**（《03》§3.3）。
   *
   * 引擎的阶段日志行形态是 `seq N: 原话`，本身不含时刻字段。给它补一个时间戳就是**编数据** ——
   * 与本项目「没有就不显示，不补占位数字」的纪律直接冲突。替代品是**客户端**记录的相对时刻。
   * 这条是防回归的：将来"顺手加个时间戳"看起来像改进，其实是把一个不存在的字段补上了。
   */
  const code = stripComments(ctx.s.engineDiag);
  const problems = [];
  if (/\b\d{1,2}:\d{2}:\d{2}\b/.test(code)) {
    problems.push('出现了形如 HH:MM:SS 的时间戳（引擎不报时刻，补一个就是编数据）');
  }
  if (!code.includes('最后更新：')) problems.push('缺「最后更新：」这一句（没有它就没有替代品）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.run.expandTo8', 'ENGINE', (ctx) => {
  /*
   * 默认 3 行、**就地**扩到 8 行（《03》§3.2）。
   * 3 行 = 一次典型失败所需的最小上下文（失败行 + 它前一步 + 再前一步）；
   * "多看几行"与"看全部"是两个需求：前者高频、不该付跳记录的成本。
   */
  const code = stripComments(ctx.s.engineDiag);
  const problems = [];
  if (!/LOG_DEFAULT\s*=\s*3/.test(code)) problems.push('默认行数不是 3');
  if (!/LOG_EXPANDED\s*=\s*8/.test(code)) problems.push('就地展开的上限不是 8');
  if (!/logMore\s*\?\s*LOG_EXPANDED\s*:\s*LOG_DEFAULT/.test(code)) {
    problems.push('日志区没有按 logMore 在 3 / 8 行之间切换');
  }
  if (!code.includes('set-run-more')) problems.push('缺「展开到 8 行」的就地入口');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.run.logErrorTint', 'ENGINE', (ctx) => {
  /* 失败行就地着色（《03》§3.4）：只靠颜色分轻重，与 R5「统一形状、只靠颜色」同一条尺子 */
  const code = stripComments(ctx.s.engineDiag);
  const css = stripComments(ctx.s.css);
  const problems = [];
  if (!/isFailedLine\(line\)/.test(code)) problems.push('日志行没有按失败态取类名（isFailedLine）');
  if (!/function isFailedLine/.test(code)) problems.push('缺 isFailedLine 的实现');
  const rule = /\.set-run-line\.is-bad\s*\{([^}]*)\}/.exec(css);
  if (!rule) problems.push('缺 .set-run-line.is-bad 的样式规则');
  else if (!/var\(--md-error\)/.test(rule[1])) problems.push('失败行没有取 --md-error');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.run.drawerFull', 'ENGINE', (ctx) => {
  /*
   * 「全部日志」抽屉 = `recentStageLog` **全量**（最多 120 行、倒序）（《03》§7.2 A6）。
   * ⚠️ 它**不能**渲染卡内那 3/8 行的 `shownLogs` —— 那样抽屉只是把卡放大了一点，
   * "一键取全量"这件事并没有做到。
   */
  const code = stripComments(ctx.s.engineDiag);
  const problems = [];
  if (!/LOG_DRAWER_MAX\s*=\s*120/.test(code)) problems.push('抽屉上限不是 120 行');
  if (!/drawerLogs\s*=\s*allLogs\.slice\(0,\s*LOG_DRAWER_MAX\)/.test(code)) {
    problems.push('抽屉没有取全量（应为 allLogs.slice(0, LOG_DRAWER_MAX)）');
  }
  if (!/drawerLogs\.map\(/.test(code)) problems.push('抽屉没有渲染 drawerLogs');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.run.drawerOps', 'ENGINE', (ctx) => {
  /* 抽屉的三个操作与三种关法（《03》§3.6）：少一样就是"打开了出不去"或"看到了拿不走" */
  const code = stripComments(ctx.s.engineDiag);
  const problems = [];
  if (!code.includes('复制全部')) problems.push('缺「复制全部」');
  if (!code.includes('导出 .txt')) problems.push('缺「导出 .txt」');
  if (!/role="dialog"/.test(code)) problems.push('抽屉没有 dialog 语义');
  if (!/aria-label="关闭"/.test(code)) problems.push('缺关闭按钮（或它没有无障碍名）');
  if (!code.includes('set-run-scrim')) problems.push('缺遮罩（点遮罩关闭无处可点）');
  if (!/e\.key === 'Escape'/.test(code)) problems.push('缺 Esc 关闭');
  return { ok: problems.length === 0, detail: problems.join('；') };
});

// —— 模型管理块 ModelManageBlock.tsx ——
add('ENGINE.manage.notOkNotFailed', 'ENGINE', (ctx) => {
  const src = ctx.s.modelManage;
  const problems = [];
  /*
   * 三句话必须分得开：
   *   `v.ok`       → 「校验通过」
   *   `!v.ok`      → 「校验完成：不符 X · 缺失 Y」（**调用成功**，是模型有问题）
   *   verifyError  → 「校验失败」（这才是调用失败）
   * 把前两者合成一句红色的"操作失败"，用户会去查网络与权限，而该做的是点「重新下载模型」。
   */
  if (!/\{v\.ok\s*\?/.test(src)) problems.push('没有按 v.ok 分支（发现不符会被当成操作失败）');
  if (!src.includes('校验通过')) problems.push('缺「校验通过」文案');
  if (!src.includes('校验完成')) problems.push('缺「校验完成」文案（ok:false 会被说成失败）');
  if (!/校验失败：\{eng\.verifyError\}/.test(src)) problems.push('「校验失败」没有与 verifyError 绑定');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.manage.downloadDisabled', 'ENGINE', (ctx) => {
  const src = ctx.s.modelManage;
  // 同上：字段是 A3d 之后的 `runnerExists`（旧写法的 `scriptExists` 已不存在）
  const ok = /runnerExists\s*===\s*false/.test(src);
  return { ok, detail: ok ? '' : '「重新下载模型」没按 runnerExists===false 置灰' };
});
// D4：同一个运行时实况也要在「模型管理」块里出现（那是用户决定"要不要重新下载"的地方）。
add('ENGINE.manage.diskRow', 'ENGINE', (ctx) => {
  const src = stripComments(ctx.s.modelManage);
  const problems = [];
  if (!/models\?\.disk/.test(src)) problems.push('「模型管理」块没有渲染 `models.disk`');
  if (!/disk\.bytes/.test(src)) problems.push('没有显示占用字节');
  if (!/disk\.assembledAt/.test(src)) problems.push('没有显示最近落盘时间');
  // 适用条目数必须取自服务端的 `applicable`，不许自己按平台名硬筛（平台判据只有一处实现）
  if (!/f\.applicable/.test(src))
    problems.push('适用条目数没有取自服务端的 `applicable`（自己按平台名筛会与下载器分叉）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.manage.listCapped', 'ENGINE', (ctx) => {
  const src = ctx.s.modelManage;
  const capped = /slice\(0,\s*8\)/.test(src);
  const restShown = /还有\s*\{rest\}\s*条/.test(src);
  return {
    ok: capped && restShown,
    detail: !capped
      ? '校验结果清单没有截断（几十行会把这一项撑成一整屏，把「引擎诊断」挤出视口）'
      : !restShown
        ? '清单截断后没告诉用户"还有 N 条"（看起来像结果就这么点）'
        : '',
  };
});

// —— 通用单元 NumberInput.tsx ——
add('ENGINE.num.textNotNumber', 'ENGINE', (ctx) => {
  /*
   * ⚠️ 必须剥注释再判：`NumberInput.tsx` 的文件头**正在讨论**为什么不用
   * `<input type="number">`，直接搜字面量会把这段说明当成违规（假红）——
   * 而解红的方式竟是"把说明删掉"，那正好把判据引向最坏的方向。
   */
  const src = stripComments(ctx.s.numberInput);
  if (src.includes('type="number"')) {
    return { ok: false, detail: '用了 <input type="number">：空值会被读成 0（= 从不卸载），且箭头宽度平台相关' };
  }
  const ok = src.includes('type="text"') && src.includes('inputMode="numeric"');
  return { ok, detail: ok ? '' : '不是 type="text" + inputMode="numeric"（见该文件头 ①②③）' };
});
add('ENGINE.num.rejectsEmpty', 'ENGINE', (ctx) => {
  const src = ctx.s.numberInput;
  /*
   * `Number('')` 是 **0**，而 0 在本项目的语义是「从不卸载」。
   * 所以空串必须**单独挡掉** —— 这是这个组件存在的首要理由。
   */
  const ok = /trim\(\)\s*!==\s*''/.test(src);
  return { ok, detail: ok ? '' : '没有显式挡掉空串（把框清空会被读成"设为 0 = 从不卸载"，且无任何提示）' };
});
add('ENGINE.num.commitOnBlurOrEnter', 'ENGINE', (ctx) => {
  const src = ctx.s.numberInput;
  const onBlur = /onBlur=\{commit\}/.test(src);
  const onEnter = /'Enter'/.test(src) && /commit\(\)/.test(src);
  // 逐字符提交会让「5 → 30」的中途真的写成 3 分钟 —— 一次真实生效的写入
  const perChar = /onChange=\{commit\}/.test(src);
  const problems = [];
  if (!onBlur) problems.push('没有 onBlur 提交');
  if (!onEnter) problems.push('回车不提交');
  if (perChar) problems.push('逐字符提交（改 5→30 会先写成 3，那是真实生效的写入）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});

// —— 样式：组件用到的每个 set-diag-*/set-manage-*/set-warn/set-hint 类都必须有规则 ——
add('ENGINE.css.classes', 'ENGINE', (ctx) => {
  /*
   * 反向判据：**从组件里把类名抽出来**，逐个要求样式里有对应规则。
   * 正向（写一份清单去查）测不到"组件用了新类但忘了写 CSS" —— 而那正是
   * 新增一整块 UI 时最常见的空缺，症状是元素照常渲染、只是完全没有样式。
   *
   * ⚠️ 2026-10-07 前缀扩容：`set-state` / `set-pnum` / `set-token` / `set-idle` /
   * `set-note` / `set-row` 一并纳入。理由不是"顺手多查几个"，而是这一轮新增的
   * 界面元素**恰好都落在这些前缀上**（状态 chip、端口 chip、令牌输入框、空闲卸载合卡、
   * 组说明抽屉、行内 why）。前缀不扩，这一轮的新 UI 就整片不在反向判据覆盖内 ——
   * 元素照常渲染、只是没有样式，与"忘了写 CSS"完全同形。
   * ⚠️ ver2.2 再扩容 `set-src`：在线翻译配置块（来源下拉 + 平台 + 密钥两行 + 两按钮）
   * 整片落在该前缀上，不扩则这块新 UI 同样没有样式兜底。
   */
  const srcs = [ctx.s.sections, ctx.s.engineDiag, ctx.s.modelManage, ctx.s.parts].join('\n');
  const used = new Set();
  for (const m of srcs.matchAll(/\bset-(?:diag|manage|warn|hint|state|pnum|token|idle|note|row|run|src)[a-z0-9-]*/g)) {
    used.add(m[0]);
  }
  const css = ctx.s.css;
  const missing = [...used].filter((c) => !css.includes(`.${c}`));
  const problems = missing.map((c) => `.${c}`);
  // `is-pending` 是状态修饰符，不在上面的前缀里，单独钉住
  if (!css.includes('.set-hint.is-pending')) problems.push('.set-hint.is-pending');
  // `set-row-why.is-one` / `set-idle-tag.is-*` 同理：修饰符不进前缀抽取（写死会误伤同类）
  if (!css.includes('.set-row-why.is-one')) problems.push('.set-row-why.is-one');
  return {
    ok: problems.length === 0,
    detail: problems.length ? `样式缺规则：${problems.join('、')}（元素会渲染成没有样式的裸文本）` : '',
  };
});

// —— 盒式提示叠行的附注类时，盒子的内边距不能被附注的简写吃掉 ——
add('ENGINE.css.noticePadding', 'ENGINE', (ctx) => {
  /*
   * 失效形态（用户实测）：`<div className="notice is-bad set-row-note">读不到引擎选项：…</div>`
   * 渲染成"边框贴着文字、左右顶格" —— 编译得过、不抛错、断言不红，只是界面不对。
   *
   * 成因：`.notice`（盒式，`padding: 9px 11px`）与 `.set-row-note`（无边附注，
   * `padding: 0 0 10px`）都是**单个类**，特异性打平 ⇒ 胜负只由 `index.scss` 的 `@use`
   * 顺序决定，而 `components.scss` 排在 `manga.scss` 之后 ⇒ 附注的简写赢，把上/左/右清零。
   *
   * 判据分两半，缺一不可：
   *   ① 必须存在**两类的**补偿规则 `.notice.set-row-note{…}`，且其 padding 与 `.notice`
   *      自身逐字相同（用 `.notice` 的实际取值去比，而不是写死 `9px 11px` —— 写死会让
   *      「.notice 改了内边距」与「补偿规则没跟着改」这两件事都测不出来）。
   *   ② `.set-row-note` 自身**不许**改成长写（`padding-top: …`）—— `minify: "esbuild"`
   *      会把四条长写重新合并成简写，修复在压缩阶段被悄悄撤回。这一条钉住"别用那种写法"。
   *
   * 反证：注掉 ① 那条规则 ⇒ 无补偿规则、盒子重回被清零态 ⇒ 变红；
   *      把 ② 改成四条长写 ⇒ 命中"会被 esbuild 合并"⇒ 变红。
   */
  const css = stripComments(ctx.s.css);
  const problems = [];

  // `.notice` 的 padding 取值（单个类、非契约类）——作为比较基准
  const notice = css.match(/\.notice\s*\{([^}]*)\}/);
  const noticePad = notice && notice[1].match(/padding\s*:\s*([^;}]+)/);
  if (!noticePad) {
    problems.push('样式里找不到 `.notice` 的 padding（基准取不到，本判据无从比对）');
  } else {
    const want = noticePad[1].replace(/\s+/g, ' ').trim();
    // ① 两类的补偿规则必须存在，且 padding 与 `.notice` 一致
    const fix = css.match(/\.notice\.set-row-note\s*\{([^}]*)\}/);
    if (!fix) {
      problems.push('缺 `.notice.set-row-note` 补偿规则（盒式提示叠附注类时四周留白被清零）');
    } else {
      const got = fix[1].match(/padding\s*:\s*([^;}]+)/);
      if (!got) problems.push('`.notice.set-row-note` 里没有 padding（补偿未落到位）');
      else if (got[1].replace(/\s+/g, ' ').trim() !== want) {
        problems.push(`补偿规则的 padding 与 .notice 不一致（${got[1].trim()} ≠ ${want}）`);
      }
    }
  }

  // ② `.set-row-note` 自身不许出现长写（会被 esbuild 合并回去，等于修复被撤回）
  const rowNote = css.match(/\.set-row-note\s*\{([^}]*)\}/);
  if (rowNote && /padding-(?:top|right|bottom|left)\s*:/.test(rowNote[1])) {
    problems.push('`.set-row-note` 用了 padding 长写（esbuild 会合并回简写，修复会被撤回）');
  }

  return {
    ok: problems.length === 0,
    detail: problems.length ? problems.join('；') : '',
  };
});

// ============================ FONT 组 ============================
// 随仓字体（`public/assets/fonts/<dir>/font.css` + 字体文件）有三条**编译得过、构建成功、
// 页面照常显示**的静默失效路径，本组专治这三条：
//   ① 清单没被任何入口引用 ⇒ 字体根本不加载（搬进 public 前的旧形态是"没走 JS 侧 import"）；
//   ② 清单被写进 sass 的 `@use` —— Sass 对带 `.css` 的 `@use` 静默丢弃 ⇒ 字体资源全不进构建；
//   ③ 清单里的 `url()` 指错位置 ⇒ public 下的 css **不被构建改写**，路径错就是 404。
// 本组按**目录扫描**，不写死具体字体名（换字体不必改断言）。

/** 采集「带 font.css 清单」的随仓字体目录名 */
const fontDirsWithCss = () =>
  existsSync(F.fontsDir)
    ? readdirSync(F.fontsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(path.join(F.fontsDir, d.name, 'font.css')))
        .map((d) => d.name)
    : [];

/** 采集所有随仓 font.css 里声明的家族名 */
const declaredFamilies = () => {
  const out = new Set();
  for (const dir of fontDirsWithCss()) {
    const css = readFileSync(path.join(F.fontsDir, dir, 'font.css'), 'utf8');
    for (const m of css.matchAll(/font-family\s*:\s*['"]([^'"]+)['"]/g)) out.add(m[1]);
  }
  return out;
};

// —— ① 每份随仓 font.css 都必须被入口 HTML 用 <link> 引到，且**不得**走 sass 的 @use ——
add('FONT.viaJsModule', 'FONT', (ctx) => {
  /*
   * 失效形态（**实测踩过**，2026-10-16 前的旧形态）：把某份 `font.css` 写成
   * `styles/index.scss` 里的 `@use '../assets/fonts/<dir>/font.css';`
   *
   * 后果：Sass 对「带 `.css` 后缀的 `@use`」是**静默丢弃**的 —— 不报错、不产出、
   * 也不改写其中的 `url()`。于是 `npm run build` 照常成功、
   * 但 `dist/assets/` 里**一个该字体的分片都没有**（实测 0 个），
   * 页面照常渲染，只是**回落**到下一个字体 —— 与"没改过"完全同形。
   *
   * 2026-10-16 起字体搬进 `public/assets/fonts/`（公共资源，不经过构建），
   * 加载方式随之从"main.tsx import"改为"入口 HTML `<link>`"。判据跟着搬家改写，
   * 但要防的是**同一类失效**：
   *   ① `templates/index.html` 必须 `<link>` 每一份 font.css（漏一条 ⇒ 该字体不加载）；
   *   ② `index.scss` 里**不许**出现指向任何 font.css 的 `@use`（防有人"顺手挪回去"）；
   *   ③ 清单里的 `url()` 必须是同目录相对路径或 `/assets/fonts/` 前缀 ——
   *      public 下的 css 不被构建改写，写错就是 404，且同样不报错。
   */
  const entry = stripComments(ctx.s.entryHtml);
  const scss = stripComments(readMaybe(path.join(F.stylesDir, 'index.scss')));
  const problems = [];

  for (const dir of fontDirsWithCss()) {
    if (!new RegExp(`<link[^>]+href="/assets/fonts/${dir}/font\\.css"`).test(entry)) {
      problems.push(`入口 HTML 没有 link ${dir}/font.css（该字体根本不会加载）`);
    }
    const css = readFileSync(path.join(F.fontsDir, dir, 'font.css'), 'utf8');
    for (const m of css.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g)) {
      const u = m[1];
      // 同目录相对：`./x` 或不带斜杠的 `x`。⚠️ 别把"以 / 开头"算进相对 —— 那正是绝对路径。
      const okRel = u.startsWith('./') || !u.startsWith('/');
      const okAbs = u.startsWith(`/assets/fonts/${dir}/`);
      if (!okRel && !okAbs) {
        problems.push(`${dir}/font.css 的 url() 指向 ${u} —— public 下的 css 不被构建改写，该路径会 404`);
      }
    }
  }
  // 入口里出现指向 font.css 的 @use ⇒ 一定是被挪回 sass 了（那会静默丢弃）
  if (/@use\s+['"][^'"]*font\.css['"]/.test(scss)) {
    problems.push('index.scss 用 @use 引了 font.css —— Sass 会静默丢弃该 .css（字体资源不会进构建）');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

// —— ② 三栈首位族名必须能找到真实来源（随仓 face 或 fontsource 包）——
add('FONT.stackFirstHasFace', 'FONT', (ctx) => {
  /*
   * 失效形态：族名写错一个字符（例如把 `Swei Gothic CJK SC` 写成文件名
   * `SweiGothicCJKsc-Regular`，或取成逐字重的 `… SC Regular`）——
   * 浏览器认不出该族名，**整个首位静默失效**，直接回落下一项。
   * 无报错、无警告、构建正常，所以「首位到底有没有真实字形」必须被钉住。
   *
   * 判据（对 display / body / numeric 三栈逐栈检查，不比具体字体名）：
   *   FONT.<栈> 的首位族名，必须能在①随仓 font.css 的 font-family，或
   *   ②`main.tsx` 里 fontsource 包名（族名转 kebab 后）中找到 —— 二者皆无 ⇒ 静默回落。
   */
  const families = declaredFamilies();
  const fontsource = new Set([...stripComments(ctx.s.main).matchAll(/@fontsource\/([a-z0-9-]+)\//g)].map((m) => m[1]));
  const tokens = stripComments(ctx.s.tokens);
  const problems = [];

  for (const key of ['display', 'body', 'numeric']) {
    // 值形如 `" 'Font A', 'Font B', … "` —— 外层是双引号、内部含单引号，
    // 故外层按引号种类配对取值，不能写成「见引号就停」（那会在内部第一个单引号处截断）。
    const m = tokens.match(new RegExp(`\\b${key}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`));
    if (!m) {
      problems.push(`tokens.ts 里找不到 FONT.${key}`);
      continue;
    }
    const stack = m[1].slice(1, -1); // 去外层引号，留栈本身
    const first = (stack.match(/^\s*['"]([^'"]+)['"]/) || [])[1];
    if (!first) {
      problems.push(`FONT.${key} 的首位取不到（字体栈写法变了）`);
      continue;
    }
    const slug = first
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!families.has(first) && !fontsource.has(slug)) {
      problems.push(`FONT.${key} 首位「${first}」在随仓 font.css 与 fontsource 清单里都找不到 ⇒ 该栈静默回落`);
    }
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

// —— ③ 每份清单的 @font-face 条数必须与目录内字体文件数一致 ——
add('FONT.assetsPresent', 'FONT', (ctx) => {
  /*
   * 这条治的是**假绿成本最低**的失效：字体文件被误删 / 未随 git 提交 / 被 .gitignore 误伤时，
   * 清单里的某些 @font-face 会指向不存在的文件 —— 缺的那部分汉字回落、其余正常，
   * 于是"大部分字看着是对的"，最难被发现。
   *
   * 判据：对每个含 font.css 的目录，
   *   ① 清单里 @font-face 条数 == 目录内字体文件（woff2/woff/ttf/otf）数（清单与资产互为对照）；
   *   ② 条数与文件数都不为 0（空挂清单 / 空目录即红）。上限也钉住：条数多于文件数同样红。
   */
  const problems = [];
  for (const dir of fontDirsWithCss()) {
    const full = path.join(F.fontsDir, dir);
    const css = readFileSync(path.join(full, 'font.css'), 'utf8');
    const nFaces = (css.match(/@font-face\s*\{/g) || []).length;
    const files = readdirSync(full).filter((f) => /\.(woff2|woff|ttf|otf)$/i.test(f));
    if (nFaces === 0) problems.push(`${dir}/font.css 里 0 条 @font-face`);
    else if (files.length === 0) problems.push(`${dir}/ 里没有字体文件（清单成空挂）`);
    else if (nFaces !== files.length) {
      problems.push(`${dir}：@font-face ${nFaces} 条 vs 字体文件 ${files.length} 个（清单与资产不符）`);
    }
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

// —— markdown 强调标记：必须被解析，且 JSX 裸文本里不许出现 ——
add('ENGINE.emphasis.impl', 'ENGINE', (ctx) => {
  const body = fnBody(ctx.s.parts, 'emphasis');
  if (!body) return { ok: false, detail: 'parts.tsx 里找不到 emphasis 的实现体（catalog 文案里的 `**` 会被原样显示）' };
  const problems = [];
  if (!/split\('\*\*'\)/.test(body)) problems.push("没有按 '**' 分割");
  // 成对的 `**` 才构成重点：落单时**原样保留**，不做"补一个"的猜测
  if (!/%\s*2\s*===\s*0/.test(body)) problems.push('没有"落单 ** 原样保留"的奇偶校验（会把后半句整段加粗）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.emphasis.renderPoints', 'ENGINE', (ctx) => {
  /*
   * catalog 的 `note` / `why` / `blurb`、spec-check 的 `label` / `detail`
   * 全都是**给用户看的文案**，全都含 `**` 标记。
   * 只做解析器、不把渲染点全接上，等于什么都没修（而且更糟：以为修好了）。
   * 所以要逐个渲染点断言它真的走了 `emphasis`。
   *
   * ⚠️ 每个 `src` 都要**先剥注释**再 `includes`：本仓注释里大量引用渲染点的写法
   * （例如 EngineDiag 的文件头就写着"`item.label` + `emphasis(item.why)`"），
   * 不剥的话，把代码里的 `emphasis(item.why)` 换成硬写字符串之后，
   * 注释那一份仍会让它绿 —— 判据被注释撑着（实测过这条假阳性）。
   */
  const points = [
    ['组级说明（note）', fnBody(ctx.s.parts, 'GroupNote'), 'emphasis(children)'],
    ['标准行（why）', fnBody(ctx.s.parts, 'Row'), 'emphasis(item.why)'],
    ['待接入行（why）', fnBody(ctx.s.parts, 'PendingRow'), 'emphasis(item.why)'],
    ['通栏块（why）', ctx.s.modelManage, 'emphasis(item.why)'],
    // 诊断面板的 why 也是 catalog 文案（见 ENGINE.diag.fromCatalog）——漏了它，
    // 面板顶上那句 100+ 字的 why 会原样显示 `**默认收起、点开即见**` 两个星号
    ['诊断面板（why）', ctx.s.engineDiag, 'emphasis(item.why)'],
    ['组标题下的 blurb', ctx.s.settingsScreen, 'emphasis(active.blurb)'],
    ['规格自检 label/detail', ctx.s.specCheck, 'emphasis(r.label)'],
  ];
  const missing = points.filter(([, src, needle]) => !src || !stripComments(src).includes(needle)).map(([n]) => n);
  const specOk = /emphasis\(r\.detail\)/.test(ctx.s.specCheck);
  if (!specOk) missing.push('规格自检 detail');
  return {
    ok: missing.length === 0,
    detail: missing.length ? `这些渲染点没走 emphasis：${missing.join('、')}` : '',
  };
});
add('ENGINE.md.noRawAsterisks', 'ENGINE', (ctx) => {
  /*
   * JSX **裸文本**里没法经过 `emphasis`（它是散文，不是一整个字符串），
   * 所以只能靠"不许出现"来守。判据必须先剥注释 —— 本仓注释里大量引用 `**`,
   * 直接搜字面量会全红，而那种红是假红（会把真正的漏出埋在噪声里）。
   */
  const files = [
    ['sections.tsx', ctx.s.sections],
    ['EngineDiag.tsx', ctx.s.engineDiag],
    ['ModelManageBlock.tsx', ctx.s.modelManage],
    ['CacheBlock.tsx', ctx.s.cacheBlock],
  ];
  const hits = [];
  for (const [name, src] of files) {
    const code = stripComments(src);
    code.split('\n').forEach((line, i) => {
      if (line.includes('**')) hits.push(`${name}:${i + 1} ${line.trim().slice(0, 60)}`);
    });
  }
  return {
    ok: hits.length === 0,
    detail: hits.length
      ? `JSX 裸文本里漏出 markdown 的 **（界面上会显示两个星号）：\n      ${hits.join('\n      ')}`
      : '',
  };
});

// ================================================================ X-C3「准备中」
//
// 守 S6 的「L1–L4 文案 + 首张稍慢」（《02》§3/§4、《09》§6.1）。
// 这一屏不在设置页里，但它和设置页共享**同一条事实源**：Rust 的 `StatusView`
// （`phase` / `mode` / `children` / `degraded`）—— 所以放同一轮断言，
// 免得"Rust 加了字段、TS 类型没跟"这类缺口两边都漏。

/**
 * 装配四段的四句用户感知文案（D-231⑥，取代 L1–L4「服务启动分层」）。
 * 🔴 与 `src/screens/manga/NotReadyScreen.tsx` 的 `ASSEMBLY_PHASES` 逐字一致。
 */
const NOTREADY_TEXTS = [
  ['prepare', '环境准备'],
  ['runtime', '运行环境装配'],
  ['visual', '视觉模型装配'],
  ['llm', 'LLM 翻译模型装配'],
  ['ready', '就绪'],
];

add('NOTREADY.stages.texts', 'NOTREADY', (ctx) => {
  const src = ctx.s.assembly;
  const missing = NOTREADY_TEXTS.filter(([, t]) => !src.includes(`text: '${t}'`)).map(([id]) => id);
  const at = NOTREADY_TEXTS.map(([id]) => src.indexOf(`id: '${id}'`));
  const ordered = at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1]));
  const problems = [];
  if (missing.length) problems.push(`装配五段文案缺失：${missing.join('、')}`);
  if (!ordered) problems.push('五段顺序不是 环境准备 → 运行环境装配 → 视觉模型装配 → LLM 翻译模型装配 → 就绪');
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('NOTREADY.stages.phaseDriven', 'NOTREADY', (ctx) => {
  /*
   * 这一条盯的是**进度事实源**。历史上它盯 `sidecar_port ? 2 : 1`（拿"引擎端口在不在"
   * 猜阶段），D-231⑥ 起改盯 `download.step` + `runtime.ready`：
   *   ① 段号只能来自服务端的 `modelDownload.step`（`assemblyReached(download?.step, …)`）；
   *   ② 第四段由 `runtime.ready` 这个**判据**收尾，不是第四个事件；
   *   ③ `status.phase` **不得**再被当进度事实源 —— 它是**服务启动**阶段（L1/L2/L3），
   *      与装配是两台不同的状态机，混进同一条时间线会出现"文案说预热、时间线说在装 Python"。
   *      🔴 它仍**保留在动作判据里**（失败时要不要给「重新下载模型」），所以不能粗暴地
   *      一刀切"源码里不许出现 phase"。
   * ④ 旧写法 `sidecar_port ? 2 : 1` 仍要钉死 —— 那是"用事实猜状态"的反面教材。
   */
  const code = stripComments(ctx.s.notReady);
  const asm = stripComments(ctx.s.assembly);
  const problems = [];
  if (!/assemblyNotes\(status, download\)/.test(code)) {
    problems.push('段号没有来自 `download.step`（五段时间线与装配事实源脱钩）');
  }
  if (!asm.includes('STEP_INDEX')) problems.push('没有 step → 段下标的映射表');
  if (!/STEP_INDEX\[download\.step\]/.test(asm)) {
    problems.push('`STEP_INDEX` 没有真的接 `download.step`');
  }
  if (!/notes\[4\] = 'done'/.test(asm)) {
    problems.push('第五段「就绪」没有由真实判据收尾（就绪后最后一段永远停在「进行中」）');
  }
  if (/status\?\.phase\s*\?/.test(code)) {
    problems.push('又把 `status.phase` 当进度事实源了（它是服务启动阶段，不是装配阶段）');
  }
  if (/sidecar_port\s*\?\s*2\s*:\s*1/.test(code)) {
    problems.push('仍在用 sidecar_port 猜阶段（端口在听 ≠ 阶段已过）');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('NOTREADY.phase.readyNotEvent', 'NOTREADY', (ctx) => {
  /*
   * 「就绪」**不是第四个事件**，而是从判据推导出来的（D-231③ 起是七项全真）。
   * 两条写错都会让用户卡在一个永远走不完的界面上：
   *   ① 让它变成事件 ⇒ "装配跑完了但判据不过"的机器永远停在第 3 段，看不出到底缺什么；
   *   ② 让它有进度事件但没收尾 ⇒ 判据全真之后第 4 段永远显示「进行中」。
   * 所以 `STEP_INDEX` 里**必须没有** `ready`，而 `assemblyReached` 必须有 ready 收尾那支。
   * （原 `NOTREADY.l4.notStartup` 盯的是 L4「首图时完成」那支状态词，随 L1–L4 一并退役。）
   */
  const asm = stripComments(ctx.s.assembly);
  const problems = [];
  if (/STEP_INDEX[^=]*= *\{[^}]*\bready\b/.test(asm)) {
    problems.push('`STEP_INDEX` 里出现了 `ready`（就绪不是事件，是判据）');
  }
  if (!/notes\[4\] = 'done'/.test(asm)) {
    problems.push('`assemblyNotes` 没有 ready 收尾（就绪后最后一段永远停在「进行中」）');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('NOTREADY.state.fiveStates', 'NOTREADY', (ctx) => {
  /*
   * Rust 的 `ServiceState` 是**五态**（S2 加了 `stopping`）。TS 侧漏同步的症状不是编译错，
   * 而是运行期 `stateView()` 返回 `undefined`、调用方取 `.text` 直接崩 —— 且崩之前
   * 表现为"状态点不显示"。所以**三头**都断言：类型定义 + `nav.ts` 的 `STATE_VIEW`
   * + `EngineDiag.tsx` **自带的那一份** `STATE_VIEW`。
   */
  const ipc = stripComments(ctx.s.ipc);
  const nav = stripComments(ctx.s.nav);
  const want = ['stopped', 'starting', 'running', 'stopping', 'error'];
  const problems = [];
  const m = ipc.match(/export type ServiceState\s*=\s*([^;]+);/);
  if (!m) problems.push('ipc.ts 找不到 ServiceState 定义');
  else {
    const missing = want.filter((w) => !m[1].includes(`'${w}'`));
    if (missing.length) problems.push(`ServiceState 缺：${missing.join('、')}`);
  }
  const missNav = want.filter((w) => !nav.includes(`${w}: { text:`));
  if (missNav.length) problems.push(`nav.ts 的 STATE_VIEW 缺：${missNav.join('、')}`);
  /*
   * `EngineDiag.tsx` **自带一份**映射表、刻意不复用 nav.ts（理由见该文件注释），
   * 所以"nav.ts 齐全"推不出"它也齐全" —— S2 给服务端加 `stopping` 时正是它漏了。
   * 症状是不崩不报错，只把**英文裸 id** `stopping` 直接显示给用户，
   * 而同一状态在设置页状态行显示「正在停止」⇒ 同一状态两处两译。
   */
  const diag = stripComments(ctx.s.engineDiag);
  const missDiag = want.filter((w) => !diag.includes(`${w}: { text:`));
  if (missDiag.length) {
    problems.push(`EngineDiag.tsx 的 STATE_VIEW 缺：${missDiag.join('、')}（漏键会把英文裸 id 显示给用户）`);
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('NOTREADY.wiring.modeDegraded', 'NOTREADY', (ctx) => {
  /*
   * 「以为在跑真引擎、其实跑的替身」是本项目最难查的一类故障（`mode` 存在的唯一理由）。
   * 三进程 pid/alive 与 degraded 同理：状态屏的价值就是把它们摆到明面上。
   */
  const src = ctx.s.notReady;
  const problems = [];
  /*
   * ⚠️ 判据必须落在**渲染那一处**，不能只判 `src.includes('status?.mode')`。
   * `status?.mode` 在本文件里出现两次：一处是 meta 行的 chip（本断言要保的就是它），
   * 另一处是 `runtimeUnready` 的**判定**（L0 分支的条件，与"显示"无关）。
   * 只判"出现过"时，把 chip 那处删掉、断言照旧绿 —— 反证轮实测就是这样一条假阳性。
   */
  if (!/引擎模式\s*\{status\?\.mode/.test(src))
    problems.push('没有显示 status.mode（"以为在跑真引擎、其实跑的替身"最难查）');
  if (!src.includes('status?.degraded')) problems.push('没有显示 degraded');
  if (!src.includes('status?.children')) problems.push('没有显示三进程 pid/alive');
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('NOTREADY.retry.byPhase', 'NOTREADY', (ctx) => {
  /* 《02》§4「按失败阶段提供『重试当前阶段』（L2 失败给『重新下载模型』）」 */
  const code = stripComments(ctx.s.notReady);
  const problems = [];
  if (!/failed\s*&&\s*status\?\.phase === 'L2'/.test(code)) {
    problems.push('没有按失败阶段分派重试（L2 失败应给「重新下载模型」）');
  }
  if (!code.includes('downloadEngineModels')) problems.push('没有真正调用下载端点（按钮会是个摆设）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('NOTREADY.detail.noFabricatedProgress', 'NOTREADY', (ctx) => {
  /*
   * X-C3 只在 **manga-service 自己没起来**时出现 —— 此刻没有任何 HTTP 通道可读下载进度。
   * 所以"L1/L2 显示可量化进度"只能由**真实来源**满足：谁真的在打进度行，那一行就原样显示。
   * 判据是"不许出现硬编码的字节/百分比字面量"，而不是"必须有进度" —— 后者会逼出编造。
   */
  const code = stripComments(ctx.s.notReady);
  const asm = stripComments(ctx.s.assembly);
  const problems = [];
  if (!/lastLogLine\(status\?\.log\)/.test(code)) problems.push('L2 明细不是取自真实日志');
  const fake = (code + '\n' + asm).match(/['"][^'"]*?(?:\d[\d.]*\s*(?:GB|MB|KB)|[\d.]+\s*%)[^'"]*?['"]/g);
  if (fake) problems.push(`出现了硬编码的进度数字：${fake.join('、')}`);
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('NOTREADY.css.classes', 'NOTREADY', (ctx) => {
  /*
   * 反向判据：从组件里把类名抽出来，逐个要求在样式表里有规则（同 ENGINE.css.classes 的理由）。
   *
   * ⚠️ 后缀必须吃 `[a-z0-9-]*`：只匹配到 `stage-meta` 的话，把类名改成
   * `stage-meta-item-v2` 会**仍然命中**（`stage-meta` 前缀还在），反证就成了假反证。
   *
   * ⚠️ 2026-10-07：X-C3 从「四行列表」改成「时间线」，类名族由 `stage-*` 换成
   * `tl-*` / `nr-*` / `mchip`。**老写法一并留在抽取表里**，否则这次重构等于把这条判据
   * 整体关掉：`used` 变成空集 ⇒ 断言恒绿且什么都不查（空缺键 = 静默跳过）。
   * 新族必须同时进抽取表，才叫"迁移"而不是"绕过"。
   */
  const src = ctx.s.notReady;
  const used = new Set();
  // ① 基础类名：逐族列出，不用 `[\w-]*` 一把捞（那会把 `stage-meta` 这类前缀也算进要求）
  for (const m of src.matchAll(
    /\b(?:stage-(?:hint|detail|meta|meta-item)|tl-(?:step|rail|node|line|body|head|title|state|detail)|nr-(?:sum|sum-t|sum-d|dot|meta|acts|guide)|mchip)[a-z0-9-]*/g,
  )) {
    used.add(m[0]);
  }
  /*
   * ② 变体类（`tl-step is-current` 这种**写死在源码里**的组合）—— 连宿主一起要求，
   *    否则「把 is-done 换成 is-donex」会因为宿主 `.tl-node` 存在而蒙混过关。
   *    这里的 `is-*` 都是字面量（组件用的是 switch 返回定值，不是模板拼接），所以抽得到。
   */
  for (const m of src.matchAll(/\b(tl-step|tl-node|nr-sum|nr-guide-toggle|mchip)((?:\s+[a-z][a-z0-9-]*)*)/g)) {
    for (const extra of m[2].trim().split(/\s+/).filter(Boolean)) {
      if (extra === 'num') continue; // `.num` 是 base.scss 的全局工具类，不属本组
      used.add(`${m[1]}.${extra}`);
    }
  }
  const missing = [...used].filter((c) => !ctx.s.css.includes(`.${c}`));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `样式缺规则：${missing.map((c) => `.${c}`).join('、')}` : '',
  };
});

add('NOTREADY.timeline.derivedFromStages', 'NOTREADY', (ctx) => {
  /*
   * 时间线**恰 4 步**，且步数与序号都由 `ASSEMBLY_PHASES` 单源派生 —— 不是写死的 1/2/3/4。
   * 为什么要单列一条：`NOTREADY.stages.texts` 只查"那四句在不在、顺序对不对"，
   * 它管不住"多渲染一行"或"序号写成 `i + 2`"这类**与数据脱钩**的改法。
   */
  const asm = stripComments(ctx.s.assembly);
  const tl = stripComments(ctx.s.timeline);
  const problems = [];
  const ids = [...asm.matchAll(/id: '(prepare|runtime|visual|llm|ready)'/g)].map((m) => m[1]);
  if (ids.length !== 5) problems.push(`ASSEMBLY_PHASES 不是 5 段（实为 ${ids.length}：${ids.join('/') || '无'}）`);
  if (!/ASSEMBLY_PHASES\.map\(/.test(tl)) problems.push('时间线不是由 ASSEMBLY_PHASES 渲染的（步数会与数据脱钩）');
  if (!/i \+ 1/.test(tl)) problems.push('节点序号不是下标派生（i + 1）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('NOTREADY.timeline.explicitLoading', 'NOTREADY', (ctx) => {
  /*
   * 本屏新增的**显式 loading 态**（用户诉求：现有四态之外补 loading）。
   * 判据分两半，缺一不可：
   *   ① 组件侧：「进行中」必须映射到 `is-loading` —— 状态词与形态收在一处；
   *   ② 样式侧：`.tl-node.is-loading::after` 必须真挂着**旋转动画**。
   * 只查 ① 会漏"类名对、圈不转"；只查 ② 会漏"样式在、根本没有一段代码进入这个态"。
   * 旋转是用户区分"在动"与"卡住了"的**唯一**信号 —— 不动的「进行中」看起来与卡住一样。
   */
  const tl = stripComments(ctx.s.timeline);
  const css = ctx.s.css;
  const problems = [];
  if (!/active:\s*'is-loading'/.test(tl)) problems.push('「进行中」没有映射到 is-loading');
  if (!/\.tl-node\.is-loading\s*\{/.test(css)) problems.push('样式表没有 .tl-node.is-loading 规则');
  if (!/\.tl-node\.is-loading::after\s*\{[^}]*animation:\s*tlspin/.test(css)) {
    problems.push('节点外圈没有挂旋转动画（「进行中」会与"卡住了"看起来一模一样）');
  }
  if (!/@keyframes\s+tlspin\s*\{/.test(css)) problems.push('没有 @keyframes tlspin');
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('NOTREADY.phase.readyTerminal', 'NOTREADY', (ctx) => {
  /*
   * 第四段「就绪」在判据全真之后必须**结构性地**拿到「已完成」，且**永远拿不到**「进行中」。
   * 两种写错都会让用户以为最后一段还在走：
   *   ① `assemblyReached` 少了 ready 收尾 ⇒ `reached` 卡在 3 ⇒ 第 4 段（i === 3）显示「进行中」，
   *      而且是**永远**转下去 —— 就绪判据明明已经全真了；
   *   ② 反过来把 `ready` 塞进 `STEP_INDEX` ⇒ `reached` 可能是 3，但语义上多了一个事件。
   * 这条与 `NOTREADY.phase.readyNotEvent`（盯"就绪不是事件"）互补：那条盯语义，这条盯结构。
   */
  const asm = stripComments(ctx.s.assembly);
  const problems = [];
  if (!/if \(status\.state === 'running' && status\.runtime\?\.ready && !status\.degraded\) \{/.test(asm)) {
    problems.push('第五段「就绪」没有由「七项全真 + 服务 running + 非降级」收尾（会永远显示「进行中」）');
  }
  if (!/notes\[4\] = 'done'/.test(asm)) {
    problems.push('没有把最后一段结构性地置为 done');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

// ================================================================ ② 分组简洁化（2026-10-07 拍板）
//
// 这一轮的动作**全是减法**：组说明折叠（700 字 → 一行 + 抽屉）、行内 why 压一行、
// 两个空闲卸载阈值合卡、状态行拆 chip、三处警告统一成一条语汇；外带三项既有拍板
// （令牌值改只读输入框 / 档位与后端下拉贴最右 / 引擎诊断默认折叠＝方案 B）。
//
// ## 为什么减法比加法更需要断言
// 加法漏了会**看得见**（少一个控件、少一段文字），减法漏了看不见 ——
// 折叠没接上数据、合卡把两个数据项并成了一个、下拉又漂回左边，这些改动的共同点是
// **编译过、不报错、tsc 过、界面照常渲染**，只是不再是这一轮商定的样子。
// 更麻烦的是反向：真把内容删掉了也照样"渲染正常"，而"信息精简"这个诉求
// 离"信息丢失"只有一步。所以这里的判据全部锚在**结构**上而非观感上：
//   · 折叠抽屉必须真的接上 catalog 数据（不是硬写一行摘要）；
//   · 合卡之后两个阈值必须**仍是两个数据项**（渲染分组 ≠ 合并数据项）；
//   · 压一行只砍 `why`，`CtlNote` 不许跟着消失（那条小字说的是"为什么此刻是灰的"）。
//
// ⚠️ 组名单列 `SIMPLIFY`（而不是并进 ENGINE）：ENGINE 那二十余条守的是
// 「十三项接真实能力」，这九条守的是「同一批能力换了一种更短的说法」。
// 混在一起，回归时就分不清是"能力掉了"还是"话又变长了"。

/** 比对摘要与原文前，两侧都去掉空白与 `**` —— 星号是强调标记，不是内容 */
const normNote = (t) =>
  String(t ?? '')
    .replace(/\s+/g, '')
    .replace(/\*\*/g, '');

add('SIMPLIFY.notesummary.verbatim', 'SIMPLIFY', (ctx) => {
  /*
   * 「摘要不得成为新的承诺」的可执行形式。
   *
   * `noteSummary` 是折叠态**唯一**可见的那一行（要再点一次「为什么 ?」才看到全文）。
   * 抽句抽错一个词，用户看到的就是一句原文里根本没有的话 —— 而它是这组的门面。
   * 判据：按 ` · ` 切段，去掉空白与 `**` 后，**每段都必须能在 `note` 原文里逐字找到**。
   * 于是三类改错同时变红：① 摘要里出现 note 没写过的说法；② note 改了、摘要没跟；
   * ③ 摘要写成空串 / 一段都切不出来（空转）。
   */
  const dataErr = CAT_ERR(ctx.cat);
  if (dataErr) return { ok: false, detail: dataErr };
  const secs = ctx.cat.mod.SETTINGS_SECTIONS ?? [];
  const problems = [];
  let pairs = 0;
  for (const sec of secs) {
    const note = typeof sec?.note === 'string' ? sec.note : '';
    const sum = typeof sec?.noteSummary === 'string' ? sec.noteSummary : '';
    if (!note) {
      // 组说明可以省略（省略即该组不渲染 GroupNote）；但留了摘要却没留说明，是数据残缺
      if (sum.trim()) problems.push(`${sec.id} 有摘要却没有组说明（摘要无源）`);
      continue;
    }
    if (!sum.trim()) {
      problems.push(`${sec.id} 没有一行摘要（noteSummary）—— 组说明会照旧铺满 6 行`);
      continue;
    }
    pairs++;
    const segs = sum
      .split('·')
      .map((x) => x.trim())
      .filter(Boolean);
    if (!segs.length) {
      problems.push(`${sec.id} 的 noteSummary 切不出一段（空转）`);
      continue;
    }
    for (const seg of segs) {
      if (!normNote(note).includes(normNote(seg))) {
        problems.push(`${sec.id} 摘要里的「${seg}」在 note 原文里找不到（摘要成了新的承诺）`);
      }
    }
  }
  /*
   * 政策（D-134）：组说明**可与不可** —— 不写就不渲染 GroupNote（小节的说明可省略）。
   * 但凡**有**组说明的分组，必须同时配一行摘要（`withNote === pairs`），
   * 且摘要每一段都逐字取自说明（上面的循环负责）。
   * 分母仍写死：5 个分组不许变；另留一条下限防空转 —— 全页不能一个组说明都没有
   * （那是把「组级说明」这一形态整体删掉，属产品决策，不该被一次文案精简顺手带走）。
   */
  const withNote = secs.filter((s) => typeof s?.note === 'string' && !!s.note.trim()).length;
  if (secs.length !== 5) problems.push(`分组数 ${secs.length}，应为 5`);
  if (withNote === 0) problems.push('所有分组都没有组说明 —— 组级说明这一形态被整体移除了');
  if (withNote !== pairs) problems.push(`有 ${withNote} 组带组说明，但只有 ${pairs} 组配了一行摘要`);
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('SIMPLIFY.notesummary.wired', 'SIMPLIFY', (ctx) => {
  /*
   * 数据侧有 `noteSummary` ≠ 界面上会折叠。要防的假绿有两层：
   *   ① 只有数据、`GroupNote` 收不到 `summary` ⇒ 照旧铺全文（= 这一轮白做）；
   *   ② 传是传了，但组件把 `summary` 无视、永远渲染全文 ⇒ 同上，且**更难发现**。
   * 所以两头都断：每组都必须把摘要传进去；组件必须有"没给摘要就不折叠"的退路。
   */
  const dataErr = CAT_ERR(ctx.cat);
  if (dataErr) return { ok: false, detail: dataErr };
  // 分母 = **分组总数**（D-136 起五组都各写一行 <GroupNote>，显隐改由组件自守 ——
  // 与"某组有没有 note"解耦；缺 note 的组由 GroupNote 自己 return null）
  const n = (ctx.cat.mod.SETTINGS_SECTIONS ?? []).length;
  const problems = [];
  // 逐个 `<GroupNote …>` 标签看它有没有带 summary（不锁常量名，重构改名不会误红）
  const calls = ctx.s.sections.match(/<GroupNote[^>]*>/g) ?? [];
  if (calls.length !== n) problems.push(`sections.tsx 里有 ${calls.length} 个 <GroupNote>，应为 ${n}（每组一行）`);
  const noSum = calls.filter((c) => !/summary=\{[\w$]+\.noteSummary\}/.test(c));
  if (noSum.length) {
    problems.push(`${noSum.length} 个 <GroupNote> 没接摘要（数据是死的，界面照旧铺全文）`);
  }
  const gb = fnBody(ctx.s.parts, 'GroupNote');
  if (!gb) problems.push('parts.tsx 里找不到 GroupNote 的实现体');
  else {
    if (!/if\s*\(!summary\)/.test(gb)) problems.push('GroupNote 没有"没给摘要就不折叠"的退路');
    if (!gb.includes('set-note-more')) problems.push('GroupNote 没有渲染「为什么 ?」按钮');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('SIMPLIFY.optional.selfGuard', 'SIMPLIFY', (ctx) => {
  /*
   * 政策：**缺字段 ⇒ 不渲染对应那一行**。`note`（组说明）与 `blurb`（页标题下的描述）
   * 都是可选文案，没写时界面既不该留空行，更不该崩。
   *
   * 为什么必须钉在**渲染层**：`note` 经由 `{X.note as string}` 送进 `<GroupNote>`，
   * 那个 `as string` 把 `string | undefined` 硬掰成了 `string` —— `tsc --noEmit` 放行，
   * 只在运行时炸（本页已因此崩过两次：D-134 MEDIA/RESOURCE、D-135 ABOUT）。
   * 所以显隐判据只能在渲染层自守，且必须被断言盯着，否则下次精简文案又会踩回去。
   *
   * 判据取"有没有守卫"而不是"长什么样"：
   *   ① `GroupNote` 体里必须有 `if (!children) return null`（缺说明直接不渲染，
   *      而不是渲染一个空 `<div className="set-note">` —— 空行同样是缺陷）；
   *   ② `SettingsScreen` 的 blurb 渲染必须挂在 `active.blurb` 的守卫上（`?` 或 `&&`）。
   */
  const problems = [];
  const gb = fnBody(ctx.s.parts, 'GroupNote');
  if (!gb) problems.push('parts.tsx 里找不到 GroupNote 的实现体');
  else if (!/if\s*\(\s*!children\s*\)\s*return\s+null/.test(gb)) {
    problems.push('GroupNote 没有"缺组说明就不渲染"的自守（缺 note 会崩或留空行）');
  }
  const ss = stripComments(ctx.s.settingsScreen ?? '');
  // `active` 在新增「番剧设置」（域内第 6 组）后可为 null ⇒ 守卫写成 `active?.blurb ?`
  if (!/active\??\.blurb\s*[?&]/.test(ss)) {
    problems.push('SettingsScreen 的 blurb 是无条件渲染（缺 blurb 会崩或留空行）');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('SIMPLIFY.why.oneLine', 'SIMPLIFY', (ctx) => {
  /*
   * 行内 `why` 压一行：7 项的 why 各两行，把冻结的 50px 行高顶到 70~80。
   * 但"压一行"有两种做法，只有一种是对的：
   *   ✅ `title` 挂全文 + CSS `nowrap/ellipsis` ⇒ 必然一行，且原文仍在（悬停可读）；
   *   ❌ 直接把 `why` 截短 ⇒ 真删掉了内容，而这一轮的口号是"精简"不是"删信息"。
   * 所以判据同时钉住这两件：行有 `is-one`，且**全文仍在 title 上**。
   *
   * ⚠️ R2 的边界：只砍 `why`，**不动** `CtlNote`（控件旁那句"为什么此刻是灰的"）。
   * 顺手把 CtlNote 也一起砍掉是很自然的"顺手简化"，而它砍掉的是**当下状态**的解释。
   */
  const problems = [];
  for (const fn of ['Row', 'PendingRow']) {
    const b = fnBody(ctx.s.parts, fn) ?? '';
    if (!b.includes('set-row-why is-one')) problems.push(`${fn} 的 why 没有压成一行（缺 is-one）`);
    if (!/title=\{plain\(item\.why\)\}/.test(b)) {
      problems.push(`${fn} 没把全文挂到 title（压一行后原文就读不到了）`);
    }
  }
  if (!(tsBody(ctx) ?? '').includes('<CtlNote>')) {
    problems.push('② 的 CtlNote 被一并砍掉了（R2 只砍 why，控件旁的状态解释要留）');
  }
  // 样式侧：`is-one` 必须真是"必然一行"。用 line-clamp 在宽容器下仍可能放两行 ⇒ 又回到老问题
  const m = /\.set-row-why\.is-one\s*\{([^}]*)\}/.exec(ctx.s.css);
  if (!m) problems.push('样式缺 .set-row-why.is-one');
  else {
    if (!/white-space:\s*nowrap/.test(m[1])) problems.push('.set-row-why.is-one 缺 nowrap（宽容器下会放两行）');
    if (!/text-overflow:\s*ellipsis/.test(m[1])) problems.push('.set-row-why.is-one 缺 ellipsis（截断处没有省略号）');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('SIMPLIFY.idle.card', 'SIMPLIFY', (ctx) => {
  /*
   * 两个空闲卸载阈值**合成一张卡**（R3）—— 但这是**渲染分组**，不是**合并数据项**。
   *
   * 这两件事看起来一样、后果完全不同：把两项并成一项，全表项数会少 1，
   * 左栏计数与 `SPEC_ITEM_TOTAL` 一起漂 —— 而卡片照样渲染得很好看。
   * 所以两头都断：catalog 里两项**必须都还在**，界面上必须是**一行一个**的两行卡。
   *
   * 另一件不能丢的事：两档待遇不同（LLM 即时 / 视觉需重启）—— 原来是两段散文各讲一遍，
   * 现在是右端两枚 chip + 一句共用注解。讲法变了，"必须说出来"这条不变，
   * 因为它是用户理解"为什么只有一档提示要重启"的唯一依据。
   */
  const { err, items } = translateItems(ctx);
  if (err) return { ok: false, detail: err };
  const problems = [];
  for (const id of ['idle-llm', 'idle-vision']) {
    if (!items.some((i) => i.id === id)) {
      problems.push(`catalog 里缺项 ${id}（合卡不该把两个数据项并成一个）`);
    }
  }
  const body = stripComments(tsBody(ctx) ?? '');
  const lines = (body.match(/className="set-idle-line"/g) ?? []).length;
  if (lines !== 2) problems.push(`合卡里的行数 ${lines}，应为 2（两个阈值各一行）`);
  if (!body.includes('set-idle-tag is-now')) problems.push('缺 LLM 档「保存后立刻生效」的标记');
  if (!body.includes('set-idle-tag is-restart')) problems.push('缺视觉档「需重启引擎」的标记');
  if (!body.includes('必须重启引擎')) {
    problems.push('没有说明两档待遇不同（用户无法理解为何只有一档要重启）');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('SIMPLIFY.state.chip', 'SIMPLIFY', (ctx) => {
  /*
   * 状态行原来是**一串不可断**的文本 `● 运行中 · 服务 :5180 · 引擎 :8001`
   * （`·` 前后无空格，整串当一个词排）—— 在窄的控件列里只能整体溢出或被截。
   * 拆成「一枚状态 chip + 两枚端口 chip」后每枚能独立换行，数字走等宽、纵向对齐可扫。
   *
   * 判据盯**数量**（恰两枚端口 chip）：只查"有 chip"的话，删掉一个端口照样绿，
   * 而少一个端口恰恰是这一项最容易出的错。
   */
  const body = stripComments(tsBody(ctx) ?? '');
  const problems = [];
  if (!/className="set-state is-chip"/.test(body)) problems.push('服务状态没有拆成 chip');
  const pnum = (body.match(/className="set-pnum"/g) ?? []).length;
  if (pnum !== 2) problems.push(`端口 chip 有 ${pnum} 枚，应为 2（服务 / 引擎各一枚）`);
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('SIMPLIFY.token.readonly', 'SIMPLIFY', (ctx) => {
  /*
   * 令牌值由 `<code>` 改成**只读输入框**（拍板）。输入框补上三件行内文本给不了的事：
   * 单行不折、一次点击全选、形状本身在说"这是一份值"。
   *
   * 🔴 必须断在 `readOnly` 上，且**必须同时确认不是 `disabled`**：
   * `disabled` 的输入框不可选中、不可复制 —— 那就把"让用户看得见还能拿走"做反了。
   * 两者只差一个单词，而且改成 `disabled` 之后界面**看起来只是变灰了一点**，
   * 不点进去拖一下根本发现不了。所以这条判据本身就是"一眼看不出"的那类。
   */
  const body = stripComments(tsBody(ctx) ?? '');
  const problems = [];
  /*
   * 只在**令牌输入框那一小段**里判 `readOnly` / `disabled` —— 整个 TranslateSection
   * 里到处都有 `disabled`（复制按钮、两个数字框、打开目录按钮），用全局搜会把
   * 别人的 `disabled` 算到令牌头上（假红），而那种红只能靠放宽判据来消。
   */
  const at = body.indexOf('className="set-token-in"');
  const win = at < 0 ? '' : body.slice(Math.max(0, at - 220), at + 320);
  if (at < 0) problems.push('令牌值不是输入框（.set-token-in 不在）');
  else {
    if (!/\breadOnly\b/.test(win)) problems.push('令牌输入框不是 readOnly');
    if (/\bdisabled\b/.test(win)) problems.push('令牌输入框用了 disabled（不可选中/复制，与"让用户拿走"相悖）');
    if (!/currentTarget\.select\(\)/.test(win)) problems.push('聚焦时没有全选（点一下拿不到整串）');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('SIMPLIFY.secret.masked', 'SIMPLIFY', (ctx) => {
  /*
   * 密钥框**一律掩码**（appKey 亦然）。
   *
   * 背景：appKey 原先按「可回显」处理，保存后明文铺在输入框里；拍板改成与 appSecret
   * 同一形态 —— 两者都 `type="password"`，明文不上屏。
   *
   * 🔴 为什么逐个框判、且窗口锚在 `<input …>` 上，而不是在整段里数 `type="password"`：
   *   ① 数总数测不出"其中一个被改回 text"（另一个仍凑够数 ⇒ 假绿）；
   *   ② 用固定长度前缀窗（如 `slice(at-320, at)`）会**越界到上一个框** ——
   *      appKey 被摘掉 `type="password"` 时，appSecret 的窗口仍能命中 appKey 那一份 ⇒
   *      假绿。所以窗口从**离 `aria-label` 最近的那个 `<input`** 起算，精确框住本框。
   *
   * 也不全局搜 `type="password"`：令牌框（`.set-token-in`）走的是 readOnly 不掩码，
   * 搜全局会把"两个密钥框都漏改"判成绿。
   */
  const body = stripComments(tsBody(ctx) ?? '');
  const problems = [];
  for (const label of ['appKey', 'appSecret']) {
    const at = body.indexOf(`aria-label="${label}"`);
    if (at < 0) {
      problems.push(`${label} 输入框不在（aria-label 缺失）`);
      continue;
    }
    const inp = body.lastIndexOf('<input', at);
    // 从本框的 `<input` 起、到 `aria-label` 之后一小段：只装本框自己的属性
    const win = inp < 0 ? body.slice(0, at + 40) : body.slice(inp, at + 40);
    if (!/type="password"/.test(win)) {
      problems.push(`${label} 框不是 type="password"（密钥明文会上屏）`);
    }
  }
  /*
   * appSecret **盘上已有一份**时，框内以**掩码点**占位（而不是"已保存 · …"这类文字）——
   * 与 appKey 的掩码观感一致。
   * 🔴 锚 `credView?.hasSecret` 而不是裸 `hasSecret`：后者在上方 `saveSrcCredentials` 的
   * `hasSecret: true` 处**先**出现，裸搜会锚错位置、窗口落在密钥回写那段上 ⇒ 命中与否
   * 与被测的占位态无关（假绿）。`credView?.hasSecret` 是占位符这一处独有的。
   */
  const hp = body.indexOf('credView?.hasSecret');
  if (hp < 0) problems.push('appSecret 占位符没接 hasSecret（分不出"已保存 / 未保存"）');
  else if (!/'•+'/.test(body.slice(hp, hp + 120))) {
    problems.push('appSecret 已保存时不是掩码点占位（文字提示会被误读成"值没存下"）');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('SIMPLIFY.translate.noSpecRefs', 'SIMPLIFY', (ctx) => {
  /*
   * 「翻译来源」的用户可见文案**不再出现需求 / 设计稿引用**：
   * `P-D\d`（需求条目号）、`《…》`（设计稿）、`§n`（章节号）、`ver2.2`（改版过程号）。
   *
   * 背景：这一小节原先把设计过程直接写进界面（组说明里的"（P-D1）""ver2.2 加进来的
   * 第一小节"、行内 why 里的"（P-D5）"）——读起来是给评审看的，不是给用户看的。
   *
   * ⚠️ 判据**只圈翻译来源**：② 的其它小节（模型与诊断的 why 仍写着《02》§5、③ 媒体组说明
   * 写着《09》§5.6）同类引用还在，不在本轮范围。**判据不许比政策宽** —— 一句"整个 catalog
   * 都不许有引用"会立刻变红，而唯一的解红方式是把它改回来（判据就此失去意义）。
   *
   * 三个出口都要查，少一个等于漏一处：① 组说明 `note`；② `source` 组各项的文案；
   * ③ sections.tsx 里「翻译来源」那一段 JSX（RowNote / 掩码说明都在里面）。
   */
  const dataErr = CAT_ERR(ctx.cat);
  if (dataErr) return { ok: false, detail: dataErr };
  const sec = ctx.cat.mod.TRANSLATE;
  const ref = /P-[A-Z]\d|《[^》]*》|§\s*\d|ver\d+\.\d+/;
  const hits = [];
  const problems = [];
  const probe = (where, text) => {
    const m = ref.exec(typeof text === 'string' ? text : '');
    if (m) hits.push(`${where} 里的「${m[0]}」`);
  };
  probe('组说明 note', sec.note);
  const grp = (sec.groups ?? []).find((g) => g.id === 'source');
  if (!grp) problems.push('② 里找不到 source 组（翻译来源）');
  // 只展平**这一个组**：整段 TRANSLATE 会把模型与诊断那一项的《02》§5 也算进来（判据过宽）
  else
    for (const it of flatItems({ groups: [grp] })) {
      probe(`项 ${it.id}.why`, it.why);
      probe(`项 ${it.id}.def`, it.def);
    }
  const body = stripComments(ctx.s.sections);
  const a = body.indexOf('翻译链路');
  const b = a < 0 ? -1 : body.indexOf('服务与配对', a);
  if (a < 0 || b < 0) problems.push('sections.tsx 里「翻译来源」小节边界找不到（判据圈不住）');
  else probe('sections 翻译来源 JSX', body.slice(a, b));
  problems.push(...hits.map((h) => `仍有需求/设计稿引用：${h}`));
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('SIMPLIFY.copy.noSpecRefs', 'SIMPLIFY', (ctx) => {
  /*
   * 设置页**全部五组**的用户可见文案都不得混进需求 / 设计稿引用：`P-D\d`（需求条目号）、
   * `《…》`（设计稿）、`§n`（章节号）、`verX.Y`（改版过程号）。
   *
   * 与 `SIMPLIFY.translate.noSpecRefs` 的分工：那条只管「翻译来源」一个组，并把
   * sections.tsx 里那一小段 JSX 也纳入（JSX 片段要按小节标题切片），本条覆盖
   * **五组全部的 catalog 文案**（blurb / note / noteSummary / 逐项 why / def）——
   * 两条互补，不是重复。
   *
   * ⚠️ 判据与政策**同宽**：政策是"设置页说明面向用户"，不是"只有翻译来源面向用户"。
   * 若某个组的说明里又写回了设计过程，本条与那条会一起变红 —— 那正是要它红的形态。
   */
  const dataErr = CAT_ERR(ctx.cat);
  if (dataErr) return { ok: false, detail: dataErr };
  const ref = /P-[A-Z]\d|《[^》]*》|§\s*\d|ver\d+\.\d+/;
  const hits = [];
  const check = (where, text) => {
    if (typeof text !== 'string') return;
    const m = ref.exec(text);
    if (m) hits.push(`${where} 里的「${m[0]}」`);
  };
  for (const sec of ctx.cat.mod.SETTINGS_SECTIONS ?? []) {
    check(`${sec.id}.blurb`, sec.blurb);
    check(`${sec.id}.note`, sec.note);
    check(`${sec.id}.noteSummary`, sec.noteSummary);
    for (const g of sec.groups ?? []) {
      for (const it of g.items ?? []) {
        check(`${sec.id}/${it.id}.why`, it.why);
        check(`${sec.id}/${it.id}.def`, it.def);
      }
    }
  }
  return {
    ok: hits.length === 0,
    detail: hits.map((h) => `仍有需求/设计稿引用：${h}`).join('；'),
  };
});

add('SIMPLIFY.select.pulledRight', 'SIMPLIFY', (ctx) => {
  /*
   * 拍板：「说明在前、下拉**贴最右**」。
   *
   * 右列是 `flex:0 0 auto` 的窄列，两行的下拉因此右边缘对齐 —— 控件的竖直对齐
   * 让人一眼读成"一列操作"，而不是每行各自为政。顺序反过来（下拉在前）则右边缘
   * 由**说明文字的宽度**决定，逐行漂移。
   *
   * 判据用**位置**而不是长相：在 TranslateSection 的**两栏行**里，每一枚 `<Select`
   * 之前必须已经出现过一枚 `<CtlNote`（即两两成对且说明在前）。
   *
   * ⚠️ ver2.2 起 `.set-src` 块**先摘掉再数**：在线配置块是另一种形态 ——
   * `.set-src-k` 小标签在左、控件贴右的**表单行**（标签就是它的"说明"），
   * 不是两栏行，本例子钉的右边缘对齐管不到它；类名存在性由 `ENGINE.css.classes` 兜底。
   * 不摘的话，平台那枚下拉会被判成"没有说明"，而它明明有 —— 那是假红，
   * 且解红只能靠把断言改成恒绿。摘法锚在结构上：该块恒居于 `<RowNote>` 之前。
   */
  const full = stripComments(tsBody(ctx) ?? '');
  const at = full.indexOf('className="set-src"');
  const end = at < 0 ? -1 : full.indexOf('<RowNote>', at);
  // 摘不掉（块或 RowNote 不在）就整段判 —— 计数会立刻报出来，逼人来看，不会静默放过
  const body = at < 0 || end < 0 ? full : full.slice(0, at) + full.slice(end);
  const problems = [];
  let ctl = 0;
  let nth = 0;
  for (const m of body.matchAll(/<CtlNote>|<Select\b/g)) {
    if (m[0] === '<CtlNote>') ctl++;
    else {
      nth++;
      if (ctl < nth) problems.push(`第 ${nth} 枚下拉之前没有说明（下拉漂到了左边）`);
    }
  }
  if (nth !== 3) problems.push(`② 两栏行里的下拉有 ${nth} 枚，应为 3（翻译来源 / 翻译档位 / 加速后端）`);
  if (ctl !== 3) problems.push(`② 两栏行里的控件旁注解有 ${ctl} 枚，应为 3`);
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('SIMPLIFY.diag.foldedByDefault', 'SIMPLIFY', (ctx) => {
  /*
   * 「诊断详情」**默认折叠**（ver2.0 的 R6 结论不被推翻），但折叠的**对象收窄了**：
   * 日志与三枚 chip 都在折叠之外（《03》§1）。所以"默认折叠"必须与"日志常驻"**同时**成立 ——
   * 只查 `useState(false)` 会漏掉"折起来之后连日志也没了"这种更糟的实现。
   *
   * ⚠️ 必须是**折叠开关那一枚自己**的初值，不能笼统搜 `useState(false)` ——
   * 本组件还有两枚别的布尔（`logMore` / `drawer`）初值也是 false。搜全局的话，
   * 把 open 改成 `useState(true)` 之后仍然能搜到别的那两枚，断言照绿（实测过这条假阳性）。
   * 判据锚在**状态变量名**上：折叠开关叫 `open` 是这一处的事实，改名就该跟着改断言。
   */
  const code = stripComments(ctx.s.engineDiag);
  const problems = [];
  if (!/const\s*\[\s*open\s*,\s*setOpen\s*\]\s*=\s*useState\(false\)/.test(code)) {
    problems.push('「诊断详情」不是默认收起（open 的初值应为 false）');
  }
  if (!/className="set-run-fold"/.test(code)) problems.push('没有「诊断详情」的折叠开关');
  if (!/aria-expanded=\{open\}/.test(code)) problems.push('折叠开关没有 aria-expanded（读屏用户不知道展开了没）');
  // 折叠体必须真的被 open 门住（否则"折叠"只是个装饰）
  if (!/\{open\s*\?\s*\(/.test(code)) problems.push('折叠体没有被 open 门住（会一直全量渲染）');
  if ((code.match(/className="set-state is-chip"/g) ?? []).length !== 3) {
    problems.push('摘要行不是三枚进程 chip（①②③ 各一枚）');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('SIMPLIFY.warn.unified', 'SIMPLIFY', (ctx) => {
  /*
   * 设置页里的三处提示原来是**三种形状**：`.set-warn`（档位不推荐）、两处
   * `.notice.is-bad`（后端不符 / 最近一次错误）。形状不同，会让"哪句更要紧"
   * 变成一道形状题 —— 用户得先学会两套语汇才分得清。
   *
   * 统一成一条：**左侧一枚圆形色块 + 一行文字**，轻重只由颜色与符号表达。
   * 判据：两条选择器必须**写在同一个规则组**里、含同一枚 `::before`（同形不同色）。
   * ⚠️ 只覆盖 `.settings-main` 作用域 —— `.notice` 在别的屏也在用，动它等于替所有屏改版。
   */
  const css = ctx.s.css;
  const problems = [];
  const group = /\.settings-main\s+\.set-warn\s*,\s*\.settings-main\s+\.notice\.is-bad\s*\{([^}]*)\}/.exec(css);
  if (!group) {
    problems.push('两处提示没有写在同一条规则里（形状仍然两套）');
  } else if (!/display:\s*flex/.test(group[1]) || !/gap:/.test(group[1])) {
    problems.push('统一后的规则不是「色块 + 文字」的横排');
  }
  const before =
    /\.settings-main\s+\.set-warn::before\s*,\s*\.settings-main\s+\.notice\.is-bad::before\s*\{([^}]*)\}/.exec(css);
  if (!before) {
    problems.push('两处提示的 `::before` 不是同一枚');
  } else {
    if (!/border-radius:\s*50%/.test(before[1])) problems.push('提示色块不是圆形');
    if (!/background:\s*var\(--md-warning\)/.test(before[1])) problems.push('提示色块没有取 --md-warning');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

// ─────────────────────────────────────────────── D-84 · 功能梳理落地（四项） ───
//
// 对应《设置页文案与功能梳理》§2.4「可以直接做」的四项：
//   ① 侧栏图标标签开关  ② 存储占用拆分版  ③ 第三方许可  ④ `def` 字段落点
//
// ⚠️ 另两项（临时文件 / 开源反馈）**仍在等外部条件**，本组因此还有一条
// 「不该多的没多出来」：它们必须仍是 `pending` —— 那正是"文档说不能做就别硬做"
// 这条纪律的可执行形式。

/** 从导入的 catalog 里按 id 找项；找不到返回 null（判据自己决定怎么报） */
function itemById(mod, id) {
  for (const s of mod?.SETTINGS_SECTIONS ?? []) {
    for (const g of s.groups) {
      const hit = g.items.find((i) => i.id === id);
      if (hit) return hit;
    }
  }
  return null;
}

// ④ `def` 字段：catalog 里一直填着值，但**从来没有组件渲染它**（注释自己都这么写）。
//    本轮把它渲染成标题行内的一枚小字 —— 零高度成本，回答的是「我改过没有」。
add('FEATURES.def.rendered', 'FEATURES', (ctx) => {
  const parts = stripComments(ctx.s.parts);
  const problems = [];
  if (!/item\.def\s*\?\s*<DefaultChip/.test(parts)) problems.push('Row 没有按 item.def 渲染 DefaultChip');
  // 文案取设计稿原文「默认 X」（`<span class="default-chip">默认 ${def}</span>`）：
  // 只写值会被读成"你现在是这个"，所以前缀必须在；分隔符跟随设计稿，不加冒号
  if (!/默认 \{value\}/.test(parts)) problems.push('DefaultChip 没有写「默认」前缀（只写值会被读成"你现在是这个"）');
  if (!/title=\{[^}]*出厂默认/.test(parts)) problems.push('DefaultChip 没有说明"这不是你当前的设置"');
  if (!/\.set-row-def\s*\{/.test(ctx.s.css)) problems.push('缺少 .set-row-def 样式');
  if (!/\.set-row-def\s*\{[^}]*flex:\s*0 0 auto/.test(ctx.s.css))
    problems.push('.set-row-def 没有 flex:0 0 auto（会被标题挤成省略号）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('FEATURES.def.commentSynced', 'FEATURES', (ctx) => {
  // ⚠️ 这一条**刻意不剥注释**：被检查的就是注释本身。
  // `def` 的字段注释曾写着「当前没有任何组件渲染它」—— 那是实现未变时的正确描述。
  // 实现变了而注释没变，下一个人会据此把 `def` 当成死字段删掉。
  const stale = '当前没有任何组件渲染它';
  const hit = ctx.s.catalog.includes(stale);
  return {
    ok: !hit,
    detail: hit ? `catalog 的 def 注释仍是旧口径（「${stale}」），而实现已经渲染它了` : '',
  };
});

// ① 壳层偏好：侧栏图标标签 + 翻译服务自动启动（D-94）。两者共用同一条储存纪律。
add('FEATURES.shell.pref', 'FEATURES', (ctx) => {
  const src = stripComments(ctx.s.shellPrefs);
  const problems = [];
  // —— 侧栏标签偏好（D-84）
  if (!/miao\.sidebar-labels/.test(src)) problems.push('偏好 key 不是 miao.sidebar-labels');
  if (!/export function initialSidebarLabels/.test(src)) problems.push('缺少 initialSidebarLabels');
  if (!/export function persistSidebarLabels/.test(src)) problems.push('缺少 persistSidebarLabels');
  // —— 翻译服务自动启动偏好（D-94）
  if (!/miao\.service-auto-start/.test(src)) problems.push('偏好 key 不是 miao.service-auto-start');
  if (!/export function initialServiceAutoStart/.test(src)) problems.push('缺少 initialServiceAutoStart');
  if (!/export function persistServiceAutoStart/.test(src)) problems.push('缺少 persistServiceAutoStart');
  /*
   * 两个偏好的默认值都必须是「只有明确写过 '0' 才是关」。
   * 写成 `=== '1'` 看似等价，实则把"没写过"也判成关 —— 老用户升级后侧栏凭空少一行字、
   * 或翻译服务不再自动起来。这里**数出现次数**（≥2）而不是只测一次：
   * 否则新增的第二个偏好照抄成 `=== '1'` 时，断言仍绿（它只看了第一处）。
   */
  const strictDefault = src.match(/getItem\([A-Z_]+\)\s*!==\s*'0'/g) ?? [];
  if (strictDefault.length < 2)
    problems.push(`只有 ${strictDefault.length}/2 个偏好是「只有显式 0 才关闭」（缺键必须回落到既有形态）`);
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('FEATURES.shell.tokens', 'FEATURES', (ctx) => {
  const src = stripComments(ctx.s.tokens);
  const problems = [];
  const a = src.match(/appItem:\s*\{\s*w:\s*(\d+),\s*h:\s*(\d+)/);
  const b = src.match(/iconOnlyItem:\s*\{\s*w:\s*(\d+),\s*h:\s*(\d+)/);
  if (!a) problems.push('tokens 里没有 appItem 几何');
  if (!b) problems.push('tokens 里没有 iconOnlyItem 几何');
  if (a && b && a[1] === b[1] && a[2] === b[2]) problems.push('两套几何完全相同（等于没切换）');
  if (b && (Number(b[1]) < 44 || Number(b[2]) < 44)) problems.push('纯图标态小于 44（点击热区下限）');
  if (a && (Number(a[1]) < 44 || Number(a[2]) < 44)) problems.push('图标 + 文字态小于 44（点击热区下限）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('FEATURES.shell.sidebarBranch', 'FEATURES', (ctx) => {
  const src = stripComments(ctx.s.sidebar);
  const problems = [];
  if (!/labels\s*\?\s*SIDEBAR\.appItem\s*:\s*SIDEBAR\.iconOnlyItem/.test(src))
    problems.push('几何没有随 labels 切换（appItem ↔ iconOnlyItem）');
  if (!/\{labels\s*\?\s*<span(?:\s+className="nav-label")?>\{a\.label\}<\/span>\s*:\s*null\}/.test(src))
    problems.push('「有没有文字」与「用哪套几何」不是同一个判断的两个输出');
  if (!/aria-label=\{a\.label\}/.test(src)) problems.push('应用入口缺少 aria-label（关掉文字后它是唯一可读名称）');
  // 几何必须来自 tokens：组件里出现裸数字就意味着有了第二个来源
  const hard = src.match(/(?:width|height):\s*\d+px?/g) ?? [];
  if (hard.length > 0) problems.push(`出现 ${hard.length} 处硬编码宽高（${hard[0]}…）`);
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('FEATURES.shell.wired', 'FEATURES', (ctx) => {
  const app = stripComments(ctx.s.appMain);
  const set = stripComments(ctx.s.settingsScreen);
  const sec = stripComments(ctx.s.sections);
  // B1 起「壳层 → 设置页」的三个 prop 由屏装配件接线（App 只持有状态本身）
  const pane = stripComments(ctx.s.settingsPane ?? '');
  const problems = [];
  if (!/useState\(\(\)\s*=>\s*initialSidebarLabels\(\)\)/.test(app)) problems.push('App 没有从偏好初始化侧栏标签');
  if (!/persistSidebarLabels\(on\)/.test(app)) problems.push('App 没有持久化侧栏标签');
  if (!/labels=\{sidebarLabels\}/.test(app)) problems.push('App 没有把 labels 传给 Sidebar');
  if (!/sidebarLabels=\{sidebarLabels\}/.test(pane)) problems.push('屏装配件没有把 sidebarLabels 传给设置页');
  if (!/onSidebarLabels=\{setLabels\}/.test(pane)) problems.push('屏装配件没有把 setLabels 传给设置页');
  if (!/sidebarLabels=\{sidebarLabels\}/.test(set)) problems.push('设置页没有透传 sidebarLabels');
  if (!/onSidebarLabels=\{onSidebarLabels\}/.test(set)) problems.push('设置页没有透传 onSidebarLabels');
  if (!/on=\{sidebarLabels\}/.test(sec)) problems.push('① 通用组的开关没有读 sidebarLabels');
  if (!/onToggle=\{\(\)\s*=>\s*onSidebarLabels\(!sidebarLabels\)\}/.test(sec)) problems.push('开关没有回写偏好');
  // 接线了却仍渲染「待接入」= 一半改完
  if (/PendingRow item=\{itemOf\(g, 'sidebar-labels'\)\}/.test(sec)) problems.push('sidebar-labels 仍渲染成待接入行');
  const item = itemById(ctx.cat.mod, 'sidebar-labels');
  if (!item) problems.push('catalog 里找不到 sidebar-labels');
  else if (item.state !== 'live') problems.push(`catalog 里 sidebar-labels 仍是 ${item.state}`);
  return { ok: problems.length === 0, detail: problems.join('；') };
});

// ② 存储占用：三行分列、**不合计**。
add('FEATURES.storage.rows', 'FEATURES', (ctx) => {
  const src = stripComments(ctx.s.storageBlock);
  const problems = [];
  const rows = (src.match(/className="set-storage-row"/g) ?? []).length;
  if (rows !== 3) problems.push(`三行分列应有 3 个 .set-storage-row，实际 ${rows} 个`);
  // 行名按设计稿：译文库 / 音乐缓存 / 翻译模型（旧名「音频缓存」「模型」与稿子不一致）
  for (const k of ['译文库', '音乐缓存', '翻译模型']) {
    if (!src.includes(k)) problems.push(`缺少「${k}」那一行`);
  }
  if (!src.includes('不合计')) problems.push('没有把"不合计"这条立场说出来');
  /*
   * 不得求和 —— 有人会顺手 `.reduce((a, b) => a + b.total, 0)` 造一个"总占用"，
   * 那等于把**没有接口的那一处**当成 0 算进去。这条断言就是拦它的。
   */
  if (/reduce\(/.test(src)) problems.push('源码里出现了求和（合计会把没有接口的那一处当成 0）');
  if (!src.includes('未统计')) problems.push('模型那一行没有如实标「未统计」');
  if (!src.includes('缺少接口')) problems.push('模型那一行没有说明缺的是哪条接口');
  if (!/musicCacheStats/.test(src)) problems.push('音频缓存没有走 musicCacheStats（会变成第二套口径）');
  if (!/lib\.totalBytes/.test(src)) problems.push('译文库没有用传进来的 lib.totalBytes');
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('FEATURES.storage.wired', 'FEATURES', (ctx) => {
  const set = stripComments(ctx.s.settingsScreen);
  const sec = stripComments(ctx.s.sections);
  // B1 起 `lib` 由屏装配件透传到设置页（App 仍是数据的持有者）
  const pane = stripComments(ctx.s.settingsPane ?? '');
  const problems = [];
  if (!/lib: LibraryResponse \| null/.test(set) && !/lib:\s*LibraryResponse\s*\|\s*null/.test(set))
    problems.push('设置页没有声明 lib prop（译文库占用要由它传进来）');
  if (!/<ResourceSection lib=\{lib\}/.test(set)) problems.push('设置页没有把 lib 传给④资源与投放');
  if (!/lib=\{lib\}/.test(pane)) problems.push('屏装配件没有把 lib 传给设置页');
  if (!/StorageBlock item=\{item\} lib=\{lib\}/.test(sec)) problems.push('④ 组没有把 lib 交给 StorageBlock');
  /*
   * storage-usage 自己必须是 live —— 否则「三行分列做了、却仍标待接入」能蒙过去。
   * 这一句与下面那个循环方向相反：那两个**必须仍是 pending**，这一个**必须是 live**。
   * 早先只查了下面两个、漏了它自己，反证轮里「把 storage-usage 退回 pending」那一条
   * 便退化成假阳性（破坏做了、断言不红）。别再把它并进下面那个循环。
   */
  const usage = itemById(ctx.cat.mod, 'storage-usage');
  if (!usage) problems.push('catalog 里找不到 storage-usage');
  else if (usage.state !== 'live')
    problems.push(`storage-usage 仍是 ${usage.state}（三行分列已接真实能力，不该再标待接入）`);
  for (const id of ['temp-files', 'oss-feedback']) {
    const it = itemById(ctx.cat.mod, id);
    if (!it) problems.push(`catalog 里找不到 ${id}`);
    else if (it.state !== 'pending')
      problems.push(`${id} 不该变成 ${it.state}（服务端接口 / 公开发布这两件事都还不存在）`);
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

// ③ 第三方许可：生成物 + 块 + 生成脚本。
add('FEATURES.licenses.generated', 'FEATURES', (ctx) => {
  let data;
  try {
    data = JSON.parse(ctx.s.licensesJson);
  } catch (e) {
    return {
      ok: false,
      detail: `licenses.json 读不到或不是合法 JSON（跑 npm run task -- gen:licenses）：${e.message}`,
    };
  }
  const problems = [];
  if (!data.disclaimer || !String(data.disclaimer).trim())
    problems.push('缺少免责声明 —— 清单是"包自己说的"，不写这句会被读成"我们核准过了"');
  for (const side of ['npm', 'rust']) {
    const s = data[side];
    if (!s) {
      problems.push(`缺少 ${side} 段`);
      continue;
    }
    for (const k of ['total', 'withLicense', 'unknown', 'byLicense', 'packages']) {
      if (s[k] === undefined) problems.push(`${side}.${k} 缺失`);
    }
    if (!Array.isArray(s.packages)) {
      problems.push(`${side}.packages 不是数组`);
      continue;
    }
    if (s.packages.length !== s.total)
      problems.push(`${side}: packages 有 ${s.packages.length} 条，与 total ${s.total} 不一致`);
    const nulls = s.packages.filter((p) => !p.license).length;
    if (nulls !== s.unknown) problems.push(`${side}: 无声明 ${nulls} 条，与 unknown ${s.unknown} 不一致`);
    if (s.withLicense + s.unknown !== s.total) problems.push(`${side}: withLicense + unknown ≠ total`);
  }
  if (!data.inputs) problems.push('缺少 inputs（生成物与来源文件对账的依据）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('FEATURES.licenses.fresh', 'FEATURES', (ctx) => {
  /*
   * 生成物**会过期**：`npm install` 之后依赖变了而没重跑 `gen:licenses`，
   * 界面上那份清单就与真实依赖对不上 —— 而它看起来完全正常。
   *
   * ⚠️ 只对账**由仓库里的来源文件决定**的量（lock 里有多少包）。
   * 不对账"本机 registry 里解包了多少"：那个量每台机器都不一样，
   * 拿它做判据会在别人的机器上无条件变红（假红比假绿更消耗信任）。
   */
  let data;
  try {
    data = JSON.parse(ctx.s.licensesJson);
  } catch {
    return { ok: false, detail: 'licenses.json 不可解析' };
  }
  const problems = [];
  let lock;
  try {
    lock = JSON.parse(ctx.s.npmLock);
  } catch (e) {
    return { ok: false, detail: `package-lock.json 不可解析：${e.message}` };
  }
  const prod = Object.entries(lock.packages ?? {}).filter(
    ([k, v]) => k.startsWith('node_modules/') && v.dev !== true && v.link !== true,
  ).length;
  if (data.inputs?.npmProdPackages !== prod)
    problems.push(
      `npm 生产依赖数已变：清单里 ${data.inputs?.npmProdPackages}，实际 ${prod} —— 重跑 npm run task -- gen:licenses`,
    );
  const third = ctx.s.cargoLock
    .split('[[package]]')
    .slice(1)
    .filter((b) => /^\s*source\s*=/m.test(b)).length;
  if (data.inputs?.rustLockCrates !== third)
    problems.push(
      `Cargo.lock 的第三方 crate 数已变：清单里 ${data.inputs?.rustLockCrates}，实际 ${third} —— 重跑 npm run task -- gen:licenses`,
    );
  /*
   * C5：引擎资产**同样**要参与过期对账 —— 清单加了条目（新模型 / 新二进制）而没重跑生成脚本，
   * 界面上那份许可清单就少一块，而它看起来完全正常。判据取清单里的 `files` 条数：它由仓库内
   * 的文件决定（不进 registry 之类"每台机器不同"的量），可以拿来对账。
   */
  let engineAssets = null;
  try {
    engineAssets = (JSON.parse(ctx.s.engineManifest).files ?? []).length;
  } catch {
    problems.push('engine/models.manifest.json 不可解析（无法对账引擎资产条数）');
  }
  if (engineAssets !== null && data.inputs?.engineAssets !== engineAssets)
    problems.push(
      `引擎资产条数已变：清单里 ${data.inputs?.engineAssets}，实际 ${engineAssets} —— 重跑 npm run task -- gen:licenses`,
    );
  return { ok: problems.length === 0, detail: problems.join('；') };
});

// ③-C5 引擎 / 模型许可段：`gen:licenses` 的输出里**必须**含引擎与模型那一段。
//
// 为什么单列一条：npm 与 Rust 两段回答的是"我们的代码用了什么开源库"，而真正会卡住
// 对外分发的许可（引擎 GPL-3.0-only / Sakura 与 nllb 的 CC-BY-NC）**只在**这一段里。
// 没有它，界面上"第三方许可"看起来完整，而最要紧的三类一个都查不到。
add('FEATURES.licenses.engine', 'FEATURES', (ctx) => {
  let data;
  try {
    data = JSON.parse(ctx.s.licensesJson);
  } catch (e) {
    return { ok: false, detail: `licenses.json 读不到或不是合法 JSON：${e.message}` };
  }
  const problems = [];
  const eng = data.engine;
  if (!eng || typeof eng !== 'object') {
    return { ok: false, detail: 'licenses.json 里没有 engine 段（引擎/模型许可一个字都查不到）' };
  }
  if (!Array.isArray(eng.assets) || eng.assets.length === 0) problems.push('engine.assets 为空');
  else {
    if (eng.assets.length !== eng.total)
      problems.push(`engine: assets ${eng.assets.length} 条，与 total ${eng.total} 不一致`);
    const nulls = eng.assets.filter((a) => !a.license).length;
    if (nulls !== eng.unknown) problems.push(`engine: 无声明 ${nulls} 条，与 unknown ${eng.unknown} 不一致`);
    if (eng.withLicense + eng.unknown !== eng.total) problems.push('engine: withLicense + unknown ≠ total');
  }
  if (!Array.isArray(eng.upstream) || eng.upstream.length === 0)
    problems.push('engine.upstream 为空（引擎/模型总许可没出处）');
  else if (!eng.upstream.some((u) => /GPL/i.test(u.spdx ?? '')))
    problems.push('engine.upstream 里没有 GPL 声明（引擎上游是 GPL-3.0-only，缺了是漏项）');
  /*
   * 🔴 C5 的**核心事实**：随包分发物里的模型权重数为 0。
   * 它是从 `tauri.conf.json` 的 `bundle.resources` 推导出来的（不是写死的常量），
   * 由 `gen-licenses` 逐条比对文件名得出 —— 与 `check:bundle` 的 W7/W7b 是**不同层**的
   * 两条判据：那边钉配置，这边钉"生成物也说得出这件事"。
   */
  if (eng.bundledCount !== 0) problems.push(`随包分发物里有 ${eng.bundledCount} 条模型资产（C5：权重一律不随包）`);
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('FEATURES.licenses.ui', 'FEATURES', (ctx) => {
  const src = stripComments(ctx.s.licensesBlock);
  const sec = stripComments(ctx.s.sections);
  const problems = [];
  /*
   * 「渲染了 {DATA.disclaimer}」与「来源 JSON 里真的有 disclaimer 这个字段」是两件事，
   * 必须分开判。只测前者时，把 licenses.json 里这个字段改名 ⇒ 界面渲染的是 undefined、
   * 实际什么都不显示，而断言照绿 —— D-83 学到的老教训的又一次应用。
   */
  const raw = JSON.parse(ctx.s.licensesJson);
  if (typeof raw.disclaimer !== 'string' || raw.disclaimer.length === 0)
    problems.push('licenses.json 里没有 disclaimer 字段（免责声明会渲染成空）');
  if (!/\{DATA\.disclaimer\}/.test(src))
    problems.push('免责声明没有被渲染（只写"第三方许可"会读成"我们查过了、没问题"）');
  if (!/s\.withLicense\}/.test(src) || !/s\.total\}/.test(src))
    problems.push('没有显示覆盖数（N / M）—— 凑不齐这件事必须看得见');
  if (!src.includes('未取到声明')) problems.push('缺少「未取到声明」的呈现');
  /*
   * C5：引擎 / 模型那一段必须**渲染出来**。
   * 生成物里有、界面上没有 = 用户看不到"这两类许可是禁止商用的" ——
   * 而这句话正是对外分发前唯一需要被人看见的那句（R13）。
   */
  if (!/DATA\.engine\.bySpdx/.test(src)) problems.push('引擎/模型许可段没有被渲染（「禁止商用」会看不见）');
  if (!/DATA\.engine\.bundledCount/.test(src)) problems.push('随包分发条目数没有被渲染（C5 的正面陈述看不见）');
  if (!/DATA\.engine\.upstream/.test(src)) problems.push('引擎上游许可（版本锁里的声明）没有被渲染');
  if (/\.filter\(\s*\(\s*p\s*\)\s*=>\s*p\.license\s*\)/.test(src))
    problems.push('把没有声明的包过滤掉了（缺口会因此看不见）');
  const item = itemById(ctx.cat.mod, 'licenses');
  if (!item) problems.push('catalog 里找不到 licenses');
  else if (item.state !== 'live') problems.push(`catalog 里 licenses 仍是 ${item.state}`);
  if (!/<LicensesBlock/.test(sec)) problems.push('AboutSection 没有渲染 LicensesBlock');
  if (/PendingRow item=\{itemOf\(g, 'licenses'\)\}/.test(sec))
    problems.push('AboutSection 仍把 licenses 当待接入项渲染');
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('FEATURES.gen.script', 'FEATURES', (ctx) => {
  const problems = [];
  const script = stripComments(ctx.s.genScript);
  if (!script) problems.push('缺少 scripts/gen-licenses.mjs');
  let pkgScripts = {};
  try {
    pkgScripts = JSON.parse(ctx.s.pkgJson).scripts ?? {};
  } catch (e) {
    problems.push(`package.json 不可解析：${e.message}`);
  }
  /*
   * 「已注册」判的是 package.json ∪ e2eScripts.json 的**合并视图**：
   * 命令收束后 `gen:licenses` 住在命令清单里（跑法 `npm run task -- gen:licenses`），
   * 只看 package.json 会把"登记着"误报成没注册 —— 那会逼着人把命令加回去。
   */
  let scripts = {};
  try {
    scripts = mergedScripts(pkgScripts);
  } catch (e) {
    problems.push(`命令清单读不出来：${e.message}`);
  }
  if (!scripts['gen:licenses']) problems.push('package.json 与 e2eScripts.json 都没有注册 gen:licenses');
  else if (!/gen-licenses\.mjs/.test(scripts['gen:licenses'])) problems.push('gen:licenses 指向的不是那个脚本');
  // 必须真的从三处来源读 —— 否则就是"手写一份清单假装是枚举出来的"
  if (!/Cargo\.lock/.test(script)) problems.push('生成脚本没有读 Cargo.lock');
  if (!/package-lock\.json/.test(script)) problems.push('生成脚本没有读 package-lock.json');
  /*
   * C5：引擎/模型那一段必须来自清单与版本锁这两个**文件**，不许在脚本里手写一份许可表。
   *
   * ⚠️ 判据必须落在 `path.join(...)` 那一行，不能只判"源码里出现过这个文件名"：
   * `sources.engine` 那句**说明文字**里也写着这两个文件名 —— 拿它当判据，
   * 把真正的读取行删掉之后断言照样绿（反证轮实测的假阳性，2026-10-14）。
   */
  if (!/ENGINE_MANIFEST\s*=\s*path\.join\([^)]*models\.manifest\.json/.test(script))
    problems.push('生成脚本没有把 engine/models.manifest.json 当作文件读入（只写在说明文字里不算）');
  if (!/ENGINE_VERSIONS\s*=\s*path\.join\([^)]*VERSIONS\.lock/.test(script))
    problems.push('生成脚本没有把 engine/VERSIONS.lock 当作文件读入（只写在说明文字里不算）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});

// ── 执行器 ────────────────────────────────────────────────────────────────
async function runAll() {
  const s = loadSources();
  const cat = await loadCatalog();
  const ctx = { s, cat };
  const res = {};
  for (const a of A) {
    try {
      const r = await a.run(ctx);
      res[a.id] = { ok: !!r.ok, detail: r.detail || '' };
    } catch (e) {
      res[a.id] = { ok: false, detail: `断言抛错：${e.message}` };
    }
  }
  return res;
}

// 分组打印顺序。🔴 数组里**不要写行注释**：`check:docs` 的 GROUPS 覆盖检查按逗号 split
// 解析这个数组，注释会把同行的下一个分组名污染成 `// …\n  'DESKTOP'` ⇒ 误报"未声明"（实测踩过）。
// 桌面应用行为（快捷键守卫 / 右键菜单）的判据源是入口 main.tsx，分组名 DESKTOP。
const GROUPS = [
  'EXCLUDED',
  'RETIRED',
  'ADDED',
  'COUNT',
  'NOTE',
  'WIRING',
  'STORE',
  'PLAYER',
  'OPTIONS',
  'CACHE',
  'ENGINE',
  'NOTREADY',
  'SIMPLIFY',
  'FEATURES',
  'FONT',
  'DESKTOP',
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

// ── 反证用例：{name, file, find, replace, expect:[断言 id]} ──────────────────
const MUTATIONS = [
  {
    name: '把 quality 项从 MEDIA 里删掉（模拟「该补的没补」）',
    file: F.catalog,
    find:
      '        {\n' +
      "          id: 'quality',\n" +
      "          label: '音质档位',\n" +
      "          state: 'live',\n" +
      "          def: '高清臻音',\n" +
      "          why: '标准 / 极高 / 无损 / 高清臻音 / 超清母带',\n" +
      '        },\n',
    replace: '',
    expect: ['ADDED.quality'],
  },
  {
    name: '把 audio-output 项加回 catalog（模拟「剔除了的又回来了」）',
    file: F.catalog,
    find: "          id: 'quality',\r\n",
    replace:
      "          id: 'quality',\r\n" +
      "          label: '音频输出',\r\n" +
      "          state: 'pending',\r\n" +
      "          why: '反证',\r\n" +
      '        },\r\n' +
      '        {\r\n',
    expect: ['EXCLUDED.audio-output'],
  },
  {
    name: '把项数自校常量改成 26（模拟自校常量漂移）',
    file: F.catalog,
    // ⚠️ 锚点必须与 catalog 的真实字节一致 —— 常量每变一次（29→31→32→33→31→32→**33**→**34**）
    // 都要同步这里，否则本行会退化成「锚点未找到 / 跳过」，看起来仍是全绿（跳过 ≠ 通过）。
    // 实测：漏同步时这条确实静默跳过过（详见台账 D-94 的反证轮复修记录）。
    find: 'export const SPEC_ITEM_TOTAL = 34;',
    replace: 'export const SPEC_ITEM_TOTAL = 26;',
    expect: ['COUNT.specMatches'],
  },
  {
    name: '把「缓存清理」项加回 RESOURCE（模拟拍板删掉的项又回来了）',
    file: F.catalog,
    find: "        {\n          id: 'temp-files',",
    replace:
      '        {\n' +
      "          id: 'cache-clean',\n" +
      "          label: '缓存清理',\n" +
      "          state: 'pending',\n" +
      "          why: '反证',\n" +
      '        },\n' +
      '        {\n' +
      "          id: 'temp-files',",
    expect: ['RETIRED.cache-clean'],
  },
  {
    name: '把 note 里的「本组 13 项」改成 12（模拟正文数字与数据脱节）',
    file: F.catalog,
    find: '本组 13 项，分四小节',
    replace: '本组 12 项，分四小节',
    expect: ['NOTE.count'],
  },
  {
    name: '把 EngineDiag.tsx 的 stopping 键删掉（漏同步 ⇒ 诊断面板露出英文裸 id）',
    file: F.engineDiag,
    find: "  stopping: { text: '正在停止', colorVar: '--md-muted' },\n",
    replace: '',
    expect: ['NOTREADY.state.fiveStates'],
  },
  {
    name: '把 MediaSection 的遍历改回 MEDIA.groups[0]（只渲染第一小节）',
    file: F.secMedia,
    find: '      {MEDIA.groups.map((g) => (\n        <Group key={g.id} group={g} render={render} />\n      ))}',
    replace: '      <Group group={MEDIA.groups[0]} render={render} />',
    expect: ['WIRING.groups.traverse', 'WIRING.groups.noFirst'],
  },
  {
    name: '把 setVinylCustomColor 从 sections.tsx 里摘掉（控件不再回写 store）',
    file: F.secMedia,
    // 锚点只到 `= useMusicStore((s) => s.setVinylCustomColor);`，不写形参名
    find: '  const setVinylCustomColor = useMusicStore((s) => s.setVinylCustomColor);',
    replace: '  const setVinylCustomColor = () => {};',
    expect: ['WIRING.setter.setVinylCustomColor'],
  },
  {
    name: '把 store 某个 setter 的 savePrefs 调用删掉（偏好不再持久化）',
    file: path.join(F.actionsDir, 'playback.ts'),
    // 只改 patch 键名，不碰形参名：savePrefs 仍在，只是键写错 → 精准打「键对不对」
    find: 'savePrefs({ vinylCustomColor:',
    replace: 'savePrefs({ notVinylCustomColor:',
    expect: ['STORE.setter.vinylCustomColor'],
  },
  {
    name: '把某个字段的默认值改成 undefined（模拟默认值缺失）',
    file: F.store,
    find: '  dynamicEnabled: false,',
    replace: '  dynamicEnabled: undefined,',
    expect: ['STORE.default.dynamicEnabled'],
  },
  {
    name: '把 ExpandedPlayer 的 --lyr-hl 注入去掉',
    file: F.expanded,
    find: "'--lyr-hl'",
    replace: "'--lyr-hl-off'",
    expect: ['PLAYER.inject.lyrHl'],
  },
  {
    name: '把 is-disc 类名改成无条件添加（该视觉态会常亮）',
    file: F.expanded,
    find: "? 'is-disc' : ''",
    replace: "'is-disc'",
    expect: ['PLAYER.class.isDisc'],
  },
  {
    name: '把 MEDIA 第三小节 id 改错（模拟小节结构被破坏）',
    file: F.catalog,
    find: "      id: 'vinyl',",
    replace: "      id: 'vinylx',",
    expect: ['ADDED.groups'],
  },
  {
    name: '把 switch 里 quality 的 case 改错（模拟某项没有取项/分派点）',
    file: F.secMedia,
    find: "      case 'quality':",
    replace: "      case 'quality-off':",
    expect: ['WIRING.item.quality'],
  },
  {
    name: '把 quality 的 case 改成挂空（return null，控件不渲染）',
    file: F.secMedia,
    // 锚点只到 `return (`，不写形参/变量名
    find: "      case 'quality':\n        return (",
    replace: "      case 'quality':\n        return null;\n      case '__dead':\n        return (",
    expect: ['WIRING.item.quality'],
  },
  {
    name: '让 ExpandedPlayer 又自己定义一份 SKINS（设置页/播放器将漂移成两套皮肤名）',
    file: F.expanded,
    find: 'export function ExpandedPlayer(',
    replace: 'const SKINS = [];\nexport function ExpandedPlayer(',
    expect: ['OPTIONS.expandedNoLocalSkins'],
  },
  {
    name: '把 main.tsx 的启动水合去掉（冷启动直接进设置页会显示默认值）',
    file: F.main,
    find: 'hydratePrefs();',
    replace: 'void 0;',
    expect: ['STORE.hydrate.atBoot'],
  },
  {
    // 复现用户报的"不像桌面应用"：守卫装了却没调用（或调用被摘掉）⇒ 刷新快捷键与右键菜单全都回来
    name: '把 main.tsx 的桌面守卫调用摘掉（刷新快捷键与默认右键菜单全都回来）',
    file: F.main,
    find: 'installDesktopGuards();',
    replace: 'void installDesktopGuards;',
    expect: ['DESKTOP.guards'],
  },
  {
    // 另一半：守卫不再区分开发态 ⇒ dev 里 Ctrl+R 失效，排障被误判成"代码没生效"。
    // ⚠️ 变异目标随 038dc7d 一起搬到了 `tools/desktopGards.ts`（仍在 F.main 上找会找不到
    //    锚点，变异自身就失败）。
    name: '把桌面守卫的开发态放行去掉（dev 里也禁刷新，排障被误导）',
    file: F.desktopGuards,
    find: '  if (import.meta.env.DEV) return;',
    replace: '  if (false) return;',
    expect: ['DESKTOP.guards'],
  },
  {
    // 新增（随"实现搬进 desktopGards.ts"补的变异）：判据改读实现文件后，得有一条变异
    // 证明**真的在读那个文件**。删掉右键菜单处理 ⇒ `DESKTOP.guards` 必须红；
    // 若判据还停在 main.tsx 上，这条变异会"按预期变红"——所以它是防"读错文件"的哨兵。
    name: '把守卫实现里的右键菜单处理删掉（默认右键菜单会回来，粘贴只剩快捷键一条路）',
    file: F.desktopGuards,
    find:
      "  window.addEventListener('contextmenu', (e) => {\n" +
      '    const t = e.target as HTMLElement | null;\n' +
      '    if (t?.closest(\'input, textarea, [contenteditable="true"]\')) return;\n' +
      '    e.preventDefault();\n' +
      '  });\n',
    replace: '',
    expect: ['DESKTOP.guards'],
  },
  /*
   * 以下三条守「音乐缓存」这一项。
   *
   * 为什么要单独守：它是**通栏四格**（`layout: 'block'`），走的是 `Group` 里
   * 一条**新分支**。新分支最典型的失效是「catalog 里写了项、脚本数得出，
   * 但渲染时被 Row 压扁 / 压根没渲染」—— 而这正是它当初要脱离 `Row` 的理由。
   */
  {
    name: '把「音乐缓存」项整条从 catalog 里删掉（模拟「加了项但忘了算进项数」）',
    file: F.catalog,
    find:
      '        {\r\n' +
      "          id: 'music-cache',\r\n" +
      "          label: '音乐缓存',\r\n" +
      "          state: 'live',\r\n" +
      '          // 四格块：塞不进 Row 的窄右列（见 SettingItem.layout 的注释）\r\n' +
      "          layout: 'block',\r\n" +
      "          why: '歌词与整首歌的本地缓存，按平台清理',\r\n" +
      '        },\r\n',
    replace: '',
    expect: ['ADDED.music-cache', 'COUNT.total'],
  },
  {
    name: '把「音乐缓存」的 layout 形态字段去掉（会被 Row 压成两栏窄列，四格失效）',
    file: F.catalog,
    find: "          // 四格块：塞不进 Row 的窄右列（见 SettingItem.layout 的注释）\n          layout: 'block',\n",
    replace: '',
    expect: ['CACHE.layoutFlag'],
  },
  {
    name: '把 sections.tsx 里 music-cache 的 case 改错（四格块不会被渲染）',
    file: F.secMedia,
    find: "      case 'music-cache':",
    replace: "      case 'music-cache-off':",
    expect: ['WIRING.item.music-cache'],
  },
  {
    name: '把「歌词高亮方式」项整条从 catalog 里删掉（模拟「加了项但忘了算进项数」）',
    file: F.catalog,
    find:
      '        {\r\n' +
      "          id: 'lyrics-mode',\r\n" +
      "          label: '歌词高亮方式',\r\n" +
      "          state: 'live',\r\n" +
      "          why: '整行点亮或逐字推进',\r\n" +
      "          def: '逐字',\r\n" +
      '        },\r\n',
    replace: '',
    expect: ['ADDED.lyrics-mode', 'COUNT.total'],
  },
  {
    name: '把 sections.tsx 里 lyrics-mode 的 case 改错（歌词高亮方式开关不渲染）',
    file: F.secMedia,
    find: "      case 'lyrics-mode':",
    replace: "      case 'lyrics-mode-off':",
    expect: ['WIRING.item.lyrics-mode'],
  },
  {
    name: '把 store 的 setLyricsMode 里 savePrefs 键改错（歌词高亮方式偏好不持久化）',
    file: path.join(F.actionsDir, 'playback.ts'),
    find: 'savePrefs({ lyricsMode:',
    replace: 'savePrefs({ notLyricsMode:',
    expect: ['STORE.setter.lyricsMode'],
  },
  {
    name: '把 lyricsMode 的默认值改成 undefined（模拟默认值缺失）',
    file: F.store,
    find: '  lyricsMode: LYRICS_MODE_DEF,',
    replace: '  lyricsMode: undefined,',
    expect: ['STORE.default.lyricsMode'],
  },

  /*
   * ============================ ② 翻译服务（S6） ============================
   *
   * ② 这十三项的失效形态全都**不报错**：编译过、类型过、页面照常渲染，只是内容不对。
   * 所以每一条正向断言都必须配一次"把它破坏掉、看它变红"，否则正向断言本身
   * 是不是有效（会不会恒绿）无从得知。
   */
  {
    name: '把 ② 的「翻译档位」改成 pending（模拟十三项里有一项没落地）',
    file: F.catalog,
    find: "          id: 'tier',\n          label: '翻译档位',\n          state: 'live',\n",
    replace: "          id: 'tier',\n          label: '翻译档位',\n          state: 'pending',\n",
    expect: ['ENGINE.items.allLive'],
  },
  {
    name: '把 ② 第四小节 id 改错（小节结构被破坏，C11 的"恰 4 个"会跟着失守）',
    file: F.catalog,
    find: "      id: 'model',\n",
    replace: "      id: 'modelx',\n",
    expect: ['ENGINE.groups.order'],
  },
  {
    name: '把「模型管理」的 layout 字段去掉（会被 Row 压成两栏窄列）',
    file: F.catalog,
    find: '          // 通栏块：校验结果是一份"哪几个不符/缺失"的清单，塞不进 Row 的窄右列\n          layout: \'block\',\n',
    replace: '',
    expect: ['ENGINE.layout.manageBlock'],
  },
  {
    name: '把「引擎诊断」的 layout 字段去掉（一整块面板会被压成一行）',
    file: F.catalog,
    find: "          // 通栏块：常驻的「运行状态」卡 + 折叠的「诊断详情」，是一整块面板而非一行\n          layout: 'block',\n",
    replace: '',
    expect: ['ENGINE.layout.diagBlock'],
  },
  {
    name: '删掉「模型与诊断」小节标题（C11 的小节数不再对得上）',
    file: F.secTranslate,
    // 锚点只取标题字面量、不带缩进与属性：小节标题现在带 head 副标题，
    // 写死 `<SubTitle>模型与诊断</SubTitle>` 会随卡片副标题的增删静默失配
    find: '模型与诊断</SubTitle>\n',
    replace: '',
    expect: ['ENGINE.wiring.fourSubTitles'],
  },
  {
    name: '把「引擎此刻在跑哪档」改成读已配置的值（已配置与已生效被合成一个）',
    file: F.secTranslate,
    /*
     * ⚠️ 反证必须打在**数据绑定**上，不能打在文案上。
     * 第一版写成把 `引擎正在跑：` 换个说法 —— 那句话变了，但 `tier.effective` 还在，
     * 断言照旧是绿的，于是这条反证成了**假反证**（看起来覆盖到了，其实什么都没测到）。
     * `all` 是必须的：`o.tier.effective` 在相等/不相等两个分支里各出现一次，
     * 只改第一处，另一处仍然是 effective ⇒ 仍然绿。
     */
    find: 'o.tier.effective',
    replace: 'o.tier.configured',
    all: true,
    expect: ['ENGINE.wiring.tierConfiguredVsEffective'],
  },
  {
    name: '删掉「已配置档也要出现在选项里」的兜底（控件会显示成空白/裸 id）',
    file: F.secTranslate,
    // ⚠️ 锚点必须带后缀「 · 权重不在清单」：ver2.2 平台下拉也有一处「（当前配置）」兜底
    // （platformOptions），只搜「（当前配置」会命中**更靠前的那一处**，破坏的是平台兜底、
    // tier 兜底原封不动 —— 断言照绿，这条反证就成了假反证（实测翻车过）。
    find: '（当前配置 · 权重不在清单）',
    replace: '（不在清单）',
    expect: ['ENGINE.wiring.tierKeepsConfigured'],
  },
  {
    name: '让「不推荐」档的强警告不取服务端文案（前端另编一句）',
    file: F.secTranslate,
    find: 'tierInfo.warning',
    replace: 'tierInfo.tier',
    expect: ['ENGINE.wiring.tierWarnFromServer'],
  },
  {
    name: '删掉「用户指定的后端本机没有」的红条（用户会以为选的 CUDA 真的在跑）',
    file: F.secTranslate,
    find: 'accel.mismatch',
    replace: 'accel.effective',
    all: true,
    expect: ['ENGINE.wiring.accelMismatch'],
  },
  {
    name: '把视觉档的空闲卸载也写成即时生效（两档待遇被混同）',
    file: F.secTranslate,
    find: '必须重启引擎',
    replace: '保存后即生效',
    // `all: true` 是必须的：这五个字在源码里出现两次（合卡注解的代码 + 它上面那句注释），
    // 只改第一处（注释）会留下代码里的那一处 ⇒ 断言照旧绿 ⇒ 假反证。
    all: true,
    expect: ['ENGINE.wiring.visionNeedsRestart'],
  },
  {
    name: '删掉卡片级「0 = 从不卸载」的说明（0 会被当成 bug 而不是设计）',
    file: F.secTranslate,
    find: '从不卸载',
    replace: '空闲即释放',
    all: true,
    expect: ['ENGINE.wiring.idleNeverUnload'],
  },
  {
    name: '删掉「改完要重启」的提示条（《09》§4.3 末句要求小节下方给提示）',
    file: F.secTranslate,
    find: '<RestartHint title="推理引擎"',
    replace: '<RestartHint2 title="推理引擎"',
    expect: ['ENGINE.wiring.restartHint'],
  },
  {
    name: '去掉「打开模型目录」的存在性守卫（路径不存在时点了只会报错）',
    file: F.secTranslate,
    find: 'disabled={!o.modelDir.exists}',
    replace: 'disabled={false}',
    expect: ['ENGINE.wiring.modelDirGuarded'],
  },
  {
    name: '从 engine-api 里摘掉一个端点（形状收口不再完整）',
    file: F.engineApi,
    find: "'/engine/unload'",
    replace: "'/engine/unload-v2'",
    expect: ['ENGINE.api.sixEndpoints'],
  },
  {
    name: '拉取失败时不再清空旧值（界面会显示一份过期快照）',
    file: F.engineState,
    find: '      setStatus(null);',
    replace: '      void 0;',
    expect: ['ENGINE.hook.clearsOnError'],
  },
  {
    name: '去掉下载轮询的「只在下载中」守卫（会常挂一个 2s 定时器）',
    file: F.engineState,
    find: '    if (!downloadRunning) return undefined;',
    replace: '    if (false) return undefined;',
    expect: ['ENGINE.hook.pollOnlyWhenDownloading'],
  },
  {
    name: '把「校验完成（发现不符）」说成「校验失败」（用户会去查网络而不是点重下）',
    file: F.engineState,
    find: '校验完成',
    replace: '校验失败',
    all: true,
    expect: ['ENGINE.hook.verifyNotFailedWhenNotOk'],
  },
  {
    name: '把诊断面板的内部小标题换成 SubTitle（C11 的"恰 4 个"会失效）',
    file: F.engineDiag,
    find: '<div className="set-diag-h">{title}</div>',
    replace: '<SubTitle>{title}</SubTitle>',
    expect: ['ENGINE.diag.notSubTitle'],
  },
  {
    name: '把「重启引擎」改成只刷界面（一个点了不出事的假按钮）',
    file: F.engineDiag,
    find: 'await serviceRestart();',
    replace: 'await eng.reload();',
    expect: ['ENGINE.diag.restartIsServiceRestart'],
  },
  {
    name: '去掉「重新下载模型」的置灰（执行体不在盘上时点了只换一条报错）',
    file: F.engineDiag,
    find: 's?.modelDownload?.runnerExists === false',
    replace: 'false',
    all: true,
    expect: ['ENGINE.diag.downloadDisabled'],
  },
  {
    name: '让诊断面板在遇到未知进程态时直接崩（引擎报第五种态就白屏）',
    file: F.engineDiag,
    /*
     * ⚠️ 锚点不能带花括号（`{view?.text ?? state}`）：那只够到展开态的进程行，
     * 摘要行 chip 里的那一处（`view?.text ?? state ?? '—'`）会漏掉 ⇒ 断言照绿。
     * 现在取裸的 `view?.text ?? state` + `all`，摘要行与进程行**两处一起破坏**。
     */
    find: 'view?.text ?? state',
    replace: 'view?.text',
    all: true,
    expect: ['ENGINE.diag.unknownStateSafe'],
  },
  {
    name: '去掉阶段日志的逆序（最新一条沉到最下面）',
    file: F.engineDiag,
    find: '[...logs].reverse()',
    replace: 'logs',
    expect: ['ENGINE.diag.stageLogReversed'],
  },
  {
    name: '把「校验通过」与「校验完成」合成一句（模型有问题会被当成操作失败）',
    file: F.modelManage,
    /*
     * ⚠️ 锚点必须是 `v.ok` 而不是 `v.ok ?` —— 后者只覆盖**其中一处**：
     * 两处判据在源码里长得不一样（`className={v.ok ? …}` 与换行后的 `{v.ok\n ? …}`），
     * 而断言判的是 `\{v\.ok\s*\?`（`\s` 含换行，两处都算）。
     * 只改一处 ⇒ 另一处仍然命中 ⇒ 断言照旧绿 ⇒ **假反证**。
     * 教训：破坏锚点要覆盖"让断言为真的**全部**来源"，不是"最像的那个"。
     */
    find: 'v.ok',
    replace: 'true',
    all: true,
    expect: ['ENGINE.manage.notOkNotFailed'],
  },
  {
    name: '去掉校验结果清单的截断（几十行会把这一项撑成一整屏）',
    file: F.modelManage,
    find: 'v?.problems.slice(0, 8) ?? []',
    replace: 'v?.problems ?? []',
    expect: ['ENGINE.manage.listCapped'],
  },
  {
    /*
     * 「模型管理」块里 `runnerExists` 出现**两处**（按钮的 `disabled` 与那行解释文案），
     * 只改一处 ⇒ 另一处仍命中 ⇒ 假反证。故 `all: true` 两处一起破坏。
     */
    name: '去掉「模型管理」块里「重新下载模型」的置灰（执行体不在盘上时点了只换一条报错）',
    file: F.modelManage,
    find: 'download?.runnerExists === false',
    replace: 'false',
    all: true,
    expect: ['ENGINE.manage.downloadDisabled'],
  },
  {
    name: 'D4：诊断视图不再渲染运行时实况（装了什么、占多少盘、何时落的又要在别处查）',
    file: F.engineDiag,
    find: '<ModelDiskRow disk={s?.models?.disk} />',
    replace: '',
    expect: ['ENGINE.diag.diskRow'],
  },
  {
    /*
     * ⚠️ `all: true`：`disk.assembledAt` 在块里出现**两处**（判断条件 + 真正渲染的那个值），
     * 只改一处 ⇒ 另一处仍命中 ⇒ 断言照绿（实测到的假反证）。
     * 教训同 `ENGINE.manage.notOkNotFailed`：破坏锚点要覆盖"让断言为真的**全部**来源"。
     */
    name: 'D4：诊断视图不再渲染「最近落盘时间」',
    file: F.engineDiag,
    find: 'disk.assembledAt',
    replace: 'undefined',
    all: true,
    expect: ['ENGINE.diag.diskRow'],
  },
  {
    name: 'D4：「模型管理」块不再显示占用字节（用户决定要不要重下时少了最关键的一个数）',
    file: F.modelManage,
    find: '<b>{humanBytes(disk.bytes)}</b>',
    replace: '<b>—</b>',
    expect: ['ENGINE.manage.diskRow'],
  },
  {
    name: '把 ExpandedPlayer 从应用根摘掉（全屏播放器再也出不来）',
    file: F.appMain,
    find: '      <ExpandedPlayer onSeek={onMusicSeek} />\n',
    replace: '',
    expect: ['PLAYER.mounted'],
  },
  {
    name: '把数字框换回 <input type="number">（空值会被读成 0 = 从不卸载）',
    file: F.numberInput,
    // `all`：文件头**正在讨论**这件事，注释里也写着 `type="text"`；只改第一处会改到注释上
    find: 'type="text"',
    replace: 'type="number"',
    all: true,
    expect: ['ENGINE.num.textNotNumber'],
  },
  {
    name: '去掉空串守卫（把框清空 = 设为 0 = 从不卸载，且无任何提示）',
    file: F.numberInput,
    find: "draft.trim() !== '' && ",
    replace: '',
    expect: ['ENGINE.num.rejectsEmpty'],
  },
  {
    name: '把提交改成逐字符（改 5→30 的中途会真的写成 3 分钟）',
    file: F.numberInput,
    find: 'onBlur={commit}',
    replace: 'onChange={commit}',
    expect: ['ENGINE.num.commitOnBlurOrEnter'],
  },
  {
    name: '让诊断面板用一个不存在的样式类（元素照常渲染，只是没有样式）',
    file: F.engineDiag,
    find: 'className="set-diag-ops"',
    replace: 'className="set-diag-ops-v2"',
    expect: ['ENGINE.css.classes'],
  },
  {
    name: '去掉 emphasis 的奇偶校验（落单的 ** 会把后半句整段加粗）',
    file: F.parts,
    find: '  if (parts.length % 2 === 0) return text;\n',
    replace: '',
    expect: ['ENGINE.emphasis.impl'],
  },
  {
    name: '让组级说明（note）不走 emphasis（界面上会原样显示两个星号）',
    file: F.parts,
    /*
     * ⚠️ `all: true` 是必须的：折叠改版后 `GroupNote` 有**两处**渲染全文
     * （`if (!summary)` 那一支 + 展开支的 `{open ? emphasis(children) : summary}`），
     * 只改第一处，展开支仍在 ⇒ 断言照旧绿（实测过这条假阳性）。
     */
    find: 'emphasis(children)',
    replace: 'children',
    all: true,
    expect: ['ENGINE.emphasis.renderPoints'],
  },
  {
    name: '去掉自取消守卫的置位那一半（StrictMode 双调用后界面永久停在「读取中…」）',
    file: F.engineState,
    // 只删「挂载置 true」那一行 —— 留下卸载置 false（这正是真实写法容易犯的形态：只写一半）
    find: '    alive.current = true;\n',
    replace: '',
    expect: ['ENGINE.hook.strictModeAliveGuard'],
  },
  {
    name: '在 JSX 裸文本里塞回一个 markdown 粗体（这是本轮真实修掉的那个缺陷）',
    file: F.secTranslate,
    // 锚点取「改完要重启」提示条那一行（稳定的 JSX 裸文本行），末尾补一对星号即可触发
    find: "      <b>{title}</b>：改 {keys.join(' / ')} 需<b>重启引擎</b>才生效 ——",
    replace: "      <b>{title}</b>：改 {keys.join(' / ')} 需<b>重启引擎</b>才生效 ——**",
    expect: ['ENGINE.md.noRawAsterisks'],
  },

  // —— X-C3「准备中」 ——
  {
    name: '给第 2 段编一个字节进度（未就绪屏此刻读不到任何 HTTP，编出来的数字就是撒谎）',
    file: F.assembly,
    find: "{ id: 'runtime', text: '运行环境装配' },",
    replace: "{ id: 'runtime', text: '运行环境装配 · 2.1/4.6 GB' },",
    expect: ['NOTREADY.detail.noFabricatedProgress'],
  },
  {
    name: '段号改回不用 download.step（五段时间线与装配事实源脱钩）',
    file: F.notReady,
    find: 'assemblyNotes(status, download)',
    replace: 'assemblyNotes(status, null)',
    expect: ['NOTREADY.stages.phaseDriven'],
  },
  {
    name: '把「就绪」塞回 `STEP_INDEX`（它变成第四个事件 ⇒ 判据不过时永远停在最后一段）',
    file: F.assembly,
    find: 'models: 3,',
    replace: 'models: 3, ready: 4,',
    expect: ['NOTREADY.phase.readyNotEvent'],
  },
  {
    file: F.ipc,
    find: "export type ServiceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';",
    replace: "export type ServiceState = 'stopped' | 'starting' | 'running' | 'error';",
    expect: ['NOTREADY.state.fiveStates'],
  },
  {
    name: '重试不再按失败阶段分派（L2 失败时用户只会把同一件坏掉的事重做一遍）',
    file: F.notReady,
    // `all`：主按钮的渲染条件与它的 kind 两处都写了这个判据，只改一处仍是绿的
    find: "failed && status?.phase === 'L2'",
    replace: 'false',
    all: true,
    expect: ['NOTREADY.retry.byPhase'],
  },
  {
    name: '不显示 status.mode（"以为在跑真引擎、其实跑的替身"重新变成查不出来的事）',
    file: F.notReady,
    find: "status?.mode ?? '—'",
    replace: "'—'",
    expect: ['NOTREADY.wiring.modeDegraded'],
  },
  {
    name: '让状态屏用一个不存在的样式类（元素照常渲染，只是没有样式）',
    file: F.notReady,
    // `all`：四个 meta chip 共用同一个类名，只改一处仍然命中样式表
    find: '<span className="mchip">',
    replace: '<span className="mchip-v2">',
    all: true,
    expect: ['NOTREADY.css.classes'],
  },
  {
    // 时间线是"一条线"：序号写死就没有"还剩几步"这回事了，且步数可能与数据脱钩
    name: '把时间线节点序号写成死值（序号不再由下标派生）',
    file: F.timeline,
    find: 'String(i + 1)',
    replace: 'String(1)',
    expect: ['NOTREADY.timeline.derivedFromStages'],
  },
  {
    // 组件侧那一半：状态词还在，但不再映射到 loading —— 圈就永远不会转
    name: '「进行中」不再映射到 loading 态（退回一个不动的节点）',
    file: F.timeline,
    find: "  active: 'is-loading',",
    replace: "  active: '',",
    expect: ['NOTREADY.timeline.explicitLoading'],
  },
  {
    // 样式侧那一半：类名与规则都在，只摘掉动画 —— 必须也被抓到，
    // 否则这条断言只测了"有没有这个类"，测不到"圈转不转"
    name: '摘掉 loading 外圈的旋转动画（节点在，但圈不转 ⇒ 与"卡住了"看起来一样）',
    file: F.mangaStyle,
    find: '  animation: tlspin 900ms linear infinite;',
    replace: '',
    expect: ['NOTREADY.timeline.explicitLoading'],
  },
  {
    name: '摘掉 `assemblyNotes` 的 ready 收尾（判据已全真，最后一段却永远显示「进行中」）',
    file: F.assembly,
    find: "    notes[4] = 'done';\n",
    replace: '',
    expect: ['NOTREADY.phase.readyTerminal'],
  },

  // ——— ② 分组简洁化（2026-10-07）—— 每条新增断言都必须有一条能把它打红的破坏 ———
  {
    name: '让 ② 的摘要说出 note 里没有的话（摘要成了新的承诺）',
    file: F.catalog,
    /*
     * ⚠️ 锚点带着目标组的**摘要原文** ⇒ 摘要每改一次就要同步一次（本项目已两次踩坑：
     * D-84 与 D-134）。锚点不同步会退化成「锚点未找到 ⇒ 跳过」—— 跳过 ≠ 通过
     * （分母写死，跳过会被 `✗ 有 N 条未能反证` 抓住，不会静默变绿，但仍要随手同步）。
     */
    find: "'本组 13 项 · 改档位/后端/模型目录要重启引擎才生效",
    replace: "'本组 13 项 · 改档位/后端/模型目录要重启引擎才生效 · 摘要新增的一条",
    expect: ['SIMPLIFY.notesummary.verbatim'],
  },
  {
    name: '把「翻译服务」的一行摘要删掉（该组有组说明却没摘要）',
    file: F.catalog,
    find: "noteSummary: '本组 13 项 · 改档位/后端/模型目录要重启引擎才生效 · 两个空闲卸载阈值生效时机不同',",
    replace: '',
    expect: ['SIMPLIFY.notesummary.verbatim'],
  },
  {
    name: '把「通用」的 <GroupNote> 摘掉 summary（数据有了、界面不折叠）',
    file: F.secGeneral,
    find: '<GroupNote summary={GENERAL.noteSummary}>{GENERAL.note as string}</GroupNote>',
    replace: '<GroupNote>{GENERAL.note as string}</GroupNote>',
    expect: ['SIMPLIFY.notesummary.wired'],
  },
  {
    name: '去掉 GroupNote 的"缺组说明就不渲染"自守（缺 note 时又会在 emphasis 处崩）',
    file: F.parts,
    find: 'if (!children) return null;',
    replace: '// 自守被移除（反证）',
    expect: ['SIMPLIFY.optional.selfGuard'],
  },
  {
    name: '把页标题下的 blurb 改回无条件渲染（缺 blurb 时这一行会崩或留空）',
    file: F.settingsScreen,
    find: 'active?.blurb ? (',
    replace: 'true ? (',
    expect: ['SIMPLIFY.optional.selfGuard'],
  },
  {
    name: '把 Row / PendingRow 的 why 去掉 is-one（行高又被 2 行的 why 顶回 70~80）',
    file: F.parts,
    find: '<div className="set-row-why is-one" title={plain(item.why)}>',
    replace: '<div className="set-row-why" title={plain(item.why)}>',
    all: true,
    expect: ['SIMPLIFY.why.oneLine'],
  },
  {
    name: '把 is-one 的 nowrap 换成 line-clamp（宽容器下仍可能放两行）',
    file: F.settingsStyle,
    find: '  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.set-row-ctl {',
    replace: '  display: -webkit-box;\n  -webkit-line-clamp: 2;\n}\n\n.set-row-ctl {',
    expect: ['SIMPLIFY.why.oneLine'],
  },
  {
    name: '把「空闲卸载视觉」从 catalog 删掉（合卡顺手并成了数据项 ⇒ 全表少 1 项）',
    file: F.catalog,
    find: "          id: 'idle-vision',\n          label: '空闲卸载视觉',\n          state: 'live',\n",
    replace: "          id: 'idle-vision-sink',\n          label: '空闲卸载视觉(sink)',\n          state: 'live',\n",
    expect: ['SIMPLIFY.idle.card'],
  },
  {
    name: '把状态行的 is-chip 摘掉（状态又变回一串不可断的文本）',
    file: F.secTranslate,
    find: '<span className="set-state is-chip">\n                <Dot colorVar={state.colorVar} pulse={status?.state === \'starting\'} />',
    replace:
      '<span className="set-state">\n                <Dot colorVar={state.colorVar} pulse={status?.state === \'starting\'} />',
    expect: ['SIMPLIFY.state.chip'],
  },
  {
    name: '把令牌输入框改成 disabled（不可选中、不可复制 —— 让用户拿不走）',
    file: F.secTranslate,
    find: '            className="set-token-in"\n            readOnly\n',
    replace: '            className="set-token-in"\n            disabled\n',
    expect: ['SIMPLIFY.token.readonly'],
  },
  {
    name: '在「翻译档位」前插一枚下拉（说明被挤到下拉后面，右边缘不再对齐）',
    file: F.secTranslate,
    find: "        <Row item={itemOf(inference, 'tier')}>\n",
    replace:
      "        <Row item={itemOf(inference, 'tier')}>\n" +
      '          <Select label="反证" value="x" options={[]} onChange={() => {}} />\n',
    expect: ['SIMPLIFY.select.pulledRight'],
  },
  {
    name: '把诊断面板改成默认展开（方案 B 被退回"常显"，首屏又被顶掉）',
    file: F.engineDiag,
    find: '  const [open, setOpen] = useState(false);',
    replace: '  const [open, setOpen] = useState(true);',
    expect: ['SIMPLIFY.diag.foldedByDefault'],
  },
  {
    name: '把三处提示里的 .set-warn 从统一规则里摘出去（形状又变成两套）',
    file: F.settingsStyle,
    find: '.settings-main .set-warn,\n.settings-main .notice.is-bad {',
    replace: '.settings-main .set-warn-v2,\n.settings-main .notice.is-bad {',
    expect: ['SIMPLIFY.warn.unified'],
  },
  {
    name: '让「关于」里留着已删项的引用（渲染到那一组直接抛错，且五道门都看不见）',
    file: F.secAbout,
    // ⚠️ 锚点随实现迁移过一次：`licenses` 从 PendingRow 变成了 LicensesBlock（D-84）。
    // 锚点若不同步，这条会退化成「锚点未找到 ⇒ 跳过」，而输出里**看起来仍是全绿**。
    find: "        <LicensesBlock item={itemOf(g, 'licenses')} />",
    replace:
      "        <PendingRow item={itemOf(g, 'check-update')} />\n" +
      "        <LicensesBlock item={itemOf(g, 'licenses')} />",
    expect: ['WIRING.itemRefs.exist'],
  },
  {
    name: '把诊断面板的标题/why 硬写回组件里（catalog 里那一份从此永不渲染）',
    file: F.engineDiag,
    find: '<div className="set-run-why">{emphasis(item.why)}</div>',
    replace: '<div className="set-run-why">{"进程、参数的现场。"}</div>',
    expect: ['ENGINE.diag.fromCatalog', 'ENGINE.emphasis.renderPoints'],
  },

  // ── D-84 · 功能梳理落地（四项）各自的破坏 ──────────────────────────────
  {
    name: '把 Row 里的 def 渲染删掉（def 又变回"填了没人看"的死字段）',
    file: F.parts,
    find: '          {item.def ? <DefaultChip value={item.def} /> : null}\n',
    replace: '',
    expect: ['FEATURES.def.rendered'],
  },
  {
    name: '把 def 的字段注释改回旧口径（「当前没有任何组件渲染它」—— 实现已变，注释没变）',
    file: F.catalog,
    find: '   * 只在 `Row`（`live` 项）渲染；`pending` 项不显示它（还没有能力，谈默认值没有对象）。',
    replace:
      '   * 只在 `Row`（`live` 项）渲染；`pending` 项不显示它（还没有能力，谈默认值没有对象）。\n' +
      '   * 当前没有任何组件渲染它。',
    expect: ['FEATURES.def.commentSynced'],
  },
  {
    name: "把侧栏标签偏好的默认值写反（`!== '0'` → `=== '1'`：没写过的老用户被当成\"关\"）",
    file: F.shellPrefs,
    // ⚠️ 锚点里的常量名要跟着源码走（`STORAGE_KEY` 在 D-94 拆成 `SIDEBAR_KEY` /
    // `AUTO_START_KEY` 两个），否则这条会静默跳过（跳过 ≠ 通过）。
    find: "  return localStorage.getItem(SIDEBAR_KEY) !== '0';",
    replace: "  return localStorage.getItem(SIDEBAR_KEY) === '1';",
    expect: ['FEATURES.shell.pref'],
  },
  {
    name: "把自动启动偏好的默认值写反（`!== '0'` → `=== '1'`：没写过的老用户不再自动起服务）",
    file: F.shellPrefs,
    find: "  return localStorage.getItem(AUTO_START_KEY) !== '0';",
    replace: "  return localStorage.getItem(AUTO_START_KEY) === '1';",
    expect: ['FEATURES.shell.pref'],
  },
  {
    name: '把自动启动偏好的 key 改错（写/读不再同一格 ⇒ 开关拨了不生效）',
    file: F.shellPrefs,
    find: "const AUTO_START_KEY = 'miao.service-auto-start';",
    replace: "const AUTO_START_KEY = 'miao.service-autostart';",
    expect: ['FEATURES.shell.pref'],
  },
  {
    name: '把侧栏几何分支去掉（关掉标签却仍用 58×52，入口下方多出一截空行框）',
    file: F.sidebar,
    find: '  const appItem = labels ? SIDEBAR.appItem : SIDEBAR.iconOnlyItem;',
    replace: '  const appItem = SIDEBAR.appItem;',
    expect: ['FEATURES.shell.sidebarBranch'],
  },
  {
    name: '把应用入口的 aria-label 删掉（纯图标态下再没有任何可读名称）',
    file: F.sidebar,
    find: '          aria-label={a.label}\n',
    replace: '',
    expect: ['FEATURES.shell.sidebarBranch'],
  },
  {
    name: '把 iconOnlyItem 改成与 appItem 同尺寸（"切换偏好"其实没换几何）',
    file: F.tokens,
    find: '  iconOnlyItem: { w: 44, h: 44 },',
    replace: '  iconOnlyItem: { w: 58, h: 52 },',
    expect: ['FEATURES.shell.tokens'],
  },
  {
    name: '把①组开关的回写断掉（拨了开关只改一半，偏好不落盘）',
    file: F.secGeneral,
    find: 'onToggle={() => onSidebarLabels(!sidebarLabels)}',
    replace: 'onToggle={() => undefined}',
    expect: ['FEATURES.shell.wired'],
  },
  {
    name: '把 catalog 的 sidebar-labels 退回 pending（接线了却仍标"待接入"）',
    file: F.catalog,
    find: "          label: '侧栏图标标签',\n          state: 'live',",
    replace: "          label: '侧栏图标标签',\n          state: 'pending',",
    expect: ['FEATURES.shell.wired'],
  },
  {
    name: '把「不合计」这条立场从存储占用块里去掉（用户会本能地去做加法）',
    file: F.storageBlock,
    // 锚点只取那句立场文案本身：卡片副标题整句会随设计稿改词，写死整行标签会静默失配
    find: '三项独立统计，不合计；有目录的项都可以直接打开',
    replace: '三项独立统计；有目录的项都可以直接打开',
    expect: ['FEATURES.storage.rows'],
  },
  {
    name: '把模型那一行的「未统计」改成 0 B（把"没有接口"谎报成"精确测得是 0"）',
    file: F.storageBlock,
    find: '          <span className="set-storage-v is-unknown">未统计</span>',
    replace: '          <span className="set-storage-v">0 B</span>',
    expect: ['FEATURES.storage.rows'],
  },
  {
    name: '把 storage-usage 退回 pending（三行分列做了却仍标"待接入"）',
    file: F.catalog,
    find: "          id: 'storage-usage',\n          label: '存储占用',\n          state: 'live',",
    replace: "          id: 'storage-usage',\n          label: '存储占用',\n          state: 'pending',",
    expect: ['FEATURES.storage.wired'],
  },
  {
    name: '把「开源反馈」硬做成 live（它缺的是"项目已公开发布"这个外部事实）',
    file: F.catalog,
    find: "          id: 'oss-feedback',\n          label: '开源反馈',\n          state: 'pending',",
    replace: "          id: 'oss-feedback',\n          label: '开源反馈',\n          state: 'live',",
    expect: ['FEATURES.storage.wired'],
  },
  {
    name: '把许可清单的免责声明字段改名（清单会被读成"我们核准过了"）',
    file: F.licensesJson,
    find: '"disclaimer":',
    replace: '"disclaimerMoved":',
    expect: ['FEATURES.licenses.generated', 'FEATURES.licenses.ui'],
  },
  {
    name: '把生成物的 inputs 字段改名（依赖变了也不会再有人发现清单过期）',
    file: F.licensesJson,
    find: '"inputs":',
    replace: '"inputsMoved":',
    expect: ['FEATURES.licenses.generated', 'FEATURES.licenses.fresh'],
  },
  {
    name: '把没有声明的包从清单里过滤掉（缺口从此在界面上看不见）',
    file: F.licensesBlock,
    find: '{DATA.rust.packages.map((p) => (',
    replace: '{DATA.rust.packages.filter((p) => p.license).map((p) => (',
    expect: ['FEATURES.licenses.ui'],
  },
  {
    name: '把「关于」里的许可块换回「待接入」行（实现了却当作没做）',
    file: F.secAbout,
    find: "        <LicensesBlock item={itemOf(g, 'licenses')} />",
    replace: "        <PendingRow item={itemOf(g, 'licenses')} />",
    expect: ['FEATURES.licenses.ui'],
  },
  {
    // 命令收束后这条命令住在 e2eScripts.json 里；把 id 改名 = 摘掉登记（生成物从此无法重跑）
    name: '把 gen:licenses 从命令清单里摘掉（生成物从此无法重跑）',
    file: F.e2eScripts,
    find: '"id": "gen:licenses",',
    replace: '"id": "gen:licenses-moved",',
    expect: ['FEATURES.gen.script'],
  },
  {
    name: 'C5：生成脚本不再读引擎资产清单（引擎/模型许可变成"手写一份"）',
    file: F.genScript,
    find: "const ENGINE_MANIFEST = path.join(ROOT, 'engine', 'models.manifest.json');",
    replace: "const ENGINE_MANIFEST = path.join(ROOT, 'engine', 'nope.json');",
    expect: ['FEATURES.gen.script'],
  },
  {
    name: 'C5：生成物里没有 engine 段（引擎/模型许可一个都查不到）',
    file: F.licensesJson,
    find: '"engine":{',
    replace: '"engineMoved":{',
    expect: ['FEATURES.licenses.engine'],
  },
  {
    name: 'C5：生成物谎报"有模型资产随包分发"（许可边界被踩却不报）',
    file: F.licensesJson,
    find: '"bundledCount":0',
    replace: '"bundledCount":1',
    expect: ['FEATURES.licenses.engine'],
  },
  {
    name: 'C5：引擎资产条数不再参与过期对账（清单加了条目也没人发现）',
    file: F.licensesJson,
    find: '"engineAssets":',
    replace: '"engineAssetsMoved":',
    expect: ['FEATURES.licenses.fresh'],
  },
  {
    name: 'C5：界面不再渲染「禁止商用」那一段（生成物有、用户看不到）',
    file: F.licensesBlock,
    /*
     * `all: true`：`DATA.engine.bySpdx` 在块里出现**两处**（NC 筛选 + 那个 Scope 的取值），
     * 只改一处 ⇒ 另一处仍命中 ⇒ 假反证（实测过一次）。
     */
    find: 'DATA.engine.bySpdx',
    replace: '{}',
    all: true,
    expect: ['FEATURES.licenses.ui'],
  },
  {
    name: 'C5：界面不再渲染"随包分发 N 条"（C5 的正面陈述看不见）',
    file: F.licensesBlock,
    find: '随包分发 {DATA.engine.bundledCount} 条',
    replace: '随包分发 0 条',
    expect: ['FEATURES.licenses.ui'],
  },

  // —— ENGINE.css.noticePadding 的两半判据各配一条反证 ——
  {
    name: '注掉 .notice.set-row-note 补偿规则（盒式提示叠附注类时四周留白重回被清零态）',
    file: F.componentsStyle,
    find: '.notice.set-row-note {\n  padding: 10px 13px;\n}',
    replace: '/* 反证：补偿规则被注掉 */',
    expect: ['ENGINE.css.noticePadding'],
  },
  {
    name: '把 .set-row-note 的 padding 换成四条长写（esbuild 会合并回简写 ⇒ 修复被静默撤回）',
    file: F.componentsStyle,
    find: '  padding: 0 0 10px;\n}\n.set-row-note code {',
    replace:
      '  padding-top: 0;\n' +
      '  padding-right: 0;\n' +
      '  padding-bottom: 10px;\n' +
      '  padding-left: 0;\n' +
      '}\n.set-row-note code {',
    expect: ['ENGINE.css.noticePadding'],
  },

  // —— FONT 组判据各配反证（锚点按**当前真实字体与当前加载方式**写；换字体/换加载方式时须同步，
  //    否则反证会以"锚点未找到"跳过，而那正是覆盖率静默降级）——
  {
    name: '把狮尾 font.css 的 link 从入口 HTML 摘掉（该字体根本不加载，首位静默回落）',
    file: F.entryHtml,
    find: '    <link rel="stylesheet" href="/assets/fonts/swei-gothic/font.css" />\n',
    replace: '',
    expect: ['FONT.viaJsModule'],
  },
  {
    // public 下的 css **不被构建改写**：url() 写错就是 404，而且构建照常成功、页面照常渲染
    // （回落下一档字体）—— 与"没改过"完全同形，所以必须有一条专门盯它。
    name: '把狮尾清单的 url() 改成错误的绝对路径（public 下没人改写它 ⇒ 404，字体静默回落）',
    file: path.join(F.fontsDir, 'swei-gothic', 'font.css'),
    find: 'url(./SweiGothicCJKsc-Regular.woff2)',
    replace: 'url(/fonts/SweiGothicCJKsc-Regular.woff2)',
    expect: ['FONT.viaJsModule'],
  },
  {
    name: '把 font.css 挪回 index.scss 的 @use（Sass 静默丢弃 .css ⇒ 字体资源全不进构建）',
    file: path.join(F.stylesDir, 'index.scss'),
    find: "@use 'base.scss';",
    replace: "@use '../assets/fonts/swei-gothic/font.css';\n@use 'base.scss';",
    expect: ['FONT.viaJsModule'],
  },
  {
    // 悠哉字体清单里两条 face 都声明 `font-family: 'Yozai'`（400 与 700），
    // 只改一条会**剩另一条顶着**，断言照样绿 ⇒ 假反证。故 `all: true` 全改。
    name: '把悠哉字体的族名改坏（FONT.body 首位在随仓 face 里消失 ⇒ 静默回落）',
    file: path.join(F.fontsDir, 'yozai-font', 'font.css'),
    find: "font-family: 'Yozai';",
    replace: "font-family: 'Yozai Broken';",
    all: true,
    expect: ['FONT.stackFirstHasFace'],
  },
  {
    name: '把 FONT.display 首位写成文件名（族名与随仓 face 不符 ⇒ 静默回落）',
    file: F.tokens,
    find: "display: \"'Swei Gothic CJK SC', 'Yozai', 'LXGW WenKai GB', 'Zen Maru Gothic', 'Noto Sans SC', system-ui, sans-serif\",",
    replace:
      "display: \"'SweiGothicCJKsc-Regular', 'Yozai', 'LXGW WenKai GB', 'Zen Maru Gothic', 'Noto Sans SC', system-ui, sans-serif\",",
    expect: ['FONT.stackFirstHasFace'],
  },
  {
    name: '把霞鹜文楷清单的 @font-face 改坏（条数与目录内字体文件数不符 ⇒ 缺字形）',
    file: path.join(F.fontsDir, 'lxgw-wenkai-gb', 'font.css'),
    find: '@font-face {',
    replace: '@font-face-x {',
    expect: ['FONT.assetsPresent'],
  },

  // ———《03》设置页优化：运行状态卡。每条新断言各配一次破坏 ———
  {
    name: '把日志区塞回折叠分支（等于本版什么都没修）',
    file: F.engineDiag,
    find: '        <div className="set-run-log">',
    replace: '        {open ? (\n        <div className="set-run-log">',
    expect: ['ENGINE.run.logOutsideFold'],
  },
  {
    name: '让日志区在某个状态下 display:none（折叠态就看不到日志了）',
    file: F.settingsStyle,
    find: '.set-run-log {\n  border-top: 1px solid var(--md-line-soft);',
    replace: '.set-run-log {\n  display: none;\n  border-top: 1px solid var(--md-line-soft);',
    expect: ['ENGINE.run.logNotConditional'],
  },
  {
    name: '把「最近阶段日志」区块留在折叠区里（日志被渲染两遍）',
    file: F.engineDiag,
    find: '          <div className="set-diag-ops">\n',
    replace:
      '          <DiagSection title="最近阶段日志"><div /></DiagSection>\n' +
      '          <div className="set-diag-ops">\n',
    expect: ['ENGINE.run.noDupeLogSection'],
  },
  {
    name: '给「最后更新」补一个时间戳（引擎不报时刻，补一个就是编数据）',
    file: F.engineDiag,
    find: '最后更新：{relativeText(logs.length > 0 ? stampRef.current.at : 0, now)}',
    replace: '最后更新 14:22:07：{relativeText(logs.length > 0 ? stampRef.current.at : 0, now)}',
    expect: ['ENGINE.run.noTimestamp'],
  },
  {
    name: '把就地展开的上限从 8 行改回 3 行（"多看几行"退化成没有这回事）',
    file: F.engineDiag,
    find: 'const LOG_EXPANDED = 8;',
    replace: 'const LOG_EXPANDED = 3;',
    expect: ['ENGINE.run.expandTo8'],
  },
  {
    name: '让失败行不再着色（失败被淹没在常规色里）',
    file: F.engineDiag,
    // `all`：卡内与抽屉两处用同一句取类名，只改一处另一处仍是失败色 ⇒ 断言照绿（假反证）
    find: "className={isFailedLine(line) ? 'set-run-line is-bad' : 'set-run-line'}",
    replace: 'className="set-run-line"',
    all: true,
    expect: ['ENGINE.run.logErrorTint'],
  },
  {
    name: '把抽屉上限截断到 10 行（"一键取全量"名不副实）',
    file: F.engineDiag,
    find: 'const LOG_DRAWER_MAX = 120;',
    replace: 'const LOG_DRAWER_MAX = 10;',
    expect: ['ENGINE.run.drawerFull'],
  },
  {
    name: '把「导出 .txt」摘掉（看到了却拿不走）',
    file: F.engineDiag,
    find: '导出 .txt',
    replace: '导出 txt',
    expect: ['ENGINE.run.drawerOps'],
  },

  // ———密钥掩码：两个框各破坏一次（只破坏一个测不出"两个都漏改"）———
  // ⚠️ 锚点跨行 ⇒ 第 2、3 行的**缩进必须与 sections.tsx 一致**（这两条曾因在线块加了一层
  // 缩进而"锚点未找到"被静默跳过 —— 跳过 ≠ 通过，脚本会打印 ⚠ 并让退出码非 0）。
  {
    name: '把 appKey 框改回明文（保存后密钥直接铺在屏幕上）',
    file: F.secTranslate,
    find: 'className="set-src-in"\n                    type="password"\n                    value={draftKey}',
    replace: 'className="set-src-in"\n                    value={draftKey}',
    expect: ['SIMPLIFY.secret.masked'],
  },
  {
    name: '把 appSecret 框改回明文（保存后密钥直接铺在屏幕上）',
    file: F.secTranslate,
    find: 'className="set-src-in"\n                    type="password"\n                    value={draftSecret}',
    replace: 'className="set-src-in"\n                    value={draftSecret}',
    expect: ['SIMPLIFY.secret.masked'],
  },
  {
    name: '把 appSecret 的"已保存"态从掩码点改回文字提示（观感不再是密码框）',
    file: F.secTranslate,
    find: "credView?.hasSecret ? '••••••••' :",
    replace: "credView?.hasSecret ? '已保存 · 留空则不更改' :",
    expect: ['SIMPLIFY.secret.masked'],
  },
  {
    name: '把需求条目号写回「翻译来源」文案（界面又变成给评审看的）',
    file: F.catalog,
    find: "'翻译来源二选一 —— 本地引擎（默认）或在线 API",
    replace: "'翻译来源二选一（P-D1）—— 本地引擎（默认）或在线 API",
    expect: ['SIMPLIFY.translate.noSpecRefs'],
  },
  {
    name: '把需求条目号写回「翻译服务」组说明（全组文案不许混进设计过程）',
    file: F.catalog,
    find: "    '本组 13 项，分四小节：翻译来源、服务与配对、推理引擎、模型与诊断。' +\n",
    replace: "    '本组 13 项（P-D1），分四小节：翻译来源、服务与配对、推理引擎、模型与诊断。' +\n",
    // 本条只指向全量判据：写回的是「翻译服务」组，其余分组那条扫不到它。
    expect: ['SIMPLIFY.copy.noSpecRefs'],
  },
];

// ── 主流程 ────────────────────────────────────────────────────────────────
const refute = process.argv.includes('--refute');

console.log(
  '设置页断言（③ 播放·媒体「能实现/不能实现」重新裁定 + ② 翻译服务十三项与引擎诊断）' + (refute ? ' · 反证轮' : ''),
);
console.log(`根目录：${ROOT}`);
console.log(`断言总数：${A.length}（${GROUPS.join('/')}）`);

if (!refute) {
  const res = await runAll();
  const { pass, fail } = printGrouped(res);
  console.log('\n' + '─'.repeat(56));
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) {
    console.log('\n下一步：按上面 ✗ 的 detail 定位（是脚本写错还是真实缺口，勿为转绿而放宽断言）。');
  }
  process.exitCode = fail === 0 ? 0 : 1;
} else {
  const base = await runAll();
  const wasGreenBase = {};
  for (const a of A) wasGreenBase[a.id] = base[a.id].ok;

  let total = 0;
  let red = 0;
  let skipped = 0;
  const falsePositives = [];
  const restored = new Map(); // file -> original Buffer
  // 分母固定：应执行的破坏条数在脚本里写死，少执行一条即判红。
  // 理由 —— 比率型指标会吞掉分母变化：「13/13」和「12/12」看起来都全绿，
  // 而后者已经永久少了一条覆盖（锚点随被测代码重构漂移时会这样静默降级）。
  const expectedTotal = MUTATIONS.reduce((n, m) => n + m.expect.length, 0);

  console.log('\n破坏源文件 → 断言必须变红 → 按字节还原\n');
  for (const mut of MUTATIONS) {
    const original = readBytes(mut.file);
    restored.set(mut.file, original);
    let okApply = true;
    try {
      const txt = original.toString('utf8');
      /*
       * 🔴 锚点必须按目标文件的实际换行**折算**再匹配。
       *
       * 本仓库 `core.autocrlf=true`（且没有 `.gitattributes`），工作区里全是 **CRLF**，
       * 而这里的 `mut.find` 多行字面量是按 **LF** 写的。裸 `txt.includes(mut.find)`
       * 于是对**任何跨行锚点**都恒为 false ⇒ 判成"破坏锚点未找到"而**静默跳过** ——
       * 跳过 ≠ 通过（跳过的那几条覆盖率是 0，账面却看不出来）。
       * 实测本脚本曾因此在基线就静默跳过 31 条；music / units 两个脚本早就加了这一折算，
       * 唯独这里漏了。`all: true` 的分支同理（`split` 的锚点也要折算）。
       */
      const eol = txt.includes('\r\n') ? '\r\n' : '\n';
      const find = txt.includes(mut.find) ? mut.find : mut.find.split('\n').join(eol);
      if (!txt.includes(find)) {
        console.log(`⚠ ${mut.name}\n    破坏锚点未找到（源文件已变？）—— 本条无法反证`);
        okApply = false;
        skipped += mut.expect.length;
      } else {
        /*
         * `all: true` 用于「同一处改错在代码里天然出现两遍」的情形
         * （例如两个分支里各写了一遍同样的文案、或注释里也引用了同一段示例）。
         * 此时只改第一处是不够的：断言仍然绿，于是这条反证变成**假反证** ——
         * 它看起来覆盖到了，其实什么都没测到。这类"看起来做了反证"比不做更危险。
         */
        const replacement = mut.replace.split('\n').join(eol);
        const next = mut.all ? txt.split(find).join(replacement) : txt.replace(find, replacement);
        writeFileSync(mut.file, next);
      }
      if (okApply) {
        /*
         * ⚠️ 必须清缓存。本脚本的反证是**直接改盘**（music / units 那两个脚本走的是
         * `overrideFile` 内存覆盖层），而**样式全文**经 `_styles-source.mjs` 的
         * `cachedReadText` 读入 —— 那个缓存没有失效时机，不清就会读到**改前的样式**，
         * 于是"破坏 CSS 规则"的反证全部退化成假阳性（实测：摘掉 `animation: tlspin`
         * 时 `NOTREADY.timeline.explicitLoading` 该红没红，报 69/70）。
         */
        clearFileCache();
        const res = await runAll();
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
      if (original != null) writeFileSync(mut.file, original); // 精确按字节恢复
    }
  }

  // 恢复校验：所有被改文件必须与原始字节完全一致
  console.log('\n恢复校验');
  let restoreFail = 0;
  for (const [file, original] of restored) {
    if (original == null) continue;
    const back = readBytes(file);
    const same = back != null && back.equals(original);
    if (!same) restoreFail++;
    console.log(`  ${same ? '✓' : '✗'} ${path.relative(ROOT, file)} 字节${same ? '一致' : '不一致！'}`);
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红（应执行 ${expectedTotal} 条）`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证（破坏锚点未找到）—— 跳过 ≠ 通过`);
  if (restoreFail) console.log(`✗ 有 ${restoreFail} 个文件未恢复到原始字节`);
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(', ')}`);
  process.exitCode = red === total && total === expectedTotal && skipped === 0 && restoreFail === 0 ? 0 : 1;
}
