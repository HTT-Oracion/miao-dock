/**
 * 番剧屏内共用件 —— 只在番剧模块成立，因此留在屏目录（归属看依赖什么）。
 *
 * 这里只有「呈现形状」，不含数据获取：数据从 `@anime/store` 来，由各屏自己选取。
 */
import type { ReactNode } from 'react';
import type { AnimeEpisode, AnimeSubject, CollectionType, SyncState } from '@anime/types';
import { COLLECTION_LABELS } from '@anime/types';
import { displayTitle, fmtClock, progressOf, progressPct } from '@anime/convert';
import { useAnimeStore } from '@anime/store';
import { Btn } from '@components/units';

/** 封面：有图用图，没图用标题首字 + 稳定色块（离线也不空白） */
export function Cover({ subject, size = 'md' }: { subject: AnimeSubject; size?: 'sm' | 'md' | 'lg' }) {
  const char = subject.title.trim().slice(0, 1) || '番';
  const palette = ['p-blue', 'p-lav', 'p-pink', 'p-mint', 'p-sun'];
  const tone = palette[Math.abs(hash(subject.id)) % palette.length];
  return (
    <span className={`an-cover an-cover-${size} ${tone}`}>
      {subject.cover ? <img src={subject.cover} alt="" loading="lazy" /> : <span>{char}</span>}
    </span>
  );
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** 进度条 */
export function ProgressBar({ value, tone }: { value: number; tone?: 'ok' | 'warn' }) {
  return (
    <span className="an-bar" aria-hidden="true">
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} data-tone={tone ?? 'pink'} />
    </span>
  );
}

/** 段标题：标题 + 计数 + 右侧动作 */
export function SectionHead({ title, count, action }: { title: string; count?: number; action?: ReactNode }) {
  return (
    <div className="an-sec-hd">
      <b>{title}</b>
      {typeof count === 'number' ? <span className="an-sec-n">{count}</span> : null}
      <span className="an-sec-sp" />
      {action}
    </div>
  );
}

/** 同步态徽标：已同步走成功色，待同步/待合并走中性色（不与下载速度徽标混用） */
export function SyncChip({ state }: { state: SyncState }) {
  if (state === 'synced') return <span className="an-chip is-ok">已同步</span>;
  if (state === 'conflict') return <span className="an-chip">待合并</span>;
  return <span className="an-chip">待同步</span>;
}

/** 收藏态徽标 */
export function CollectionChip({ value }: { value: CollectionType | null | undefined }) {
  if (!value) return <span className="an-chip is-plain">未收藏</span>;
  return <span className={value === 'doing' ? 'an-chip is-hot' : 'an-chip is-plain'}>{COLLECTION_LABELS[value]}</span>;
}

/** 条目卡片：封面 + 标题 + 连载态 + 进度 + 继续观看 */
export function SubjectCard({
  subject,
  episodes,
  onOpen,
  onContinue,
}: {
  subject: AnimeSubject;
  episodes: AnimeEpisode[];
  onOpen: () => void;
  onContinue: () => void;
}) {
  const titleMode = useAnimeStore((s) => s.prefs.titleMode);
  const title = displayTitle(subject, titleMode);
  const watched = progressOf(subject, episodes);
  const total = subject.episodesTotal ?? episodes.filter((e) => e.subjectId === subject.id).length;
  const pct = progressPct(watched, total);
  return (
    <article className="an-card">
      <Btn kind="bare" type="button" className="an-card-cover" onClick={onOpen} title="查看条目">
        <Cover subject={subject} size="md" />
        {subject.rating ? <span className="an-card-score">{subject.rating.toFixed(1)}</span> : null}
      </Btn>
      <div className="an-card-body">
        <Btn kind="bare" type="button" className="an-card-name" onClick={onOpen} title={title}>
          {title}
        </Btn>
        <div className="an-card-meta">
          <span className={subject.airing?.state === 'airing' ? 'an-dot is-live' : 'an-dot'} />
          {subject.airing?.state === 'airing' ? `连载至第 ${subject.airing.latest ?? watched} 话` : '已完结'}
          {total ? ` · 全 ${total} 话` : ''}
        </div>
        <div className="an-card-tags">
          <CollectionChip value={subject.collection} />
          {subject.tags.slice(0, 2).map((t) => (
            <span key={t} className="an-tag">
              {t}
            </span>
          ))}
        </div>
        <div className="an-card-prog">
          <div className="an-card-lb">
            <span>
              已看 {watched} / {total || '?'}
            </span>
            <span className="an-num">{pct}%</span>
          </div>
          <ProgressBar value={pct} tone={pct >= 100 ? 'ok' : undefined} />
        </div>
        <Btn kind="bare" type="button" className="an-card-play" onClick={onContinue}>
          {watched > 0 && watched < (total || Number.MAX_SAFE_INTEGER) ? `继续观看 第 ${watched + 1} 话` : '开始观看'}
        </Btn>
      </div>
    </article>
  );
}

/** 集行（详情选集 / 播放器侧栏 / 历史共用） */
export function EpisodeRow({
  episode,
  onPlay,
  onToggleWatched,
}: {
  episode: AnimeEpisode;
  onPlay: () => void;
  onToggleWatched?: () => void;
}) {
  const pct = episode.durationMs > 0 ? Math.round((episode.positionMs / episode.durationMs) * 100) : 0;
  return (
    <div className={episode.watched ? 'an-ep is-done' : 'an-ep'}>
      <Btn kind="bare" type="button" className="an-ep-main" onClick={onPlay} title={`播放第 ${episode.index} 话`}>
        <span className="an-ep-no">{Number.isInteger(episode.index) ? episode.index : episode.index.toFixed(1)}</span>
        <span className="an-ep-tx">
          <b>{episode.title}</b>
          <span>
            {episode.durationMs > 0 ? fmtClock(episode.durationMs) : '时长未知'} ·{' '}
            {episode.watched ? '已看完' : pct > 0 ? `看到 ${fmtClock(episode.positionMs)}` : '未观看'}
          </span>
          {pct > 0 && !episode.watched ? <ProgressBar value={pct} /> : null}
        </span>
      </Btn>
      {onToggleWatched ? (
        <Btn
          kind="bare"
          type="button"
          className="an-ep-ck"
          onClick={onToggleWatched}
          title={episode.watched ? '取消看完' : '标记看完'}
        >
          {episode.watched ? '✓' : '○'}
        </Btn>
      ) : null}
    </div>
  );
}

/** 数值标签（统计三格） */
export function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="an-stat">
      <b className="an-num">{value}</b>
      <span>{label}</span>
    </div>
  );
}
