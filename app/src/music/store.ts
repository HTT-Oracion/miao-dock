/**
 * 音乐模块状态层（zustand）—— 播放 + 四平台 + 本地 + 发现，全模块唯一状态源。
 *
 * 从参考实现（Zustand store，3559 行）移植**逻辑**、剥离 Chakra UI 绑定（PD-1「界面重写」）。
 * 本文件只持状态与副作用，不渲染任何 UI；UI 在 screens/MusicScreen.tsx 与其子组件。
 *
 * 与参考实现的对应关系（便于日后对照）：
 *   playbackSource/searchProvider        同参考实现（搜索源可独立于播放源）
 *   leftView   playlists|tracks|local|history   左栏四视图（参考 leftPanelView）
 *   rightView  recommendations|tracks|daily     右栏三视图（参考 rightPanelView）
 *   recommendPlaylists                    参考 dailyRecommendPlaylists（网易云/咪咕）
 *   dailySongs                            参考 recommendSongs（仅网易云）
 *
 * 播放地址解析：
 * - 本地歌曲：`convertFileSrc(绝对路径)` 转 asset 协议，WebView 内可直接播放；
 * - 在线歌曲：**先查本地整首音频缓存**（命中直接播本地、不回源），
 *   未命中再按平台调 song_url 拿真实 URL、走音频代理
 *   `http://127.0.0.1:{port}/audio?url=...`（加 Referer/CORS/流式，Range 透传），
 *   并在**后台**预热整首缓存（不阻塞播放、失败不打断播放）；
 * - 封面：`http://127.0.0.1:{port}/cover?url=...`（见 coverProxyUrl）。
 *
 * 持久化：播放历史、本地曲库、播放偏好（音质/音量/皮肤/播放模式）存 WebView localStorage。
 *
 * 桌面歌词：独立窗口（label 固定 `desktop-lyrics`），主窗通过 `pushLyricsState`
 * 按「状态跳变」推送（换歌 / 歌词就绪 / 播放态切换 / 拖动进度 / 开窗），
 * 进度**不推** —— 歌词窗自己按 `startedAtMs` + 本地单调钟推进。详见 `pushLyricsState` 注释。
 *
 * ## 为什么用 localStorage 而不是 Tauri Store（已实测，不是推测）
 * 参考实现用 tauri-plugin-store，理由是**桌面歌词独立窗口需跨进程共享**。
 * 2026-10-04 实测（本机双窗口探针，连跑两次，8/8 全绿）确认：
 * **同 origin 的两个 WebviewWindow 共享同一份 localStorage，且跨进程重启持久。**
 * 机制依据：wry 0.57 未用 `with_data_store_identifier` 隔离 → 走
 * `WKWebsiteDataStore::defaultDataStore`（macOS 上所有 WebView 共享的默认持久化存储）。
 * 因此桌面歌词窗口**可以继续用 localStorage**，不必切 Tauri Store。
 * ⚠️ 两条前提若改变需重测：① 给窗口加了 `with_data_store_identifier`（会各自分配独立 store）；
 * ② 桌面歌词窗口若加载**外部 origin**（localStorage 按 origin 隔离，就不共享了）。
 * 实测记录：lsm-probe（工作区内，2026-10-04）；台账见 docs/spec-notes.md D-47。
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import { create } from 'zustand';
import * as ipc from '@music/ipc';
import type { ParsedLyricLine } from '@tools/lyrics';
import { songKey } from './convert';
import { savePrefs } from './prefs';
import { MAX_PLAY_QUEUE } from './slice';
import { createPlayHistorySlice } from './actions/history';
import { createLeftSlice } from './actions/left';
import { createLocalSlice } from './actions/local';
import { createRightSlice } from './actions/right';
import { createLikeSlice } from './actions/like';
import { createLyricsSlice } from './actions/lyrics';
import { createSearchSlice } from './actions/search';
import { createInitSlice } from './actions/init';
import { createQueueSlice } from './actions/queue';
import { createPlatformSlice } from './actions/platform';
import { createDesktopSlice } from './actions/desktop';
import { createUiSlice } from './actions/ui';
import {
  DL_BASE_COLOR_DEF,
  DL_HIGHLIGHT_COLOR_DEF,
  DL_LINE_COUNT,
  DL_LYRICS_SIZE,
  LYRICS_COLOR_DEF,
  LYRICS_MODE_DEF,
  LYRICS_SIZE,
  VINYL_COLOR_DEF,
} from '@music/player-options';
import * as platform from '@music/platform';
import type { MusicProvider } from '@music/platform';
import type {
  Artist,
  CommentPage,
  LocalSongInfo,
  LoginInfo,
  LyricsMode,
  Playlist,
  PlayHistoryEntry,
  PlayMode,
  PlaybackQuality,
  Song,
} from '@music/types';

// ------------------------------------------------------------------ 常量 / 工具

/** 展开播放器皮肤（设计稿 M5 六皮肤；spectrum 为 CSS 近似，不做 WebGL） */
export type PlayerSkin = 'modern' | 'glass' | 'immersive' | 'spectrum' | 'vinyl' | 'cover';

/** 左栏视图：我的歌单 / 歌单曲目 / 本地 / 播放历史 */
export type LeftView = 'playlists' | 'tracks' | 'local' | 'history';
/** 右栏视图：推荐歌单 / 曲目（歌单或榜单）/ 每日推荐 */
export type RightView = 'recommendations' | 'tracks' | 'daily';
/** 搜索标签：单曲 / 歌单 / 歌手 */
export type SearchTab = 'song' | 'playlist' | 'artist';
/** 展开播放器面板：歌词 / 评论 */
export type CommentTab = 'lyric' | 'comments';

/**
 * 灵动岛展开态的视图：`play` = 播放卡（歌手/进度/传输控件）、`lyrics` = 歌词卡。
 *
 * 为什么要**持久化**（而不是组件内的 useState）：hover 展开是"临时看一眼"的动作，
 * 用户一旦切到歌词卡，下次展开还该是歌词卡 —— 不记住就等于每次都要再点一次切换键。
 */
export type IslandView = 'play' | 'lyrics';

// ------------------------------------------------------------------ 无版权自动跳过控制

let unplayableSkipCount = 0;
let isAutoSkipping = false;
/** 每次 playSong 递增，用于忽略飞行中的旧请求（切歌竞态） */
let playSeq = 0;

// ------------------------------------------------------------------ 状态定义

export interface MusicState {
  // ---- 播放 ----
  currentSong: Song | null;
  queue: Song[];
  currentIndex: number;
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  volume: number;
  /**
   * 静音。
   *
   * 与 `volume` **分开存**：静音时若把音量值改成 0，「取消静音」就回不到原来的音量
   * （用户只是临时静一下，不该丢掉他的音量设置）。落到 audio 元素上就是 `muted` 属性，
   * 完全不必动 volume —— 两者本来就该是正交的。
   */
  muted: boolean;
  playMode: PlayMode;
  playUrl: string;
  playbackQuality: PlaybackQuality;
  currentQuality: string;
  currentBitrate: number;
  proxyPort: number;
  playHistoryList: PlayHistoryEntry[];
  /**
   * 换音质时的**续播位置**（毫秒，0 表示无需续播）。
   * 换档必须重新取一次音频地址，`<audio>` 因此会从 0 重新起播 ——
   * 这个字段把「换档前的进度」交给播放内核，让它在新地址上先 seek 再播。
   */
  resumeAtMs: number;

