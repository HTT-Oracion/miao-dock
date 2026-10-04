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
 * - 在线歌曲：先按平台调 song_url 拿真实 URL，再走音频代理
 *   `http://127.0.0.1:{port}/audio?url=...`（加 Referer/CORS/流式，Range 透传）。
 * - 封面：`http://127.0.0.1:{port}/cover?url=...`（见 coverProxyUrl）。
 *
 * 持久化：播放历史、本地曲库、播放偏好（音质/音量/皮肤/播放模式）存 WebView localStorage。
 * 参考实现用 tauri-plugin-store（因桌面歌词独立窗口需跨进程共享），本移植**无桌面歌词窗口**
 * （已裁定延后），故用 localStorage 即可，不额外引入前端插件依赖。
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import { create } from 'zustand';
import * as ipc from './ipc';
import { LYRICS_COLOR_DEF, LYRICS_SIZE, VINYL_COLOR_DEF } from './player-options';
import * as platform from './platform';
import type { MusicProvider } from './platform';
import type {
  Artist,
  CommentPage,
  LocalSongInfo,
  LoginInfo,
  Playlist,
  PlayHistoryEntry,
  PlayMode,
  PlaybackQuality,
  Song,
} from './types';

// ------------------------------------------------------------------ 常量 / 工具

/** 单次分页拉取条数（歌单滚动加载） */
const PAGE_SIZE = 50;
/** 播放队列上限（防止无限追加撑爆内存），参考实现同值 */
const MAX_PLAY_QUEUE = 2000;
/** 播放历史上限 */
const MAX_HISTORY = 300;

const LS_HISTORY = 'miaodock.music.playHistory';
const LS_LOCAL = 'miaodock.music.localSongs';
const LS_PREFS = 'miaodock.music.prefs';

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

/** 解析后的歌词行（LRC 时间戳 + 文本） */
export interface ParsedLyricLine {
  time: number;
  text: string;
}

/** 平台音质 token → 中文档位名（认不出的原样显示，不猜） */
const QUALITY_LABELS: Record<string, string> = {
  jymaster: '超清母带',
  master: '超清母带',
  hi_res: '高清臻音',
  hires: '高清臻音',
  lossless: '无损',
  flac: '无损',
  exhigh: '极高',
  highest: '极高',
  higher: '较高',
  high: '较高',
  hq: '较高',
  standard: '标准',
  normal: '标准',
  medium: '标准',
};

export function qualityLabel(raw: string): string {
  if (!raw) return '';
  return QUALITY_LABELS[raw.trim().toLowerCase()] ?? raw;
}

/** 解析 LRC 歌词文本 → 带时间戳的行（按时间排序，过滤空行与元信息标签） */
export function parseLrc(lrc: string): ParsedLyricLine[] {
  const lines: ParsedLyricLine[] = [];
  for (const line of lrc.split('\n')) {
    const m = line.match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/);
    if (!m) continue;
    const min = Number(m[1]);
    const sec = Number(m[2]);
    const ms = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    if (text) lines.push({ time: min * 60 + sec + ms / 1000, text });
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/** 根据当前播放秒数定位高亮歌词行索引（-1 表示尚未到第一句） */
export function lyricIndexAt(lines: ParsedLyricLine[], seconds: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= seconds) idx = i;
    else break;
  }
  return idx;
}

/** 封面走本地代理（加 Referer / 绕 CORS）；asset 协议与 data/blob 原样返回 */
export function coverProxyUrl(url: string, proxyPort: number): string {
  if (!url) return '';
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  if (url.startsWith('http://asset.localhost/') || url.startsWith('https://asset.localhost/')) return url;
  if (!proxyPort) return url;
  return `http://127.0.0.1:${proxyPort}/cover?url=${encodeURIComponent(url)}`;
}

