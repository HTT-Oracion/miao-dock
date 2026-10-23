/**
 * 音乐模块状态层（zustand）—— 播放 + 四平台 + 本地 + 发现，全模块唯一状态源。
 *
 * 从参考实现（Zustand store，3559 行）移植**逻辑**、剥离 Chakra UI 绑定（PD-1「界面重写」）。
 * 本文件只持状态与副作用，不渲染任何 UI；UI 在 screens/MusicScreen.tsx 与其子组件。
 *
 * ## 分层判据（`modules/music/` 与 `screens/music/` 同名是事实，不是歧义）
 * · `src/modules/music/` 住**域逻辑**：状态 / IPC / 平台适配 / 播放器选项 / 持久化，**不 import 任何屏**。
 * · `src/screens/music/` 住**屏内件**：只服务音乐屏的 UI 组件。
 * 两层靠依赖方向区分（域不知道屏，屏可以引域），不靠目录名区分；`@music` 永远指本目录。
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
 * 实测记录：lsm-probe（工作区内，2026-10-04）；台账见 docs/internal/spec-notes.md D-47。
 */
import { create } from 'zustand';
import type { ParsedLyricLine } from '@tools/lyrics';
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
import { createPlaybackSlice } from './actions/playback';
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
  /**
   * 当前队列是否来自「我喜欢的音乐」。
   *
   * 为什么需要它：心动模式**只在这个歌单的上下文里**有效（见 PlayMode 注释）。
   * 它随队列一起被写：播「我喜欢的音乐」置真，播其它歌单/搜索结果/本地/历史置假。
   * 不做成"看 queue 内容去猜"—— 队列里是一堆 Song，猜不出它从哪来。
   */
  queueFromLiked: boolean;
  /**
   * 当前这轮队列上下文里**是否进过心动模式**。
   *
   * 用途：区分「首次进入心动模式」与「离开后又切回来」——
   * 前者要替换整个队列并从头播放第一首，后者要**保留当前歌曲**、只替换其余部分
   * 并继续播放当前歌曲（需求原文的两种情形）。
   *
   * 🔴 为什么不能直接用"队列是不是心动生成的"来判断：
   * 切离心动模式时队列会**恢复成原来的播放列表**（需求），那一刻队列已不是心动生成的，
   * 但"进过心动"这个事实必须留着 —— 否则切回来又走"首次进入"，把用户正在听的歌从头重播。
   * 这两个条件会分叉，所以必须是**独立**的标志。
   *
   * 生命周期：随播放源的新队列一起复位（`playQueue` 里置假），不持久化
   * —— 冷启动后队列来自快照，视为"还没进过心动"，行为与首次一致。
   */
  heartbeatSeeded: boolean;
  /**
   * 进入心动模式**之前**的队列快照 —— 用于"切离心动模式时恢复成原来的播放列表"。
   *
   * 为什么必须有它：心动模式会把队列整个换成相似歌（[当前歌, ...相似]），
   * 原歌单就此被覆盖。若不先存一份，用户切到别的模式时**拿不回**他原来的歌单 ——
   * 队列会一直停在那一串相似歌上，而且没有任何入口能回去。
   *
   * 只记"首次进入"时的那一份：从心动切走再切回来（`heartbeatSeeded` 已为真）不覆盖它，
   * 否则第二次进入会把「[当前歌, ...相似]」当成"原列表"存下来，恢复出来的还是相似歌。
   */
  heartbeatRestore: { queue: Song[]; index: number; queueFromLiked: boolean } | null;
  /**
   * 「我喜欢的音乐」是否**开启过**心动模式（持久化）。
   *
   * 用途：切换歌单时若目标是「我喜欢的音乐」—— 开启过就自动切到心动模式并开始播放；
   * 没开启过就沿用前一个歌单的播放模式。
   * 之所以要**单独**记在"我喜欢的音乐"名下、而不是复用全局 playMode：
   * 全局 playMode 会被切歌单重写（离开心动会切成顺序播放），
   * 拿它当"有没有开启过"的判据，切一次歌单就丢了。
   */
  likedHeartbeatOn: boolean;
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
  /**
   * 歌单列表两个分组（创建的歌单 / 收藏的歌单）的收起状态，**默认都展开**。
   *
   * 为什么放 store 而不是组件内 useState：分组状态要能跨 Tab 切换存活 ——
   * 用组件内状态的话，用户收起"收藏的歌单"后去「本地」转一圈再回来，分组又展开了，
   * 他收起的动作等于白做。这类"用户刚调过、不该被无关操作重置"的 UI 状态属于屏级状态，
   * 与 `leftView` / `queueOpen` 同类，故放 store。
   *
   * 不持久化：它是一次性的浏览偏好，重启后回到"都展开"这个最稳妥的默认值即可，
   * 没有必要占一个偏好键（与歌词字号那类"用户显式调过"的偏好不同）。
   */
  userPlaylists: Playlist[];
  loadingUserPlaylists: boolean;
  userPlaylistsError: string;
  leftPlaylistMeta: Playlist | null;
  leftPlaylistTracks: Song[];
  /** 左栏曲目读取失败的原因（空串 = 没失败） */
  leftTracksError: string;
  loadingLeftTracks: boolean;
  loadingMoreLeft: boolean;

  // ---- 右栏（发现）----
  rightView: RightView;
  officialCharts: Playlist[];
  loadingCharts: boolean;
  /** 榜单读取失败的原因（空串 = 没失败）：空列表 + 一句原因，比「暂无榜单」诚实 */
  chartsError: string;
  recommendPlaylists: Playlist[];
  /** 推荐三段（歌单 / 每日推荐 / 今日精选）全部读失败时的原因（空串 = 没失败） */
  recommendError: string;
  loadingRecommend: boolean;
  dailySongs: Song[];
  loadingDaily: boolean;
  /** 首页「今日精选」：平台级推荐新歌（匿名可取，目前仅网易云） */
  newSongs: Song[];
  loadingNewSongs: boolean;
  rightPlaylistMeta: Playlist | null;
  rightPlaylistTracks: Song[];
  loadingRightTracks: boolean;
  /** 右栏曲目读取失败的原因（空串 = 没失败） */
  rightTracksError: string;
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
  /** 评论读取失败的原因（空串 = 没失败） */
  commentsError: string;
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

  /**
   * 桌面歌词窗在本平台是否提供（2026-10-16 裁定：**只有 Windows 提供**）。
   *
   * mac 上不显示入口（播放条与展开播放器两处按钮），设置页里那项保持可交互但不产生效果。
   * 值由 `hydratePlatform()` 在**挂载前**从 Rust 取一次（平台是编译期常量，取不到按 false：
   * 藏一个入口好过留一个不符合预期的入口）。默认 false 也意味着"未取到前按钮不渲染"。
   */
  desktopLyricsSupported: boolean;

  // ---- UI ----
  queueOpen: boolean;
  expanded: boolean;
  skin: PlayerSkin;
  loginOpen: boolean;
  loginProvider: MusicProvider;
  qrUrl: string;
  qrStatus: string;
  qrLoading: boolean;
  /**
   * 轻提示（音乐模块统一出口）。设计稿的 toast 是**两行**：标题说"发生了什么"，
   * 说明补"这意味着什么"（清空队列 → `播放已关闭` / `队列已清空`）。`sub` 缺省只渲染标题行。
   */
  musicToast: { type: ToastType; message: string; sub?: string } | null;

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
  playQueue: (
    songs: Song[],
    startIndex: number,
    opts?: {
      expand?: boolean;
      /** 这次入队的来源是不是「我喜欢的音乐」——决定心动模式是否可用（见 queueFromLiked） */
      fromLiked?: boolean;
      /** 这次是"从播放历史里点播"（历史不重复置顶，见 recordPlayHistory） */
      fromHistory?: boolean;
    },
  ) => Promise<void>;
  /**
   * 播放一个**歌单 / 歌曲列表**（歌单、榜单、每日推荐、本地曲库、播放历史的统一入口）。
   *
   * 与 `playQueue` 的分工：`playQueue` 是"按下标播一首"的底层入口；
   * 本 action 承载**列表特有的联动**，三件事都只在"用户点开某个列表"时成立：
   *   ① 起始下标 —— `opts.index` 有值（用户点了具体某一首）就以它为准；
   *      没有（点"播放全部"）则按当前模式决定：列表循环/单曲循环/顺序播放从第 1 首起，
   *      随机播放随机挑一首（需求第 2 条）。
   *   ② 离开心动模式的上下文要切回顺序播放（需求第 4 条）。
   *   ③ 进入「我喜欢的音乐」时，若它开启过心动模式则自动切到心动模式并开始播放（需求第 4 条）。
   *
   * 播放历史与本地曲库同样走这里 —— 它们是**独立的播放列表**（需求第 6 条），
   * 不是"当前队列的附属"，所以一样要享受/承担上面这三条联动。
   */
  playPlaylist: (
    songs: Song[],
    opts?: {
      /** 该列表对应的歌单元信息（只有歌单才有；用来识别「我喜欢的音乐」） */
      playlist?: Playlist;
      /** 用户点的那一首的下标；不传 = "播放全部"，起始位交给模式决定 */
      index?: number;
      /** 从播放历史点播（历史列表不因这次播放而重排，见 recordPlayHistory） */
      fromHistory?: boolean;
    },
  ) => Promise<void>;
  /**
   * 进入心动模式：拿当前歌曲去换一批相似歌，重排队列。
   *
   * 两种情形（需求原文）：
   *   ① 首次进入（`heartbeatSeeded` 为假）→ 队列整个换成心动列表，**从头播放第一首**；
   *   ② 离开后又切回来（`heartbeatSeeded` 为真）→ **保留当前播放歌曲**，
   *      只把它以外的部分换成新的心动列表，**继续播放当前歌曲**（不重启、不动进度）。
   *
   * `opts.advance` 是**第三条**用途（由 `next` 在走到队尾时调用）：播完最后一首要往下走，
   * 所以换一批之后**从新的第一首开始播**。它与上面两条的区别是"要不要自己前进"——
   * 前两条都不前进（一条从头播当前歌、一条继续播当前歌），这条必须前进。
   */
  enterHeartbeat: (opts?: { advance?: boolean }) => Promise<void>;
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
  /**
   * 直接切到某个播放模式（不是"循环到下一个"）。
   *
   * 与 `cycleMode` 的分工：`cycleMode` 是按钮的"下一档"，要跳过不可用的档位；
   * 本 action 是"切到这个模式"的**唯一落点**，承载进入某档时的副作用 ——
   * 目前是"进心动模式就重排队列"与"记下我喜欢的音乐开启过心动"。
   * 把副作用放在这里而不是各调用点，是为了让"切顺序播放"这类无副作用的调用
   * 也走同一条路径，避免有人绕过它、导致心动模式的队列没被重建。
   */
  setPlayMode: (mode: PlayMode) => void;
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
  /** `silent`：内部兜底清空（播放失败 / 恢复失败 / 移除最后一项）不提示用户 */
  clearQueue: (silent?: boolean) => void;
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
  /** 收起/展开歌单分组（创建的歌单 / 收藏的歌单） */
  loadUserPlaylists: (p?: MusicProvider) => Promise<void>;
  openLeftPlaylist: (pl: Playlist) => Promise<void>;
  loadMoreLeft: () => Promise<void>;
  loadAllLeft: () => Promise<void>;
  backToPlaylists: () => void;
  /**
   * 打开一份**已经在内存里的歌单**（每日推荐这类没有 Playlist 对象的列表）。
   * 与 `openLeftPlaylist` 的区别：不去请求曲目，直接把 songs 设进详情。
   * 展示的是同一个 `PlaylistDetail`。
   */
  openTracksDetail: (meta: Playlist, songs: Song[]) => void;

  // 右栏
  setRightView: (v: RightView) => void;
  loadCharts: (p?: MusicProvider) => Promise<void>;
  /** 首屏用：三段推荐一起拉（省三次往返） */
  loadRecommend: (p?: MusicProvider) => Promise<void>;
  /**
   * 只刷**推荐歌单**一节（「换一批」按钮）。
   *
   * ⚠️ 为什么不能继续用 `loadRecommend`：它一次刷三段（推荐歌单 / 每日推荐 / 今日精选）。
   * 用户在「推荐歌单」那节点「换一批」，却连带把另外两节也刷了 ——
   * 一是白跑两次请求，二是另外两节会闪一下骨架屏，像被误触了。
   */
  loadRecommendPlaylists: (p?: MusicProvider) => Promise<void>;
  /** 只刷**每日推荐**一节 */
  loadDailySongs: (p?: MusicProvider) => Promise<void>;
  /** 只刷**今日精选**一节 */
  loadNewSongs: (p?: MusicProvider) => Promise<void>;
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
  /** 取一次桌面平台，写出 `desktopLyricsSupported`（由入口在**挂载前**调用） */
  hydratePlatform: () => Promise<void>;
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
  toast: (message: string, type?: ToastType, sub?: string) => void;
  clearToast: () => void;
}

