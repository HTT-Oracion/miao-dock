/**
 * 探索 / 搜索（设计稿 ①，双模式共用一格入口）。
 *
 * 两模式数据源相同（番剧库），区别只在呈现：探索按「继续观看 → 新番时间表 → 热度推荐」
 * 组织；搜索按关键词过滤成网格。合在一个组件里是因为两模式共用搜索栏与结果卡。
 */
import { useMemo } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { Btn, Empty, ErrorState, Skeleton } from '@components/units';
import { useAnimeStore } from '@anime/store';
import { historyFrom } from '@anime/selectors';
import { fmtClock } from '@anime/convert';
import { WEEKDAYS } from '@anime/player-options';
import { Cover, ProgressBar, SectionHead, SubjectCard } from '@screens/anime/shared';

export function DiscoverScreen() {
  const mode = useAnimeStore((s) => s.searchMode);
  const setMode = useAnimeStore((s) => s.setSearchMode);
  const query = useAnimeStore((s) => s.query);
  const setQuery = useAnimeStore((s) => s.setQuery);
  const subjects = useAnimeStore((s) => s.subjects);
  const episodes = useAnimeStore((s) => s.episodes);
  const loading = useAnimeStore((s) => s.loading);
  const loaded = useAnimeStore((s) => s.loaded);
  const error = useAnimeStore((s) => s.error);
  const refresh = useAnimeStore((s) => s.refreshLibrary);
  const openPlayer = useAnimeStore((s) => s.openPlayer);
  const select = useAnimeStore((s) => s.selectSubject);
  const setView = useAnimeStore((s) => s.setView);

  /** 搜索结果：只按关键词过滤，不吃追番 tab 的筛选（两个入口语义不同） */
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return subjects;
    return subjects.filter((x) => [x.title, x.titleOriginal ?? '', ...x.tags].join(' ').toLowerCase().includes(q));
  }, [query, subjects]);

  const resume = useMemo(() => historyFrom(subjects, episodes).slice(0, 4), [subjects, episodes]);
  const airing = useMemo(() => subjects.filter((x) => x.airing?.state === 'airing'), [subjects]);
  const hot = useMemo(() => [...subjects].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)).slice(0, 12), [subjects]);

  if (loading && !loaded) {
    return (
      <div className="an-screen an-pad">
        <Skeleton height={38} width={280} radius={10} />
        <div className="an-grid" style={{ marginTop: 16 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} height={196} radius={16} />
          ))}
        </div>
      </div>
    );
  }

  if (error && !loaded) {
    return (
      <div className="an-screen an-pad">
        <ErrorState
          title="番剧库读不出来"
          message={error}
          actions={
            <Btn kind="primary" onClick={() => void refresh()}>
              重试
            </Btn>
          }
        />
      </div>
    );
  }

  return (
    <div className="an-screen an-pad">
      <div className="an-discover-hd">
        <div className="an-modes" role="tablist" aria-label="入口模式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'explore'}
            className={mode === 'explore' ? 'an-mode is-on' : 'an-mode'}
            onClick={() => setMode('explore')}
          >
            探索
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'search'}
            className={mode === 'search' ? 'an-mode is-on' : 'an-mode'}
            onClick={() => setMode('search')}
          >
            搜索
          </button>
        </div>

        <label className="an-search">
          <Search size={14} />
          <input
            value={query}
            placeholder="搜番名、标签 —— 也可以直接粘 Bangumi 链接"
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setMode('search')}
          />
          {query ? (
            <button type="button" onClick={() => setQuery('')} title="清空">
              ✕
            </button>
          ) : null}
        </label>

        <span className="an-sp" />
        <Btn kind="ghost" size="sm" onClick={() => void refresh()} title="重新扫描番剧库">
          <RefreshCw size={13} /> 刷新
        </Btn>
      </div>

      {subjects.length === 0 ? (
        <Empty>
          <b>番剧库还空着</b>
          <div className="an-empty-sub">
            {error
              ? `服务没答上来：${error}`
              : '把番剧文件夹放进番剧根目录，或者先去「三态」页载入一份示例数据看看样子。'}
          </div>
          <div className="an-empty-acts">
            <Btn kind="primary" onClick={() => setView('states')}>
              载入示例数据
            </Btn>
            <Btn kind="ghost" onClick={() => void refresh()}>
              重新扫描
            </Btn>
          </div>
        </Empty>
      ) : mode === 'search' ? (
        <>
          <SectionHead title="搜索结果" count={results.length} />
          {results.length === 0 ? (
            <Empty inline>没搜到「{query}」。换个关键词，或者确认一下译名。</Empty>
          ) : (
            <div className="an-grid">
              {results.map((s) => (
                <SubjectCard
                  key={s.id}
                  subject={s}
                  episodes={episodes}
                  onOpen={() => select(s.id)}
                  onContinue={() => openPlayer(s.id)}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <SectionHead
            title="继续观看"
            count={resume.length}
            action={
              resume.length ? (
                <button type="button" className="an-link" onClick={() => setView('history')}>
                  全部历史
                </button>
              ) : null
            }
          />
          {resume.length === 0 ? (
            <Empty inline>还没开看。挑一部顺眼的，点「开始观看」就算入坑了。</Empty>
          ) : (
            <div className="an-resume">
              {resume.map(({ subject, episode }) => {
                const pct = episode.durationMs ? Math.round((episode.positionMs / episode.durationMs) * 100) : 0;
                return (
                  <button
                    key={episode.id}
                    type="button"
                    className="an-resume-card"
                    onClick={() => openPlayer(subject.id, episode.id)}
                  >
                    <Cover subject={subject} size="sm" />
                    <span className="an-resume-tx">
                      <b>{subject.title}</b>
                      <span>
                        第 {episode.index} 话 · 看到 {fmtClock(episode.positionMs)}
                      </span>
                      <ProgressBar value={pct} />
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <SectionHead title="新番时间表" count={airing.length} />
          {airing.length === 0 ? (
            <Empty inline>这一季还没有在追的连载。等它开播，或者去搜索里先点个「想补」。</Empty>
          ) : (
            <div className="an-week">
              {WEEKDAYS.map((w) => {
                const list = airing.filter((x) => x.airing?.weekday === w.idx);
                return (
                  <div key={w.idx} className="an-week-col">
                    <div className="an-week-hd">{w.label}</div>
                    {list.length === 0 ? (
                      <div className="an-week-none">—</div>
                    ) : (
                      list.map((s) => (
                        <button key={s.id} type="button" className="an-week-item" onClick={() => select(s.id)}>
                          {s.title}
                        </button>
                      ))
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <SectionHead title="热度推荐" count={hot.length} />
          <div className="an-grid">
            {hot.map((s) => (
              <SubjectCard
                key={s.id}
                subject={s}
                episodes={episodes}
                onOpen={() => select(s.id)}
                onContinue={() => openPlayer(s.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