  // ---- 启动恢复（restoreSession）----
  /**
   * 本次会话**是否正在恢复**上次播放。
   *
   * 作用是给「恢复态」专有的行为开闸，最主要是**加载失败自动切下一首**：
   * 恢复时队列里可能有失效的本地文件 / 下架的专辑，遍历到第一首能播的为止。
   * 这个开关只在恢复期间为真 —— 平时播放失败仍走原有的「提示 + 停」，
   * 否则一次网络抖动就会把用户的队列清空。
   */
  restoring: boolean;
  /**
   * 本次会话**是否已经尝试过恢复**（Q6：只跑一次）。
   *
   * 为什么需要：切走音乐屏再切回会重跑 `init()`，而恢复挂在音乐屏上；
   * 没有这个闸就会每次进屏都恢复一次，并覆盖用户刚做的操作。
   *
   * ⚠️ 登录态**探针失败**时会把它退回 `false`（允许下次重试）——
   * 否则断网时第一次进屏就把闸关死，网络恢复后用户永远等不到恢复。
   * 那种情况下"没恢复"的表现是自然的（播放条不出现，与现在一致），不该有任何提示。
   */
  restoreAttempted: boolean;

  // ---- 播放/媒体的持久化偏好（设置页「播放·媒体」）----
  lyricsFontSize: number;
  lyricsHighlightColor: string;
  /** 歌词高亮方式：word 逐字 / line 整行一次性点亮 */
  lyricsMode: LyricsMode;
  /**
   * 桌面歌词的独立偏好（设置项在「桌面歌词设置」弹窗里，不在设置页的歌词小节）。
   * 与上面两条全局歌词偏好分开，理由见 `Prefs` 接口里的注释。
   */
  desktopLyricsFontSize: number;
  desktopLyricsHighlightColor: string;
  desktopLyricsBaseColor: string;
  desktopLyricsLineCount: number;
  dynamicEnabled: boolean;
  discMode: boolean;
  vinylColorMode: 'auto' | 'custom';
  vinylCustomColor: string;
  /** 灵动岛视图（见 `Prefs.islandView` 的注释：为什么必须持久化） */
  islandView: IslandView;

  // ---- 本地 ----
  localSongs: LocalSongInfo[];
  localQueue: Song[];
  importingLocal: boolean;

  // ---- 平台 ----
  playbackSource: MusicProvider;
  searchProvider: MusicProvider;
  loginInfo: LoginInfo | null;
  loginInfos: Record<MusicProvider, LoginInfo | null>;

  // ---- 搜索 ----
  searchText: string;
  searchTab: SearchTab;
  searchResults: Song[];
  /** 搜索结果是否还有下一页（由「本页是否被填满」推断，各平台页大小不同见 platform.searchPageSize） */
  searchHasMore: boolean;
  loadingMoreSearch: boolean;
  playlistSearchResults: Playlist[];
  artistSearchResults: Artist[];
  searching: boolean;
  searchError: string;

  // ---- 左栏（我的音乐）----
  leftView: LeftView;
  userPlaylists: Playlist[];
  loadingUserPlaylists: boolean;
  userPlaylistsError: string;
  leftPlaylistMeta: Playlist | null;
  leftPlaylistTracks: Song[];
  loadingLeftTracks: boolean;
  loadingMoreLeft: boolean;

  // ---- 右栏（发现）----
  rightView: RightView;
  officialCharts: Playlist[];
  loadingCharts: boolean;
  recommendPlaylists: Playlist[];
  loadingRecommend: boolean;
  dailySongs: Song[];
  loadingDaily: boolean;
  rightPlaylistMeta: Playlist | null;
  rightPlaylistTracks: Song[];
  loadingRightTracks: boolean;
  loadingMoreRight: boolean;

  // ---- 红心 ----
  /** **播放源**的红心集合（播放条/队列用；= likedByProvider[playbackSource]） */
  likedSongIds: Set<string>;
  /**
   * 按平台分片的红心集合。
   *
   * 为什么不能只用一个集合：搜索源可独立于播放源（设计稿 S9），若红心只看播放源，
   * 在「播放酷狗、搜索网易云」时红心会显示成错的状态、写回也会打到错平台。
   */
  likedByProvider: Record<MusicProvider, Set<string>>;

  // ---- 歌词 / 评论 ----
  parsedLyrics: ParsedLyricLine[];
  comments: CommentPage | null;
  loadingComments: boolean;
  commentTab: CommentTab;

  // ---- 桌面歌词（独立窗口）----
  /**
   * 桌面歌词窗是否开着。
   *
   * 它是**主窗侧对窗口存在性的认知**，不是窗口自己上报的实时状态：
   * 歌词窗右上角的关闭按钮直接调 Rust 的 `close_lyrics_window`（窗口的生死归主窗管），
   * 不会回头改这个字段。所以用户从歌词窗内部关掉窗口后，这里会**短暂偏乐观**，
   * 再点一次开关即自愈（幂等调用 + 重新置位）。要彻底消除这个偏差需要 Rust 侧
   * 在窗口关闭时 emit 一个事件，那是改动冻结侧的事，本轮不做。
   */
  lyricsWindowOpen: boolean;

  // ---- UI ----
  queueOpen: boolean;
  expanded: boolean;
  skin: PlayerSkin;
  loginOpen: boolean;
  loginProvider: MusicProvider;
  qrUrl: string;
  qrStatus: string;
  qrLoading: boolean;
  musicToast: { type: 'warning' | 'success'; message: string } | null;

  // ---- Actions ----
  init: () => Promise<void>;
  /**
   * 只把**持久化偏好**读回内存（纯 localStorage，无网络/无副作用）。
   *
   * 为什么单独抽一个：`init()` 会拉登录态与首屏数据，只在音乐屏挂载时跑。
   * 而设置页「播放·媒体」也要读这些偏好 —— 冷启动后直接进设置页时若不水合，
   * 控件会显示默认值而不是上次存的值（同一个偏好出现两个事实）。
   * 所以由应用启动时调一次（见 main.tsx）。
   */
  hydratePrefs: () => void;
  setProxyPort: (p: number) => void;

  // 本地
  loadLocalSongs: () => void;
  importLocal: (paths: string[]) => Promise<void>;
  importFolder: (folder: string) => Promise<void>;
  removeLocalSong: (id: string) => void;
  clearLocalSongs: () => void;

