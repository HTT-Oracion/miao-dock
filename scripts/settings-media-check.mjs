#!/usr/bin/env node
/**
 * 设置页的**验收断言**（设置页是唯一一屏"服务没起来也照常显示"的界面，见《09》§3.2）——
 * 且必须**可反证**。
 *
 * 覆盖两组，因为它们的失效形态是同一类（**编译得过、不抛错、界面就是不对**）：
 *   ③ 播放·媒体 ——「能实现 / 不能实现」重新裁定（EXCLUDED…CACHE 八组）
 *   ② 翻译服务 —— 十项全部接真实能力 + 引擎诊断视图（ENGINE 一组）
 *
 * ## 为什么需要它
 *
 * ③ 那次改动的本质是「把 5 项做不到的剔除、把 8 项能做到的补全」，它同时横跨五层，
 * 每层的静默失败各不相同：
 *
 *   CATALOG  app/src/screens/settings/catalog.ts        数据源（剔除了吗 / 补进了吗 / 项数对得上吗）
 *   WIRING   app/src/screens/settings/sections.tsx      设置页是否真的渲染控件、是否遍历三小节
 *   STORE    app/src/music/store.ts                     六个偏好字段（默认值 / setter / 持久化）
 *   PLAYER   app/src/screens/music/ExpandedPlayer.tsx   偏好是否真的落到播放器（CSS 变量 / 条件类名）
 *   OPTIONS  app/src/music/player-options.ts            选项常量的单一事实源（防设置页/播放器两套皮肤名）
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
 *   node scripts/settings-media-check.mjs            正向跑（期望全绿）
 *   node scripts/settings-media-check.mjs --refute   反证轮（破坏源文件 → 断言必须变红 → 按字节还原）
 *
 * 注意：本脚本禁止出现某个历史品牌标识的字面量（项目已清除该品牌词），需要提及时写「参考实现」。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readStyleSource } from './_styles-source.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = path.join(ROOT, 'app');

const F = {
  catalog: path.join(APP, 'src', 'screens', 'settings', 'catalog.ts'),
  sections: path.join(APP, 'src', 'screens', 'settings', 'sections.tsx'),
  store: path.join(APP, 'src', 'music', 'store.ts'),
  options: path.join(APP, 'src', 'music', 'player-options.ts'),
  expanded: path.join(APP, 'src', 'screens', 'music', 'ExpandedPlayer.tsx'),
  musicScreen: path.join(APP, 'src', 'screens', 'MusicScreen.tsx'),
  main: path.join(APP, 'src', 'main.tsx'),
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
  notReady: path.join(APP, 'src', 'screens', 'NotReadyScreen.tsx'),
  ipc: path.join(APP, 'src', 'ipc.ts'),
  nav: path.join(APP, 'src', 'nav.ts'),
  // 断言读到的 css 是全分片拼接（见 loadSources）；本组无 css 反证条目，
  // 故无需指到具体分片 —— 留 stylesDir 供将来新增反证时定位。
  stylesDir: path.join(APP, 'src', 'styles'),
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
 *  → **32**（加「音乐缓存」1 项）→ **33**（加「歌词高亮方式」1 项） */
const SPEC_TOTAL = 33;

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
const OPTION_EXPORTS = ['SKINS', 'QUALITY_OPTIONS', 'LYRICS_SIZE', 'LYRICS_COLORS', 'LYRICS_MODE_OPTIONS', 'LYRICS_MODE_DEF', 'VINYL_COLOR_DEF', 'LYRICS_COLOR_DEF'];

// ── 读文件 ───────────────────────────────────────────────────────────────
const readMaybe = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const readBytes = (p) => (existsSync(p) ? readFileSync(p) : null);

