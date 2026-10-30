// 搜索切片 —— 「搜索」段（D-156 从 store.ts 按 action 段切出）。
import * as platform from '@music/platform';
import { songKey } from '@music/convert';
import type { MusicState, StoreGet, StoreSet } from '@music/slice';

export const createSearchSlice = (
  set: StoreSet,
  get: StoreGet,
): Pick<
  MusicState,
  'setSearchText' | 'setSearchTab' | 'search' | 'loadMoreSearch' | 'searchArtists' | 'searchPlaylists' | 'clearSearch'
> => ({
  setSearchText: (t) => set({ searchText: t }),
  setSearchTab: (t) => set({ searchTab: t }),

  search: async (kw) => {
    const keywords = (kw ?? get().searchText).trim();
    if (!keywords) {
      set({ searchResults: [], searchError: '', searchHasMore: false });
      return;
    }

    /*
     * **歌单内搜索**：当前在歌单详情（`leftView === 'tracks'`）时，搜的是这个歌单自己的曲目。
     *
     * 为什么不打平台的 `/search` 接口：那个接口是**全站搜索**，不接受歌单 id
     * （NeteaseCloudMusicApiEnhanced 的 `search.js` 只有 `s / type / limit / offset`）。
     * 拿全站结果冒充"歌单内搜索"，用户点一首不在该歌单里的歌，播放列表就对不上了。
     *
     * 做法：先把**整个歌单**拉全（分页循环，上限 1000/页），再在本地按
     * 标题 / 歌手 / 专辑过滤。歌单量级是几百首，本地过滤是一次性的数组扫描，
     * 比为此新开一个后端端点更合适；也确实没有更贴近的后端接口。
     */
    const st = get();
    const pl = st.leftPlaylistMeta;
    if (st.leftView === 'tracks' && pl) {
      set({ searching: true, searchError: '', searchText: keywords, searchResults: [], searchHasMore: false });
      try {
        const total = pl.track_count ?? st.leftPlaylistTracks.length;
        // 已在内存里的那部分直接用，缺的按页补齐
        let all = [...st.leftPlaylistTracks];
        while (all.length < total) {
          const page = await platform.playlistTracksRange(st.playbackSource, pl.id, all.length, 1000);
          if (page.length === 0) break;
          all = [...all, ...page];
        }
        const kw = keywords.toLowerCase();
        const hit = all.filter(
          (s) =>
            s.name.toLowerCase().includes(kw) ||
            (s.artist ?? '').toLowerCase().includes(kw) ||
            (s.album ?? '').toLowerCase().includes(kw),
        );
        if (get().leftView !== 'tracks' || get().leftPlaylistMeta?.id !== pl.id) return;
        set({ searchResults: hit, searchTab: 'song', searchHasMore: false });
      } catch (e) {
        set({ searchResults: [], searchError: String(e) });
      } finally {
        set({ searching: false });
      }
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