  // 播放
  /**
   * 播放一首歌。
   *
   * `opts.expand`：播放后是否展开播放器（即"详情"，《09》§5.6 第 3 项）。
   * **默认 true**（调用点绝大多数是"用户点了某一首"）；自动续播/切歌传 false。
   *
   * `opts.autoplay`：**默认 true**。传 false 时取到地址后停在暂停态 ——
   * 这是「启动恢复上次播放」唯一需要的形态（需求原话："显示播放条、定位到时间，
   * 但**暂停**"）。不复用这条路径就得把 playSong 的全套逻辑（队列设置、歌词加载、
   * URL 解析、无版权跳歌、playSeq 竞态保护）**再写一遍**，那是必然走偏的第二份实现。
   *
   * `opts.resumeAtMs`：起始播放位置（毫秒）。与 `resumeAtMs` 状态字段配合：
   * 冷启动是**全新加载**，`src` 刚变时设 `currentTime` 会被浏览器忽略，
   * 所以这里只**记录意图**，真正的 seek 交给播放内核在 `loadedmetadata` 之后做
   * （见 MusicKernel）。传 0 表示从头开始。
   */
  playSong: (
    song: Song,
    queue?: Song[],
    opts?: { fromHistory?: boolean; expand?: boolean; autoplay?: boolean; resumeAtMs?: number },
  ) => Promise<void>;
  /**
   * 启动恢复上次播放（Q6：本次会话只跑一次）。
   *
   * 完整判据链见实现处。三个要点：
   *   · **没有快照 → 什么都不做**（与现在行为完全一致：不显示播放条）
   *   · **明确未登录 → 清快照**；**探针失败 → 保留快照且不恢复**（Q1）
   *   · 恢复出来的歌**停在暂停态**，定位到快照里的进度
   */
  restoreSession: () => Promise<void>;
  /**
   * 恢复成功：这首歌**真的加载出来了** → 关掉恢复态。
   *
   * 为什么必须有这一步（`restoring` 只会开不会关的话就是个缺陷）：
   * 闸一直开着的话，用户之后正常播放遇到一次网络失败，也会走"静默 + 遍历整个队列"，
   * 一次抖动就把队列清空。判据用**音频真的开始加载**（`loadedmetadata`），
   * 而不是"URL 解析成功" —— 地址拿到了不等于这歌能播。
   */
  finishRestore: () => void;
  /**
   * 恢复态下这首歌加载失败（Q4）→ 换下一首继续试。
   *
   * 遍历到队列尽头 = 这次恢复彻底失败 → 清空播放条（队列空 → 播放条自动隐藏）。
   * 恢复态**不弹提示**：用户还没做任何操作，一串 toast 是纯噪音；
   * 而"播放条没出现"与"从来没恢复过"在视觉上无法区分，也不该区分。
   */
  handleRestoreFailed: () => void;
  playQueue: (songs: Song[], startIndex: number, opts?: { expand?: boolean }) => Promise<void>;
  /**
   * 「下一首播放」：把这首歌插到**当前播放的下一首**位置。
   * 与 `appendToQueue`（加进队尾）是两种不同的用户意图，所以刻意分成两个 action。
   */
  playNext: (song: Song) => void;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  /**
   * 一首**自然播完**时的分流。
   *
   * 单独成一个 action（而不是让组件直接调 `next()`）的原因：
   * 「单曲循环」只在**自动播完**时重播，而**手动点下一首**必须换歌 ——
   * 这两条路的差异没法塞进 `next()` 里（它两种调用都要服务）。
   */
  handleTrackEnded: () => void;
  /** 心动模式取不到相似歌曲时的降级：按队列顺序取下一首（不随机） */
  fallbackNext: () => void;
  seek: (ms: number) => void;
  setVolume: (v: number) => void;
  /** 静音/取消静音（不改 volume，见 `muted` 字段注释） */
  toggleMute: () => void;
  /** 滚轮调音量：按**步长**增减并夹到 [0,1]（滚轮是一串离散事件，用步长比按 delta 直接赋值稳） */
  stepVolume: (delta: number) => void;
  /**
   * 关闭播放：清掉当前歌曲与进度，**保留队列**。
   * 与 `clearQueue` 的分工：那是清空列表，这是「停下这一首」。
   */
  closePlayback: () => void;
  cycleMode: () => void;
  /** 换音质：更新偏好，并在**正在播放**时重取地址续播（保住当前进度） */
  setPlaybackQuality: (q: PlaybackQuality) => Promise<void>;
  setLyricsFontSize: (px: number) => void;
  setLyricsHighlightColor: (color: string) => void;
  setLyricsMode: (mode: LyricsMode) => void;
  /** 桌面歌词独立字号（px，当前行）。与 `setLyricsFontSize` 不是同一件事 */
  setDesktopLyricsFontSize: (px: number) => void;
  /** 桌面歌词当前行颜色 */
  setDesktopLyricsHighlightColor: (color: string) => void;
  /** 桌面歌词未高亮行的颜色 */
  setDesktopLyricsBaseColor: (color: string) => void;
  /** 桌面歌词显示行数（含当前行） */
  setDesktopLyricsLineCount: (n: number) => void;
  /** 桌面歌词四项偏好一起恢复出厂值（弹窗里的「恢复默认」） */
  resetDesktopLyricsPrefs: () => void;
  setDynamicEnabled: (on: boolean) => void;
  setDiscMode: (on: boolean) => void;
  setVinylColorMode: (mode: 'auto' | 'custom') => void;
  setVinylCustomColor: (color: string) => void;
  /** 切灵动岛展开态的视图（播放卡 ⇄ 歌词卡），并记住这次选择 */
  setIslandView: (v: IslandView) => void;
  /** 播放内核消费完续播位置后清零 */
  clearResumeAt: () => void;
  setProgress: (ms: number) => void;
  setDuration: (ms: number) => void;

  // 队列
  appendToQueue: (songs: Song[]) => void;
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
  /**
   * 把当前播放态写进「启动恢复快照」（localStorage）。
   *
   * ## 调用时机（少一个就丢一类场景）
   *   · 切歌成功后 —— 换歌后立刻退出，进度是 0 但歌与队列要对
   *   · 暂停时 —— 覆盖"听完暂停、第二天再开"这个主场景
   *   · MusicKernel 的低频定时器 —— 兜底"听着直接退出"
   *
   * **不在每次 progress 变化时写**：进度每秒变几十次，
   * 而快照序列化 200 首歌约几十 KB —— 那是持续 I/O。
   */
  persistSnapshot: () => void;
  /** 清掉快照（明确清空播放、或恢复时判定"不该恢复"） */
  clearSnapshot: () => void;
  setQueueOpen: (open: boolean) => void;

  // 播放历史
  recordPlayHistory: (song: Song, fromHistory?: boolean) => void;
  removePlayHistoryEntry: (provider: string, id: string) => void;
  clearPlayHistoryList: () => void;

  // 平台
  switchPlaybackSource: (p: MusicProvider) => Promise<void>;
  setSearchProvider: (p: MusicProvider) => void;
  loadAllLoginStatuses: () => Promise<void>;
  loadLoginStatus: (p?: MusicProvider) => Promise<void>;
  openLogin: (p?: MusicProvider) => Promise<void>;
  closeLogin: () => void;
  logoutCurrent: () => Promise<void>;
  logoutFor: (p: MusicProvider) => Promise<void>;

  // 搜索
  setSearchText: (t: string) => void;
  setSearchTab: (t: SearchTab) => void;
  search: (kw?: string) => Promise<void>;
  /** 搜索结果触底续拉下一页（offset = 已加载条数） */
  loadMoreSearch: () => Promise<void>;
  searchArtists: (kw?: string) => Promise<void>;
  searchPlaylists: (kw?: string) => Promise<void>;
  clearSearch: () => void;

  // 左栏
  setLeftView: (v: LeftView) => void;
  loadUserPlaylists: (p?: MusicProvider) => Promise<void>;
  openLeftPlaylist: (pl: Playlist) => Promise<void>;
  loadMoreLeft: () => Promise<void>;
  loadAllLeft: () => Promise<void>;
  backToPlaylists: () => void;

  // 右栏
  setRightView: (v: RightView) => void;
  loadCharts: (p?: MusicProvider) => Promise<void>;
  loadRecommend: (p?: MusicProvider) => Promise<void>;
  openRightPlaylist: (pl: Playlist) => Promise<void>;
  openRightChart: (pl: Playlist) => Promise<void>;
  loadMoreRight: () => Promise<void>;
  backToRecommendations: () => void;
  togglePlaylistSubscribe: (pl: Playlist) => Promise<void>;

  // 红心
  loadLikedList: (p?: MusicProvider) => Promise<void>;
  /** 红心/取消红心：平台取自**歌曲自身**（song.provider），不跟随播放源 */
  toggleLike: (song: Song) => Promise<void>;

