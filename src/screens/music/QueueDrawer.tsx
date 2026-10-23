import { useState } from 'react';
import { ListEnd, Play, X } from 'lucide-react';
import { useMusicStore } from '@music/store';
import { coverProxyUrl, fmtTime, songKey } from '@music/convert';
import type { Song } from '@music/types';
import { Btn, ContextMenu, MenuItem, SideDrawer, VirtualList, playModeLabel } from '@components/units';
import { Cover } from '@screens/music/shared';

/**
 * 播放队列抽屉（设计稿 `.queue-drawer`，362 宽、左侧 24 圆角）。
 *
 * 容器用通用 `SideDrawer` 单元：宽度 / 圆角 / 阴影 / 蒙层模糊 / 进场曲线都由单元与
 * 这里的 `.queue-drawer` 修饰类给出，本文件只管**队列内容**（设计稿 `.qd-*` 那三层）。
 * 早先这里手写过一套 `.music-drawer` 外壳，与通用抽屉各差一档（348 宽、无圆角、
 * 蒙层不模糊、横穿一屏的进场）—— 同一类容器只能有一个实现。
 *
 * ## 两段式（设计稿 `.qd-section`）
 * 「正在播放」单独一行固定，下面「接下来 · N 首」才是滚动区。旧实现是一条平铺列表 ——
 * 用户得自己在几十行里找"现在播的是哪首"，而这一屏存在的意义恰恰是回答那个问题。
 *
 * ## 行上的右键菜单
 * 与歌曲行走同一套 `ContextMenu` 单元，但**不给 onPlay**：队列行的左键语义是
 * `playSong(s)`（在现有队列里定位），菜单里那一项必须和它一致，所以走兜底路径。
 */
export function QueueDrawer() {
  // 菜单状态必须在组件顶层：renderItem 是回调，放进去会随渲染行数变化破坏 hook 顺序
  const [menu, setMenu] = useState<{ x: number; y: number; song: Song } | null>(null);
  const queueOpen = useMusicStore((s) => s.queueOpen);
  const queue = useMusicStore((s) => s.queue);
  const currentIndex = useMusicStore((s) => s.currentIndex);
  const playMode = useMusicStore((s) => s.playMode);
  const proxyPort = useMusicStore((s) => s.proxyPort);
  const playSong = useMusicStore((s) => s.playSong);
  const playNext = useMusicStore((s) => s.playNext);
  const removeFromQueue = useMusicStore((s) => s.removeFromQueue);
  const clearQueue = useMusicStore((s) => s.clearQueue);
  const setQueueOpen = useMusicStore((s) => s.setQueueOpen);

  if (!queueOpen) return null;

  /** 正在播的那一首与它后面的队列（设计稿两段式的数据切分） */
  const current = currentIndex >= 0 ? (queue[currentIndex] ?? null) : null;
  const upcoming = queue.slice(currentIndex + 1);

  /** 一行队列（正在播放与接下来共用同一套结构，只差高亮） */
  const renderRow = (s: Song, i: number, hot: boolean) => (
    <div
      className={hot ? 'qd-row is-current' : 'qd-row'}
      key={`${songKey(s)}:${i}`}
      onClick={() => void playSong(s)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, song: s });
      }}
    >
      {/* 序号：正在播的那行用 ♪ 代替数字（设计稿 `.qd-index` 的同一个约定） */}
      <span className="qd-index">{hot ? '♪' : i + 1}</span>
      <Cover url={s.cover ? coverProxyUrl(s.cover, proxyPort) : ''} className="qd-cover" />
      <span className="qd-row-meta">
        <strong>{s.name}</strong>
        <small>{s.artist}</small>
      </span>
      {s.duration ? <span className="qd-time">{fmtTime(s.duration)}</span> : null}
      <Btn
        kind="bare"
        className="qd-remove"
        ariaLabel="移除"
        title="移除"
        onClick={(e) => {
          e.stopPropagation();
          removeFromQueue(i);
        }}
      >
        <X size={12} />
      </Btn>
    </div>
  );

  return (
    <>
      <SideDrawer
        drawerClass="queue-drawer"
        title="播放队列"
        subtitle={`${queue.length} 首 · ${playModeLabel(playMode)}`}
        headActions={
          <Btn kind="text" onClick={() => clearQueue()} disabled={queue.length === 0}>
            清空
          </Btn>
        }
        onClose={() => setQueueOpen(false)}
      >
        {current && currentIndex >= 0 ? (
          <div className="qd-section">
            <p className="qd-caption">正在播放</p>
            {renderRow(current, currentIndex, true)}
          </div>
        ) : null}
        <div className="qd-section">
          <p className="qd-caption">接下来 · {upcoming.length} 首</p>
          {upcoming.length ? (
            <VirtualList
              className="is-drawer"
              items={upcoming}
              resetKey="queue-next"
              itemKey={(s, i) => `${songKey(s)}:${i}`}
              renderItem={(s, i) => renderRow(s, currentIndex + 1 + i, false)}
            />
          ) : (
            /* 设计稿的队列空态就是这一行（`.ms-empty`），不是一张居中大卡片 */
            <div className="qd-empty">队列后面没有歌曲了</div>
          )}
        </div>
      </SideDrawer>
      {/* 菜单 portal 到 body —— 队列列表自身是滚动容器，挂在行内会被裁掉 */}
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {(close) => (
            <>
              {/* 队列行不给 onPlay ⇒ 走兜底 playSong(song)，与左键点击"在现有队列里定位"同一语义 */}
              <MenuItem
                icon={<Play size={13} />}
                label="播放"
                onClick={() => {
                  close();
                  void playSong(menu.song);
                }}
              />
              <MenuItem
                icon={<ListEnd size={13} />}
                label="下一首播放"
                onClick={() => {
                  close();
                  playNext(menu.song);
                }}
              />
            </>
          )}
        </ContextMenu>
      ) : null}
    </>
  );
}
