import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ListEnd, Play } from 'lucide-react';
import { useMusicStore } from '@music/store';
import type { Song } from '@music/types';

/**
 * 歌曲右键菜单（本轮两项：播放 / 下一首播放）。
 *
 * 形态是 `useSongMenu()` 而不是一个"菜单组件"，是因为菜单要被两种宿主复用：
 * `SongRow`（歌曲行）与 `QueueDrawer`（队列行，它有自己的 .music-qrow，不是 SongRow）。
 * 两处各写一份"开/关 + 定位 + 监听"的 state 管理必然走出两套行为，
 * 所以把这套机制收进一个 hook，宿主只负责「什么时候开」和「播放到底是什么」。
 *
 * ## 为什么必须 portal 到 body
 * 所有列表都在 `overflow: auto` 的容器里（`VirtualList` / `music-drawer`），
 * 菜单挂在行内会被父级的 overflow 裁掉 —— 靠底部的行弹出时甚至完全看不见。
 * 挂到 body 后只受视口约束，不与任何滚动容器发生裁剪关系。
 *
 * ## 为什么关闭监听用 `mousedown` + 捕获阶段
 * · 用 `mousedown` 而不是 `click`：click 到达 window 时行的 `onClick` 已经先跑完了
 *   —— 于是"点菜单项"会顺带把这一行也播了（两个动作同时发生，用户只看到歌切了）。
 *   mousedown 先于 click，抢在行的点击之前就能把菜单收掉。
 * · 用捕获阶段（`true`）：菜单项自己的点击若不额外阻断，捕获阶段的 window 监听
 *   同样会先于菜单项看到这次按下 —— 所以菜单项靠 `stopPropagation` 与"点在菜单内不关"
 *   两条一起保证：既不被外部点击误关，也不让外部收到这一下。
 *
 * ## 为什么滚动监听也必须捕获阶段
 * `scroll` 事件**不冒泡**，只在目标元素上派发。列表滚动的是内层容器（`.ui-vlist`），
 * 挂在 window 冒泡阶段的监听永远听不到 → 菜单会停在原地、与内容脱节（视觉上像"飘着"）。
 * 捕获阶段是 window 先收到、再往下派发，这是唯一能听到内层滚动的挂法。
 *
 * ## 为什么「播放」要由宿主给
 * 同一行的"播放"在不同列表里不是一个语义：`LeftPanel` 里是 `playQueue(整个歌单, i)`，
 * `HistoryView` 里是 `playSong(s, undefined, { fromHistory: true })`。
 * 行组件不掌握"这首歌属于哪个列表"，所以宿主传 `onPlay` 就走宿主的语义（与左键点击一致），
 * 没传才退回 `playSong(song)` —— 绝不在这里猜一个"大概对"的语义。
 */

/** 估算尺寸：菜单还没渲染时拿不到真实宽高，用它做边缘翻转的判据（宁可估宽一点，翻早不翻晚） */
const MENU_W = 168;
const MENU_H = 76;

interface MenuState {
  x: number;
  y: number;
  song: Song;
  /** 宿主给的「播放」语义；不传则退回 playSong(song) */
  onPlay?: () => void;
}

export function useSongMenu(): {
  open: (e: ReactMouseEvent, song: Song, onPlay?: () => void) => void;
  node: ReactNode;
} {
  const playSong = useMusicStore((s) => s.playSong);
  const playNext = useMusicStore((s) => s.playNext);
  const [st, setSt] = useState<MenuState | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setSt(null), []);

  const open = useCallback((e: ReactMouseEvent, song: Song, onPlay?: () => void) => {
    // 关掉浏览器/系统自己的右键菜单，否则两层菜单叠在一起
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;
    // 边缘翻转：默认摆在光标右下，右边/下边放不下就翻到左/上摆（夹到 0 防止翻出视口外）
    const px = x + MENU_W > window.innerWidth ? Math.max(0, x - MENU_W) : x;
    const py = y + MENU_H > window.innerHeight ? Math.max(0, y - MENU_H) : y;
    setSt({ x: px, y: py, song, onPlay });
  }, []);

  // 打开期间才挂监听：菜单关着时不占着 window 的三个监听位
  useEffect(() => {
    if (!st) return;
    const onDown = (e: MouseEvent) => {
      const box = boxRef.current;
      if (box && e.target instanceof Node && box.contains(e.target)) return; // 点在菜单内 → 交给菜单项
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onViewChange = () => close();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onViewChange, true);
    window.addEventListener('resize', onViewChange);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onViewChange, true);
      window.removeEventListener('resize', onViewChange);
    };
  }, [st, close]);

  const node = st
    ? createPortal(
        <div
          ref={boxRef}
          className="music-menu"
          style={{ left: st.x, top: st.y }}
          // 菜单自身吃掉右键：在菜单上再点右键不该弹出系统菜单
          onContextMenu={(e) => e.preventDefault()}
          // portal 的事件会沿 **React 树** 冒泡回 SongRow 的 div ——
          // 不在这里截断，点菜单项就等于顺带点了这一行（行 onClick 会播这首歌）
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="music-menu-item"
            onClick={(e) => {
              e.stopPropagation();
              close(); // 先关再执行：动作里可能弹 toast / 换视图，留着菜单会挡住
              if (st.onPlay) st.onPlay();
              else void playSong(st.song);
            }}
          >
            <Play size={13} /> 播放
          </button>
          <button
            type="button"
            className="music-menu-item"
            onClick={(e) => {
              e.stopPropagation();
              close();
              playNext(st.song);
            }}
          >
            <ListEnd size={13} /> 下一首播放
          </button>
        </div>,
        document.body,
      )
    : null;

  return { open, node };
}
