import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { QUEUE_EMPTY } from '@/themes/tokens';

/*
 * 原子件（通用单元）—— 最早沉淀下来的一批"界面最小积木"。
 *
 * 原文件在 `components/atoms.tsx`，2026-10-04 按《09》§2.2 的抽离规则移入 `units/`：
 * 判据是「**不依赖业务数据层**」（不 import store / ipc / types / platform），
 * 与"有多少个调用点"无关 —— 后者是收益，前者才是归属。
 * 本文件不 import 任何业务模块，改动时请守住这一条（有断言盯着）。
 */

// ------------------------------------------------------------------ 状态点

/**
 * 状态点 —— 色相的唯一承载处。
 *
 * 《02》§5.2：状态文字一律 `ink`，颜色只由状态点承载；且**颜色不得作为唯一信息载体**，
 * 所以每处用点的位置旁边必然有文字，本组件自身不承担语义。
 */
export function Dot({ colorVar, pulse = false }: { colorVar: string; pulse?: boolean }) {
  return (
    <span className={pulse ? 'dot dot-pulse' : 'dot'} style={{ background: `var(${colorVar})` }} aria-hidden="true" />
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

type BtnKind = 'primary' | 'ghost' | 'danger' | 'text' | 'bare';

/**
 * 按钮。
 *
 * 四种**权重**：`primary`（推进）/ `ghost`（中性次按钮）/ `danger`（破坏）/
 * `text`（文字按钮，无底无边、悬停才浮一层底色）。
 *
 * 第五种 `bare` 是**结构件**：整行可点、分组标题、翻页器页码这类"位置自己就有样式"
 * 的点击目标 —— 它只借这个组件保证「是 `<button type="button">`、有 disabled/title 语义」，
 * 视觉全部由调用处的类名决定。不给它单开组件：调用方要的是"同一件事的不同权重"，
 * 拆成两个组件反而逼调用方先判"这个算不算按钮"。
 *
 * `active` 给"当前项"语义（翻页器高亮页码、已选中的筛选钮）：只加 `is-active`，
 * 具体长什么样由该处样式决定 —— 单元不预设"选中 = 蓝底"。
 */
export function Btn({
  children,
  kind = 'ghost',
  size,
  onClick,
  onContextMenu,
  disabled,
  title,
  ariaLabel,
  ariaPressed,
  active,
  className,
  style,
}: {
  children: ReactNode;
  kind?: BtnKind;
  size?: 'sm';
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  /**
   * 右键菜单（受控）：给需要"右键出菜单"的按钮用（如漫画库的页卡）。
   * 单元只把事件交出去，**不自己造菜单** —— 菜单内容与归属都是调用方的事。
   */
  onContextMenu?: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  title?: string;
  /** 纯图标按钮的无障碍名（可见文案为空时必填；有文案时不必重复） */
  ariaLabel?: string;
  /** 开关型按钮的按下态（分段控件 / 切换钮）：有它读屏才会说「已按下」 */
  ariaPressed?: boolean;
  /** 当前项（翻页器页码 / 已选中的筛选钮）：只加 `is-active`，样式由调用处决定 */
  active?: boolean;
  /** 屏内业务类名；`kind="bare"` 时它是**唯一**的类名 */
  className?: string;
  style?: CSSProperties;
}) {
  const cls = [
    kind === 'text' ? 'text-btn' : kind === 'bare' ? '' : 'btn',
    kind === 'text' || kind === 'bare' ? '' : `btn-${kind}`,
    kind !== 'text' && kind !== 'bare' && size === 'sm' ? 'btn-sm' : '',
    active ? 'is-active' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={cls}
      onClick={onClick}
      onContextMenu={onContextMenu}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      style={style}
    >
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ X-C2 魔法阵

/**
 * 队列空态插画：160×160 魔法阵（《02》§5.3）。
 *
 * 四道同心环（lavender / blue 交替）+ 五芒星（pink）+ 中心星核（yellow），
 * 底轨用 `line-soft`；四色全部取自既有令牌，**不新增令牌**。
 * 旋转 8s linear infinite；`prefers-reduced-motion` 下由 base.scss 统一降级为静态。
 *
 * 它为什么算"通用单元"而不是业务组件：只读令牌常量、不碰任何业务数据
 * （用途是队列空态，但组件本身对队列一无所知），符合《09》§2.2 的判据。
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
