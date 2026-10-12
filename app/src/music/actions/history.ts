// 播放历史切片 —— 「播放历史」段（D-156 从 store.ts 按 action 段切出）。
import { LS_HISTORY, sanitizeForStorage, writeLS } from '@music/persist';
import type { PlayHistoryEntry } from '@music/types';
import type { MusicState, StoreGet, StoreSet } from '@music/slice';

/** 播放历史上限 */
const MAX_HISTORY = 300;

export const createPlayHistorySlice = (set: StoreSet, get: StoreGet): Pick<MusicState, 'recordPlayHistory' | 'removePlayHistoryEntry' | 'clearPlayHistoryList'> => ({
  recordPlayHistory: (song, fromHistory) => {
    if (song.provider === 'local' && !song._localPath) return;
    const entry: PlayHistoryEntry = { song: sanitizeForStorage(song), playedAt: Date.now() };
    const rest = get().playHistoryList.filter(
      (e) => !(e.song.provider === song.provider && e.song.id === song.id),
    );
    // 从历史点播 → 不重复置顶（参考实现同语义：避免自己推动自己）
    const list = fromHistory ? get().playHistoryList : [entry, ...rest].slice(0, MAX_HISTORY);
    set({ playHistoryList: list });
    writeLS(LS_HISTORY, list);
  },

  removePlayHistoryEntry: (provider, id) => {
    const list = get().playHistoryList.filter((e) => !(e.song.provider === provider && e.song.id === id));
    set({ playHistoryList: list });
    writeLS(LS_HISTORY, list);
  },

  clearPlayHistoryList: () => {
    set({ playHistoryList: [] });
    writeLS(LS_HISTORY, []);
  },
});
