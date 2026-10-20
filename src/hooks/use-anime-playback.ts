/**
 * 播放器屏的 WebView 轨接线（M2）。
 *
 * 一次播放要经过四步，任何一步失败都要给得出原因：
 * ① `anime_play_source` 拿到「这一集走哪条轨 / 带票地址 / 外挂字幕」；
 * ② 建播放器（`@anime/player`，ArtPlayer + hls.js）；
 * ③ 把播放状态（位置 / 缓冲 / 播放中 / 倍速）喂给控制条；
 * ④ 按 5 秒节流回写续看位置，播完标看完。
 *
 * libmpv 轨**不在这里**：它需要随包内核，`anime_play_source` 会返回
 * `supported: false` 与原因，屏上直接把原因显示出来，不假装能播。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import * as ipc from '@anime/ipc';
import { errText } from '@anime/convert';
import { RATE_STEPS } from '@anime/player-options';
import { createWebviewPlayer, type PlayerEnv, type WebviewPlayer } from '@anime/player';
import type {
  AnimeEpisode,
  AnimeKernelTrack,
  AnimePlaySource,
  AnimePlaySubtitle,
  AnimeRemotePlayback,
  PlaybackState,
} from '@anime/types';
import type { AnimePrefs } from '@anime/prefs';

const IDLE: PlaybackState = {
  episodeId: null,
  positionMs: 0,
  durationMs: 0,
  playing: false,
  bufferedMs: 0,
  rate: 1,
  subtitle: '',
  audioTrack: '',
};

/** 续看落盘的最小间隔（毫秒）—— 与 store 的节流同口径，避免两处各写一个数 */
const SAVE_GAP_MS = 5000;

export interface AnimePlaybackOptions {
  subjectId: string | null;
  episode: AnimeEpisode | null;
  /**
   * 远程播放（媒体服务器中继）。给了就**不再探测本地**，直接用这条带票地址建播放器。
   *
   * 为什么是「给了就不探测」而不是「探测失败再兜底」：远程播放时用户根本不在看本地库，
   * 去探测只会白白等一次本地扫描，还会把「本地没有」的错误显示出来误导人。
   */
  remote?: AnimeRemotePlayback | null;
  prefs: AnimePrefs;
  /** 回写续看位置（调用方接 `savePosition`） */
  onProgress: (episodeId: string, positionMs: number) => void;
  /** 自然播完（调用方接 `markWatched` / 自动连播） */
  onEnded: (episodeId: string) => void;
}

export interface AnimePlayback {
  containerRef: RefObject<HTMLDivElement>;
  source: AnimePlaySource | null;
  loading: boolean;
  error: string | null;
  state: PlaybackState;
  /** -1 = 字幕关闭 */
  subtitleIndex: number;
  subtitles: AnimePlaySubtitle[];
  /** 走的是内核轨（画面在 mpv 窗口里，不在 container 里） */
  kernel: boolean;
  /** 内核轨的轨道表（音轨 / 字幕轨）；WebView 轨为空 */
  kernelTracks: AnimeKernelTrack[];
  /** 当前音量 0–1（两轨共用） */
  volume: number;
  controls: {
    toggle: () => void;
    seekMs: (ms: number) => void;
    cycleRate: () => number;
    cycleSubtitle: () => number;
    screenshot: () => void;
    fullscreen: () => void;
    retry: () => void;
    setVolume: (v: number) => void;
    /** 选一条内核轨（`kind: 'audio' | 'sub'`；`id: 'no'` = 关掉） */
    selectKernelTrack: (kind: 'audio' | 'sub', id: string) => void;
  };
}

