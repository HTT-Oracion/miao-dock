/**
 * 番剧模块的 zustand store —— 跨组件共享状态的**唯一收口**（D-42 口径）。
 *
 * 与 `modules/music/store.ts` 同构：状态 shape 在这里，动作按切片拆到 `actions/*.ts`。
 * 🔴 切片文件与 store **不得互相 import 值**（类型可 type-only）——
 * 被多段共用的东西先下沉到 `slice.ts` / `convert.ts`，否则成环。
 */
import { create } from 'zustand';
import type {
  AnimeAccount,
  BtStats,
  BtTask,
  PikPakStatus,
  AnimeCalendarDay,
  AnimeDetailExtra,
  AnimeEpisode,
  AnimeMetadataCandidate,
  AnimeSearchFilters,
  AnimeServiceStatus,
  AnimeSubject,
  AnimeView,
  CacheTask,
  CollectionType,
  MediaSourceView,
  PlaybackState,
  AnimeRemotePlayback,
  AnimeSourceTestItem,
  SyncConflict,
  SyncTask,
} from '@anime/types';
import type { AnimePrefs } from '@anime/prefs';
import { loadPrefs } from '@anime/prefs';
import { navigationActions } from '@anime/actions/navigation';
import { libraryActions } from '@anime/actions/library';

export interface AnimeState {
  // ── 导航 ──
  /** 模块内视图（不参与壳层路由；`/anime` 只回答"哪个应用"） */
  view: AnimeView;
  /** 搜索关键词 */
  query: string;
  /** 入口双模式：探索（默认落地）/ 搜索 */
  searchMode: 'explore' | 'search';
  /** 追番筛选：`all` = 全部 */
  filter: CollectionType | 'all';

  // ── 服务 ──
  status: AnimeServiceStatus | null;

  // ── 番剧库（animesvc 扫描结果） ──
  libraryRoot: string;
  subjects: AnimeSubject[];
  episodes: AnimeEpisode[];
  loading: boolean;
  /** 至少成功扫描过一次；区分「还没扫」与「扫了是空的」 */
  loaded: boolean;
  error: string | null;
  scannedAt: number;
  skipped: { path: string; reason: string }[];

  // ── 选中 / 播放 ──
  selectedId: string | null;
  selectedEpisodeId: string | null;
  playback: PlaybackState;

  // ── 偏好 / 账号 / 数据源 / 缓存 ──
  prefs: AnimePrefs;
  account: AnimeAccount;
  /** BT 任务与会话状态（librqbit 真实数据） */
  btTasks: BtTask[];
  btStats: BtStats;
  /** PikPak 接口状态（只留接口：能力位恒 false） */
  pikpakStatus: PikPakStatus | null;
  syncQueue: SyncTask[];
  conflicts: SyncConflict[];
  sources: MediaSourceView[];
  cache: CacheTask[];
  /** 远程播放（媒体服务器中继）；本地播放时不占用这个字段 */
  remote: AnimeRemotePlayback | null;

  // ── 探索页在线数据（Bangumi 时间表 / 热度） ──
  calendar: AnimeCalendarDay[];
  hot: AnimeMetadataCandidate[];
  /** `rank` = 上游不支持热度排序、服务侧退回了排行（界面据此换文案） */
  hotSource: 'heat' | 'rank';
  exploreLoading: boolean;
  exploreError: string | null;

  /** 详情页补充数据（角色 / 制作 / 关联），按 Bangumi id 现取 */
  detailExtra: AnimeDetailExtra | null;
  /** 搜索筛选条（年份 / 季度 / 标签 / 排序 / 布局） */
  searchFilters: AnimeSearchFilters;
  /** 「补全信息」找到多个候选时挂在这里，等用户挑一个（dir = 作品目录名） */
  metaCandidates: { dir: string; list: AnimeMetadataCandidate[] } | null;

