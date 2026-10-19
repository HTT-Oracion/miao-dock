/**
 * 条目详情（设计稿 ④）：左信息栏 + 右内容流（双栏）。
 *
 * 断点口径：本窗口 1400 → 双栏；≥1600 时右栏末尾内容移入独立 rail。
 * 这里只做双栏 —— 三栏是同一份内容的排布，不额外复制一套 DOM。
 */
import { useMemo } from 'react';
import { ArrowLeft, Play } from 'lucide-react';
import { Btn, Empty } from '@components/units';
import { useAnimeStore } from '@anime/store';
import { episodesOf, selectedSubject } from '@anime/selectors';
import { fmtClock, progressOf, progressPct } from '@anime/convert';
import { COLLECTION_LABELS, COLLECTION_ORDER } from '@anime/types';
import { CollectionChip, Cover, EpisodeRow, ProgressBar, SectionHead, Stat } from '@screens/anime/shared';

export function DetailScreen() {
  const subject = useAnimeStore(selectedSubject);
  const allEpisodes = useAnimeStore((s) => s.episodes);
  const episodes = useMemo(() => episodesOf(subject?.id ?? null, allEpisodes), [subject?.id, allEpisodes]);
  const setView = useAnimeStore((s) => s.setView);
  const setCollection = useAnimeStore((s) => s.setCollection);
  const openPlayer = useAnimeStore((s) => s.openPlayer);
  const markWatched = useAnimeStore((s) => s.markWatched);

  if (!subject) {
    return (
      <div className="an-screen an-pad">
        <Empty>
          <b>还没选条目</b>
          <div className="an-empty-sub">从探索或追番里挑一部，详情会开在这里。</div>
          <div className="an-empty-acts">
            <Btn kind="primary" onClick={() => setView('explore')}>
              去探索
            </Btn>
          </div>
        </Empty>
      </div>
    );
  }

  const watched = progressOf(subject, episodes);
  const pct = progressPct(watched, subject.episodesTotal);
  const rating = subject.rating ?? null;

  return (
    <div className="an-screen an-detail">
      <aside className="an-detail-side">
        <div className="an-detail-cover">
          <Cover subject={subject} size="lg" />
        </div>
        <button type="button" className="btn btn-primary an-detail-play" onClick={() => openPlayer(subject.id)}>
          <Play size={15} /> {watched > 0 ? `继续观看 第 ${watched + 1} 话` : '开始观看'}
        </button>

        <div className="an-detail-coll">
          {COLLECTION_ORDER.map((c) => (
            <button
              key={c}
              type="button"
              className={subject.collection === c ? 'an-chip is-hot' : 'an-chip is-plain'}
              onClick={() => void setCollection(subject.id, subject.collection === c ? null : c)}
            >
              {COLLECTION_LABELS[c]}
            </button>
          ))}
        </div>

        <div className="an-stats">
          <Stat label="已看" value={watched} />
          <Stat label="总集数" value={subject.episodesTotal ?? (episodes.length || '—')} />
          <Stat label="评分" value={rating ? rating.toFixed(1) : '—'} />
        </div>

        <dl className="an-info">
          {subject.year ? (
            <>
              <dt>年份</dt>
              <dd className="an-num">{subject.year}</dd>
            </>
          ) : null}
          {subject.season ? (
            <>
              <dt>季度</dt>
              <dd className="an-num">{subject.season}</dd>
            </>
          ) : null}
          <dt>状态</dt>
          <dd>
            <CollectionChip value={subject.collection} />
          </dd>
        </dl>

        {subject.tags.length ? (
          <div className="an-detail-tags">
            {subject.tags.map((t) => (
              <span key={t} className="an-tag">
                {t}
              </span>
            ))}
          </div>
        ) : null}
      </aside>

      <div className="an-detail-main an-scroll">
        <div className="an-detail-top">
          <button type="button" className="an-back" onClick={() => setView('collection')} title="返回追番">
            <ArrowLeft size={15} /> 返回
          </button>
          <h2>{subject.title}</h2>
          {subject.titleOriginal && subject.titleOriginal !== subject.title ? (
            <div className="an-detail-sub">{subject.titleOriginal}</div>
          ) : null}
          <div className="an-detail-bar">
            <span>
              已看 {watched} / {subject.episodesTotal ?? '?'}
            </span>
            <span className="an-num">{pct}%</span>
          </div>
          <ProgressBar value={pct} tone={pct >= 100 ? 'ok' : undefined} />
        </div>

        {rating ? (
          <section className="an-detail-sec">
            <SectionHead title="评分" action={<span className="an-num">{rating.toFixed(1)} / 10</span>} />
            <div className="an-hist">
              <div className="an-hist-bar">
                <span className="an-num">{rating.toFixed(1)}</span>
                <i style={{ width: `${Math.round((rating / 10) * 100)}%` }} />
              </div>
            </div>
          </section>
        ) : null}

        {subject.summary ? (
          <section className="an-detail-sec">
            <SectionHead title="简介" />
            <p className="an-summary">{subject.summary}</p>
          </section>
        ) : null}

        <section className="an-detail-sec">
          <SectionHead title="选集" count={episodes.length} />
          {episodes.length === 0 ? (
            <Empty inline>还没有剧集信息。往这部番的目录里放集文件夹（一集一个目录）后重新扫描。</Empty>
          ) : (
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
          )}
        </section>

        <section className="an-detail-sec">
          <SectionHead title="制作人员 / 关联作品" />
          <Empty inline>元数据接入后会显示制作人员、角色与关联作品；点进去是独立页，不在详情里堆长列表。</Empty>
        </section>

        <section className="an-detail-sec">
          <SectionHead title="热门评价" action={<span className="an-note">只读预览 · 写入口预留</span>} />
          <Empty inline>评价数据随元数据一起接入；本期只读，发评入口预留。</Empty>
        </section>

        <div className="an-note">
          最长一集 {episodes.length ? fmtClock(Math.max(...episodes.map((e) => e.durationMs))) : '—'} · 共{' '}
          {episodes.length} 集
        </div>
      </div>
    </div>
  );
}
