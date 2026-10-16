// 桌面歌词切片 —— D-156 从 store.ts 按 action 段切出。
import * as ipc from '@music/ipc';
import { songKey } from '@music/convert';
import type { MusicState, StoreGet, StoreSet } from '@music/slice';

/**
 * 把 store 状态里的桌面歌词偏好拼成推送形状。
 *
 * 单独抽出来是为了让"字段名映射"只有一处：`pushLyricsState`（完整推送）与
 * `pushLyricsPrefs`（轻量推送）都要用它，两处各拼一遍迟早会出现"一条通道多带一个
 * 字段、另一条忘了"的不一致，而症状是**外观偶尔回退**，很难联想到这里。
 */
function dlPrefsOf(s: {
  desktopLyricsFontSize: number;
  desktopLyricsHighlightColor: string;
  desktopLyricsBaseColor: string;
  desktopLyricsLineCount: number;
}): ipc.DesktopLyricsPrefs {
  return {
    fontSize: s.desktopLyricsFontSize,
    highlightColor: s.desktopLyricsHighlightColor,
    baseColor: s.desktopLyricsBaseColor,
    lineCount: s.desktopLyricsLineCount,
  };
}

export const createDesktopSlice = (
  set: StoreSet,
  get: StoreGet,
): Pick<
  MusicState,
  'hydratePlatform' | 'setLyricsWindowOpen' | 'pushLyricsState' | 'pushLyricsPrefs' | 'setCommentTab' | 'loadComments'
> => ({
  /**
   * 取一次桌面平台，写出桌面歌词能力位。
   *
   * 为什么是**入口挂载前**的一次性调用：平台是编译期常量，整局不会变；
   * 挂载后再补会让两处入口按钮先按 false（不渲染）画一帧，或反过来先按旧值闪一下。
   * 取不到（浏览器里直接开主窗 / IPC 失败）按 false 兜底 —— 藏一个入口好过留一个
   * 在本平台并不工作的入口。
   */
  hydratePlatform: async () => {
    try {
      const p = await ipc.fetchDesktopPlatform();
      set({ desktopLyricsSupported: p === 'windows' });
    } catch {
      set({ desktopLyricsSupported: false });
    }
  },

  setLyricsWindowOpen: async (open) => {
    // 本平台不提供桌面歌词窗时直接空转：设置页那项保持可交互（用户要求），
    // 但不能走到 IPC —— 那一侧没有对应窗口，硬开会报一句对用户无意义的错。
    if (!get().desktopLyricsSupported) return;
    // 先改状态再调命令：让 UI 立刻响应，不被 IPC 往返卡住。
    // 失败时回滚 —— 否则会留下"开关显示已开、窗口却没起来"的假状态。
    const prev = get().lyricsWindowOpen;
    set({ lyricsWindowOpen: open });
    try {
      if (open) await ipc.openLyricsWindow();
      else await ipc.closeLyricsWindow();
    } catch (e) {
      set({ lyricsWindowOpen: prev });
      get().toast(`桌面歌词窗口${open ? '打开' : '关闭'}失败：${String(e)}`);
      return;
    }
    // 开窗后立即推一次：新建的窗口手里没有任何状态，
    // 不推它就停在「待播放」，要等下次换歌才显示内容。
    if (open) await get().pushLyricsState();
  },

  pushLyricsState: async () => {
    const { currentSong, parsedLyrics, isPlaying, progressMs, durationMs, playMode } = get();
    // `songId` 用 `songKey`（provider:id）而不是裸 `song.id`：四个平台的 id 各自独立，
    // 裸 id 跨平台会撞车，歌词窗就无法区分"换歌了"与"还是同一首"。
    const payload: ipc.LyricsPushPayload = {
      songId: currentSong ? songKey(currentSong) : null,
      songName: currentSong?.name ?? '',
      artist: currentSong?.artist ?? '',
      // 契约要的是**毫秒**，而 `parseLrc` 产出的 `time` 是**秒** —— 这里必须换算，
      // 漏了会让整首歌的歌词都挤在开头几秒内（症状：歌词瞬间刷完然后不动）。
      lines: parsedLyrics.map((l) => ({ ms: Math.round(l.time * 1000), text: l.text })),
      playing: isPlaying,
      startedAtMs: progressMs,
      durationMs,
      sentAtEpoch: Date.now(),
      // 播放模式要跟着走：歌词窗的控制栏靠它显示正确的模式图标（两窗 store 互不可见）
      playMode,
      // 完整推送也带上偏好：新开的窗口首帧就能拿到正确外观，
      // 不必等用户去动一次设置（那样新窗口会先按默认值闪一下再跳成用户的值）。
      desktopLyrics: dlPrefsOf(get()),
    };
    try {
      // 窗口不存在时 Rust 侧静默成功，所以这里不需要先判断开没开
      await ipc.lyricsPush(payload);
    } catch {
      // 推失败不能影响播放：桌面歌词是旁路能力，窗口侧的问题不该阻断主流程
    }
  },

  pushLyricsPrefs: async () => {
    const payload: ipc.LyricsPrefsPayload = {
      prefsOnly: true,
      desktopLyrics: dlPrefsOf(get()),
    };
    try {
      await ipc.lyricsPush(payload);
    } catch {
      // 窗口没开时 Rust 静默成功；非 Tauri 环境（浏览器里直接开主窗）则忽略
    }
  },

  setCommentTab: (t) => set({ commentTab: t }),

  loadComments: async (song) => {
    if (song.provider !== 'netease') {
      set({ comments: null });
      return;
    }
    set({ loadingComments: true });
    try {
      const c = await ipc.musicSongComments(song.id, 1, 20);
      set({ comments: c, loadingComments: false });
    } catch {
      set({ comments: null, loadingComments: false });
    }
  },
});
