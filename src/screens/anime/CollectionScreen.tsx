/**
 * 追番（设计稿 ②）：五状态 tab + 卡片网格。
 *
 * tab 顺序与文案取自 `types.ts` 的单一事实源（`COLLECTION_ORDER` / `COLLECTION_LABELS`），
 * 不在组件里另写一份 —— 否则会出现"tab 写「溜了」、卡片徽标写「抛弃」"。
 */
import { useMemo } from 'react';
import { Empty, Skeleton, Btn } from '@components/units';
import { useAnimeStore } from '@anime/store';
import { byCollection, collectionCounts } from '@anime/selectors';
import { COLLECTION_LABELS, COLLECTION_ORDER } from '@anime/types';
import { SubjectCard } from '@screens/anime/shared';

export function CollectionScreen() {
  const subjects = useAnimeStore((s) => s.subjects);
  const episodes = useAnimeStore((s) => s.episodes);
  const filter = useAnimeStore((s) => s.filter);
  const setFilter = useAnimeStore((s) => s.setFilter);
  const loading = useAnimeStore((s) => s.loading);
  const loaded = useAnimeStore((s) => s.loaded);
  const listAnim = useAnimeStore((s) => s.prefs.listAnim);
  const select = useAnimeStore((s) => s.selectSubject);
  const openPlayer = useAnimeStore((s) => s.openPlayer);
  const setView = useAnimeStore((s) => s.setView);

  const counts = useMemo(() => collectionCounts(subjects), [subjects]);
  const list = useMemo(() => (filter === 'all' ? subjects : byCollection(subjects, filter)), [subjects, filter]);

  if (loading && !loaded) {
    return (
      <div className="an-screen an-pad">
        <Skeleton height={34} width={420} radius={999} />
        <div className="an-grid" style={{ marginTop: 16 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} height={196} radius={16} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="an-screen an-pad">
      <div className="an-tabs" role="tablist" aria-label="追番状态">
        {COLLECTION_ORDER.map((c) => (
          <Btn
            kind="bare"
            key={c}
            type="button"
            role="tab"
            aria-selected={filter === c}
            className={filter === c ? 'an-tab is-on' : 'an-tab'}
            onClick={() => setFilter(c)}
          >
            {COLLECTION_LABELS[c]}
            <span className="an-tab-n">{counts[c]}</span>
          </Btn>
        ))}
      </div>

      {list.length === 0 ? (
        <Empty>
          <b>
            {filter === 'doing' || filter === 'all' ? '追番列表还空着' : `「${COLLECTION_LABELS[filter]}」里还没有番`}
          </b>
          <div className="an-empty-sub">去探索页翻两下，遇到对味的就点颗心，攒起来慢慢补。</div>
          <div className="an-empty-acts">
            <Btn kind="bare" type="button" className="btn btn-primary btn-sm" onClick={() => setView('explore')}>
              去探索
            </Btn>
          </div>
        </Empty>
      ) : (
        <div className={listAnim ? 'an-grid an-stagger' : 'an-grid'}>
          {list.map((s) => (
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
    </div>
  );
}
