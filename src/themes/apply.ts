import { useEffect } from 'react';
import { setWindowTheme } from '@/ipc';
import { cssVars, type ThemeMode } from '@/themes/tokens';

const STORAGE_KEY = 'miao.theme';

/** 上次选择的主题（未选择时跟随系统） */
export function initialMode(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function persistMode(mode: ThemeMode): void {
  localStorage.setItem(STORAGE_KEY, mode);
}

/**
 * 把当前模式的令牌写进 `document.documentElement`。
 *
 * 这是**唯一**写入颜色变量的地方 —— 深色模式因此不可能改到结构，
 * 因为换主题只走这一条路径（《01》§9「深色模式只换变量，不换结构」）。
 */
export function useThemeTokens(mode: ThemeMode): void {
  useEffect(() => {
    const root = document.documentElement;
    const vars = cssVars(mode);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    root.dataset.theme = mode;
    // 让 WebView 原生控件（滚动条、表单）也跟随主题
    root.style.colorScheme = mode;
    // 同步给原生窗口：标题栏（含红绿灯按钮那条 bar）跟着变色，否则暗色时顶部一条白。
    // 纯浏览器环境（如规格自检跑在浏览器里）没有 Tauri 桥，静默忽略即可。
    try {
      void setWindowTheme(mode);
    } catch {
      /* 非 Tauri 环境：无窗口可同步 */
    }
  }, [mode]);
}