export function useAnimePlayback(opts: AnimePlaybackOptions): AnimePlayback {
  const { subjectId, episode, prefs, remote, onProgress, onEnded } = opts;
  const episodeId = episode?.id ?? null;
  const index = episode?.index ?? null;

  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<WebviewPlayer | null>(null);
  const [source, setSource] = useState<AnimePlaySource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<PlaybackState>(IDLE);
  const [subtitleIndex, setSubtitleIndex] = useState(-1);
  const [reloadKey, setReloadKey] = useState(0);
  const [kernelTracks, setKernelTracks] = useState<AnimeKernelTrack[]>([]);
  const [volume, setVolumeState] = useState(0.8);
  const volumeRef = useRef(0.8);
  /** 当前是否走内核轨（回调里读它，避免每次渲染换身份） */
  const kernelRef = useRef(false);
  /** 内核自然播完只认一次：轮询会重复读到 `ended`，重复触发会连播到最后一集 */
  const kernelEndedRef = useRef(false);

  const kernelActive = source !== null && source.found && source.track === 'libmpv' && source.supported;
  kernelRef.current = kernelActive;

  // 回调 / 偏好 / 当前状态都走 ref：它们的身份每次渲染都在变，进依赖会把播放器重建
  const progressRef = useRef(onProgress);
  const endedRef = useRef(onEnded);
  const prefsRef = useRef(prefs);
  const stateRef = useRef(state);
  const epIdRef = useRef(episodeId);

  // 续看起点与跳跃标记只在「换集」时重置
  const startRef = useRef(0);
  const lastEpRef = useRef<string | null>(null);
  const skippedOp = useRef(false);
  const skippedEd = useRef(false);
  const lastSaveRef = useRef(0);

  useEffect(() => {
    progressRef.current = onProgress;
    endedRef.current = onEnded;
    prefsRef.current = prefs;
    stateRef.current = state;
    epIdRef.current = episodeId;
  });

  // ⚠️ 必须排在「取播放事实」之前：换集时先把续看起点换掉，建播放器时读到的才是这一集的
  useEffect(() => {
    if (episodeId === lastEpRef.current) return;
    lastEpRef.current = episodeId;
    startRef.current = episode?.positionMs ?? 0;
    skippedOp.current = false;
    skippedEd.current = false;
    lastSaveRef.current = 0;
    kernelEndedRef.current = false;
  }, [episodeId, episode]);

  /** 回写进度；`force` 用于暂停 / 切集 / 播完这些「必须落」的时刻 */
  const save = useCallback((positionMs: number, force = false) => {
    const id = epIdRef.current;
    if (!id || positionMs <= 0) return;
    const now = Date.now();
    if (!force && now - lastSaveRef.current < SAVE_GAP_MS) return;
    lastSaveRef.current = now;
    progressRef.current(id, Math.round(positionMs));
  }, []);

  // ① 取播放事实
  //
  // 远程优先：给了 `remote` 就把它包装成同一条 WebView 轨的播放事实，
  // 播放器 / 控制条 / 键盘因此一套代码都不用改（`container: 'remote'` 只为展示区分）。
  const remoteSource = useMemo<AnimePlaySource | null>(() => {
    if (!remote) return null;
    return {
      found: true,
      track: 'webview',
      supported: true,
      kind: 'progressive',
      url: remote.url,
      container: 'remote',
      sizeBytes: 0,
      title: remote.title,
      subtitles: [],
      expiresAt: remote.expiresAt,
    };
  }, [remote]);

  useEffect(() => {
    if (remoteSource) {
      setSource(remoteSource);
      setLoading(false);
      setError(null);
      setState({ ...IDLE, rate: prefsRef.current.defaultRate });
      setSubtitleIndex(-1);
      return;
    }
    if (!subjectId || index === null) {
      setSource(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    setSource(null);
    setState({ ...IDLE, rate: prefsRef.current.defaultRate });
    setSubtitleIndex(-1);
    ipc
      .animePlaySource(subjectId, index)
      .then((s) => {
        if (!alive) return;
        setSource(s);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(errText(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [subjectId, index, reloadKey, remoteSource]);

  // ② 建播放器（只有 WebView 轨才建）
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !source || !source.found || source.track !== 'webview' || !source.supported) return;
    const p = prefsRef.current;
    const env: PlayerEnv = {
      startMs: p.resume ? startRef.current : 0,
      rate: p.defaultRate,
      subtitleIndex: -1,
      subtitleSize: p.subtitleSize,
      subtitleStroke: p.subtitleStroke,
    };
    const player = createWebviewPlayer(el, source, env, {
      onState: (patch) => {
        setState((s) => ({ ...s, ...patch }));
        // 暂停是一个「用户走开了」的信号：这一下必须落盘，不能等节流窗口
        if (patch.playing === false && patch.positionMs) save(patch.positionMs, true);
      },
      onEnded: () => {
        const id = epIdRef.current;
        const pos = stateRef.current.positionMs;
        if (id) {
          if (pos > 0) save(pos, true);
          endedRef.current(id);
        }
      },
      onError: (message) => setError(message),
    });
    playerRef.current = player;
    return () => {
      const pos = stateRef.current.positionMs;
      if (pos > 0) save(pos, true);
      player.destroy();
      playerRef.current = null;
    };
    // source 每次加载都是新对象：换集 / 重试都会走到这里重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // ②b 内核轨：让服务侧起 mpv，之后轮询它的状态
  //
  // 为什么是轮询而不是事件：内核在**另一个进程**里，状态要过进程边界；
  // 800ms 对控制条够用（拖拽本身是本地即时反馈），比开一条 SSE 便宜得多。
  useEffect(() => {
    if (!kernelActive || !subjectId || index === null) return;
    let alive = true;
    const p = prefsRef.current;
    // 「强制硬件解码」放开不安全后端；默认 auto-safe 让 mpv 自己挑
    const hwdec = p.forceHwDecode ? 'auto' : 'auto-safe';
    ipc
      .animeKernelOpen(subjectId, index, hwdec)
      .then((r) => {
        if (!alive) return;
        setError(null);
        setKernelTracks(r.session.tracks);
        setState({ ...r.session.state, episodeId: epIdRef.current });
      })
      .catch((e) => {
        if (alive) setError(errText(e));
      });
    const timer = window.setInterval(() => {
      void ipc
        .animeKernelStatus()
        .then((st) => {
          if (!alive) return;
          setKernelTracks(st.session.tracks);
          setState({ ...st.session.state, episodeId: epIdRef.current });
          if (st.session.ended && !kernelEndedRef.current && epIdRef.current) {
            kernelEndedRef.current = true;
            const pos = st.session.state.positionMs;
            if (pos > 0) save(pos, true);
            endedRef.current(epIdRef.current);
          }
        })
        .catch(() => {
          /* 轮询失败不刷屏：下一次再试 */
        });
    }, 800);
    return () => {
      alive = false;
      window.clearInterval(timer);
      const pos = stateRef.current.positionMs;
      if (pos > 0) save(pos, true);
      void ipc.animeKernelClose();
    };
  }, [kernelActive, subjectId, index, save]);

  // ③ 进度节流回写
  useEffect(() => {
    if (!state.playing || state.positionMs <= 0) return;
    save(state.positionMs);
  }, [state.playing, state.positionMs, save]);

  // 片头 / 片尾跳过（按偏好，只在每集触发一次）
  //
  // 两轨共用：走 `seekMs` 这个口，而不是直接拿 player —— 内核轨没有 player。
  useEffect(() => {
    if (!episode || !state.playing) return;
    const pos = state.positionMs;
    const op = episode.op;
    const ed = episode.ed;
    const skip = prefs.skip;
    const jump = (ms: number) => {
      if (kernelRef.current) void ipc.animeKernelCtl('seek', Math.round(ms));
      else playerRef.current?.seekMs(ms);
    };
    if (op && (skip === 'op' || skip === 'both') && !skippedOp.current && pos >= op.startMs && pos < op.endMs - 1000) {
      skippedOp.current = true;
      jump(op.endMs);
    }
    if (ed && (skip === 'ed' || skip === 'both') && !skippedEd.current && pos >= ed.startMs && pos < ed.endMs - 1000) {
      skippedEd.current = true;
      jump(ed.endMs);
    }
  }, [episode, prefs.skip, state.playing, state.positionMs]);

  const subtitles = useMemo<AnimePlaySubtitle[]>(() => {
    if (!source || !source.found) return [];
    if (source.track === 'webview') return source.subtitles;
    // 内核轨：字幕是盘上的文件（内核自己读），url 只是占位
    return source.subtitles.map((s) => ({ url: '', name: s.name, format: s.format }));
  }, [source]);

  const toggle = useCallback(() => {
    if (kernelRef.current) {
      void ipc.animeKernelCtl(stateRef.current.playing ? 'pause' : 'play');
      return;
    }
    playerRef.current?.toggle();
  }, []);

  const seekMs = useCallback((ms: number) => {
    if (kernelRef.current) {
      void ipc.animeKernelCtl('seek', Math.round(ms));
      return;
    }
    playerRef.current?.seekMs(ms);
  }, []);

  const cycleRate = useCallback(() => {
    const cur = stateRef.current.rate || 1;
    const at = RATE_STEPS.indexOf(cur);
    const next = RATE_STEPS[(at + 1) % RATE_STEPS.length] ?? 1;
    if (kernelRef.current) void ipc.animeKernelCtl('rate', next);
    else playerRef.current?.setRate(next);
    setState((s) => ({ ...s, rate: next }));
    return next;
  }, []);

  const cycleSubtitle = useCallback(() => {
    if (subtitles.length === 0) return -1;
    const next = subtitleIndex >= subtitles.length - 1 ? -1 : subtitleIndex + 1;
    setSubtitleIndex(next);
    if (kernelRef.current) {
      void ipc.animeKernelCtl('subtitle', next < 0 ? '' : subtitles[next].name.replace(/\.[^.]+$/, '.ass'));
    } else {
      playerRef.current?.setSubtitle(next);
    }
    setState((s) => ({ ...s, subtitle: next < 0 ? '' : subtitles[next].name }));
    return next;
  }, [subtitles, subtitleIndex]);

  const screenshot = useCallback(() => {
    if (kernelRef.current) {
      void ipc.animeKernelCtl('screenshot');
      return;
    }
    const name = `anime-${epIdRef.current ?? 'frame'}-${Math.round(stateRef.current.positionMs / 1000)}`;
    playerRef.current?.screenshot(name);
  }, []);

  const fullscreen = useCallback(() => {
    if (kernelRef.current) void ipc.animeKernelCtl('fullscreen', true);
    else playerRef.current?.fullscreen();
  }, []);

  const setVolume = useCallback((v: number) => {
    const n = Math.max(0, Math.min(1, v));
    volumeRef.current = n;
    setVolumeState(n);
    if (kernelRef.current) void ipc.animeKernelCtl('volume', Math.round(n * 100));
    else playerRef.current?.setVolume(n);
  }, []);

  const selectKernelTrack = useCallback((kind: 'audio' | 'sub', id: string) => {
    if (!kernelRef.current) return;
    void ipc.animeKernelCtl('track', { kind, id });
  }, []);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  // 键盘：只在本屏挂着时生效；输入框里不抢键。两轨共用同一套按键。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!kernelRef.current && !playerRef.current) return;
      const pos = stateRef.current.positionMs;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          toggle();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seekMs(Math.max(0, pos - 5000));
          break;
        case 'ArrowRight':
          e.preventDefault();
          seekMs(pos + 5000);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setVolume(volumeRef.current + 0.05);
          break;
        case 'ArrowDown':
          e.preventDefault();
          setVolume(volumeRef.current - 0.05);
          break;
        case 'f':
        case 'F':
          fullscreen();
          break;
        case 'm':
        case 'M':
          if (!kernelRef.current) playerRef.current?.toggleMute();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, seekMs, setVolume, fullscreen]);

  return {
    containerRef,
    source,
    loading,
    error,
    state,
    subtitleIndex,
    subtitles,
    kernel: kernelActive,
    kernelTracks,
    volume,
    controls: {
      toggle,
      seekMs,
      cycleRate,
      cycleSubtitle,
      screenshot,
      fullscreen,
      retry,
      setVolume,
      selectKernelTrack,
    },
  };
}
