#!/usr/bin/env node
/**
 * 设置页「③ 播放·媒体」按「能实现 / 不能实现」重新裁定的**验收断言** —— 且必须**可反证**。
 *
 * ## 为什么需要它
 *
 * 这次改动的本质是「把 5 项做不到的剔除、把 8 项能做到的补全」，它同时横跨五层，
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
  // 后者的文件清单被 units-structure-check 的 MANIFEST 锁死为 11 个，多一个即红）
  cacheBlock: path.join(APP, 'src', 'screens', 'settings', 'CacheBlock.tsx'),
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

/** ② MEDIA 组里必须存在且为 live 的 11 项（id ↔ 中文标签）
 *  后两项是桌面歌词（P3 落地后恢复）—— 此前它们以"需独立置顶窗口，延后"为由被剔除，
 *  该前提已不成立（《09》§5.6 第 1 项拍板要做独立窗口），故恢复。
 *  末项「音乐缓存」是通栏四格（`layout: 'block'`），不是标准两栏行。 */
const ADDED = [
  { id: 'quality', label: '音质档位' },
  { id: 'skin', label: '展开播放器皮肤' },
  { id: 'dynamic-bg', label: '动态背景' },
  { id: 'disc-mode', label: '碟片模式' },
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
 *  → **32**（加「音乐缓存」1 项） */
const SPEC_TOTAL = 32;

/** ④ 设置页必须真正取用的 store setter（逐项对应的控件回写） */
const MEDIA_SETTERS = [
  'setPlaybackQuality',
  'setSkin',
  'setDynamicEnabled',
  'setDiscMode',
  'setLyricsFontSize',
  'setLyricsHighlightColor',
  'setVinylColorMode',
  'setVinylCustomColor',
];

/** ⑤ store 侧六个偏好字段 ↔ 各自 setter（判据只认实现体，不认 interface 声明） */
const STORE_FIELDS = [
  { field: 'lyricsFontSize', setter: 'setLyricsFontSize' },
  { field: 'lyricsHighlightColor', setter: 'setLyricsHighlightColor' },
  { field: 'dynamicEnabled', setter: 'setDynamicEnabled' },
  { field: 'discMode', setter: 'setDiscMode' },
  { field: 'vinylColorMode', setter: 'setVinylColorMode' },
  { field: 'vinylCustomColor', setter: 'setVinylCustomColor' },
];

/** ⑦ 选项常量单一事实源应导出的常量 */
const OPTION_EXPORTS = ['SKINS', 'QUALITY_OPTIONS', 'LYRICS_SIZE', 'LYRICS_COLORS', 'VINYL_COLOR_DEF', 'LYRICS_COLOR_DEF'];

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

const GROUPS = ['EXCLUDED', 'ADDED', 'COUNT', 'WIRING', 'STORE', 'PLAYER', 'OPTIONS', 'CACHE'];
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
    // ⚠️ 锚点必须与 catalog 的真实字节一致 —— 常量从 29 变 31、再变 32 后不同步，
    // 这条会退化成「锚点未找到 / 跳过」，看起来仍是全绿（跳过 ≠ 通过）
    find: 'export const SPEC_ITEM_TOTAL = 32;',
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
];

// ── 主流程 ────────────────────────────────────────────────────────────────
const refute = process.argv.includes('--refute');

console.log('设置页 · ③ 播放·媒体「能实现/不能实现」重新裁定断言' + (refute ? ' · 反证轮' : ''));
console.log(`根目录：${ROOT}`);
console.log(`断言总数：${A.length}（EXCLUDED/ADDED/COUNT/WIRING/STORE/PLAYER/OPTIONS/CACHE）`);

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
        writeFileSync(mut.file, txt.replace(mut.find, mut.replace));
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
