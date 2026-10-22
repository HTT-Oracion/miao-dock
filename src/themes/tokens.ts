/**
 * 设计令牌 —— 与插件端**逐字一致**（《02》§5「与插件共用同一套设计令牌」）。
 *
 * ver3.0「空色日和」调色板：雾蓝为骨、杏奶为温、鼠尾草为静。
 * 键名保持不变（`pink` = 强调色、`blue` = 主色、`lavender` = 第三强调色），
 * 这样旧分片不需要逐处改名；新样式一律再经 `--miao-*` 语义别名消费。
 *
 * 取值与 `extension/src/themes/tokens.ts` 保持同步 —— 两侧不一致即为缺陷。
 */

export const COLOR_TOKENS_LIGHT = {
  ink: '#2D3B46',
  'ink-2': '#55646F',
  muted: '#7E8D98',
  surface: '#FFFFFF',
  'surface-2': '#F1F5F7',
  board: '#F6F8F9',
  line: '#E5EBEF',
  'line-soft': '#EEF3F6',
  pink: '#DFA47D',
  'pink-soft': '#FBF0E7',
  blue: '#6E97B9',
  'blue-soft': '#EAF2F8',
  lavender: '#8CA88C',
  yellow: '#D9A441',
  success: '#6F9A83',
  error: '#C97D73',
  'on-accent': '#FFFFFF',
  warning: '#BE8A57',
} as const;

