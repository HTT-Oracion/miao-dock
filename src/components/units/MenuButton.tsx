import { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

/**
 * 点击展开的命令菜单（通用单元）：触发按钮 + 弹层。
 *
 * 弹层走 Portal 挂到 body、用 fixed 定位 —— 脱离 `.content` 等滚动容器的裁剪，
 * 表格靠下的行也能完整显示。关闭时机：点外部 / Esc / 滚动 / 缩放。
 */
export function MenuButton({
  label,
  badge,
  disabled,
  title = '更多操作',
  size,
  children,
}: {
  label: string;
  badge?: string;
  disabled?: boolean;
  title?: string;
  size?: 'sm';
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

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      // 右对齐到按钮右缘，避免菜单横向溢出视口
      setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    }
    setOpen((v) => !v);
  };

  const cls = ['btn', 'btn-ghost', 'ui-menu-btn', size === 'sm' ? 'btn-sm' : ''].filter(Boolean).join(' ');

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className={cls}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        title={title}
      >
        {label}
        {badge ? <span className="ui-menu-badge">{badge}</span> : null}
        <ChevronDown size={13} />
      </button>
      {open && pos
        ? createPortal(
            <div className="ui-menu" role="menu" ref={popRef} style={{ top: pos.top, right: pos.right }}>
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
    <button
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
    </button>
  );
}
