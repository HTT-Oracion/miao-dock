/**
 * 设计令牌 —— 与插件端**逐字一致**（《02》§5「与插件共用同一套设计令牌」）。
 *
 * 来源：设计稿文件 732136506189423 的 Color 变量集（id `3:2`），Light `3:1` / Dark `3:3`。
 * 共 18 色（ver1.0 新增 warning）。`$3:n` 是设计稿变量 id，保留以便对账。
 * 取值与 `extension/src/theme/tokens.ts` 保持同步 —— 两侧不一致即为缺陷。
 */

export const COLOR_TOKENS_LIGHT = {
  ink: '#3B3352', // $3:4
  'ink-2': '#5C5478', // $3:5
  muted: '#8C85A3', // $3:6
  surface: '#FFFFFF', // $3:7
  'surface-2': '#F5F5FF', // $3:8
  board: '#FAFAFF', // $3:9
  line: '#E5DEF5', // $3:10
  'line-soft': '#F0EBFA', // $3:11
  pink: '#FF8FBF', // $3:12
  'pink-soft': '#FFE0ED', // $3:13
  blue: '#8FC7FF', // $3:14
  'blue-soft': '#DEEDFF', // $3:15
  lavender: '#C9B5FF', // $3:16
  yellow: '#FFE066', // $3:17
  success: '#70D9AD', // $3:18
  error: '#FF7D85', // $3:19
  'on-accent': '#FFFFFF', // $3:20
  warning: '#C97B12', // $3:21（ver1.0 新增，用于「部分失败」）
} as const;

export const COLOR_TOKENS_DARK = {
  ink: '#F5F2FF',
  'ink-2': '#C9C2E0',
  muted: '#9994B8',
  surface: '#262140',
  'surface-2': '#2E294F',
  board: '#140F29',
  line: '#3B3361',
  'line-soft': '#292447',
  pink: '#FF9EC4',
  'pink-soft': '#4A2440',
  blue: '#8FC7FF',
  'blue-soft': '#1F304F',
  lavender: '#C9B5FF',
  yellow: '#FFE066',
  success: '#80E3BD',
  error: '#FF99A1',
  'on-accent': '#291A2E',
  warning: '#FFC46B',
} as const;

export type TokenName = keyof typeof COLOR_TOKENS_LIGHT;
export type ThemeMode = 'light' | 'dark';

/** 圆角档（《01》§9） */
export const RADIUS = {
  xs: 6,
  sm: 10,
  md: 16,
  lg: 22,
  xl: 28,
  thumb: 14,
} as const;

/**
 * 字体分工（《02》§5）：Zen Maru Gothic（标题/强调）、Noto Sans SC（正文）、Inter Medium（纯数字）。
 * 桌面端随应用分发字体文件（`src/assets/fonts`），不依赖用户系统是否装了这两款字体。
 */
export const FONT = {
  display: "'Zen Maru Gothic', 'Noto Sans SC', system-ui, sans-serif",
  body: "'Noto Sans SC', 'Zen Maru Gothic', system-ui, sans-serif",
  numeric: "'Inter', 'Noto Sans SC', system-ui, sans-serif",
} as const;

/** 品牌色为冻结值 —— 不绑令牌、不随主题切换（《01》§9） */
export const BRAND = {
  catEar: '#FF8FBF',
  bubble: '#FFFFFF',
  blush: '#FFC2D8',
} as const;

/**
 * 应用外壳几何（《02》§5.1）—— 逐值可对账
 *
 * | 元素     | 规格 |
 * |----------|------|
 * | 侧边导航 | 宽 78 |
 * | 工具条   | 高 62 |
 * | 应用区   | 内边距 26 / 26 / 22 / 24（上右下左） |
 */
export const SHELL = {
  sidebarWidth: 78,
  toolbarHeight: 62,
  contentPadding: { top: 26, right: 26, bottom: 22, left: 24 },
  logoSize: 40,
} as const;

