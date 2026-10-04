/**
 * 定高虚拟列表（windowed rendering）—— 只渲染视口内的行。
 *
 * 为什么自己写而不是引库：本项目约定「不引入未经确认的新依赖」，而音乐模块所有列表行
 * 都是**定高**（`.music-row` = 40px 封面 + 上下各 6px padding = 52px；`.music-qrow`
 * 显式 52px），定高场景的窗口化只有几十行代码，引 react-window / react-virtual 不划算。
 *
 * 为什么必须虚拟化：一个歌单动辄上千首，全量 DOM 会让首次渲染和滚动都明显卡顿
 * （每行含封面 img，浏览器要维护上千个节点与图片解码任务），而这正是「歌单分页」
 * 想解决的问题的反面 —— 分页只减少了**首屏数据量**，没减少**节点数**。
 *
 * 与分页的配合：`onNearEnd` 在「距底两行」时触发，把下一片的网络耗时藏在滚动里
 * （等价于原先 `scrollTop + clientHeight >= scrollHeight - 60` 的阈值，只是改成按行高算）。
 *
 * 两个容易踩的点，都已在下面处理：
 * 1. **切歌单必须复位滚动**：沿用旧 scrollTop 会显示到新列表的中段（`resetKey`）。
 * 2. **首片撑不满视口时要续拉**：否则用户看到一片空白且永远不会滚动、也就永远不会触发加载。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, UIEvent } from 'react';

/** 与 `.music-row` 几何一致：40px 封面 + 上下各 6px padding */
export const ROW_H = 52;
/** 原 `.music-list { gap: 2px }` 的行间距 —— 虚拟列表用 top 定位复现同样的视觉节奏 */
export const ROW_GAP = 2;

interface VirtualListProps<T> {
  items: T[];
  /** 行 key。带上 index 是刻意的：队列里同一首歌可能出现多次 */
  itemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  itemHeight?: number;
  gap?: number;
  /** 视口上下各多渲染几行，抵消快速滚动时的白屏 */
  overscan?: number;
  /** 滚动接近底部时回调（分页续拉） */
  onNearEnd?: () => void;
  /** 变化即把滚动位置复位到顶（歌单 id / 视图名） */
  resetKey?: string | number;
  className?: string;
}

export function VirtualList<T>({
  items,
  itemKey,
  renderItem,
  itemHeight = ROW_H,
  gap = ROW_GAP,
  overscan = 6,
  onNearEnd,
  resetKey,
  className,
}: VirtualListProps<T>) {
  const outerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const rafRef = useRef<number | null>(null);
  /** onNearEnd 每帧刷新进 ref：调用方通常传内联箭头函数，塞进依赖会让 effect 每渲染都重跑 */
  const nearEndRef = useRef(onNearEnd);
  nearEndRef.current = onNearEnd;
  /** 「首片撑不满视口」的自动续拉按 total 去重，避免同一份内容反复请求 */
  const autoFillAskedRef = useRef(-1);

  const pitch = itemHeight + gap;
  const total = items.length === 0 ? 0 : items.length * itemHeight + (items.length - 1) * gap;

  // 视口高度：容器高度由 flex 布局决定，用 ResizeObserver 比监听 window 准
  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 换歌单 / 换视图复位到顶
  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    el.scrollTop = 0;
    setScrollTop(0);
    autoFillAskedRef.current = -1;
  }, [resetKey]);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  /** 距底两行即视为「快到了」——到底才拉会白等一个 RTT */
  const checkNearEnd = useCallback(
    (el: HTMLDivElement) => {
      const fn = nearEndRef.current;
      if (!fn) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - pitch * 2) fn();
    },
    [pitch],
  );

  // 首片撑不满视口（内容比容器还矮）→ 立刻续拉下一片；否则用户没有滚动机会，分页永远停在第一页
  useEffect(() => {
    const el = outerRef.current;
    if (!el || items.length === 0 || !onNearEnd) return;
    if (total > viewportH) return;
    if (autoFillAskedRef.current === total) return;
    autoFillAskedRef.current = total;
    checkNearEnd(el);
  }, [checkNearEnd, items.length, onNearEnd, total, viewportH]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // rAF 节流：scroll 事件在触控板上触发极密，直接 setState 会把渲染排队
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setScrollTop(el.scrollTop);
      checkNearEnd(el);
    });
  };

  const start = Math.max(0, Math.floor(scrollTop / pitch) - overscan);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewportH) / pitch) + overscan);

  return (
    <div
      ref={outerRef}
      className={className ? `music-vlist ${className}` : 'music-vlist'}
      onScroll={onScroll}
    >
      {/* 撑高元素：让滚动条长度与真实内容一致 */}
      <div className="music-vlist-inner" style={{ height: total }}>
        {items.slice(start, end).map((item, k) => {
          const i = start + k;
          return (
            <div
              key={itemKey(item, i)}
              className="music-vlist-item"
              style={{ top: i * pitch, height: itemHeight }}
            >
              {renderItem(item, i)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
