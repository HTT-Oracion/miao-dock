import { useEffect } from 'react';

/**
 * Esc 关闭当前浮层（通用 hook）。
 *
 * 每个浮层各自挂一个，互不干扰 —— 面板叠面板时，后开的那个会先收到 Esc
 * （监听器按注册顺序倒序触发的前提是同一时刻只有一个浮层在监听；
 * 本项目没有嵌套浮层，故不做"只让最上层响应"的仲裁）。
 *
 * 放在 units 而不是 `src/hooks.ts`：hooks.ts 是**业务数据**的 hook 聚合
 * （服务状态、任务列表，内部 import ipc），而这个是纯 DOM 行为、无业务依赖
 * —— 与 units 的判据一致。
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
