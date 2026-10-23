// 平台切片 —— D-156 从 store.ts 按 action 段切出。
import * as ipc from '@music/ipc';
import * as platform from '@music/platform';
import { savePrefs } from '@music/prefs';
import type { LoginInfo, MusicProvider } from '@music/types';
import type { MusicState, StoreGet, StoreSet } from '@music/slice';

/** 把 provider 的登录信息写进 loginInfos，并按需同步当前 loginInfo */
function mergeLogin(state: MusicState, provider: MusicProvider, info: LoginInfo | null) {
  return {
    loginInfos: { ...state.loginInfos, [provider]: info },
    loginInfo: state.playbackSource === provider ? info : state.loginInfo,
  };
}

export const createPlatformSlice = (
  set: StoreSet,
  get: StoreGet,
): Pick<
  MusicState,
  | 'switchPlaybackSource'
  | 'setSearchProvider'
  | 'loadAllLoginStatuses'
  | 'loadLoginStatus'
  | 'openLogin'
  | 'closeLogin'
  | 'logoutCurrent'
  | 'logoutFor'
> => ({
  switchPlaybackSource: async (p) => {
    if (get().playbackSource === p) return;
    set({
      playbackSource: p,
      loginInfo: get().loginInfos[p] ?? null,
      // 切换平台立即清空旧平台数据，避免残留闪烁
      userPlaylists: [],
      userPlaylistsError: '',
      officialCharts: [],
      recommendPlaylists: [],
      dailySongs: [],
      rightView: 'recommendations',
      leftView: 'playlists',
      leftPlaylistTracks: [],
      leftPlaylistMeta: null,
      rightPlaylistTracks: [],
      rightPlaylistMeta: null,
      likedSongIds: get().likedByProvider[p] ?? new Set<string>(),
      searchResults: [],
      searchHasMore: false,
      comments: null,
    });
    // 平台选择是**用户偏好**，必须落盘：恢复流程要按"上次那个平台"校验登录态，
    // 而这一项此前没持久化 → 重启后 playbackSource 恒为初始的 'netease'。
    savePrefs({ playbackSource: p });
    try {
      await ipc.musicSwitchProvider(p);
    } catch {
      // 后端未就绪（服务未启动）不阻断界面切换
    }
    await Promise.all([get().loadCharts(p), get().loadRecommend(p)]);
    if (get().loginInfos[p]?.logged_in) {
      await get().loadUserPlaylists(p);
      await get().loadLikedList(p);
    }
  },

  setSearchProvider: (p) => {
    if (get().searchProvider === p) return;
    set({
      searchProvider: p,
      searchResults: [],
      searchHasMore: false,
      playlistSearchResults: [],
      artistSearchResults: [],
      searchError: '',
    });
  },

  loadAllLoginStatuses: async () => {
    try {
      const statuses = await ipc.musicGetLoginStatuses();
      const infos: Record<MusicProvider, LoginInfo | null> = {
        netease: statuses.netease ?? null,
        kugou: statuses.kugou ?? null,
        qqmusic: statuses.qqmusic ?? null,
        migu: statuses.migu ?? null,
      };
      set({ loginInfos: infos, loginInfo: infos[get().playbackSource] ?? null });

      /*
       * **一个平台都没登录** ⇒ 默认落到「本地」。
       *
       * 四个平台的歌单、榜单、每日推荐全都要登录态；没登录时停在某个平台上，
       * 整屏都是空态 + 一串"可能需要登录"，用户第一眼看到的是"这个应用没内容"。
       * 而本地曲库不依赖任何账号 —— 它才是这时唯一**有东西可看**的页签。
       * 只在"当前页签还是初始的 playlists"时切，免得把用户手动选的页签抢走。
       */
      const anyLogged = Object.values(infos).some((i) => i?.logged_in);
      if (!anyLogged && get().leftView === 'playlists') set({ leftView: 'local' });
    } catch {
      // 服务未就绪：逐个兜底探测
      await Promise.all(
        (['netease', 'kugou', 'qqmusic', 'migu'] as MusicProvider[]).map((p) => get().loadLoginStatus(p)),
      );
    }
  },

  loadLoginStatus: async (p) => {
    const provider = p ?? get().playbackSource;
    try {
      const info = await platform.loginStatus(provider);
      set((s) => mergeLogin(s, provider, info?.logged_in ? info : null));
    } catch {
      set((s) => mergeLogin(s, provider, null));
    }
  },

  openLogin: async (p) => {
    const provider = p ?? get().playbackSource;
    set({ loginOpen: true, loginProvider: provider, qrLoading: true, qrStatus: '', qrUrl: '' });
    // 四平台统一走官方网页登录窗口，登录后 Rust 侧回读 Cookie 并落盘
    try {
      await platform.openLoginWindow(provider);
      set({ qrStatus: '请在打开的窗口中完成登录', qrLoading: false });
      // 轮询登录态，成功后自动收起
      const poll = async () => {
        if (!get().loginOpen || get().loginProvider !== provider) return;
        await get().loadLoginStatus(provider);
        if (get().loginInfos[provider]?.logged_in) {
          set({ loginOpen: false, qrStatus: '' });
          await get().loadUserPlaylists(provider);
          await get().loadLikedList(provider);
          if (provider === get().playbackSource) await get().loadCharts(provider);
          await get().loadRecommend(provider);
          get().toast(`${platform.providerLabel(provider)} 登录成功`, 'success');
          return;
        }
        setTimeout(poll, 1500);
      };
      setTimeout(poll, 1500);
    } catch (e) {
      set({ qrLoading: false, qrStatus: `登录窗口打开失败：${String(e)}` });
    }
  },

  closeLogin: () => set({ loginOpen: false, qrUrl: '', qrStatus: '' }),

  logoutCurrent: async () => {
    await get().logoutFor(get().playbackSource);
  },

  logoutFor: async (p) => {
    try {
      await platform.logout(p);
    } catch {
      // 后端失败也继续清本地态，避免「界面还显示已登录」
    }
    set((s) => ({
      ...mergeLogin(s, p, null),
      userPlaylists: s.playbackSource === p ? [] : s.userPlaylists,
      likedByProvider: { ...s.likedByProvider, [p]: new Set<string>() },
      likedSongIds: s.playbackSource === p ? new Set<string>() : s.likedSongIds,
    }));
  },
});
