import {
  Aperture,
  AudioWaveform,
  ChevronLeft,
  Disc3,
  Droplets,
  Film,
  Heart,
  Image as ImageIcon,
  ListMusic,
  MonitorSpeaker,
  Palette,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Waves,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { capsOf } from '@music/platform';
import { LYRICS_SIZE, QUALITY_OPTIONS, SKINS, STYLE_PREVIEW_ORDER } from '@music/player-options';
import { coverProxyUrl, fmtTime, lyricIndexAt, songKey, useMusicStore } from '@music/store';
import type { PlayerSkin } from '@music/store';
import type { MusicComment } from '@music/types';
import { ColorPicker, Empty, IconButton, PlayModeButton, Select, Switch } from '@components/units';
import { useCoverColor } from '@hooks/useCoverColor';

/**
 * 允许在 style 里写 CSS 自定义属性（--x）的写法。
 * React.CSSProperties 不含 `--*` 键，直接写会报 TS 错；这里用模板字面量索引签名
 * 精确描述「所有以 -- 开头的字符串键」，既不用 any 糊，也不丢类型检查。
 */
type CSSVarStyle = React.CSSProperties & Record<`--${string}`, string | number>;

/** 「切换样式」触发器上的图标：按当前皮肤换图标（照参考实现 1746–1759 的映射） */
const STYLE_ICON: Record<PlayerSkin, LucideIcon> = {
  glass: Droplets,
  modern: Palette,
  spectrum: AudioWaveform,
  vinyl: Disc3,
  cover: ImageIcon,
  immersive: Waves,
};

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
 *
 * 底部控制栏照参考实现分**左中右三区**（左/右两区绝对定位贴边，中区绝对居中）：
 *  · 左：红心（仅登录）、碟片模式、切换样式（带 NEW 角标）、动态开关（仅「现代」）；
 *  · 中：播放模式 + 上一首/播放暂停/下一首 + 音量（hover 向右展开滑块）；
 *  · 右：歌词高亮色、歌词字号、音质、桌面歌词、播放队列。
 * 采用绝对定位而非 flex 均分，是因为左右两侧控件数量会随皮肤/登录态增减——
 * 只有让中区脱离文档流，两侧怎么变它都还在正中（与参考同款做法）。
 */
export function ExpandedPlayer({ onSeek }: { onSeek: (ms: number) => void }) {
  const expanded = useMusicStore((s) => s.expanded);
  const expandedClosing = useMusicStore((s) => s.expandedClosing);
  const currentSong = useMusicStore((s) => s.currentSong);
  const isPlaying = useMusicStore((s) => s.isPlaying);
  const progressMs = useMusicStore((s) => s.progressMs);
  const durationMs = useMusicStore((s) => s.durationMs);
  const volume = useMusicStore((s) => s.volume);
  const muted = useMusicStore((s) => s.muted);
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
  // ---- 底部右区/左区要用的播放与账号状态 ----
  const playbackQuality = useMusicStore((s) => s.playbackQuality);
  const lyricsWindowOpen = useMusicStore((s) => s.lyricsWindowOpen);
  const queueOpen = useMusicStore((s) => s.queueOpen);
  const loginInfo = useMusicStore((s) => s.loginInfo);
  const likedSongIds = useMusicStore((s) => s.likedSongIds);

  const setSkin = useMusicStore((s) => s.setSkin);
  // 收起走 store 的 closeExpanded（带电）—— 直接 setExpanded(false) 会跳过退场动画
  const closeExpanded = useMusicStore((s) => s.closeExpanded);
  const togglePlay = useMusicStore((s) => s.togglePlay);
  const next = useMusicStore((s) => s.next);
  const prev = useMusicStore((s) => s.prev);
  const cycleMode = useMusicStore((s) => s.cycleMode);
  const setVolume = useMusicStore((s) => s.setVolume);
  const stepVolume = useMusicStore((s) => s.stepVolume);
  const toggleMute = useMusicStore((s) => s.toggleMute);
  const setCommentTab = useMusicStore((s) => s.setCommentTab);
  const loadComments = useMusicStore((s) => s.loadComments);
  const toggleLike = useMusicStore((s) => s.toggleLike);
  const setDiscMode = useMusicStore((s) => s.setDiscMode);
  const setDynamicEnabled = useMusicStore((s) => s.setDynamicEnabled);
  const setLyricsFontSize = useMusicStore((s) => s.setLyricsFontSize);
  const setLyricsHighlightColor = useMusicStore((s) => s.setLyricsHighlightColor);
  const setVinylColorMode = useMusicStore((s) => s.setVinylColorMode);
  const setVinylCustomColor = useMusicStore((s) => s.setVinylCustomColor);
  const setPlaybackQuality = useMusicStore((s) => s.setPlaybackQuality);
  const setLyricsWindowOpen = useMusicStore((s) => s.setLyricsWindowOpen);
  const setQueueOpen = useMusicStore((s) => s.setQueueOpen);

  const [styleMenuOpen, setStyleMenuOpen] = useState(false);
  const activeRef = useRef<HTMLDivElement>(null);
  const loadedKeyRef = useRef('');

  const caps = capsOf(playbackSource);
  const skinMeta = SKINS.find((s) => s.id === skin) ?? SKINS[0];
  const activeLine = lyricIndexAt(parsedLyrics, progressMs / 1000);
  const curKey = currentSong ? songKey(currentSong) : '';

  // ---- 样式分支：哪些控件按皮肤显隐，全在这里判定（见下方各条注释） ----
  const isModern = skin === 'modern';
  const isImmersive = skin === 'immersive';
  const isSpectrum = skin === 'spectrum';
  const isVinyl = skin === 'vinyl';
  const isCover = skin === 'cover';

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

  const isLiked = !!currentSong && likedSongIds.has(currentSong.id);
  const logged = !!loginInfo?.logged_in;
  // 「切换样式」按钮的图标随当前皮肤切换（表里查不到时兜底 Waves）
  const StyleIcon = STYLE_ICON[skin] ?? Waves;

  /**
   * 歌词高亮色控件的当前值。
   * 透明彩胶下它改的其实是**胶片色**（参考实现同款语义联动）：
   * auto 模式显示提取出的封面色，custom 模式显示用户固定色；其余皮肤就是歌词高亮色。
   */
  const highlightValue = isVinyl
    ? vinylColorMode === 'custom'
      ? vinylCustomColor
      : vinylAccent
    : lyricsHighlightColor;

  const onHighlightChange = (c: string) => {
    // 彩胶下选色 = 固定为手动色（置 custom），并同时写进胶片色；其余皮肤只改歌词高亮色
    if (isVinyl) {
      setVinylCustomColor(c);
      setVinylColorMode('custom');
    } else {
      setLyricsHighlightColor(c);
    }
  };

  // 根节点类名：皮肤 + 浅色 + 动态背景 + 碟片模式（暂停时唱片停转）+ 退场中
  const rootClass = [
    'music-exp',
    skinMeta.cls,
    skinMeta.light ? 'is-light' : '',
    dynamicOn ? 'is-dynamic' : '',
    discMode ? 'is-disc' : '',
    // is-paused 只在「碟片模式」下有视觉含义（暂停时停转），且随 isPlaying 实时变化
    discMode && !isPlaying ? 'is-paused' : '',
    // 退场中：由 app.css 的 .music-exp.is-closing 播下滑动画。
    // 组件本身要等 store 延时置 expanded=false 才消失，所以这期间画面还在、动画播得完。
    expandedClosing ? 'is-closing' : '',
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

  const showComments = commentTab === 'comments';
  // 「切换样式」弹层的卡片顺序照参考 STYLE_PREVIEWS：从皮肤表按顺序取元信息
  const styleCards = STYLE_PREVIEW_ORDER.map((id) => SKINS.find((s) => s.id === id)).filter(
    (s): s is (typeof SKINS)[number] => !!s,
  );

  return (
    <div className={rootClass} style={rootStyle}>
      <div className="music-exp-topbar">
        <IconButton title="收起" onClick={() => closeExpanded()}>
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
          {/* ── 左区（绝对贴左）────────────────────────────────────────── */}
          <div className="music-exp-bl">
            {/* 红心：仅登录后显示（未登录点了也写不进去），已红心时填充红色 */}
            {logged ? (
              <IconButton
                title={isLiked ? '取消红心' : '红心'}
                onClick={() => {
                  if (currentSong) void toggleLike(currentSong);
                }}
              >
                <Heart
                  size={20}
                  color={isLiked ? '#e53e3e' : undefined}
                  fill={isLiked ? '#e53e3e' : 'none'}
                />
              </IconButton>
            ) : null}

            {/* 碟片模式：沉浸/音域回响（全屏场景无封面）、透明彩胶（自带胶片）与封面渐染
                （左侧已是满铺封面）下**隐藏** —— 这四种样式里封面本就不是「一张方图」，
                再叠一层碟片模式要么无意义、要么与样式自身的封面处理冲突（彩胶自己就是唱片）。
                只有「现代 / 通透」这种标准方形封面才需要它。 */}
            {!isImmersive && !isSpectrum && !isVinyl && !isCover ? (
              <IconButton
                title={discMode ? '关闭碟片模式' : '开启碟片模式'}
                active={discMode}
                onClick={() => setDiscMode(!discMode)}
              >
                <Film size={18} />
              </IconButton>
            ) : null}

            {/* 切换样式：触发器是**带文字标签的按钮**（不是图标按钮），点击打开图片预览弹层 */}
            <div className="music-exp-stylewrap">
              <button
                type="button"
                className="music-exp-stylebtn"
                title="切换样式"
                onClick={() => setStyleMenuOpen((v) => !v)}
              >
                <StyleIcon size={16} />
                <span>{skinMeta.label}</span>
                <span className="music-exp-new">NEW</span>
              </button>

              {styleMenuOpen ? (
                <>
                  {/* 点弹层外部关闭（铺满一层透明遮罩，避免依赖全局 click 监听） */}
                  <div className="music-style-backdrop" onClick={() => setStyleMenuOpen(false)} />
                  <div className="music-style-pop">
                    {styleCards.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className={s.id === skin ? 'music-style-card is-on' : 'music-style-card'}
                        onClick={() => {
                          // 点击即切换并关闭弹层（不是单击循环切换）
                          setSkin(s.id);
                          setStyleMenuOpen(false);
                        }}
                      >
                        <img className="music-style-thumb" src={s.preview} alt={s.label} />
                        <span className="music-style-lb">{s.label}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>

            {/* 动态开关：仅「现代」样式显示 —— 动态渐变背景目前只有现代/沉浸两套皮肤有，
                但沉浸下背景已由 --vinyl-accent/固定渐变主导，用户可感的可调项只有现代，
                所以入口只在现代出现（参考实现同款条件）。 */}
            {isModern ? (
              <div className="music-exp-dyn">
                <span>动态</span>
                <Switch on={dynamicEnabled} onToggle={() => setDynamicEnabled(!dynamicEnabled)} label="动态背景" />
              </div>
            ) : null}
          </div>

          {/* ── 中区（绝对居中）──────────────────────────────────────── */}
          <div className="music-ctrl">
            <PlayModeButton mode={playMode} onCycle={() => cycleMode()} size={20} />
            <IconButton title="上一首" onClick={() => prev()}>
              <SkipBack size={22} />
            </IconButton>
            <IconButton title={isPlaying ? '暂停' : '播放'} primary onClick={() => togglePlay()}>
              {isPlaying ? <Pause size={20} /> : <Play size={20} />}
            </IconButton>
            <IconButton title="下一首" onClick={() => next()}>
              <SkipForward size={22} />
            </IconButton>
            {/* 音量：图标常显，hover 时右侧展开滑块（宽度/透明度过渡，见 app.css 的 .music-exp-volwrap） */}
            <div
              className="music-exp-volwrap"
              onWheel={(e) => stepVolume(e.deltaY < 0 ? 0.05 : -0.05)}
            >
              <IconButton title={muted ? '取消静音' : '静音'} onClick={() => toggleMute()}>
                {muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
              </IconButton>
              <input
                className="music-exp-vol-slider"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
              />
            </div>
          </div>

          {/* ── 右区（绝对贴右）──────────────────────────────────────── */}
          <div className="music-exp-br">
            {/* 歌词颜色 / 字号在「沉浸 / 音域回响」下隐藏 —— 这两种样式是整屏视觉主导
                （沉浸＝背景随歌流动、音域回响＝频谱），屏上没有传统歌词区可调，
                留着两个调了也看不见的滑块只会让人以为坏了。 */}
            {!isImmersive && !isSpectrum ? (
              <>
                {/* 歌词高亮色：色块形态。透明彩胶下语义联动为「胶片/歌词颜色」（见 onHighlightChange） */}
                <ColorPicker
                  label={isVinyl ? '胶片/歌词颜色' : '歌词高亮颜色'}
                  value={highlightValue}
                  onChange={onHighlightChange}
                />
                {/* 透明彩胶：手动色模式下额外给一个「跟随封面颜色」，一键切回 auto */}
                {isVinyl && vinylColorMode === 'custom' ? (
                  <IconButton title="跟随封面颜色" onClick={() => setVinylColorMode('auto')}>
                    <Aperture size={16} />
                  </IconButton>
                ) : null}
                {/* 歌词字号：文字「A」+ 滑块，范围与步进取自 LYRICS_SIZE（17–48，step 1） */}
                <span className="music-exp-alf">A</span>
                <input
                  className="music-exp-size"
                  type="range"
                  min={LYRICS_SIZE.min}
                  max={LYRICS_SIZE.max}
                  step={LYRICS_SIZE.step}
                  value={lyricsFontSize}
                  onChange={(e) => setLyricsFontSize(Number(e.target.value))}
                  title={`歌词字号: ${lyricsFontSize}px`}
                />
              </>
            ) : null}

            {/* 音质：触发器显示档位文字（同播放条）。setPlaybackQuality 是 async，void 收口 */}
            <Select
              className="music-q-sel"
              label="音质档位"
              value={playbackQuality}
              options={QUALITY_OPTIONS}
              onChange={(v) => void setPlaybackQuality(v)}
            />

            {/* 桌面歌词窗口开关 */}
            <IconButton
              title={lyricsWindowOpen ? '关闭桌面歌词' : '开启桌面歌词'}
              active={lyricsWindowOpen}
              onClick={() => void setLyricsWindowOpen(!lyricsWindowOpen)}
            >
              <MonitorSpeaker size={19} />
            </IconButton>

            {/* 播放队列（已打开时禁用，参考同款） */}
            <IconButton title="播放队列" disabled={queueOpen} onClick={() => setQueueOpen(true)}>
              <ListMusic size={19} />
            </IconButton>
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
    </div>
  );
}