  // ── 动作（实现见 actions/*.ts） ──
  setView: (v: AnimeView) => void;
  setQuery: (q: string) => void;
  setSearchMode: (m: 'explore' | 'search') => void;
  setFilter: (f: CollectionType | 'all') => void;
  refreshLibrary: (root?: string | null) => Promise<void>;
  selectSubject: (id: string | null) => void;
  openPlayer: (subjectId: string, episodeId?: string | null) => void;
  setCollection: (id: string, c: CollectionType | null) => Promise<void>;
  markWatched: (episodeId: string, watched: boolean) => Promise<void>;
  savePosition: (episodeId: string, positionMs: number) => Promise<void>;
  /** 从 Bangumi 补全元数据（封面 / 评分 / 简介 / 标签 / 连载星期） */
  fillMetadata: (subjectId: string) => Promise<{ ok: boolean; message: string }>;
  /** 切换番剧库根（会重启动漫服务，随后重新扫描） */
  applyLibraryRoot: (dir: string) => Promise<void>;
  /** 切换代理（会重启动漫服务） */
  applyProxy: (mode: string, url: string) => Promise<void>;
  /** 新增 / 更新一个媒体源 */
  saveSource: (source: MediaSourceView) => Promise<void>;
  /** 删除一个媒体源 */
  deleteSource: (id: string) => Promise<void>;
  /** 把本机文件夹导入库根，返回一句人话结果 */
  importFolder: (path: string, subject?: string | null) => Promise<{ ok: boolean; message: string }>;
  /** 播媒体服务器里的一集（Jellyfin / Emby）：取带票中继地址并跳播放器 */
  playRemoteSource: (sourceId: string, item: AnimeSourceTestItem) => Promise<{ ok: boolean; message: string }>;
  /** 退出远程播放（离开播放器时调用） */
  clearRemote: () => void;
  /** 用一条已解析的直链播放（在线网页源；不经过中继，可能受防盗链影响） */
  playWebUrl: (url: string, title: string, sourceName: string, sourceId: string) => void;
  setPref: <K extends keyof AnimePrefs>(key: K, value: AnimePrefs[K]) => void;
  loadDemo: () => Promise<void>;
  clearDemo: () => Promise<void>;
  loadSources: () => Promise<void>;
  loadCache: () => Promise<void>;
  /** 拉探索页在线数据（时间表 + 热度）；`force` 跳过缓存重取 */
  loadExplore: (force?: boolean) => Promise<void>;
  /** 拉详情页补充数据（角色 / 制作 / 关联）；同一部只拉一次 */
  loadDetailExtra: (bgmId: number) => Promise<void>;
  /** 把 Bangumi 候选建成一条新番剧（幂等），成功后重扫并选中 */
  importCandidate: (bgmId: number) => Promise<{ ok: boolean; message: string }>;
  /** 粘贴 Bangumi 链接 / 手输编号 → 建库 */
  importByRef: (input: string) => Promise<{ ok: boolean; message: string }>;
  /** 用户从候选里挑了一个：按它补全这一部 */
  applyMetadataCandidate: (dir: string, bgmId: number) => Promise<{ ok: boolean; message: string }>;
  /** 收起候选面板（用户改主意） */
  clearMetaCandidates: () => void;
  /** 改一个筛选条（年份 / 季度 / 标签 / 排序 / 布局） */
  setSearchFilter: <K extends keyof AnimeSearchFilters>(key: K, value: AnimeSearchFilters[K]) => void;
  /** 清空筛选条 */
  resetSearchFilters: () => void;
  /** 新建缓存任务（用当前这一集的直链；目录与上限来自设置） */
  addCache: (input: {
    subjectId: string;
    episodeIndex: number;
    title: string;
    url: string;
    sizeBytes?: number;
  }) => Promise<{ ok: boolean; message: string }>;
  /** 暂停 / 继续 / 删除缓存任务（三个都重新拉一次列表） */
  pauseCache: (id: string) => Promise<void>;
  resumeCache: (id: string) => Promise<void>;
  deleteCache: (id: string) => Promise<void>;
  refreshStatus: () => Promise<void>;
  /** 账号：拉状态（登录态 + 待同步队列） */
  loadAccount: () => Promise<void>;
  /** 邮箱密码登录 */
  loginPassword: (email: string, password: string) => Promise<{ ok: boolean; message: string }>;
  /** 设备码 / 扫码：开始（返回设备码与轮询间隔） */
  startDevice: (kind: 'oauth' | 'qr') => Promise<{ deviceCode: string; userCode: string; interval: number } | null>;
  /** 设备码 / 扫码：轮询一次 */
  pollDevice: (code: string) => Promise<'pending' | 'ok' | 'expired'>;
  /** 桩专用：模拟另一端确认 */
  approveDevice: (code: string) => Promise<void>;
  /** 退出登录 */
  logoutAccount: () => Promise<void>;
  /** 同步一次（按设置里的冲突策略） */
  syncNow: () => Promise<{ ok: boolean; message: string; conflicts: number }>;
  /** 手动挑边：local 覆盖云端 / 
emote 采纳云端 */
  resolveConflict: (id: string, side: 'local' | 'remote') => Promise<{ ok: boolean; message: string }>;
  /** BT：拉任务与会话状态 */
  loadBt: () => Promise<void>;
  /** BT：添加磁力（受 allowBt 开关约束） */
  addBt: (url: string) => Promise<{ ok: boolean; message: string }>;
  /** BT：暂停 / 继续 / 删除 */
  pauseBt: (id: number) => Promise<void>;
  resumeBt: (id: number) => Promise<void>;
  deleteBt: (id: number) => Promise<void>;
  /** BT 边下边播：拿带票地址并交给播放器（受 btStream 开关约束） */
  playBt: (id: number, name: string) => Promise<{ ok: boolean; message: string }>;
  /** 拉 PikPak 接口状态（不编造能力） */
  loadPikpak: () => Promise<void>;
}

/** 播放器初始态：没有片源时也要有完整形状（组件读字段不判空） */
const IDLE_PLAYBACK: PlaybackState = {
  episodeId: null,
  positionMs: 0,
  durationMs: 0,
  playing: false,
  bufferedMs: 0,
  rate: 1,
  subtitle: '',
  audioTrack: '',
};

/**
 * 账号初始态 = 未登录。
 * 刻意**不预置示例账号**：登录态是事实，不是占位内容（假账号比空态更糟）。
 */
const EMPTY_ACCOUNT: AnimeAccount = { loggedIn: false };

export const useAnimeStore = create<AnimeState>()((set, get) => ({
  view: 'explore',
  query: '',
  searchMode: 'explore',
  // 追番默认落在「在看」——设计稿的默认 tab，也是用户回来最常看的一格
  filter: 'doing',

  status: null,

  libraryRoot: '',
  subjects: [],
  episodes: [],
  loading: false,
  loaded: false,
  error: null,
  scannedAt: 0,
  skipped: [],

  selectedId: null,
  selectedEpisodeId: null,
  playback: { ...IDLE_PLAYBACK },

  prefs: loadPrefs(),
  account: EMPTY_ACCOUNT,
  btTasks: [],
  btStats: { running: false, port: 0 },
  pikpakStatus: null,
  syncQueue: [],
  conflicts: [],
  sources: [],
  cache: [],
  remote: null,

  calendar: [],
  hot: [],
  hotSource: 'heat',
  exploreLoading: false,
  exploreError: null,
  detailExtra: null,
  metaCandidates: null,
  searchFilters: { year: null, quarter: null, tag: null, sort: 'match', layout: 'grid' },

  ...navigationActions(set, get),
  ...libraryActions(set, get),
}));
