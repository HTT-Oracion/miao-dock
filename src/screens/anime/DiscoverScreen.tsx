/**
 * 探索 / 搜索（设计稿 ①，双模式共用一格入口）。
 *
 * 数据来源（2026-10-20 起，R2）：
 * · **继续观看** —— 本地库（manifest 里的进度），永远可用；
 * · **新番时间表** —— Bangumi `/calendar`（整条 subject，按周几分组）；
 * · **热度推荐** —— Bangumi 检索的 `sort: heat`；上游不支持时服务侧退回排行，
 *   回执里的 `source` 决定标题写「热度推荐」还是「高分排行」；
 * · **搜索** —— Bangumi 检索（350ms 防抖），本地库命中优先给「查看」，
 *   库里没有的给「加入追番」（建条目、还没有片源）。
 *
 * 断网时**不清空本地内容**：错误只作为一条提示挂在在线版块上方，并保留本地库结果。
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, Search } from 'lucide-react';
import { Btn, Empty, ErrorState, Skeleton } from '@components/units';
import { useToasts } from '@hooks';
import * as ipc from '@anime/ipc';
import { useAnimeStore } from '@anime/store';
import { historyFrom } from '@anime/selectors';
import { errText, fmtClock, looksLikeBgmRef } from '@anime/convert';
import { WEEKDAYS } from '@anime/player-options';
import type { AnimeEpisode, AnimeMetadataCandidate, AnimeSearchFilters, AnimeSubject } from '@anime/types';
import { Cover, ProgressBar, SectionHead, SubjectCard } from '@screens/anime/shared';

/** 搜索防抖：每敲一个字都打一次上游既慢又容易被限流 */
const SEARCH_DEBOUNCE_MS = 350;

