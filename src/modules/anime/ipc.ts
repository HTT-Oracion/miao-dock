/**
 * 番剧模块 IPC 层 —— 封装 Rust `anime/` 桥接命令（`anime_*` 前缀）。
 *
 * 数据链路：前端 → Tauri 命令（`src-tauri/src/anime/mod.rs`）→ 本地 `animesvc` HTTP。
 * 前端**不直连第三方站点、不直接读盘**：扫描、manifest、收藏、进度全在服务侧，
 * CLI / e2e / 桌面端跑的是同一套实现。
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  AccountQueueItem,
  AccountSyncResult,
  AnimeCalendarDay,
  AnimeCharacter,
  AnimeCookie,
  AnimeEpisode,
  AnimeHotResult,
  AnimeKernelStatus,
  AnimeLibrarySnapshot,
  AnimeMetadataCandidate,
  AnimePlaySource,
  AnimeRelated,
  AnimeServiceStatus,
  AnimeSourceRules,
  AnimeSourceTestItem,
  AnimeStaff,
  AnimeSubject,
  BtStats,
  BtTask,
  CacheTask,
  CollectionType,
  MediaSourceView,
} from '@anime/types';

/** 服务状态（端口与库根可见；令牌不出 Rust） */
export const animeStatus = () => invoke<AnimeServiceStatus>('anime_status');

/** 手动拉起（首次进番剧时自动调，设置页「重启」也用它） */
export const animeStart = () => invoke<AnimeServiceStatus>('anime_start');

/** 停止（退出/排障） */
export const animeStop = () => invoke<AnimeServiceStatus>('anime_stop');

/** 扫描番剧库（唯一数据入口） */
export const animeLibrary = () => invoke<AnimeLibrarySnapshot>('anime_library');

/** 单部明细 */
export const animeEntry = (name: string) =>
  invoke<{ name: string; dir: string; episodes: { name: string; dir: string; files: number; bytes: number }[] }>(
    'anime_entry',
    { name },
  );

/** 保存条目（新建 / 改元数据） */
export const animeSaveSubject = (subject: AnimeSubject) => invoke<unknown>('anime_save_subject', { subject });

/** 改收藏态 */
export const animeSetCollection = (id: string, collection: CollectionType | null) =>
  invoke<unknown>('anime_set_collection', { id, collection });

/** 保存一集进度 */
export const animeSaveEpisode = (episode: AnimeEpisode) => invoke<unknown>('anime_save_episode', { episode });

/** 载入示例数据（显式动作） */
export const animeSeedDemo = () => invoke<AnimeLibrarySnapshot>('anime_seed_demo');

/** 清空示例（只删 `demo-` 前缀） */
export const animeClearDemo = () => invoke<AnimeLibrarySnapshot>('anime_clear_demo');

/** 路径快照（设置页展示落点） */
export const animePaths = () => invoke<AnimeServiceStatus['paths']>('anime_paths');

/**
 * 一集的播放事实：本地有没有片、走哪条轨、带票的流地址。
 *
 * 地址里的签名由 Rust 侧算好，前端**不碰令牌、不拼签名** —— 令牌一旦进前端就有泄漏面。
 */
export const animePlaySource = (subjectId: string, index: number) =>
  invoke<AnimePlaySource>('anime_play_source', { subjectId, index });

/** 按关键词检索 Bangumi 候选（请求由服务侧发出，前端不直连第三方）；可带年份/季度/标签/排序 */
export const animeMetadataSearch = (
  q: string,
  year?: number | null,
  quarter?: number | null,
  tag?: string | null,
  sort?: string | null,
) =>
  invoke<{ ok: boolean; count: number; candidates: AnimeMetadataCandidate[] }>('anime_metadata_search', {
    q,
    year: year ?? null,
    quarter: quarter ?? null,
    tag: tag ?? null,
    sort: sort ?? null,
  });

/** 把某个候选补进这一部的 manifest；只增不改用户数据 */
export const animeMetadataApply = (dir: string, bgmId: number) =>
  invoke<{ ok: boolean; dir: string; subject: AnimeSubject }>('anime_metadata_apply', { dir, bgmId });

/** 探索页：本周新番时间表（Bangumi `/calendar`，条目是整条 subject） */
export const animeMetadataCalendar = () => invoke<{ ok: boolean; days: AnimeCalendarDay[] }>('anime_metadata_calendar');

/** 探索页：热度推荐（服务侧在 `heat` 不可用时退回排行，`source` 说明来源） */
export const animeMetadataHot = (limit = 12) => invoke<AnimeHotResult>('anime_metadata_hot', { limit });

/** 把 Bangumi 条目建成一条新番剧（只有元数据、没有片源；同一部幂等） */
export const animeMetadataImport = (bgmId: number) =>
  invoke<{ ok: boolean; dir: string; path: string; subject: AnimeSubject }>('anime_metadata_import', { bgmId });

