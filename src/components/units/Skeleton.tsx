import type { CSSProperties } from 'react';

/**
 * 骨架块（通用单元）。
 *
 * 为什么用它而不是整屏转圈：列表的结构先出来，内容再逐步填充，
 * 加载完成时布局不跳。尺寸由调用方给（骨架形状必须与真实卡片一致，
 * 组件自己猜尺寸只会猜错）。
 */
export function Skeleton({
  height = 12,
  width = '100%',
  radius,
  className,
  style,
}: {
  /**
   * 高度。传 `'auto'` 表示**交给 CSS 决定**（配合 `aspect-ratio` 用）：
   * 骨架块的尺寸有时必须跟着容器走（卡封面 1:1），写死 px 就会在窗口变宽时对不上。
   */
  height?: number | string;
  width?: number | string;
  /** 圆角（px）；缺省沿用 `--r-xs`，卡片级骨架可传 12/14 */
  radius?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={className ? `ui-skel ${className}` : 'ui-skel'}
      style={{ height, width, borderRadius: radius, ...style }}
      aria-hidden="true"
    />
  );
}