/** 候选卡片（Bangumi 条目，可能不在库里）：封面 + 标题 + 年份/评分 + 动作 */
function CandidateCard({
  item,
  inLibrary,
  onOpen,
}: {
  item: AnimeMetadataCandidate;
  inLibrary: boolean;
  onOpen: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const title = item.nameCn || item.name;
  const meta = [
    item.year ?? '',
    item.rating ? `${item.rating.toFixed(1)} 分` : '',
    item.episodesTotal ? `${item.episodesTotal} 集` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <article className="an-card an-cand">
      <button type="button" className="an-card-cover" onClick={onOpen} title={inLibrary ? '查看条目' : '加入番剧库'}>
        {item.cover && !broken ? (
          <img src={item.cover} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : (
          <span className="an-cover an-cover-md p-lav">
            <span>{title.slice(0, 1)}</span>
          </span>
        )}
        {item.rating ? <span className="an-card-score">{item.rating.toFixed(1)}</span> : null}
      </button>
      <div className="an-card-body">
        <button type="button" className="an-card-name" onClick={onOpen} title={title}>
          {title}
        </button>
        <div className="an-card-meta">
          <span className={inLibrary ? 'an-dot is-live' : 'an-dot'} />
          <span className="an-note">{inLibrary ? '已在库' : '未入库'}</span>
        </div>
        {meta ? <div className="an-note">{meta}</div> : null}
        <div className="an-card-prog">
          <button type="button" className="an-card-play" onClick={onOpen}>
            {inLibrary ? (
              '查看'
            ) : (
              <>
                <Plus size={12} /> 加入追番
              </>
            )}
          </button>
        </div>
      </div>
    </article>
  );
}

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
  const calendar = useAnimeStore((s) => s.calendar);
  const hot = useAnimeStore((s) => s.hot);
  const hotSource = useAnimeStore((s) => s.hotSource);
  const exploreLoading = useAnimeStore((s) => s.exploreLoading);
  const exploreError = useAnimeStore((s) => s.exploreError);
  const loadExplore = useAnimeStore((s) => s.loadExplore);
  const importCandidate = useAnimeStore((s) => s.importCandidate);
  const importByRef = useAnimeStore((s) => s.importByRef);
  const filters = useAnimeStore((s) => s.searchFilters);
  const setFilter = useAnimeStore((s) => s.setSearchFilter);
  const resetFilters = useAnimeStore((s) => s.resetSearchFilters);
  const { push } = useToasts();

  const [cands, setCands] = useState<AnimeMetadataCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  /** 搜索重试计数：塞进 effect 依赖，重跑同一条查询 */
  const [searchTick, setSearchTick] = useState(0);

  // 首次进探索页拉一次在线数据（失败不阻塞本地内容）
  useEffect(() => {
    void loadExplore();
  }, [loadExplore]);

  // 搜索：在线候选（防抖）；空关键词回到本地库过滤；粘的是条目链接则走建库
  useEffect(() => {
    if (mode !== 'search') return;
    const q = query.trim();
    if (!q || looksLikeBgmRef(q)) {
      setCands(null);
      setSearchError(null);
      setSearching(false);
      return;
    }
    let alive = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void ipc
        .animeMetadataSearch(q, filters.year, filters.quarter, filters.tag, filters.sort)
        .then((r) => {
          if (!alive) return;
          setCands(r.candidates ?? []);
          setSearchError(null);
          setSearching(false);
        })
        .catch((e) => {
          if (!alive) return;
          setCands([]);
          setSearchError(errText(e));
          setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [mode, query, searchTick, filters.year, filters.quarter, filters.tag, filters.sort]);

  /** 库里已有同一条目就打开它，否则建库（幂等） */
  const openCandidate = (c: AnimeMetadataCandidate) => {
    const local = subjects.find((s) => s.bgmId === c.bgmId);
    if (local) {
      select(local.id);
      return;
    }
    void importCandidate(c.bgmId).then((r) => push(r.message, r.ok ? 'good' : 'bad'));
  };

  const localByBgm = useMemo(() => {
    const map = new Map<number, string>();
    for (const s of subjects) if (typeof s.bgmId === 'number') map.set(s.bgmId, s.id);
    return map;
  }, [subjects]);

  const localResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return subjects;
    return subjects.filter((x) => [x.title, x.titleOriginal ?? '', ...x.tags].join(' ').toLowerCase().includes(q));
  }, [query, subjects]);

  const resume = useMemo(() => historyFrom(subjects, episodes).slice(0, 4), [subjects, episodes]);
  const airingByDay = useMemo(() => {
    const map = new Map<number, AnimeMetadataCandidate[]>();
    for (const d of calendar) map.set(d.weekday, d.items);
    return map;
  }, [calendar]);

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

      {mode === 'search' ? (
        <SearchBody
          query={query}
          searching={searching}
          searchError={searchError}
          cands={cands}
          localResults={localResults}
          localByBgm={localByBgm}
          onOpenCandidate={openCandidate}
          onOpenLocal={(id) => select(id)}
          onContinue={(id) => openPlayer(id)}
          episodes={episodes}
          onRetry={() => setSearchTick((t) => t + 1)}
          onImportRef={(input) => void importByRef(input).then((r) => push(r.message, r.ok ? 'good' : 'bad'))}
          filters={filters}
          setFilter={setFilter}
          resetFilters={resetFilters}
        />
      ) : (
        <ExploreBody
          subjectsCount={subjects.length}
          error={error}
          resume={resume}
          airingByDay={airingByDay}
          hot={hot}
          hotSource={hotSource}
          exploreLoading={exploreLoading}
          exploreError={exploreError}
          localByBgm={localByBgm}
          onRefreshExplore={() => void loadExplore(true)}
          onOpenCandidate={openCandidate}
          onOpenLocal={(id) => select(id)}
          onContinue={(subjectId, episodeId) => openPlayer(subjectId, episodeId)}
          onGoStates={() => setView('states')}
          onGoHistory={() => setView('history')}
        />
      )}
    </div>
  );
}

/** 排序档（与 Rust 侧白名单同值；未知值服务侧退回 match） */
const SORTS: { key: AnimeSearchFilters['sort']; label: string }[] = [
  { key: 'match', label: '匹配' },
  { key: 'heat', label: '热度' },
  { key: 'score', label: '评分' },
  { key: 'rank', label: '排名' },
];

const QUARTERS = [1, 2, 3, 4];

/** 检索筛选条：年份 / 季度 / 排序 / 布局 + 结果里的热门标签 */
function FilterBar({
  filters,
  setFilter,
  resetFilters,
  cands,
}: {
  filters: AnimeSearchFilters;
  setFilter: <K extends keyof AnimeSearchFilters>(key: K, value: AnimeSearchFilters[K]) => void;
  resetFilters: () => void;
  cands: AnimeMetadataCandidate[] | null;
}) {
  const years = useMemo(() => {
    const now = new Date().getFullYear();
    return Array.from({ length: 6 }, (_, i) => now - i);
  }, []);
  // 标签来自**当前结果**（真数据），不是写死的一份清单
  const topTags = useMemo(() => {
    const count = new Map<string, number>();
    for (const c of cands ?? []) for (const t of c.tags) count.set(t, (count.get(t) ?? 0) + 1);
    return [...count.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([t]) => t);
  }, [cands]);

  return (
    <>
      <div className="an-chips">
        <span className="an-note">年份</span>
        <button
          type="button"
          className={filters.year == null ? 'an-chip is-ok' : 'an-chip is-plain'}
          onClick={() => setFilter('year', null)}
        >
          全部
        </button>
        {years.map((y) => (
          <button
            key={y}
            type="button"
            className={filters.year === y ? 'an-chip is-ok' : 'an-chip is-plain'}
            onClick={() => setFilter('year', filters.year === y ? null : y)}
          >
            {y}
          </button>
        ))}
        <span className="an-note">季度</span>
        <button
          type="button"
          className={filters.quarter == null ? 'an-chip is-ok' : 'an-chip is-plain'}
          onClick={() => setFilter('quarter', null)}
        >
          全年
        </button>
        {QUARTERS.map((q) => (
          <button
            key={q}
            type="button"
            className={filters.quarter === q ? 'an-chip is-ok' : 'an-chip is-plain'}
            onClick={() => setFilter('quarter', filters.quarter === q ? null : q)}
          >
            Q{q}
          </button>
        ))}
        <span className="an-note">排序</span>
        {SORTS.map((o) => (
          <button
            key={o.key}
            type="button"
            className={filters.sort === o.key ? 'an-chip is-ok' : 'an-chip is-plain'}
            onClick={() => setFilter('sort', o.key)}
          >
            {o.label}
          </button>
        ))}
        <span className="an-sp" />
        <button type="button" className="an-chip is-plain" onClick={resetFilters}>
          清筛选
        </button>
        <button
          type="button"
          className="an-chip is-plain"
          title="切换结果布局"
          onClick={() => setFilter('layout', filters.layout === 'grid' ? 'list' : 'grid')}
        >
          {filters.layout === 'grid' ? '列表' : '网格'}
        </button>
      </div>
      {topTags.length ? (
        <div className="an-chips">
          <span className="an-note">标签</span>
          {topTags.map((t) => (
            <button
              key={t}
              type="button"
              className={filters.tag === t ? 'an-chip is-ok' : 'an-chip is-plain'}
              onClick={() => setFilter('tag', filters.tag === t ? null : t)}
            >
              {t}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** 搜索模式：在线候选优先；断网时退回本地库匹配并如实标注 */
function SearchBody({
  query,
  searching,
  searchError,
  cands,
  localResults,
  localByBgm,
  onOpenCandidate,
  onOpenLocal,
  onContinue,
  episodes,
  onRetry,
  onImportRef,
  filters,
  setFilter,
  resetFilters,
}: {
  query: string;
  searching: boolean;
  searchError: string | null;
  cands: AnimeMetadataCandidate[] | null;
  localResults: AnimeSubject[];
  localByBgm: Map<number, string>;
  onOpenCandidate: (c: AnimeMetadataCandidate) => void;
  onOpenLocal: (id: string) => void;
  onContinue: (id: string) => void;
  episodes: AnimeEpisode[];
  onRetry: () => void;
  onImportRef: (input: string) => void;
  filters: AnimeSearchFilters;
  setFilter: <K extends keyof AnimeSearchFilters>(key: K, value: AnimeSearchFilters[K]) => void;
  resetFilters: () => void;
}) {
  const q = query.trim();
  if (looksLikeBgmRef(q)) {
    // 占位文案承诺的「粘链接」：不拿去当关键词检索，直接走建库
    return (
      <div className="an-explore-err">
        <span>这是 Bangumi 条目链接 / 编号：{q}</span>
        <Btn kind="primary" size="sm" onClick={() => onImportRef(q)}>
          加入番剧库
        </Btn>
      </div>
    );
  }
  if (!q) {
    return (
      <>
        <SectionHead title="本地库" count={localResults.length} />
        {localResults.length === 0 ? (
          <Empty inline>库里还没有番。把片放进番剧根目录，或者搜一部「加入追番」。</Empty>
        ) : (
          <div className="an-grid">
            {localResults.map((s) => (
              <SubjectCard
                key={s.id}
                subject={s}
                episodes={episodes}
                onOpen={() => onOpenLocal(s.id)}
                onContinue={() => onContinue(s.id)}
              />
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {searching ? (
        <div className="an-grid" style={{ marginTop: 12 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} height={196} radius={16} />
          ))}
        </div>
      ) : searchError ? (
        <>
          <div className="an-explore-err">
            <span>在线检索不可用：{searchError}</span>
            <Btn kind="ghost" size="sm" onClick={onRetry}>
              重试
            </Btn>
          </div>
          <SectionHead title="本地库匹配" count={localResults.length} />
          {localResults.length === 0 ? (
            <Empty inline>本地库也没有「{q}」。检查网络或设置里的 Bangumi 镜像 / 代理。</Empty>
          ) : (
            <div className="an-grid">
              {localResults.map((s) => (
                <SubjectCard
                  key={s.id}
                  subject={s}
                  episodes={episodes}
                  onOpen={() => onOpenLocal(s.id)}
                  onContinue={() => onContinue(s.id)}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <FilterBar filters={filters} setFilter={setFilter} resetFilters={resetFilters} cands={cands} />
          <SectionHead title="搜索结果" count={cands?.length ?? 0} />
          {!cands || cands.length === 0 ? (
            <Empty inline>没搜到「{q}」。换个关键词、放宽筛选，或者确认一下译名。</Empty>
          ) : filters.layout === 'list' ? (
            <div className="an-cand-list">
              {cands.map((c) => {
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
                    <span className={localByBgm.has(c.bgmId) ? 'an-chip is-ok' : 'an-chip is-plain'}>
                      {localByBgm.has(c.bgmId) ? '已在库' : '未入库'}
                    </span>
                    <Btn kind="ghost" size="sm" onClick={() => onOpenCandidate(c)}>
                      {localByBgm.has(c.bgmId) ? '查看' : '加入追番'}
                    </Btn>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="an-grid">
              {cands.map((c) => (
                <CandidateCard
                  key={c.bgmId}
                  item={c}
                  inLibrary={localByBgm.has(c.bgmId)}
                  onOpen={() => onOpenCandidate(c)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

/** 探索模式：继续观看（本地） + 新番时间表（Bangumi） + 热度推荐（Bangumi） */
function ExploreBody({
  subjectsCount,
  error,
  resume,
  airingByDay,
  hot,
  hotSource,
  exploreLoading,
  exploreError,
  localByBgm,
  onRefreshExplore,
  onOpenCandidate,
  onOpenLocal,
  onContinue,
  onGoStates,
  onGoHistory,
}: {
  subjectsCount: number;
  error: string | null;
  resume: { subject: AnimeSubject; episode: AnimeEpisode }[];
  airingByDay: Map<number, AnimeMetadataCandidate[]>;
  hot: AnimeMetadataCandidate[];
  hotSource: 'heat' | 'rank';
  exploreLoading: boolean;
  exploreError: string | null;
  localByBgm: Map<number, string>;
  onRefreshExplore: () => void;
  onOpenCandidate: (c: AnimeMetadataCandidate) => void;
  onOpenLocal: (id: string) => void;
  onContinue: (subjectId: string, episodeId?: string) => void;
  onGoStates: () => void;
  onGoHistory: () => void;
}) {
  if (subjectsCount === 0 && !exploreLoading && !airingByDay.size && hot.length === 0) {
    return (
      <Empty>
        <b>番剧库还空着</b>
        <div className="an-empty-sub">
          {error
            ? `服务没答上来：${error}`
            : '把番剧文件夹放进番剧根目录，或者先去「三态」页载入一份示例数据看看样子。'}
        </div>
        <div className="an-empty-acts">
          <Btn kind="primary" onClick={onGoStates}>
            载入示例数据
          </Btn>
          <Btn kind="ghost" onClick={onRefreshExplore}>
            拉一次在线数据
          </Btn>
        </div>
      </Empty>
    );
  }

  return (
    <>
      <SectionHead
        title="继续观看"
        count={resume.length}
        action={
          resume.length ? (
            <button type="button" className="an-link" onClick={onGoHistory}>
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
                onClick={() => onContinue(subject.id, episode.id)}
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

      {exploreError ? (
        <div className="an-explore-err">
          <span>{exploreError}</span>
          <Btn kind="ghost" size="sm" onClick={onRefreshExplore}>
            重试
          </Btn>
        </div>
      ) : null}

      <SectionHead
        title="新番时间表"
        count={[...airingByDay.values()].reduce((n, list) => n + list.length, 0)}
        action={
          <button type="button" className="an-link" onClick={onRefreshExplore}>
            {exploreLoading ? '刷新中…' : '刷新'}
          </button>
        }
      />
      {exploreLoading && airingByDay.size === 0 ? (
        <Skeleton height={120} radius={12} />
      ) : airingByDay.size === 0 ? (
        <Empty inline>这一季还没有在追的连载。等它开播，或者去搜索里先点个「想补」。</Empty>
      ) : (
        <div className="an-week">
          {WEEKDAYS.map((w) => {
            const list = airingByDay.get(w.idx) ?? [];
            return (
              <div key={w.idx} className="an-week-col">
                <div className="an-week-hd">{w.label}</div>
                {list.length === 0 ? (
                  <div className="an-week-none">—</div>
                ) : (
                  list.map((c) => (
                    <button
                      key={c.bgmId}
                      type="button"
                      className={localByBgm.has(c.bgmId) ? 'an-week-item is-in' : 'an-week-item'}
                      onClick={() =>
                        localByBgm.has(c.bgmId) ? onOpenLocal(localByBgm.get(c.bgmId) as string) : onOpenCandidate(c)
                      }
                      title={localByBgm.has(c.bgmId) ? '已在库，打开条目' : '加入追番'}
                    >
                      {c.nameCn || c.name}
                    </button>
                  ))
                )}
              </div>
            );
          })}
        </div>
      )}

      <SectionHead
        title={hotSource === 'rank' ? '高分排行' : '热度推荐'}
        count={hot.length}
        action={hotSource === 'rank' ? <span className="an-note">上游不支持热度，已退回排行</span> : null}
      />
      {hot.length === 0 ? (
        <Empty inline>热度还没拉到。点上面的「刷新」重试，或检查设置里的镜像 / 代理。</Empty>
      ) : (
        <div className="an-grid">
          {hot.map((c) => (
            <CandidateCard
              key={c.bgmId}
              item={c}
              inLibrary={localByBgm.has(c.bgmId)}
              onOpen={() => onOpenCandidate(c)}
            />
          ))}
        </div>
      )}
    </>
  );
}
