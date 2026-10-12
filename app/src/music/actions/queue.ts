// 队列切片 —— D-156 从 store.ts 按 action 段切出。
import { songKey } from '@music/convert';
import { writeResumeSnapshot, clearResumeSnapshot, truncateQueueForSnapshot, sanitizeForStorage, SNAPSHOT_VERSION } from '@music/persist';
import { MAX_PLAY_QUEUE } from '@music/slice';
import type { MusicState, StoreGet, StoreSet } from '@music/slice';


export const createQueueSlice = (set: StoreSet, get: StoreGet): Pick<MusicState, 'appendToQueue' | 'playNext' | 'removeFromQueue' | 'clearQueue' | 'persistSnapshot' | 'clearSnapshot' | 'setQueueOpen'> => ({
  appendToQueue: (songs) => {
    const { queue } = get();
    const ids = new Set(queue.map(songKey));
    const unique = songs.filter((s) => !ids.has(songKey(s)));
    if (unique.length === 0) return;
    const remaining = MAX_PLAY_QUEUE - queue.length;
    set({ queue: [...queue, ...unique.slice(0, Math.max(0, remaining))] });
  },

  playNext: (song) => {
    const { queue, currentSong } = get();
    const key = songKey(song);

    // 边界 ①：这首歌**就是正在播的那首**。
    // 不能按常规流程"摘掉再插" —— 摘掉会把当前项从队列里删掉，于是 `currentSong` 在播、
    // 队列里却找不到它（自相矛盾，且 `removeFromQueue` 那类逻辑会开始出错）。
    if (currentSong && songKey(currentSong) === key) {
      get().toast('这首歌正在播放');
      return;
    }

    // 边界 ②：这首歌**已在队列里** → 先摘掉再插，否则队列里会出现两份。
    // 注意这一步会让当前歌之后的所有项前移一位，所以**不能**用 `currentIndex + 1` 推插入点。
    const without = queue.filter((s) => songKey(s) !== key);
    const at = currentSong ? without.findIndex((s) => songKey(s) === songKey(currentSong)) : -1;
    const insertAt = at >= 0 ? at + 1 : 0;
    const next = [...without.slice(0, insertAt), song, ...without.slice(insertAt)];
    set({ queue: next });
    // 同理，currentIndex 也必须**按当前歌重新定位**，不能沿用旧值（那是位置漂移的来源）
    if (currentSong) {
      const idx = next.findIndex((s) => songKey(s) === songKey(currentSong));
      if (idx >= 0) set({ currentIndex: idx });
    }
    get().toast('已添加到下一首播放');
  },

  removeFromQueue: (index) => {
    const { queue, currentSong, currentIndex } = get();
    if (index < 0 || index >= queue.length) return;
    const removedCurrent = index === currentIndex;
    const nextQ = queue.filter((_, i) => i !== index);
    if (nextQ.length === 0) {
      set({ queue: [], currentSong: null, playUrl: '', isPlaying: false, currentIndex: 0 });
      // 队列空了 = 没有当前歌曲了，桌面歌词要跟着清空（否则停在最后一首）
      void get().pushLyricsState();
      return;
    }
    set({ queue: nextQ, currentIndex: Math.min(index, nextQ.length - 1) });
    if (removedCurrent) void get().playSong(nextQ[Math.min(index, nextQ.length - 1)]);
    else if (index < currentIndex) set({ currentIndex: currentIndex - 1 });
    void currentSong; // 保留引用，避免未使用告警
  },

  clearQueue: () => {
    set({ queue: [], currentSong: null, playUrl: '', isPlaying: false, currentIndex: 0 });
    // 同上：清空队列后没有当前歌曲了，推一次空状态让桌面歌词归位
    void get().pushLyricsState();
    // 队列空了就不该留快照 —— 否则下次启动会恢复出一个"用户刚清掉的队列"
    clearResumeSnapshot();
  },

  persistSnapshot: () => {
    const { queue, currentIndex, currentSong, playbackSource, progressMs } = get();
    if (!currentSong || queue.length === 0) {
      clearResumeSnapshot();
      return;
    }
    // 下标以 currentSong **反查**为准，而不是直接信 currentIndex：
    // 两者在 playSong 里同步设置，但"从播放历史点歌"等路径可能让它们短暂不一致，
    // 写错下标会让恢复后停在一首完全不同的歌上（播放条却显示 currentSong，自相矛盾）。
    const found = queue.findIndex((s) => songKey(s) === songKey(currentSong));
    const index = found >= 0 ? found : currentIndex;
    if (index < 0 || index >= queue.length) {
      clearResumeSnapshot();
      return;
    }
    const { queue: q, index: idx } = truncateQueueForSnapshot(queue, index);
    writeResumeSnapshot({
      v: SNAPSHOT_VERSION,
      provider: playbackSource,
      // sanitizeForStorage 清掉 data URL 封面（base64 可能上百 KB，
      // 200 首塞进 localStorage 会直接触发配额失败）
      queue: q.map(sanitizeForStorage),
      index: idx,
      progressMs: Math.max(0, Math.round(progressMs)),
      savedAt: Date.now(),
    });
  },

  clearSnapshot: () => clearResumeSnapshot(),

  setQueueOpen: (open) => set({ queueOpen: open }),
});
