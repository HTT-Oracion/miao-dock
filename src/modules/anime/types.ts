/**
 * 番剧模块（anime）的类型事实源 —— 前端与 `animesvc` 共用同一套形状。
 *
 * 三层模型「番 / 集 / 进度」：
 * - `AnimeSubject` 是「番」（条目）；
 * - `AnimeEpisode` 是「集」；
 * - 进度不是独立对象，而是**集上的 `positionMs` + `watched`**，
 *   条目级进度由集汇总得出（不另存一份，避免两处数字打架）。
 *
 * 字段一律 camelCase：Rust 侧 `#[serde(rename_all = "camelCase")]`，
 * manifest 落盘与 IPC 返回是同一份形状（少一层转换就少一类漂移）。
 */

/** 模块内视图（侧栏 popover 四项 + 详情/播放器/账号等衍生视图） */
export type AnimeView =
  'explore' | 'collection' | 'cache' | 'history' | 'detail' | 'player' | 'account' | 'source' | 'states';

/** 追番五状态 —— 与界面文案一一对应（溜了 / 想补 / 在看 / 囤着 / 看完） */
export type CollectionType = 'dropped' | 'wish' | 'doing' | 'onhold' | 'done';

export const COLLECTION_LABELS: Record<CollectionType, string> = {
  dropped: '溜了',
  wish: '想补',
  doing: '在看',
  onhold: '囤着',
  done: '看完',
};

/** 追番页 tab 顺序（渲染与断言共用一处；顺序即产品口径） */
export const COLLECTION_ORDER: CollectionType[] = ['dropped', 'wish', 'doing', 'onhold', 'done'];

/** 同步态：本地与云端是否一致（播放历史 / 条目同步徽标用） */
export type SyncState = 'synced' | 'pending' | 'conflict';

/** 番（条目） */
export interface AnimeSubject {
  /** 条目 id（= 番剧目录名；本地库以目录为身份） */
  id: string;
  /** Bangumi 条目 id（元数据来源；身份仍是目录名） */
  bgmId?: number;
  title: string;
  titleOriginal?: string;
  cover?: string;
  year?: number;
  /** 放送季度，如 `2022-04` */
  season?: string;
  episodesTotal?: number;
  summary?: string;
  tags: string[];
  /** 0–10 分；无评分时省略（不写 0，0 是「打了 0 分」） */
  rating?: number;
  /** 收藏态；null / 缺省 = 未收藏 */
  collection?: CollectionType | null;
  /** 已看集数（由集汇总，落盘时写一份便于列表排序） */
  progress: number;
  updatedAt: number;
  /** 放送信息：连载中 / 已完结，最新话与星期（新番时间表用） */
  airing?: { state: 'airing' | 'finished'; latest?: number; weekday?: number };
  /** 目录绝对路径（Rust 扫描附带，界面不展示完整路径，只做定位） */
  dir?: string;
  /** 目录体积（字节） */
  sizeBytes?: number;
}

/** 片段区间（片头 / 片尾） */
export interface Segment {
  startMs: number;
  endMs: number;
}

/** 集 */
export interface AnimeEpisode {
  id: string;
  subjectId: string;
  /** 集号（从 1 起）；特别篇用 `12.5` 这类一位小数 */
  index: number;
  title: string;
  durationMs: number;
  op?: Segment;
  ed?: Segment;
  watched: boolean;
  /** 续看位置（毫秒）；0 = 从头 */
  positionMs: number;
  updatedAt: number;
}

/** `anime_library` / `anime_seed_demo` 的返回（与 animesvc 的 JSON 同形） */
export interface AnimeLibrarySnapshot {
  root: string;
  count: number;
  subjects: AnimeSubject[];
  episodes: AnimeEpisode[];
  scannedAt: number;
  /** 扫描时跳过的目录与原因（坏 manifest 不静默吞） */
  skipped: { path: string; reason: string }[];
}

/** `anime_status` 的返回 */
export interface AnimeServiceStatus {
  running: boolean;
  port: number | null;
  rootDir: string | null;
  bin: string | null;
  paths: {
    dataRoot: string;
    animeStateDir: string;
    animeRootDir: string;
    animeRuntimeRoot: string;
    animeTokenFile: string;
  };
}

/** 数据源「测试」返回的一条（RSS 适配器；kind 决定上层能拿它干什么） */
export interface AnimeSourceTestItem {
  /** 源内部的稳定 id（媒体服务器的条目 id；RSS 这类没有 id 的源为 null） */
  id: string | null;
  title: string;
  index: number | null;
  link: string | null;
  enclosure: string | null;
  /** `video` 可直链播放 / `torrent` 要走 BT（M5）/ `page` 只是网页 */
  kind: 'video' | 'torrent' | 'page';
  published: string | null;
}

