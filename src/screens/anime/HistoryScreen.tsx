/**
 * 播放历史（设计稿 ⑦）：续播位置列表 + 同步态 + 筛选。
 *
 * 三处版面纪律（上一轮修版的结论）：
 * ① 列表收宽 920 居中 —— 通栏会把文字与按钮推到两极；
 * ② 同步态徽标进行内 meta 行，右簇只留主按钮 —— 状态与动作不同层；
 * ③ 「待同步 / 待合并」必须能一键筛出，不能让人翻完整张表。
 */
import { useMemo, useState } from 'react';
import { Play } from 'lucide-react';
import { Empty } from '@components/units';
import { useAnimeStore } from '@anime/store';
import { historyFrom } from '@anime/selectors';
import { fmtClock } from '@anime/convert';
import { Cover, ProgressBar, SyncChip } from '@screens/anime/shared';

type FilterId = 'all' | 'pending' | 'conflict';

export function HistoryScreen() {
  const subjects = useAnimeStore((s) => s.subjects);
  const episodes = useAnimeStore((s) => s.episodes);
  const openPlayer = useAnimeStore((s) => s.openPlayer);
  const select = useAnimeStore((s) => s.selectSubject);
  const conflicts = useAnimeStore((s) => s.conflicts);
  const syncQueue = useAnimeStore((s) => s.syncQueue);
  const [filter, setFilter] = useState<FilterId>('all');

  const rows = useMemo(() => historyFrom(subjects, episodes), [subjects, episodes]);
  const pendingCount = syncQueue.filter((t) => t.state !== 'pushed').length;
  const conflictCount = conflicts.length;

  const list = useMemo(() => {
    if (filter === 'conflict') return rows.filter((r) => conflicts.some((c) => c.subjectTitle === r.subject.title));
    if (filter === 'pending') return rows.filter((r) => syncQueue.some((t) => t.label.includes(r.subject.title)));
    return rows;
  }, [conflicts, filter, rows, syncQueue]);

  return (
    <div className="an-screen an-pad">
      <div className="an-hist-wrap">
        <div className="an-hist-hd">
          <b>播放历史</b>
          <div className="an-hist-stats">
            <span>{rows.length} 条</span>
            <i />
            <span>
              本地 {rows.length} / 云端 {Math.max(0, rows.length - pendingCount)}
            </span>
            <i />
            <span>{pendingCount + conflictCount ? `${pendingCount + conflictCount} 条待处理` : '都已同步'}</span>
          </div>
        </div>

        <div className="an-filters">
          <button
            type="button"
            className={filter === 'all' ? 'an-fchip is-on' : 'an-fchip'}
            onClick={() => setFilter('all')}
          >
            全部 {rows.length}
          </button>
          <button
            type="button"
            className={filter === 'pending' ? 'an-fchip is-on' : 'an-fchip'}
            onClick={() => setFilter('pending')}
          >
            待同步 {pendingCount}
          </button>
          <button
            type="button"
            className={filter === 'conflict' ? 'an-fchip is-on' : 'an-fchip'}
            onClick={() => setFilter('conflict')}
          >
            待合并 {conflictCount}
          </button>
        </div>

        {list.length === 0 ? (
          <Empty>
            <b>还没有播放记录</b>
            <div className="an-empty-sub">看过一集之后，这里会记住你停在哪，下次直接接着看。</div>
          </Empty>
        ) : (
          list.map(({ subject, episode }) => {
            const pct = episode.durationMs ? Math.round((episode.positionMs / episode.durationMs) * 100) : 0;
            const state = conflicts.some((c) => c.subjectTitle === subject.title)
              ? 'conflict'
              : syncQueue.some((t) => t.label.includes(subject.title))
                ? 'pending'
                : 'synced';
            return (
              <div key={episode.id} className={state === 'conflict' ? 'an-hist-row is-dashed' : 'an-hist-row'}>
                <button type="button" className="an-hist-cover" onClick={() => select(subject.id)} title="查看条目">
                  <Cover subject={subject} size="sm" />
                </button>
                <span className="an-hist-tx">
                  <b>{subject.title}</b>
                  <span className="an-hist-ep">
                    第 {episode.index} 话 · 看到 {fmtClock(episode.positionMs)} / {fmtClock(episode.durationMs)}
                    <SyncChip state={state} />
                  </span>
                  <ProgressBar value={pct} tone={episode.watched ? 'ok' : undefined} />
                </span>
                <span className="an-hist-rt">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => openPlayer(subject.id, episode.id)}
                  >
                    <Play size={12} /> 继续看
                  </button>
                </span>
              </div>
            );
          })
        )}
        <div className="an-note">续播位置每条一行；「待同步 / 待合并」可一键筛出，不用翻完整表。</div>
      </div>
    </div>
  );
}
