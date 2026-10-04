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
  css: path.join(APP, 'src', 'styles', 'app.css'),
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

/** ② MEDIA 组里必须存在且为 live 的 10 项（id ↔ 中文标签）
 *  后两项是桌面歌词（P3 落地后恢复）—— 此前它们以"需独立置顶窗口，延后"为由被剔除，
 *  该前提已不成立（《09》§5.6 第 1 项拍板要做独立窗口），故恢复。 */
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
];

/** ③ MEDIA 的三小节 id（顺序即渲染顺序） */
const MEDIA_GROUPS = ['playback', 'lyrics', 'vinyl'];

/** ③ 全表项数自校常量应等于的合计
 *  26（初版）→ 29（③ 组 5 项 pending → 8 项 live）→ **31**（P3 桌面歌词恢复 2 项） */
const SPEC_TOTAL = 31;

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
    css: readMaybe(F.css),
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

/** 取 `export function <name>(…) { … }` 的函数体 */
function fnBody(src, name) {
  const m = new RegExp(`export function ${esc(name)}\\b`).exec(src);
  if (!m) return null;
  const start = src.indexOf('{', m.index);
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
    detail: missing.length ? `app.css 未消费这些注入：${missing.join('、')}（注入了却没样式消费 = 不生效）` : '',
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

const GROUPS = ['EXCLUDED', 'ADDED', 'COUNT', 'WIRING', 'STORE', 'PLAYER', 'OPTIONS'];
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
    // ⚠️ 锚点必须与 catalog 的真实字节一致 —— 常量从 29 变 31 后不同步，
    // 这条会退化成「锚点未找到 / 跳过」，看起来仍是全绿（跳过 ≠ 通过）
    find: 'export const SPEC_ITEM_TOTAL = 31;',
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
];

// ── 主流程 ────────────────────────────────────────────────────────────────
const refute = process.argv.includes('--refute');

console.log('设置页 · ③ 播放·媒体「能实现/不能实现」重新裁定断言' + (refute ? ' · 反证轮' : ''));
console.log(`根目录：${ROOT}`);
console.log(`断言总数：${A.length}（EXCLUDED/ADDED/COUNT/WIRING/STORE/PLAYER/OPTIONS）`);

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
