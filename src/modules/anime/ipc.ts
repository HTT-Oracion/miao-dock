/**
 * 番剧模块 IPC 层 —— 封装 Rust `anime/` 桥接命令（`anime_*` 前缀）。
 *
 * 数据链路：前端 → Tauri 命令（`src-tauri/src/anime/mod.rs`）→ 本地 `animesvc` HTTP。
 * 前端**不直连第三方站点、不直接读盘**：扫描、manifest、收藏、进度全在服务侧，
 * CLI / e2e / 桌面端跑的是同一套实现。
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  AnimeEpisode,
  AnimeKernelStatus,
  AnimeLibrarySnapshot,
  AnimeMetadataCandidate,
  AnimePlaySource,
  AnimeServiceStatus,
  AnimeSourceTestItem,
  AnimeSubject,
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

/** 按关键词检索 Bangumi 候选（请求由服务侧发出，前端不直连第三方） */
export const animeMetadataSearch = (q: string) =>
  invoke<{ ok: boolean; count: number; candidates: AnimeMetadataCandidate[] }>('anime_metadata_search', { q });

/** 把某个候选补进这一部的 manifest；只增不改用户数据 */
export const animeMetadataApply = (dir: string, bgmId: number) =>
  invoke<{ ok: boolean; dir: string; subject: AnimeSubject }>('anime_metadata_apply', { dir, bgmId });

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

/** 测试一个数据源：拉前几条看看里面是什么（RSS 已接，其余明确回未接入） */
export const animeTestSource = (url: string, kind: string, limit = 8) =>
  invoke<{ ok: boolean; kind: string; count: number; items: AnimeSourceTestItem[] }>('anime_test_source', {
    url,
    kind,
    limit,
  });

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
