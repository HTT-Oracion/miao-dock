/**
 * 桌面应用守卫：禁掉刷新/查找/查看源码/开发者工具快捷键，并取消默认右键菜单。
 *
 * 为什么装在入口：这是"这个程序是桌面应用、不是网页"的唯一收口处 —— 装在某个屏里，
 * 换一屏就失效；装在 App 里则每一次渲染都要重挂。入口只跑一次，语义也对。
 *
 * 🔴 **开发态放行**（`import.meta.env.DEV`）：Ctrl+R 刷新、F5、右键 inspect 都是排障手段，
 * 在 dev 里禁掉只会让人以为"我改的代码没生效"。要验这条守卫，跑的是**打包后的程序**。
 *
 * 右键菜单的例外是**可编辑元素**（input / textarea / contenteditable）：那里的原生菜单是
 * "剪切/复制/粘贴"，是桌面应用该有的样子；一刀切禁掉会让粘贴只剩快捷键一条路。
 */
export function installDesktopGuards(): void {
  if (import.meta.env.DEV) return;
  const mod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;
  const key = (e: KeyboardEvent) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);
  window.addEventListener(
    'keydown',
    (e) => {
      // F5 / F12 不带修饰键；其余都要 Ctrl 或 Cmd
      const bare = key(e) === 'F5' || key(e) === 'F12';
      const k = key(e);
      const combo =
        mod(e) &&
        (k === 'r' || // 刷新 / 硬刷新（Ctrl+Shift+R 一并覆盖）
          k === 'f' || // 页内查找
          k === 'u' || // 查看源码
          (e.shiftKey && (k === 'i' || k === 'j' || k === 'c'))); // 开发者工具
      if (bare || combo) e.preventDefault();
    },
    { capture: true },
  );
  window.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
  });
}
