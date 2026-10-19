/**
 * 播放器（设计稿 ⑤）：画面 + 选集侧栏。
 *
 * 画面区接的是 **WebView 轨**（`anime_play_source` 返回 `track: "webview"` 时）：
 * 带票的本地 Range 流交给 ArtPlayer + hls.js，控制条仍是设计稿这一套（不用它的控件）。
 * 需要随包内核的容器（mkv 等）拿不到地址，屏上直接说清「内核未就绪」——
 * 不画假的播放进度，也不给一个放不出来的 URL。
 */
import { useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeft, ListMusic, Maximize2, Pause, Play, Settings2, SkipBack, SkipForward } from 'lucide-react';
import { Btn, Empty } from '@components/units';
import { useAnimeStore } from '@anime/store';
import { episodesOf, selectedEpisode, selectedSubject } from '@anime/selectors';
import { fmtClock } from '@anime/convert';
import { PLAYER_KEYS, SOURCE_KIND_LABEL } from '@anime/player-options';
import type { AnimePlaySource } from '@anime/types';
import { useAnimePlayback } from '@hooks';
import { Cover, EpisodeRow } from '@screens/anime/shared';

type SideTab = 'episodes' | 'info' | 'comments';

/** 画面区顶部那行状态（不做多级内联三元，规则见 AGENTS §2 第 10 条） */
function stageLine(loading: boolean, error: string | null, source: AnimePlaySource | null): string {
  if (loading) return '正在探测本地片源…';
  if (error) return '播放器起不来';
  if (!source || !source.found) return '尚无片源';
  if (!source.supported) return `需要播放内核 · ${source.container.toUpperCase()}`;
  return source.kind === 'hls' ? 'HLS 流' : `${source.container.toUpperCase()} · 本地文件`;
}

/** 倍速标签：`1` / `1.25` / `2`（不带多余的 0） */
function rateLabel(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
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
  const [tab, setTab] = useState<SideTab>('episodes');

  const idx = episode ? episodes.findIndex((e) => e.id === episode.id) : -1;
  const prev = idx > 0 ? episodes[idx - 1] : null;
  const next = idx >= 0 && idx < episodes.length - 1 ? episodes[idx + 1] : null;

  const { containerRef, source, loading, error, state, subtitleIndex, subtitles, controls } = useAnimePlayback({
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
  const durationMs = state.durationMs || episode.durationMs;
  const pct = durationMs ? Math.min(100, Math.round((state.positionMs / durationMs) * 100)) : 0;
  const bufferedPct = durationMs ? Math.min(100, Math.round((state.bufferedMs / durationMs) * 100)) : 0;
  const rate = state.rate || prefs.defaultRate;
  const subtitleName = subtitleIndex >= 0 ? (subtitles[subtitleIndex]?.name ?? '') : '';

  const seekByPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!playable || !durationMs) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    controls.seekMs(ratio * durationMs);
  };

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
          <button type="button" className="an-stage-btn" onClick={() => setView('source')} title="选择播放来源">
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

        <div className={`an-stage-mid${playable ? ' is-video' : ''}`}>
          {playable && <div className="an-stage-video" ref={containerRef} />}
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
                if (e.buttons === 1) seekByPointer(e);
              }}
            >
              <span className="an-seek-buf" style={{ width: `${bufferedPct}%` }} />
              <span className="an-seek-fill" style={{ width: `${pct}%` }} />
              <span className="an-seek-knob" style={{ left: `${pct}%` }} />
            </div>
            <span className="an-num">{fmtClock(durationMs)}</span>
          </div>
          <div className="an-ctl">
            <button
              type="button"
              className="an-stage-btn"
              disabled={!prev}
              title="上一集"
              onClick={() => prev && openPlayer(subject.id, prev.id)}
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
              disabled={!next}
              title="下一集"
              onClick={() => next && openPlayer(subject.id, next.id)}
            >
              <SkipForward size={17} />
            </button>
            <button
              type="button"
              className="an-rate"
              disabled={!playable}
              title="切换倍速（同时记为默认倍速）"
              onClick={() => setPref('defaultRate', controls.cycleRate())}
            >
              {rateLabel(rate)}
            </button>
            <span className="an-sp" />
            <button
              type="button"
              className="an-kbd"
              disabled={!playable}
              title="截一张当前帧"
              onClick={controls.screenshot}
            >
              截图
            </button>
            <button type="button" className="an-kbd" disabled title="统计面板待接入内核诊断">
              统计
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
              <b>{playable && source ? '内置源 · 本地番剧库' : '尚未选择来源'}</b>
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
    </div>
  );
}
