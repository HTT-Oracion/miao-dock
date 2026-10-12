// 音乐模块的**持久化收口**：localStorage 读写 · 启动恢复快照 · 偏好合并写入的底座。
//
// 为什么从 `store.ts` 抽出来（D-153）：审计 §3.3 指出 store 混了四层职责
// （纯函数 / 持久化 / 网络 / 播放状态机）。纯函数已由 D-149 下沉 `tools/lyrics.ts`；
// 这里把**持久化**那层单独成件 —— 它只跟 localStorage 与"存进去的形状"打交道，
// 与播放状态机无耦合。
import type { MusicProvider } from '@music/platform';
import type { Song } from '@music/types';

// ------------------------------------------------------------------ 持久化小工具

export function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeLS(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 配额满 / 隐私模式：持久化失败不影响本次会话
  }
}

// ------------------------------------------------------------------ 启动恢复快照

const LS_SNAPSHOT = 'miaodock.music.resumeSnapshot';

/**
 * 快照的版本号。**结构一变就必须 +1**。
 *
 * 为什么需要它：localStorage 是**外部可改且跨版本存活**的边界 ——
 * 老版本存下的结构会被新版本读到。不带版本号的话，恢复流程会拿着
 * 缺字段 / 字段名已改的对象继续跑，故障表现为"恢复了但队列是空的"
 * 或"恢复出上次的幽灵歌曲"，且不报错。判版本不匹配就直接当"没有快照"，
 * 行为退化成与现在一致（不显示播放条）—— 这是最安全的降级。
 */
export const SNAPSHOT_VERSION = 1;

/** 队列持久化上限（Q3 拍板：200 首）。 */
const SNAPSHOT_MAX_QUEUE = 200;

/**
 * 兜底存快照的间隔（毫秒）。
 * 理由见 MusicKernel 里那个定时器的注释；导出成常量是为了让"节奏"可被断言盯住，
 * 而不是散落成一个裸数字。
 */
export const SNAPSHOT_PERSIST_INTERVAL_MS = 30_000;

/**
 * 启动恢复用的播放快照。
 *
 * ## 为什么存**完整** Song 而不是一个 id
 * 恢复时要重新解析播放地址，而各平台解析 URL 依赖的字段各不相同且很偏：
 * 酷狗要 `hash`、QQ 要 `qq_song_id`、咪咕要 `content_id`、网易云要 `mid`。
 * 只存 `{provider, id}` 就得再写一套"按 id 回查全字段"的接口（现在没有），
 * 而漏掉任何一个字段都会变成"恢复出来播不了"。裁字段省下的那点体积
 * 远不值得换一个"静默不可播"的故障面。
 */
export interface ResumeSnapshot {
  /** 结构版本，见 SNAPSHOT_VERSION */
  v: number;
  /** 上次退出时**正在播放的平台**（恢复时只校验这一个平台的登录态） */
  provider: MusicProvider;
  /** 队列（已按 SNAPSHOT_MAX_QUEUE 截断） */
  queue: Song[];
  /** 当前歌曲在 queue 里的下标（截断后**重新计算**，不是原值） */
  index: number;
  /** 播放位置（毫秒） */
  progressMs: number;
  /** 保存时刻（毫秒时间戳），仅供排查 */
  savedAt: number;
}

/**
 * 队列过长时按窗口截断，**且保证当前歌曲仍在窗口内**。
 *
 * ## 为什么不能简单取前 N 首
 * 那样会把"当前正在听的那首"截掉，恢复后停在一首完全不同的歌上 ——
 * 而用户看到的播放条里正是那首歌（它来自 currentSong），点播放才会跳走。
 * 以当前歌为中心开窗口，把新下标一并返回，是唯一自洽的做法。
 */
export function truncateQueueForSnapshot(
  queue: Song[],
  index: number,
  max = SNAPSHOT_MAX_QUEUE,
): { queue: Song[]; index: number } {
  if (queue.length <= max) return { queue, index };
  const half = Math.floor(max / 2);
  // start 要同时满足：① 0 ≤ start ② start ≤ index ③ start + max ≤ queue.length
  const start = Math.max(0, Math.min(index - half, queue.length - max));
  return { queue: queue.slice(start, start + max), index: index - start };
}

/** 从 localStorage 读快照；**任何**不符（缺 key / 版本不符 / 结构不对）都当"没有" */
export function readResumeSnapshot(): ResumeSnapshot | null {
  const raw = readLS<unknown>(LS_SNAPSHOT, null);
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<ResumeSnapshot>;
  if (s.v !== SNAPSHOT_VERSION) return null;
  if (typeof s.provider !== 'string') return null;
  if (!Array.isArray(s.queue) || s.queue.length === 0) return null;
  // index 越界说明快照与队列不自洽（例如被手改过）——同样当"没有"，不做强行夹紧
  if (typeof s.index !== 'number' || s.index < 0 || s.index >= s.queue.length) return null;
  return {
    v: s.v,
    provider: s.provider as MusicProvider,
    queue: s.queue,
    index: s.index,
    progressMs: typeof s.progressMs === 'number' && s.progressMs > 0 ? s.progressMs : 0,
    savedAt: typeof s.savedAt === 'number' ? s.savedAt : 0,
  };
}

export function writeResumeSnapshot(s: ResumeSnapshot): void {
  writeLS(LS_SNAPSHOT, s);
}

export function clearResumeSnapshot(): void {
  try {
    localStorage.removeItem(LS_SNAPSHOT);
  } catch {
    /* 隐私模式下删不掉：读侧会因版本/结构不符而自行失效 */
  }
}

/** 读取历史时剔除带 base64 data URL 封面的条目，避免历史把存储撑爆 */
export function sanitizeForStorage(song: Song): Song {
  return song.cover && song.cover.startsWith('data:') ? { ...song, cover: '' } : song;
}

