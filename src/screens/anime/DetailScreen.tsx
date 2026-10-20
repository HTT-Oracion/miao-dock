/**
 * 条目详情（设计稿 ④）：左信息栏 + 右内容流（双栏）。
 *
 * 断点口径：本窗口 1400 → 双栏；≥1600 时右栏末尾内容移入独立 rail。
 * 这里只做双栏 —— 三栏是同一份内容的排布，不额外复制一套 DOM。
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Play, Wand2 } from 'lucide-react';
import { Btn, Empty, Skeleton } from '@components/units';
import { useToasts } from '@hooks';
import { useAnimeStore } from '@anime/store';
import { episodesOf, selectedSubject } from '@anime/selectors';
import { displayTitle, fmtClock, progressOf, progressPct } from '@anime/convert';
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
  const fillMetadata = useAnimeStore((s) => s.fillMetadata);
  const titleMode = useAnimeStore((s) => s.prefs.titleMode);
  const loadDetailExtra = useAnimeStore((s) => s.loadDetailExtra);
  const extra = useAnimeStore((s) => s.detailExtra);
  const subjects = useAnimeStore((s) => s.subjects);
  const selectSubject = useAnimeStore((s) => s.selectSubject);
  const importCandidate = useAnimeStore((s) => s.importCandidate);
  const metaCandidates = useAnimeStore((s) => s.metaCandidates);
  const applyMetadataCandidate = useAnimeStore((s) => s.applyMetadataCandidate);
  const clearMetaCandidates = useAnimeStore((s) => s.clearMetaCandidates);
  const { push } = useToasts();
  const [metaBusy, setMetaBusy] = useState(false);

  const bgmId = subject?.bgmId ?? null;
  // 有 Bangumi id 就拉一次补充数据（角色 / 制作 / 关联）；换条目才重拉
  useEffect(() => {
    if (bgmId) void loadDetailExtra(bgmId);
  }, [bgmId, loadDetailExtra]);

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
        <Btn
          kind="ghost"
          size="sm"
          disabled={metaBusy}
          title="从 Bangumi 拉取封面 / 评分 / 简介 / 标签（不改收藏态与进度）"
          onClick={() => {
            setMetaBusy(true);
            void fillMetadata(subject.id)
              .then((r) => push(r.message, r.ok ? 'good' : 'bad'))
              .finally(() => setMetaBusy(false));
          }}
        >
          <Wand2 size={13} /> {metaBusy ? '正在补全…' : '补全信息'}
        </Btn>

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
          <h2>{displayTitle(subject, titleMode)}</h2>
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

        {metaCandidates?.dir === subject.id ? (
          <section className="an-detail-sec">
            <SectionHead
              title="选择要补全的条目"
              count={metaCandidates.list.length}
              action={
                <button type="button" className="an-link" onClick={clearMetaCandidates}>
                  取消
                </button>
              }
            />
            <div className="an-cand-list">
              {metaCandidates.list.map((c) => {
                const meta =
                  [
                    c.year ?? '',
                    c.rating ? `${c.rating.toFixed(1)} 分` : '',
                    c.episodesTotal ? `${c.episodesTotal} 集` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ') || c.name;
                return (
                  <div key={c.bgmId} className="an-cand-row">
                    <span className="an-cand-pic">
                      {c.cover ? (
                        <img src={c.cover} alt="" loading="lazy" />
                      ) : (
                        <span>{(c.nameCn || c.name).slice(0, 1)}</span>
                      )}
                    </span>
                    <span className="an-cand-tx">
                      <b>{c.nameCn || c.name}</b>
                      <span>{meta}</span>
                    </span>
                    <Btn
                      kind="primary"
                      size="sm"
                      onClick={() =>
                        void applyMetadataCandidate(subject.id, c.bgmId).then((r) =>
                          push(r.message, r.ok ? 'good' : 'bad'),
                        )
                      }
                    >
                      用这个
                    </Btn>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {rating ? (
          <section className="an-detail-sec">
            <SectionHead title="评分" action={<span className="an-num">{rating.toFixed(1)} / 10</span>} />
            {/* v0 只给 score / rank / collection_total，没有分档人数 —— 不画直方图，避免编数据 */}
            <div className="an-detail-stats">
              <Stat label="评分" value={rating.toFixed(1)} />
              <Stat label="排名" value={subject.rank ? `#${subject.rank}` : '—'} />
              <Stat label="收藏" value={subject.collectionTotal ? String(subject.collectionTotal) : '—'} />
            </div>
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
          <SectionHead
            title="角色"
            count={extra?.characters.length}
            action={
              subject.bgmId ? (
                <button type="button" className="an-link" onClick={() => void loadDetailExtra(subject.bgmId as number)}>
                  刷新
                </button>
              ) : null
            }
          />
          {!subject.bgmId ? (
            <Empty inline>先在左侧点「补全信息」拿到 Bangumi 条目 id，角色与声优才拉得到。</Empty>
          ) : extra?.loading ? (
            <Skeleton height={88} radius={12} />
          ) : extra?.error ? (
            <div className="an-note">角色没拉到：{extra.error}</div>
          ) : extra && extra.characters.length > 0 ? (
            <div className="an-cast">
              {extra.characters.map((c) => (
                <div key={c.id} className="an-cast-item">
                  <span className="an-cast-pic">
                    {c.image ? (
                      <img src={c.image} alt="" loading="lazy" />
                    ) : (
                      <span>{c.nameCn.slice(0, 1) || c.name.slice(0, 1)}</span>
                    )}
                  </span>
                  <span className="an-cast-tx">
                    <b>{c.nameCn || c.name}</b>
                    <span>{c.relation || '角色'}</span>
                    {c.actors.length ? (
                      <span className="an-note">CV {c.actors.map((a) => a.name).join(' / ')}</span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty inline>这部番还没有角色数据。</Empty>
          )}
        </section>

        <section className="an-detail-sec">
          <SectionHead title="制作人员" count={extra?.staff.length} />
          {!subject.bgmId ? (
            <Empty inline>补全信息后显示制作人员。</Empty>
          ) : extra?.staff.length ? (
            <div className="an-tags">
              {extra.staff.map((p) => (
                <span key={p.id} className="an-tag" title={p.career.join(' / ')}>
                  {p.relation ? `${p.relation} · ` : ''}
                  {p.name}
                </span>
              ))}
            </div>
          ) : extra?.loading ? (
            <Skeleton height={40} radius={10} />
          ) : (
            <Empty inline>没有制作人员数据。</Empty>
          )}
        </section>

        <section className="an-detail-sec">
          <SectionHead title="关联作品" count={extra?.related.length} />
          {!subject.bgmId ? (
            <Empty inline>补全信息后显示关联作品（续作 / 同系列 / 剧场版）。</Empty>
          ) : extra?.related.length ? (
            <div className="an-grid">
              {extra.related.map((r) => {
                const local = subjects.find((x) => x.bgmId === r.bgmId);
                return (
                  <button
                    key={r.bgmId}
                    type="button"
                    className="an-cand an-cand-mini"
                    title={local ? '已在库，打开条目' : '加入番剧库'}
                    onClick={() => {
                      if (local) {
                        selectSubject(local.id);
                        return;
                      }
                      void importCandidate(r.bgmId).then((res) => push(res.message, res.ok ? 'good' : 'bad'));
                    }}
                  >
                    <span className="an-cand-pic">
                      {r.image ? (
                        <img src={r.image} alt="" loading="lazy" />
                      ) : (
                        <span>{(r.nameCn || r.name).slice(0, 1)}</span>
                      )}
                    </span>
                    <span className="an-cand-tx">
                      <b>{r.nameCn || r.name}</b>
                      <span>{r.relation || '关联'}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : extra?.loading ? (
            <Skeleton height={72} radius={12} />
          ) : (
            <Empty inline>没有关联作品数据。</Empty>
          )}
        </section>

        <section className="an-detail-sec">
          <SectionHead title="热门评价" action={<span className="an-note">只读预览 · 写入口预留</span>} />
          <Empty inline>Bangumi v0 没有公开的评价（短评）端点，这一块等上游契约明确后再接。</Empty>
        </section>

        <div className="an-note">
          最长一集 {episodes.length ? fmtClock(Math.max(...episodes.map((e) => e.durationMs))) : '—'} · 共{' '}
          {episodes.length} 集
        </div>
      </div>
    </div>
  );
}