/** 粘贴 Bangumi 链接 / 手输编号 → 建库（解析在服务侧） */
export const animeMetadataImportRef = (input: string) =>
  invoke<{ ok: boolean; dir: string; path: string; subject: AnimeSubject }>('anime_metadata_import_ref', { input });

/** 详情页：角色 + 声优（按 Bangumi id 现取，不落盘） */
export const animeMetadataCharacters = (bgmId: number) =>
  invoke<{ ok: boolean; characters: AnimeCharacter[] }>('anime_metadata_characters', { bgmId });

/** 详情页：制作人员 */
export const animeMetadataStaff = (bgmId: number) =>
  invoke<{ ok: boolean; staff: AnimeStaff[] }>('anime_metadata_staff', { bgmId });

/** 详情页：关联作品 */
export const animeMetadataRelated = (bgmId: number) =>
  invoke<{ ok: boolean; related: AnimeRelated[] }>('anime_metadata_related', { bgmId });

/**
 * 切换番剧库根（设置页「番剧根目录」）；留空 = 回服务端默认落点。
 * 会重启动漫服务，返回新的服务状态。
 */
export const animeSetLibraryRoot = (dir: string) => invoke<AnimeServiceStatus>('anime_set_library_root', { dir });

/** 切换代理（off / system / custom）；同样会重启动漫服务 */
export const animeSetProxy = (mode: string, url: string) =>
  invoke<AnimeServiceStatus>('anime_set_proxy', { mode, url });

/** 媒体源列表（内置本地库 + 用户自建源） */
export const animeSources = () => invoke<{ ok: boolean; root: string; sources: MediaSourceView[] }>('anime_sources');

/** 新增 / 更新一个源（按 id 覆盖；内置源不可改） */
export const animeSaveSource = (source: MediaSourceView) =>
  invoke<{ ok: boolean; source: MediaSourceView }>('anime_save_source', { source });

/** 删除一个源（内置源拒绝） */
export const animeDeleteSource = (id: string) => invoke<{ ok: boolean; id: string }>('anime_delete_source', { id });

/** 把本机一个文件夹复制进番剧库根；之后要重新扫描才会出现在列表 */
export const animeImportFolder = (path: string, subject: string | null) =>
  invoke<{ ok: boolean; subject: string; dir: string; copied: number; skipped: string[] }>('anime_import_folder', {
    path,
    subject,
  });

/** 测试一个数据源：拉前几条看看里面是什么（RSS / 媒体服务器 / 通用网页源已接） */
export const animeTestSource = (
  url: string,
  kind: string,
  limit = 8,
  rules?: AnimeSourceRules,
  cookies?: AnimeCookie[],
) =>
  invoke<{ ok: boolean; kind: string; count: number; items: AnimeSourceTestItem[] }>('anime_test_source', {
    url,
    kind,
    limit,
    rules: rules ?? null,
    cookies: cookies ?? null,
  });

/** 通用网页源：详情页 → 视频直链（拿到直链才能交给播放器）；多清晰度按 preferRes 挑 */
export const animeResolveSource = (url: string, rules: AnimeSourceRules, cookies?: AnimeCookie[], preferRes?: string) =>
  invoke<{ ok: boolean; url: string }>('anime_resolve_source', {
    url,
    rules,
    cookies: cookies ?? null,
    preferRes: preferRes ?? null,
  });

/** BT 端口 / peer 过滤订阅：推给 Rust，下次拉起 animesvc 生效 */
export const animeSetBtOptions = (opts: { port: number | null; peerFilterUrl: string | null }) =>
  invoke<{ ok: boolean }>('anime_set_bt_options', opts);

/** BT 任务列表（librqbit 的 stats 原样映射） */
export const animeBtList = () => invoke<{ ok: boolean; tasks: BtTask[] }>('anime_bt_list');

/** BT 会话状态（端口 / 聚合量 / 任务数） */
export const animeBtStats = () => invoke<BtStats>('anime_bt_stats');

/** 添加磁力 / 种子 */
export const animeBtAdd = (url: string) => invoke<{ ok: boolean; id: number; name?: string }>('anime_bt_add', { url });

/** 暂停 / 继续 / 删除 BT 任务 */
export const animeBtPause = (id: number) => invoke<{ ok: boolean }>('anime_bt_pause', { id });
export const animeBtResume = (id: number) => invoke<{ ok: boolean }>('anime_bt_resume', { id });
export const animeBtDelete = (id: number, deleteFiles: boolean) =>
  invoke<{ ok: boolean }>('anime_bt_delete', { id, deleteFiles });

/** 账号状态（登录态 / 队列 / 中继地址） */
export const animeAccount = () =>
  invoke<{
    loggedIn: boolean;
    user: { id?: string; email?: string; name?: string };
    lastSyncAt?: number;
    cloudCount?: number;
    relayBase: string;
    queue: AccountQueueItem[];
  }>('anime_account');

/** 邮箱密码登录 */
export const animeAccountLogin = (email: string, password: string) =>
  invoke<{ ok: boolean; user: { email?: string; name?: string } }>('anime_account_login', { email, password });

