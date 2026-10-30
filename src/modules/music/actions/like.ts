// 红心切片 —— 「红心」段（D-156 从 store.ts 按 action 段切出）。
import * as platform from '@music/platform';
import type { MusicProvider } from '@music/types';
import type { MusicState, StoreGet, StoreSet } from '@music/slice';

export const createLikeSlice = (set: StoreSet, get: StoreGet): Pick<MusicState, 'loadLikedList' | 'toggleLike'> => ({
  loadLikedList: async (p) => {
    const provider = p ?? get().playbackSource;
    let ids: string[] = [];
    try {
      ids = await platform.likedIds(provider);
    } catch {
      ids = [];
    }
    const idSet = new Set(ids);
    set((s) => ({
      likedByProvider: { ...s.likedByProvider, [provider]: idSet },
      // 播放源的红心集合是 likedByProvider[playbackSource] 的别名，保持同步
      likedSongIds: s.playbackSource === provider ? idSet : s.likedSongIds,
    }));
  },

  toggleLike: async (song) => {
    const provider = song.provider as MusicProvider;
    const caps = platform.capsOf(provider);
    if (!caps.likeWrite) {
      get().toast(provider === 'qqmusic' ? 'QQ 音乐当前仅支持读取账号收藏，暂不支持写回' : '咪咕音乐暂不支持红心收藏');
      return;
    }
    const setOf = (s: MusicState) => s.likedByProvider[provider] ?? new Set<string>();
    const liked = setOf(get()).has(song.id);
    // 乐观更新：先改 UI，失败回滚
    const optimistic = new Set(setOf(get()));
    if (liked) optimistic.delete(song.id);
    else optimistic.add(song.id);
    set((s) => ({
      likedByProvider: { ...s.likedByProvider, [provider]: optimistic },
      likedSongIds: s.playbackSource === provider ? optimistic : s.likedSongIds,
    }));

    try {
      await platform.likeToggle(provider, song, !liked);
      // 与服务器对齐；顺带刷新「我喜欢」歌单的曲目数
      await get().loadLikedList(provider);
      void get().loadUserPlaylists();
    } catch (e) {
      // 回滚
      const rollback = new Set(setOf(get()));
      if (liked) rollback.add(song.id);
      else rollback.delete(song.id);
      set((s) => ({
        likedByProvider: { ...s.likedByProvider, [provider]: rollback },
        likedSongIds: s.playbackSource === provider ? rollback : s.likedSongIds,
      }));
      get().toast(`红心同步失败：${String(e)}`);
    }
  },
});
