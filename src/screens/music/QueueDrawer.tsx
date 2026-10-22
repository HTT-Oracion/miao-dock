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
  const playMode = useMusicStore((s) => s.playMode);
  const playSong = useMusicStore((s) => s.playSong);
  const playNext = useMusicStore((s) => s.playNext);
  const removeFromQueue = useMusicStore((s) => s.removeFromQueue);
  const clearQueue = useMusicStore((s) => s.clearQueue);
  const setQueueOpen = useMusicStore((s) => s.setQueueOpen);

  if (!queueOpen) return null;

  /*
   * 心动模式下队列内容来自 `music_intelligence_list`（相似歌），**不是**用户点开的那个歌单。
   * 标题必须跟着变 —— 否则用户打开抽屉看到的是一批陌生的歌，头顶却写着"播放队列"，
   * 而左栏正停在「我喜欢的音乐」上，两处对不上却没有任何提示（不报错、只表现为"列表莫名其妙换了"）。
   *
   * ⚠️ 这行刻意放在**早退之后**：反证轮里有一条变异要把 useState 挪到早退之后，
   * 它的锚点是从 `menu` 一路连到 `if (!queueOpen) return null` 的**连续代码行** ——
   * 在那段之间插任何东西（注释块也算）都会打断锚点，那条变异就再也打不红
   * （"跳过 ≠ 通过"，反证轮实测）。
   */
  const isHeartbeat = playMode === 'heartbeat';

  /** 正在播的那一首与它后面的队列（设计稿两段式的数据切分） */
  const current = currentIndex >= 0 ? (queue[currentIndex] ?? null) : null;
  const upcoming = queue.slice(currentIndex + 1);

  /** 一行队列（正在播放与接下来共用同一套结构，只差高亮） */
  const renderRow = (s: Song, i: number, hot: boolean) => (
    <div
      className={hot ? 'music-qrow is-hot' : 'music-qrow'}
      onClick={() => void playSong(s)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, song: s });
      }}
    >
      <span className="music-qrow-ix">{hot ? '♪' : i + 1}</span>
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
  );

  return (
    <>
      <div className="music-drawer-bd" onClick={() => setQueueOpen(false)} />
      <div className="music-drawer">
        <div className="music-drawer-hd">
          <ListMusic size={15} className="music-drawer-ic" />
          <span className="music-card-title">{isHeartbeat ? '心动模式' : '播放队列'}</span>
          <span className="music-card-sub">（{queue.length} 首）</span>
          <div className="grow" />
          <IconButton title="清空队列" onClick={() => clearQueue()}>
            <Trash2 size={15} />
          </IconButton>
          <IconButton title="关闭" onClick={() => setQueueOpen(false)}>
            <X size={15} />
          </IconButton>
        </div>

        {/*
          两段式（设计稿 `.qd-section`）：上面「正在播放」单独一行、固定不滚；下面「接下来 · N 首」
          才是滚动区。旧实现是一条平铺列表 —— 用户得自己在几十行里找"现在播的是哪首"，
          而这一屏存在的意义恰恰是回答那个问题。
        */}
        {queue.length === 0 ? (
          <Empty>队列是空的</Empty>
        ) : (
          <>
            {current && currentIndex >= 0 ? (
              <div className="music-qd-section">
                <p className="music-qd-caption">正在播放</p>
                {renderRow(current, currentIndex, true)}
              </div>
            ) : null}
            <div className="music-qd-section is-next">
              <p className="music-qd-caption">接下来 · {upcoming.length} 首</p>
              {upcoming.length ? (
                <VirtualList
                  className="is-drawer"
                  items={upcoming}
                  resetKey="queue-next"
                  itemKey={(s, i) => `${songKey(s)}:${i}`}
                  renderItem={(s, i) => renderRow(s, currentIndex + 1 + i, false)}
                />
              ) : (
                <div className="music-qd-empty">队列后面没有歌曲了</div>
              )}
            </div>
          </>
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