/**
 * 侧栏两级结构几何（《09》§3.1）—— ver2.0 新增，逐值可对账
 *
 * | 元素            | 规格 | 为什么是这个值 |
 * |-----------------|------|----------------|
 * | 应用入口        | 58×52 | 图标 + 文字的形态，沿用 ver1.0 `.nav-item`，不改动已验证的点击热区 |
 * | 应用入口（纯图标）| 44×44 | 同一按钮关掉文字后的形态（「侧栏图标标签」偏好，台账 D-84） |
 * | 分隔线          | 34×1  | 与入口同宽的短横线，居中；比通栏更像"分组"而非"分隔线" |
 * | 全局层设置      | 44×44 | **纯图标**（去文字），故用方形 44 而非 58×52 |
 * | 设置 hover 提示 | title | 去掉了文字，交互上必须补回可发现的提示 |
 *
 * ⚠️ `iconOnlyItem` 与 `globalItem` 数值相同但**语义不同**，刻意不复用同一个常量：
 * 前者是"同一个应用入口在另一种偏好下的形态"（它仍带 `is-app`、仍参与应用层秩序），
 * 后者是"全局层唯一入口"。合并成一个常量会让将来想单独调其中一个时被迫连带改另一个。
 *
 * 两套尺寸都不小于 44 —— 44 是**点击热区下限**，纯图标态不得为了好看而缩到 40 以下。
 */
export const SIDEBAR = {
  appItem: { w: 58, h: 52 },
  iconOnlyItem: { w: 44, h: 44 },
  divider: { w: 34, h: 1 },
  globalItem: { w: 44, h: 44 },
} as const;

/**
 * 翻译应用内视图 Tab 行（《09》§3.2）—— ver2.0 新增
 *
 * 高 44：低于工具条 62（它是二级导航，不该与应用级工具条抢视觉权重），
 * 高于常见触控目标 40（保证可点）。贴在工具条下方，与工具条之间不另加边框分隔 ——
 * 二者同属"顶部导航带"，再加一条线会把 62+44 切成两个不相干的区域。
 */
export const VIEW_TABS = {
  height: 44,
  itemMinWidth: 88,
  itemPaddingX: 16,
} as const;

/**
 * 设置页两栏壳几何（《09》§4.1）—— 1:1 参考实现 `SettingsPage.tsx` 的几何规格
 *
 * | 元素       | 规格 | 说明 |
 * |------------|------|------|
 * | 左栏       | 180px，`flex:0 0 180px` | 分组导航 |
 * | 左栏 sticky| top 26px | 对齐内容区上内边距，滚动时左栏不动 |
 * | 右栏       | flex:1 / min-width:0 | `min-width:0` 必写，否则长路径会把壳撑破 |
 * | 分组项     | padding 9/12, icon 18, gap 2 | — |
 * | 页标题     | 15px/700 | — |
 * | 小节标题   | 10.5px/700/uppercase/.05em | **组内分层的关键**，不可省 |
 * | 行         | min-height 50, padding 10 0 | 相邻行 1px line-soft |
 */
export const SETTINGS = {
  navWidth: 180,
  navStickyTop: 26,
  navItemPadding: { y: 9, x: 12 },
  navItemIcon: 18,
  navItemGap: 2,
  pageTitleSize: 15,
  sectionTitleSize: 10.5,
  sectionTitleTracking: '0.05em',
  rowMinHeight: 50,
  rowPaddingY: 10,
} as const;

/** 画面 X-C1 · 任务队列几何（《02》§5.2） */
export const QUEUE_TABLE = {
  colSource: 120,
  colProgress: 160,
  colStatus: 150,
  colAction: 90,
  rowHeight: 58,
} as const;

/** 画面 X-D1 · 本地漫画库几何（《02》§5.5） */
export const LIBRARY = {
  leftColumnWidth: 260,
  card: { w: 110, h: 165, radius: 12 },
  gridGap: 12,
} as const;

/** 画面 X-C2 · 队列空态（《02》§5.3） */
export const QUEUE_EMPTY = {
  magicCircle: 160,
  rotateSeconds: 8,
} as const;

/** 生成 CSS 变量（深色模式只换变量，不换结构 —— 《01》§9） */
export function cssVars(mode: ThemeMode): Record<string, string> {
  const src = mode === 'dark' ? COLOR_TOKENS_DARK : COLOR_TOKENS_LIGHT;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) out[`--md-${k}`] = v;
  out['--md-radius-xs'] = `${RADIUS.xs}px`;
  out['--md-radius-sm'] = `${RADIUS.sm}px`;
  out['--md-radius-md'] = `${RADIUS.md}px`;
  out['--md-radius-lg'] = `${RADIUS.lg}px`;
  out['--md-radius-xl'] = `${RADIUS.xl}px`;
  out['--md-radius-thumb'] = `${RADIUS.thumb}px`;
  out['--md-font-display'] = FONT.display;
  out['--md-font-body'] = FONT.body;
  out['--md-font-numeric'] = FONT.numeric;
  return out;
}
