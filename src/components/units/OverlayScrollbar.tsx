import type { OverlayThumb } from '@hooks/useOverlayScrollbar';

/**
 * 覆盖式滚动条的滑块本体（配合 `useOverlayScrollbar` 使用）。
 *
 * 它是容器里的**绝对定位**一层：`right: 2px`，宽度 6px，半透明。
 * 因为不参与文档流，滚动条**不会占掉任何内容宽度** —— 这正是本项目要的效果
 * （原生 `::-webkit-scrollbar` 无论多细都会挤占宽度）。
 */
export function OverlayScrollbar({ thumb }: { thumb: OverlayThumb }) {
  if (!thumb.size) return null;
  return (
    <span
      className={thumb.visible ? 'ui-osb is-on' : 'ui-osb'}
      style={{ height: thumb.size, transform: `translateY(${thumb.offset}px)` }}
      aria-hidden="true"
    />
  );
}