/** 本地导入的 LocalSongInfo → 可播放的统一 Song（provider = "local"） */
export function localToSong(info: LocalSongInfo): Song {
  return {
    provider: 'local',
    id: info.id,
    name: info.title || info.name,
    artist: info.artist || '未知艺术家',
    album: info.album,
    cover: info.cover_path ? convertFileSrc(info.cover_path) : '',
    // Song.duration 全链路单位是毫秒（含本地导入），这里不做换算
    duration: Math.round(info.duration_ms),
    fee: 0,
    playable: true,
    language: 0,
    artists: [],
    _localPath: info.path,
    _localCoverPath: info.cover_path,
    _localHasLyric: info.has_lyric,
  };
}

/** 统一歌曲唯一键（跨列表去重 / 队列定位用） */
export function songKey(s: Song): string {
  return `${s.provider}:${s.id}`;
}

/** 格式化毫秒 → m:ss（播放条时间显示） */
export function fmtTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ 持久化小工具

function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLS(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 配额满 / 隐私模式：持久化失败不影响本次会话
  }
}

/**
 * 合并式写入偏好：每项只改自己那个键。
 * 为什么用合并而不是整份覆盖 —— 各项分别由不同的 setter 写入，整份覆盖会把
 * 「同时改两项」编排成互相覆盖（后写的赢），是一个只在特定操作序列下复现的 bug。
 */
function savePrefs(patch: Partial<Prefs>): void {
  writeLS(LS_PREFS, { ...readLS<Partial<Prefs>>(LS_PREFS, {}), ...patch });
}

/** 读取历史时剔除带 base64 data URL 封面的条目，避免历史把存储撑爆 */
function sanitizeForStorage(song: Song): Song {
  return song.cover && song.cover.startsWith('data:') ? { ...song, cover: '' } : song;
}

// ------------------------------------------------------------------ 无版权自动跳过控制

let unplayableSkipCount = 0;
let isAutoSkipping = false;
/** 每次 playSong 递增，用于忽略飞行中的旧请求（切歌竞态） */
let playSeq = 0;

// ------------------------------------------------------------------ 状态定义

interface Prefs {
  playbackQuality: PlaybackQuality;
  volume: number;
  playMode: PlayMode;
  skin: PlayerSkin;
  /** 展开播放器歌词字号（px） */
  lyricsFontSize: number;
  /** 展开播放器歌词高亮色 */
  lyricsHighlightColor: string;
  /** 动态背景：modern/immersive 皮肤的渐变缓慢流动 */
  dynamicEnabled: boolean;
  /** 碟片模式：展开播放器的封面变成旋转唱片 */
  discMode: boolean;
  /** 透明彩胶配色：auto=跟随封面主色 / custom=固定色 */
  vinylColorMode: 'auto' | 'custom';
  vinylCustomColor: string;
}

interface MusicState {
  // ---- 播放 ----
  currentSong: Song | null;
  queue: Song[];
  currentIndex: number;
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  volume: number;
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

  // ---- 播放/媒体的持久化偏好（设置页「播放·媒体」）----
  lyricsFontSize: number;
  lyricsHighlightColor: string;
  dynamicEnabled: boolean;
  discMode: boolean;
  vinylColorMode: 'auto' | 'custom';
  vinylCustomColor: string;

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
  playSong: (song: Song, queue?: Song[], opts?: { fromHistory?: boolean }) => Promise<void>;
  playQueue: (songs: Song[], startIndex: number) => Promise<void>;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  seek: (ms: number) => void;
  setVolume: (v: number) => void;
  cycleMode: () => void;
  /** 换音质：更新偏好，并在**正在播放**时重取地址续播（保住当前进度） */
  setPlaybackQuality: (q: PlaybackQuality) => Promise<void>;
  setLyricsFontSize: (px: number) => void;
  setLyricsHighlightColor: (color: string) => void;
  setDynamicEnabled: (on: boolean) => void;
  setDiscMode: (on: boolean) => void;
  setVinylColorMode: (mode: 'auto' | 'custom') => void;
  setVinylCustomColor: (color: string) => void;
  /** 播放内核消费完续播位置后清零 */
  clearResumeAt: () => void;
  setProgress: (ms: number) => void;
  setDuration: (ms: number) => void;

