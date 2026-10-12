// init切片 —— D-156 从 store.ts 按 action 段切出。
import * as ipc from '@music/ipc';
import { DL_BASE_COLOR_DEF, DL_HIGHLIGHT_COLOR_DEF, DL_LINE_COUNT, DL_LYRICS_SIZE, LYRICS_COLOR_DEF, LYRICS_MODE_DEF, LYRICS_SIZE, VINYL_COLOR_DEF } from '@music/player-options';
import { readLS, LS_HISTORY, LS_PREFS, readResumeSnapshot, clearResumeSnapshot } from '@music/persist';
import { Prefs } from '@music/prefs';
import type { LoginInfo, LyricsMode, PlayHistoryEntry, PlayMode, PlaybackQuality, MusicProvider } from '@music/types';
import type { IslandView, PlayerSkin } from '@music/store';
import type { MusicState, StoreGet, StoreSet } from '@music/slice';

/** 取整并夹到 [min, max]。用于把外部存进来的数值偏好收进合法区间（见 hydratePrefs） */
function clampInRange(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)));
}

/**
 * 登录态的**三态**判定（不是布尔）。
 *
 * ## 为什么必须分三态
 * 「明确未登录」与「探测失败」必须区别对待：断网时四个平台全都探不动，
 * 若一律当成"未登录"就清掉用户的播放快照，**用户一断网就丢播放进度**。
 *
 * ## 三态怎么从 `loginInfos` 里读出来
 * 这个区分是 Rust 侧刻意对齐出来的（见 `music_get_login_statuses` 的文档注释）：
 *   · `loginInfos[p] === null` —— 批量探测时该平台**探测失败**（网络/服务未就绪）。
 *     Rust 只在 `Some(info)` 时才 insert key，而 `.ok()` 把探测的 `Err` 吞成了 `None`。
 *   · `loginInfos[p]?.logged_in === false` —— **明确未登录**。
 *     cookie 为空或没有登录标记时，Rust 返回 `Ok(LoginInfo{logged_in:false})`。
 *   · `loginInfos[p]?.logged_in === true` —— 有效。
 *
 * ⚠️ 既有 13 处读取点全是 `loginInfos[p]?.logged_in`（布尔判据，**一个字都不该动**）；
 * 三态只在本函数与「启动恢复」流程里使用。两者并存是有意的：UI 只关心"能不能播"，
 * 而恢复流程要关心"是不是真的登出了"。
 */
export type LoginVerdict = 'valid' | 'logged_out' | 'probe_failed';

export function loginVerdict(infos: Record<MusicProvider, LoginInfo | null>, p: MusicProvider): LoginVerdict {
  const info = infos?.[p];
  if (info === null || info === undefined) return 'probe_failed';
  return info.logged_in ? 'valid' : 'logged_out';
}

