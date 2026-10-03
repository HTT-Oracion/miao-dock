import type { CSSProperties, ReactNode } from 'react';
import { QUEUE_EMPTY } from '../theme/tokens';

// ------------------------------------------------------------------ 状态点

/**
 * 状态点 —— 色相的唯一承载处。
 *
 * 《02》§5.2：状态文字一律 `ink`，颜色只由状态点承载；且**颜色不得作为唯一信息载体**，
 * 所以每处用点的位置旁边必然有文字，本组件自身不承担语义。
 */
export function Dot({ colorVar, pulse = false }: { colorVar: string; pulse?: boolean }) {
  return (
    <span
      className={pulse ? 'dot dot-pulse' : 'dot'}
      style={{ background: `var(${colorVar})` }}
      aria-hidden="true"
    />
  );
}

// ------------------------------------------------------------------ 药丸 / 徽章

export function Pill({ children, colorVar }: { children: ReactNode; colorVar?: string }) {
  return (
    <span className="pill">
      <Dot colorVar={colorVar ?? '--md-muted'} pulse={colorVar === '--md-blue'} />
      {children}
    </span>
  );
}

export function Badge({ children }: { children: ReactNode }) {
  return <span className="badge">{children}</span>;
}

// ------------------------------------------------------------------ 按钮

type BtnKind = 'primary' | 'ghost' | 'danger';

export function Btn({
  children,
  kind = 'ghost',
  size,
  onClick,
  disabled,
  title,
  style,
}: {
  children: ReactNode;
  kind?: BtnKind;
  size?: 'sm';
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  style?: CSSProperties;
}) {
  const cls = ['btn', `btn-${kind}`, size === 'sm' ? 'btn-sm' : ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} onClick={onClick} disabled={disabled} title={title} style={style}>
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ 图标

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const IconQueue = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
    <path d="M4 7h16M4 12h16M4 17h9" />
  </svg>
);

export const IconLibrary = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
    <rect x="4" y="4" width="7" height="16" rx="1.6" />
    <rect x="13" y="4" width="7" height="9" rx="1.6" />
    <path d="M13 17h7" />
  </svg>
);

export const IconDrop = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
    <path d="M12 16V5" />
    <path d="M8 9l4-4 4 4" />
    <path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" />
  </svg>
);

export const IconSettings = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
  </svg>
);

export const IconFolder = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
    <path d="M3 7.5A1.5 1.5 0 014.5 6h4l2 2.4h7A1.5 1.5 0 0119 10v7a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 013 17V7.5z" />
  </svg>
);

export const IconRefresh = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" {...stroke}>
    <path d="M20 11a8 8 0 10-2.6 6" />
    <path d="M20 5v6h-6" />
  </svg>
);

// ------------------------------------------------------------------ X-C2 魔法阵

/**
 * 队列空态插画：160×160 魔法阵（《02》§5.3）。
 *
 * 四道同心环（lavender / blue 交替）+ 五芒星（pink）+ 中心星核（yellow），
 * 底轨用 `line-soft`；四色全部取自既有令牌，**不新增令牌**。
 * 旋转 8s linear infinite；`prefers-reduced-motion` 下由 base.css 统一降级为静态。
 */
export function MagicCircle() {
  const s = QUEUE_EMPTY.magicCircle;
  const c = s / 2;
  const rings = [
    { r: 68, color: 'var(--md-lavender)', w: 2, dash: '5 7' },
    { r: 54, color: 'var(--md-blue)', w: 1.6, dash: '3 6' },
    { r: 40, color: 'var(--md-lavender)', w: 1.4, dash: '10 6' },
    { r: 27, color: 'var(--md-blue)', w: 1.2, dash: '2 5' },
  ];
  // 五芒星：5 个顶点按 90° 起、每 72° 一个，连成 {0,2,4,1,3} 的星形折线
  const pts = Array.from({ length: 5 }, (_, i) => {
    const a = (-90 + i * 72) * (Math.PI / 180);
    return [c + 46 * Math.cos(a), c + 46 * Math.sin(a)] as const;
  });
  const star = [0, 2, 4, 1, 3, 0].map((i) => `${pts[i][0].toFixed(1)},${pts[i][1].toFixed(1)}`).join(' ');

  return (
    <svg className="magic" width={s} height={s} viewBox={`0 0 ${s} ${s}`} role="img" aria-label="魔法阵">
      <circle cx={c} cy={c} r={74} fill="none" stroke="var(--md-line-soft)" strokeWidth={1} />
      <g className="magic-spin">
        {rings.map((r) => (
          <circle
            key={r.r}
            cx={c}
            cy={c}
            r={r.r}
            fill="none"
            stroke={r.color}
            strokeWidth={r.w}
            strokeDasharray={r.dash}
            opacity={0.85}
          />
        ))}
        <polygon points={star} fill="none" stroke="var(--md-pink)" strokeWidth={1.8} strokeLinejoin="round" />
        <circle cx={c} cy={c} r={6} fill="var(--md-yellow)" />
        <circle cx={c} cy={c} r={11} fill="none" stroke="var(--md-yellow)" strokeWidth={1.2} opacity={0.6} />
      </g>
    </svg>
  );
}
