import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '@components/units/IconButton';

/**
 * 右侧抽屉（通用浮层）—— 设计稿 `.drawer-layer` + `.drawer-mask` + `.side-drawer`。
 *
 * ## 为什么是抽屉而不是弹窗
 *
 * 设计稿把「运行日志」这类**长内容、边看边操作**的面板放在右侧抽屉：它从右边滑入、
 * 高度吃满窗口，日志能一屏看四十行；居中的弹窗要么被压得很矮，要么遮住正文。
 * 居中弹窗留给"需要用户先决定才能继续"的确认类（退出、删除）。
 *
 * ## 三条行为约定
 *
 * - 遮罩点击 / 关闭按钮 / Esc 都关闭（三个入口缺一个，用户就会觉得"关不掉"）；
 * - 打开时接管 `aria-modal`，关闭即卸载 —— 不做"隐藏但仍在 DOM 里"，
 *   否则读屏仍会念到抽屉内容；
 * - 抽屉自身不持数据、不发请求：内容与动作全部由调用方给，浮层只管壳。
 */
export function SideDrawer({
  open = true,
  kicker,
  title,
  subtitle,
  foot,
  onClose,
  children,
}: {
  /** 缺省即打开：调用方按需挂载（`open ? <SideDrawer/> : null`）时可省略 */
  open?: boolean;
  /** 眉标（设计稿 `.modal-kicker`），如 `LOCAL ENGINE` */
  kicker?: string;
  title: string;
  /** 标题下的一行说明（设计稿 `.side-drawer-head p`） */
  subtitle?: string;
  /** 底部动作区（设计稿 `.modal-foot`），缺省不渲染 */
  foot?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="ui-drawer-layer">
      <div className="ui-drawer-mask" onClick={onClose} />
      <aside className="ui-drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header className="ui-drawer-head">
          <div className="ui-drawer-titles">
            {kicker ? <span className="ui-drawer-kicker">{kicker}</span> : null}
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <IconButton title="关闭" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </header>
        <div className="ui-drawer-body">{children}</div>
        {foot ? <footer className="ui-drawer-foot">{foot}</footer> : null}
      </aside>
    </div>
  );
}
