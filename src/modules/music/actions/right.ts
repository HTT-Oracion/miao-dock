// 右栏（发现）切片 —— 「右栏」段（D-156 从 store.ts 按 action 段切出）。
import * as ipc from '@music/ipc';
import * as platform from '@music/platform';
import { capsOf } from '@music/platform';
import { songKey } from '@music/convert';
import { PAGE_SIZE } from '@music/slice';
import type { MusicState, StoreGet, StoreSet } from '@music/slice';
import type { MusicProvider, Playlist, Song } from '@music/types';

/** 首页榜单卡只铺前 5 名（设计稿 `ch.rows` 就是 5 行） */
const CHART_PREVIEW_N = 5;

/**
 * 给每个榜单补上前 5 名预览（设计稿的首页「官方榜单」卡直接铺排行，不是入口列表）。
 *
 * 两条纪律：
 *   · **逐条兜底**：某张榜单取不到前 5 名时保留 `preview: undefined`（卡片退化成只有标题），
 *     而不是 `preview: []` —— 空数组会渲染成"这个榜一首歌都没有"，那是谎报。
 *   · **先看平台换没换**：这一轮 await 的是 5 个网络请求，期间用户可能切了平台；
 *     切了就整批丢弃，否则会把上一个平台的排行画到新平台的卡上。
 */
async function withPreview(charts: Playlist[], provider: MusicProvider): Promise<Playlist[]> {
  return Promise.all(
    charts.map(async (pl) => {
      try {
        const songs = platform.chartUsesRankSongs(provider)
          ? await platform.rankSongs(provider, pl.id, CHART_PREVIEW_N)
          : (await platform.playlistTracks(provider, pl.id))[1];
        const preview = songs.slice(0, CHART_PREVIEW_N).map((s) => ({ title: s.name, artist: s.artist }));
        return preview.length ? { ...pl, preview } : pl;
      } catch {
        // 单张榜失败不影响其它卡：保留 undefined，不写空数组
        return pl;
      }
    }),
  );
}

export const createRightSlice = (
  set: StoreSet,
  get: StoreGet,
): Pick<
  MusicState,
  | 'setRightView'
  | 'loadCharts'
  | 'loadRecommend'
  | 'loadRecommendPlaylists'
  | 'loadDailySongs'
  | 'loadNewSongs'
  | 'openRightPlaylist'
  | 'openRightChart'
  | 'loadMoreRight'
  | 'backToRecommendations'
  | 'togglePlaylistSubscribe'
