/**
 * WebView 轨的播放器封装（M2）：ArtPlayer 负责解码与字幕层，hls.js 负责 m3u8。
 *
 * ## 为什么控制条不交给 ArtPlayer
 * 播放器屏的控制条是设计稿的一部分（`.an-stage-bar`），ArtPlayer 自带一套。
 * 两套并存会出现「两个播放键、两条进度条」，观感与可测性都更差。所以这里
 * `controls: false`，只把播放器的**能力**暴露给屏上的控制条。
 *
 * ## 为什么片源类型是显式传的
 * 带票地址形如 `…/stream?path=…&exp=…&sig=…`，路径里**没有扩展名**，
 * ArtPlayer 靠 URL 猜类型会猜空。因此 m3u8 用 `type: 'm3u8'` 走 hls.js，
 * 其余走自定义类型 `animefile`（同时补上 `crossOrigin`，否则截图会污染画布）。
 */
import Artplayer from 'artplayer';
import Hls from 'hls.js';
import type { AnimePlaySourceWebview, PlaybackState } from '@anime/types';

/** 建播放器时一次性读取的环境（后续变化走实例方法，不重建实例） */
export interface PlayerEnv {
  /** 续看起点（毫秒）；0 = 从头 */
  startMs: number;
  rate: number;
  /** 初始字幕序号；-1 = 关闭 */
  subtitleIndex: number;
  subtitleSize: 100 | 120 | 140;
  subtitleStroke: 'thin' | 'mid' | 'bold';
}

export interface PlayerHandlers {
  /** 播放器状态增量（位置 / 时长 / 播放中 / 缓冲） */
  onState: (patch: Partial<PlaybackState>) => void;
  /** 自然播完（不含错误） */
  onEnded: () => void;
  /** 解不了 / 网络断，文案给人看 */
  onError: (message: string) => void;
}

export interface WebviewPlayer {
  play(): void;
  pause(): void;
  toggle(): void;
  /** 绝对定位（毫秒） */
  seekMs(ms: number): void;
  setRate(rate: number): void;
  /** -1 = 关闭字幕 */
  setSubtitle(index: number): void;
  screenshot(name: string): void;
  fullscreen(): void;
  /** 音量增减（0–1 的增量） */
  stepVolume(delta: number): void;
  /** 绝对音量（0–1） */
  setVolume(volume: number): void;
  toggleMute(): void;
  destroy(): void;
}

const SUBTITLE_PX: Record<PlayerEnv['subtitleSize'], number> = { 100: 16, 120: 19, 140: 22 };
const SUBTITLE_STROKE: Record<PlayerEnv['subtitleStroke'], string> = {
  thin: '0 0 1px rgba(0,0,0,.8)',
  mid: '0 0 2px rgba(0,0,0,.9), 0 1px 3px rgba(0,0,0,.85)',
  bold: '0 0 3px #000, 0 0 5px #000, 0 2px 4px rgba(0,0,0,.9)',
};

/** 主题色从设计令牌读；读不到时用设计稿的粉色兜底 */
function themeOf(container: HTMLElement): string {
  const v = getComputedStyle(container).getPropertyValue('--md-pink').trim();
  return v || '#ff5c8a';
}

/**
 * 在 `container` 里建一个 WebView 轨播放器。
 * 只建实例，不判断「这一集该不该走这条轨」——那是调用方（`anime_play_source`）的事。
 */
export function createWebviewPlayer(
  container: HTMLDivElement,
  source: AnimePlaySourceWebview,
  env: PlayerEnv,
  handlers: PlayerHandlers,
): WebviewPlayer {
  const art = new Artplayer({
    container,
    url: source.url,
    type: source.kind === 'hls' ? 'm3u8' : 'animefile',
    customType: {
      // m3u8：本机 HLS 文件经带票流端点读取（段地址需为绝对地址，详见台账）
      m3u8: (video, url, player) => {
        if (Hls.isSupported()) {
          const hls = new Hls({ enableWorker: true });
          hls.loadSource(url);
          hls.attachMedia(video);
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) handlers.onError('HLS 流断开：这一集的播放列表读不出来');
          });
          player.on('destroy', () => hls.destroy());
          return;
        }
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
          return;
        }
        handlers.onError('当前 WebView 不支持 HLS 播放');
      },
      // 单文件（mp4/webm/mov…）：显式设 crossOrigin，截图才不污染画布
      animefile: (video, url) => {
        video.crossOrigin = 'anonymous';
        video.src = url;
      },
    },
    autoplay: false,
    // 控制条是设计稿那一套（`.an-stage-bar`），这里不给 ArtPlayer 任何控件
    controls: [],
    setting: false,
    hotkey: false,
    playbackRate: false,
    aspectRatio: false,
    fullscreen: true,
    fullscreenWeb: false,
    pip: false,
    airplay: false,
    miniProgressBar: false,
    muted: false,
    volume: 0.8,
    theme: themeOf(container),
  });

  const emit = () => {
    handlers.onState({
      positionMs: Math.max(0, art.currentTime * 1000),
      durationMs: Math.max(0, art.duration * 1000),
      playing: art.playing,
      bufferedMs: Math.max(0, art.loadedTime * 1000),
    });
  };

  art.on('ready', () => {
    if (env.rate !== 1) art.playbackRate = env.rate;
    if (env.startMs > 0 && env.startMs < art.duration * 1000 - 5000) {
      art.currentTime = env.startMs / 1000;
    }
    if (env.subtitleIndex >= 0) applySubtitle(env.subtitleIndex);
    emit();
  });
  art.on('video:timeupdate', emit);
  art.on('video:play', emit);
  art.on('video:pause', emit);
  art.on('video:progress', emit);
  art.on('video:ended', () => {
    emit();
    handlers.onEnded();
  });
  art.on('video:error', () => {
    handlers.onError('这一集解不开：容器或编码超出 WebView 播放内核能力');
  });

  art.subtitle.style({
    fontSize: `${SUBTITLE_PX[env.subtitleSize]}px`,
    fontWeight: '600',
    textShadow: SUBTITLE_STROKE[env.subtitleStroke],
  });

  function applySubtitle(index: number) {
    const sub = source.subtitles[index];
    if (!sub) {
      art.subtitle.show = false;
      return;
    }
    art.subtitle.show = true;
    void art.subtitle
      .switch(sub.url, { type: sub.format, name: sub.name })
      .catch(() => handlers.onError(`字幕载入失败：${sub.name}`));
  }

  return {
    play: () => void art.play(),
    pause: () => art.pause(),
    toggle: () => art.toggle(),
    seekMs: (ms) => {
      const sec = Math.max(0, Math.min(ms / 1000, art.duration || Infinity));
      art.currentTime = sec;
      emit();
    },
    setRate: (rate) => {
      art.playbackRate = rate;
    },
    setSubtitle: (index) => applySubtitle(index),
    screenshot: (name) => void art.screenshot(name),
    fullscreen: () => {
      art.fullscreen = true;
    },
    stepVolume: (delta) => {
      art.volume = Math.max(0, Math.min(1, art.volume + delta));
    },
    setVolume: (volume) => {
      art.volume = Math.max(0, Math.min(1, volume));
    },
    toggleMute: () => {
      art.muted = !art.muted;
    },
    destroy: () => art.destroy(),
  };
}
