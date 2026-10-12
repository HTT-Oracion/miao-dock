// 左栏（我的音乐）切片 —— 「左栏」段（D-156 从 store.ts 按 action 段切出）。
import * as platform from '@music/platform';
import { songKey } from '@music/convert';
import { PAGE_SIZE } from '@music/slice';
import type { MusicState, StoreGet, StoreSet } from '@music/slice';
import type { Song } from '@music/types';

export const createLeftSlice = (set: StoreSet, get: StoreGet): Pick<MusicState, 'setLeftView' | 'loadUserPlaylists' | 'openLeftPlaylist' | 'loadMoreLeft' | 'loadAllLeft' | 'backToPlaylists'> => ({
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
      set({ userPlaylists: list, loadingUserPlaylists: false });
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
      set({ leftPlaylistMeta: meta, leftPlaylistTracks: songs });
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
