/**
 * 设计令牌 —— **镜像副本**，数值逐条取自主工程 `src/themes/tokens.ts`（浅色档）。
 *
 * 🔴 为什么是副本而不是 import：安装向导是**独立的安装器程序**，不许 import 主工程源码
 *    （它要单独构建、单独分发，生命周期与主应用无关）。代价是两侧可能漂移 ——
 *    改 `src/themes/tokens.ts` 时必须同步这里；那份是 `check:ia` 的断言对象，改它本就要慎重。
 *
 * 只保留浅色：安装 / 卸载是系统级小窗，不读应用主题偏好，也不提供切换入口。
 */

/** 18 色 + warning；键名即 CSS 变量名（`--md-<key>`） */
const COLOR_TOKENS_LIGHT = {
  ink: '#3B3352',
  'ink-2': '#5C5478',
  muted: '#8C85A3',
  surface: '#FFFFFF',
  'surface-2': '#F5F5FF',
  board: '#FAFAFF',
  line: '#E5DEF5',
  'line-soft': '#F0EBFA',
  pink: '#FF8FBF',
  'pink-soft': '#FFE0ED',
  blue: '#8FC7FF',
  'blue-soft': '#DEEDFF',
  lavender: '#C9B5FF',
  yellow: '#FFE066',
  success: '#70D9AD',
  error: '#FF7D85',
  'on-accent': '#FFFFFF',
  warning: '#C97B12',
} as const;

/** 圆角档（px） */
const RADIUS = { xs: 6, sm: 10, md: 16, lg: 22, xl: 28, thumb: 14 } as const;

/** 字体分工：标题 / 正文 / 纯数字各一套栈（末位统一回落系统字体） */
const FONT = {
  display: "'Swei Gothic CJK SC', 'Yozai', 'LXGW WenKai GB', 'Zen Maru Gothic', 'Noto Sans SC', system-ui, sans-serif",
  body: "'Yozai', 'LXGW WenKai GB', 'Swei Gothic CJK SC', 'Noto Sans SC', 'Zen Maru Gothic', system-ui, sans-serif",
  numeric:
    "'Swei Gothic CJK SC', 'Yozai', 'LXGW WenKai GB', 'Zen Maru Gothic', 'Inter', 'Noto Sans SC', system-ui, sans-serif",
} as const;

/** 组装成 CSS 变量表（与主工程 `cssVars('light')` 同形） */
export function cssVars(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(COLOR_TOKENS_LIGHT)) out[`--md-${k}`] = v;
  for (const [k, v] of Object.entries(RADIUS)) out[`--md-radius-${k}`] = `${v}px`;
  out['--md-font-display'] = FONT.display;
  out['--md-font-body'] = FONT.body;
  out['--md-font-numeric'] = FONT.numeric;
  return out;
}

/** 写入 `document.documentElement` —— 本应用唯一注入令牌的地方 */
export function applyTokens(): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(cssVars())) root.style.setProperty(k, v);
  root.style.colorScheme = 'light';
}
