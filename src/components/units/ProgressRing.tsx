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

/**
 * 不确定态（spinning）的旋转样式。
 *
 * 🔴 **`animation` 必须显式声明**：只有 `@keyframes` 而没有 `animation` 属性，
 *    关键帧永远不会被应用 —— 真机实测 `animationName: "none"`，
 *    于是"不确定态"只剩一圈静止的 25% 弧，与"看得见在动"正好相反。
 *    周期与侧栏下载入口的 `.nav-dl-spin` 同值（1.2s 线性无限）。
 *
 * ⚠️ 说明文字必须留在模板字符串**外面**：CSS 注释里出现反引号会把模板字符串提前闭合（TS1005）。
 */
const SPIN_KEYFRAMES = `
@keyframes ui-ring-spin { to { transform: rotate(360deg); } }
.ui-ring-spin {
  animation: ui-ring-spin 1.2s linear infinite;
}
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
  /**
   * 环半径（px，**画出来的那个半径**）。
   *
   * 🔴 缺省 = `(size - stroke) / 2`（环贴满外框）。但设计稿的 `.ed-ring` 是
   *    **170×170 的画布装 160×160 的 viewBox**（`r=68` / `stroke-width=7` 都按 160 计），
   *    换算到 px 是 `r≈72.25 / stroke≈7.44` ⇒ 环外径 **152**，四周各留 9px 白。
   *    按缺省算会得到 `r=81.5 / 外径 170` —— 环比设计稿大 18px 且贴边。
   *    所以下载页显式给 `radius`，让环的**外径**与设计稿一致。
   */
  radius?: number;
  /** 进度弧色相令牌（`--md-*`）；默认 `--md-blue` */
  colorVar?: string;
  /** 不确定态是否旋转（仅下载进行中、无 percent 时） */
  spinning?: boolean;
}

export function ProgressRing({
  percent = null,
  size = 18,
  stroke = 2.5,
  radius,
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

  const r = radius ?? (size - stroke) / 2;
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
        /*
         * 起点在 12 点：设计稿把 -90° 放在 **svg 整体**上（`.ed-ring { transform: rotate(-90deg) }`）。
         * 🔴 不能挂在 circle 上：不确定态的旋转动画（`.ui-ring-spin` 的 `to { rotate(360deg) }`）
         *    是 CSS transform，会**覆盖** SVG 的 `transform` 属性 ⇒ -90° 丢失、起点跳回 3 点。
         * `overflow: visible` 也照设计稿：hidden 会把 `linecap: round` 的端点削平。
         */
        style={{ display: 'block', flex: '0 0 auto', overflow: 'visible', transform: 'rotate(-90deg)' }}
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
          className={doSpin && pct === 0 ? 'ui-ring-spin' : undefined}
          style={{
            transformOrigin: 'center',
            // 设计稿 `.ed-ring-fill` 是 `stroke-dashoffset .4s var(--ease-out)` —— 走令牌而不是 `ease`
            transition: reduced ? undefined : 'stroke-dashoffset 0.4s var(--miao-ease-out)',
            opacity: pct === 0 && !doSpin ? 0.5 : 1,
          }}
        />
      </svg>
    </>
  );
}
