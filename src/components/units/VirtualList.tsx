/**
 * 定高虚拟列表（通用单元，windowed rendering）—— 只渲染视口内的行。
 *
 * ## 为什么自己写而不是引库
 * 定高场景的窗口化只有几十行代码，而引 react-window / react-virtual 要新增一层依赖
 * 与一套自己的 API 约定。真需要"不定高 + 自动测量"时再评估引库（届时判据是
 * 《09》§2.2 的"新依赖需负责人确认"）。
 *
 * ## 为什么必须虚拟化
 * 一个歌单动辄上千首，全量 DOM 会让首次渲染和滚动都明显卡顿（每行含封面 img，
 * 浏览器要维护上千个节点与图片解码任务）。而这正是"分页"解决不了的部分 ——
 * **分页只减少首屏数据量，不减少节点数**。
 *
 * ## 与分页的配合
 * `onNearEnd` 在「距底两行」时触发，把下一片的网络耗时藏在滚动里
 * （等价于原先 `scrollTop + clientHeight >= scrollHeight - 60` 的阈值，只是改成按行高算）。
 *
 * ## 两个容易踩的点（都已处理）
 * 1. **换列表必须复位滚动**：沿用旧 scrollTop 会显示到新列表的中段（`resetKey`）。
 * 2. **首片撑不满视口时要续拉**：否则用户看不到滚动条、也就永远不会触发加载，
 *    分页会停在第一页。
 *
 * ## 行高为什么有默认值
 * `ROW_H = 52` 是当前所有调用点的行几何（40px 封面 + 上下各 6px padding）。
 * 行高不是本组件的私事：**调用方的行必须真的是这个高度**，否则滚动会跳
 * —— 换行高时由调用方显式传 `itemHeight`，不要偷偷改默认值。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, UIEvent } from 'react';

/** 默认行高 52：40px 封面 + 上下各 6px padding（与列表行几何一致） */
export const ROW_H = 52;
/** 默认行间距 2 —— 与静态列表的 `gap: 2px` 一致，用 top 定位复现同样的视觉节奏 */
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
  /**
   * 打开时把这一行滚到视口中间（如播放队列定位到"正在播的那首"）。
   *
   * 与 `resetKey` 的关系：`resetKey` 把位置复位到顶，本参数再把位置挪到目标行 ——
   * 两者都作用于滚动位置，所以**必须由本组件统一裁决**（见下面的 useEffect），
   * 不能交给调用方自己在外面 `scrollTop = …`：那样会和复位打架，
   * 表现为"打开抽屉先闪到顶部再跳下来"。
   */
  scrollToIndex?: number;
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
  scrollToIndex,
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

  // 换列表 / 换视图复位到顶；给了 scrollToIndex 则改为定位到目标行。
  // 两件事写在**同一个** layout effect 里，是为了让它们相对顺序确定：
  // 分开写时两个 effect 都会改 scrollTop，谁后跑取决于代码顺序 —— 一个改动的顺序调整
  // 就会让"打开抽屉先闪到顶再跳下来"。这里合成一处，复位即定位，不存在中间态。
  // 用 layout effect（而非 effect）是为了赶在浏览器绘制前定好位置，用户看不到跳动。
  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    autoFillAskedRef.current = -1;

    if (scrollToIndex == null || scrollToIndex < 0) {
      el.scrollTop = 0;
      setScrollTop(0);
      return;
    }

    // 目标行居中：目标行顶边 - (视口高 - 行高) / 2，再夹到合法区间
    const content = items.length === 0 ? 0 : items.length * itemHeight + (items.length - 1) * gap;
    const centered = scrollToIndex * pitch - (el.clientHeight - itemHeight) / 2;
    const maxTop = Math.max(0, content - el.clientHeight);
    const top = Math.max(0, Math.min(centered, maxTop));
    el.scrollTop = top;
    setScrollTop(top);
    // items.length 进依赖：队列在抽屉打开后仍可能变（续拉/删行），
    // 定位要跟着重算，否则"正在播的那行"会跑出视口
  }, [resetKey, scrollToIndex, itemHeight, gap, pitch, items.length]);

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
    <div ref={outerRef} className={className ? `ui-vlist ${className}` : 'ui-vlist'} onScroll={onScroll}>
      {/* 撑高元素：让滚动条长度与真实内容一致 */}
      <div className="ui-vlist-inner" style={{ height: total }}>
        {items.slice(start, end).map((item, k) => {
          const i = start + k;
          return (
            <div key={itemKey(item, i)} className="ui-vlist-item" style={{ top: i * pitch, height: itemHeight }}>
              {renderItem(item, i)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
