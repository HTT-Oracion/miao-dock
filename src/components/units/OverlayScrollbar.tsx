import type { CSSProperties } from 'react';

/**
 * 覆盖式滚动条的滑块几何（由 `useOverlayScrollbar` 算出后传进来）。
 *
 * 为什么类型在本文件里再写一遍而不从 hook 里 import：`units/` 下的文件**不许 import
 * 业务层**（`@hooks` 整个目录都在禁列里，由 `check:units` 的 PURITY 组机器核查）。
 * 一个只含数字的接口重复一遍的代价，远小于"为了复用把分层规则破一个洞"。
 */
export interface OverlayThumb {
  /** 滑块高度（px） */
  size: number;
  /** 滑块顶部偏移（px，相对滚动容器可视区） */
  offset: number;
  /** 是否该显示（内容溢出 & 正在滚动/悬停） */
  visible: boolean;
}

export interface OverlayScrollbarProps {
  thumb: OverlayThumb;
  /** 追加到滑块上的类名 */
  className?: string;
  style?: CSSProperties;
}

/**
 * 覆盖式滚动条的滑块本体（配合 `useOverlayScrollbar` 使用）。
 *
 * 它是容器里的**绝对定位**一层：`right: 2px`，宽度 6px，半透明。
 * 因为不参与文档流，滚动条**不会占掉任何内容宽度** —— 这正是本项目要的效果
 * （原生 `::-webkit-scrollbar` 无论多细都会挤占宽度）。
 */
export function OverlayScrollbar({ thumb, className, style }: OverlayScrollbarProps) {
  if (!thumb.size) return null;
  return (
    <span
      className={['ui-osb', thumb.visible ? 'is-on' : '', className ?? ''].filter(Boolean).join(' ')}
      style={{ height: thumb.size, transform: `translateY(${thumb.offset}px)`, ...style }}
      aria-hidden="true"
    />
  );
}