  // 歌词 / 评论
  loadLyrics: (song: Song) => Promise<void>;
  setCommentTab: (t: CommentTab) => void;
  loadComments: (song: Song) => Promise<void>;

  // 桌面歌词
  /**
   * 开关桌面歌词窗。
   *
   * 打开时**立即推一次状态**：窗口刚建好时还没有任何 payload，
   * 不推的话它会一直停在「待播放」，直到下一次换歌/播放态变化才显示内容。
   */
  setLyricsWindowOpen: (open: boolean) => Promise<void>;
  /**
   * 把当前播放状态推给桌面歌词窗（换歌 / 歌词就绪 / 播放态变化 / 开窗时调用）。
   *
   * ## 推送判据：推"状态突变"，不推"连续量"
   *
   * 只有**用户能感知到的状态跳变**才推：换歌、歌词解析完、播放/暂停切换、拖动进度（去抖后）、开关窗口。
   * 这些事件每秒最多几次，事件通道扛得住。
   *
   * ⚠️ **绝不在 `setProgress` 里推** —— 它由 `<audio>.timeupdate` 驱动，**每秒数次**。
   * 那个频率下每条都要跨进程序列化 + emit，事件通道会被打爆，
   * 表现出来是「主窗操作发涩、歌词窗反而卡」。歌词窗也不需要这么高频率：
   * 它收到一次 payload 后按 `startedAtMs` + 本地单调钟自己往前走（见 DesktopLyrics
   * 的「进度推进」段）。**加这条推送前先想清楚这一点，别顺手补上。**
   *
   * 同理，`seek`（拖动进度）走的是**去抖后**推一次，不逐次推 —— 理由同上，
   * 详见 `seek` 实现处的注释。
   *
   * 无当前歌曲时**照样推**（`songId: null`）：不推的话歌词窗会一直显示上一首，
   * 变成「主窗已停、桌面还挂着别人的歌词」。
   */
  pushLyricsState: () => Promise<void>;
  /**
   * 只把桌面歌词的**偏好**推给歌词窗（不带歌词行、不带进度）。
   *
   * 为什么单独一条而不是复用 `pushLyricsState`：用户拖字号滑杆 / 连点色点会在
   * 一次操作里触发几十次 setter，每次发完整载荷就要把整首歌词行重新序列化一遍 ——
   * 那是把事件通道打爆的另一种写法（`setProgress` 注释里警告的是同一个坑）。
   * 偏好推送只带 4 个字段，代价恒定。
   *
   * 这条**不算**"污染进度通道"：它不推进度、频率由用户手势决定（秒级），
   * 与 `timeupdate` 每秒数次的连续量不是一回事。
   */
  pushLyricsPrefs: () => Promise<void>;

  // UI
  setExpanded: (open: boolean) => void;
  /** 收起动画进行中：展开播放器据此加 `.is-closing` 播退场动画 */
  expandedClosing: boolean;
  /**
   * 收起展开播放器（**带动画**）。
   *
   * 所有收起入口都走这里 —— 若各处直接 `setExpanded(false)`，动画会被跳过，
   * 于是"点按钮收得起劲、按 Esc 唰地消失"这种不一致就会冒出来。
   *
   * 延时长度必须与 app.css `.music-exp.is-closing` 的动画时长一致（0.3s）；
   * 改一处必须改另一处（断言 `ANIM.durationSync` 盯着这两个数）。
   */
  closeExpanded: () => void;
  setSkin: (s: PlayerSkin) => void;
  toast: (message: string, type?: 'warning' | 'success') => void;
  clearToast: () => void;
}

// ------------------------------------------------------------------ 内部辅助

/**
 * 一首歌在**音频缓存**里的稳定主键（逐平台）。
 *
 * ⚠️ 必须与 `platform.songUrl` / `platform.lyric` 取 id 的口径对齐，
 * 否则会出现「按A 的 key 存了 B 的歌」这种错位 —— 症状是**别的歌的音频**，
 * 且全程不报错。
 *
 * ## 为什么用 `||` 而不是 `??`
 *
 * `kugou.rs` 会把空 hash 序列化成 `Some("")`（不是 `None`），
 * 而 `??` 只对 `null` / `undefined` 回落 ⇒ 空串会原样传下去。
 * 于是所有空 hash 的酷狗歌会共用同一个 key，表现为「A 歌的音频出现在 B 歌上」。
 * `||` 对空串也回落，比 `??` 严格更安全。QQ 的 `mid` 同理。
 */
function audioCacheId(provider: MusicProvider, song: Song): string {
  switch (provider) {
    case 'kugou':
      return song.hash || song.id;
    case 'qqmusic':
      return song.mid || song.id;
    // 咪咕的 `Song.id` 存的是 copyrightId（主键）；`content_id` 只是
    // `listen_url` 的另一个必填查询参数，**别把它当主键**。
    default:
      return song.id;
  }
}

/**
 * 查整首音频缓存，命中返回**可直接播放的 asset URL**，未命中返回 `null`。
 *
 * ## ⚠️ 为什么不直接把结果交给上层而不在这里转 `convertFileSrc`
 *
 * 命中返回的是**绝对路径**，而 `<audio>` 在 Tauri 下不能直接吃 `file://`
 * （被跨源策略挡），必须经 `convertFileSrc` 转 `asset://` ——
 * 与本地歌曲（`resolvePlayUrl` 对 `song._localPath` 的处理）完全同一条路。
 * 转换放在这里，是为了让本函数的契约是「返回能播的 URL」而不是「返回路径」，
 * 调用方不必知道缓存命中拿到的是什么东西。
 *
 * ## 为什么吞掉异常
 *
 * 缓存是**优化**。查缓存失败（命令未注册 / 缓存目录不可读）时，
 * 正确反应是「当它不存在」—— 走原来的代理路径在线播。
 * 一旦让异常冒泡，`playSong` 会把它当成"解析播放地址失败"，
 * 弹「播放失败」并**自动跳下一首** —— 症状是"缓存坏了就放不出歌"，
 * 而缓存本该是可有可无的。
 */
async function lookupAudioCache(
  song: Song,
  provider: MusicProvider,
  quality: string,
): Promise<string | null> {
  /**
   * 本地歌曲**不入缓存链**。
   *
   * 两个理由：① 它走 `asset://` 直接播，文件本就在本地，再问一遍缓存是多余的系统调用；
   * ② 它是用户自己导入的文件，计入「音乐缓存」统计会让设置页的占用数字失真
   * （用户会看到"缓存占了 1.2GB"，其实全是自己的歌）。
   *
   * 这道闸放在**缓存链的入口**而不是调用点：将来多一个调用方也不会漏掉。
   */
  if (song._localPath) return null;
  try {
    const hit = await ipc.musicAudioCached(provider, audioCacheId(provider, song), quality);
    return hit ? convertFileSrc(hit) : null;
  } catch {
    // 见上方注释：查不到就当没缓存，绝不影响播放
    return null;
  }
}

/**
 * 后台整首下载落盘。**绝不阻塞播放，也绝不打断播放。**
 *
 * 调用点必须放在「播放地址已经拿到」之后（它需要源站真实 URL），
 * 且以 `void` 发出、不 `await`。
 *
 * ## 为什么失败可以完全静默
 *
 * 下载失败对用户而言**与「没缓存」完全等价** —— 歌已经在放了，缓存只是让它下次更快。
 * 所以这里既不弹提示也不重试：任何"下载缓存失败"的打扰都是净损失。
 * 静默放弃的是**这一次**缓存机会，不是播放。
 */
