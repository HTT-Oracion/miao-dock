// 左栏（我的音乐）切片 —— 「左栏」段（D-156 从 store.ts 按 action 段切出）。
import * as platform from '@music/platform';
import { songKey } from '@music/convert';
import { PAGE_SIZE } from '@music/slice';
import type { MusicState, StoreGet, StoreSet } from '@music/slice';
import type { Song } from '@music/types';

/** 「我喜欢的音乐」的**统一显示名**（各平台原名不一，见 loadUserPlaylists 的注释） */
export const LIKED_PLAYLIST_NAME = '我喜欢的音乐';

export const createLeftSlice = (
  set: StoreSet,
  get: StoreGet,
): Pick<
  MusicState,
  'setLeftView' | 'loadUserPlaylists' | 'openLeftPlaylist' | 'loadMoreLeft' | 'loadAllLeft' | 'backToPlaylists'
> => ({
  setLeftView: (v) => set({ leftView: v }),

  loadUserPlaylists: async (p) => {
    const provider = p ?? get().playbackSource;
    if (!get().loginInfos[provider]?.logged_in) {
      set({ userPlaylists: [], userPlaylistsError: '' });
      return;
    }
    set({ loadingUserPlaylists: true, userPlaylistsError: '' });
    try {
      const list = await platform.userPlaylists(provider);
      if (get().playbackSource !== provider) return;
      /*
       * 「我喜欢的音乐」= **第一个 subscribed=false 的歌单**，并把它的名字统一改成「我喜欢的音乐」。
       *
       * 为什么用 `subscribed` 判，而不是原来的"下标 0"：
       * `subscribed` 是接口给每条数据打的**语义标记**（false = 用户自己创建的，
       * true = 收藏别人的），属于数据本身的属性；而"排在第一"只是当前的排序结果，
       * 排序一调，按下标判就静默指到别的歌单上 —— 且不报错。
       *
       * 为什么还要**改名**：这个歌单在各平台/各语言下的显示名并不统一
       * （"我喜欢" / "我喜欢的音乐" / "喜欢的音乐"）。心动模式的可用性判定、
       * 以及左侧"创建/收藏"分组，都依赖"哪一条是它"这个判断 ——
       * 名字统一之后，用户眼里看到的和代码里判定的是同一条，不会出现
       * "界面叫我喜欢、代码认的却是另一条"这种对不上的情况。
       */
      const likedIdx = list.findIndex((pl) => pl.subscribed === false);
      const marked =
        likedIdx < 0
          ? list
          : list.map((pl, i) => (i === likedIdx ? { ...pl, name: LIKED_PLAYLIST_NAME, isLiked: true } : pl));
      set({ userPlaylists: marked, loadingUserPlaylists: false });
    } catch (e) {
      set({ loadingUserPlaylists: false, userPlaylistsError: String(e) });
    }
  },

  openLeftPlaylist: async (pl) => {
    set({ loadingLeftTracks: true, leftPlaylistTracks: [], leftPlaylistMeta: pl, leftView: 'tracks' });
    const provider = get().playbackSource;
    try {
      const [meta, songs] = await platform.playlistTracks(provider, pl.id);
      if (get().playbackSource !== provider) return;
      // 曲目接口返回的 meta **不带** isLiked，名字也是接口原始名 —— 必须把点进来时那份
      // 统一后的信息带过去。否则下钻一次，「我喜欢的音乐」就变回接口原名，
      // 心动模式的可用性判定（看 isLiked）也会跟着失效。
      set({
        leftPlaylistMeta: pl.isLiked ? { ...meta, name: pl.name, isLiked: true } : meta,
        leftPlaylistTracks: songs,
      });
    } catch {
      set({ leftPlaylistTracks: [] });
    } finally {
      set({ loadingLeftTracks: false });
    }
  },

  loadMoreLeft: async () => {
    const { leftPlaylistMeta, leftPlaylistTracks, loadingMoreLeft, playbackSource } = get();
    const id = leftPlaylistMeta?.id;
    const total = leftPlaylistMeta?.track_count ?? 0;
    if (!id || loadingMoreLeft) return;
    const start = leftPlaylistTracks.length;
    if (start >= total) return;
    set({ loadingMoreLeft: true });
    try {
      const songs = await platform.playlistTracksRange(playbackSource, id, start, PAGE_SIZE);
      if (songs.length === 0) return;
      set((s) => {
        // 当前队列正来自本歌单 → 新页去重后同步追加进队列
        const syncsQueue =
          s.queue.length > 0 &&
          s.leftPlaylistTracks.length > 0 &&
          songKey(s.leftPlaylistTracks[0]) === songKey(s.queue[0]);
        if (syncsQueue) {
          const ids = new Set(s.queue.map(songKey));
          const unique = songs.filter((x) => !ids.has(songKey(x)));
          return {
            leftPlaylistTracks: [...s.leftPlaylistTracks, ...songs],
            queue: unique.length > 0 ? [...s.queue, ...unique] : s.queue,
          };
        }
        return { leftPlaylistTracks: [...s.leftPlaylistTracks, ...songs] };
      });
    } catch {
      // 静默：滚动加载失败不打断已加载内容
    } finally {
      set({ loadingMoreLeft: false });
    }
  },

  loadAllLeft: async () => {
    const { leftPlaylistMeta, playbackSource } = get();
    const id = leftPlaylistMeta?.id;
    const total = leftPlaylistMeta?.track_count ?? 0;
    if (!id || total === 0) return;
    // 循环拉完剩余页；任一页空或报错即退出（避免死循环）
    for (;;) {
      const s = get();
      if (s.leftPlaylistMeta?.id !== id) break;
      const start = s.leftPlaylistTracks.length;
      if (start >= total) break;
      let songs: Song[] = [];
      try {
        songs = await platform.playlistTracksRange(playbackSource, id, start, PAGE_SIZE);
      } catch {
        break;
      }
      if (songs.length === 0) break;
      set((st) => ({ leftPlaylistTracks: [...st.leftPlaylistTracks, ...songs] }));
    }
  },

  backToPlaylists: () => set({ leftView: 'playlists', leftPlaylistTracks: [], leftPlaylistMeta: null }),
});
