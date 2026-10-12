// 搜索切片 —— 「搜索」段（D-156 从 store.ts 按 action 段切出）。
import * as platform from '@music/platform';
import { songKey } from '@music/convert';
import type { MusicState, StoreGet, StoreSet } from '@music/slice';

export const createSearchSlice = (set: StoreSet, get: StoreGet): Pick<MusicState, 'setSearchText' | 'setSearchTab' | 'search' | 'loadMoreSearch' | 'searchArtists' | 'searchPlaylists' | 'clearSearch'> => ({
  setSearchText: (t) => set({ searchText: t }),
  setSearchTab: (t) => set({ searchTab: t }),

  search: async (kw) => {
    const keywords = (kw ?? get().searchText).trim();
    if (!keywords) {
      set({ searchResults: [], searchError: '', searchHasMore: false });
      return;
    }
    const provider = get().searchProvider;
    const pageSize = platform.searchPageSize(provider);
    // 清掉上一轮结果：否则「搜索中」会与旧关键词的结果混在一起
    set({ searching: true, searchError: '', searchText: keywords, searchResults: [], searchHasMore: false });
    try {
      const results = await platform.search(provider, keywords, pageSize, 0);
      // 切了搜索平台就不要旧结果，避免串台
      if (get().searchProvider !== provider) return;
      set({ searchResults: results, searchTab: 'song', searchHasMore: results.length >= pageSize });
    } catch (e) {
      set({ searchResults: [], searchError: String(e) });
    } finally {
      set({ searching: false });
    }
  },

  loadMoreSearch: async () => {
    const { searchText, searchProvider, searchResults, searchHasMore, loadingMoreSearch, searching } = get();
    const keywords = searchText.trim();
    if (!keywords || !searchHasMore || loadingMoreSearch || searching) return;
    const provider = searchProvider;
    const pageSize = platform.searchPageSize(provider);
    set({ loadingMoreSearch: true });
    try {
      const more = await platform.search(provider, keywords, pageSize, searchResults.length);
      // 期间换了平台或改了关键词 → 丢弃这一页
      if (get().searchProvider !== provider || get().searchText.trim() !== keywords) return;
      set((s) => {
        const seen = new Set(s.searchResults.map(songKey));
        const unique = more.filter((x) => !seen.has(songKey(x)));
        return {
          searchResults: [...s.searchResults, ...unique],
          // 「本页被填满 且 有新增」才认为还有下一页：返回空页或整页重复都算到底，
          // 否则会在同一页上无限续拉
          searchHasMore: more.length >= pageSize && unique.length > 0,
        };
      });
    } catch {
      // 这一页失败就停在当前位置，不反复重试同一页
      set({ searchHasMore: false });
    } finally {
      set({ loadingMoreSearch: false });
    }
  },

  searchArtists: async (kw) => {
    const keywords = (kw ?? get().searchText).trim();
    if (!keywords) return;
    const provider = get().searchProvider;
    set({ searching: true, searchError: '' });
    try {
      const results = await platform.searchArtists(provider, keywords, 30);
      if (get().searchProvider !== provider) return;
      set({ artistSearchResults: results, searchTab: 'artist' });
    } catch (e) {
      set({ artistSearchResults: [], searchError: String(e) });
    } finally {
      set({ searching: false });
    }
  },

  searchPlaylists: async (kw) => {
    const keywords = (kw ?? get().searchText).trim();
    if (!keywords) return;
    const provider = get().searchProvider;
    set({ searching: true, searchError: '' });
    try {
      const results = await platform.searchPlaylists(provider, keywords, 30);
      if (get().searchProvider !== provider) return;
      set({ playlistSearchResults: results, searchTab: 'playlist' });
    } catch (e) {
      set({ playlistSearchResults: [], searchError: String(e) });
    } finally {
      set({ searching: false });
    }
  },

  clearSearch: () =>
    set({
      searchText: '',
      searchResults: [],
      searchHasMore: false,
      playlistSearchResults: [],
      artistSearchResults: [],
      searchError: '',
    }),
});