export const COLOR_TOKENS_DARK = {
  ink: '#EDF3F7',
  'ink-2': '#B9C7D1',
  muted: '#8798A5',
  surface: '#18222C',
  'surface-2': '#1E2A34',
  board: '#111820',
  line: '#25333E',
  'line-soft': '#1B2731',
  pink: '#E3B08A',
  'pink-soft': '#33291F',
  blue: '#85ADCE',
  'blue-soft': '#223340',
  lavender: '#9BB89A',
  yellow: '#D2A36E',
  success: '#8FB69F',
  error: '#D9968C',
  'on-accent': '#111820',
  warning: '#D2A36E',
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
 * 字体分工（《02》§5，2026-10-10 定案）：**标题/强调与纯数字 = 狮尾圆体 · 简体（Swei Gothic CJK SC）**、
 * **正文 = 悠哉字体（Yozai）**；回退位依次为霞鹜文楷 GB、Zen Maru Gothic、Noto Sans SC。
 * 桌面端随应用分发字体文件（`public/assets/fonts`），不依赖用户系统是否装了这几款字体。
 * （**漫画译文**的渲染字体是另一条线：引擎侧 `LXGWWenKaiGB-Medium`，见 D-105，与本文件无关。）
 *
 * 🔴 族名必须与对应 `font.css` 里的 `font-family` 逐字一致，写错 ⇒ 该栈**首位静默失效**、回落下一项：
 *    `'Swei Gothic CJK SC'`（取 **TypoFamily**，不是 `Swei Gothic CJK SC Regular`——狮尾**每字重一个
 *    独立 family**，写 Family(1) 的名字 700 就取不到 Bold 那条 face）、`'Yozai'`、`'LXGW WenKai GB'`。
 *
 * 随仓分发三类字体，引入方式**不同**、别搞混：
 *   · Swei Gothic CJK SC —— **woff2**（Regular + **原生 Bold**），清单在 `public/assets/fonts/swei-gothic/font.css`；
 *   · Yozai —— 单体 TTF（Regular + Medium，无 Bold ⇒ 清单里 700 映射到 Medium），清单在 `public/assets/fonts/yozai-font/font.css`；
 *   · LXGW WenKai GB —— 单体 TTF（**Medium 档**，无 Bold），清单在 `public/assets/fonts/lxgw-wenkai-gb/font.css`。
 *   三者都由 `main.tsx` 从 **JS 侧** import（不能走 `styles/index.scss` 的 `@use`——Sass 对带 `.css`
 *   后缀的 `@use` 静默丢弃，字体不会进构建）。
 *   ⚠️ 原「源柔ゴシックP Medium（GenJyuuGothicP，120 片 woff2）」已于 2026-10-10 弃用并移除。
 */
export const FONT = {
  display: "'Swei Gothic CJK SC', 'Yozai', 'LXGW WenKai GB', 'Zen Maru Gothic', 'Noto Sans SC', system-ui, sans-serif",
  body: "'Yozai', 'LXGW WenKai GB', 'Swei Gothic CJK SC', 'Noto Sans SC', 'Zen Maru Gothic', system-ui, sans-serif",
  numeric:
    "'Swei Gothic CJK SC', 'Yozai', 'LXGW WenKai GB', 'Zen Maru Gothic', 'Inter', 'Noto Sans SC', system-ui, sans-serif",
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
  /** 1040 断点以下的纯图标轨宽度（与 app.scss 的媒体查询同值） */
  compactSidebarWidth: 66,
  /** 760 断点以下的窄轨宽度（与 app.scss 的媒体查询同值） */
  narrowSidebarWidth: 60,
  toolbarHeight: 62,
  contentPadding: { top: 26, right: 26, bottom: 22, left: 24 },
  /** 1180 断点以下的内容区内边距（与 app.scss 的媒体查询同值） */
  compactContentPadding: { top: 20, right: 18, bottom: 18, left: 18 },
  /** 760 断点以下的内容区内边距（与 app.scss 的媒体查询同值） */
  narrowContentPadding: { top: 14, right: 14, bottom: 18, left: 14 },
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
 * | 行         | min-height 56, padding 12 16 | 相邻行 1px line（设计稿 `.s-row` 原值）|
 * | 行控件     | 下拉 186×32 · 小按钮 28/r9 · 只读 28/r8 · 开关 38×22（圆点 16）| 见下方 `ctl*` 键 |
 */
export const SETTINGS = {
  /** 左栏列宽：设计稿 `.settings-layout` 的 `grid-template-columns: 192px` */
  navWidth: 192,
  /** 1180 断点以下的左栏宽度（设计稿同断点取 172） */
  navWidthCompact: 172,
  navStickyTop: 26,
  /** 左栏内边距：设计稿 `.settings-nav { padding: 16px 10px }` */
  navPadding: { y: 16, x: 10 },
  /** 导航项内边距：设计稿 `.snav { padding: 9px }` */
  navItemPadding: { y: 9, x: 9 },
  navItemIcon: 18,
  /** 设计稿 `.snav { gap: 8px }` */
  navItemGap: 8,
  /** 设计稿 `.settings-section-head h2 { font-size: 22px; line-height: 1.25 }` */
  pageTitleSize: 22,
  /** 设计稿 `.s-card-head h3 { font-size: 12.5px }` */
  sectionTitleSize: 12.5,
  sectionTitleTracking: '0.05em',
  /** 设计稿 `.s-row { min-height: 56px }` */
  rowMinHeight: 56,
  /** 设计稿 `.s-row { padding: 12px 16px }` —— 左右 16 是卡片内边距，行本身不能再贴边 */
  rowPaddingY: 12,
  rowPaddingX: 16,
  /** 设计稿 `.settings-body { max-width: 880px }` */
  bodyMaxWidth: 880,
  /** 设计稿 `.settings-main { padding: 16px 26px 56px }` */
  mainPadding: { top: 16, x: 26, bottom: 56 },
  /**
   * 行右侧控件位的几何（自检 C12 量的是渲染值，CSS 改错这里立刻红）。
   * 每一条都注明设计稿的原选择器 —— 这四档**不是一套尺寸**：下拉 32 高、
   * 小按钮与只读值 28 高、开关 22 高，各按设计稿；统一成一个高度反而是错的。
   * 只收几何、不收字号：字号被 `--ui-scale` 换算，首帧可能取不到变量（见 C12 的注释）。
   */
  /** 设计稿 `.s-row-control .select { width: 186px; height: 32px }` */
  ctlSelectWidth: 186,
  ctlSelectHeight: 32,
  /** 设计稿 `.btn-sm { height: 28px; border-radius: 9px }` */
  ctlBtnSmHeight: 28,
  ctlBtnSmRadius: 9,
  /** 设计稿 `.readonly { height: 28px; border-radius: 8px }` */
  ctlRoHeight: 28,
  ctlRoRadius: 8,
  /** 设计稿 `.switch-track { width: 38px; height: 22px; padding: 2px }` + `.switch-dot { 16×16 }` */
  ctlSwitchWidth: 38,
  ctlSwitchHeight: 22,
  ctlSwitchKnob: 16,
} as const;

/** 画面 X-C1 · 任务队列几何（《02》§5.2） */
export const QUEUE_TABLE = {
  colSource: 120,
  colProgress: 160,
  colStatus: 150,
  /**
   * 操作列。**从 90 加宽到 128**（R3）：每行现在是「主动作 + [更多]」两枚按钮
   * （[取消]/[重试]/[查看] + [更多]），90 放不下。改这里必须**同步改**
   * `manga.scss` 的 `.qt-c-action`（flex-basis 才是实际宽度）与 `SpecCheck` 样张 —— C2a 量的是实测宽。
   */
  colAction: 128,
  rowHeight: 58,
} as const;

/** 画面 X-D1 · 本地漫画库几何（《02》§5.5） */
export const LIBRARY = {
  leftColumnWidth: 260,
  card: { w: 110, h: 165, radius: 12 },
  gridGap: 12,
  /**
   * 封面几何（设计稿 §7.1 左栏缩略 / §7.3 详情头封面）。
   *
   * 两处**只有尺寸与圆角不同**，故用一份常量给出两组值，而不是在两个组件里各写一遍魔法数
   * —— 尺寸写两份，改一处忘一处时表现是"两处封面不一样大"，没人会当成 bug 去查。
   *
   * 圆角用**绝对像素**而不是 `--md-radius-*` 令牌：令牌阶梯是 6 / 10 / 16，
   * 而设计稿把详情头封面定在 8 —— 就近取 10 会让 56×76 的小封面圆角明显发胖。
   */
  cover: {
    thumb: { w: 36, h: 48, radius: 5 },
    head: { w: 56, h: 76, radius: 8 },
  },
} as const;

/** 画面 X-C2 · 队列空态（《02》§5.3） */
export const QUEUE_EMPTY = {
  magicCircle: 160,
  rotateSeconds: 8,
} as const;

/**
 * ver3.0 圆角阶梯（「空色日和」视觉系统）。
 *
 * 与 `RADIUS` 并存而不是替换：`RADIUS` 的数值被规格自检与漫画库几何钉着，
 * 新视觉层需要更大的一档（26 / 32），故单列一套供 `--miao-*` 消费。
 */
export const MIAO_RADIUS = {
  xs: 9,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 26,
  '2xl': 32,
  full: 999,
} as const;

/** ver3.0 动效令牌：所有位移走弹簧，不用线性缓动。 */
export const MIAO_MOTION = {
  fast: '140ms',
  base: '240ms',
  slow: '380ms',
  spring: 'cubic-bezier(.22, 1.3, .36, 1)',
  springSoft: 'cubic-bezier(.34, 1.4, .64, 1)',
  out: 'cubic-bezier(.16, 1, .3, 1)',
} as const;

/** 各模块的强调色 —— 侧栏高亮、模块标题、空态插画各取一支。 */
export const MODULE_ACCENT = {
  translate: '#6E97B9',
  music: '#DFA47D',
  settings: '#8CA88C',
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

  // ver3 语义别名：新样式只消费这一层，调色板换代时不用改组件。
  out['--miao-bg'] = src.board;
  out['--miao-surface'] = src.surface;
  out['--miao-surface-2'] = src['surface-2'];
  out['--miao-surface-3'] = mode === 'dark' ? '#26343F' : '#E9F0F4';
  out['--miao-ink'] = src.ink;
  out['--miao-text'] = src['ink-2'];
  out['--miao-muted'] = src.muted;
  out['--miao-faint'] = mode === 'dark' ? '#6B7D8A' : '#A5B1BA';
  out['--miao-font-mono'] = "'Cascadia Code', 'SFMono-Regular', Consolas, 'Liberation Mono', monospace";
  out['--miao-line'] = src.line;
  out['--miao-line-strong'] = mode === 'dark' ? '#344550' : '#D3DEE5';
  out['--miao-primary'] = src.blue;
  out['--miao-primary-soft'] = src['blue-soft'];
  out['--miao-primary-line'] = mode === 'dark' ? '#344C5E' : '#CFE1ED';
  out['--miao-primary-ink'] = mode === 'dark' ? '#B7D1E5' : '#3F6078';
  out['--miao-accent'] = src.pink;
  out['--miao-accent-soft'] = src['pink-soft'];
  out['--miao-accent-line'] = mode === 'dark' ? '#4E3C2D' : '#F0D9C8';
  // 🔴 这一档曾被 CSS 用了 5 处却**没人定义**（`--miao-accent-ink`）—— 未定义的自定义属性
  // 会让整条声明失效（IACVT），`color` 静默回落到继承值，于是 kicker/徽标/注解毒那几处
  // 一直"看着是灰的"却没人报错。值取设计稿的 `--accent-deep`（浅 #BE7F57 / 深 #EFC4A4）。
  out['--miao-accent-ink'] = mode === 'dark' ? '#EFC4A4' : '#BE7F57';
  out['--miao-sage'] = src.lavender;
  out['--miao-sage-soft'] = mode === 'dark' ? '#233027' : '#EEF4EE';
  out['--miao-sage-line'] = mode === 'dark' ? '#3A4C3D' : '#D8E6D8';
  out['--miao-sage-ink'] = mode === 'dark' ? '#B6CDB4' : '#5E7A5F';
  out['--miao-danger'] = src.error;
  out['--miao-danger-soft'] = mode === 'dark' ? '#352522' : '#F9EDEB';
  out['--miao-success'] = src.success;
  out['--miao-success-soft'] = mode === 'dark' ? '#20322A' : '#EAF3EE';
  out['--miao-warning'] = src.warning;
  out['--miao-warning-soft'] = mode === 'dark' ? '#33291E' : '#F9F0E6';
  out['--miao-glass'] = mode === 'dark' ? 'rgba(23, 32, 41, .68)' : 'rgba(255, 255, 255, .64)';
  out['--miao-glass-line'] = mode === 'dark' ? 'rgba(255,255,255,.08)' : 'rgba(255,255,255,.72)';
  out['--miao-shadow-1'] =
    mode === 'dark'
      ? '0 1px 2px rgba(0,0,0,.24), 0 16px 36px -30px rgba(0,0,0,.7)'
      : '0 1px 2px rgba(45,59,70,.04), 0 14px 34px -26px rgba(45,59,70,.22)';
  out['--miao-shadow-2'] =
    mode === 'dark'
      ? '0 2px 6px rgba(0,0,0,.3), 0 28px 64px -34px rgba(0,0,0,.8)'
      : '0 2px 6px rgba(45,59,70,.06), 0 28px 64px -34px rgba(45,59,70,.28)';
  out['--miao-shadow-primary'] =
    mode === 'dark' ? '0 12px 24px -16px rgba(0,0,0,.55)' : '0 10px 22px -14px rgba(110,151,185,.5)';
  for (const [k, v] of Object.entries(MIAO_RADIUS)) out[`--miao-r-${k}`] = `${v}px`;
  out['--miao-dur-fast'] = MIAO_MOTION.fast;
  out['--miao-dur-base'] = MIAO_MOTION.base;
  out['--miao-dur-slow'] = MIAO_MOTION.slow;
  out['--miao-ease-spring'] = MIAO_MOTION.spring;
  out['--miao-ease-spring-soft'] = MIAO_MOTION.springSoft;
  out['--miao-ease-out'] = MIAO_MOTION.out;
  out['--miao-mod-translate'] = MODULE_ACCENT.translate;
  out['--miao-mod-music'] = MODULE_ACCENT.music;
  out['--miao-mod-settings'] = MODULE_ACCENT.settings;
  return out;
}
