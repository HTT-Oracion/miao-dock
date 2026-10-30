import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

/**
 * 按钮（通用单元）—— 全仓**唯一**的按钮实现。
 *
 * 2026-10-26 从 `atoms.tsx` 拆出：`atoms.tsx` 是"最小积木"（状态点 / 药丸 / 徽章 /
 * 魔法阵）的合集，而 `Btn` 有自己的 prop 表面积（权重 / 尺寸 / 6 个 aria / ref 透传）
 * 和 90 行文档 —— 混在里面时，改按钮得先在 200 行里找它。
 * 拆分后 `units/` 的每个文件对应一个组件，桶文件出口不变（调用方一行都不用改）。
 */

export type BtnKind = 'primary' | 'ghost' | 'danger' | 'text' | 'bare';

/**
 * `Btn` 的自有 prop；其余**原生 button 属性一律透传**（`ref` / `type` / `onMouseDown` /
 * `onFocus` / `onBlur` / `aria-controls` / `data-*` …），见下方 `BtnProps`。
 */
export interface BtnOwnProps {
  children?: ReactNode;
  kind?: BtnKind;
  size?: 'sm';
  /** 纯图标按钮的无障碍名（可见文案为空时必填；有文案时不必重复） */
  ariaLabel?: string;
  /** 开关型按钮的按下态（分段控件 / 切换钮）：有它读屏才会说「已按下」 */
  ariaPressed?: boolean;
  /** 折叠型按钮的展开态（"查看完整许可清单"这类）：读屏才会说「已展开 / 已折叠」 */
  ariaExpanded?: boolean;
  /** 导航项的"当前页"标记（设置页左侧分组导航）：读屏才会说「当前页」 */
  ariaCurrent?: 'page' | 'true';
  /**
   * 角色：`tab`（页签组的一枚）/ `option`（列表可选项）/ `menuitem`（弹出菜单的一条）。
   *
   * 🔴 只开放这三个 —— 给按钮挂 `role="button"` 这类语义错配比不挂更糟。
   *    这三个都是"外观是按钮、语义是别的东西"的正当场景。
   */
  role?: 'tab' | 'option' | 'menuitem';
  /** 配合 `role="tab"` / `role="option"` 的选中态 */
  ariaSelected?: boolean;
  /**
   * 弹出层的触发器标记：只给 `aria-expanded` 而不给 `aria-haspopup`，
   * 读屏会念"已展开"但不会说"这是个菜单/对话框"。
   */
  ariaHasPopup?: 'menu' | 'dialog' | 'listbox';
  /** 当前项（翻页器页码 / 已选中的筛选钮）：只加 `is-active`，样式由调用处决定 */
  active?: boolean;
  /** 屏内业务类名；`kind="bare"` 时它是**唯一**的类名 */
  className?: string;
  /** 行内样式（少数位置需要按实测值注入，如侧栏两套几何） */
  style?: CSSProperties;
}

/**
 * `Btn` 的完整 prop：自有 prop + **原生 button 属性**（除被本单元接管的那几个）。
 *
 * 被接管而不透传：`className`（参与权重类名拼接）、`style`（自有窄类型）、
 * `role` / `aria-*`（走窄类型，防止语义错配）、`children`。
 */
export type BtnProps = BtnOwnProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'role' | 'children' | 'style'>;

/**
 * 按钮。
 *
 * 五种**权重**：`primary`（推进）/ `ghost`（中性次按钮）/ `danger`（破坏）/
 * `text`（文字按钮，无底无边、悬停才浮一层底色）/ `bare`（结构件）。
 *
 * `bare` 是**结构件**：整行可点、分组标题、翻页器页码、菜单项、图标钮这类
 * "位置自己就有样式"的点击目标 —— 它只借这个组件保证
 * 「是 `<button type="button">`、有 disabled/title 语义、可挂 ref」，
 * 视觉全部由调用处的类名决定。不给它单开组件：调用方要的是"同一件事的不同权重"。
 *
 * ## 2026-10-26：改成 `forwardRef` + 原生属性透传
 *
 * 全仓把裸 `<button>` 换成 `Btn` 时，那些位置各有各的需要：`MenuButton` 要 `ref`
 * 量位置、图标钮要 `onMouseDown`、模态要 `aria-controls`。
 * 以前这些一律没有 ⇒ 只能写裸 `<button>`，于是"同一件事两套写法"。
 * 现在：自有 prop 之外的**原生 button 属性全部透传**，`ref` 也真的挂到了 DOM 上。
 *
 * ⚠️ `btn-primary` 的文字颜色由样式固定为白色（`components.scss` 的 `.btn-primary`）：
 * 主色底上放深色字会读成"禁用"，而这一档的语义是"推进"。
 */
export const Btn = forwardRef<HTMLButtonElement, BtnProps>(function Btn(
  {
    children,
    kind = 'ghost',
    size,
    ariaLabel,
    ariaPressed,
    ariaExpanded,
    ariaCurrent,
    role,
    ariaSelected,
    ariaHasPopup,
    active,
    className,
    type = 'button',
    ...rest
  },
  ref,
) {
  const cls = [
    kind === 'text' ? 'text-btn' : kind === 'bare' ? '' : 'btn',
    kind === 'text' || kind === 'bare' ? '' : `btn-${kind}`,
    kind !== 'text' && kind !== 'bare' && size === 'sm' ? 'btn-sm' : '',
    active ? 'is-active' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  /*
   * 只把**已定义**的 aria 属性拼进去。
   * 🔴 不能直接写 `aria-label={ariaLabel}`：`ariaLabel` 未传时值是 `undefined`，
   *    而 JSX 里后写的 `undefined` 会把 `...rest` 里调用方给的原生 `aria-label`
   *    一起抹掉 —— 于是"换个组件名"就把无障碍名丢了，且不报错。
   */
  const aria: Record<string, unknown> = {};
  if (ariaLabel !== undefined) aria['aria-label'] = ariaLabel;
  if (ariaPressed !== undefined) aria['aria-pressed'] = ariaPressed;
  if (ariaExpanded !== undefined) aria['aria-expanded'] = ariaExpanded;
  if (ariaCurrent !== undefined) aria['aria-current'] = ariaCurrent;
  if (ariaSelected !== undefined) aria['aria-selected'] = ariaSelected;
  if (ariaHasPopup !== undefined) aria['aria-haspopup'] = ariaHasPopup;

  return (
    <button {...rest} {...aria} ref={ref} type={type} className={cls} role={role}>
      {children}
    </button>
  );
});