function prefetchAudioCache(
  song: Song,
  provider: MusicProvider,
  quality: string,
  url: string,
): void {
  if (song._localPath) return;
  // `void` 明确表达"发出即弃"，`.catch` 保证拒绝不会变成未处理的 Promise
  void ipc.musicCacheDownload(provider, audioCacheId(provider, song), quality, url).catch(() => {});
}

/** 按平台解析在线播放地址（本地音频缓存 → song_url → 音频代理） */
async function resolveOnlineUrl(song: Song): Promise<string> {
  const state = useMusicStore.getState();
  const provider = song.provider as MusicProvider;
  /**
   * ⚠️ 缓存 key 里的 quality **只能是这个值**（5 值枚举的请求档位），
   * 绝不能是 `r.quality` / `r.level` —— 四平台那两个字段值域互不相同
   * （网易云是中文 label、QQ 是英文 label、咪咕是 `PQ`/`SQ`/`ZQ`），
   * 拿它们当 key 会让同一首歌每次 key 都不同 ⇒ **缓存永不命中且不报错**。
   *
   * 它也天然**非空**（`PlaybackQuality` 是不含空串的联合类型，
   * 水合处有 `?? 'hires'` 兜底）。Rust 侧对空档位判为"无法寻址"直接不下缓存，
   * 那里也**刻意没有**默认成 `standard` —— 宁可无缓存，也不能让用户
   * 以为听到了自己选的高音质。
   */
  const quality = state.playbackQuality;

  // 先查缓存：命中就直接播本地文件，**不再回源**（省掉一次取流地址的网络往返）
  const cached = await lookupAudioCache(song, provider, quality);
  if (cached) {
    /**
     * 命中时拿不到"实际码率"（没调 `songUrl`），所以 `currentBitrate` 置 0 ——
     * UI 侧只在 `> 0` 时显示码率（`PlayerBar`），置 0 等于"不谎报"。
     * ⚠️ 不能留着上一首的值：那样播放条会显示**上一首**的码率。
     * `currentQuality` 填请求档位是诚实的 —— 这个文件本就是按该档位的 key 存的
     *（源站当时是否降级无从得知，不谎报具体码率）。
     */
    useMusicStore.setState({ currentQuality: quality, currentBitrate: 0 });
    return cached;
  }

  const r = await platform.songUrl(provider, song, quality);
  if (!r?.url) return '';
  let port = state.proxyPort;
  if (!port) {
    port = await ipc.getProxyPort();
    useMusicStore.setState({ proxyPort: port });
  }
  // 回写「实际拿到的音质与码率」。
  // 这两个字段在 store 里定义了却**一直没有被赋值**（播放条上那个音质标签因此从来不显示）
  // —— 档位是**要的**、这两个是**真拿到的**，平台降级时两者不一致；
  // 只显示档位等于把降级藏了起来。
  // `br` 单位是 bps（网易云/QQ 原样透传；咪咕恒为 0），故 UI 侧只在 >0 时显示。
  useMusicStore.setState({
    currentQuality: r.quality || r.level || '',
    currentBitrate: r.br || 0,
  });
  // 播放地址已就绪 → 这时才后台预热。`void` 不阻塞，且失败不打断播放。
  prefetchAudioCache(song, provider, quality, r.url);
  return `http://127.0.0.1:${port}/audio?url=${encodeURIComponent(r.url)}`;
}

/** 统一解析一首歌的可播放 URL（本地 asset 协议 / 在线音频代理） */
async function resolvePlayUrl(song: Song): Promise<string> {
  if (song._localPath) return convertFileSrc(song._localPath);
  return resolveOnlineUrl(song);
}

// ------------------------------------------------------------------ store

/**
 * 播放内核登记进来的 <audio> 元素。
 *
 * **刻意不放进 zustand state**：它是 DOM 引用、不是可渲染数据，放进 state 只会让
 * 每次登记都惊动所有订阅者。它唯一的作用是让 `seek` 能在**同一处**同时改
 * 「store.progressMs」与「audio.currentTime」—— 这两件事分开做必然被漏掉一件。
 *
 * 为什么需要这条通道：`<audio>` 住在组件里（`components/MusicKernel.tsx`，挂应用根常驻），
 * 而 seek 是 store action。没有它，就得把 audio 的 ref 一路当 prop 传进每个进度条。
 */
let audioEl: HTMLAudioElement | null = null;

/** 播放内核在挂载 / 卸载时登记与注销 audio 元素 */
export function registerAudioElement(el: HTMLAudioElement | null): void {
  audioEl = el;
}

/**
 * 拖动进度条后、真正推给歌词窗之前的去抖定时器。
 *
 * 为什么需要：展开播放器的进度条 `onChange` 直连 `seek`，拖动时每秒几十次；
 * 不去抖就等于把 `setProgress` 那种频率从另一个入口灌进事件通道。
 * 120ms 是"手还在动就别推、停下来就推一次"的取舍 —— 短到察觉不出延迟，
 * 长到足以把一次拖动的几十次调用压成一次。
 */
const SEEK_PUSH_DEBOUNCE_MS = 120;
let seekPushTimer: ReturnType<typeof setTimeout> | null = null;

