import { ChevronLeft, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { capsOf } from '@music/platform';
import { SKINS } from '@music/player-options';
import { coverProxyUrl, fmtTime, lyricIndexAt, songKey, useMusicStore } from '@music/store';
import type { MusicComment } from '@music/types';
import { Empty, IconButton } from '@components/units';
import { useCoverColor } from '@screens/music/useCoverColor';

/**
 * 允许在 style 里写 CSS 自定义属性（--x）的写法。
 * React.CSSProperties 不含 `--*` 键，直接写会报 TS 错；这里用模板字面量索引签名
 * 精确描述「所有以 -- 开头的字符串键」，既不用 any 糊，也不丢类型检查。
 */
type CSSVarStyle = React.CSSProperties & Record<`--${string}`, string | number>;

function CommentRow({ c }: { c: MusicComment }) {
  return (
    <div className="music-exp-cm">
      <span className="music-ava">{c.avatar ? <img src={c.avatar} alt="" /> : c.nickname?.slice(0, 1)}</span>
      <div className="music-exp-cm-body">
        <div className="music-exp-cm-hd">
          <b>{c.nickname}</b>
          <span>{c.liked_count} 赞</span>
        </div>
        <div className="music-exp-cm-txt">{c.content}</div>
      </div>
    </div>
  );
}

/**
 * 展开播放器（全屏）。
 * 歌词区上下边缘用 mask 渐隐；当前行按 progressMs 定位并滚动到中央。
 * 「歌词 / 评论」Tab：评论只在 `capsOf(playbackSource).comments` 为真（网易云）时出现；
 * 若因为切平台导致评论 Tab 仍处于选中态，正文会兜底显示「当前平台暂不支持评论」，不留白。
 */
export function ExpandedPlayer({ onSeek }: { onSeek: (ms: number) => void }) {
  const expanded = useMusicStore((s) => s.expanded);
  const currentSong = useMusicStore((s) => s.currentSong);
  const isPlaying = useMusicStore((s) => s.isPlaying);
  const progressMs = useMusicStore((s) => s.progressMs);
  const durationMs = useMusicStore((s) => s.durationMs);
  const volume = useMusicStore((s) => s.volume);
  const playMode = useMusicStore((s) => s.playMode);
  const skin = useMusicStore((s) => s.skin);
  const parsedLyrics = useMusicStore((s) => s.parsedLyrics);
  const comments = useMusicStore((s) => s.comments);
  const loadingComments = useMusicStore((s) => s.loadingComments);
  const commentTab = useMusicStore((s) => s.commentTab);
  const playbackSource = useMusicStore((s) => s.playbackSource);
  const proxyPort = useMusicStore((s) => s.proxyPort);
  // ---- 设置页「播放·媒体」里需要在这里落地的偏好 ----
  const dynamicEnabled = useMusicStore((s) => s.dynamicEnabled);
  const discMode = useMusicStore((s) => s.discMode);
  const lyricsFontSize = useMusicStore((s) => s.lyricsFontSize);
  const lyricsHighlightColor = useMusicStore((s) => s.lyricsHighlightColor);
  const vinylColorMode = useMusicStore((s) => s.vinylColorMode);
  const vinylCustomColor = useMusicStore((s) => s.vinylCustomColor);

  const setSkin = useMusicStore((s) => s.setSkin);
  const setExpanded = useMusicStore((s) => s.setExpanded);
  const togglePlay = useMusicStore((s) => s.togglePlay);
  const next = useMusicStore((s) => s.next);
  const prev = useMusicStore((s) => s.prev);
  const cycleMode = useMusicStore((s) => s.cycleMode);
  const setVolume = useMusicStore((s) => s.setVolume);
  const setCommentTab = useMusicStore((s) => s.setCommentTab);
  const loadComments = useMusicStore((s) => s.loadComments);

  const [skinOpen, setSkinOpen] = useState(false);
  const activeRef = useRef<HTMLDivElement>(null);
  const loadedKeyRef = useRef('');

  const caps = capsOf(playbackSource);
  const skinMeta = SKINS.find((s) => s.id === skin) ?? SKINS[0];
  const activeLine = lyricIndexAt(parsedLyrics, progressMs / 1000);
  const curKey = currentSong ? songKey(currentSong) : '';

  // ---- 偏好落地的派生值 ----
  // 动态背景：只有 modern/immersive 两种皮肤有可流动的渐变（见 app.css 的 is-dynamic 说明）
  const dynamicOn = dynamicEnabled && (skin === 'modern' || skin === 'immersive');

  /**
   * 是否真的需要跑封面取色。
   * 只有「透明彩胶」皮肤会消费 --vinyl-accent（app.css：.sk-vinyl .music-exp-cover），
   * 且只有 auto 模式才用它 —— custom 模式直接用用户固定色。
   * 碟片模式（discMode）不加进来：它给封面套的是深色唱片径向渐变，同样不读 --vinyl-accent。
   * 收起了播放器（!expanded）更不必解码：画面根本不存在。
   */
  const needCoverColor = expanded && skin === 'vinyl' && vinylColorMode === 'auto';
  const coverColor = useCoverColor(needCoverColor ? coverProxyUrl(currentSong?.cover ?? '', proxyPort) : '');

  // 彩胶底色：custom 用用户固定色，auto 用本地取到的封面主色（取不到时 hook 已回落默认色）
  const vinylAccent = vinylColorMode === 'custom' ? vinylCustomColor : coverColor.hex;

  // 根节点类名：皮肤 + 浅色 + 动态背景 + 碟片模式（暂停时唱片停转）
  const rootClass = [
    'music-exp',
    skinMeta.cls,
    skinMeta.light ? 'is-light' : '',
    dynamicOn ? 'is-dynamic' : '',
    discMode ? 'is-disc' : '',
    // is-paused 只在「碟片模式」下有视觉含义（暂停时停转），且随 isPlaying 实时变化
    discMode && !isPlaying ? 'is-paused' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // 根节点注入彩胶底色；歌词区注入字号与高亮色（app.css 里 var(--lyr-size/--lyr-hl) 消费）
  const rootStyle: CSSVarStyle = { '--vinyl-accent': vinylAccent };
  const lyricStyle: CSSVarStyle = {
    '--lyr-size': `${lyricsFontSize}px`,
    '--lyr-hl': lyricsHighlightColor,
  };

  // 当前行滚到中间（切歌/进度跳动都跟随；activeRef 只在命中行上挂载）
  useEffect(() => {
    if (!expanded) return;
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeLine, expanded]);

  // 评论懒加载：切到评论 Tab 或评论 Tab 下换歌时，按歌曲拉一次
  useEffect(() => {
    if (!expanded || commentTab !== 'comments' || !caps.comments || !currentSong) return;
    if (loadedKeyRef.current === curKey) return;
    loadedKeyRef.current = curKey;
    void loadComments(currentSong);
  }, [expanded, commentTab, caps.comments, currentSong, curKey, loadComments]);

  if (!expanded) return null;

  const modeIcon =
    playMode === 'one' ? <Repeat1 size={16} /> : playMode === 'shuffle' ? <Shuffle size={16} /> : <Repeat size={16} />;

  const showComments = commentTab === 'comments';

  return (
    <div className={rootClass} style={rootStyle}>
      <div className="music-exp-topbar">
        <IconButton title="收起" onClick={() => setExpanded(false)}>
          <ChevronLeft size={18} />
        </IconButton>
      </div>

      <div className="music-exp-body">
        <div className="music-exp-left">
          <div className="music-exp-cover">
            {currentSong?.cover ? <img src={currentSong.cover} alt="" /> : null}
          </div>
          <div className="music-exp-info">
            <b>{currentSong?.name ?? '未在播放'}</b>
            <span>{currentSong?.artist ?? ''}</span>
            <em>{currentSong?.album || ''}</em>
          </div>
        </div>

        <div className="music-exp-lyrics">
          <div className="music-exp-ltabs">
            <button
              type="button"
              className={showComments ? 'music-exp-ltab' : 'music-exp-ltab is-on'}
              onClick={() => setCommentTab('lyric')}
            >
              歌词
            </button>
            {caps.comments ? (
              <button
                type="button"
                className={showComments ? 'music-exp-ltab is-on' : 'music-exp-ltab'}
                onClick={() => setCommentTab('comments')}
              >
                评论
              </button>
            ) : null}
          </div>

          {!showComments ? (
            parsedLyrics.length === 0 ? (
              <Empty>暂无歌词</Empty>
            ) : (
              <div className="music-exp-lyr-box" style={lyricStyle}>
                {parsedLyrics.map((line, i) => (
                  <div
                    key={i}
                    ref={i === activeLine ? activeRef : undefined}
                    className={i === activeLine ? 'music-lyr-line is-on' : 'music-lyr-line'}
                  >
                    {line.text}
                  </div>
                ))}
              </div>
            )
          ) : !caps.comments ? (
            <Empty>当前平台暂不支持评论</Empty>
          ) : loadingComments ? (
            <Empty>加载评论中…</Empty>
          ) : !comments || (comments.comments.length === 0 && comments.hot_comments.length === 0) ? (
            <Empty>暂无评论</Empty>
          ) : (
            <div className="music-exp-comments">
              {comments.hot_comments.length > 0 ? <div className="music-exp-cm-sec">热门评论</div> : null}
              {comments.hot_comments.map((c) => (
                <CommentRow key={`h${c.comment_id}`} c={c} />
              ))}
              {comments.comments.length > 0 ? <div className="music-exp-cm-sec">最新评论</div> : null}
              {comments.comments.map((c) => (
                <CommentRow key={`n${c.comment_id}`} c={c} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="music-exp-bottom">
        <div className="music-exp-brow">
          <div className="music-exp-l">
            <button type="button" className="music-exp-chip" onClick={() => setSkinOpen((v) => !v)}>
              皮肤：{skinMeta.label}
            </button>
          </div>
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
            <IconButton title="播放模式" onClick={() => cycleMode()}>
              {modeIcon}
            </IconButton>
          </div>
          <div className="music-exp-vol">
            <Volume2 size={15} />
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
        </div>
      </div>

      {skinOpen ? (
        <div className="music-skin-picker">
          <div className="music-skin-hd">选择皮肤</div>
          <div className="music-skins">
            {SKINS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={skin === s.id ? 'music-skin is-on' : 'music-skin'}
                onClick={() => {
                  setSkin(s.id);
                  setSkinOpen(false);
                }}
              >
                <span className={`music-skin-thumb ${s.cls}`} />
                <span className="music-skin-lb">{s.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
