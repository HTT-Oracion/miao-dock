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
  AnimeLibrarySnapshot,
  AnimeMetadataCandidate,
  AnimePlaySource,
  AnimeServiceStatus,
  AnimeSubject,
  CollectionType,
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