export const createInitSlice = (set: StoreSet, get: StoreGet): Pick<MusicState, 'hydratePrefs' | 'init' | 'setProxyPort' | 'restoreSession' | 'finishRestore' | 'handleRestoreFailed'> => ({
  hydratePrefs: () => {
    const prefs = readLS<Partial<Prefs>>(LS_PREFS, {});
    const volume = typeof prefs.volume === 'number' ? prefs.volume : 0.8;
    /*
     * 播放模式：枚举型偏好**白名单收口**，脏值一律回落 'order'（新的默认档）。
     *
     * ⚠️ 这里刻意**不**因为默认值从 'list' 改成 'order' 而去迁移老偏好：
     * 用户在按钮上显式选过的档位就是他的选择，替他改回去等于产品替他做决定
     * （与 lyricsMode / islandView 的处理同一条纪律，见 D-137）。
     * 只有"从没选过"（键缺失或值不认识）的人才拿到新默认。
     * 白名单同时挡住旧版本残留与手改 localStorage 两种情况。
     */
    const ALL_MODES: readonly PlayMode[] = ['list', 'one', 'shuffle', 'order', 'heartbeat'];
    /*
     * 心动模式额外收一道门：`heartbeat` 落在白名单里也不算数。
     *
     * 冷启动这一刻 `queueFromLiked` 恒为假（还没有队列，见下方注释），
     * 所以心动模式**必然**不可用 —— 若照白名单放它进来，状态就是
     * "模式 = 心动，但那个档位此刻点不动、也不显示"，界面与行为对不上。
     * 需求要的是"不是「我喜欢的音乐」就不显示心动模式"，那就该在这里落回顺序播放：
     * 用户之后重新播「我喜欢的音乐」时，`playPlaylist` 会按 `likedHeartbeatOn`
     * 自动把心动模式接回来，这条偏好并没有丢。
     */
    const playMode: PlayMode =
      ALL_MODES.includes(prefs.playMode as PlayMode) && prefs.playMode !== 'heartbeat'
        ? (prefs.playMode as PlayMode)
        : 'order';
    const skin: PlayerSkin = prefs.skin ?? 'modern';
    const playbackQuality: PlaybackQuality = prefs.playbackQuality ?? 'hires';
    const lyricsFontSize =
      typeof prefs.lyricsFontSize === 'number' ? prefs.lyricsFontSize : LYRICS_SIZE.def;
    /*
     * 桌面歌词的两项数值偏好在这里夹到常量区间内。
     *
     * localStorage 是**外部可改的边界**（用户手改、旧版本残留、日后收紧量程后的老值），
     * 越界值会让设置页的滑杆与桌面歌词窗显示成两个数 —— 歌词窗那边本来就会夹
     * （见其 normalizePrefs），这里不夹就等于"两个窗口各说各话"。
     */
    const dlFontSize =
      typeof prefs.desktopLyricsFontSize === 'number' ? prefs.desktopLyricsFontSize : DL_LYRICS_SIZE.def;
    const dlLineCount =
      typeof prefs.desktopLyricsLineCount === 'number' ? prefs.desktopLyricsLineCount : DL_LINE_COUNT.def;
    /*
     * 灵动岛视图：只认两个字面量，其余一律回落 'play'。
     * 为什么不能写 `prefs.islandView ?? 'play'` —— localStorage 是外部可改的边界
     * （旧版本残留、手改、日后改名），`'xxx'` 这类脏值会被原样读进内存，
     * 于是卡片按歌词态渲染却拿到空分支。枚举型偏好一律白名单收口。
     */
    const islandView: IslandView = prefs.islandView === 'lyrics' ? 'lyrics' : 'play';
    // 歌词高亮方式：同 islandView，枚举型偏好白名单收口，脏值一律回落 LYRICS_MODE_DEF
    // ⚠️ 这里刻意**不**因为默认值改动而迁移老偏好：用户在设置页显式选过的值就是他的选择，
    //   替他改回去等于产品替他做决定。只有"从没选过"（键缺失）的人才拿到新默认（D-137：'line'）。
    const lyricsMode: LyricsMode = prefs.lyricsMode === 'word' ? 'word' : LYRICS_MODE_DEF;
    /*
     * 播放平台：同样白名单收口。
     * 脏值（手改 / 旧版本残留 / 日后新增平台后被删）一律回落 'netease' ——
     * 平台 id 是**四处**的键（后端命令派发、登录态表、快照校验、URL 解析），
     * 放过一个不认识的 id 会让恢复流程按它去查登录态，拿到必然是
     * 「探测失败」，于是每次都判成断网、永远不恢复。
     */
    const ALL_PROVIDERS: readonly MusicProvider[] = ['netease', 'kugou', 'qqmusic', 'migu'];
    const playbackSource: MusicProvider = ALL_PROVIDERS.includes(prefs.playbackSource as MusicProvider)
      ? (prefs.playbackSource as MusicProvider)
      : 'netease';
    set({
      playbackSource,
      volume,
      playMode,
      skin,
      playbackQuality,
      lyricsFontSize,
      lyricsHighlightColor: prefs.lyricsHighlightColor ?? LYRICS_COLOR_DEF,
      lyricsMode,
      desktopLyricsFontSize: clampInRange(dlFontSize, DL_LYRICS_SIZE.min, DL_LYRICS_SIZE.max),
      desktopLyricsHighlightColor: prefs.desktopLyricsHighlightColor ?? DL_HIGHLIGHT_COLOR_DEF,
      desktopLyricsBaseColor: prefs.desktopLyricsBaseColor ?? DL_BASE_COLOR_DEF,
      desktopLyricsLineCount: clampInRange(dlLineCount, DL_LINE_COUNT.min, DL_LINE_COUNT.max),
      dynamicEnabled: prefs.dynamicEnabled === true,
      discMode: prefs.discMode === true,
      vinylColorMode: prefs.vinylColorMode === 'custom' ? 'custom' : 'auto',
      vinylCustomColor: prefs.vinylCustomColor ?? VINYL_COLOR_DEF,
      islandView,
      // 布尔项一律用 === true 收口（与 dynamicEnabled / discMode 同一写法）
      likedHeartbeatOn: prefs.likedHeartbeatOn === true,
      // 队列上下文每次启动都从零开始：cold start 时还没有队列，标成"来自我喜欢音乐"是假的
      queueFromLiked: false,
      heartbeatSeeded: false,
    });
  },

  init: async () => {
    // 恢复偏好（与启动时那次水合是同一份实现，重复调用无副作用）
    get().hydratePrefs();

    // 恢复播放历史 + 本地曲库
    const history = readLS<PlayHistoryEntry[]>(LS_HISTORY, []);
    set({ playHistoryList: Array.isArray(history) ? history : [] });
    get().loadLocalSongs();

    // 代理端口（懒启动，失败不阻断）
    try {
      const port = await ipc.getProxyPort();
      set({ proxyPort: port });
    } catch {
      // 音频代理未就绪：播放时会再试
    }

    // 各平台登录态
    await get().loadAllLoginStatuses();

    // 首屏发现数据
    await Promise.all([get().loadCharts(), get().loadRecommend()]);
    if (get().loginInfos[get().playbackSource]?.logged_in) {
      await get().loadUserPlaylists();
      await get().loadLikedList();
    }
  },

  setProxyPort: (p) => set({ proxyPort: p }),

  /**
   * 启动恢复上次播放（Q6：本次会话只跑一次）。
   *
   * ## 为什么不挂在 `init` 里
   * `init` 挂在音乐屏且**没有防重入守卫** —— 切走再切回会重跑。恢复挂在它里面
   * 就会变成"每次进屏都恢复一次"，并覆盖用户刚做的操作。所以它有独立的闸。
   *
   * ## 判据链（顺序不能换）
   *   1. 闸 + 快照：没快照 → 直接返回，**与现在行为完全一致**（不显示播放条）
   *   2. 探一次目标平台的登录态 —— 必须**自己探**：`loginInfos` 初值全是 `null`，
   *      分不清"没探过"与"探过但失败"，不能靠"看现成的"来判断
   *   3. Q1 三态分流：
   *        明确未登录 → **清快照**（用户的登录都没了，恢复出来也是播不了）
   *        探针失败   → **保留快照、本次不恢复**，并把闸退回 false 允许下次重试
   *        有效       → 恢复
   *   4. 恢复：装载队列 + 停在**暂停态** + 定位到快照里的进度（Q2）
   */
  restoreSession: async () => {
    if (get().restoreAttempted) return;
    set({ restoreAttempted: true });

    const snap = readResumeSnapshot();
    if (!snap) return;

    // 队列/下标已在 readResumeSnapshot 里做过结构校验，这里仍要防一手：
    // 快照是外部可改的边界，不假设"读出来就一定自洽"
    const song = snap.queue[snap.index];
    if (!song) {
      clearResumeSnapshot();
      return;
    }

    await get().loadLoginStatus(snap.provider);
    const verdict = loginVerdict(get().loginInfos, snap.provider);
    if (verdict === 'logged_out') {
      // Q1①：明确未登录 → 清掉快照，下次不再尝试
      clearResumeSnapshot();
      return;
    }
    if (verdict === 'probe_failed') {
      // Q1②：探不动（断网 / 服务未就绪）**不等于**登出。保留快照，把闸退回，
      // 用户下次进屏、网络也好了，会自然恢复。静默——「没恢复」的表现与现在一致，
      // 不该弹任何提示。
      set({ restoreAttempted: false });
      return;
    }

    // Q1③：有效 → 恢复。restoring 打开失败切歌通道，并让静默失败继续走
    set({ restoring: true });
    await get().playSong(song, snap.queue, {
      autoplay: false,
      expand: false,
      resumeAtMs: snap.progressMs,
    });
  },

  finishRestore: () => {
    // 已经离开恢复态就别覆盖（比如用户在恢复过程中自己点了别的歌）
    if (get().restoring) set({ restoring: false });
  },

  handleRestoreFailed: () => {
    if (!get().restoring) return;
    const { queue, currentIndex } = get();
    // 下一首还有 → 继续试。**带上 autoplay:true**：Q4 拍板「切到第一首能播的就
    // 自动播放」—— 恢复的头一首保持暂停（那是需求要的），一旦因为它失败而换了歌，
    // 就已经进入"找一首能播的"这条路了，此时静默自动播才对。
    if (currentIndex + 1 < queue.length) {
      const nextSong = queue[currentIndex + 1];
      void get().playSong(nextSong, queue, { autoplay: true, expand: false });
      return;
    }
    // 整条队列都试过了 → 这次恢复失败：清空（clearQueue 内会清快照）
    get().clearQueue();
    set({ restoring: false });
  },
});
