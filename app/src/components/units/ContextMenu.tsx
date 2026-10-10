import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';

/**
 * 右键菜单（通用单元）：在**光标处**弹出命令菜单，配 `MenuSeparator` 做分组。
 *
 * 与 `MenuButton` 是兄弟而不是父子：MenuButton 的锚是按钮（右对齐、可再点收起），
 * 这里的锚是 `contextmenu` 事件的坐标（左上对齐、只能靠点外部 / Esc / 滚动收起）。
 * 菜单项本身**复用 MenuItem** —— 同一个应用里菜单项长两副面孔，只会让人怀疑点错了地方。
 *
 * ## 为什么坐标由调用方给、组件只做收口
 * "在哪弹"是事件的属性（`clientX/Y`），只有事件处理器知道；组件拿到后只负责
 * 两件通用的事：① **夹进视口**（贴近右缘 / 底缘时不许溢出，量实际尺寸后修正一次）；
 * ② 统一的关闭时机（点外部 / Esc / 滚动 / 缩放 —— 与 MenuButton 同一套手势）。
 */
export function ContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  /** 弹出锚点（`contextmenu` 事件的 `clientX/Y`，视口坐标） */
  x: number;
  y: number;
  onClose: () => void;
  /** 渲染菜单项；入参 `close` 用于项内点击后收起 */
  children: (close: () => void) => ReactElement;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // 首帧先按光标坐标渲染（量尺寸需要它已在 DOM 里），量完再夹进视口
  const [pos, setPos] = useState({ top: y, left: x });

  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      const top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
      const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
      setPos((p) => (p.top === top && p.left === left ? p : { top, left }));
    }
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // Esc 只收菜单，不向上冒泡（否则会连带触发上层的 Esc 行为，与 MenuButton 同纪律）
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose, true);
    };
    // onClose 每次渲染都是新函数，但 effect 只挂监听器与夹位置，重挂是幂等的
  }, [onClose, x, y]);

  return createPortal(
    <div className="ui-menu ui-ctx" role="menu" ref={ref} style={{ top: pos.top, left: pos.left }}>
      {children(onClose)}
    </div>,
    document.body,
  );
}

/** 菜单分组线（`role="separator"`）。菜单项语义上不同组时用它隔开，不要靠空项凑。 */
export function MenuSeparator() {
  return <div className="ui-menu-sep" role="separator" />;
}
