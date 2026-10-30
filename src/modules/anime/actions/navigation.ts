/**
 * 番剧模块导航切片 —— 屏内视图与筛选条件。
 *
 * 为什么不把十屏塞进 URL：与音乐同口径（`APP_VIEWS.anime = null`）——
 * 番剧是**独立应用、自成工作区**，模块内视图不参与壳层路由。
 */
import type { AnimeState, StoreGet, StoreSet } from '@anime/slice';
import type { AnimeView, CollectionType } from '@anime/types';

export function navigationActions(
  set: StoreSet,
  _get: StoreGet,
): Pick<AnimeState, 'setView' | 'setQuery' | 'setSearchMode' | 'setFilter'> {
  return {
    setView: (view: AnimeView) => set({ view }),
    setQuery: (query: string) => set({ query }),
    setSearchMode: (searchMode: 'explore' | 'search') => set({ searchMode }),
    /**
     * 追番筛选。
     * 切筛选时把选中条目清掉：详情页还挂着上一部会让「筛了却没变」看起来像没生效。
     */
    setFilter: (filter: CollectionType | 'all') => set({ filter, selectedId: null }),
  };
}
