/**
 * 播放器（设计稿 ⑤）：画面 + 选集侧栏。
 *
 * 画面区接的是 **WebView 轨**（`anime_play_source` 返回 `track: "webview"` 时）：
 * 带票的本地 Range 流交给 ArtPlayer + hls.js，控制条仍是设计稿这一套（不用它的控件）。
 * 需要随包内核的容器（mkv 等）拿不到地址，屏上直接说清「内核未就绪」——
 * 不画假的播放进度，也不给一个放不出来的 URL。
 */
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeft, ListMusic, Maximize2, Pause, Play, Settings2, SkipBack, SkipForward, X } from 'lucide-react';
import { Btn, Empty } from '@components/units';
import { useToasts } from '@hooks';
import { useEsc } from '@hooks/useEsc';
import * as ipc from '@anime/ipc';
import { useAnimeStore } from '@anime/store';
import { episodesOf, selectedEpisode, selectedSubject } from '@anime/selectors';
import { errText, fmtClock, tidyRules } from '@anime/convert';
import { PLAYER_KEYS, SOURCE_KIND_LABEL } from '@anime/player-options';
import type {
  AnimeKernelTrack,
  AnimePlaySource,
  AnimePlaySourceKernel,
  AnimePlaySubtitle,
  AnimeRemotePlayback,
  AnimeSourceTestItem,
  MediaSourceView,
  PlaybackState,
} from '@anime/types';
import type { AnimePrefs } from '@anime/prefs';
import { useAnimePlayback, type AnimePlayback } from '@hooks';
import { Cover, EpisodeRow } from '@screens/anime/shared';

type SideTab = 'episodes' | 'info' | 'comments';

/** 画面区顶部那行状态（不做多级内联三元，规则见 AGENTS §2 第 10 条） */
function stageLine(loading: boolean, error: string | null, source: AnimePlaySource | null): string {
  if (loading) return '正在探测本地片源…';
  if (error) return '播放器起不来';
  if (!source || !source.found) return '尚无片源';
  if (source.track === 'libmpv') {
    return source.supported
      ? `内核轨 · ${source.container.toUpperCase()} · 独立窗口`
      : `需要播放内核 · ${source.container.toUpperCase()}`;
  }
  return source.kind === 'hls' ? 'HLS 流' : `${source.container.toUpperCase()} · 本地文件`;
}

/** 倍速标签：`1` / `1.25` / `2`（不带多余的 0） */
function rateLabel(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}

/**
 * 控制条（本地与远程播放共用）。
 *
 * 抽成一件是因为两条播放路只有「顶部标题 / 中间画面 / 侧栏」不同，
 * 底部这一整套（进度、播放、倍速、截图、字幕、快捷键提示）必须一致 ——
 * 各写一套迟早会出现「远程播放没有快捷键」这种静默缺口。
 */
interface ControlBarProps {
  playable: boolean;
  state: PlaybackState;
  durationMs: number;
  rate: number;
  subtitleName: string;
  subtitles: AnimePlaySubtitle[];
  controls: AnimePlayback['controls'];
  onRate: (rate: number) => void;
  /** 当前音量 0–1 */
  volume: number;
  onVolume: (v: number) => void;
  /** 片头 / 片尾跳转（这一集没标记就传 null，按钮不渲染） */
  skip: { op: number | null; ed: number | null; onJump: (ms: number) => void } | null;
  /** 统计面板开关（只有内核轨有真实数据） */
  stats: { on: boolean; onToggle: () => void } | null;
  /** 本地播放才有上一集 / 下一集；远程播放传 null */
  epNav: { prev: boolean; next: boolean; onPrev: () => void; onNext: () => void } | null;
}