  // 队列
  appendToQueue: (songs: Song[]) => void;
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
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

  // UI
  setExpanded: (open: boolean) => void;
  setSkin: (s: PlayerSkin) => void;
  toast: (message: string, type?: 'warning' | 'success') => void;
  clearToast: () => void;
}

// ------------------------------------------------------------------ 内部辅助

/** 按平台解析在线播放地址（song_url → 音频代理） */
async function resolveOnlineUrl(song: Song): Promise<string> {
  const state = useMusicStore.getState();
  const provider = song.provider as MusicProvider;
  const r = await platform.songUrl(provider, song, state.playbackQuality);
  if (!r?.url) return '';
  let port = state.proxyPort;
  if (!port) {
    port = await ipc.getProxyPort();
    useMusicStore.setState({ proxyPort: port });
  }
  return `http://127.0.0.1:${port}/audio?url=${encodeURIComponent(r.url)}`;
}

/** 统一解析一首歌的可播放 URL（本地 asset 协议 / 在线音频代理） */
async function resolvePlayUrl(song: Song): Promise<string> {
  if (song._localPath) return convertFileSrc(song._localPath);
  return resolveOnlineUrl(song);
}

/** 把 provider 的登录信息写进 loginInfos，并按需同步当前 loginInfo */
function mergeLogin(state: MusicState, provider: MusicProvider, info: LoginInfo | null) {
  return {
    loginInfos: { ...state.loginInfos, [provider]: info },
    loginInfo: state.playbackSource === provider ? info : state.loginInfo,
  };
}

// ------------------------------------------------------------------ store