/**
 * 远程播放事实（媒体服务器中继）。
 *
 * `url` 是**我们自己的**带票地址（`/anime/mediaserver/stream`），
 * 不是上游地址：`api_key` 只活在服务侧请求头里，不进 URL。
 */
export interface AnimeRemotePlayback {
  url: string;
  /** 展示用标题（源里的那一集叫什么） */
  title: string;
  sourceId: string;
  sourceName: string;
  /** 票面过期时刻（毫秒时间戳） */
  expiresAt: number;
}

/** Bangumi 检索候选（`anime_metadata_search` 的一项） */
export interface AnimeMetadataCandidate {
  bgmId: number;
  /** 原名 */
  name: string;
  /** 中文名；空串 = 上游没有 */
  nameCn: string;
  cover: string | null;
  year: number | null;
  season: string | null;
  rating: number | null;
  episodesTotal: number | null;
  summary: string;
  tags: string[];
}

/** 一集的外挂字幕（`url` 已带票，`<track>` 可直接用） */
export interface AnimePlaySubtitle {
  url: string;
  name: string;
  format: string;
}

/** 探测到片源、但需要随包内核（mkv 等 WebView 解不了的容器） */
export interface AnimePlaySourceKernel {
  found: true;
  track: 'libmpv';
  supported: false;
  /** 人话原因（「这一集是 mkv 容器，需要随包播放内核…」） */
  reason: string;
  container: string;
  title: string;
  file: string;
}

/** WebView 轨：带签名的本地 Range 流（或 HLS） */
export interface AnimePlaySourceWebview {
  found: true;
  track: 'webview';
  supported: true;
  /** `progressive` = 单文件；`hls` = m3u8（要 hls.js） */
  kind: 'progressive' | 'hls';
  url: string;
  container: string;
  sizeBytes: number;
  title: string;
  subtitles: AnimePlaySubtitle[];
  /** 票面过期时刻（毫秒时间戳）；过期后地址不再可用，需重新取一次 */
  expiresAt: number;
}

/** 盘上没有这一集的视频（不是错误，是事实） */
export interface AnimePlaySourceMissing {
  found: false;
  subjectId: string;
  index: number;
  reason: string;
  skipped: { path: string; reason: string }[];
}

/** `anime_play_source` 的返回：走哪条轨、能不能播、地址是什么 */
export type AnimePlaySource = AnimePlaySourceWebview | AnimePlaySourceKernel | AnimePlaySourceMissing;

/** 播放器的单一状态接口（M2 双轨共用；本轮先冻结形状） */
export interface PlaybackState {
  episodeId: string | null;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  bufferedMs: number;
  rate: number;
  /** 当前字幕轨标签；空 = 无字幕 */
  subtitle: string;
  /** 当前音轨标签 */
  audioTrack: string;
}

/** 账号与同步 */
export interface AnimeAccount {
  loggedIn: boolean;
  username?: string;
  email?: string;
  cloudCount?: number;
  lastSyncAt?: number;
}

/** 待同步队列的一条 */
export interface SyncTask {
  id: string;
  /** 人话描述（「《孤独摇滚！》第 12 话 标记为看完」） */
  label: string;
  state: 'pushed' | 'retrying' | 'queued';
}

/** 双侧冲突（本地 vs 云端 同一集进度不同） */
export interface SyncConflict {
  subjectTitle: string;
  episodeIndex: number;
  localMs: number;
  cloudMs: number;
  localAt: number;
  cloudAt: number;
}

/** 缓存 / BT 任务 */
export interface CacheTask {
  id: string;
  subjectId: string;
  episodeIndex: number;
  title: string;
  sizeBytes: number;
  receivedBytes: number;
  state: 'downloading' | 'paused' | 'done' | 'failed' | 'seeding';
  bufferedMs?: number;
}

/** 数据源 */
export interface MediaSourceView {
  id: string;
  name: string;
  kind: 'web' | 'rss' | 'selector' | 'jellyfin' | 'emby' | 'local' | 'builtin' | 'bt';
  url?: string;
  enabled: boolean;
  health?: 'ok' | 'timeout' | 'untested' | 'error';
}

/** 跳过片头片尾的档位（设计稿四档） */
export type SkipMode = 'op' | 'ed' | 'both' | 'off';
export const SKIP_LABEL: Record<SkipMode, string> = {
  op: '跳过片头',
  ed: '跳过片尾',
  both: '全部',
  off: '关闭',
};
