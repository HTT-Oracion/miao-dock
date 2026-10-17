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

  return { screen, view, overlay, setScreen, setView };
}