export const useMusicStore = create<MusicState>((set, get) => ({
  // ---- 播放 ----
  currentSong: null,
  queue: [],
  currentIndex: 0,
  isPlaying: false,
  progressMs: 0,
  durationMs: 0,
  volume: 0.8,
  playMode: 'list',
  playUrl: '',
  playbackQuality: 'hires',
  currentQuality: '',
  currentBitrate: 0,
  proxyPort: 0,
  playHistoryList: [],
  resumeAtMs: 0,

  // ---- 播放/媒体的持久化偏好 ----
  lyricsFontSize: LYRICS_SIZE.def,
  lyricsHighlightColor: LYRICS_COLOR_DEF,
  dynamicEnabled: false,
  discMode: false,
  vinylColorMode: 'auto',
  vinylCustomColor: VINYL_COLOR_DEF,

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

  // ---- UI ----
  queueOpen: false,
  expanded: false,
  skin: 'modern',
  loginOpen: false,
  loginProvider: 'netease',
  qrUrl: '',
  qrStatus: '',
  qrLoading: false,
  musicToast: null,

  // ================================================================ init

  hydratePrefs: () => {
    const prefs = readLS<Partial<Prefs>>(LS_PREFS, {});
    const volume = typeof prefs.volume === 'number' ? prefs.volume : 0.8;
    const playMode: PlayMode = prefs.playMode ?? 'list';
    const skin: PlayerSkin = prefs.skin ?? 'modern';
    const playbackQuality: PlaybackQuality = prefs.playbackQuality ?? 'hires';
    const lyricsFontSize =
      typeof prefs.lyricsFontSize === 'number' ? prefs.lyricsFontSize : LYRICS_SIZE.def;
    set({
      volume,
      playMode,
      skin,
      playbackQuality,
      lyricsFontSize,
      lyricsHighlightColor: prefs.lyricsHighlightColor ?? LYRICS_COLOR_DEF,
      dynamicEnabled: prefs.dynamicEnabled === true,
      discMode: prefs.discMode === true,
      vinylColorMode: prefs.vinylColorMode === 'custom' ? 'custom' : 'auto',
      vinylCustomColor: prefs.vinylCustomColor ?? VINYL_COLOR_DEF,
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

  // ================================================================ 本地

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

  // ================================================================ 播放

  playSong: async (song, queue, opts) => {
    const mySeq = ++playSeq;

    // 队列与位置
    if (queue) {
      const idx = queue.findIndex((s) => songKey(s) === songKey(song));
      set({ queue, currentIndex: idx >= 0 ? idx : 0 });
    } else {
      const idx = get().queue.findIndex((s) => songKey(s) === songKey(song));
      if (idx >= 0) set({ currentIndex: idx });
    }

    if (!isAutoSkipping) unplayableSkipCount = 0;

    set({ currentSong: song, progressMs: 0, durationMs: song.duration || 0, isPlaying: false });
    // 歌词与 URL 获取并行（不阻塞播放）
    void get().loadLyrics(song);

    let url = '';
    try {
      url = await resolvePlayUrl(song);
    } catch (e) {
      if (mySeq !== playSeq) return;
      set({ isPlaying: false });
      get().toast(`播放失败：${String(e)}`);
      return;
    }
    if (mySeq !== playSeq) return;

    if (!url) {
      // 无版权 / 需会员：提示后自动跳下一首（连跳上限 10 首，防止整队列全不可播时无限跳）
      set({ isPlaying: false });
      if (unplayableSkipCount < 10) {
        unplayableSkipCount += 1;
        isAutoSkipping = true;
        get().toast('该歌曲无版权或需会员，已自动跳过');
        setTimeout(() => {
          if (get().queue.length > 1) get().next();
        }, 800);
      } else {
        isAutoSkipping = false;
        unplayableSkipCount = 0;
        get().toast('当前队列中多首歌曲无法播放，已停止自动切换');
      }
      return;
    }

    isAutoSkipping = false;
    set({ playUrl: url, isPlaying: true });
    get().recordPlayHistory(song, opts?.fromHistory);
  },

  playQueue: async (songs, startIndex) => {
    const song = songs[startIndex];
    if (!song) return;
    await get().playSong(song, songs);
  },

  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),

  next: () => {
    const { queue, currentIndex, playMode } = get();
    if (queue.length === 0) return;
    let idx = currentIndex;
    if (playMode === 'shuffle') {
      idx = queue.length === 1 ? 0 : Math.floor(Math.random() * queue.length);
    } else {
      idx = (currentIndex + 1) % queue.length;
    }
    void get().playSong(queue[idx]);
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
    void get().playSong(queue[idx]);
  },

  seek: (ms) => set({ progressMs: ms }),

  setVolume: (v) => {
    set({ volume: v });
    savePrefs({ volume: v });
  },

  cycleMode: () => {
    // 心动模式（heartbeat）需相似歌曲续播，本轮未接；顺序：列表 → 随机 → 单曲
    const order: PlayMode[] = ['list', 'shuffle', 'one'];
    const nextMode = order[(order.indexOf(get().playMode) + 1) % order.length];
    set({ playMode: nextMode });
    savePrefs({ playMode: nextMode });
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

  setProgress: (ms) => set({ progressMs: ms }),
  setDuration: (ms) => set({ durationMs: ms }),

  // ================================================================ 队列

  appendToQueue: (songs) => {
    const { queue } = get();
    const ids = new Set(queue.map(songKey));
    const unique = songs.filter((s) => !ids.has(songKey(s)));
    if (unique.length === 0) return;
    const remaining = MAX_PLAY_QUEUE - queue.length;
    set({ queue: [...queue, ...unique.slice(0, Math.max(0, remaining))] });
  },

  removeFromQueue: (index) => {
    const { queue, currentSong, currentIndex } = get();
    if (index < 0 || index >= queue.length) return;
    const removedCurrent = index === currentIndex;
    const nextQ = queue.filter((_, i) => i !== index);
    if (nextQ.length === 0) {
      set({ queue: [], currentSong: null, playUrl: '', isPlaying: false, currentIndex: 0 });
      return;
    }
    set({ queue: nextQ, currentIndex: Math.min(index, nextQ.length - 1) });
    if (removedCurrent) void get().playSong(nextQ[Math.min(index, nextQ.length - 1)]);
    else if (index < currentIndex) set({ currentIndex: currentIndex - 1 });
    void currentSong; // 保留引用，避免未使用告警
  },

  clearQueue: () => set({ queue: [], currentSong: null, playUrl: '', isPlaying: false, currentIndex: 0 }),

  setQueueOpen: (open) => set({ queueOpen: open }),

  // ================================================================ 播放历史

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

  // ================================================================ 平台

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
    } catch {
      // 服务未就绪：逐个兜底探测
      await Promise.all((['netease', 'kugou', 'qqmusic', 'migu'] as MusicProvider[]).map((p) => get().loadLoginStatus(p)));
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

  // ================================================================ 搜索

  setSearchText: (t) => set({ searchText: t }),
  setSearchTab: (t) => set({ searchTab: t }),

  search: async (kw) => {
    const keywords = (kw ?? get().searchText).trim();
    if (!keywords) {
      set({ searchResults: [], searchError: '', searchHasMore: false });
      return;
    }
    const provider = get().searchProvider;
    const pageSize = platform.searchPageSize(provider);
    // 清掉上一轮结果：否则「搜索中」会与旧关键词的结果混在一起
    set({ searching: true, searchError: '', searchText: keywords, searchResults: [], searchHasMore: false });
    try {
      const results = await platform.search(provider, keywords, pageSize, 0);
      // 切了搜索平台就不要旧结果，避免串台
      if (get().searchProvider !== provider) return;
      set({ searchResults: results, searchTab: 'song', searchHasMore: results.length >= pageSize });
    } catch (e) {
      set({ searchResults: [], searchError: String(e) });
    } finally {
      set({ searching: false });
    }
  },

  loadMoreSearch: async () => {
    const { searchText, searchProvider, searchResults, searchHasMore, loadingMoreSearch, searching } = get();
    const keywords = searchText.trim();
    if (!keywords || !searchHasMore || loadingMoreSearch || searching) return;
    const provider = searchProvider;
    const pageSize = platform.searchPageSize(provider);
    set({ loadingMoreSearch: true });
    try {
      const more = await platform.search(provider, keywords, pageSize, searchResults.length);
      // 期间换了平台或改了关键词 → 丢弃这一页
      if (get().searchProvider !== provider || get().searchText.trim() !== keywords) return;
      set((s) => {
        const seen = new Set(s.searchResults.map(songKey));
        const unique = more.filter((x) => !seen.has(songKey(x)));
        return {
          searchResults: [...s.searchResults, ...unique],
          // 「本页被填满 且 有新增」才认为还有下一页：返回空页或整页重复都算到底，
          // 否则会在同一页上无限续拉
          searchHasMore: more.length >= pageSize && unique.length > 0,
        };
      });
    } catch {
      // 这一页失败就停在当前位置，不反复重试同一页
      set({ searchHasMore: false });
    } finally {
      set({ loadingMoreSearch: false });
    }
  },

  searchArtists: async (kw) => {
    const keywords = (kw ?? get().searchText).trim();
    if (!keywords) return;
    const provider = get().searchProvider;
    set({ searching: true, searchError: '' });
    try {
      const results = await platform.searchArtists(provider, keywords, 30);
      if (get().searchProvider !== provider) return;
      set({ artistSearchResults: results, searchTab: 'artist' });
    } catch (e) {
      set({ artistSearchResults: [], searchError: String(e) });
    } finally {
      set({ searching: false });
    }
  },

  searchPlaylists: async (kw) => {
    const keywords = (kw ?? get().searchText).trim();
    if (!keywords) return;
    const provider = get().searchProvider;
    set({ searching: true, searchError: '' });
    try {
      const results = await platform.searchPlaylists(provider, keywords, 30);
      if (get().searchProvider !== provider) return;
      set({ playlistSearchResults: results, searchTab: 'playlist' });
    } catch (e) {
      set({ playlistSearchResults: [], searchError: String(e) });
    } finally {
      set({ searching: false });
    }
  },

  clearSearch: () =>
    set({
      searchText: '',
      searchResults: [],
      searchHasMore: false,
      playlistSearchResults: [],
      artistSearchResults: [],
      searchError: '',
    }),

  // ================================================================ 左栏

  setLeftView: (v) => set({ leftView: v }),

  loadUserPlaylists: async (p) => {
    const provider = p ?? get().playbackSource;
    if (!get().loginInfos[provider]?.logged_in) {
      set({ userPlaylists: [], userPlaylistsError: '' });
      return;
    }
    set({ loadingUserPlaylists: true, userPlaylistsError: '' });
    try {
      const list = await platform.userPlaylists(provider);
      if (get().playbackSource !== provider) return;
      set({ userPlaylists: list, loadingUserPlaylists: false });
    } catch (e) {
      set({ loadingUserPlaylists: false, userPlaylistsError: String(e) });
    }
  },

  openLeftPlaylist: async (pl) => {
    set({ loadingLeftTracks: true, leftPlaylistTracks: [], leftPlaylistMeta: pl, leftView: 'tracks' });
    const provider = get().playbackSource;
    try {
      const [meta, songs] = await platform.playlistTracks(provider, pl.id);
      if (get().playbackSource !== provider) return;
      set({ leftPlaylistMeta: meta, leftPlaylistTracks: songs });
    } catch {
      set({ leftPlaylistTracks: [] });
    } finally {
      set({ loadingLeftTracks: false });
    }
  },

  loadMoreLeft: async () => {
    const { leftPlaylistMeta, leftPlaylistTracks, loadingMoreLeft, playbackSource } = get();
    const id = leftPlaylistMeta?.id;
    const total = leftPlaylistMeta?.track_count ?? 0;
    if (!id || loadingMoreLeft) return;
    const start = leftPlaylistTracks.length;
    if (start >= total) return;
    set({ loadingMoreLeft: true });
    try {
      const songs = await platform.playlistTracksRange(playbackSource, id, start, PAGE_SIZE);
      if (songs.length === 0) return;
      set((s) => {
        // 当前队列正来自本歌单 → 新页去重后同步追加进队列
        const syncsQueue =
          s.queue.length > 0 &&
          s.leftPlaylistTracks.length > 0 &&
          songKey(s.leftPlaylistTracks[0]) === songKey(s.queue[0]);
        if (syncsQueue) {
          const ids = new Set(s.queue.map(songKey));
          const unique = songs.filter((x) => !ids.has(songKey(x)));
          return {
            leftPlaylistTracks: [...s.leftPlaylistTracks, ...songs],
            queue: unique.length > 0 ? [...s.queue, ...unique] : s.queue,
          };
        }
        return { leftPlaylistTracks: [...s.leftPlaylistTracks, ...songs] };
      });
    } catch {
      // 静默：滚动加载失败不打断已加载内容
    } finally {
      set({ loadingMoreLeft: false });
    }
  },

  loadAllLeft: async () => {
    const { leftPlaylistMeta, playbackSource } = get();
    const id = leftPlaylistMeta?.id;
    const total = leftPlaylistMeta?.track_count ?? 0;
    if (!id || total === 0) return;
    // 循环拉完剩余页；任一页空或报错即退出（避免死循环）
    for (;;) {
      const s = get();
      if (s.leftPlaylistMeta?.id !== id) break;
      const start = s.leftPlaylistTracks.length;
      if (start >= total) break;
      let songs: Song[] = [];
      try {
        songs = await platform.playlistTracksRange(playbackSource, id, start, PAGE_SIZE);
      } catch {
        break;
      }
      if (songs.length === 0) break;
      set((st) => ({ leftPlaylistTracks: [...st.leftPlaylistTracks, ...songs] }));
    }
  },

  backToPlaylists: () => set({ leftView: 'playlists', leftPlaylistTracks: [], leftPlaylistMeta: null }),

  // ================================================================ 右栏

  setRightView: (v) => set({ rightView: v }),

  /** 官方榜单：网易云用硬编码榜单 ID + 歌单详情拼；酷狗/QQ/咪咕各有榜单列表接口 */
  loadCharts: async (p) => {
    const provider = p ?? get().playbackSource;
    set({ loadingCharts: true });
    try {
      if (provider === 'netease') {
        const CHART_IDS: [string, string][] = [
          ['3778678', '热歌榜'],
          ['19723756', '飙升榜'],
          ['3779629', '新歌榜'],
          ['2884035', '原创榜'],
          ['112504', '抖音排行榜'],
          ['6723173524', '网络热歌榜'],
          ['5453912201', 'VIP热歌榜'],
          ['6886768100', '中文DJ榜'],
          ['1978921795', '电音榜'],
          ['2809513713', '说唱榜'],
          ['71384707', '古典榜'],
        ];
        const results = await Promise.all(
          CHART_IDS.map(([id, name]) =>
            ipc.musicPlaylistDetail(id).catch(
              () =>
                ({
                  provider: 'netease',
                  id,
                  name,
                  cover: '',
                  track_count: 0,
                  creator: '网易云音乐',
                  subscribed: false,
                }) as Playlist,
            ),
          ),
        );
        if (get().playbackSource !== provider) return;
        set({ officialCharts: results });
      } else {
        const charts = await platform.rankList(provider);
        if (get().playbackSource !== provider) return;
        set({ officialCharts: charts });
      }
    } catch {
      if (get().playbackSource === provider) set({ officialCharts: [] });
    } finally {
      set({ loadingCharts: false });
    }
  },

  /** 推荐歌单 + 每日推荐歌曲（按平台能力，无能力的平台置空） */
  loadRecommend: async (p) => {
    const provider = p ?? get().playbackSource;
    set({ loadingRecommend: true, loadingDaily: true });
    try {
      const [pls, songs] = await Promise.all([
        platform.recommendPlaylists(provider).catch(() => [] as Playlist[]),
        platform.dailySongs(provider).catch(() => [] as Song[]),
      ]);
      if (get().playbackSource !== provider) return;
      set({ recommendPlaylists: pls, dailySongs: songs });
    } finally {
      set({ loadingRecommend: false, loadingDaily: false });
    }
  },

  openRightPlaylist: async (pl) => {
    set({ loadingRightTracks: true, rightPlaylistTracks: [], rightPlaylistMeta: pl, rightView: 'tracks' });
    const provider = get().playbackSource;
    try {
      if (platform.chartUsesRankSongs(provider) && pl.creator === '榜单') {
        const songs = await platform.rankSongs(provider, pl.id, 100);
        if (get().playbackSource !== provider) return;
        set({ rightPlaylistTracks: songs });
        return;
      }
      const [meta, songs] = await platform.playlistTracks(provider, pl.id);
      if (get().playbackSource !== provider) return;
      set({ rightPlaylistMeta: meta, rightPlaylistTracks: songs });
    } catch {
      set({ rightPlaylistTracks: [] });
    } finally {
      set({ loadingRightTracks: false });
    }
  },

  /** 榜单卡片点击：QQ/咪咕走榜单歌曲接口，网易云/酷狗走歌单曲目接口 */
  openRightChart: async (pl) => {
    set({ rightView: 'tracks', rightPlaylistMeta: pl, loadingRightTracks: true, rightPlaylistTracks: [] });
    const provider = get().playbackSource;
    try {
      if (platform.chartUsesRankSongs(provider)) {
        const limited = provider === 'migu' ? 100 : 99999;
        const songs = await platform.rankSongs(provider, pl.id, limited);
        if (get().playbackSource !== provider) return;
        set({ rightPlaylistTracks: songs });
      } else {
        const [meta, songs] = await platform.playlistTracks(provider, pl.id);
        if (get().playbackSource !== provider) return;
        set({ rightPlaylistMeta: meta, rightPlaylistTracks: songs });
      }
    } catch {
      set({ rightPlaylistTracks: [] });
    } finally {
      set({ loadingRightTracks: false });
    }
  },

  loadMoreRight: async () => {
    const { rightPlaylistMeta, rightPlaylistTracks, loadingMoreRight, playbackSource } = get();
    const id = rightPlaylistMeta?.id;
    const total = rightPlaylistMeta?.track_count ?? 0;
    if (!id || loadingMoreRight) return;
    const start = rightPlaylistTracks.length;
    if (total === 0 || start >= total) return;
    set({ loadingMoreRight: true });
    try {
      const songs = await platform.playlistTracksRange(playbackSource, id, start, PAGE_SIZE);
      if (songs.length === 0) return;
      set((s) => {
        const syncsQueue =
          s.queue.length > 0 &&
          s.rightPlaylistTracks.length > 0 &&
          songKey(s.rightPlaylistTracks[0]) === songKey(s.queue[0]);
        if (syncsQueue) {
          const ids = new Set(s.queue.map(songKey));
          const unique = songs.filter((x) => !ids.has(songKey(x)));
          return {
            rightPlaylistTracks: [...s.rightPlaylistTracks, ...songs],
            queue: unique.length > 0 ? [...s.queue, ...unique] : s.queue,
          };
        }
        return { rightPlaylistTracks: [...s.rightPlaylistTracks, ...songs] };
      });
    } catch {
      // 静默
    } finally {
      set({ loadingMoreRight: false });
    }
  },

  backToRecommendations: () =>
    set({ rightView: 'recommendations', rightPlaylistTracks: [], rightPlaylistMeta: null }),

  togglePlaylistSubscribe: async (pl) => {
    if (pl.provider !== 'netease') {
      get().toast('当前平台暂不支持收藏歌单');
      return;
    }
    try {
      await ipc.musicPlaylistSubscribe(pl.id, !pl.subscribed);
      set((s) => ({
        officialCharts: s.officialCharts.map((x) => (x.id === pl.id ? { ...x, subscribed: !x.subscribed } : x)),
        recommendPlaylists: s.recommendPlaylists.map((x) =>
          x.id === pl.id ? { ...x, subscribed: !x.subscribed } : x,
        ),
        userPlaylists: s.userPlaylists.map((x) => (x.id === pl.id ? { ...x, subscribed: !x.subscribed } : x)),
      }));
      get().toast(pl.subscribed ? '已取消收藏' : '已收藏歌单', 'success');
    } catch (e) {
      get().toast(`收藏失败：${String(e)}`);
    }
  },

  // ================================================================ 红心

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

  // ================================================================ 歌词 / 评论

  loadLyrics: async (song) => {
    try {
      let raw = '';
      if (song._localPath) {
        raw = await ipc.getLocalLyric(song._localPath);
      } else {
        const l = await platform.lyric(song.provider as MusicProvider, song);
        raw = l.lyric || '';
      }
      // 只应用当前歌曲的歌词，避免切歌后旧歌词覆盖
      if (get().currentSong && songKey(get().currentSong as Song) !== songKey(song)) return;
      set({ parsedLyrics: parseLrc(raw) });
    } catch {
      if (get().currentSong && songKey(get().currentSong as Song) === songKey(song)) set({ parsedLyrics: [] });
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

  // ================================================================ UI

  setExpanded: (open) => set({ expanded: open }),

  setSkin: (s) => {
    set({ skin: s });
    savePrefs({ skin: s });
  },

  toast: (message, type = 'warning') => set({ musicToast: { type, message } }),
  clearToast: () => set({ musicToast: null }),
}));