function ControlBar({
  playable,
  state,
  durationMs,
  rate,
  subtitleName,
  subtitles,
  controls,
  onRate,
  volume,
  onVolume,
  skip,
  stats,
  epNav,
}: ControlBarProps) {
  const pct = durationMs ? Math.min(100, Math.round((state.positionMs / durationMs) * 100)) : 0;
  const bufferedPct = durationMs ? Math.min(100, Math.round((state.bufferedMs / durationMs) * 100)) : 0;

  /** 悬停帧预览：位置 + 时间 + 抓到的帧（内核轨 / HLS 轨拿不到帧，只显示时间） */
  const [preview, setPreview] = useState<{ pct: number; ms: number; img: string | null } | null>(null);
  const previewTimer = useRef<number | null>(null);
  const previewSeq = useRef(0);

  const seekByPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!playable || !durationMs) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    controls.seekMs(ratio * durationMs);
  };

  const hoverPreview = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!playable || !durationMs) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ms = ratio * durationMs;
    setPreview((h) => ({ pct: ratio * 100, ms, img: h?.img ?? null }));
    // 90ms 防抖：鼠标扫过进度条时不该每像素都去 seek 一次隐藏视频
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
    const seq = ++previewSeq.current;
    previewTimer.current = window.setTimeout(() => {
      void controls.preview(ms).then((img) => {
        if (seq !== previewSeq.current || !img) return;
        setPreview((h) => (h ? { ...h, img } : h));
      });
    }, 90);
  };

  const clearPreview = () => {
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
    previewSeq.current += 1;
    setPreview(null);
  };

  return (
    <div className="an-stage-bar">
      <div className="an-seek">
        <span className="an-num">{fmtClock(state.positionMs)}</span>
        <div
          className={`an-seek-track${playable ? ' is-live' : ''}`}
          role="slider"
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(durationMs / 1000)}
          aria-valuenow={Math.round(state.positionMs / 1000)}
          tabIndex={playable ? 0 : -1}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekByPointer(e);
          }}
          onPointerMove={(e) => {
            hoverPreview(e);
            if (e.buttons === 1) seekByPointer(e);
          }}
          onPointerLeave={clearPreview}
        >
          <span className="an-seek-buf" style={{ width: `${bufferedPct}%` }} />
          <span className="an-seek-fill" style={{ width: `${pct}%` }} />
          <span className="an-seek-knob" style={{ left: `${pct}%` }} />
          {preview ? (
            <span className="an-seek-pv" style={{ left: `${preview.pct}%` }} aria-hidden>
              {preview.img ? (
                <img src={preview.img} alt="" />
              ) : (
                <i className="an-seek-pv-none" title="这一条轨取不到帧预览" />
              )}
              <b className="an-num">{fmtClock(preview.ms)}</b>
            </span>
          ) : null}
        </div>
        <span className="an-num">{fmtClock(durationMs)}</span>
      </div>
      <div className="an-ctl">
        <button
          type="button"
          className="an-stage-btn"
          disabled={!epNav?.prev}
          title="上一集"
          onClick={() => epNav?.onPrev()}
        >
          <SkipBack size={17} />
        </button>
        <button
          type="button"
          className="an-bigplay"
          disabled={!playable}
          title={playable ? (state.playing ? '暂停' : '播放') : '有片源后可播放'}
          onClick={controls.toggle}
        >
          {state.playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button
          type="button"
          className="an-stage-btn"
          disabled={!epNav?.next}
          title="下一集"
          onClick={() => epNav?.onNext()}
        >
          <SkipForward size={17} />
        </button>
        <button
          type="button"
          className="an-rate"
          disabled={!playable}
          title="切换倍速（同时记为默认倍速）"
          onClick={() => onRate(controls.cycleRate())}
        >
          {rateLabel(rate)}
        </button>
        {skip?.op != null ? (
          <button
            type="button"
            className="an-kbd"
            disabled={!playable}
            title="跳到片头结束"
            onClick={() => skip.onJump(skip.op as number)}
          >
            跳片头
          </button>
        ) : null}
        {skip?.ed != null ? (
          <button
            type="button"
            className="an-kbd"
            disabled={!playable}
            title="跳到片尾结束"
            onClick={() => skip.onJump(skip.ed as number)}
          >
            跳片尾
          </button>
        ) : null}
        <span className="an-sp" />
        <label className="an-vol" title={`音量 ${Math.round(volume * 100)}%`}>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(volume * 100)}
            aria-label="音量"
            disabled={!playable}
            onChange={(e) => onVolume(Number(e.target.value) / 100)}
          />
        </label>
        <button
          type="button"
          className="an-kbd"
          disabled={!playable}
          title="截一张当前帧"
          onClick={controls.screenshot}
        >
          截图
        </button>
        <button
          type="button"
          className="an-kbd"
          disabled={!stats}
          title={stats ? '内核统计（缓冲 / 轨道 / 倍速）' : '统计面板只在内核轨有真实数据'}
          onClick={stats?.onToggle}
        >
          {stats?.on ? '统计 ●' : '统计'}
        </button>
        <button
          type="button"
          className="an-kbd"
          disabled={!playable || subtitles.length === 0}
          title={subtitleName ? `当前字幕：${subtitleName}` : subtitles.length ? '切换字幕' : '这一集没有外挂字幕'}
          onClick={controls.cycleSubtitle}
        >
          字幕
        </button>
      </div>
      <div className="an-keys">
        {PLAYER_KEYS.slice(0, 6).map((k) => (
          <span key={k.key}>
            <kbd>{k.key}</kbd> {k.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * 内核轨画面区（mkv / ass / 多音轨）。
 *
 * 画面在 **mpv 自己的窗口**里 —— 这一屏不假装画面在应用内，而是把「现在在放什么、
 * 有哪些轨、缓冲到哪」摊开给用户看，控制条仍然由应用驱动（同一条 `PlaybackCore`）。
 */
/** 「选择播放来源」浮层：本地 / 媒体服务器 / 在线网页 / 订阅 / BT 五组（设计稿 ⑤ 的来源入口） */
function SourcePicker({ onClose }: { onClose: () => void }) {
  const sources = useAnimeStore((s) => s.sources);
  const playRemoteSource = useAnimeStore((s) => s.playRemoteSource);
  const playWebUrl = useAnimeStore((s) => s.playWebUrl);
  const { push } = useToasts();
  const [busy, setBusy] = useState<string | null>(null);
  const [items, setItems] = useState<Record<string, AnimeSourceTestItem[]>>({});
  useEsc(onClose);

  const load = async (src: MediaSourceView) => {
    if (!src.url) {
      push('这个源没有地址', 'bad');
      return;
    }
    setBusy(src.id);
    try {
      const r = await ipc.animeTestSource(src.url, src.kind, 6, src.rules);
      setItems((m) => ({ ...m, [src.id]: r.items }));
      push(`「${src.name}」取到 ${r.count} 条`, 'good');
    } catch (e) {
      push(`取条目失败：${errText(e)}`, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const play = async (src: MediaSourceView, it: AnimeSourceTestItem) => {
    if (it.kind === 'video' && it.id) {
      const r = await playRemoteSource(src.id, it);
      if (r.ok) onClose();
      else push(r.message, 'bad');
      return;
    }
    if (it.link && (src.kind === 'web' || src.kind === 'selector')) {
      if (!src.rules?.video?.trim()) {
        push('这个源没配「视频地址选择器」，解析不出直链', 'bad');
        return;
      }
      try {
        const r = await ipc.animeResolveSource(it.link, tidyRules(src.rules));
        playWebUrl(r.url, it.title, src.name, src.id);
        onClose();
      } catch (e) {
        push(`解析失败：${errText(e)}`, 'bad');
      }
      return;
    }
    push('这一条没有可直接播放的地址', 'bad');
  };

  const group = (title: string, kinds: MediaSourceView['kind'][]) => {
    const list = sources.filter((s) => kinds.includes(s.kind) && s.enabled);
    return (
      <section className="an-picker-group">
        <div className="an-picker-hd">
          <b>{title}</b>
          <span className="an-note">{list.length ? `${list.length} 个源` : '还没有这类源'}</span>
        </div>
        {list.map((src) => (
          <div key={src.id} className="an-picker-src">
            <div className="an-picker-row">
              <span className="an-picker-tx">
                <b>{src.name}</b>
                <span>{SOURCE_KIND_LABEL[src.kind] ?? src.kind}</span>
              </span>
              <Btn kind="ghost" size="sm" disabled={busy === src.id || !src.url} onClick={() => void load(src)}>
                {busy === src.id ? '取条目中' : '取条目'}
              </Btn>
            </div>
            {(items[src.id] ?? []).slice(0, 5).map((it, i) => (
              <div key={`${it.title}-${i}`} className="an-picker-row is-item">
                <span className="an-picker-tx">
                  <b>{it.title}</b>
                  <span>{it.index ? `第 ${it.index} 话` : '—'}</span>
                </span>
                <Btn kind="ghost" size="sm" onClick={() => void play(src, it)}>
                  <Play size={12} /> 播放
                </Btn>
              </div>
            ))}
          </div>
        ))}
      </section>
    );
  };

  return (
    <div className="an-picker-mask" role="dialog" aria-modal="true" aria-label="选择播放来源" onClick={onClose}>
      <div className="an-picker" onClick={(e) => e.stopPropagation()}>
        <div className="an-picker-top">
          <b>选择播放来源</b>
          <button type="button" className="an-picker-x" onClick={onClose} aria-label="关闭">
            <X size={14} />
          </button>
        </div>
        <div className="an-picker-body">
          <section className="an-picker-group">
            <div className="an-picker-hd">
              <b>本地</b>
              <span className="an-note">番剧库里的这一集（当前正在播）</span>
            </div>
          </section>
          {group('媒体服务器', ['jellyfin', 'emby'])}
          {group('在线网页源', ['web', 'selector'])}
          {group('订阅源', ['rss'])}
          <section className="an-picker-group">
            <div className="an-picker-hd">
              <b>BT</b>
              <span className="an-note">适配器未接入（R5）—— 现在选了也播不了，不给你一个假的入口</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function KernelStage({
  source,
  kernelTracks,
  state,
  volume,
  statsOn,
  onSelectTrack,
}: {
  source: AnimePlaySourceKernel;
  kernelTracks: AnimeKernelTrack[];
  state: PlaybackState;
  volume: number;
  statsOn: boolean;
  onSelectTrack: (kind: 'audio' | 'sub', id: string) => void;
}) {
  const audio = kernelTracks.filter((t) => t.kind === 'audio');
  const subs = kernelTracks.filter((t) => t.kind === 'sub');
  const file = source.file.split(/[\\/]/).pop() ?? source.file;
  return (
    <div className="an-kernel">
      <div className="an-kernel-hd">
        <b>画面在内核窗口</b>
        <span>
          {source.container.toUpperCase()} · {file}
        </span>
        <span className="an-note">播放 / 暂停 / 跳转都在下面这条控制条上；拖进度也是它。</span>
      </div>

      <div className="an-kernel-tracks">
        <div className="an-kernel-group">
          <span>音轨</span>
          <div className="an-kernel-chips">
            {audio.length === 0 ? <i className="an-note">这一集只有一条默认音轨</i> : null}
            {audio.map((t) => (
              <button
                key={t.id}
                type="button"
                className={t.selected ? 'an-chip is-hot' : 'an-chip is-plain'}
                onClick={() => onSelectTrack('audio', t.id)}
              >
                {t.label}
                {t.lang ? ` · ${t.lang}` : ''}
              </button>
            ))}
          </div>
        </div>
        <div className="an-kernel-group">
          <span>字幕</span>
          <div className="an-kernel-chips">
            {subs.map((t) => (
              <button
                key={t.id}
                type="button"
                className={t.selected ? 'an-chip is-hot' : 'an-chip is-plain'}
                onClick={() => onSelectTrack('sub', t.id)}
              >
                {t.label}
              </button>
            ))}
            <button
              type="button"
              className={subs.some((t) => t.selected) ? 'an-chip is-plain' : 'an-chip is-hot'}
              onClick={() => onSelectTrack('sub', 'no')}
            >
              关闭
            </button>
          </div>
        </div>
      </div>

      {statsOn ? (
        <dl className="an-kernel-stats">
          <div>
            <dt>进度</dt>
            <dd className="an-num">
              {fmtClock(state.positionMs)} / {fmtClock(state.durationMs)}
            </dd>
          </div>
          <div>
            <dt>缓冲</dt>
            <dd className="an-num">{fmtClock(state.bufferedMs)}</dd>
          </div>
          <div>
            <dt>倍速</dt>
            <dd className="an-num">{state.rate.toFixed(2)}×</dd>
          </div>
          <div>
            <dt>音量</dt>
            <dd className="an-num">{Math.round(volume * 100)}%</dd>
          </div>
          <div>
            <dt>轨道</dt>
            <dd className="an-num">
              音 {audio.length} · 字 {subs.length}
            </dd>
          </div>
        </dl>
      ) : (
        <div className="an-keys">
          <span>
            <kbd>空格</kbd> 播放 / 暂停
          </span>
          <span>
            <kbd>← →</kbd> 快退 / 快进 5s
          </span>
          <span>
            <kbd>↑ ↓</kbd> 音量
          </span>
          <span>
            <kbd>f</kbd> 内核窗口全屏
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * 远程播放（媒体服务器中继）—— 与本地播放**共用控制条**，只换顶部与侧栏。
 *
 * 诚实边界：远程这一路**不写续看进度**（库里没有这个条目，没处可写），
 * 侧栏里明说这件事，不做一个「看起来记了其实没记」的进度条。
 */
function RemoteStage({ remote, prefs }: { remote: AnimeRemotePlayback; prefs: AnimePrefs }) {
  const setView = useAnimeStore((s) => s.setView);
  const clearRemote = useAnimeStore((s) => s.clearRemote);
  const setPref = useAnimeStore((s) => s.setPref);
  const { containerRef, source, loading, error, state, subtitles, volume, controls } = useAnimePlayback({
    subjectId: null,
    episode: null,
    remote,
    prefs,
    onProgress: () => {},
    onEnded: () => {},
  });
  const playable = source !== null && source.found && source.supported;

  return (
    <div className="an-player">
      <div className="an-stage">
        <div className="an-stage-top">
          <button
            type="button"
            className="an-stage-btn"
            onClick={() => {
              clearRemote();
              setView('source');
            }}
            title="返回数据源"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="an-stage-tt">
            <b>{remote.title}</b>
            <span>
              {remote.sourceName} · 远程中继
              {loading ? ' · 正在起播' : error ? ' · 起不来' : ''}
            </span>
          </div>
          <button
            type="button"
            className="an-stage-btn"
            disabled={!playable}
            title={playable ? '全屏' : '有片源后可全屏'}
            onClick={controls.fullscreen}
          >
            <Maximize2 size={16} />
          </button>
        </div>

        <div className={`an-stage-mid${playable ? ' is-video' : ''}`}>
          {playable && <div className="an-stage-video" ref={containerRef} />}
          {!playable && (
            <div className="an-stage-empty">
              <b>{loading ? '正在起播' : error ? '播放器起不来' : '正在准备播放器'}</b>
              <span>{error ?? '地址由本机服务侧中继，api_key 不会出现在地址里。'}</span>
              {error ? (
                <Btn kind="primary" onClick={controls.retry}>
                  重试
                </Btn>
              ) : null}
            </div>
          )}
        </div>

        <ControlBar
          playable={playable}
          state={state}
          durationMs={state.durationMs}
          rate={state.rate || prefs.defaultRate}
          subtitleName=""
          subtitles={subtitles}
          controls={controls}
          onRate={(r) => setPref('defaultRate', r)}
          volume={volume}
          onVolume={controls.setVolume}
          skip={null}
          stats={null}
          epNav={null}
        />
      </div>

      <aside className="an-player-side">
        <div className="an-side-tabs" role="tablist" aria-label="远程播放信息">
          <button type="button" role="tab" aria-selected className="is-on">
            远程来源
          </button>
        </div>
        <div className="an-side-body an-scroll">
          <div className="an-src-box">
            <span className="an-src-ic">{SOURCE_KIND_LABEL.jellyfin}</span>
            <span className="an-src-tx">
              <b>{remote.sourceName}</b>
              <span>{remote.title}</span>
            </span>
          </div>
          <div className="an-side-info">
            <div>
              <span>地址</span>
              <b className="an-note">本机中继（带票，6 小时有效）</b>
            </div>
            <div>
              <span>续看进度</span>
              <b>不记录（远程条目不在本地库）</b>
            </div>
            <div>
              <span>外挂字幕</span>
              <b>暂不支持（媒体服务器字幕轨后续接入）</b>
            </div>
          </div>
          <div className="an-acts">
            <Btn
              kind="ghost"
              size="sm"
              onClick={() => {
                clearRemote();
                setView('source');
              }}
            >
              返回数据源
            </Btn>
          </div>
        </div>
      </aside>
    </div>
  );
}

export function PlayerScreen() {
  const subject = useAnimeStore(selectedSubject);
  const episode = useAnimeStore(selectedEpisode);
  const allEpisodes = useAnimeStore((s) => s.episodes);
  const episodes = useMemo(() => episodesOf(subject?.id ?? null, allEpisodes), [subject?.id, allEpisodes]);
  const setView = useAnimeStore((s) => s.setView);
  const openPlayer = useAnimeStore((s) => s.openPlayer);
  const markWatched = useAnimeStore((s) => s.markWatched);
  const savePosition = useAnimeStore((s) => s.savePosition);
  const prefs = useAnimeStore((s) => s.prefs);
  const setPref = useAnimeStore((s) => s.setPref);
  const remote = useAnimeStore((s) => s.remote);
  const [tab, setTab] = useState<SideTab>('episodes');
  const [statsOn, setStatsOn] = useState(false);
  /** 「选择播放来源」浮层（设计稿 ⑤ 的来源入口） */
  const [pickerOpen, setPickerOpen] = useState(false);

  const idx = episode ? episodes.findIndex((e) => e.id === episode.id) : -1;
  const prev = idx > 0 ? episodes[idx - 1] : null;
  const next = idx >= 0 && idx < episodes.length - 1 ? episodes[idx + 1] : null;

  const {
    containerRef,
    source,
    loading,
    error,
    state,
    subtitleIndex,
    subtitles,
    kernel,
    kernelTracks,
    volume,
    controls,
  } = useAnimePlayback({
    subjectId: subject?.id ?? null,
    episode,
    prefs,
    onProgress: (episodeId, positionMs) => void savePosition(episodeId, positionMs),
    onEnded: (episodeId) => {
      void markWatched(episodeId, true);
      if (prefs.autoNext && next && subject) openPlayer(subject.id, next.id);
    },
  });

  if (!subject || !episode) {
    // 远程播放（媒体服务器中继）：没有本地条目也能播
    if (remote) return <RemoteStage remote={remote} prefs={prefs} />;
    return (
      <div className="an-screen an-pad">
        <Empty>
          <b>还没有在播的剧集</b>
          <div className="an-empty-sub">从条目详情点「开始观看」，这里就会载入播放器。</div>
          <div className="an-empty-acts">
            <Btn kind="primary" onClick={() => setView('collection')}>
              回追番挑一部
            </Btn>
          </div>
        </Empty>
      </div>
    );
  }

  const playable = source !== null && source.found && source.supported;
  const isKernel = kernel && source !== null && source.found && source.track === 'libmpv';
  const kernelSource = isKernel && source !== null && source.found && source.track === 'libmpv' ? source : null;
  const durationMs = state.durationMs || episode.durationMs;
  const rate = state.rate || prefs.defaultRate;
  const subtitleName = subtitleIndex >= 0 ? (subtitles[subtitleIndex]?.name ?? '') : '';

  return (
    <div className="an-player">
      <div className="an-stage">
        {!playable && (
          <div className="an-stage-bg">
            <Cover subject={subject} size="lg" />
          </div>
        )}

        <div className="an-stage-top">
          <button type="button" className="an-stage-btn" onClick={() => setView('detail')} title="返回条目详情">
            <ArrowLeft size={16} />
          </button>
          <div className="an-stage-tt">
            <b>{subject.title}</b>
            <span>
              第 {episode.index} 话「{episode.title}」· {stageLine(loading, error, source)}
            </span>
          </div>
          <button type="button" className="an-stage-btn" onClick={() => setPickerOpen(true)} title="选择播放来源">
            <Settings2 size={16} />
          </button>
          <button
            type="button"
            className="an-stage-btn"
            disabled={!playable}
            title={playable ? '全屏' : '有片源后可全屏'}
            onClick={controls.fullscreen}
          >
            <Maximize2 size={16} />
          </button>
        </div>

        <div className={`an-stage-mid${playable && !isKernel ? ' is-video' : ''}`}>
          {playable && !isKernel && <div className="an-stage-video" ref={containerRef} />}
          {kernelSource && (
            <KernelStage
              source={kernelSource}
              kernelTracks={kernelTracks}
              state={state}
              volume={volume}
              statsOn={statsOn}
              onSelectTrack={controls.selectKernelTrack}
            />
          )}
          {!loading && !error && source === null && (
            <div className="an-stage-empty">
              <b>正在准备播放器</b>
              <span>先确认这一集在盘上的位置。</span>
            </div>
          )}
          {loading && (
            <div className="an-stage-empty">
              <b>正在找这一集的片源</b>
              <span>只查本地番剧库，不联网。</span>
            </div>
          )}
          {!loading && error && (
            <div className="an-stage-empty">
              <b>播放器起不来</b>
              <span>{error}</span>
              <Btn kind="primary" onClick={controls.retry}>
                重试
              </Btn>
            </div>
          )}
          {!loading && !error && source !== null && !source.found && (
            <div className="an-stage-empty">
              <b>这集还没有片源</b>
              <span>{source.reason}</span>
              <Btn kind="primary" onClick={() => setView('source')}>
                去选来源
              </Btn>
            </div>
          )}
          {!loading && !error && source !== null && source.found && !source.supported && (
            <div className="an-stage-empty">
              <b>这集需要随包播放内核</b>
              <span>{source.reason}</span>
              <span>内核就绪后这一集会走 libmpv，不经过 WebView。</span>
            </div>
          )}
        </div>

        <ControlBar
          playable={playable}
          state={state}
          durationMs={durationMs}
          rate={rate}
          subtitleName={subtitleName}
          subtitles={subtitles}
          controls={controls}
          onRate={(r) => setPref('defaultRate', r)}
          volume={volume}
          onVolume={controls.setVolume}
          skip={{
            op: episode.op?.endMs ?? null,
            ed: episode.ed?.endMs ?? null,
            onJump: controls.seekMs,
          }}
          stats={{ on: statsOn, onToggle: () => setStatsOn((v) => !v) }}
          epNav={{
            prev: !!prev,
            next: !!next,
            onPrev: () => prev && openPlayer(subject.id, prev.id),
            onNext: () => next && openPlayer(subject.id, next.id),
          }}
        />
      </div>

      <aside className="an-player-side">
        <div className="an-side-tabs" role="tablist" aria-label="播放器侧栏">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'episodes'}
            className={tab === 'episodes' ? 'is-on' : ''}
            onClick={() => setTab('episodes')}
          >
            选集
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'info'}
            className={tab === 'info' ? 'is-on' : ''}
            onClick={() => setTab('info')}
          >
            剧集信息
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'comments'}
            className={tab === 'comments' ? 'is-on' : ''}
            onClick={() => setTab('comments')}
          >
            评论
          </button>
        </div>

        <div className="an-side-body an-scroll">
          <div className="an-src-box">
            <span className="an-src-ic">{SOURCE_KIND_LABEL.builtin}</span>
            <span className="an-src-tx">
              <b>{playable && source ? (isKernel ? '内核 · 本地番剧库' : '内置源 · 本地番剧库') : '尚未选择来源'}</b>
              <span>
                {playable && source
                  ? `${source.container.toUpperCase()} · ${subtitles.length} 条字幕`
                  : '在线源 / BT / 媒体服务器随 M3、M5 接入'}
              </span>
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setView('source')}>
              切换
            </button>
          </div>

          {tab === 'episodes' ? (
            <div className="an-ep-list">
              {episodes.map((e) => (
                <EpisodeRow
                  key={e.id}
                  episode={e}
                  onPlay={() => openPlayer(subject.id, e.id)}
                  onToggleWatched={() => void markWatched(e.id, !e.watched)}
                />
              ))}
            </div>
          ) : tab === 'info' ? (
            <div className="an-side-info">
              <div>
                <span>集号</span>
                <b className="an-num">{episode.index}</b>
              </div>
              <div>
                <span>时长</span>
                <b className="an-num">{durationMs ? fmtClock(durationMs) : '未知'}</b>
              </div>
              <div>
                <span>片头</span>
                <b>{episode.op ? `${fmtClock(episode.op.startMs)} – ${fmtClock(episode.op.endMs)}` : '未标记'}</b>
              </div>
              <div>
                <span>片尾</span>
                <b>{episode.ed ? `${fmtClock(episode.ed.startMs)} – ${fmtClock(episode.ed.endMs)}` : '未标记'}</b>
              </div>
              <div>
                <span>弹幕</span>
                <b>预留能力</b>
              </div>
            </div>
          ) : (
            <Empty inline>
              <ListMusic size={14} /> 评论本期只读；接上元数据后这里显示剧集评论。
            </Empty>
          )}
        </div>
      </aside>
      {pickerOpen ? <SourcePicker onClose={() => setPickerOpen(false)} /> : null}
    </div>
  );
}
