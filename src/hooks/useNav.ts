/**
 * 导航读写口 —— 把 URL 折成 `{ screen, view }`，并把「去哪」翻译回 URL。
 *
 * ## 为什么形状与原 `useState` 对偶
 * 返回的 `screen` / `view` / `setScreen` / `setView` 与引入路由之前**同名同签名**：
 * 侧栏、视图 Tab、未就绪屏的「去设置」这些调用点一行都不用改，
 * 断言里断「谁在改导航」的锚点（`onOpenGuide={() => setScreen('settings')}`、
 * 自动启动 effect 的依赖 `[screen, autoStart]`）也保持逐字不变。
 * 变的只有一处：这两个值**住在 URL 里**，不再住在组件 state 里。
 */
import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Screen, TranslateView } from '@/stores/nav';
import { FIRST_VIEW, parseScreen, pathOfScreen, pathOfView, type OverlayId } from '@/router/routes';

export interface Nav {
  screen: Screen;
  view: TranslateView;
  /** 覆盖层命中（如 `/engine-download`）；`null` = 正常屏内容 */
  overlay: OverlayId | null;
  setScreen: (s: Screen) => void;
  /**
   * 去设置页并**指定分组**（深链 `#/settings?section=x`）。
   *
   * 🔴 为什么需要它：`setScreen('settings')` 只改路径、不带 query ⇒ 设置页按
   *    `parseSection(null)` 回落到「① 通用」。而引导页的「查看完整诊断 / 服务设置」
   *    指向的是**「② 翻译链路」里的引擎诊断** —— 落在通用组等于把用户丢在错误的页面上，
   *    他得自己再去左栏找一次。这条入口就是"直接送到该去的那一组"。
   */
  setScreenSection: (s: Screen, section: string) => void;
  setView: (v: TranslateView) => void;
}

export function useNav(): Nav {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const hit = useMemo(() => parseScreen(pathname), [pathname]);

  // 未命中只可能是「组件树挂在路由表之外」这一种情况（正常路径由 `AppRouter` 的
  // 兜底路由改写回默认落点，走不到这里）。此时回落默认屏而不是抛错：
  // 渲染外壳的代价远小于让整个窗口白屏。
  const screen: Screen = hit?.screen ?? 'translate';
  const view: TranslateView = hit?.view ?? FIRST_VIEW;
  const overlay: OverlayId | null = hit?.overlay ?? null;

  const setScreen = useCallback((s: Screen) => navigate(pathOfScreen(s, view)), [navigate, view]);
  const setView = useCallback((v: TranslateView) => navigate(pathOfView(v)), [navigate]);
  /**
   * 带分组去设置页。
   *
   * 参数写进 **hash**（`#/settings?section=x`）而不是 search —— HashRouter 下只有前者是
   * 合法形态；写到 search 会变成 `?section=x#/settings`，刷新后设置页读不到（见
   * `SettingsScreen` 的 `readSectionParam` 与它的注释）。
   */
  const setScreenSection = useCallback(
    (s: Screen, section: string) => navigate(`${pathOfScreen(s)}?section=${encodeURIComponent(section)}`),
    [navigate],
  );

  return { screen, view, overlay, setScreen, setScreenSection, setView };
}
