import { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { Btn } from '@components/units/Btn';

/**
 * 点击展开的命令菜单（通用单元）：触发按钮 + 弹层。
 *
 * 弹层走 Portal 挂到 body、用 fixed 定位 —— 脱离 `.content` 等滚动容器的裁剪，
 * 表格靠下的行也能完整显示。关闭时机：点外部 / Esc / 滚动 / 缩放。
 *
 * ## 两种用法
 *
 * 1. **默认触发器**（传 `label`）：渲染成一枚 `.btn.btn-ghost`，右侧自带 `ChevronDown`。
 *    绝大多数"更多操作"这类按钮走这条。
 * 2. **自定义触发器**（传 `trigger`）：调用方给什么就渲染什么，`MenuButton` 只负责
 *    挂 `aria-haspopup` / `aria-expanded` / `ref` / 点击开合。
 *    用于"触发器本身有独特外观"的场合 —— 比如工具条上的**服务状态胶囊**
 *    （`.svc-pill`：圆点 + 状态文案 + 端口号 + 箭头）。
 *
 * 🔴 第二条是 2026-10-26 补的。此前 `ServicePill` 自己手写了一遍
 *    外部点击 / Esc / 定位 / Portal —— 与这里逐行重复，只是触发器长得不一样。
 *    多写一份的代价不是行数，而是"两套收起逻辑迟早不一致"（比如这处有
 *    `scroll`/`resize` 收起，手写那份就没有）。
 */
export function MenuButton({
  label,
  ariaLabel,
  badge,
  disabled,
  title = '更多操作',
  size,
  trigger,
  menuClass,
  children,
}: {
  /** 默认触发器的文案（与 `trigger` 二选一） */
  label?: string;
  /** 纯图标触发器的无障碍名（可见文案是 ⋯ 这类符号时必填） */
  ariaLabel?: string;
  badge?: string;
  disabled?: boolean;
  title?: string;
  size?: 'sm';
  /**
   * 自定义触发器（与 `label` 二选一）。入参 `open` 供调用方渲染展开态，
   * `toggle` 是开合动作（**要接收事件**，定位靠它拿 `currentTarget`）。
   * 不需要 `ref` —— 于是触发器可以直接用 `Btn` 单元（React 18 下 `Btn` 不是 `forwardRef`）。
   */
  trigger?: (p: { open: boolean; toggle: (e: React.MouseEvent<HTMLElement>) => void }) => ReactElement;
  /** 额外的弹层类名（调用方要加宽 / 改层级时用）；基础类 `ui-menu` 恒定保留 */
  menuClass?: string;
  /** 渲染菜单项；入参 `close` 用于项内点击后收起 */
  children: (close: () => void) => ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      close();
    };
    // Esc 只收菜单，不向上冒泡（否则会连带触发上层的 Esc 行为）
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close, true);
    };
  }, [open]);

  const toggle = (e?: React.MouseEvent<HTMLElement>) => {
    if (!open) {
      /*
       * 定位优先用**事件目标**（`currentTarget`），不依赖 `ref`：
       * 这样自定义触发器可以直接用 `Btn` 之类的单元（React 18 的 `Btn` 不是
       * `forwardRef`，拿不到 ref）。ref 只在"没有事件"时兜底（当前没有这种路径）。
       */
      const el = (e?.currentTarget as HTMLElement | undefined) ?? btnRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        // 右对齐到按钮右缘，避免菜单横向溢出视口
        setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
      }
    }
    setOpen((v) => !v);
  };

  const cls = ['btn', 'btn-ghost', 'ui-menu-btn', size === 'sm' ? 'btn-sm' : ''].filter(Boolean).join(' ');

  return (
    <>
      {trigger ? (
        trigger({ open, toggle })
      ) : (
        <Btn
          kind="bare"
          type="button"
          ref={btnRef}
          className={cls}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
          title={title}
        >
          {label}
          {badge ? <span className="ui-menu-badge">{badge}</span> : null}
          <ChevronDown size={13} />
        </Btn>
      )}
      {open && pos
        ? createPortal(
            <div
              className={menuClass ? `ui-menu ${menuClass}` : 'ui-menu'}
              role="menu"
              ref={popRef}
              style={{ top: pos.top, right: pos.right }}
            >
              {children(() => setOpen(false))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** 菜单项：图标 + 主文案（+ 可选副文案）；`danger` 走红色 hover。 */
export function MenuItem({
  icon,
  label,
  sub,
  danger,
  disabled,
  title,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  sub?: string;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <Btn
      kind="bare"
      type="button"
      className={danger ? 'ui-menu-item is-danger' : 'ui-menu-item'}
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {icon}
      <span className="ui-menu-label">
        {label}
        {sub ? <span className="ui-menu-sub">{sub}</span> : null}
      </span>
    </Btn>
  );
}
