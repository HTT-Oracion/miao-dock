// 本地曲库切片 —— 「本地」段的 5 个 action（D-156 从 store.ts 按 action 段切出）。
import * as ipc from '@music/ipc';
import { localToSong } from '@music/convert';
import { LS_LOCAL, readLS, writeLS } from '@music/persist';
import type { LocalSongInfo } from '@music/types';
import type { MusicState, StoreGet, StoreSet } from '@music/slice';

export const createLocalSlice = (set: StoreSet, get: StoreGet): Pick<MusicState, 'loadLocalSongs' | 'importLocal' | 'importFolder' | 'removeLocalSong' | 'clearLocalSongs'> => ({
  loadLocalSongs: () => {
    const infos = readLS<LocalSongInfo[]>(LS_LOCAL, []);
    if (!Array.isArray(infos) || infos.length === 0) return;
    set({ localSongs: infos, localQueue: infos.map(localToSong) });
  },

  importLocal: async (paths) => {
    if (paths.length === 0) return;
    set({ importingLocal: true });
    try {
      const infos = await ipc.importLocalMusic(paths);
      if (infos.length > 0) {
        const songs = infos.map(localToSong);
        set({ localSongs: infos, localQueue: songs });
        writeLS(LS_LOCAL, infos);
        // 导入后立即把本地歌单作为播放队列，自动播第一首
        await get().playSong(songs[0], songs);
      }
    } catch (e) {
      get().toast(`本地导入失败：${String(e)}`);
    } finally {
      set({ importingLocal: false });
    }
  },

  importFolder: async (folder) => {
    set({ importingLocal: true });
    try {
      const infos = await ipc.importLocalMusicFolder(folder);
      if (infos.length > 0) {
        const songs = infos.map(localToSong);
        set({ localSongs: infos, localQueue: songs });
        writeLS(LS_LOCAL, infos);
        await get().playSong(songs[0], songs);
      }
    } catch (e) {
      get().toast(`文件夹导入失败：${String(e)}`);
    } finally {
      set({ importingLocal: false });
    }
  },

  removeLocalSong: (id) => {
    const infos = get().localSongs.filter((s) => s.id !== id);
    const songs = infos.map(localToSong);
    set({ localSongs: infos, localQueue: songs });
    writeLS(LS_LOCAL, infos);
  },

  clearLocalSongs: () => {
    // 回收封面缓存文件（失败不阻断清空）
    const paths = get().localSongs.map((s) => s.cover_path).filter(Boolean);
    if (paths.length > 0) void ipc.deleteCoverCacheFiles(paths).catch(() => undefined);
    set({ localSongs: [], localQueue: [] });
    writeLS(LS_LOCAL, []);
  },
});
