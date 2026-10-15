import { useEffect, useState } from 'react';

/**
 * 防抖取值（纯 DOM 行为 hook，无业务依赖）。
 *
 * 用法约定：输入框的「受控值」用**原始 state**（保证按键即时回显、不错字），
 * 喂给昂贵下游（过滤 / 重挂载 / 拉网络）的**派生值**用本 hook 的返回值。
 * 于是连续输入期间只有轻量回显在跟手，重活被压到用户停手 `delayMs` 之后只做一次。
 *
 * 用途（漫画库搜索）：逐键过滤本身很便宜，但过滤会改 `filtered`，进而把选中项
 * 挤到别的漫画上、触发右栏网格重挂载并重拉十几张缩略图 —— 卡的是这串**级联**，
 * 不是过滤本身。防抖把级联从「每键一次」压成「停手一次」。
 */
export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
