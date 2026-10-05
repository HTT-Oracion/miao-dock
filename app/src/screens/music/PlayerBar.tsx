import {
  ListMusic,
  MonitorSpeaker,
  Pause,
  Play,
  Settings,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { QUALITY_OPTIONS } from '@music/player-options';
import { fmtTime, qualityLabel, useMusicStore } from '@music/store';
import { IconButton, PlayModeButton, Select } from '@components/units';
import { DesktopLyricsSettingsModal } from '@screens/music/DesktopLyricsSettingsModal';

/**
 * 底部播放条。
 * 控制组用 `position:absolute; left:50%; translateX(-50%)` 相对整条居中（设计稿明确注的排版），
 * 刻意不用 flex 居中 —— flex 会被左右两侧（封面/歌名、右侧控件组）的宽度带偏，两端不等宽时按设计稿就不在正中。
 *
 * 分区照参考实现：**中间只放「上一首 / 播放暂停 / 下一首 / 播放模式」这组传输控件**
 * （参考里居中组恰是这四个），音质、音量、桌面歌词、队列、关闭播放都归**右侧组**。
 * 早先我们把队列/桌面歌词/关闭播放塞在居中组里，结果是「中间一坨、右边空着」，
 * 与参考的构图不一致 —— 这次按参考把非传输控件整体挪到右侧。
 *
 * onSeek 由 MusicScreen 注入（转发 `store.seek`）：改 store 进度与挪 `<audio>.currentTime`
 * 两件事已收进 store action 内 —— 早先它由音乐屏自己拿着 audioRef 做，
 * 播放内核搬去应用层（components/MusicKernel.tsx）后那条路就断了，
 * 现在由 store 通过 `registerAudioElement` 拿到元素。所以这里传的只是一个已收口的动作。
 *
 * hidden：播放队列为空时整条不渲染。判断写成 prop（而不是让调用方 `{x > 0 ? <PlayerBar/> : null}`）
 * 是为了把「什么时候该出现」这条规则留在组件自己身上，避免以后又多一处调用点各自判断。
 *
 * 控制组里的桌面歌词开关是**主窗侧唯一的窗口入口**（设置页那一项与它共用同一个
 * store action，两处不会各持一份状态）。窗口的生死归主窗管：歌词窗自己的关闭按钮
 * 调的是 Rust 的 `close_lyrics_window`，不直接改 store，所以这个开关是「意图」的表达，
 * 详见 store 里 `lyricsWindowOpen` 的注释。
 * 它右侧的「桌面歌词设置」（参考实现用的 Settings 图标）只负责打开弹窗；
 * 弹窗内容项由后续任务补齐，这里不重复持有偏好。
 */
export function PlayerBar({ onSeek, hidden }: { onSeek: (ms: number) => void; hidden?: boolean }) {
  const currentSong = useMusicStore((s) => s.currentSong);
  const isPlaying = useMusicStore((s) => s.isPlaying);
  const progressMs = useMusicStore((s) => s.progressMs);
  const durationMs = useMusicStore((s) => s.durationMs);
  const volume = useMusicStore((s) => s.volume);
  const muted = useMusicStore((s) => s.muted);
  const playMode = useMusicStore((s) => s.playMode);
  const playbackQuality = useMusicStore((s) => s.playbackQuality);
  const currentQuality = useMusicStore((s) => s.currentQuality);
  const currentBitrate = useMusicStore((s) => s.currentBitrate);
  const lyricsWindowOpen = useMusicStore((s) => s.lyricsWindowOpen);

  const togglePlay = useMusicStore((s) => s.togglePlay);
  const next = useMusicStore((s) => s.next);
  const prev = useMusicStore((s) => s.prev);
  const cycleMode = useMusicStore((s) => s.cycleMode);
  const setVolume = useMusicStore((s) => s.setVolume);
  const stepVolume = useMusicStore((s) => s.stepVolume);
  const toggleMute = useMusicStore((s) => s.toggleMute);
  const closePlayback = useMusicStore((s) => s.closePlayback);
  const setPlaybackQuality = useMusicStore((s) => s.setPlaybackQuality);
  const setQueueOpen = useMusicStore((s) => s.setQueueOpen);
  const setExpanded = useMusicStore((s) => s.setExpanded);
  const setLyricsWindowOpen = useMusicStore((s) => s.setLyricsWindowOpen);

  /** 桌面歌词设置弹窗的开合（纯 UI 状态，不落 store：它没有需要跨屏/跨窗共享的语义） */
  const [dlSettingsOpen, setDlSettingsOpen] = useState(false);

  /**
   * 进度条的「拖拽会话」状态：非 null 表示用户正在拖/敲键盘，界面显示 dragMs；null 表示跟随 store 的实时进度。
   * 存在的理由：range 的 onChange 在拖动中会连续触发，若每次都 onSeek 会让 <audio> 跟着不断 seek（卡顿/爆音），
   * 且松手前的中间值本就无意义 —— 拖拽期间只改本地显示，松手（或键盘抬起）才提交一次。
   *
   * 必须放在 `if (hidden) return null` 之前：Hook 的调用顺序不能在渲染之间变化。
   */
  const [dragMs, setDragMs] = useState<number | null>(null);

  // 拖拽中显示本地值，否则显示 store 的实时进度；同时夹住上界，避免 duration 尚未就绪时滑块越界。
  const shownMs = dragMs ?? Math.min(progressMs, Math.max(durationMs, 1));

  /**
   * 进度条「已调节段」的填充百分比（0~100），注入 CSS 变量 `--fill`。
   * 渐变本身写在 `.music-prog-bar`（见 music.scss）：已调节段取高亮色、未调节段取原轨道色。
   * 用 `shownMs`（拖拽中含本地值）⇒ **拖动时填充同步跟随**，不必等松手。
   * 除数复用上面那个 `Math.max(durationMs, 1)`，与 value 的上界保持同一口径。
   */
  const progFill = Math.max(0, Math.min(100, (shownMs / Math.max(durationMs, 1)) * 100));
  /** 音量条填充百分比（0~100），同一套渐变口径。 */
  const volFill = Math.max(0, Math.min(100, volume * 100));

  /** 允许在 style 里写 CSS 自定义属性（--fill）的类型（React.CSSProperties 不含 `--*` 键） */
  type FillStyle = React.CSSProperties & Record<'--fill', string>;

  /**
   * 提交一次拖拽结果。
   * 闭包说明：本函数在每次渲染时重建，因此 `dragMs` 读到的总是「本次渲染」的值；
   * 而 onChange 的 setDragMs 会触发重渲染，pointerup/keyup 拿到的就是最新的那个闭包 —— 不会用到首次渲染的旧值。
   * `dragMs === null` 早退：键盘抬起（如 Tab）没经历拖动时是空操作，避免拖着 seek 到无关位置。
   */
  const commit = () => {
    if (dragMs === null) return;
    onSeek(dragMs);
    setDragMs(null);
  };

  if (hidden) return null;

  return (
    <div className="music-player">
      <div className="music-player-row">
        {/* 左侧：封面 + 歌名/歌手（固定不收缩，标题内部再截断） */}
        <div className="music-pb-l">
          <div className="music-pb-cover" onClick={() => setExpanded(true)} title="展开播放器">
            {currentSong?.cover ? <img src={currentSong.cover} alt="" /> : null}
          </div>
          <div className="music-pb-tx" onClick={() => setExpanded(true)} title="展开播放器">
            <b>{currentSong?.name ?? '未在播放'}</b>
            <span>{currentSong?.artist ?? '从左侧歌单或搜索结果里选一首'}</span>
          </div>
        </div>

        {/* 中间：绝对居中的传输控制组（上一首 / 播放暂停 / 下一首 / 播放模式） */}
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
          <PlayModeButton mode={playMode} onCycle={() => cycleMode()} />
        </div>

        {/* 右侧：音质（档位文字）+ 音量 + 桌面歌词 + 桌面歌词设置 + 播放队列 + 关闭播放 */}
        <div className="music-pb-r">
          {/* 音质档位下拉（要的档位）：触发器显示档位名（如「无损」），不是图标。setPlaybackQuality 是 async，用 void 显式忽略 Promise */}
          <Select
            className="music-q-sel"
            label="音质档位"
            value={playbackQuality}
            options={QUALITY_OPTIONS}
            onChange={(v) => void setPlaybackQuality(v)}
          />
          <div
            className="music-vol"
            /*
             * 滚轮调音量：仅改数值，不拦默认事件。
             * 不调 e.preventDefault()：React 的 wheel 监听是被动（passive）的，调用无效且会在控制台刷警告；
             * 本容器位于播放条内、外层并不滚动，也就没有需要拦截的默认滚动行为。
             */
            onWheel={(e) => stepVolume(e.deltaY < 0 ? 0.05 : -0.05)}
          >
            {/* 静音是「不改音量值」的正交状态，图标随 muted 切换，文案也一并切换 */}
            <IconButton title={muted ? '取消静音' : '静音'} onClick={() => toggleMute()}>
              {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
            </IconButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              style={{ '--fill': `${volFill.toFixed(2)}%` } as FillStyle}
              onChange={(e) => setVolume(Number(e.target.value))}
            />
          </div>
          {/* 桌面歌词：独立置顶小窗。title 随状态切换，让同一个按钮的「下一步」始终明确 ——
              开着时看到「关闭桌面歌词」比看到「桌面歌词」更能说明再点一下会发生什么。
              active 走 IconButton 自带的 is-on，与旁边按钮的激活态同一套视觉。 */}
          <IconButton
            title={lyricsWindowOpen ? '关闭桌面歌词' : '桌面歌词'}
            active={lyricsWindowOpen}
            onClick={() => void setLyricsWindowOpen(!lyricsWindowOpen)}
          >
            <MonitorSpeaker size={16} />
          </IconButton>
          {/* 桌面歌词设置：打开独立弹窗（内容项后续任务补，这里只给入口） */}
          <IconButton title="桌面歌词设置" onClick={() => setDlSettingsOpen(true)}>
            <Settings size={16} />
          </IconButton>
          <IconButton title="播放队列" onClick={() => setQueueOpen(true)}>
            <ListMusic size={16} />
          </IconButton>
          {/* 「关闭播放」= 停下当前这首（保留队列），与上面的「播放队列」（清空列表）是两件事 */}
          <IconButton title="关闭播放" onClick={() => closePlayback()}>
            <X size={15} />
          </IconButton>
        </div>
      </div>

      <div className="music-prog">
        {/* 左侧当前时间：拖拽中显示本地值，松手前不跟 store 跳动；第二个参数仍是总时长 */}
        <span className="music-prog-t">{fmtTime(shownMs)}</span>
        {/* 拖动只改本地 dragMs；指针抬起（pointerup）提交。
            键盘方向键不产生 pointerup，必须再挂 keyup 兜底，否则键盘调进度永远提交不了。
            blur 是第三种收尾：拖到滑块外松手时 pointerup 不一定落在 input 上，失焦就成了最后一道保险
            （dragMs 已为 null 时 commit 会早退，所以重复触发无副作用）。 */}
        <input
          type="range"
          className="music-prog-bar"
          min={0}
          max={Math.max(durationMs, 1)}
          step={1000}
          value={shownMs}
          style={{ '--fill': `${progFill.toFixed(2)}%` } as FillStyle}
          onChange={(e) => setDragMs(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <span className="music-prog-t">{fmtTime(durationMs)}</span>
        {/* 实际拿到的音质/码率：与下拉的「想要的档位」分开显示 —— 平台降级时两者不一致，只显示档位等于把降级藏了。
            currentQuality 为空（未在播放）时整块不渲染；码率仅在拿到（>0）时追加。 */}
        {currentQuality ? (
          <span className="music-br">
            {qualityLabel(currentQuality)}
            {currentBitrate > 0 ? ` ${Math.round(currentBitrate / 1000)}kbps` : ''}
          </span>
        ) : null}
      </div>

      <DesktopLyricsSettingsModal open={dlSettingsOpen} onClose={() => setDlSettingsOpen(false)} />
    </div>
  );
}
