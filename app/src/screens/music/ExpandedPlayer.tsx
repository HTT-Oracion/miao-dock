import {
  Aperture,
  AudioWaveform,
  ChevronDown,
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
import { useEffect, useMemo, useRef, useState } from 'react';
import { capsOf } from '@music/platform';
import { LYRICS_SIZE, QUALITY_OPTIONS, SKINS, STYLE_PREVIEW_ORDER } from '@music/player-options';
import { useMusicStore } from '@music/store';
import { canUseHeartbeat } from '@music/actions/playback';
import { coverProxyUrl, fmtTime, songKey } from '@music/convert';
import type { PlayerSkin } from '@music/store';
import type { MusicComment } from '@music/types';
import { ColorPicker, Empty, IconButton, PlayModeButton, Select, Switch } from '@components/units';
// 六皮肤的封面取色基础设施（useCoverColor / useCoverEdgeColor / makeVividColor）。
// 注意：按本项目 D-41 收口，use* 命名的文件必须住 src/hooks/，故该模块文件名为 coverColor.ts。
import { makeVividColor, useCoverColor, useCoverEdgeColor } from '@hooks/useCoverColor';
import { SpectrumScene } from '@screens/music/SpectrumScene';
import { VinylDisc } from '@screens/music/VinylDisc';
// 逐字歌词渲染组件（双层叠加 + RAF 推进）。歌词的"定位当前行 / 滚动跟随 / 逐字进度"
// 全部由它内部承担 —— 所以本文件不再自己算 activeLine、不再持有 activeRef。
import { KaraokeLyrics } from '@screens/music/KaraokeLyrics';

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
 * 展开播放器（全屏）。六皮肤**各自的背景 / 文字色 / 专属视觉分支**都在这一个组件里落地。
 *
 * ## 为什么背景与文字色用 JS 算、用 CSS 变量注入，而不是写死在 app.css
 *
 * 参考实现里「现代 / 沉浸 / 封面渐染 / 透明彩胶」的背景与文字色**都由封面派生**：
 * 现代 = 封面主色 + 其 0.25 暗色；沉浸 = 封面主色映射到柔和色板；封面渐染 = 封面**右缘**主色；
 * 彩胶 = 封面主色经 HSV 钳制。封面色**运行时才知道**，CSS 里表达不了 ——
 * 所以必须由组件算出一组 `--skin-*` / `--vinyl-accent` / `--lyr-*` 变量注入根节点，
 * CSS 只负责消费。`.sk-*` 类名退化为"结构性差异"的表达（哪些元素隐藏/变形/换成专属组件）。
 *
 * ## 只有「通透」用毛玻璃
 *
 * 参考实现里 `backdropFilter` 仅通透取 `blur(20px)`，其余五种一律 `none`
 * —— 因为毛玻璃会把背后内容糊掉，只有"半透明浅底"的通透需要它来降噪；
 * 给不透明背景加 blur 既无效果又白耗一次合成。本实现用 `--skin-blur` 表达，只有 glass 分支给它值。
 *
 * 歌词区上下边缘用 mask 渐隐；「歌词 / 评论」Tab 只在「现代 / 通透」出现。
 *
 * 底部控制栏分**左中右三区**（左/右两区绝对定位贴边，中区绝对居中）：
 *  · 左：红心（仅登录）、碟片模式、切换样式（带 NEW 角标）、动态开关（仅「现代」）；
 *  · 中：播放模式 + 上一首/播放暂停/下一首 + 音量（hover 向右展开滑块）；
 *  · 右：歌词高亮色、歌词字号、音质、桌面歌词、播放队列。
 * 采用绝对定位而非 flex 均分，是因为左右两侧控件数量会随皮肤/登录态增减 ——
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
  // 心动模式是否可用（判据只有一个出口：store 的 canUseHeartbeat）。
  // 不可用时模式按钮**不显示**心动档，而不是显示一个点不动的假控件。
  const heartbeatAvailable = useMusicStore((s) =>
    canUseHeartbeat({ playbackSource: s.playbackSource, queueFromLiked: s.queueFromLiked }),
  );
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
  const loadedKeyRef = useRef('');

  const caps = capsOf(playbackSource);
  const skinMeta = SKINS.find((s) => s.id === skin) ?? SKINS[0];
  const curKey = currentSong ? songKey(currentSong) : '';

  // ---- 样式分支：哪些控件按皮肤显隐、哪些布局分支走哪条，全在这里判定 ----
  const isModern = skin === 'modern';
  const isImmersive = skin === 'immersive';
  const isSpectrum = skin === 'spectrum';
  const isVinyl = skin === 'vinyl';
  const isCover = skin === 'cover';
  // 「现代 / 通透」保留标准"左封面 + 右歌词 Tab"布局；其余四种各自走专属布局
  const isPlainLayout = !isImmersive && !isSpectrum && !isVinyl && !isCover;

  // ---- 偏好落地的派生值 ----
  // 动态背景：只有 modern/immersive 两种皮肤有可流动的渐变（见 app.css 的 is-dynamic 说明）
  const dynamicOn = dynamicEnabled && (skin === 'modern' || skin === 'immersive');

  /**
   * 封面 URL（走本地音频代理，带 CORS 头，画布可读）。
   * 显示与取色共用同一个 URL —— 与参考实现一致（它显示/取色都走 coverProxyUrl）。
   */
  const coverUrl = currentSong?.cover ? coverProxyUrl(currentSong.cover, proxyPort) : '';

  /**
   * 是否真的需要跑封面取色。
   * 只有会消费封面色/右缘色的皮肤才解码：现代/沉浸/彩胶用主色，封面渐染用右缘色，音域回响用主色派生冷暖双色。
   * 通透（半透明浅底，纯主题色）与收起的播放器都不必解码。
   */
  const needsCoverColor = expanded && (isModern || isImmersive || isVinyl || isCover || isSpectrum);
  const coverColor = useCoverColor(needsCoverColor ? coverUrl : '');
  // 封面渐染专用：只有该皮肤才有必要取"右缘主色"（取不到时 hook 已回落默认色）
  const edgeColor = useCoverEdgeColor(expanded && isCover && coverUrl ? coverUrl : '');

  // 沉浸柔和色板：把封面色相映射到固定深色板，供沉浸背景 + 音域回响冷暖双色共用
  const vivid = useMemo(
    () => makeVividColor(coverColor.rgb[0], coverColor.rgb[1], coverColor.rgb[2]),
    [coverColor.rgb],
  );

  // 彩胶底色：custom 用用户固定色，auto 用本地取到的封面主色（取不到时 hook 已回落默认色）
  const vinylAccent = vinylColorMode === 'custom' ? vinylCustomColor : coverColor.hex;

  /**
   * 进度条 / 音量条的「已调节段」填充百分比（0~100），注入 CSS 变量 `--fill`。
   * 渐变写在 `.music-prog-bar` / `.music-exp-vol-slider`（见 music.scss）：
   * 已调节段取高亮色，未调节段保持原轨道色（各皮肤只覆盖 `--track-c`）。
   * 除数与两个 input 的 `max` 同口径，避免填充比例与滑块位置对不上。
   */
  const progFill = Math.max(
    0,
    Math.min(100, (Math.min(progressMs, Math.max(durationMs, 1)) / Math.max(durationMs, 1)) * 100),
  );
  const volFill = Math.max(0, Math.min(100, volume * 100));

  /**
   * 歌词高亮色控件的当前值。
   * 透明彩胶下它改的其实是**胶片色**（参考实现同款语义联动）：
   * auto 模式显示提取出的封面色，custom 模式显示用户固定色；其余皮肤就是歌词高亮色。
   */
  const highlightValue = isVinyl ? vinylAccent : lyricsHighlightColor;

  const onHighlightChange = (c: string) => {
    // 彩胶下选色 = 固定为手动色（置 custom），并同时写进胶片色；其余皮肤只改歌词高亮色
    if (isVinyl) {
      setVinylCustomColor(c);
      setVinylColorMode('custom');
    } else {
      setLyricsHighlightColor(c);
    }
  };

  // ---- 每套皮肤的「背景 / 文字 / 悬停 / 毛玻璃」派生（全部依赖封面，故在 JS 里算） ----
  const [cr, cg, cb] = coverColor.rgb;
  // 现代：封面主色 + 其 0.25 暗色拼斜向渐变；开「动态」时改成 45° 三段渐变交给 CSS 平移流动
  const modernSolid = coverColor.hex;
  const modernDark = `rgb(${Math.round(cr * 0.25)},${Math.round(cg * 0.25)},${Math.round(cb * 0.25)})`;
  const modernBg = dynamicEnabled
    ? `linear-gradient(45deg, ${modernSolid}, ${modernDark}, ${modernSolid})`
    : `linear-gradient(135deg, ${modernSolid} 0%, ${modernSolid} 40%, ${modernDark} 100%)`;
  // 现代/封面渐染的文字色按封面明暗二选一；音域回响固定亮色；彩胶固定深灰
  const onLightText = '#1a1a2e';
  const onLightSub = '#4a4a5e';
  const onLightHover = 'rgba(0,0,0,0.06)';
  const onDarkText = '#f0f0f0';
  const onDarkSub = '#b0b0b0';
  const onDarkHover = 'rgba(255,255,255,0.12)';
  const modernText = coverColor.isLight ? onLightText : onDarkText;
  const modernSub = coverColor.isLight ? onLightSub : onDarkSub;
  const modernHover = coverColor.isLight ? onLightHover : onDarkHover;
  // 沉浸：封面色相 → 柔和色板的「左深右浅」三段渐变
  const immersiveBg = `linear-gradient(90deg, ${vivid.deep} 0%, ${vivid.hex} 50%, ${vivid.light} 100%)`;
  // 封面渐染：右侧背景 = 封面右缘主色；文字色按右缘色的明暗二选一
  const coverBg = coverUrl ? edgeColor.hex : modernBg;
  const coverText = edgeColor.isLight ? onLightText : onDarkText;
  const coverSub = edgeColor.isLight ? onLightSub : onDarkSub;
  const coverHover = edgeColor.isLight ? onLightHover : onDarkHover;

  let skinBg: string;
  let skinText: string;
  let skinSub: string;
  let skinHover: string;
  let skinBlur = 'none';
  // 歌词正文色（未高亮那几行）：默认跟随皮肤文字色，彩胶用参考实现的中性深灰
  let lyrText = '#f0f0f0';
  switch (skin) {
    case 'glass':
      // 通透：唯一用毛玻璃的皮肤（半透明白 + blur(20px)），文字取主题深色
      skinBg = 'rgba(255,255,255,0.25)';
      skinText = 'var(--md-ink)';
      skinSub = 'rgba(59,51,82,0.7)';
      skinHover = 'rgba(59,51,82,0.1)';
      skinBlur = 'blur(20px)';
      lyrText = 'var(--md-ink)';
      break;
    case 'modern':
      skinBg = modernBg;
      skinText = modernText;
      skinSub = modernSub;
      skinHover = modernHover;
      lyrText = modernText;
      break;
    case 'immersive':
      skinBg = immersiveBg;
      skinText = onDarkText;
      skinSub = 'rgba(255,255,255,0.72)';
      skinHover = onDarkHover;
      lyrText = onDarkText;
      break;
    case 'spectrum':
      // 音域回响：近黑底（频谱场景自带底色，这里兜底同色）
      skinBg = '#05070c';
      skinText = onDarkText;
      skinSub = 'rgba(255,255,255,0.6)';
      skinHover = onDarkHover;
      lyrText = onDarkText;
      break;
    case 'vinyl':
      // 透明彩胶：浅灰胶底 + 固定深灰字（胶片色只作强调，不改文字色）
      skinBg = 'linear-gradient(160deg, #dfdfe2 0%, #d8d8dc 55%, #d1d1d6 100%)';
      skinText = '#333338';
      skinSub = 'rgba(51,51,56,0.55)';
      skinHover = 'rgba(0,0,0,0.07)';
      lyrText = '#45454c';
      break;
    case 'cover':
    default:
      skinBg = coverBg;
      skinText = coverText;
      skinSub = coverSub;
      skinHover = coverHover;
      lyrText = coverText;
      break;
  }

  // 浅色皮肤（图标/控件要翻深色）：通透、彩胶恒定；现代/封面渐染跟随封面明暗
  const skinIsLight = isModern ? coverColor.isLight : isCover ? edgeColor.isLight : !!skinMeta.light;

  // 封面渐染的上下压暗/提亮罩色，保证悬浮图标可读（浅缘配白雾、深缘配黑雾）
  const coverScrim = edgeColor.isLight ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.32)';

  const isLiked = !!currentSong && likedSongIds.has(currentSong.id);
  const logged = !!loginInfo?.logged_in;
  // 「切换样式」按钮的图标随当前皮肤切换（表里查不到时兜底 Waves）
  const StyleIcon = STYLE_ICON[skin] ?? Waves;

  // 根节点类名：皮肤 + 浅色 + 动态背景 + 碟片模式（暂停时唱片停转）+ 退场中
  const rootClass = [
    'music-exp',
    skinMeta.cls,
    skinIsLight ? 'is-light' : '',
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

  // 主体容器类名：给四种专属布局各自的微调钩子（隐藏左封面 / 歌词占满 / 侧栏宽度）
  const bodyClass = [
    'music-exp-body',
    isImmersive ? 'is-immersive' : '',
    isSpectrum ? 'is-spectrum' : '',
    isVinyl ? 'is-vinyl' : '',
    isCover ? 'is-cover' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // 根节点注入：六皮肤变量 + 彩胶底色 + 歌词字号/高亮色。
  // 说明（重要）：这些值都依赖封面（运行时才知道），写死在 CSS 里做不到，故由 JS 注入。
  // 歌词两项（--lyr-size / --lyr-hl）仍**由本文件注入**（挂在 .music-exp 根上，靠继承传到歌词行）：
  // 这是设置页「播放·媒体」断言的既定契约（注入必须落在被 style={…} 消费的对象上），
  // 逐字组件只负责按 var(--lyr-*) 渲染，不再自己重复注入，避免两个 owner。
  const rootStyle: CSSVarStyle = {
    '--vinyl-accent': vinylAccent,
    '--skin-bg': skinBg,
    '--skin-text': skinText,
    '--skin-sub': skinSub,
    '--skin-hover': skinHover,
    '--skin-blur': skinBlur,
    '--lyr-text': lyrText,
    '--lyr-size': `${lyricsFontSize}px`,
    '--lyr-hl': highlightValue,
  };

  // 评论懒加载：切到评论 Tab 或评论 Tab 下换歌时，按歌曲拉一次
  useEffect(() => {
    if (!expanded || commentTab !== 'comments' || !caps.comments || !currentSong) return;
    if (loadedKeyRef.current === curKey) return;
    loadedKeyRef.current = curKey;
    void loadComments(currentSong);
  }, [expanded, commentTab, caps.comments, currentSong, curKey, loadComments]);

  if (!expanded) return null;

  // 评论 Tab 只在「现代 / 通透」有意义（其余四种皮肤没有传统歌词面板）
  const showTabs = isPlainLayout;
  const showComments = showTabs && commentTab === 'comments';
  // 「切换样式」弹层的卡片顺序照参考 STYLE_PREVIEWS：从皮肤表按顺序取元信息
  const styleCards = STYLE_PREVIEW_ORDER.map((id) => SKINS.find((s) => s.id === id)).filter(
    (s): s is (typeof SKINS)[number] => !!s,
  );

  return (
    <div className={rootClass} style={rootStyle}>
      {/* ── 全屏场景层（z=1）：各皮肤专属视觉，铺在顶栏/控制栏之下 ───────── */}
      {/* 沉浸：多层径向扩散的波纹（简化版，纯 CSS 动画） */}
      {isImmersive ? (
        <div className="skin-ripple-layer" style={{ '--ripple-c': vivid.deep } as CSSVarStyle} aria-hidden>
          <span className="skin-ripple" />
          <span className="skin-ripple" />
          <span className="skin-ripple" />
        </div>
      ) : null}
      {/* 透明彩胶：右上角伸出的旋转唱片（暂停即停转） */}
      {isVinyl ? <VinylDisc isPlaying={isPlaying} accentColor={vinylAccent} coverUrl={coverUrl} /> : null}
      {/* 封面渐染：左侧满铺封面原图（伸到顶/底栏下方），右缘羽化融入右缘主色背景 */}
      {isCover && coverUrl ? (
        <div className="skin-cover-bleed" aria-hidden>
          <img src={coverUrl} alt="" draggable={false} />
          <div
            className="skin-cover-scrim skin-cover-scrim-top"
            style={{ background: `linear-gradient(180deg, ${coverScrim} 0%, transparent 100%)` }}
          />
          <div
            className="skin-cover-scrim skin-cover-scrim-bottom"
            style={{ background: `linear-gradient(0deg, ${coverScrim} 0%, transparent 100%)` }}
          />
        </div>
      ) : null}
      {/* 音域回响：全屏频谱场景（真实频谱，取不到音频图时降级为 CSS 动画）。
          非该皮肤时组件内部直接 return null，不渲染也不跑 RAF。 */}
      <SpectrumScene active={isSpectrum} isPlaying={isPlaying} deep={vivid.deep} light={vivid.light} />

      <div className="music-exp-topbar">
        <IconButton title="收起" onClick={() => closeExpanded()}>
          {/*
            收起用 ChevronDown（向下）而不是 ChevronLeft —— 展开播放器是从**底部上滑**铺满的，
            "收起"对应的是**向下**退回去；向左的箭头会让人以为"返回上一页"。
            与参考实现的形态也一致（`ChevronDown size={24}`）。
          */}
          <ChevronDown size={22} />
        </IconButton>
      </div>

      <div className={bodyClass}>
        {/* 左侧封面区：只有「现代 / 通透」保留标准方图（其余四种的封面各有专属呈现） */}
        {isPlainLayout ? (
          <div className="music-exp-left">
            <div className="music-exp-cover">{coverUrl ? <img src={coverUrl} alt="" /> : null}</div>
            <div className="music-exp-info">
              <b>{currentSong?.name ?? '未在播放'}</b>
              <span>{currentSong?.artist ?? ''}</span>
              <em>{currentSong?.album || ''}</em>
            </div>
          </div>
        ) : null}

        {/* 歌词 / 评论面板：音域回响时不渲染（该皮肤整屏是频谱，参考实现同样不显示歌词） */}
        {!isSpectrum ? (
          <div className="music-exp-lyrics">
            {/* 彩胶 / 封面渐染：左上角歌名 + 歌手（参考实现同款），压在封面羽化区/胶片之上 */}
            {isVinyl || isCover ? (
              <div className="music-exp-title">
                <b>{currentSong?.name ?? ''}</b>
                <span>{currentSong?.artist ?? ''}</span>
              </div>
            ) : null}

            {/* Tab 只在「现代 / 通透」出现 */}
            {showTabs ? (
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
            ) : null}

            {showComments ? (
              !caps.comments ? (
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
              )
            ) : parsedLyrics.length === 0 ? (
              <Empty>暂无歌词</Empty>
            ) : (
              <>
                {/* 逐字歌词：组件自己承担"定位当前行 / 滚动跟随 / RAF 逐字推进"，
                    并复用 .music-exp-lyr-box 的上下 edge mask 与 .music-lyr-line 的字号/暗色语汇。
                    字号/高亮色经根节点注入的 --lyr-size / --lyr-hl 继承进来，故无需再传。
                    align：彩胶/封面渐染左对齐（参考实现同款），其余居中。
                    headerLine：「演唱: {artist}」作为歌词流**第 0 帧**渲染在同一个滚动容器内
                    （此前是容器外的固定 div，不随歌词滚动）；作词/作曲/编曲各平台数据不全故不做。 */}
                <KaraokeLyrics
                  lines={parsedLyrics}
                  fontPx={lyricsFontSize}
                  align={isVinyl || isCover ? 'left' : 'center'}
                  showTranslation
                  headerLine={currentSong?.artist ? `演唱：${currentSong.artist}` : undefined}
                />
              </>
            )}
          </div>
        ) : null}
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
                <Heart size={20} color={isLiked ? '#e53e3e' : undefined} fill={isLiked ? '#e53e3e' : 'none'} />
              </IconButton>
            ) : null}

            {/* 碟片模式：沉浸/音域回响（全屏场景无封面）、透明彩胶（自带胶片）与封面渐染
                （左侧已是满铺封面）下**隐藏** —— 这四种样式里封面本就不是「一张方图」，
                再叠一层碟片模式要么无意义、要么与样式自身的封面处理冲突（彩胶自己就是唱片）。
                只有「现代 / 通透」这种标准方形封面才需要它。 */}
            {isPlainLayout ? (
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
                但沉浸下背景已由柔和色板主导，用户可感的可调项只有现代，所以入口只在现代出现。 */}
            {isModern ? (
              <div className="music-exp-dyn">
                <span>动态</span>
                <Switch on={dynamicEnabled} onToggle={() => setDynamicEnabled(!dynamicEnabled)} label="动态背景" />
              </div>
            ) : null}
          </div>

          {/* ── 中区（绝对居中）──────────────────────────────────────── */}
          <div className="music-ctrl">
            <PlayModeButton
              mode={playMode}
              onCycle={() => cycleMode()}
              size={20}
              heartbeatAvailable={heartbeatAvailable}
            />
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
            <div className="music-exp-volwrap" onWheel={(e) => stepVolume(e.deltaY < 0 ? 0.05 : -0.05)}>
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
                style={{ '--fill': `${volFill.toFixed(2)}%` } as CSSVarStyle}
                onChange={(e) => setVolume(Number(e.target.value))}
              />
            </div>
          </div>

          {/* ── 右区（绝对贴右）──────────────────────────────────────── */}
          <div className="music-exp-br">
            {/* 歌词颜色 / 字号在「沉浸 / 音域回响」下隐藏 —— 这两种样式是整屏视觉主导
                （沉浸＝文字放大居中、音域回响＝频谱），屏上没有传统歌词区可调，
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
            style={{ '--fill': `${progFill.toFixed(2)}%` } as CSSVarStyle}
            onChange={(e) => onSeek(Number(e.target.value))}
          />
          <span className="music-prog-t">{fmtTime(durationMs)}</span>
        </div>
      </div>
    </div>
  );
}
