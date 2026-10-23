import { ChevronUp, Heart } from 'lucide-react';
import { coverProxyUrl, qualityLabel } from '@music/convert';
import { providerLabel } from '@music/platform';
import { useMusicStore } from '@music/store';
import { Mascot, Btn, IconButton, playModeLabel } from '@components/units';
import { Cover } from '@screens/music/shared';

/**
 * 右栏「正在播放」（设计稿 `.now-card`）。
 *
 * ## 这一块是"信息"，不是"控制台"
 *
 * 设计稿的右栏没有传输控件 —— 上/下一首、播放暂停、进度都在**底部播放条**上。
 * 右栏给的是：眉标 + 封面 + 曲目 + **歌词预览** + 打开播放器 + 四格统计。
 * 旧实现把传输控件与进度条搬到了这里，于是同一件事在屏幕上出现两份，
 * 而"这首歌在唱到哪一句"反而没有地方看。
 *
 * 歌词预览取**当前句起三行**（设计稿 `lines.slice(active, active + 3)`），当前句加粗并带 `♪`。
 * 没有歌词时给固定文案「♪ 纯音乐，请欣赏」，不留空白。
 */
export function NowPlaying() {
  const current = useMusicStore((s) => s.currentSong);
  const queue = useMusicStore((s) => s.queue);
  const likedSongIds = useMusicStore((s) => s.likedSongIds);
  const toggleLike = useMusicStore((s) => s.toggleLike);
  const setExpanded = useMusicStore((s) => s.setExpanded);
  const progressMs = useMusicStore((s) => s.progressMs);
  const lines = useMusicStore((s) => s.parsedLyrics);
  // currentQuality 是**实际播放**的档位（可能与偏好不同：平台不支持会降档），统计要报实的
  const quality = useMusicStore((s) => s.currentQuality);
  const playMode = useMusicStore((s) => s.playMode);
  const playbackSource = useMusicStore((s) => s.playbackSource);
  const proxyPort = useMusicStore((s) => s.proxyPort);

  if (!current) {
    return (
      <div className="now-card">
        {/* 右栏空态（设计稿 `.now-empty`）：插画 + 标题 + 一句引导，底子是那块杏奶→天蓝的柔渐变 */}
        <div className="now-empty">
          <div className="now-empty-art">
            <Mascot mood="sleep" />
          </div>
          <h3>还没有播放</h3>
          <p>从今日精选挑一首歌吧。</p>
        </div>
      </div>
    );
  }

  const liked = likedSongIds.has(current.id);

  // 当前句下标：最后一条 `time <= 当前进度`。进度早于第一句时为 -1，预览从第 0 句开始
  let active = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].time * 1000 <= progressMs) active = i;
    else break;
  }
  const start = Math.max(0, active);
  const preview = lines.slice(start, start + 3);

  return (
    <div className="now-card">
      <div className="now-head">
        <span className="kicker">NOW PLAYING</span>
        <IconButton title="展开播放器" onClick={() => setExpanded(true)}>
          <ChevronUp size={14} />
        </IconButton>
      </div>

      <div className="now-art">
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

      <div className="now-lyrics">
        {preview.length > 0 ? (
          preview.map((l, i) => (
            <div
              key={`${l.time}:${i}`}
              className={i === 0 && active >= 0 ? 'now-lyric-line is-active' : 'now-lyric-line'}
            >
              {l.text}
            </div>
          ))
        ) : (
          <div className="now-lyric-line">♪ 纯音乐，请欣赏</div>
        )}
      </div>

      <div className="now-actions">
        <Btn kind="primary" size="sm" onClick={() => setExpanded(true)}>
          <ChevronUp size={13} />
          打开播放器
        </Btn>
        <IconButton title={liked ? '取消收藏' : '收藏'} active={liked} onClick={() => void toggleLike(current)}>
          <Heart size={14} fill={liked ? 'currentColor' : 'none'} />
        </IconButton>
      </div>

      <div className="now-stats">
        <div className="now-stat">
          <span>音质</span>
          <strong>{qualityLabel(quality)}</strong>
        </div>
        <div className="now-stat">
          <span>播放模式</span>
          <strong>{playModeLabel(playMode)}</strong>
        </div>
        <div className="now-stat">
          <span>来源</span>
          <strong>{providerLabel(playbackSource)}</strong>
        </div>
        <div className="now-stat">
          <span>队列</span>
          <strong>{queue.length} 首</strong>
        </div>
      </div>
    </div>
  );
}
