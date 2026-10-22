// 右栏（发现）切片 —— 「右栏」段（D-156 从 store.ts 按 action 段切出）。
import * as ipc from '@music/ipc';
import * as platform from '@music/platform';
import { capsOf } from '@music/platform';
import { songKey } from '@music/convert';
import { PAGE_SIZE } from '@music/slice';
import type { MusicState, StoreGet, StoreSet } from '@music/slice';
import type { Playlist, Song } from '@music/types';

export const createRightSlice = (
  set: StoreSet,
  get: StoreGet,
): Pick<
  MusicState,
  | 'setRightView'
  | 'loadCharts'
  | 'loadRecommend'
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
        if (get().playbackSource !== provider) return;
        set({ officialCharts: results, chartsError: failed === CHART_IDS.length ? lastError : '' });
      } else {
        const charts = await platform.rankList(provider);
        if (get().playbackSource !== provider) return;
        set({ officialCharts: charts, chartsError: '' });
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
