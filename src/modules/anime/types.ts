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
  /** Bangumi 全站排名（v0 `rank`；没进榜就没有） */
  rank?: number;
  /** 收藏人数（v0 `collection_total`） */
  collectionTotal?: number;
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

/** 探索页「新番周历」的一天；`weekday` 0=周一…6=周日（与 `WEEKDAYS` 同口径） */
export interface AnimeCalendarDay {
  weekday: number;
  items: AnimeMetadataCandidate[];
}

/** 详情页：角色 + 声优（Bangumi `/subjects/{id}/characters`） */
export interface AnimeCharacter {
  id: number;
  name: string;
  nameCn: string;
  relation: string;
  image: string | null;
  actors: { id: number; name: string; image: string | null }[];
}

/** 详情页：制作人员（`/subjects/{id}/persons`） */
export interface AnimeStaff {
  id: number;
  name: string;
  relation: string;
  career: string[];
  image: string | null;
}

/** 详情页：关联作品（`/subjects/{id}/subjects`） */
export interface AnimeRelated {
  bgmId: number;
  name: string;
  nameCn: string;
  relation: string;
  image: string | null;
}

/** 详情页补充数据：三个接口各拉各的，任一失败只影响它自己 */
export interface AnimeDetailExtra {
  bgmId: number;
  characters: AnimeCharacter[];
  staff: AnimeStaff[];
  related: AnimeRelated[];
  loading: boolean;
  error: string | null;
}

/**
 * 探索页「热度推荐」的回执。
 *
 * `source: 'rank'` = 上游不支持热度排序，服务侧退回了排行 —— 界面据此换文案，
 * **不把排行说成热度**。
 */
export interface AnimeHotResult {
  ok: boolean;
  source: 'heat' | 'rank';
  note?: string;
  candidates: AnimeMetadataCandidate[];
}

/** 一集的外挂字幕（`url` 已带票，`<track>` 可直接用） */
export interface AnimePlaySubtitle {
  url: string;
  name: string;
  format: string;
}

/** 探测到片源、需要随包内核（mkv 等 WebView 解不了的容器） */
export interface AnimePlaySourceKernel {
  found: true;
  track: 'libmpv';
  /** 内核可用 ⇒ 能播；不可用 ⇒ 只有 reason（不给一个播不出来的地址） */
  supported: boolean;
  /** 画面在内核自己的窗口里（不嵌在应用内） */
  external: boolean;
  /** 人话原因（可用时说明走哪条轨，不可用时说明缺什么） */
  reason: string;
  container: string;
  title: string;
  file: string;
  sizeBytes: number;
  /** 外挂字幕：内核自己读盘，所以只有文件名，没有带票 URL */
  subtitles: { name: string; file: string; format: string }[];
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

/** 内核轨的一条轨（音轨 / 字幕轨） */
export interface AnimeKernelTrack {
  kind: 'audio' | 'sub';
  id: string;
  label: string;
  lang: string;
  selected: boolean;
}

/** 内核会话快照（`anime_kernel_status` 的返回） */
export interface AnimeKernelStatus {
  /** 随包 mpv 找不找得到（不可用时 `reason` 说清缺什么） */
  available: boolean;
  path: string;
  reason: string;
  /** 画面在内核自己的窗口里 */
  external: boolean;
  session: {
    open: boolean;
    file: string;
    title: string;
    state: PlaybackState;
    tracks: AnimeKernelTrack[];
    ended: boolean;
  };
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

/** 待同步队列里的一条（服务端结构） */
export interface AccountQueueItem {
  id: string;
  kind: string;
  key: string;
  updatedAt: number;
  payload: Record<string, unknown>;
}

/** 同步结果摘要 */
export interface AccountSyncResult {
  ok: boolean;
  pushed: number;
  cloudCount: number;
  lastSyncAt?: number;
  conflicts: {
    id: string;
    kind: string;
    key: string;
    local: AccountQueueItem | null;
    cloud: AccountQueueItem;
  }[];
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

/** BT 任务（librqbit 的 stats 原样映射） */
export interface BtTask {
  id: number;
  name: string;
  state: 'initializing' | 'downloading' | 'paused' | 'done' | 'failed';
  progressBytes: number;
  totalBytes: number;
  uploadedBytes: number;
  finished: boolean;
  ratio: number;
  error?: string | null;
}

/** PikPak 接口状态（只留接口：能力位恒 false） */
export interface PikPakStatus {
  implemented: boolean;
  configured: boolean;
  reason: string;
}

/** BT 会话状态（端口 / 聚合量 / 任务数） */
export interface BtStats {
  running: boolean;
  port: number;
  downloadedBytes?: number;
  uploadedBytes?: number;
  ratio?: number;
  tasks?: number;
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
  /** 通用网页源的选择器规则（`web` / `selector` 两类用；其余类型没有） */
  rules?: AnimeSourceRules;
}

/** 通用网页源的选择器规则（与 Rust `sources::SourceRules` 同形）。
 *
 * `list` 必填；`link` / `title` 缺省时按「容器自身或第一个 `<a>`」「容器文本」处理；
 * `video` 只在详情页解析直链时用。
 */
export interface AnimeSourceRules {
  list: string;
  link?: string;
  title?: string;
  video?: string;
}

/** 验证码窗口里取出的会话 cookie（抓取层拿它当 `Cookie` 头） */
export interface AnimeCookie {
  name: string;
  value: string;
}

/** 跳过片头片尾的档位（设计稿四档） */
export type SkipMode = 'op' | 'ed' | 'both' | 'off';
export const SKIP_LABEL: Record<SkipMode, string> = {
  op: '跳过片头',
  ed: '跳过片尾',
  both: '全部',
  off: '关闭',
};

/** 搜索筛选条（R2-6）：年份 / 季度 / 标签 / 排序 + 结果布局 */
export interface AnimeSearchFilters {
  year: number | null;
  quarter: number | null;
  tag: string | null;
  sort: 'match' | 'heat' | 'rank' | 'score';
  layout: 'grid' | 'list';
}
