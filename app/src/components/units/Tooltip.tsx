import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';

/**
 * 悬停提示（通用单元）：包裹**单个**元素，悬停 / 聚焦 250ms 后在其上方浮出气泡。
 *
 * ## 为什么自绘而不用原生 `title`
 * 原生 title 由系统渲染，**文字不可选中、不可复制、延迟不受控** —— 漫画名这种
 * "被截断后想看全貌、还想复制走"的场景（本组件的诞生理由），title 等于没做。
 * 气泡内容是普通 DOM，`user-select: text`（见 components.scss 的 `.ui-tooltip`）。
 *
 * ## 为什么走 Portal + fixed
 * 宿主多在滚动容器里（左栏 `.lib-left-list`），absolute 气泡会被 `overflow` 裁掉；
 * 与 MenuButton 的弹层同一套做法：量宿主矩形 → fixed 定位，不受任何祖先裁剪。
 *
 * 为什么延迟 250ms：扫过列表时每个名字都立即冒泡会闪成一片；但也不能长到
 * "悬停了半天以为坏了"。250ms 是桌面 tooltip 的常见手感档。
 */
export function Tooltip({ label, children }: { label: string; children: ReactElement }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const timer = useRef<number | null>(null);

  const show = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const r = hostRef.current?.getBoundingClientRect();
      // 宿主已不在视口（滚动走了）就不冒泡 —— 对着一个看不见的宿主出提示是噪音
      if (r && r.bottom > 0 && r.top < window.innerHeight) {
        setPos({ top: r.top - 6, left: r.left + r.width / 2 });
      }
    }, 250);
  };
  /** 悬停从宿主挪到气泡上：不收（气泡要能选中复制，进气泡 ≠ 离开） */
  const keep = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const hide = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setPos(null);
  };

  // 卸载时清掉定时器（悬停中卸载 ⇒ 定时器回来时宿主已没了，量不到矩形是次要的，泄漏是主要的）
  useEffect(() => hide, []);

  return (
    <span
      ref={hostRef}
      className="ui-tooltip-host"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {pos
        ? createPortal(
            <div
              className="ui-tooltip"
              role="tooltip"
              style={{ top: pos.top, left: pos.left }}
              onMouseEnter={keep}
              onMouseLeave={hide}
            >
              {label}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
