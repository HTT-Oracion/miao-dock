/**
 * 缓存（设计稿 ③）：总占用 + 状态筛选 + 按条目分组 + 分集下载行。
 *
 * 数据来自 `animesvc`（M5 前为空数组 —— 不编造进度条）。
 * 空态必须给出「怎么才会不空」：去数据源挑源、或设置缓存目录。
 */
import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Btn, Empty } from '@components/units';
import { formatBytes } from '@tools';
import { useAnimeStore } from '@anime/store';
import { fmtClock } from '@anime/convert';
import { ProgressBar, SectionHead } from '@screens/anime/shared';

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'downloading', label: '下载中' },
  { id: 'done', label: '已完成' },
  { id: 'paused', label: '已暂停' },
  { id: 'failed', label: '失败' },
] as const;

type FilterId = (typeof FILTERS)[number]['id'];

export function CacheScreen() {
  const cache = useAnimeStore((s) => s.cache);
  const subjects = useAnimeStore((s) => s.subjects);
  const setView = useAnimeStore((s) => s.setView);
  const [filter, setFilter] = useState<FilterId>('all');

  const totals = useMemo(() => {
    const total = cache.reduce((n, t) => n + t.sizeBytes, 0);
    const done = cache.filter((t) => t.state === 'done' || t.state === 'seeding').reduce((n, t) => n + t.sizeBytes, 0);
    return { total, done, active: total - done, count: cache.length };
  }, [cache]);

  const groups = useMemo(() => {
    const map = new Map<string, { title: string; rows: typeof cache; size: number }>();
    for (const t of cache) {
      if (filter !== 'all' && t.state !== filter) continue;
      const g = map.get(t.subjectId) ?? {
        title: subjects.find((s) => s.id === t.subjectId)?.title ?? t.title,
        rows: [],
        size: 0,
      };
      g.rows.push(t);
      g.size += t.sizeBytes;
      map.set(t.subjectId, g);
    }
    return [...map.values()].sort((a, b) => b.size - a.size);
  }, [cache, filter, subjects]);

  return (
    <div className="an-screen an-pad">
      <div className="an-cache-stat">
        <div className="an-cache-total">
          <span>总缓存占用</span>
          <b className="an-num">{formatBytes(totals.total)}</b>
          <small>
            {groups.length} 部番剧 · {totals.count} 个任务
          </small>
        </div>
        <div className="an-cache-legend">
          <span>
            <i className="is-done" /> 已完成 {formatBytes(totals.done)}
          </span>
          <span>
            <i className="is-live" /> 下载中 {formatBytes(totals.active)}
          </span>
        </div>
      </div>

      <div className="an-filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={filter === f.id ? 'an-fchip is-on' : 'an-fchip'}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            {f.id === 'all' ? ` ${cache.length}` : ''}
          </button>
        ))}
      </div>

      {groups.length === 0 ? (
        <Empty>
          <b>缓存是空的</b>
          <div className="an-empty-sub">把想囤的番先下下来，通勤路上没网也能看。BT 源在「数据源与 BT」里挑。</div>
          <div className="an-empty-acts">
            <Btn kind="primary" onClick={() => setView('source')}>
              <Download size={13} /> 挑几集下载
            </Btn>
          </div>
        </Empty>
      ) : (
        groups.map((g) => (
          <section key={g.title} className="an-cache-group">
            <SectionHead
              title={g.title}
              count={g.rows.length}
              action={<span className="an-num">{formatBytes(g.size)}</span>}
            />
            {g.rows.map((t) => (
              <div key={t.id} className="an-dl-row">
                <span className="an-dl-no">{t.episodeIndex}</span>
                <span className="an-dl-tx">
                  <b>
                    第 {t.episodeIndex} 话 · {t.title}
                  </b>
                  <span className="an-dl-sub">
                    {t.state === 'downloading'
                      ? `${formatBytes(t.receivedBytes)} / ${formatBytes(t.sizeBytes)}`
                      : t.state === 'paused'
                        ? '已暂停'
                        : t.state === 'failed'
                          ? '下载失败'
                          : '已完成'}
                    {t.bufferedMs ? ` · 边下边播已缓冲 ${fmtClock(t.bufferedMs)}` : ''}
                  </span>
                  <ProgressBar
                    value={t.sizeBytes ? Math.round((t.receivedBytes / t.sizeBytes) * 100) : 0}
                    tone={t.state === 'done' ? 'ok' : t.state === 'paused' ? 'warn' : undefined}
                  />
                </span>
                <span className="an-dl-st">
                  {t.state === 'downloading'
                    ? '下载中'
                    : t.state === 'done'
                      ? '已完成'
                      : t.state === 'paused'
                        ? '已暂停'
                        : t.state === 'failed'
                          ? '失败'
                          : '做种中'}
                </span>
              </div>
            ))}
          </section>
        ))
      )}
    </div>
  );
}