export const useMusicStore = create<MusicState>()((set, get) => ({
  // ---- 播放 ----
  currentSong: null,
  queue: [],
  currentIndex: 0,
  isPlaying: false,
  progressMs: 0,
  durationMs: 0,
  volume: 0.8,
  muted: false,
  playMode: 'list',
  playUrl: '',
  playbackQuality: 'hires',
  currentQuality: '',
  currentBitrate: 0,
  proxyPort: 0,
  playHistoryList: [],
  resumeAtMs: 0,
  // 启动恢复：默认都不在恢复态
  restoring: false,
  restoreAttempted: false,

  // ---- 播放/媒体的持久化偏好 ----
  lyricsFontSize: LYRICS_SIZE.def,
  lyricsHighlightColor: LYRICS_COLOR_DEF,
  lyricsMode: LYRICS_MODE_DEF,
  desktopLyricsFontSize: DL_LYRICS_SIZE.def,
  desktopLyricsHighlightColor: DL_HIGHLIGHT_COLOR_DEF,
  desktopLyricsBaseColor: DL_BASE_COLOR_DEF,
  desktopLyricsLineCount: DL_LINE_COUNT.def,
  dynamicEnabled: false,
  discMode: false,
  vinylColorMode: 'auto',
  vinylCustomColor: VINYL_COLOR_DEF,
  islandView: 'play',

  // ---- 本地 ----
  localSongs: [],
  localQueue: [],
  importingLocal: false,

  // ---- 平台 ----
  playbackSource: 'netease',
  searchProvider: 'netease',
  loginInfo: null,
  loginInfos: { netease: null, kugou: null, qqmusic: null, migu: null },

  // ---- 搜索 ----
  searchText: '',
  searchTab: 'song',
  searchResults: [],
  searchHasMore: false,
  loadingMoreSearch: false,
  playlistSearchResults: [],
  artistSearchResults: [],
  searching: false,
  searchError: '',

  // ---- 左栏 ----
  leftView: 'playlists',
  userPlaylists: [],
  loadingUserPlaylists: false,
  userPlaylistsError: '',
  leftPlaylistMeta: null,
  leftPlaylistTracks: [],
  loadingLeftTracks: false,
  loadingMoreLeft: false,

  // ---- 右栏 ----
  rightView: 'recommendations',
  officialCharts: [],
  loadingCharts: false,
  recommendPlaylists: [],
  loadingRecommend: false,
  dailySongs: [],
  loadingDaily: false,
  rightPlaylistMeta: null,
  rightPlaylistTracks: [],
  loadingRightTracks: false,
  loadingMoreRight: false,

  // ---- 红心 ----
  likedSongIds: new Set<string>(),
  likedByProvider: { netease: new Set(), kugou: new Set(), qqmusic: new Set(), migu: new Set() },

  // ---- 歌词 / 评论 ----
  parsedLyrics: [],
  comments: null,
  loadingComments: false,
  commentTab: 'lyric',

  // ---- 桌面歌词 ----
  // 冷启动时窗口一定不存在（窗口不跨进程重启保留），所以初值 false 是事实而非猜测
  lyricsWindowOpen: false,

  // ---- UI ----
  queueOpen: false,
  expanded: false,
  expandedClosing: false,
  skin: 'modern',
  loginOpen: false,
  loginProvider: 'netease',
  qrUrl: '',
  qrStatus: '',
  qrLoading: false,
  musicToast: null,

  // ================================================================ 切片（D-156）
  // 每段 action 自成一文件，共享件在 music/{persist,convert,slice}.ts。
  // 未切的段仍在本文件（见下）。
  ...createLocalSlice(set, get),
  ...createPlayHistorySlice(set, get),
  ...createLeftSlice(set, get),
  ...createRightSlice(set, get),
  ...createSearchSlice(set, get),
  ...createLikeSlice(set, get),
  ...createLyricsSlice(set, get),
  ...createInitSlice(set, get),
  ...createQueueSlice(set, get),
  ...createPlatformSlice(set, get),
  ...createDesktopSlice(set, get),
  ...createUiSlice(set, get),

  // ================================================================ 播放

  playSong: async (song, queue, opts) => {
    const mySeq = ++playSeq;

    // 队列与位置
    if (queue) {
      const idx = queue.findIndex((s) => songKey(s) === songKey(song));
      set({ queue, currentIndex: idx >= 0 ? idx : 0 });
    } else {
      /**
       * 没给队列 → 在**现有队列**里移动指针。
       *
       * ⚠️ 找不到时**不能什么都不做**（这里曾是一个真实缺陷）：
       * 从「播放历史」点一首不在当前队列里的歌，`findIndex` 返回 -1，
       * 于是队列与 currentIndex 都不动 —— 结果 `currentSong` 是这首歌、
       * 而 `queue[currentIndex]` 指向**另一首**：点「下一首」从错误位置往后走，
       * 队列抽屉高亮的也不是正在播的那首。**自相矛盾的状态，且不报错。**
       * 对齐网易云的做法：把这首歌**接进队列**。
       */
      const idx = get().queue.findIndex((s) => songKey(s) === songKey(song));
      if (idx >= 0) {
        set({ currentIndex: idx });
      } else {
        // 队列满（2000 首，极少见）时退化成"以这首歌开一个新队列"，
        // 而不是静默丢弃 —— 用户点了播放却什么都没发生是最难解释的行为。
        const cur = get().queue;
        const next = cur.length >= MAX_PLAY_QUEUE ? [song] : [...cur, song];
        set({ queue: next, currentIndex: next.length - 1 });
      }
    }

    if (!isAutoSkipping) unplayableSkipCount = 0;

    // 恢复态：进度**先显示**到快照里的位置。
    // 为什么 display 值要先给：真实 seek 要等 loadedmetadata（见 MusicKernel），
    // 两者之间有几百毫秒到几秒；这段时间播放条若停在 0:00，定位完成后会"跳一下"，
    // 看起来就像 bug（评估稿 §1.4 记的正是这个）。先给目标值，跳动就发生在
    // 同一个组件的同一次渲染里，肉眼几乎看不出。
    const startAt = Math.max(0, opts?.resumeAtMs ?? 0);
    set({
      currentSong: song,
      progressMs: startAt,
      durationMs: song.duration || 0,
      isPlaying: false,
      // 「详情」= 展开播放器（《09》§5.6 第 3 项）。用户主动点一首歌就展开它；
      // **自动续播/切歌不展开**（否则听歌时会被不断弹开）—— 由 next/prev 传 expand:false 表达。
      // 默认展开，因为调用点绝大多数是"用户点了某一首"。
      ...(opts?.expand === false ? {} : { expanded: true }),
    });
    // 把 seek 意图交给播放内核：它在 loadedmetadata 之后才真正设 currentTime。
    // 必须在换歌前清掉旧的 resumeAtMs，否则上一首残留的位置会作用到这一首。
    if (startAt > 0) set({ resumeAtMs: startAt });
    else if (get().resumeAtMs !== 0) set({ resumeAtMs: 0 });
    // 歌词与 URL 获取并行（不阻塞播放）
    void get().loadLyrics(song);
    // 换歌即刻推一次（此刻歌词多半还没到，歌词窗会先显示歌名/纯音乐提示，
    // 歌词解析完后再由 loadLyrics 补推一次）。不推的话换歌后桌面会停留在上一首。
    void get().pushLyricsState();

    let url = '';
    try {
      url = await resolvePlayUrl(song);
    } catch (e) {
      if (mySeq !== playSeq) return;
      // ⚠️ 这里的 `restoring: false` 不是顺手写的：解析抛错是**唯一一条
      // playUrl 永远不会被设置**的失败路径 ⇒ 不会有 loadedmetadata 来关恢复态的闸。
      // 闸漏在这里的后果：用户之后正常播放遇到一次网络失败，也会静默遍历整个队列
      // 并清空播放条（一次抖动把队列丢光）。
      set({ isPlaying: false, restoring: false });
      get().toast(`播放失败：${String(e)}`);
      return;
    }
    if (mySeq !== playSeq) return;

    if (!url) {
      // 无版权 / 需会员：提示后自动跳下一首
      //
      // ⚠️ **两条路的跳数上限不同，这是刻意的**：
      //   · 平时（用户自己点的歌）：上限 10 首。整队列全不可播时停下来，
      //     免得一路跳下去让界面疯转 —— 平时用户在场，看得见发生了什么。
      //   · 恢复态（Q4 拍板）：上限 = 队列长度，**遍历到有一首能播的为止**。
      //     恢复时用户什么都还没做，队列里混着被移走的本地文件 / 已下架的专辑
      //     是常态；停在"全都不行"等于恢复失败（播放条空着、用户一脸茫然）。
      //     全部失败才落到 clearQueue（见 handleRestoreFailed）。
      const restoring = get().restoring;
      const skipLimit = restoring ? Math.max(1, get().queue.length) : 10;
      set({ isPlaying: false });
      if (unplayableSkipCount < skipLimit) {
        unplayableSkipCount += 1;
        isAutoSkipping = true;
        // 恢复态**不弹提示**：用户还没做任何操作，一串"该歌曲无版权"是纯噪音
        if (!restoring) get().toast('该歌曲无版权或需会员，已自动跳过');
        setTimeout(() => {
          if (get().queue.length > 1) {
            get().next();
          } else if (get().restoring) {
            /**
             * 队列只有一首歌，而它恰好也失败 —— 没有"下一首"可跳，恢复到此为止。
             * 不清的话 `restoring` 会一直开着（下面那个 else 分支只在"跳够次数"时才到），
             * 于是用户之后正常播放遇到一次失败也会遍历整个队列并清空。
             * 在回调里**重新读** restoring 而不是用闭包里那份：800ms 里用户可能
             * 已经点了别的歌（那时不该由这一条定时器去清他的队列）。
             */
            get().clearQueue();
            set({ restoring: false });
          }
        }, 800);
      } else {
        isAutoSkipping = false;
        unplayableSkipCount = 0;
        // 恢复态走到这里 = 整个队列都试过了（Q4）→ 清空，播放条随之隐藏
        if (restoring) {
          get().clearQueue();
          return;
        }
        get().toast('当前队列中多首歌曲无法播放，已停止自动切换');
      }
      return;
    }

    isAutoSkipping = false;
    // autoplay:false（恢复）→ 停在暂停态，但**地址照样挂上**：
    // 播放条要显示歌曲信息、进度条要显示定位后的位置，而音频元素必须真的
    // 加载到那首歌（否则 onError 永远不会触发，Q4 的"失败切下一首"无从判断）。
    set({ playUrl: url, isPlaying: opts?.autoplay !== false });
    // 「取到地址、真正开始播」是第二次状态跳变（上面那次推的时候还没在播）。
    // 不推的话桌面歌词会停在那首歌的暂停态，直到用户手动暂停/播放一次才恢复。
    void get().pushLyricsState();
    get().recordPlayHistory(song, opts?.fromHistory);
    // 切歌后立刻存快照：此刻进度是 0，但「换了哪首、队列长什么样」必须立刻落盘
    get().persistSnapshot();
  },

  playQueue: async (songs, startIndex, opts) => {
    const song = songs[startIndex];
    if (!song) return;
    await get().playSong(song, songs, opts);
  },

  // 播放/暂停切换必须推：歌词窗收到 playing=false 才会真的停住走表，
  // 否则暂停期间歌词会继续往前爬（这是最容易被当成"歌词乱跳"的故障）。
  togglePlay: () => {
    set((s) => ({ isPlaying: !s.isPlaying }));
    void get().pushLyricsState();
    // **暂停时**存快照 —— 这是"听完暂停、第二天再打开"这个主场景的落盘点。
    // （继续播放时不存：进度每秒都在变，交给 MusicKernel 的低频定时器。）
    if (!get().isPlaying) get().persistSnapshot();
  },

  next: () => {
    const { queue, currentIndex, playMode } = get();
    if (queue.length === 0) return;

    // 心动模式：播完当前这首后，按它找相似歌曲续播，**并把相似结果替换成新队列**。
    // 为什么替换而不是追加：心动模式是"顺着当前这首歌往下听"，队列会越滚越杂；
    // 而每次替换都让队列变成"这一串都是相似歌"，语义与体验都更稳。
    // 降级：非网易云无"按 songid 找相似"接口 → 退化为随机（与 shuffle 同语义），
    // **不拿同歌手/同歌单冒充相似**。切换该档时已提示过用户，这里不再重复弹提示。
    if (playMode === 'heartbeat' && platform.supportsSimilar(get().playbackSource)) {
      const cur = queue[currentIndex];
      if (!cur) {
        get().toast('心动模式需要先有一首歌在播');
        return;
      }
      void (async () => {
        try {
          const similar = await platform.similarSongs(get().playbackSource, cur.id, 20);
          // 排除当前这首与空结果：接口可能把它自己也算进"相似"里
          const pick = similar.filter((s) => songKey(s) !== songKey(cur));
          if (pick.length === 0) {
            get().toast('没有找到相似歌曲，已切回队列下一首');
            get().fallbackNext();
            return;
          }
          const nextSong = pick[0];
          // 用相似列表当新队列，并跳到第一首；expand:false —— 自动续播不该弹开播放器
          await get().playSong(nextSong, pick, { expand: false });
        } catch (e) {
          get().toast(`找相似歌曲失败：${String(e)}`);
          get().fallbackNext();
        }
      })();
      return;
    }

    let idx = currentIndex;
    if (playMode === 'shuffle' || playMode === 'heartbeat') {
      // heartbeat 走到这里 = 平台不支持相似（已提示过），按随机处理
      idx = queue.length === 1 ? 0 : Math.floor(Math.random() * queue.length);
    } else {
      idx = (currentIndex + 1) % queue.length;
    }
    // expand:false —— 自动切歌不该把播放器弹开（含 onEnded 自动续播与无版权自动跳过）
    void get().playSong(queue[idx], undefined, { expand: false });
  },

  /**
   * 一首**自然播完**时的分流。
   *
   * ## 为什么必须在这里分流，而不是让 `onEnded` 直接调 `next()`
   *
   * 「单曲循环」的语义是：**自动播完重播当前曲**，但**手动点「下一首」要换歌**。
   * `next()` 同时服务这两条路，没法在里面区分 —— 所以此前 `one` 档
   * 落进了 `next()` 的"顺序下一首"分支，**单曲循环实际是坏的**（播完就切歌）。
   *
   * ## 为什么是"定位回 0"而不是重新 `playSong`
   * 重新播要走完整的取 URL 流程（网络歌要重新解析、可能还要等代理），
   * 单曲循环会因此每轮卡一下。直接 `currentTime = 0` 是即时的。
   */
  handleTrackEnded: () => {
    const { playMode } = get();
    if (playMode === 'one') {
      set({ progressMs: 0, isPlaying: true });
      const a = audioEl;
      if (a) {
        a.currentTime = 0;
        void a.play().catch(() => undefined);
      }
      // 歌词窗自己按 startedAtMs 走表，重播必须补推一次，否则它会继续按上一轮的基准往前跑
      void get().pushLyricsState();
      return;
    }
    get().next();
  },

  /**
   * 按现有队列顺序取下一首 —— 供"心动模式拿不到相似歌曲"时降级调用。
   * 单独成 action 而不是给 next 加参数：调用点（相似接口失败）需要明确表达
   * "我不是要随机，我要队列的下一首"，让降级路径在代码里一眼可辨。
   */
  fallbackNext: () => {
    const { queue, currentIndex } = get();
    if (queue.length === 0) return;
    const idx = (currentIndex + 1) % queue.length;
    void get().playSong(queue[idx], undefined, { expand: false });
  },

  prev: () => {
    const { queue, currentIndex, playMode } = get();
    if (queue.length === 0) return;
    const idx =
      playMode === 'shuffle'
        ? queue.length === 1
          ? 0
          : Math.floor(Math.random() * queue.length)
        : (currentIndex - 1 + queue.length) % queue.length;
    void get().playSong(queue[idx], undefined, { expand: false });
  },

  seek: (ms) => {
    set({ progressMs: ms });
    // 必须**同时**挪 audio.currentTime：只改 store 是进度条动、声音不动；
    // 只改 currentTime 则进度条与音频不同步。两件事放在同一处做，才不会被人只做一半。
    const a = audioEl;
    if (a) a.currentTime = ms / 1000;
    // 拖动进度是**不连续跳变**：歌词窗靠自己走表，拖过之后它的基准就错了
    // （会一直按旧位置往下算），所以必须重推一次对齐。
    //
    // ⚠️ 但这里**必须去抖**，不能一调就推：展开播放器的进度条是
    // `onChange` 直连 seek（`ExpandedPlayer.tsx`），拖动过程中每秒能触发几十次 ——
    // 那就是「setProgress 那种频率」换个入口又灌进来一遍，把事件通道打爆。
    // 去抖后一次拖动只推一次（停手 120ms 后），既对齐了位置又压住了频率。
    // 播放条那条路径本身有拖拽会话（松手才提交），经过这里也只剩一次。
    if (seekPushTimer) clearTimeout(seekPushTimer);
    seekPushTimer = setTimeout(() => {
      seekPushTimer = null;
      void get().pushLyricsState();
    }, SEEK_PUSH_DEBOUNCE_MS);
  },

  setVolume: (v) => {
    // 调音量即「想听见」：若正静音则顺带解除，否则拖/滚了半天毫无反馈
    set(v > 0 ? { volume: v, muted: false } : { volume: v });
    savePrefs({ volume: v });
  },

  toggleMute: () => set((s) => ({ muted: !s.muted })),

  stepVolume: (delta) => {
    const v = Math.min(1, Math.max(0, get().volume + delta));
    get().setVolume(v);
  },

  closePlayback: () => {
    // 只停这一首，队列原样留着（下一首还能接着播）
    set({
      currentSong: null,
      playUrl: '',
      isPlaying: false,
      progressMs: 0,
      durationMs: 0,
      currentQuality: '',
      currentBitrate: 0,
    });
    // 必须推一次空状态：否则桌面歌词会一直挂着刚停掉那首的歌词
    void get().pushLyricsState();
  },

  cycleMode: () => {
    // 四档循环：列表 → 随机 → 单曲 → 心动 → 列表
    // ⚠️ 心动模式（heartbeat）的语义是"按当前歌曲找相似续播"，**仅网易云可得**。
    // 其余平台会降级为随机（见 next 的 heartbeat 分支），所以切换到心动档时
    // 必须提示用户，否则他会以为在听"相似歌曲"、实际听的是随机 —— 这与假控件同级的问题。
    const order: PlayMode[] = ['list', 'shuffle', 'one', 'heartbeat'];
    const nextMode = order[(order.indexOf(get().playMode) + 1) % order.length];
    set({ playMode: nextMode });
    savePrefs({ playMode: nextMode });
    if (nextMode === 'heartbeat' && !platform.supportsSimilar(get().playbackSource)) {
      get().toast(
        `${platform.providerLabel(get().playbackSource)} 没有"按歌曲找相似"的能力，已降级为随机播放`,
      );
    }
  },

  setPlaybackQuality: async (q) => {
    set({ playbackQuality: q });
    savePrefs({ playbackQuality: q });

    // 正在播放时换档必须重取地址，否则「换了音质」要等下一首才生效。
    // 重取会让 <audio> 从 0 起播，所以把当前进度交给播放内核去续播（resumeAtMs）。
    const { currentSong, playUrl, progressMs } = get();
    if (!currentSong || !playUrl) return;
    try {
      const url = await resolvePlayUrl(currentSong);
      if (!url) return;
      // 期间又切歌了 → 放弃本次换档，避免把旧歌的地址盖到新歌上
      if (get().currentSong !== currentSong) return;
      set({ playUrl: url, resumeAtMs: progressMs, isPlaying: true });
      // 换档后音频从 resumeAtMs 续播，播放位置对歌词窗来说是一次跳变 —— 重推对齐
      void get().pushLyricsState();
    } catch {
      get().toast('切换音质失败，已保持原音质');
    }
  },

  clearResumeAt: () => set({ resumeAtMs: 0 }),

  setLyricsFontSize: (px) => {
    set({ lyricsFontSize: px });
    savePrefs({ lyricsFontSize: px });
  },

  setLyricsHighlightColor: (color) => {
    set({ lyricsHighlightColor: color });
    savePrefs({ lyricsHighlightColor: color });
  },

  setLyricsMode: (mode) => {
    set({ lyricsMode: mode });
    savePrefs({ lyricsMode: mode });
  },

  /*
   * 下面四个 setter 的形态一致：改内存 → 写偏好 → **推给歌词窗**。
   *
   * 第三条是「实时预览」的全部实现：偏好只写 localStorage 是不够的 ——
   * 两个 WebView 之间 `storage` 事件不保证触发（见 ipc.ts 的注释），
   * 所以必须显式走事件通道。用 pushLyricsPrefs（轻量）而不是 pushLyricsState，
   * 理由见 `pushLyricsPrefs` 的注释（拖滑杆会连发几十次）。
   *
   * 窗口没开时 Rust 侧静默成功，所以不必先判断开没开。
   */
  setDesktopLyricsFontSize: (px) => {
    set({ desktopLyricsFontSize: px });
    savePrefs({ desktopLyricsFontSize: px });
    void get().pushLyricsPrefs();
  },

  setDesktopLyricsHighlightColor: (color) => {
    set({ desktopLyricsHighlightColor: color });
    savePrefs({ desktopLyricsHighlightColor: color });
    void get().pushLyricsPrefs();
  },

  setDesktopLyricsBaseColor: (color) => {
    set({ desktopLyricsBaseColor: color });
    savePrefs({ desktopLyricsBaseColor: color });
    void get().pushLyricsPrefs();
  },

  setDesktopLyricsLineCount: (n) => {
    set({ desktopLyricsLineCount: n });
    savePrefs({ desktopLyricsLineCount: n });
    void get().pushLyricsPrefs();
  },

  resetDesktopLyricsPrefs: () => {
    // 四项作为一个 patch 一次写完：分四次 set+savePrefs+push 会连推四遍，
    // 而"恢复默认"在用户眼里是一次操作，一次推完即可。
    const patch = {
      desktopLyricsFontSize: DL_LYRICS_SIZE.def,
      desktopLyricsHighlightColor: DL_HIGHLIGHT_COLOR_DEF,
      desktopLyricsBaseColor: DL_BASE_COLOR_DEF,
      desktopLyricsLineCount: DL_LINE_COUNT.def,
    };
    set(patch);
    savePrefs(patch);
    void get().pushLyricsPrefs();
  },

  setDynamicEnabled: (on) => {
    set({ dynamicEnabled: on });
    savePrefs({ dynamicEnabled: on });
  },

  setDiscMode: (on) => {
    set({ discMode: on });
    savePrefs({ discMode: on });
  },

  setVinylColorMode: (mode) => {
    set({ vinylColorMode: mode });
    savePrefs({ vinylColorMode: mode });
  },

  setVinylCustomColor: (color) => {
    set({ vinylCustomColor: color });
    savePrefs({ vinylCustomColor: color });
  },

  setIslandView: (v) => {
    // 与其它偏好 setter 同形：改内存 → 写偏好。少了 savePrefs 这一步，
    // 用户切到歌词卡后重开应用会回到播放卡（"切了没记住"）。
    set({ islandView: v });
    savePrefs({ islandView: v });
  },

  /**
   * 逐帧推进播放进度（由 `<audio>.timeupdate` 驱动，**每秒数次**）。
   *
   * ⚠️⚠️ **这里绝对不要加 `pushLyricsState()`** —— 请先读下面这段再改：
   *
   * 桌面歌词窗收到一次 payload 后，会按 `startedAtMs` + 自己的单调钟**继续往前走**，
   * 所以它不需要主窗逐帧喂进度。真正的风险在另一头：`timeupdate` 是每秒数次的事件，
   * 在这里推意味着每秒数次跨进程序列化 + emit，事件通道会被打满，症状是
   * **主窗整体操作发涩、歌词窗反而卡顿**（一个为省事加的推送，同时毁掉两个窗口）。
   *
   * 「用户拖了进度条怎么办」不构成在这里推的理由 —— 拖动是**不连续跳变**，
   * 已经在 `seek` 里推了一次（那里才是它该待的地方）。
   * 需要桌面歌词跟着走的"状态跳变"清单，见 `pushLyricsState` 的注释。
   */
  setProgress: (ms) => set({ progressMs: ms }),
  setDuration: (ms) => set({ durationMs: ms }),

}));
