/**
 * 桌面应用守卫：禁掉刷新 / 查找 / 查看源码 / 开发者工具快捷键，并取消默认右键菜单。
 *
 * 与主工程 `src/tools/desktopGards.ts` 同一套语义（这里是一份**副本** —— 安装器是独立程序，
 * 不 import 主工程源码；两侧要改就一起改）。装在入口只跑一次。
 *
 * 🔴 **开发态放行**（`import.meta.env.DEV`）：Ctrl+R / F5 / 右键调试都是排障手段，
 * 在 dev 里禁掉只会让人以为"改的代码没生效"。要验这条，跑打包后的程序。
 * 右键菜单的例外是**可编辑元素**：那里的原生菜单是剪切/复制/粘贴，桌面应用该有。
 */
export function installDesktopGuards(): void {
  if (import.meta.env.DEV) return;
  const mod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;
  const key = (e: KeyboardEvent) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);
  window.addEventListener(
    'keydown',
    (e) => {
      // F5 / F12 不带修饰键；其余都要 Ctrl 或 Cmd
      const k = key(e);
      const bare = k === 'F5' || k === 'F12';
      const combo =
        mod(e) &&
        (k === 'r' || // 刷新 / 硬刷新
          k === 'f' || // 页内查找
          k === 'u' || // 查看源码
          (e.shiftKey && (k === 'i' || k === 'j' || k === 'c'))); // 开发者工具
      if (bare || combo) e.preventDefault();
    },
    { capture: true },
  );
  window.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
  });
}
