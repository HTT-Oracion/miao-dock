import type { CSSProperties, ReactNode } from 'react';

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

/**
 * 统一加载态（通用单元）。
 *
 * 两种形态，调用方按**内容形状**选择，而不是按心情：
 * - `skeleton`：列表 / 卡片 / 表格 —— 结构先出来，内容再填充，加载完成时不跳版；
 * - `spinner`：一块没有稳定形状的区域（日志、诊断、单值）—— 转圈就够了。
 *
 * 只负责"长什么样"，**不负责决定该不该显示**：与 `Empty` / `ErrorState` 同一口径，
 * 三态由业务层按请求状态切换。
 */
export function LoadingState({
  label = '加载中…',
  variant = 'skeleton',
  rows = 3,
  inline,
  skeleton,
}: {
  label?: string;
  variant?: 'skeleton' | 'spinner';
  /** 骨架行数（`variant='skeleton'` 时生效） */
  rows?: number;
  /** 行内形态：不撑满、与相邻文字同基线 */
  inline?: boolean;
  /** 自定义骨架（例如书架缩略图网格）；给了就完全接管骨架区域 */
  skeleton?: ReactNode;
}) {
  const cls = ['ui-loading', inline ? 'is-inline' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} role="status" aria-live="polite" aria-busy="true">
      {variant === 'spinner' ? <span className="ui-loading-ring" aria-hidden="true" /> : null}
      {skeleton ? (
        skeleton
      ) : variant === 'skeleton' ? (
        <div className="ui-loading-lines" aria-hidden="true">
          {Array.from({ length: Math.max(1, rows) }, (_, i) => (
            <Skeleton key={i} height={10} width={i === rows - 1 ? '62%' : '100%'} />
          ))}
        </div>
      ) : null}
      <span>{label}</span>
    </div>
  );
}
