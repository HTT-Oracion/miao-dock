import { useEffect } from 'react';

/**
 * Esc 关闭当前浮层（纯 DOM 行为 hook，无业务依赖）。
 *
 * 每个浮层各自挂一个，互不干扰 —— 面板叠面板时，后开的那个会先收到 Esc
 * （监听器按注册顺序倒序触发的前提是同一时刻只有一个浮层在监听；
 * 本项目没有嵌套浮层，故不做"只让最上层响应"的仲裁）。
 *
 * 归属（2026-10-04 收口）：`use*` 开头的 hook 一律住 `src/hooks/`（spec-notes D-41），
 * 不再按「纯 DOM / 业务」拆散在组件目录里。
 * 注意 units 的判据因此收紧为**不 import `@hooks`（整个目录）**——
 * UI 单元对 hooks 层零依赖，哪怕 hook 本身无业务性。
 */
export function useEsc(onEsc: () => void) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEsc();
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onEsc]);
}