/** 设备码 / 扫码：开始（拿 deviceCode 与轮询间隔） */
export const animeAccountDeviceStart = (kind: 'oauth' | 'qr') =>
  invoke<{ deviceCode: string; userCode: string; verifyUrl: string; interval: number; expiresIn: number }>(
    'anime_account_device_start',
    { kind },
  );

/** 设备码 / 扫码：轮询一次 */
export const animeAccountDevicePoll = (deviceCode: string) =>
  invoke<{ status: 'pending' | 'ok' | 'expired'; token?: string; user?: { email?: string; name?: string } }>(
    'anime_account_device_poll',
    { deviceCode },
  );

/** 桩专用：模拟另一端确认 */
export const animeAccountDeviceApprove = (deviceCode: string) =>
  invoke<{ ok: boolean }>('anime_account_device_approve', { deviceCode });

/** 退出登录 */
export const animeAccountLogout = () => invoke<{ ok: boolean }>('anime_account_logout');

/** 入队一条待同步条目 */
export const animeAccountEnqueue = (item: AccountQueueItem) =>
  invoke<{ ok: boolean }>('anime_account_enqueue', { item });

/** 同步一次（推队列 → 冲突按策略处理 → 拉云端） */
export const animeAccountSync = (policy: string) => invoke<AccountSyncResult>('anime_account_sync', { policy });

/** 缓存任务列表（进度以盘上为准） */
export const animeCache = () => invoke<{ ok: boolean; tasks: CacheTask[] }>('anime_cache');

/** 新建缓存任务：cacheDir / limitGb 来自设置（改目录 → 新任务落新目录） */
export const animeCacheAdd = (payload: {
  subjectId: string;
  episodeIndex: number;
  title: string;
  url: string;
  sizeBytes?: number;
  cacheDir?: string;
  limitGb?: number;
}) => invoke<{ ok: boolean; id: string }>('anime_cache_add', { payload });

/** 暂停缓存任务 */
export const animeCachePause = (id: string) => invoke<{ ok: boolean; id: string }>('anime_cache_pause', { id });

/** 继续缓存任务（Range 续传） */
export const animeCacheResume = (id: string) => invoke<{ ok: boolean; id: string }>('anime_cache_resume', { id });

/** 删除缓存任务（连同盘上文件） */
export const animeCacheDelete = (id: string) => invoke<{ ok: boolean; id: string }>('anime_cache_delete', { id });

/** 从订阅地址拉一份规则草稿（服务侧解析并校验，不落盘） */
export const animeSubscribeSource = (url: string) =>
  invoke<{ ok: boolean; draft: { name: string; kind: string; url: string; rules: AnimeSourceRules } }>(
    'anime_subscribe_source',
    { url },
  );

/** 打开「过验证码」窗口（内嵌网页，用户手动完成验证） */
export const animeOpenChallenge = (url: string) =>
  invoke<{ ok: boolean; reused: boolean }>('anime_open_challenge', { url });

/** 读出验证码窗口里该地址的会话 cookie（随后随抓取请求带上） */
export const animeChallengeCookies = (url: string) =>
  invoke<{ ok: boolean; cookies: AnimeCookie[] }>('anime_challenge_cookies', { url });

/**
 * 远程播放事实：媒体服务器（Jellyfin / Emby）的某一集。
 *
 * 返回的 `url` 指向本机服务侧中继（带票），**不是上游地址** ——
 * 上游的 `api_key` 只走服务侧请求头，不进 URL。
 */
export const animePlayRemote = (sourceId: string, itemId: string) =>
  invoke<{ ok: boolean; kind: string; url: string; expiresAt: number }>('anime_play_remote', {
    sourceId,
    itemId,
  });

// ---------------------------------------------------------------- 内核轨（libmpv 替身）

/** 内核状态：可不可用 + 当前会话快照（音轨 / 字幕 / 进度 / 缓冲） */
export const animeKernelStatus = () => invoke<AnimeKernelStatus>('anime_kernel_status');

/**
 * 用内核打开一集（画面在 mpv 自己的窗口里）。
 *
 * `hwdec` 由设置页「强制硬件解码」决定；服务侧解析文件路径，前端不拼磁盘路径。
 */
export const animeKernelOpen = (subjectId: string, index: number, hwdec?: string) =>
  invoke<{ ok: boolean; external: boolean; session: AnimeKernelStatus['session'] }>('anime_kernel_open', {
    subjectId,
    index,
    hwdec: hwdec ?? null,
  });

/** 驱动内核：`play` / `pause` / `seek` / `rate` / `track` / `subtitle` / `volume` / `fullscreen` / `screenshot` */
export const animeKernelCtl = (action: string, value?: unknown) =>
  invoke<{ ok: boolean; file?: string; session: AnimeKernelStatus['session'] }>('anime_kernel_ctl', {
    action,
    value: value ?? null,
  });

/** 关掉内核会话（离开播放器 / 换集时调） */
export const animeKernelClose = () => invoke<AnimeKernelStatus>('anime_kernel_close');
