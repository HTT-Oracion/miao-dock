import { useCallback, useEffect, useRef, useState } from 'react';

export interface OverlayThumb {
  /** 滑块高度（px） */
  size: number;
  /** 滑块顶部偏移（px，相对滚动容器可视区） */
  offset: number;
  /** 是否该显示（内容溢出 & 正在滚动/悬停） */
  visible: boolean;
}

/**
 * 覆盖式滚动条：**不占布局宽度**的自绘滑块。
 *
 * ## 为什么不用 `::-webkit-scrollbar`
 * Chromium 的原生滚动条是**占位式**的：设 `width: 6px` 它就吃掉 6px 内容宽度，
 * 设 `width: 0` 则完全看不见。也就是说，"细一点"和"不占宽度"在原生滚动条上不能同时成立。
 * 而覆盖式（macOS 那种浮在内容上的）在 Chromium 里没有对应的 CSS —— 只能自己画。
 *
 * ## 做法
 * 1. 容器保留原生滚动（`overflow: auto`），用 CSS `scrollbar-width: none` +
 *    `::-webkit-scrollbar { display: none }` 把原生条藏掉 —— **滚动能力一点没变**
 *    （滚轮、键盘、触控板、拖选都还是浏览器原生的）；
 * 2. 这个 hook 读 `scrollTop / scrollHeight / clientHeight`，算出滑块的高度与位置；
 * 3. 组件把滑块渲染成容器里的一层 `position: absolute` 元素，因此**不参与内容布局**。
 *
 * ## 淡入淡出
 * 滚动时出现、停止 900ms 后淡出；指针悬停在容器上时保持可见（否则想拖的时候它已经没了）。
 */
export function useOverlayScrollbar() {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<OverlayThumb>({ size: 0, offset: 0, visible: false });
  const hideTimer = useRef<number | null>(null);
  const hovering = useRef(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const overflowing = scrollHeight > clientHeight + 1;
    if (!overflowing) {
      setThumb((t) => (t.visible ? { ...t, visible: false } : t));
      return;
    }
    // 滑块最短 28px：内容极长时也要留一个能抓得住的目标
    const size = Math.max(28, Math.round((clientHeight / scrollHeight) * clientHeight));
    const maxOffset = clientHeight - size;
    const ratio = scrollTop / Math.max(1, scrollHeight - clientHeight);
    const offset = Math.round(maxOffset * ratio);
    setThumb({ size, offset, visible: true });
  }, []);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!hovering.current) setThumb((t) => ({ ...t, visible: false }));
    }, 900);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onScroll = () => {
      measure();
      scheduleHide();
    };
    const onEnter = () => {
      hovering.current = true;
      measure();
    };
    const onLeave = () => {
      hovering.current = false;
      scheduleHide();
    };

    measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('pointerenter', onEnter);
    el.addEventListener('pointerleave', onLeave);

    // 容器尺寸变化（窗口缩放 / 同屏内容变化）时重算滑块
    const ro = new ResizeObserver(measure);
    ro.observe(el);

    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('pointerenter', onEnter);
      el.removeEventListener('pointerleave', onLeave);
      ro.disconnect();
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [measure, scheduleHide]);

  return { ref, thumb };
}
