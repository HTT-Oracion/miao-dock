/**
 * 屏级路由表 —— 「哪个路径 = 哪一屏」的**唯一事实源**。
 *
 * ## 为什么要有它
 * 引入路由之前，「当前在哪一屏」是 `App.tsx` 里的两个 `useState`（`screen` + `view`），
 * 侧栏与 Tab 各自回调 setState，URL 上不留任何痕迹。代价有三条：
 *   ① 两个状态可以同时非法（`screen='music'` 配 `view='library'`）；
 *   ② 刷新 / 深链一律回到默认屏，开发时要反复点回原来的位置；
 *   ③ 「一共有哪些屏」散在渲染分支里，没有可枚举的清单。
 * 现在由 URL 承载「屏 + 应用内视图」，侧栏与 Tab 只发**导航意图**。
 *
 * ## 为什么是 hash 路由
 * 桌面端没有服务端，也不该有：Tauri 加载的是本地文档（dev 走 vite dev server，
 * 打包后走 tauri 协议下的同一份静态文件）。History 路由的深链刷新会打到不存在的路径，
 * 而 hash 在两种形态下都稳，且不需要任何服务端改写。
 *
 * ## 与 `@/stores/nav` 的分工
 * `nav.ts` 回答「有哪些屏、哪个屏在服务未就绪时让位」（IA 事实源，纯数据）；
 * 本文件回答「哪个路径对应哪个屏」（路由事实源，纯映射）。
 * 视图清单不在这里另立枚举 —— 直接由 `TRANSLATE_VIEWS` 生成。
 *
 * ## 桌面歌词窗**不在**本表内（这是有意的）
 * 它是第二个 HTML 入口下的独立文档、独立 WebView，且刻意不引主窗的全局样式
 * （见 `templates/lyrics.html` 与 `src/screens/lyrics/index.ts` 的文件头理由）。
 * 给它套主窗的路由只会把主窗那套样式依赖一起拖进那个置顶小窗，收益为零。
 */
import { TRANSLATE_VIEWS, type Screen, type TranslateView } from '@/stores/nav';

/** 壳层覆盖层（不属于 `Screen` 枚举，避免破坏「两个应用 + 全局设置」的 IA）。 */
export type OverlayId = 'engine-download';

/** 屏级路由：`screen` 是壳层屏；`view` 只有漫画翻译应用有（音乐自成工作区，不加 Tab）。 */
export interface ScreenRoute {
  path: string;
  screen: Screen;
  view?: TranslateView;
  /** 覆盖层路由：命中时内容区换成对应面板，但侧栏仍按 `screen` 高亮 */
  overlay?: OverlayId;
}

/** 视图清单的第一项 —— 翻译应用的默认落点（顺序即 `TRANSLATE_VIEWS` 的顺序） */
export const FIRST_VIEW: TranslateView = TRANSLATE_VIEWS[0].id;

/** 无路径 / 路径非法时的落点 */
export const DEFAULT_PATH = `/translate/${FIRST_VIEW}`;

/**
 * 路由表本体。
 *
 * 翻译三视图**从 `TRANSLATE_VIEWS` 生成**：视图清单只在 `nav.ts` 维护一份，
 * 于是「新增一个视图却忘了加路由」这件事在类型上就发生不了。
 */
export const SCREEN_ROUTES: ScreenRoute[] = [
  ...TRANSLATE_VIEWS.map((v) => ({
    path: `/translate/${v.id}`,
    screen: 'translate' as const,
    view: v.id,
  })),
  { path: '/music', screen: 'music' },
  { path: '/settings', screen: 'settings' },
];

/**
 * 覆盖层路由：**不是屏**，不参与侧栏/视图 Tab，也不会在服务未就绪时让位。
 * 它挂在 App layout 下渲染成面板，`screen` 只用于侧栏高亮与返回上下文。
 */
export const OVERLAY_ROUTES: ScreenRoute[] = [
  { path: '/engine-download', screen: 'translate', overlay: 'engine-download' },
];

/** 末位斜杠与多余的重复斜杠都不算另一条路由（`/music/` 与 `/music` 同屏） */
function normalize(pathname: string): string {
  const p = pathname.replace(/\/{2,}/g, '/');
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** 路径 → 屏/覆盖层。**未命中返回 `null`**（由调用方决定去哪，不在这里静默兜底） */
export function parseScreen(pathname: string): ScreenRoute | null {
  const p = normalize(pathname);
  return [...SCREEN_ROUTES, ...OVERLAY_ROUTES].find((r) => r.path === p) ?? null;
}

/** 屏 → 路径（侧栏点击）。翻译应用落回它的第一视图 */
export function pathOfScreen(screen: Screen, view: TranslateView = FIRST_VIEW): string {
  return screen === 'translate' ? `/translate/${view}` : `/${screen}`;
}

/** 应用内视图 → 路径（Tab 点击） */
export function pathOfView(view: TranslateView): string {
  return `/translate/${view}`;
}
