/**
 * 窗口级动作的收口 —— 目前只有"关闭"一件事。
 *
 * 为什么不走 props 层层传：需要"关闭"的只有标题栏那枚 ✕，而它嵌在每一个步骤的外壳里，
 * 为它把 `onClose` 穿过三层组件，改动面比收益大。窗口只有一个，模块级绑定既准确，
 * 又保留了可测性（`bindClose` 可以换成假实现）。
 */
let closeHandler: (() => void) | null = null;

export function bindClose(handler: () => void): void {
  closeHandler = handler;
}

export function requestClose(): void {
  closeHandler?.();
}