function loadSources() {
  return {
    catalog: readMaybe(F.catalog),
    sections: readMaybe(F.sections),
    store: readMaybe(F.store),
    options: readMaybe(F.options),
    expanded: readMaybe(F.expanded),
    musicScreen: readMaybe(F.musicScreen),
    main: readMaybe(F.main),
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
    ipc: readMaybe(F.ipc),
    nav: readMaybe(F.nav),
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
  return { ok: total === SPEC_TOTAL, detail: total === SPEC_TOTAL ? '' : `实际合计 ${total}（${perSection.join(', ')}），应为 ${SPEC_TOTAL}` };
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
  ok: /<ExpandedPlayer\b/.test(ctx.s.musicScreen),
  detail: '<ExpandedPlayer 未在 MusicScreen 挂载（挂载了偏好才可能生效）',
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
  return { ok: !hit, detail: hit ? 'ExpandedPlayer.tsx 又自己定义了一份 SKINS —— 设置页与播放器会漂移成两套皮肤名' : '' };
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
        ? "Group 的 block 分支排在 <Row 之后（包 Row 的分支会先执行，四格失效）"
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
  const need = [
    'set-cache-name',
    'set-cache-path',
    'set-cache-total',
    'set-cache-acts',
  ];
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
  const hasDialog = /className="modal-mask"/.test(src) && /role="dialog"/.test(src);
  const clearAt = src.indexOf('musicCacheClear(');
  // 确认状态必须是清除的前置：pending 非空时才渲染弹层，点确认后才调清除
  const gateByPending = /pending\s*\?/.test(src) && /setPending\(/.test(src);
  return {
    ok: hasDialog && clearAt > 0 && gateByPending,
    detail: !hasDialog
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
  const ok = /disabled=\{\s*bytes\s*<=\s*0\s*\}/.test(src);
  return {
    ok,
    detail: ok ? '' : '某平台 0 缓存时没有置灰（无可删之物却给可点的入口，点了像坏了）',
  };
});

// ============================ ⑨ ENGINE（② 翻译服务：推理引擎 / 模型与诊断） ============================
/*
 * 这一组守的是 ② 翻译服务**十项全部接真实能力**（《09》§4.3 / 《02》§5）
 * 与「引擎诊断视图」（《09》§6.2）。
 *
 * 为什么它值得一整组断言：这十项的失效形态**全都不会报错** ——
 *   · catalog 里标了 `live`、sections.tsx 里也写了控件，但控件绑的不是服务端字段
 *     （渲染出来永远停在"读取中…"，或显示一个前端自己编的默认值）；
 *   · 「已配置」与「已生效」被合成一个值（保存成功后下拉跳回旧值，用户只能得出"没存上"）；
 *   · 数字框逐字符提交（想把 5 改成 30，中途那一下会先写成 3 —— 那是**真实生效**的写入）；
 *   · 诊断面板的内部小标题复用了 `.set-subtitle`（规格自检 C11 的"恰好 3 个"从
 *     "3"变成"3+5"，那条断言红得莫名其妙，等于废掉）；
 *   · JSX 文本里漏出 markdown 的 `**`（界面上原样显示两个星号）。
 * 每一条都编译得过、类型检查过、不抛错。只能靠断言钉住。
 */

/** ② 的三小节 id（顺序即渲染顺序，也是 C11 判据「恰 3 个 `.set-subtitle`」的来源） */
const ENGINE_GROUPS = ['pairing', 'inference', 'model'];
/** 三小节标题字面量 —— C11 同时校验文字，这里必须逐字同源 */
const ENGINE_SUBTITLES = ['服务与配对', '推理引擎', '模型与诊断'];
/** 面板内四个区块标题（第五个"操作"区由 `.set-diag-ops` 承载，它不是一个 DiagSection） */
const DIAG_SECTIONS = ['进程状态', '生效配置', '模型状态', '最近阶段日志'];
/** 诊断面板的三个操作按钮文案 */
const DIAG_OPS = ['重启引擎', '重新下载模型', '强制释放模型'];

/** 取 ② 的十项（真实数据结构，不是字符串） */
function translateItems(ctx) {
  const err = CAT_ERR(ctx.cat);
  if (err) return { err, items: null, sec: null };
  const sec = ctx.cat.mod.TRANSLATE;
  return { err: null, items: flatItems(sec), sec };
}

add('ENGINE.items.tenAllLive', 'ENGINE', (ctx) => {
  const { err, items, sec } = translateItems(ctx);
  if (err) return { ok: false, detail: err };
  const per = (sec.groups ?? []).map((g) => `${g.id}=${(g.items ?? []).length}`);
  const problems = [];
  if (items.length !== 10) problems.push(`项数 ${items.length}，应为 10（${per.join(', ')}）`);
  // 每项都必须 live —— 十项里剩一项 pending，就意味着《09》§4.3 的"10 项"没落地
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
for (const [id, group] of [['ENGINE.layout.manageBlock', 'model-manage'], ['ENGINE.layout.diagBlock', 'engine-diag']]) {
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

add('ENGINE.wiring.threeSubTitles', 'ENGINE', (ctx) => {
  const body = tsBody(ctx);
  if (!body) return { ok: false, detail: 'sections.tsx 里找不到 TranslateSection 的实现体' };
  const n = (body.match(/<SubTitle>/g) ?? []).length;
  if (n !== 3) return { ok: false, detail: `TranslateSection 里有 ${n} 个 <SubTitle>，应恰为 3（C11 判据）` };
  const missing = ENGINE_SUBTITLES.filter((t) => !body.includes(`<SubTitle>${t}</SubTitle>`));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `小节标题缺字面量：${missing.join('、')}（C11 按文字校验）` : '',
  };
});
add('ENGINE.wiring.tierConfiguredVsEffective', 'ENGINE', (ctx) => {
  const body = tsBody(ctx) ?? '';
  const problems = [];
  // 控件显示的是**已配置**（用户在这里改"下次启动用哪档"）
  if (!/tier\.configured/.test(body)) problems.push('没读 tier.configured（控件会显示不出已配置的那一档）');
  // 旁边小字报的是**已生效**（引擎此刻在跑哪档）
  if (!/tier\.effective/.test(body)) problems.push('没读 tier.effective（用户看不到改动是否已生效）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.wiring.tierKeepsConfigured', 'ENGINE', (ctx) => {
  const body = tsBody(ctx) ?? '';
  /*
   * 判据是「已配置档**即使不在候选清单里也必须出现在选项里**」这条兜底分支。
   * 只查"有 tierValue"会假绿 —— 兜底写了但没人用、或用了但没推进 options，都测不到。
   * 这里锚在**渲染出来的那句标注**上（它同时也是用户能看见的证据）。
   */
  const ok = /tierOptions\.push\(/.test(body) && body.includes('（当前配置');
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
  const ok = body.includes('accel.mismatch') && /notice is-bad/.test(body) && /accel\.reason/.test(body);
  return {
    ok,
    detail: ok
      ? ''
      : '「用户指定的后端本机没有」没显示（或没说清实际按什么在跑）—— 用户会以为选的 CUDA 真的生效了',
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
  const body = tsBody(ctx) ?? '';
  // 「0 = 从不卸载」这一条**两档都要写**：只写一处，另一处遇到 0 用户会以为是 bug
  const n = (body.match(/从不卸载/g) ?? []).length;
  return { ok: n >= 2, detail: n >= 2 ? '' : `「0 = 从不卸载」只出现 ${n} 处，两档都要写明` };
});
add('ENGINE.wiring.visionNeedsRestart', 'ENGINE', (ctx) => {
  const body = tsBody(ctx) ?? '';
  // 两档待遇不同（LLM 即时 / 视觉需重启）必须**在界面上说出来**，否则用户无法理解为何只有一条提示
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

// —— 诊断面板 EngineDiag.tsx ——
add('ENGINE.diag.notSubTitle', 'ENGINE', (ctx) => {
  /*
   * 面板内部小标题**不能**复用 `.set-subtitle` / `SubTitle`：
   * 那个类名是规格自检 C11 数"② 有几个小节"的判据（恰 3 个）。
   * ⚠️ 必须先剥注释再判 —— 本文件的注释里**就在讨论这件事**（写着 `SubTitle` 与 `.set-subtitle`），
   * 直接搜字面量会把说明当成违规（而且删掉说明才能变绿，正好把判据引向错误的方向）。
   */
  const code = stripComments(ctx.s.engineDiag);
  const problems = [];
  if (code.includes('set-subtitle')) problems.push('面板里用了 .set-subtitle（C11 的"恰 3 个"会失效）');
  if (/\bSubTitle\b/.test(code)) problems.push('面板里用了 SubTitle 组件');
  if (!code.includes('set-diag-h')) problems.push('面板内部标题没有用 .set-diag-h');
  return { ok: problems.length === 0, detail: problems.join('；') };
});
add('ENGINE.diag.fiveBlocksAndOps', 'ENGINE', (ctx) => {
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
   * box-service 是兄弟进程管不到它 —— 所以这个动作诚实的表述就是"重启整条链路"。
   */
  const ok = /await\s+serviceRestart\(\)/.test(src);
  return { ok, detail: ok ? '' : '「重启引擎」没有调用 serviceRestart()（那就是一个点了不出事的假按钮）' };
});
add('ENGINE.diag.downloadDisabled', 'ENGINE', (ctx) => {
  const src = ctx.s.engineDiag;
  const ok = /scriptExists\s*===\s*false/.test(src) && /disabled=/.test(src);
  return {
    ok,
    detail: ok ? '' : '「重新下载模型」没按 scriptExists===false 置灰（脚本不在盘上时点了只会换一条报错）',
  };
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
  return {
    ok: mapped && safe,
    detail:
      !mapped
        ? '进程态映射表没有显式声明"可能不认识"（Record<string, … | undefined>）'
        : !safe
          ? '未知进程态回了 undefined 兜底（`view?.text ?? state` 缺失 ⇒ 遇到第五种态会整块崩）'
          : '',
  };
});
add('ENGINE.diag.stageLogReversed', 'ENGINE', (ctx) => {
  const src = ctx.s.engineDiag;
  const ok = /\[\.\.\.s\.recentStageLog\]\.reverse\(\)/.test(src);
  return { ok, detail: ok ? '' : '阶段日志没逆序（最新的应该在最上面，否则用户要滚到底才看见刚发生的事）' };
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
  const ok = /scriptExists\s*===\s*false/.test(src);
  return { ok, detail: ok ? '' : '「重新下载模型」没按 scriptExists===false 置灰' };
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
   */
  const srcs = [ctx.s.sections, ctx.s.engineDiag, ctx.s.modelManage, ctx.s.parts].join('\n');
  const used = new Set();
  for (const m of srcs.matchAll(/\bset-(?:diag|manage|warn|hint)[a-z0-9-]*/g)) used.add(m[0]);
  const css = ctx.s.css;
  const missing = [...used].filter((c) => !css.includes(`.${c}`));
  const problems = missing.map((c) => `.${c}`);
  // `is-pending` 是状态修饰符，不在上面的前缀里，单独钉住
  if (!css.includes('.set-hint.is-pending')) problems.push('.set-hint.is-pending');
  return {
    ok: problems.length === 0,
    detail: problems.length ? `样式缺规则：${problems.join('、')}（元素会渲染成没有样式的裸文本）` : '',
  };
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
   */
  const points = [
    ['组级说明（note）', fnBody(ctx.s.parts, 'GroupNote'), 'emphasis(children)'],
    ['标准行（why）', fnBody(ctx.s.parts, 'Row'), 'emphasis(item.why)'],
    ['待接入行（why）', fnBody(ctx.s.parts, 'PendingRow'), 'emphasis(item.why)'],
    ['通栏块（why）', ctx.s.modelManage, 'emphasis(item.why)'],
    ['组标题下的 blurb', ctx.s.settingsScreen, 'emphasis(active.blurb)'],
    ['规格自检 label/detail', ctx.s.specCheck, 'emphasis(r.label)'],
  ];
  const missing = points.filter(([, src, needle]) => !src || !src.includes(needle)).map(([n]) => n);
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
    detail: hits.length ? `JSX 裸文本里漏出 markdown 的 **（界面上会显示两个星号）：\n      ${hits.join('\n      ')}` : '',
  };
});

// ================================================================ X-C3「准备中」
//
// 守 S6 的「L1–L4 文案 + 首张稍慢」（《02》§3/§4、《09》§6.1）。
// 这一屏不在设置页里，但它和设置页共享**同一条事实源**：Rust 的 `StatusView`
// （`phase` / `mode` / `children` / `degraded`）—— 所以放同一轮断言，
// 免得"Rust 加了字段、TS 类型没跟"这类缺口两边都漏。

/** 《02》§3 与《09》§6.1 两张表里**逐字一致**的四句用户感知文案 */
const NOTREADY_TEXTS = [
  ['L1', '正在检查运行环境'],
  ['L2', '正在准备翻译模型'],
  ['L3', '正在预热'],
  ['L4', '首张稍慢，后续加快'],
];

add('NOTREADY.stages.texts', 'NOTREADY', (ctx) => {
  const src = ctx.s.notReady;
  const missing = NOTREADY_TEXTS.filter(([, t]) => !src.includes(`text: '${t}'`)).map(([id]) => id);
  const at = NOTREADY_TEXTS.map(([id]) => src.indexOf(`id: '${id}'`));
  const ordered = at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1]));
  const problems = [];
  if (missing.length) problems.push(`文案与方案表不一致（或缺失）：${missing.join('、')}`);
  if (!ordered) problems.push('四段顺序不是 L1→L2→L3→L4');
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('NOTREADY.stages.phaseDriven', 'NOTREADY', (ctx) => {
  /*
   * 这一条盯着本轮真实修掉的缺陷：早先进度是 `sidecar_port ? 2 : 1` —— 拿"引擎端口在不在"
   * 猜阶段。两处必错：① 端口先于阶段就绪时把 L1 显示成 L2；② ② 已起但 ③ 还没答 HTTP 时
   * L3 永远点不亮，用户看到的是"卡在第二段"。判据里必须**同时**有"读了 phase"与
   * "旧写法已消失"，只判前者会让旧写法以旁路形式留下来。
   */
  const code = stripComments(ctx.s.notReady);
  const problems = [];
  if (!/status\?\.phase\s*\?/.test(code)) problems.push('没有读 status.phase');
  if (!code.includes('PHASE_INDEX')) problems.push('没有 L1/L2/L3 → 阶段下标的映射表');
  if (/sidecar_port\s*\?\s*2\s*:\s*1/.test(code)) {
    problems.push('仍在用 sidecar_port 猜阶段（端口在听 ≠ 阶段已过）');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('NOTREADY.l4.notStartup', 'NOTREADY', (ctx) => {
  /*
   * L4 不属启动期（《04》§4.5：引擎的准备/卸载/降档都不新增客户端状态机节点）。
   * 它单列一支状态词「首图时完成」；沿用「待开始」会让用户以为卡在最后一段、
   * 一直在等一段永远不会自己走完的进度。
   */
  const code = stripComments(ctx.s.notReady);
  const problems = [];
  if (!code.includes("STAGES[i]?.id === 'L4' ? '首图时完成' : '待开始'")) {
    problems.push('L4 的状态词没有单列一支（会沿用「待开始」）');
  }
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('NOTREADY.state.fiveStates', 'NOTREADY', (ctx) => {
  /*
   * Rust 的 `ServiceState` 是**五态**（S2 加了 `stopping`）。TS 侧漏同步的症状不是编译错，
   * 而是运行期 `stateView()` 返回 `undefined`、调用方取 `.text` 直接崩 —— 且崩之前
   * 表现为"状态点不显示"。所以两头都断言：类型定义与 `STATE_VIEW` 映射表。
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
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('NOTREADY.wiring.modeDegraded', 'NOTREADY', (ctx) => {
  /*
   * 「以为在跑真引擎、其实跑的替身」是本项目最难查的一类故障（`mode` 存在的唯一理由）。
   * 三进程 pid/alive 与 degraded 同理：状态屏的价值就是把它们摆到明面上。
   */
  const src = ctx.s.notReady;
  const problems = [];
  if (!src.includes('status?.mode')) problems.push('没有显示 status.mode');
  if (!src.includes('status?.degraded')) problems.push('没有显示 degraded');
  if (!src.includes('status?.children')) problems.push('没有显示三进程 pid/alive');
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('NOTREADY.retry.byPhase', 'NOTREADY', (ctx) => {
  /* 《02》§4「按失败阶段提供『重试当前阶段』（L2 失败给『重新下载模型』）」 */
  const code = stripComments(ctx.s.notReady);
  const problems = [];
  if (!/failed\s*&&\s*status\?\.phase === 'L2'/.test(code)) {
    problems.push("没有按失败阶段分派重试（L2 失败应给「重新下载模型」）");
  }
  if (!code.includes('downloadEngineModels')) problems.push('没有真正调用下载端点（按钮会是个摆设）');
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('NOTREADY.detail.noFabricatedProgress', 'NOTREADY', (ctx) => {
  /*
   * X-C3 只在 **box-service 自己没起来**时出现 —— 此刻没有任何 HTTP 通道可读下载进度。
   * 所以"L1/L2 显示可量化进度"只能由**真实来源**满足：谁真的在打进度行，那一行就原样显示。
   * 判据是"不许出现硬编码的字节/百分比字面量"，而不是"必须有进度" —— 后者会逼出编造。
   */
  const code = stripComments(ctx.s.notReady);
  const problems = [];
  if (!/lastLogLine\(status\?\.log\)/.test(code)) problems.push('L2 明细不是取自真实日志');
  const fake = code.match(/['"][^'"]*?(?:\d[\d.]*\s*(?:GB|MB|KB)|[\d.]+\s*%)[^'"]*?['"]/g);
  if (fake) problems.push(`出现了硬编码的进度数字：${fake.join('、')}`);
  return { ok: problems.length === 0, detail: problems.join('；') };
});

add('NOTREADY.css.classes', 'NOTREADY', (ctx) => {
  /*
   * 反向判据：从组件里把类名抽出来，逐个要求在样式表里有规则（同 ENGINE.css.classes 的理由）。
   * ⚠️ 后缀必须吃 `[a-z0-9-]*`：只匹配到 `stage-meta` 的话，把类名改成
   * `stage-meta-item-v2` 会**仍然命中**（`stage-meta` 前缀还在），反证就成了假反证。
   */
  const src = ctx.s.notReady;
  const used = new Set();
  for (const m of src.matchAll(/\bstage-(?:hint|detail|meta|meta-item)[a-z0-9-]*/g)) used.add(m[0]);
  if (src.includes("'stage is-current'") || src.includes('is-failed')) used.add('stage.is-failed');
  const missing = [...used].filter((c) => !ctx.s.css.includes(`.${c}`));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `样式缺规则：${missing.map((c) => `.${c}`).join('、')}` : '',
  };
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

const GROUPS = ['EXCLUDED', 'ADDED', 'COUNT', 'WIRING', 'STORE', 'PLAYER', 'OPTIONS', 'CACHE', 'ENGINE', 'NOTREADY'];
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
    find: "        { id: 'quality', label: '音质档位', state: 'live', def: '高清臻音' },\n",
    replace: '',
    expect: ['ADDED.quality'],
  },
  {
    name: '把 audio-output 项加回 catalog（模拟「剔除了的又回来了」）',
    file: F.catalog,
    find: "        { id: 'quality', label: '音质档位', state: 'live', def: '高清臻音' },",
    replace:
      "        { id: 'quality', label: '音质档位', state: 'live', def: '高清臻音' },\n" +
      "        { id: 'audio-output', label: '音频输出', state: 'pending', why: '反证' },",
    expect: ['EXCLUDED.audio-output'],
  },
  {
    name: '把项数自校常量改成 26（模拟自校常量漂移）',
    file: F.catalog,
    // ⚠️ 锚点必须与 catalog 的真实字节一致 —— 常量从 29 变 31、再变 32、再变 33 后不同步，
    // 这条会退化成「锚点未找到 / 跳过」，看起来仍是全绿（跳过 ≠ 通过）
    find: 'export const SPEC_ITEM_TOTAL = 33;',
    replace: 'export const SPEC_ITEM_TOTAL = 26;',
    expect: ['COUNT.specMatches'],
  },
  {
    name: '把 MediaSection 的遍历改回 MEDIA.groups[0]（只渲染第一小节）',
    file: F.sections,
    find: '      {MEDIA.groups.map((g) => (\n        <Group key={g.id} group={g} render={render} />\n      ))}',
    replace: '      <Group group={MEDIA.groups[0]} render={render} />',
    expect: ['WIRING.groups.traverse', 'WIRING.groups.noFirst'],
  },
  {
    name: '把 setVinylCustomColor 从 sections.tsx 里摘掉（控件不再回写 store）',
    file: F.sections,
    // 锚点只到 `= useMusicStore((s) => s.setVinylCustomColor);`，不写形参名
    find: '  const setVinylCustomColor = useMusicStore((s) => s.setVinylCustomColor);',
    replace: '  const setVinylCustomColor = () => {};',
    expect: ['WIRING.setter.setVinylCustomColor'],
  },
  {
    name: '把 store 某个 setter 的 savePrefs 调用删掉（偏好不再持久化）',
    file: F.store,
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
    name: "把 is-disc 类名改成无条件添加（该视觉态会常亮）",
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
    file: F.sections,
    find: "      case 'quality':",
    replace: "      case 'quality-off':",
    expect: ['WIRING.item.quality'],
  },
  {
    name: '把 quality 的 case 改成挂空（return null，控件不渲染）',
    file: F.sections,
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
    // 整条（含 id/label/state/layout）一起删 —— 只改 id 的话项还在，
    // COUNT.total 仍然对得上（那是**正确**的行为，不是假阳性）。
    // 判据是「真的导入 catalog 求和」，所以只有项真的少了它才会红。
    find:
      "        {\n" +
      "          id: 'music-cache',\n" +
      "          label: '音乐缓存',\n" +
      "          state: 'live',\n" +
      "          // 四格块：塞不进 Row 的窄右列（见 SettingItem.layout 的注释）\n" +
      "          layout: 'block',\n" +
      "          why:\n" +
      "            '在线播放的歌词与整首歌会落盘缓存，这里能看占用、按平台清除、打开缓存目录。' +\n" +
      "            '只统计**在线歌曲**的缓存 —— 你自己导入的本地文件不在其中。',\n" +
      "        },\n",
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
    name: "把 sections.tsx 里 music-cache 的 case 改错（四格块不会被渲染）",
    file: F.sections,
    find: "      case 'music-cache':",
    replace: "      case 'music-cache-off':",
    expect: ['WIRING.item.music-cache'],
  },
  {
    name: '把「歌词高亮方式」项整条从 catalog 里删掉（模拟「加了项但忘了算进项数」）',
    file: F.catalog,
    find:
      "        {\n" +
      "          id: 'lyrics-mode',\n" +
      "          label: '歌词高亮方式',\n" +
      "          state: 'live',\n" +
      "          def: '逐字',\n" +
      "          why:\n" +
      "            '逐字＝有逐字数据（yrc/qrc）时精确到字、没有则整行从左到右渐进（默认）；' +\n" +
      "            '整行＝唱到该句整行一次性点亮，不逐字也不渐变。作用于「展开播放器」与灵动岛歌词卡。',\n" +
      "        },\n",
    replace: '',
    expect: ['ADDED.lyrics-mode', 'COUNT.total'],
  },
  {
    name: "把 sections.tsx 里 lyrics-mode 的 case 改错（歌词高亮方式开关不渲染）",
    file: F.sections,
    find: "      case 'lyrics-mode':",
    replace: "      case 'lyrics-mode-off':",
    expect: ['WIRING.item.lyrics-mode'],
  },
  {
    name: '把 store 的 setLyricsMode 里 savePrefs 键改错（歌词高亮方式偏好不持久化）',
    file: F.store,
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
   * ② 这十项的失效形态全都**不报错**：编译过、类型过、页面照常渲染，只是内容不对。
   * 所以每一条正向断言都必须配一次"把它破坏掉、看它变红"，否则正向断言本身
   * 是不是有效（会不会恒绿）无从得知。
   */
  {
    name: '把 ② 的「翻译档位」改成 pending（模拟十项里有一项没落地）',
    file: F.catalog,
    find: "          id: 'tier',\n          label: '翻译档位',\n          state: 'live',\n",
    replace: "          id: 'tier',\n          label: '翻译档位',\n          state: 'pending',\n",
    expect: ['ENGINE.items.tenAllLive'],
  },
  {
    name: '把 ② 第三小节 id 改错（小节结构被破坏，C11 的"恰 3 个"会跟着失守）',
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
    find: '          // 通栏块：进程表 / 参数 / 模型 / 阶段日志 / 三个操作，是一整块面板而非一行\n          layout: \'block\',\n',
    replace: '',
    expect: ['ENGINE.layout.diagBlock'],
  },
  {
    name: '删掉「模型与诊断」小节标题（C11 的小节数不再对得上）',
    file: F.sections,
    find: '        <SubTitle>模型与诊断</SubTitle>\n',
    replace: '',
    expect: ['ENGINE.wiring.threeSubTitles'],
  },
  {
    name: '把「引擎此刻在跑哪档」改成读已配置的值（已配置与已生效被合成一个）',
    file: F.sections,
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
    file: F.sections,
    find: '（当前配置',
    replace: '（不在清单',
    expect: ['ENGINE.wiring.tierKeepsConfigured'],
  },
  {
    name: '让「不推荐」档的强警告不取服务端文案（前端另编一句）',
    file: F.sections,
    find: 'tierInfo.warning',
    replace: 'tierInfo.tier',
    expect: ['ENGINE.wiring.tierWarnFromServer'],
  },
  {
    name: '删掉「用户指定的后端本机没有」的红条（用户会以为选的 CUDA 真的在跑）',
    file: F.sections,
    find: 'accel.mismatch',
    replace: 'accel.effective',
    all: true,
    expect: ['ENGINE.wiring.accelMismatch'],
  },
  {
    name: '把视觉档的空闲卸载也写成即时生效（两档待遇被混同）',
    file: F.sections,
    find: '必须重启引擎',
    replace: '保存后即生效',
    expect: ['ENGINE.wiring.visionNeedsRestart'],
  },
  {
    name: '删掉两处「0 = 从不卸载」的说明（0 会被当成 bug 而不是设计）',
    file: F.sections,
    find: '从不卸载',
    replace: '空闲即释放',
    all: true,
    expect: ['ENGINE.wiring.idleNeverUnload'],
  },
  {
    name: '删掉「改完要重启」的提示条（《09》§4.3 末句要求小节下方给提示）',
    file: F.sections,
    find: '<RestartHint title="推理引擎"',
    replace: '<RestartHint2 title="推理引擎"',
    expect: ['ENGINE.wiring.restartHint'],
  },
  {
    name: '去掉「打开模型目录」的存在性守卫（路径不存在时点了只会报错）',
    file: F.sections,
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
    name: '把诊断面板的内部小标题换成 SubTitle（C11 的"恰 3 个"会失效）',
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
    name: '去掉「重新下载模型」的置灰（脚本不在盘上时点了只换一条报错）',
    file: F.engineDiag,
    find: 's?.modelDownload?.scriptExists === false',
    replace: 'false',
    all: true,
    expect: ['ENGINE.diag.downloadDisabled'],
  },
  {
    name: '让诊断面板在遇到未知进程态时直接崩（引擎报第五种态就白屏）',
    file: F.engineDiag,
    find: '{view?.text ?? state}',
    replace: '{view.text}',
    expect: ['ENGINE.diag.unknownStateSafe'],
  },
  {
    name: '去掉阶段日志的逆序（最新一条沉到最下面）',
    file: F.engineDiag,
    find: '[...s.recentStageLog].reverse()',
    replace: 's.recentStageLog',
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
    find: 'return <div className="set-note">{emphasis(children)}</div>;',
    replace: 'return <div className="set-note">{children}</div>;',
    expect: ['ENGINE.emphasis.renderPoints'],
  },
  {
    name: '在 JSX 裸文本里塞回一个 markdown 粗体（这是本轮真实修掉的那个缺陷）',
    file: F.sections,
    find: '          0 = <b>从不卸载</b>。这一档由 box-service 自己看护，保存后<b>立刻生效</b>，不需要重启。',
    replace: '          0 = **从不卸载**。这一档由 box-service 自己看护，保存后<b>立刻生效</b>，不需要重启。',
    expect: ['ENGINE.md.noRawAsterisks'],
  },

  // —— X-C3「准备中」 ——
  {
    name: '给 L2 编一个字节进度（X-C3 此刻读不到任何 HTTP，编出来的数字就是撒谎）',
    file: F.notReady,
    find: "{ id: 'L2', text: '正在准备翻译模型' },",
    replace: "{ id: 'L2', text: '正在准备翻译模型 · 2.1/4.6 GB' },",
    expect: ['NOTREADY.detail.noFabricatedProgress'],
  },
  {
    name: '退回用 sidecar_port 猜阶段（端口先于阶段就绪时 L1 会显示成 L2）',
    file: F.notReady,
    find: "  const reached = state === 'running' ? STAGES.length : idx;",
    replace: "  const reached = state === 'running' ? STAGES.length : status?.sidecar_port ? 2 : 1;",
    expect: ['NOTREADY.stages.phaseDriven'],
  },
  {
    name: 'L4 的状态词退回「待开始」（用户会以为卡在最后一段、一直在等它走完）',
    file: F.notReady,
    find: "STAGES[i]?.id === 'L4' ? '首图时完成' : '待开始'",
    replace: "'待开始'",
    expect: ['NOTREADY.l4.notStartup'],
  },
  {
    name: 'TS 侧把第五态 stopping 删掉（Rust 已是五态；stateView() 会返回 undefined 而崩）',
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
    // `all`：五个 meta 项共用同一个类名，只改一处仍然命中样式表
    find: '<span className="stage-meta-item">',
    replace: '<span className="stage-meta-item-v2">',
    all: true,
    expect: ['NOTREADY.css.classes'],
  },
];

// ── 主流程 ────────────────────────────────────────────────────────────────
const refute = process.argv.includes('--refute');

console.log('设置页断言（③ 播放·媒体「能实现/不能实现」重新裁定 + ② 翻译服务十项与引擎诊断）' + (refute ? ' · 反证轮' : ''));
console.log(`根目录：${ROOT}`);
console.log(`断言总数：${A.length}（EXCLUDED/ADDED/COUNT/WIRING/STORE/PLAYER/OPTIONS/CACHE/ENGINE/NOTREADY）`);

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
      if (!txt.includes(mut.find)) {
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
        const next = mut.all ? txt.split(mut.find).join(mut.replace) : txt.replace(mut.find, mut.replace);
        writeFileSync(mut.file, next);
      }
      if (okApply) {
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