> => ({
  setRightView: (v) => set({ rightView: v }),

  /** 官方榜单：网易云用硬编码榜单 ID + 歌单详情拼；酷狗/QQ/咪咕各有榜单列表接口 */
  loadCharts: async (p) => {
    const provider = p ?? get().playbackSource;
    set({ loadingCharts: true, chartsError: '' });
    try {
      if (provider === 'netease') {
        const CHART_IDS: [string, string][] = [
          ['3778678', '热歌榜'],
          ['19723756', '飙升榜'],
          ['3779629', '新歌榜'],
          ['2884035', '原创榜'],
          ['112504', '抖音排行榜'],
          ['6723173524', '网络热歌榜'],
          ['5453912201', 'VIP热歌榜'],
          ['6886768100', '中文DJ榜'],
          ['1978921795', '电音榜'],
          ['2809513713', '说唱榜'],
          ['71384707', '古典榜'],
        ];
        // 逐条兜底（一张榜单失败不该拖垮整组），但要记下**失败了几条**：
        // 全部失败时那是"网络/服务坏了"，不是"这些榜单恰好没内容" —— 必须说出来
        let failed = 0;
        let lastError = '';
        const results = await Promise.all(
          CHART_IDS.map(([id, name]) =>
            ipc.musicPlaylistDetail(id).catch((e: unknown) => {
              failed += 1;
              lastError = String(e);
              return {
                provider: 'netease',
                id,
                name,
                cover: '',
                track_count: 0,
                creator: '网易云音乐',
                subscribed: false,
              } as Playlist;
            }),
          ),
        );
        /*
         * 打上 `isChart`：榜单与歌单共用同一个详情组件，但它的数据来源不同
         * （QQ / 咪咕走榜单歌曲接口）—— 由这里**显式打标**，详情侧就不用再猜 id 形态。
         */
        if (get().playbackSource !== provider) return;
        const marked = results.map((c) => ({ ...c, isChart: true }));
        set({
          officialCharts: await withPreview(marked, provider),
          chartsError: failed === CHART_IDS.length ? lastError : '',
        });
      } else {
        const charts = await platform.rankList(provider);
        if (get().playbackSource !== provider) return;
        const marked = charts.map((c) => ({ ...c, isChart: true }));
        set({ officialCharts: await withPreview(marked, provider), chartsError: '' });
      }
    } catch (e) {
      // 失败要**说出来**：空列表 + 一句原因，用户才知道是"没榜单"还是"没读到"
      if (get().playbackSource === provider) set({ officialCharts: [], chartsError: String(e) });
    } finally {
      set({ loadingCharts: false });
    }
  },

  /** 推荐歌单 + 每日推荐歌曲（按平台能力，无能力的平台置空） */
  loadRecommend: async (p) => {
    const provider = p ?? get().playbackSource;
    set({ loadingRecommend: true, loadingDaily: true, loadingNewSongs: true, recommendError: '' });
    try {
      // 三段各自兜底（某一节失败不该拖垮另外两节），但要记下**失败了几段**：
      // 本平台支持的段全挂时，那是"没读到"，不是"今天没有推荐" —— 必须说出来
      const caps = capsOf(provider);
      const expected = [caps.recommendPlaylists, caps.dailySongs, caps.newSongs].filter(Boolean).length;
      let failed = 0;
      let lastError = '';
      const guard = <T>(p: Promise<T>, fallback: T) =>
        p.catch((e: unknown) => {
          failed += 1;
          lastError = String(e);
          return fallback;
        });
      const [pls, songs, fresh] = await Promise.all([
        guard(platform.recommendPlaylists(provider), [] as Playlist[]),
        guard(platform.dailySongs(provider), [] as Song[]),
        guard(platform.newSongs(provider), [] as Song[]),
      ]);
      if (get().playbackSource !== provider) return;
      set({
        recommendPlaylists: pls,
        dailySongs: songs,
        newSongs: fresh,
        recommendError: expected > 0 && failed >= expected ? lastError : '',
      });
    } finally {
      set({ loadingRecommend: false, loadingDaily: false, loadingNewSongs: false });
    }
  },

  /*
   * 只刷「推荐歌单」一节。
   *
   * ⚠️ 为什么不复用 `loadRecommend`：它一次刷三段。用户在这节点「换一批」，
   * 却连带把「每日推荐」「今日精选」也刷了 —— 白跑两次请求，
   * 而且另外两节会闪一下骨架屏，像是被误触。
   */
  loadRecommendPlaylists: async (p) => {
    const provider = p ?? get().playbackSource;
    set({ loadingRecommend: true, recommendError: '' });
    try {
      const pls = await platform.recommendPlaylists(provider);
      if (get().playbackSource !== provider) return;
      set({ recommendPlaylists: pls, recommendError: '' });
    } catch (e) {
      // 失败要**说出来**：空列表 + 一句原因，用户才知道是"没推荐"还是"没读到"
      set({ recommendPlaylists: [], recommendError: String(e) });
    } finally {
      set({ loadingRecommend: false });
    }
  },

  /** 只刷「每日推荐」一节（hero 里那首歌的来源） */
  loadDailySongs: async (p) => {
    const provider = p ?? get().playbackSource;
    set({ loadingDaily: true });
    try {
      const songs = await platform.dailySongs(provider);
      if (get().playbackSource !== provider) return;
      set({ dailySongs: songs });
    } catch {
      // 每日推荐取不到就保持空（hero 会显示"登录后每天更新"），不打扰用户
      set({ dailySongs: [] });
    } finally {
      set({ loadingDaily: false });
    }
  },

  /** 只刷「今日精选」一节 */
  loadNewSongs: async (p) => {
    const provider = p ?? get().playbackSource;
    set({ loadingNewSongs: true });
    try {
      const songs = await platform.newSongs(provider);
      if (get().playbackSource !== provider) return;
      set({ newSongs: songs });
    } catch {
      set({ newSongs: [] });
    } finally {
      set({ loadingNewSongs: false });
    }
  },

  openRightPlaylist: async (pl) => {
    set({ loadingRightTracks: true, rightPlaylistTracks: [], rightPlaylistMeta: pl, rightView: 'tracks' });
    const provider = get().playbackSource;
    try {
      if (platform.chartUsesRankSongs(provider) && pl.creator === '榜单') {
        const songs = await platform.rankSongs(provider, pl.id, 100);
        if (get().playbackSource !== provider) return;
        set({ rightPlaylistTracks: songs, rightTracksError: '' });
        return;
      }
      const [meta, songs] = await platform.playlistTracks(provider, pl.id);
      if (get().playbackSource !== provider) return;
      set({ rightPlaylistMeta: meta, rightPlaylistTracks: songs, rightTracksError: '' });
    } catch (e) {
      set({ rightPlaylistTracks: [], rightTracksError: String(e) });
    } finally {
      set({ loadingRightTracks: false });
    }
  },

  /** 榜单卡片点击：QQ/咪咕走榜单歌曲接口，网易云/酷狗走歌单曲目接口 */
  openRightChart: async (pl) => {
    set({
      rightView: 'tracks',
      rightPlaylistMeta: pl,
      loadingRightTracks: true,
      rightPlaylistTracks: [],
      rightTracksError: '',
    });
    const provider = get().playbackSource;
    try {
      if (platform.chartUsesRankSongs(provider)) {
        const limited = provider === 'migu' ? 100 : 99999;
        const songs = await platform.rankSongs(provider, pl.id, limited);
        if (get().playbackSource !== provider) return;
        set({ rightPlaylistTracks: songs, rightTracksError: '' });
      } else {
        const [meta, songs] = await platform.playlistTracks(provider, pl.id);
        if (get().playbackSource !== provider) return;
        set({ rightPlaylistMeta: meta, rightPlaylistTracks: songs, rightTracksError: '' });
      }
    } catch (e) {
      set({ rightPlaylistTracks: [], rightTracksError: String(e) });
    } finally {
      set({ loadingRightTracks: false });
    }
  },

  loadMoreRight: async () => {
    const { rightPlaylistMeta, rightPlaylistTracks, loadingMoreRight, playbackSource } = get();
    const id = rightPlaylistMeta?.id;
    const total = rightPlaylistMeta?.track_count ?? 0;
    if (!id || loadingMoreRight) return;
    const start = rightPlaylistTracks.length;
    if (total === 0 || start >= total) return;
    set({ loadingMoreRight: true });
    try {
      const songs = await platform.playlistTracksRange(playbackSource, id, start, PAGE_SIZE);
      if (songs.length === 0) return;
      set((s) => {
        const syncsQueue =
          s.queue.length > 0 &&
          s.rightPlaylistTracks.length > 0 &&
          songKey(s.rightPlaylistTracks[0]) === songKey(s.queue[0]);
        if (syncsQueue) {
          const ids = new Set(s.queue.map(songKey));
          const unique = songs.filter((x) => !ids.has(songKey(x)));
          return {
            rightPlaylistTracks: [...s.rightPlaylistTracks, ...songs],
            queue: unique.length > 0 ? [...s.queue, ...unique] : s.queue,
          };
        }
        return { rightPlaylistTracks: [...s.rightPlaylistTracks, ...songs] };
      });
    } catch {
      // 静默
    } finally {
      set({ loadingMoreRight: false });
    }
  },

  backToRecommendations: () => set({ rightView: 'recommendations', rightPlaylistTracks: [], rightPlaylistMeta: null }),

  togglePlaylistSubscribe: async (pl) => {
    if (pl.provider !== 'netease') {
      get().toast('当前平台暂不支持收藏歌单');
      return;
    }
    try {
      await ipc.musicPlaylistSubscribe(pl.id, !pl.subscribed);
      set((s) => ({
        officialCharts: s.officialCharts.map((x) => (x.id === pl.id ? { ...x, subscribed: !x.subscribed } : x)),
        recommendPlaylists: s.recommendPlaylists.map((x) => (x.id === pl.id ? { ...x, subscribed: !x.subscribed } : x)),
        userPlaylists: s.userPlaylists.map((x) => (x.id === pl.id ? { ...x, subscribed: !x.subscribed } : x)),
      }));
      get().toast(pl.subscribed ? '已取消收藏' : '已收藏歌单', 'success');
    } catch (e) {
      get().toast(`收藏失败：${String(e)}`);
    }
  },
});
