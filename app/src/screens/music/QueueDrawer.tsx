import { ListMusic, Trash2, X } from 'lucide-react';
import { fmtTime, songKey, useMusicStore } from '../../music/store';
import { VirtualList } from './VirtualList';
import { Empty, IconButton } from './shared';

/**
 * 播放队列抽屉（右侧 340px）。
 * 当前项用 currentIndex 高亮 —— 不比较歌曲对象：队列里可能有同 id 多次出现的场景，
 * 下标才是「正在播哪一行」的唯一答案。Esc 关闭由 MusicScreen 统一挂（避免每个浮层各挂一个监听）。
 */
export function QueueDrawer() {
  const queueOpen = useMusicStore((s) => s.queueOpen);
  const queue = useMusicStore((s) => s.queue);
  const currentIndex = useMusicStore((s) => s.currentIndex);
  const playSong = useMusicStore((s) => s.playSong);
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
    </>
  );
}
