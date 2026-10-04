import { ListMusic, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2 } from 'lucide-react';
import { fmtTime, qualityLabel, useMusicStore } from '../../music/store';
import { IconButton } from './shared';

/**
 * 底部播放条。
 * 控制组用 `position:absolute; left:50%; translateX(-50%)` 相对整条居中（设计稿明确注的排版），
 * 刻意不用 flex 居中 —— flex 会被左右两侧（封面/歌名、音量）的宽度带偏，两端不等宽时按设计稿就不在正中。
 *
 * onSeek 由 MusicScreen 注入：只改 store.progressMs 不会真的挪动 <audio> 的 currentTime，
 * 必须在同一处把两者一起改。
 *
 * hidden：播放队列为空时整条不渲染。判断写成 prop（而不是让调用方 `{x > 0 ? <PlayerBar/> : null}`）
 * 是为了把「什么时候该出现」这条规则留在组件自己身上，避免以后又多一处调用点各自判断。
 */
export function PlayerBar({ onSeek, hidden }: { onSeek: (ms: number) => void; hidden?: boolean }) {
  const currentSong = useMusicStore((s) => s.currentSong);
  const isPlaying = useMusicStore((s) => s.isPlaying);
  const progressMs = useMusicStore((s) => s.progressMs);
  const durationMs = useMusicStore((s) => s.durationMs);
  const volume = useMusicStore((s) => s.volume);
  const playMode = useMusicStore((s) => s.playMode);
  const currentQuality = useMusicStore((s) => s.currentQuality);

  const togglePlay = useMusicStore((s) => s.togglePlay);
  const next = useMusicStore((s) => s.next);
  const prev = useMusicStore((s) => s.prev);
  const cycleMode = useMusicStore((s) => s.cycleMode);
  const setVolume = useMusicStore((s) => s.setVolume);
  const setQueueOpen = useMusicStore((s) => s.setQueueOpen);
  const setExpanded = useMusicStore((s) => s.setExpanded);

  const modeTitle = playMode === 'one' ? '单曲循环' : playMode === 'shuffle' ? '随机播放' : '列表循环';
  const modeIcon =
    playMode === 'one' ? <Repeat1 size={16} /> : playMode === 'shuffle' ? <Shuffle size={16} /> : <Repeat size={16} />;

  if (hidden) return null;

  return (
    <div className="music-player">
      <div className="music-player-row">
        <div className="music-pb-cover" onClick={() => setExpanded(true)} title="展开播放器">
          {currentSong?.cover ? <img src={currentSong.cover} alt="" /> : null}
        </div>
        <div className="music-pb-tx" onClick={() => setExpanded(true)} title="展开播放器">
          <b>{currentSong?.name ?? '未在播放'}</b>
          <span>{currentSong?.artist ?? '从左侧歌单或搜索结果里选一首'}</span>
        </div>

        {/* 绝对居中的控制组 */}
        <div className="music-ctrl">
          <IconButton title="上一首" onClick={() => prev()}>
            <SkipBack size={17} />
          </IconButton>
          <IconButton title={isPlaying ? '暂停' : '播放'} primary onClick={() => togglePlay()}>
            {isPlaying ? <Pause size={15} /> : <Play size={15} />}
          </IconButton>
          <IconButton title="下一首" onClick={() => next()}>
            <SkipForward size={17} />
          </IconButton>
          <IconButton title={modeTitle} onClick={() => cycleMode()}>
            {modeIcon}
          </IconButton>
          <IconButton title="播放队列" onClick={() => setQueueOpen(true)}>
            <ListMusic size={16} />
          </IconButton>
        </div>

        <div className="music-vol">
          <Volume2 size={13} />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="music-prog">
        <span className="music-prog-t">{fmtTime(progressMs)}</span>
        <input
          type="range"
          className="music-prog-bar"
          min={0}
          max={Math.max(durationMs, 1)}
          step={1000}
          value={Math.min(progressMs, Math.max(durationMs, 1))}
          onChange={(e) => onSeek(Number(e.target.value))}
        />
        <span className="music-prog-t">{fmtTime(durationMs)}</span>
        {currentQuality ? <span className="music-q">{qualityLabel(currentQuality)}</span> : null}
      </div>
    </div>
  );
}