/** 轻提示语义色：warning 警示 / success 完成 / info 中性告知（设计稿这三种都在用） */
export type ToastType = 'warning' | 'success' | 'info';

// ------------------------------------------------------------------ 内部辅助

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
  // 默认顺序播放（需求口径：五档里默认「顺序播放」，不是列表循环）
  playMode: 'order',
  queueFromLiked: false,
  heartbeatSeeded: false,
  heartbeatRestore: null,
  likedHeartbeatOn: false,
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
  leftTracksError: '',
  loadingLeftTracks: false,
  loadingMoreLeft: false,

  // ---- 右栏 ----
  rightView: 'recommendations',
  officialCharts: [],
  loadingCharts: false,
  chartsError: '',
  recommendPlaylists: [],
  recommendError: '',
  loadingRecommend: false,
  dailySongs: [],
  loadingDaily: false,
  newSongs: [],
  loadingNewSongs: false,
  rightPlaylistMeta: null,
  rightPlaylistTracks: [],
  loadingRightTracks: false,
  rightTracksError: '',
  loadingMoreRight: false,

  // ---- 红心 ----
  likedSongIds: new Set<string>(),
  likedByProvider: { netease: new Set(), kugou: new Set(), qqmusic: new Set(), migu: new Set() },

  // ---- 歌词 / 评论 ----
  parsedLyrics: [],
  comments: null,
  loadingComments: false,
  commentsError: '',
  commentTab: 'lyric',

  // ---- 桌面歌词 ----
  // 冷启动时窗口一定不存在（窗口不跨进程重启保留），所以初值 false 是事实而非猜测
  lyricsWindowOpen: false,
  // 平台能力未知前一律 false：入口宁可晚渲染一瞬，也不能在 mac 上先闪一个按钮再消失
  desktopLyricsSupported: false,

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
  ...createPlaybackSlice(set, get),
}));
