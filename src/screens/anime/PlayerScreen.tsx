/**
 * 播放器（设计稿 ⑤）：画面 + 选集侧栏。
 *
 * ⚠️ 本期还没有接播放内核（M2）：控制条按最终形状渲染但**禁用**，画面区给「去选来源」。
 * 不画一条假的播放进度 —— 进度是事实，不是占位内容。
 * M2 接入后这里换成两轨共用的控制层（libmpv / hls.js 对上层透明）。
 */
import { useMemo, useState } from 'react';
import { ArrowLeft, ListMusic, Maximize2, Play, Settings2, SkipBack, SkipForward } from 'lucide-react';
import { Btn, Empty } from '@components/units';
import { useAnimeStore } from '@anime/store';
import { episodesOf, selectedEpisode, selectedSubject } from '@anime/selectors';
import { fmtClock } from '@anime/convert';
import { PLAYER_KEYS, SOURCE_KIND_LABEL } from '@anime/player-options';
import { Cover, EpisodeRow } from '@screens/anime/shared';

type SideTab = 'episodes' | 'info' | 'comments';

export function PlayerScreen() {
  const subject = useAnimeStore(selectedSubject);
  const episode = useAnimeStore(selectedEpisode);
  const allEpisodes = useAnimeStore((s) => s.episodes);
  const episodes = useMemo(() => episodesOf(subject?.id ?? null, allEpisodes), [subject?.id, allEpisodes]);
  const setView = useAnimeStore((s) => s.setView);
  const openPlayer = useAnimeStore((s) => s.openPlayer);
  const markWatched = useAnimeStore((s) => s.markWatched);
  const rate = useAnimeStore((s) => s.prefs.defaultRate);
  const [tab, setTab] = useState<SideTab>('episodes');

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

  const pct = episode.durationMs ? Math.round((episode.positionMs / episode.durationMs) * 100) : 0;
  const idx = episodes.findIndex((e) => e.id === episode.id);
  const prev = idx > 0 ? episodes[idx - 1] : null;
  const next = idx >= 0 && idx < episodes.length - 1 ? episodes[idx + 1] : null;

  return (
    <div className="an-player">
      <div className="an-stage">
        <div className="an-stage-bg">
          <Cover subject={subject} size="lg" />
        </div>

        <div className="an-stage-top">
          <button type="button" className="an-stage-btn" onClick={() => setView('detail')} title="返回条目详情">
            <ArrowLeft size={16} />
          </button>
          <div className="an-stage-tt">
            <b>{subject.title}</b>
            <span>
              第 {episode.index} 话「{episode.title}」· 尚无片源
            </span>
          </div>
          <button type="button" className="an-stage-btn" onClick={() => setView('source')} title="选择播放来源">
            <Settings2 size={16} />
          </button>
          <button type="button" className="an-stage-btn" disabled title="全屏（接入播放内核后可用）">
            <Maximize2 size={16} />
          </button>
        </div>

        <div className="an-stage-mid">
          <div className="an-stage-empty">
            <b>这集还没有片源</b>
            <span>先选一个播放来源：在线源、BT 边下边播或媒体服务器都行。</span>
            <Btn kind="primary" onClick={() => setView('source')}>
              去选来源
            </Btn>
          </div>
        </div>

        {/* 控制条：形状先立好，动作在接入内核后启用 —— 禁用比"点了没反应"诚实 */}
        <div className="an-stage-bar">
          <div className="an-seek">
            <span className="an-num">{fmtClock(episode.positionMs)}</span>
            <div className="an-seek-track">
              <span className="an-seek-buf" />
              <span className="an-seek-fill" style={{ width: `${pct}%` }} />
              <span className="an-seek-knob" style={{ left: `${pct}%` }} />
            </div>
            <span className="an-num">{fmtClock(episode.durationMs)}</span>
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
            <button type="button" className="an-bigplay" disabled title="接入播放内核后可用">
              {/* 内核未接，暂停态不可达：只画播放图标，不做 `false ? …` 的假分支 */}
              <Play size={16} />
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
            <button type="button" className="an-rate" disabled title="倍速（接入内核后可用）">
              {rate.toFixed(2).replace(/0$/, '')}×
            </button>
            <span className="an-sp" />
            <button type="button" className="an-kbd" disabled>
              截图
            </button>
            <button type="button" className="an-kbd" disabled>
              统计
            </button>
            <button type="button" className="an-kbd" disabled>
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
              <b>尚未选择来源</b>
              <span>选好之后这里显示「来源 · 清晰度 · 字幕」</span>
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
                <b className="an-num">{episode.durationMs ? fmtClock(episode.durationMs) : '未知'}</b>
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
