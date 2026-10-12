import { useState } from 'react';
import { ListEnd, ListMusic, Play, Trash2, X } from 'lucide-react';
import { useMusicStore } from '@music/store';
import { fmtTime, songKey } from '@music/convert';
import type { Song } from '@music/types';
import { ContextMenu, Empty, IconButton, MenuItem, VirtualList } from '@components/units';

/**
 * 播放队列抽屉（右侧 340px）。
 * 当前项用 currentIndex 高亮 —— 不比较歌曲对象：队列里可能有同 id 多次出现的场景，
 * 下标才是「正在播哪一行」的唯一答案。Esc 关闭由 MusicScreen 统一挂（避免每个浮层各挂一个监听）。
 *
 * 行上的右键菜单与歌曲行走同一套通用单元 `ContextMenu`，但**不给 onPlay**：
 * 队列行的左键语义是 `playSong(s)`（不带队列 = 在现有队列里定位），
 * 菜单的「播放」必须和它一致，所以让菜单走兜底的 `playSong(song)`。
 */
export function QueueDrawer() {
  // 菜单状态必须在组件顶层：renderItem 是回调，放进去会随渲染行数变化破坏 hook 顺序
  const [menu, setMenu] = useState<{ x: number; y: number; song: Song } | null>(null);
  const queueOpen = useMusicStore((s) => s.queueOpen);
  const queue = useMusicStore((s) => s.queue);
  const currentIndex = useMusicStore((s) => s.currentIndex);
  const playSong = useMusicStore((s) => s.playSong);
  const playNext = useMusicStore((s) => s.playNext);
  const removeFromQueue = useMusicStore((s) => s.removeFromQueue);
  const clearQueue = useMusicStore((s) => s.clearQueue);
  const setQueueOpen = useMusicStore((s) => s.setQueueOpen);

  if (!queueOpen) return null;

  return (
    <>
      <div className="music-drawer-bd" onClick={() => setQueueOpen(false)} />
      <div className="music-drawer">
        <div className="music-drawer-hd">
          <ListMusic size={15} className="music-drawer-ic" />
          <span className="music-card-title">播放队列</span>
          <span className="music-card-sub">（{queue.length} 首）</span>
          <div className="grow" />
          <IconButton title="清空队列" onClick={() => clearQueue()}>
            <Trash2 size={15} />
          </IconButton>
          <IconButton title="关闭" onClick={() => setQueueOpen(false)}>
            <X size={15} />
          </IconButton>
        </div>

        {queue.length === 0 ? (
          <Empty>队列是空的</Empty>
        ) : (
          <VirtualList
            className="is-drawer"
            items={queue}
            resetKey="queue"
            itemKey={(s, i) => `${songKey(s)}:${i}`}
            renderItem={(s, i) => (
              <div
                className={i === currentIndex ? 'music-qrow is-hot' : 'music-qrow'}
                onClick={() => void playSong(s)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, song: s });
                }}
              >
                <span className="music-qrow-ix">{i === currentIndex ? '♪' : i + 1}</span>
                <div className="music-row-tx">
                  <b>{s.name}</b>
                  <span>{s.artist}</span>
                </div>
                {s.duration ? <span className="music-dur">{fmtTime(s.duration)}</span> : null}
                <IconButton
                  title="从队列移除"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFromQueue(i);
                  }}
                >
                  <X size={13} />
                </IconButton>
              </div>
            )}
          />
        )}
      </div>
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
