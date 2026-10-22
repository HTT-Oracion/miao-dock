import { Heart, ListMusic, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { coverProxyUrl, fmtTime } from '@music/convert';
import { useMusicStore } from '@music/store';
import { Cover } from '@screens/music/shared';

/**
 * 右栏「正在播放」（设计稿 `music-now`）。
 *
 * 与底部播放条的分工：播放条只放**控制**，右栏放**上下文** ——
 * 封面、当前曲目、进度、歌词入口、队列入口。设计稿把这两件事分开，
 * 于是切歌时右栏整块换内容、播放条位置不动。
 */
export function NowPlaying() {
  const current = useMusicStore((s) => s.currentSong);
  const queue = useMusicStore((s) => s.queue);
  const isPlaying = useMusicStore((s) => s.isPlaying);
  const togglePlay = useMusicStore((s) => s.togglePlay);
  const next = useMusicStore((s) => s.next);
  const prev = useMusicStore((s) => s.prev);
  const likedSongIds = useMusicStore((s) => s.likedSongIds);
  const toggleLike = useMusicStore((s) => s.toggleLike);
  const setQueueOpen = useMusicStore((s) => s.setQueueOpen);
  const progressMs = useMusicStore((s) => s.progressMs);
  const durationMs = useMusicStore((s) => s.durationMs);
  const proxyPort = useMusicStore((s) => s.proxyPort);

  if (!current) {
    return (
      <div className="now-card">
        <div className="empty is-plain">
          <h3>还没有播放</h3>
          <p>从今日精选挑一首歌吧。</p>
        </div>
      </div>
    );
  }

  const liked = likedSongIds.has(current.id);
  const pct = durationMs > 0 ? Math.min(100, (progressMs / durationMs) * 100) : 0;

  return (
    <div className="now-card">
      <div className="now-cover">
        <Cover url={coverProxyUrl(current.cover, proxyPort)} />
      </div>
      <div className="now-meta">
        <strong className="now-title" title={current.name}>
          {current.name}
        </strong>
        <span className="now-artist" title={current.artist}>
          {current.artist}
        </span>
      </div>

      <div className="now-prog">
        <span className="num">{fmtTime(progressMs)}</span>
        <span className="now-prog-track">
          <i style={{ width: `${pct}%` }} />
        </span>
        <span className="num">{fmtTime(durationMs)}</span>
      </div>

      <div className="now-ctl">
        <button type="button" className="icon-btn" aria-label="上一首" onClick={() => void prev()}>
          <SkipBack size={16} />
        </button>
        <button
          type="button"
          className="now-play"
          aria-label={isPlaying ? '暂停' : '播放'}
          onClick={() => void togglePlay()}
        >
          {isPlaying ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button type="button" className="icon-btn" aria-label="下一首" onClick={() => void next()}>
          <SkipForward size={16} />
        </button>
      </div>

      <div className="now-acts">
        <button
          type="button"
          className={liked ? 'text-btn is-on' : 'text-btn'}
          aria-pressed={liked}
          onClick={() => void toggleLike(current)}
        >
          <Heart size={13} fill={liked ? 'currentColor' : 'none'} />
          {liked ? '已喜欢' : '喜欢'}
        </button>
        <button type="button" className="text-btn" onClick={() => setQueueOpen(true)}>
          <ListMusic size={13} />
          队列{queue.length > 0 ? ` · ${queue.length}` : ''}
        </button>
      </div>
    </div>
  );
}
