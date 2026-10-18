import { useEffect, useState } from 'react';

/**
 * 细环形进度（通用单元；工具条 + 下载视图共用，纯 SVG）。
 *
 * ## 设计纪律
 * - 进度**只来自真实 `percent`**：`percent === null` 时显示「准备中」的静止环，
 *   **不**画假的 0%（与 NotReadyScreen `lastLogLine`「不编造」同一立场）。
 * - 旋转只在 `spinning` 时开，且 `prefers-reduced-motion` 下自动停（降级为静止环）。
 * - 色相走 `--md-*` 令牌，由调用方传入；颜色只承载状态，不堆装饰。
 */

const SPIN_KEYFRAMES = `
@keyframes ui-ring-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .ui-ring-spin { animation: none !important; }
}
`;

interface ProgressRingProps {
  /** 0..100；`null` = 无真实进度（准备中 / 不确定） */
  percent?: number | null;
  /** 直径（px） */
  size?: number;
  /** 环线宽（px） */
  stroke?: number;
  /** 进度弧色相令牌（`--md-*`）；默认 `--md-blue` */
  colorVar?: string;
  /** 不确定态是否旋转（仅下载进行中、无 percent 时） */
  spinning?: boolean;
}

export function ProgressRing({
  percent = null,
  size = 18,
  stroke = 2.5,
  colorVar = '--md-blue',
  spinning = false,
}: ProgressRingProps) {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);

  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = typeof percent === 'number' && percent > 0 ? Math.min(100, percent) : 0;
  const offset = c * (1 - pct / 100);
  const color = `var(${colorVar})`;
  const doSpin = spinning && reduced === false;
  // 不确定态：画 25% 弧再旋转，给「在动」的信号；否则画满整圈。
  const dash = doSpin && pct === 0 ? `${c * 0.25} ${c}` : c;

  return (
    <>
      <style>{SPIN_KEYFRAMES}</style>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ display: 'block', flex: '0 0 auto' }}
        role="img"
        aria-label={typeof percent === 'number' ? `下载进度 ${Math.round(percent)}%` : '准备中'}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--md-track, rgba(128,128,128,0.22))"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={dash}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className={doSpin && pct === 0 ? 'ui-ring-spin' : undefined}
          style={{
            transformOrigin: 'center',
            transition: reduced ? undefined : 'stroke-dashoffset 0.4s ease',
            opacity: pct === 0 && !doSpin ? 0.5 : 1,
          }}
        />
      </svg>
    </>
  );
}
