// UI切片 —— D-156 从 store.ts 按 action 段切出。
import { savePrefs } from '@music/prefs';
import type { MusicState, StoreGet, StoreSet } from '@music/slice';

/** 收起播放器的退场定时器。留着它才能在"退场途中又被点开"时取消关闭（见 setExpanded） */
let closeExpandedTimer: ReturnType<typeof setTimeout> | null = null;

export const createUiSlice = (
  set: StoreSet,
  get: StoreGet,
): Pick<MusicState, 'setExpanded' | 'closeExpanded' | 'setSkin' | 'toast' | 'clearToast'> => ({
  setExpanded: (open) => {
    // 展开时若退场动画正在播，必须**取消那次关闭** ——
    // 否则定时器到点仍会把 expanded 置 false，表现成"点开反而关了"。
    if (open && closeExpandedTimer) {
      clearTimeout(closeExpandedTimer);
      closeExpandedTimer = null;
    }
    set(open ? { expanded: true, expandedClosing: false } : { expanded: open });
  },

  closeExpanded: () => {
    if (!get().expanded || get().expandedClosing) return;
    set({ expandedClosing: true });
    // 300ms 对应 app.css `.music-exp.is-closing` 的 0.3s（断言 ANIM.durationSync 双向盯着）
    closeExpandedTimer = setTimeout(() => {
      closeExpandedTimer = null;
      set({ expandedClosing: false, expanded: false });
    }, 300);
  },

  setSkin: (s) => {
    set({ skin: s });
    savePrefs({ skin: s });
  },

  toast: (message, type = 'warning') => set({ musicToast: { type, message } }),
  clearToast: () => set({ musicToast: null }),
});
