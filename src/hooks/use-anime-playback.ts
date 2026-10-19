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
import type { AnimeEpisode, AnimePlaySource, AnimePlaySubtitle, PlaybackState } from '@anime/types';
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
  controls: {
    toggle: () => void;
    seekMs: (ms: number) => void;
    cycleRate: () => number;
    cycleSubtitle: () => number;
    screenshot: () => void;
    fullscreen: () => void;
    retry: () => void;
  };
}

export function useAnimePlayback(opts: AnimePlaybackOptions): AnimePlayback {
  const { subjectId, episode, prefs, onProgress, onEnded } = opts;
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
  useEffect(() => {
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
  }, [subjectId, index, reloadKey]);

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

  // ③ 进度节流回写
  useEffect(() => {
    if (!state.playing || state.positionMs <= 0) return;
    save(state.positionMs);
  }, [state.playing, state.positionMs, save]);

  // 片头 / 片尾跳过（按偏好，只在每集触发一次）
  useEffect(() => {
    if (!episode || !state.playing) return;
    const player = playerRef.current;
    if (!player) return;
    const pos = state.positionMs;
    const op = episode.op;
    const ed = episode.ed;
    const skip = prefs.skip;
    if (op && (skip === 'op' || skip === 'both') && !skippedOp.current && pos >= op.startMs && pos < op.endMs - 1000) {
      skippedOp.current = true;
      player.seekMs(op.endMs);
    }
    if (ed && (skip === 'ed' || skip === 'both') && !skippedEd.current && pos >= ed.startMs && pos < ed.endMs - 1000) {
      skippedEd.current = true;
      player.seekMs(ed.endMs);
    }
  }, [episode, prefs.skip, state.playing, state.positionMs]);

  // 键盘：只在本屏挂着时生效；输入框里不抢键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const player = playerRef.current;
      if (!player) return;
      const pos = stateRef.current.positionMs;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          player.toggle();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          player.seekMs(Math.max(0, pos - 5000));
          break;
        case 'ArrowRight':
          e.preventDefault();
          player.seekMs(pos + 5000);
          break;
        case 'ArrowUp':
          e.preventDefault();
          player.stepVolume(0.05);
          break;
        case 'ArrowDown':
          e.preventDefault();
          player.stepVolume(-0.05);
          break;
        case 'f':
        case 'F':
          player.fullscreen();
          break;
        case 'm':
        case 'M':
          player.toggleMute();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const subtitles = useMemo<AnimePlaySubtitle[]>(() => {
    if (!source || !source.found || source.track !== 'webview') return [];
    return source.subtitles;
  }, [source]);

  const toggle = useCallback(() => playerRef.current?.toggle(), []);

  const seekMs = useCallback((ms: number) => playerRef.current?.seekMs(ms), []);

  const cycleRate = useCallback(() => {
    const cur = stateRef.current.rate || 1;
    const at = RATE_STEPS.indexOf(cur);
    const next = RATE_STEPS[(at + 1) % RATE_STEPS.length] ?? 1;
    playerRef.current?.setRate(next);
    setState((s) => ({ ...s, rate: next }));
    return next;
  }, []);

  const cycleSubtitle = useCallback(() => {
    if (subtitles.length === 0) return -1;
    const next = subtitleIndex >= subtitles.length - 1 ? -1 : subtitleIndex + 1;
    setSubtitleIndex(next);
    playerRef.current?.setSubtitle(next);
    setState((s) => ({ ...s, subtitle: next < 0 ? '' : subtitles[next].name }));
    return next;
  }, [subtitles, subtitleIndex]);

  const screenshot = useCallback(() => {
    const name = `anime-${epIdRef.current ?? 'frame'}-${Math.round(stateRef.current.positionMs / 1000)}`;
    playerRef.current?.screenshot(name);
  }, []);

  const fullscreen = useCallback(() => playerRef.current?.fullscreen(), []);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  return {
    containerRef,
    source,
    loading,
    error,
    state,
    subtitleIndex,
    subtitles,
    controls: { toggle, seekMs, cycleRate, cycleSubtitle, screenshot, fullscreen, retry },
  };
}
