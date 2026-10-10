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

  /**
   * 悬停丢失的修复（用户 2026-10-11 报：「hover 到 tooltip 上它就消失了」）：
   * 气泡悬在宿主上方 6px，指针从宿主挪进气泡必然先触发宿主的 mouseleave。
   * 若宿主离开就立即收，气泡在指针到达前已经被销毁 —— `onMouseEnter={keep}` 永远追不上。
   * 所以「离开」改成**宽限期**：宿主离开起 140ms 后才真正收，指针在这段窗口内进入气泡
   * 就取消收起；气泡自身离开（或宽限内没进气泡）才收。
   * 140ms 取值：跨过 6px 间隙绰绰有余，又不至于让"扫过列表"的收起手感变黏。
   */
  const GRACE_MS = 140;

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
  /** 悬停从宿主挪到气泡上：取消宽限收起（气泡要能选中复制，进气泡 ≠ 离开） */
  const keep = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  /** 宿主 / 聚焦离开：不立即收，先给指针一段时间挪进气泡（见 GRACE_MS 的说明） */
  const scheduleHide = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setPos(null);
    }, GRACE_MS);
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
      onMouseLeave={scheduleHide}
      onFocus={show}
      onBlur={scheduleHide}
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
