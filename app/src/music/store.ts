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

/**
 * 逐字歌词里的一个词（yrc / qrc 词级数据）。
 *
 * ⚠️ 口径统一用**秒**（与 `ParsedLyricLine.time` 一致）——本项目踩过
 * `ParsedLyricLine` 字段「一处秒一处毫秒」的坑，逐字数据不能再引入第三种口径。
 */
export interface LyricWord {
  /** 该词起始时间（秒） */
  t: number;
  /** 该词持续时长（秒），下限 0.06s（见 parseYrc） */
  d: number;
  /** 该词首个字符在所在行 `text` 中的下标（含） */
  c0: number;
  /** 该词末尾字符在所在行 `text` 中的下标（不含） */
  c1: number;
}

/**
 * 解析后的歌词行。
 *
 * `duration` / `words` / `hasKaraoke` 是逐字高亮引入的**可选扩展** ——
 * 必填的只有 `time` + `text`，所以既有的 `lyricIndexAt`（只读 time）与
 * `pushLyricsState`（只读 time/text）无需改动即继续工作，向后兼容。
 *
 * `duration` 的单位是**秒**，且**总是有值**：parseLrc / parseYrc 收尾都会走
 * `finalizeLineDurations` 补一个由相邻行时间差推断的值 —— 这是「无 yrc 也能逐字推进」
 * 的前提（没有它，没有逐字数据的歌就退化成"整行高亮、毫无推进感"）。
 */
/**
 * 灵动岛展开态的视图：`play` = 播放卡（歌手/进度/传输控件）、`lyrics` = 歌词卡。
 *
 * 为什么要**持久化**（而不是组件内的 useState）：hover 展开是"临时看一眼"的动作，
 * 用户一旦切到歌词卡，下次展开还该是歌词卡 —— 不记住就等于每次都要再点一次切换键。
 */
export type IslandView = 'play' | 'lyrics';

export interface ParsedLyricLine {
  time: number;
  text: string;
  /** 本行持续秒数（无逐字数据时用它做行级插值）；由 finalizeLineDurations 保证 > 0 */
  duration?: number;
  /** 逐字数据；仅 yrc/qrc 有。空/缺省 = 无逐字数据，退回行级插值 */
  words?: LyricWord[];
  /** 是否含逐字数据（等价于 words 非空；显式写出便于渲染层直接判定，不必二次求长度） */
  hasKaraoke?: boolean;
  /** 本行的翻译（外语歌的译文；`loadLyrics` 合并 `Lyrics.translation` 时按时间匹配填上，无翻译的歌缺省） */
  translation?: string;
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
  // ⚠️ LRC **只有行级时间**，没有逐字数据 —— 必须在这里补出行持续时长，
  // 否则「无 yrc 的歌」在渲染层没有可插值的跨度，逐字推进会整体失效。
  return finalizeLineDurations(lines);
}

/**
 * 排序 + 补齐每行 duration + 夹紧到合理区间。
 *
 * ## 为什么必须补 duration（本任务最容易漏、后果最隐蔽的一步）
 * 平台返回的逐字歌词（yrc）是少数派，**绝大多数歌只有行级 LRC 时间戳**。
 * 若 duration 缺失/为 0，渲染层的行级插值就拿不到跨度，只能整行一次点亮 ——
 * 用户看到的效果与「没有逐字高亮」完全一样，而所有断言却都可能全绿
 *（因为代码"看起来"实现了插值）。所以这一函数是「退化路径」的真正支点。
 *
 * 推断规则（参考实现的 finalizeLineDurations）：
 *   · 有下一行且时间更大 → 用「下一行起点 − 本行起点」当作本行时长（最贴近实际唱速）；
 *   · 末行 / 时间并列 → 回落到 4.8s（一个不刺眼的经验值，避免末行瞬间填满）。
 * 夹紧 `[0.45, 12]`：
 *   · 下限 0.45s：太短会让逐字推进"一闪而过"，看不清；
 *   · 上限 12s：太长（常见于末尾长间奏、或两行间隔过大）会让"未唱"部分像卡住。
 * 已是正数的 duration（yrc 自带）**保留原值**，只做夹紧 —— 逐字数据比行距推断更可信。
 */
function finalizeLineDurations(lines: ParsedLyricLine[]): ParsedLyricLine[] {
  lines.sort((a, b) => a.time - b.time);
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    const inferred = next && next.time > lines[i].time ? next.time - lines[i].time : 4.8;
    if (!Number.isFinite(lines[i].duration) || (lines[i].duration ?? 0) <= 0) {
      lines[i].duration = inferred;
    }
    lines[i].duration = Math.max(0.45, Math.min(12, lines[i].duration as number));
  }
  return lines;
}

/**
 * 解析 YRC 逐字歌词。
 *
 * 格式：`[lineStartMs,lineDurMs](wordStartMs,wordDurMs,0)word(wordStartMs,wordDurMs,0)word...`
 *
 * ## 绝对 / 相对时间戳的判定（参考实现同款）
 * 各平台 yrc 的 word 时间戳口径不统一：网易云是**绝对毫秒**，另有平台给的是
 * **相对行头的偏移**。判据：`rawStart >= lineStartMs - 500` 视为绝对，否则视为相对
 *（加上行头）。500ms 的容差用来吸收平台间的毫秒级抖动 —— 相对偏移不可能接近行头
 * 那么大的数值，而绝对时间戳也不会比行头小 500ms 以上（词总在行内）。
 *
 * 产出的行同样走 `finalizeLineDurations`：yrc 自带行时长时保留，仅夹紧；
 * 缺失时才用行距推断 —— 两条路径共用同一个收尾，行为一致。
 */
export function parseYrc(yrc: string): ParsedLyricLine[] {
  if (!yrc || !yrc.trim()) return [];

  const lines: ParsedLyricLine[] = [];

  for (const rawLine of yrc.split(/\r?\n/)) {
    // 行头：[startMs,durMs]
    const lineMatch = rawLine.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!lineMatch) continue;

    const lineStartMs = parseInt(lineMatch[1], 10) || 0;
    const lineDurMs = parseInt(lineMatch[2], 10) || 0;
    const body = lineMatch[3] || '';

    // 逐词：(startMs,durMs,0)text
    const wordRegex = /\((\d+),(\d+),\d+\)([^()]*)/g;
    const words: LyricWord[] = [];
    let fullText = '';
    let wm: RegExpExecArray | null;

    while ((wm = wordRegex.exec(body)) !== null) {
      const txt = (wm[3] || '').replace(/\s+/g, ' ');
      if (!txt) continue;

      const rawStart = parseInt(wm[1], 10) || 0;
      const rawDur = parseInt(wm[2], 10) || 0;
      // 绝对 / 相对判定，见函数头注释
      const absStartMs = rawStart >= lineStartMs - 500 ? rawStart : lineStartMs + rawStart;

      const c0 = fullText.length;
      fullText += txt;
      words.push({
        t: absStartMs / 1000,
        // 下限 0.06s：个别平台会给 0 时长词，直接除会得到除零/瞬时跳帧
        d: Math.max(0.06, rawDur / 1000),
        c0,
        c1: fullText.length,
      });
    }

    // 没匹配到词（纯文本行）时，清掉残留的时间标记再取文本
    if (!fullText) {
      fullText = body.replace(/\(\d+,\d+,\d+\)/g, '').replace(/\s+/g, ' ');
    }

    // 逐词拼接可能带来首尾空白；词的字符下标要按**清理后的文本**重新校正，
    // 否则 c0/c1 会整体偏移，高亮落在错误的字上。
    const leading = (fullText.match(/^\s+/) || [''])[0].length;
    fullText = fullText.replace(/\s+/g, ' ').trim();
    if (!fullText) continue;

    let validWords: LyricWord[] | undefined;
    if (words.length) {
      for (const w of words) {
        w.c0 = Math.max(0, Math.min(fullText.length, w.c0 - leading));
        w.c1 = Math.max(w.c0, Math.min(fullText.length, w.c1 - leading));
      }
      const kept = words.filter((w) => w.c1 > w.c0);
      if (kept.length) validWords = kept;
    }

    lines.push({
      time: lineStartMs / 1000,
      text: fullText,
      duration: lineDurMs / 1000,
      words: validWords,
      hasKaraoke: !!validWords,
    });
  }

  return finalizeLineDurations(lines);
}

/**
 * 把翻译 LRC 合并进解析后的歌词行（按时间精确匹配 + 0.5s 容差模糊匹配）。
 *
 * 参考实现 `buildKaraokeLines` 的合并逻辑：翻译 LRC 先解析成 `Map<时间,文本>`，
 * 再对每行按时间匹配。为什么不能按 index 对齐 —— 翻译通常把重复句（副歌）合并成一行，
 * 行数与原文不一致，按 index 会整体错位。0.5s 容差吸收平台间毫秒级抖动。
 */
function mergeTranslation(lines: ParsedLyricLine[], translationLrc: string): void {
  if (!translationLrc || !translationLrc.trim()) return;
  const transMap = new Map<number, string>();
  for (const line of translationLrc.split('\n')) {
    const m = line.match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/);
    if (!m) continue;
    const time = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3].padEnd(3, '0')) / 1000 : 0);
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    if (text) transMap.set(time, text);
  }
  if (transMap.size === 0) return;
  for (const line of lines) {
    if (transMap.has(line.time)) {
      line.translation = transMap.get(line.time);
      continue;
    }
    let best: string | undefined;
    let bestDiff = Infinity;
    for (const [t, txt] of transMap) {
      const diff = Math.abs(t - line.time);
      if (diff < bestDiff && diff < 0.5) {
        bestDiff = diff;
        best = txt;
      }
    }
    if (best) line.translation = best;
  }
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
const SNAPSHOT_VERSION = 1;

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

/**
 * 合并式写入偏好：每项只改自己那个键。
 * 为什么用合并而不是整份覆盖 —— 各项分别由不同的 setter 写入，整份覆盖会把
 * 「同时改两项」编排成互相覆盖（后写的赢），是一个只在特定操作序列下复现的 bug。
 */
function savePrefs(patch: Partial<Prefs>): void {
  writeLS(LS_PREFS, { ...readLS<Partial<Prefs>>(LS_PREFS, {}), ...patch });
}

/** 取整并夹到 [min, max]。用于把外部存进来的数值偏好收进合法区间（见 hydratePrefs） */
function clampInRange(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)));
}

/**
 * 把 store 状态里的桌面歌词偏好拼成推送形状。
 *
 * 单独抽出来是为了让"字段名映射"只有一处：`pushLyricsState`（完整推送）与
 * `pushLyricsPrefs`（轻量推送）都要用它，两处各拼一遍迟早会出现"一条通道多带一个
 * 字段、另一条忘了"的不一致，而症状是**外观偶尔回退**，很难联想到这里。
 */
function dlPrefsOf(s: {
  desktopLyricsFontSize: number;
  desktopLyricsHighlightColor: string;
  desktopLyricsBaseColor: string;
  desktopLyricsLineCount: number;
}): ipc.DesktopLyricsPrefs {
  return {
    fontSize: s.desktopLyricsFontSize,
    highlightColor: s.desktopLyricsHighlightColor,
    baseColor: s.desktopLyricsBaseColor,
    lineCount: s.desktopLyricsLineCount,
  };
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
  /**
   * 上次使用的播放平台。
   *
   * ⚠️ 这一项**以前根本没持久化**（store 初始值硬编码 `'netease'`），
   * 于是重启后播放平台恒为网易云，即使用户上次用的是 QQ —— 而
   * 「启动恢复上次播放」要求"按**上次那个**平台校验登录态"，
   * 连"上次是哪个平台"都不知道。补上这一项是该功能的必要前提。
   */
  playbackSource: MusicProvider;
  playbackQuality: PlaybackQuality;
  volume: number;
  playMode: PlayMode;
  skin: PlayerSkin;
  /** 展开播放器歌词字号（px） */
  lyricsFontSize: number;
  /** 展开播放器歌词高亮色 */
  lyricsHighlightColor: string;
  /** 歌词高亮方式：word 逐字 / line 整行一次性点亮 */
  lyricsMode: LyricsMode;
  /**
   * 桌面歌词的**独立**偏好 —— 与上面两条分开存、分开调。
   *
   * 为什么必须独立（不是"多一个字段好看"）：展开播放器可以铺满整屏、桌面歌词窗
   * 只有 160px 高。共用一个 `lyricsFontSize` 时，用户为详情页调到 48 会把桌面歌词
   * 撑成两行巨字 —— 这是真实回归，不是假想。参考实现也是两套字段。
   */
  desktopLyricsFontSize: number;
  desktopLyricsHighlightColor: string;
  desktopLyricsBaseColor: string;
  desktopLyricsLineCount: number;
  /** 动态背景：modern/immersive 皮肤的渐变缓慢流动 */
  dynamicEnabled: boolean;
  /** 碟片模式：展开播放器的封面变成旋转唱片 */
  discMode: boolean;
  /** 透明彩胶配色：auto=跟随封面主色 / custom=固定色 */
  vinylColorMode: 'auto' | 'custom';
  vinylCustomColor: string;
  /**
   * 灵动岛展开后进哪个视图（播放卡 / 歌词卡）。
   *
   * ⚠️ 这是**唯一一次**为灵动岛新增的偏好：歌词字号/高亮色一律**不新增** ——
   * 高亮色复用 `lyricsHighlightColor`（用户选的颜色应当三处一致），字号用卡片自己的
   * 固定值（设置页那条 17–48 的量程给 320px 宽的卡片用会一行放不下几个字）。
   */
  islandView: IslandView;
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

/** 把 provider 的登录信息写进 loginInfos，并按需同步当前 loginInfo */
function mergeLogin(state: MusicState, provider: MusicProvider, info: LoginInfo | null) {
  return {
    loginInfos: { ...state.loginInfos, [provider]: info },
    loginInfo: state.playbackSource === provider ? info : state.loginInfo,
  };
}

/**
 * 登录态的**三态**判定（不是布尔）。
 *
 * ## 为什么必须分三态
 * 「明确未登录」与「探测失败」必须区别对待：断网时四个平台全都探不动，
 * 若一律当成"未登录"就清掉用户的播放快照，**用户一断网就丢播放进度**。
 *
 * ## 三态怎么从 `loginInfos` 里读出来
 * 这个区分是 Rust 侧刻意对齐出来的（见 `music_get_login_statuses` 的文档注释）：
 *   · `loginInfos[p] === null` —— 批量探测时该平台**探测失败**（网络/服务未就绪）。
 *     Rust 只在 `Some(info)` 时才 insert key，而 `.ok()` 把探测的 `Err` 吞成了 `None`。
 *   · `loginInfos[p]?.logged_in === false` —— **明确未登录**。
 *     cookie 为空或没有登录标记时，Rust 返回 `Ok(LoginInfo{logged_in:false})`。
 *   · `loginInfos[p]?.logged_in === true` —— 有效。
 *
 * ⚠️ 既有 13 处读取点全是 `loginInfos[p]?.logged_in`（布尔判据，**一个字都不该动**）；
 * 三态只在本函数与「启动恢复」流程里使用。两者并存是有意的：UI 只关心"能不能播"，
 * 而恢复流程要关心"是不是真的登出了"。
 */
export type LoginVerdict = 'valid' | 'logged_out' | 'probe_failed';

export function loginVerdict(infos: Record<MusicProvider, LoginInfo | null>, p: MusicProvider): LoginVerdict {
  const info = infos?.[p];
  if (info === null || info === undefined) return 'probe_failed';
  return info.logged_in ? 'valid' : 'logged_out';
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

/** 收起播放器的退场定时器。留着它才能在"退场途中又被点开"时取消关闭（见 setExpanded） */
let closeExpandedTimer: ReturnType<typeof setTimeout> | null = null;

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

export const useMusicStore = create<MusicState>((set, get) => ({
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

  // ================================================================ init

  hydratePrefs: () => {
    const prefs = readLS<Partial<Prefs>>(LS_PREFS, {});
    const volume = typeof prefs.volume === 'number' ? prefs.volume : 0.8;
    const playMode: PlayMode = prefs.playMode ?? 'list';
    const skin: PlayerSkin = prefs.skin ?? 'modern';
    const playbackQuality: PlaybackQuality = prefs.playbackQuality ?? 'hires';
    const lyricsFontSize =
      typeof prefs.lyricsFontSize === 'number' ? prefs.lyricsFontSize : LYRICS_SIZE.def;
    /*
     * 桌面歌词的两项数值偏好在这里夹到常量区间内。
     *
     * localStorage 是**外部可改的边界**（用户手改、旧版本残留、日后收紧量程后的老值），
     * 越界值会让设置页的滑杆与桌面歌词窗显示成两个数 —— 歌词窗那边本来就会夹
     * （见其 normalizePrefs），这里不夹就等于"两个窗口各说各话"。
     */
    const dlFontSize =
      typeof prefs.desktopLyricsFontSize === 'number' ? prefs.desktopLyricsFontSize : DL_LYRICS_SIZE.def;
    const dlLineCount =
      typeof prefs.desktopLyricsLineCount === 'number' ? prefs.desktopLyricsLineCount : DL_LINE_COUNT.def;
    /*
     * 灵动岛视图：只认两个字面量，其余一律回落 'play'。
     * 为什么不能写 `prefs.islandView ?? 'play'` —— localStorage 是外部可改的边界
     * （旧版本残留、手改、日后改名），`'xxx'` 这类脏值会被原样读进内存，
     * 于是卡片按歌词态渲染却拿到空分支。枚举型偏好一律白名单收口。
     */
    const islandView: IslandView = prefs.islandView === 'lyrics' ? 'lyrics' : 'play';
    // 歌词高亮方式：同 islandView，枚举型偏好白名单收口，脏值一律回落 LYRICS_MODE_DEF
    // ⚠️ 这里刻意**不**因为默认值改动而迁移老偏好：用户在设置页显式选过的值就是他的选择，
    //   替他改回去等于产品替他做决定。只有"从没选过"（键缺失）的人才拿到新默认（D-137：'line'）。
    const lyricsMode: LyricsMode = prefs.lyricsMode === 'word' ? 'word' : LYRICS_MODE_DEF;
    /*
     * 播放平台：同样白名单收口。
     * 脏值（手改 / 旧版本残留 / 日后新增平台后被删）一律回落 'netease' ——
     * 平台 id 是**四处**的键（后端命令派发、登录态表、快照校验、URL 解析），
     * 放过一个不认识的 id 会让恢复流程按它去查登录态，拿到必然是
     * 「探测失败」，于是每次都判成断网、永远不恢复。
     */
    const ALL_PROVIDERS: readonly MusicProvider[] = ['netease', 'kugou', 'qqmusic', 'migu'];
    const playbackSource: MusicProvider = ALL_PROVIDERS.includes(prefs.playbackSource as MusicProvider)
      ? (prefs.playbackSource as MusicProvider)
      : 'netease';
    set({
      playbackSource,
      volume,
      playMode,
      skin,
      playbackQuality,
      lyricsFontSize,
      lyricsHighlightColor: prefs.lyricsHighlightColor ?? LYRICS_COLOR_DEF,
      lyricsMode,
      desktopLyricsFontSize: clampInRange(dlFontSize, DL_LYRICS_SIZE.min, DL_LYRICS_SIZE.max),
      desktopLyricsHighlightColor: prefs.desktopLyricsHighlightColor ?? DL_HIGHLIGHT_COLOR_DEF,
      desktopLyricsBaseColor: prefs.desktopLyricsBaseColor ?? DL_BASE_COLOR_DEF,
      desktopLyricsLineCount: clampInRange(dlLineCount, DL_LINE_COUNT.min, DL_LINE_COUNT.max),
      dynamicEnabled: prefs.dynamicEnabled === true,
      discMode: prefs.discMode === true,
      vinylColorMode: prefs.vinylColorMode === 'custom' ? 'custom' : 'auto',
      vinylCustomColor: prefs.vinylCustomColor ?? VINYL_COLOR_DEF,
      islandView,
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

  /**
   * 启动恢复上次播放（Q6：本次会话只跑一次）。
   *
   * ## 为什么不挂在 `init` 里
   * `init` 挂在音乐屏且**没有防重入守卫** —— 切走再切回会重跑。恢复挂在它里面
   * 就会变成"每次进屏都恢复一次"，并覆盖用户刚做的操作。所以它有独立的闸。
   *
   * ## 判据链（顺序不能换）
   *   1. 闸 + 快照：没快照 → 直接返回，**与现在行为完全一致**（不显示播放条）
   *   2. 探一次目标平台的登录态 —— 必须**自己探**：`loginInfos` 初值全是 `null`，
   *      分不清"没探过"与"探过但失败"，不能靠"看现成的"来判断
   *   3. Q1 三态分流：
   *        明确未登录 → **清快照**（用户的登录都没了，恢复出来也是播不了）
   *        探针失败   → **保留快照、本次不恢复**，并把闸退回 false 允许下次重试
   *        有效       → 恢复
   *   4. 恢复：装载队列 + 停在**暂停态** + 定位到快照里的进度（Q2）
   */
  restoreSession: async () => {
    if (get().restoreAttempted) return;
    set({ restoreAttempted: true });

    const snap = readResumeSnapshot();
    if (!snap) return;

    // 队列/下标已在 readResumeSnapshot 里做过结构校验，这里仍要防一手：
    // 快照是外部可改的边界，不假设"读出来就一定自洽"
    const song = snap.queue[snap.index];
    if (!song) {
      clearResumeSnapshot();
      return;
    }

    await get().loadLoginStatus(snap.provider);
    const verdict = loginVerdict(get().loginInfos, snap.provider);
    if (verdict === 'logged_out') {
      // Q1①：明确未登录 → 清掉快照，下次不再尝试
      clearResumeSnapshot();
      return;
    }
    if (verdict === 'probe_failed') {
      // Q1②：探不动（断网 / 服务未就绪）**不等于**登出。保留快照，把闸退回，
      // 用户下次进屏、网络也好了，会自然恢复。静默——「没恢复」的表现与现在一致，
      // 不该弹任何提示。
      set({ restoreAttempted: false });
      return;
    }

    // Q1③：有效 → 恢复。restoring 打开失败切歌通道，并让静默失败继续走
    set({ restoring: true });
    await get().playSong(song, snap.queue, {
      autoplay: false,
      expand: false,
      resumeAtMs: snap.progressMs,
    });
  },

  finishRestore: () => {
    // 已经离开恢复态就别覆盖（比如用户在恢复过程中自己点了别的歌）
    if (get().restoring) set({ restoring: false });
  },

  handleRestoreFailed: () => {
    if (!get().restoring) return;
    const { queue, currentIndex } = get();
    // 下一首还有 → 继续试。**带上 autoplay:true**：Q4 拍板「切到第一首能播的就
    // 自动播放」—— 恢复的头一首保持暂停（那是需求要的），一旦因为它失败而换了歌，
    // 就已经进入"找一首能播的"这条路了，此时静默自动播才对。
    if (currentIndex + 1 < queue.length) {
      const nextSong = queue[currentIndex + 1];
      void get().playSong(nextSong, queue, { autoplay: true, expand: false });
      return;
    }
    // 整条队列都试过了 → 这次恢复失败：清空（clearQueue 内会清快照）
    get().clearQueue();
    set({ restoring: false });
  },

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

  // ================================================================ 队列

  appendToQueue: (songs) => {
    const { queue } = get();
    const ids = new Set(queue.map(songKey));
    const unique = songs.filter((s) => !ids.has(songKey(s)));
    if (unique.length === 0) return;
    const remaining = MAX_PLAY_QUEUE - queue.length;
    set({ queue: [...queue, ...unique.slice(0, Math.max(0, remaining))] });
  },

  playNext: (song) => {
    const { queue, currentSong } = get();
    const key = songKey(song);

    // 边界 ①：这首歌**就是正在播的那首**。
    // 不能按常规流程"摘掉再插" —— 摘掉会把当前项从队列里删掉，于是 `currentSong` 在播、
    // 队列里却找不到它（自相矛盾，且 `removeFromQueue` 那类逻辑会开始出错）。
    if (currentSong && songKey(currentSong) === key) {
      get().toast('这首歌正在播放');
      return;
    }

    // 边界 ②：这首歌**已在队列里** → 先摘掉再插，否则队列里会出现两份。
    // 注意这一步会让当前歌之后的所有项前移一位，所以**不能**用 `currentIndex + 1` 推插入点。
    const without = queue.filter((s) => songKey(s) !== key);
    const at = currentSong ? without.findIndex((s) => songKey(s) === songKey(currentSong)) : -1;
    const insertAt = at >= 0 ? at + 1 : 0;
    const next = [...without.slice(0, insertAt), song, ...without.slice(insertAt)];
    set({ queue: next });
    // 同理，currentIndex 也必须**按当前歌重新定位**，不能沿用旧值（那是位置漂移的来源）
    if (currentSong) {
      const idx = next.findIndex((s) => songKey(s) === songKey(currentSong));
      if (idx >= 0) set({ currentIndex: idx });
    }
    get().toast('已添加到下一首播放');
  },

  removeFromQueue: (index) => {
    const { queue, currentSong, currentIndex } = get();
    if (index < 0 || index >= queue.length) return;
    const removedCurrent = index === currentIndex;
    const nextQ = queue.filter((_, i) => i !== index);
    if (nextQ.length === 0) {
      set({ queue: [], currentSong: null, playUrl: '', isPlaying: false, currentIndex: 0 });
      // 队列空了 = 没有当前歌曲了，桌面歌词要跟着清空（否则停在最后一首）
      void get().pushLyricsState();
      return;
    }
    set({ queue: nextQ, currentIndex: Math.min(index, nextQ.length - 1) });
    if (removedCurrent) void get().playSong(nextQ[Math.min(index, nextQ.length - 1)]);
    else if (index < currentIndex) set({ currentIndex: currentIndex - 1 });
    void currentSong; // 保留引用，避免未使用告警
  },

  clearQueue: () => {
    set({ queue: [], currentSong: null, playUrl: '', isPlaying: false, currentIndex: 0 });
    // 同上：清空队列后没有当前歌曲了，推一次空状态让桌面歌词归位
    void get().pushLyricsState();
    // 队列空了就不该留快照 —— 否则下次启动会恢复出一个"用户刚清掉的队列"
    clearResumeSnapshot();
  },

  persistSnapshot: () => {
    const { queue, currentIndex, currentSong, playbackSource, progressMs } = get();
    if (!currentSong || queue.length === 0) {
      clearResumeSnapshot();
      return;
    }
    // 下标以 currentSong **反查**为准，而不是直接信 currentIndex：
    // 两者在 playSong 里同步设置，但"从播放历史点歌"等路径可能让它们短暂不一致，
    // 写错下标会让恢复后停在一首完全不同的歌上（播放条却显示 currentSong，自相矛盾）。
    const found = queue.findIndex((s) => songKey(s) === songKey(currentSong));
    const index = found >= 0 ? found : currentIndex;
    if (index < 0 || index >= queue.length) {
      clearResumeSnapshot();
      return;
    }
    const { queue: q, index: idx } = truncateQueueForSnapshot(queue, index);
    writeResumeSnapshot({
      v: SNAPSHOT_VERSION,
      provider: playbackSource,
      // sanitizeForStorage 清掉 data URL 封面（base64 可能上百 KB，
      // 200 首塞进 localStorage 会直接触发配额失败）
      queue: q.map(sanitizeForStorage),
      index: idx,
      progressMs: Math.max(0, Math.round(progressMs)),
      savedAt: Date.now(),
    });
  },

  clearSnapshot: () => clearResumeSnapshot(),

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
      userPlaylists: [],      userPlaylistsError: '',
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
    // 平台选择是**用户偏好**，必须落盘：恢复流程要按"上次那个平台"校验登录态，
    // 而这一项此前没持久化 → 重启后 playbackSource 恒为初始的 'netease'。
    savePrefs({ playbackSource: p });
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
      let lines: ParsedLyricLine[] = [];
      if (song._localPath) {
        // 本地导入的歌词是磁盘上的 .lrc（行级），没有 yrc → 走 LRC 解析（同样会补 duration）
        const raw = await ipc.getLocalLyric(song._localPath);
        lines = parseLrc(raw);
      } else {
        const l = await platform.lyric(song.provider as MusicProvider, song);
        // 后端（netease/qqmusic 等）**已经返回 yrc 逐字歌词**，但此前只取了 l.lyric，
        // 这正是"有 yrc 却没有逐字高亮"的直接原因。这里改为 yrc 优先：
        //   有 yrc → parseYrc（精确到字）；否则 → parseLrc（行级 + 时间差推断 duration）。
        lines = l.yrc ? parseYrc(l.yrc) : parseLrc(l.lyric || '');
        // 兜底：yrc 字段非空但解析出来是空（格式异常/平台给了空骨架）时退回 LRC，
        // 避免"明明有词却显示暂无歌词"。
        if (l.yrc && lines.length === 0) lines = parseLrc(l.lyric || '');
        // 合并翻译（仅网络歌曲；本地 .lrc 无 translation）—— 后端 netease/qqmusic 已返回
        // `l.translation`，此前被整段丢弃。翻译行数常与原文不一致（重复句被合并），故按时间匹配。
        mergeTranslation(lines, l.translation || '');
      }
      // 只应用当前歌曲的歌词，避免切歌后旧歌词覆盖
      if (get().currentSong && songKey(get().currentSong as Song) !== songKey(song)) return;
      set({ parsedLyrics: lines });
    } catch {
      if (get().currentSong && songKey(get().currentSong as Song) === songKey(song)) set({ parsedLyrics: [] });
    }
    // 歌词是**异步**取回来的：playSong 那次推送发出时 lines 往往还是空的。
    // 这里补推一次，歌词窗才真的显示出词。
    await get().pushLyricsState();
  },

  // ================================================================ 桌面歌词

  setLyricsWindowOpen: async (open) => {
    // 先改状态再调命令：让 UI 立刻响应，不被 IPC 往返卡住。
    // 失败时回滚 —— 否则会留下"开关显示已开、窗口却没起来"的假状态。
    const prev = get().lyricsWindowOpen;
    set({ lyricsWindowOpen: open });
    try {
      if (open) await ipc.openLyricsWindow();
      else await ipc.closeLyricsWindow();
    } catch (e) {
      set({ lyricsWindowOpen: prev });
      get().toast(`桌面歌词窗口${open ? '打开' : '关闭'}失败：${String(e)}`);
      return;
    }
    // 开窗后立即推一次：新建的窗口手里没有任何状态，
    // 不推它就停在「待播放」，要等下次换歌才显示内容。
    if (open) await get().pushLyricsState();
  },

  pushLyricsState: async () => {
    const { currentSong, parsedLyrics, isPlaying, progressMs, durationMs, playMode } = get();
    // `songId` 用 `songKey`（provider:id）而不是裸 `song.id`：四个平台的 id 各自独立，
    // 裸 id 跨平台会撞车，歌词窗就无法区分"换歌了"与"还是同一首"。
    const payload: ipc.LyricsPushPayload = {
      songId: currentSong ? songKey(currentSong) : null,
      songName: currentSong?.name ?? '',
      artist: currentSong?.artist ?? '',
      // 契约要的是**毫秒**，而 `parseLrc` 产出的 `time` 是**秒** —— 这里必须换算，
    // 漏了会让整首歌的歌词都挤在开头几秒内（症状：歌词瞬间刷完然后不动）。
      lines: parsedLyrics.map((l) => ({ ms: Math.round(l.time * 1000), text: l.text })),
      playing: isPlaying,
      startedAtMs: progressMs,
      durationMs,
      sentAtEpoch: Date.now(),
      // 播放模式要跟着走：歌词窗的控制栏靠它显示正确的模式图标（两窗 store 互不可见）
      playMode,
      // 完整推送也带上偏好：新开的窗口首帧就能拿到正确外观，
      // 不必等用户去动一次设置（那样新窗口会先按默认值闪一下再跳成用户的值）。
      desktopLyrics: dlPrefsOf(get()),
    };
    try {
      // 窗口不存在时 Rust 侧静默成功，所以这里不需要先判断开没开
      await ipc.lyricsPush(payload);
    } catch {
      // 推失败不能影响播放：桌面歌词是旁路能力，窗口侧的问题不该阻断主流程
    }
  },

  pushLyricsPrefs: async () => {
    const payload: ipc.LyricsPrefsPayload = {
      prefsOnly: true,
      desktopLyrics: dlPrefsOf(get()),
    };
    try {
      await ipc.lyricsPush(payload);
    } catch {
      // 窗口没开时 Rust 静默成功；非 Tauri 环境（浏览器里直接开主窗）则忽略
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

  setExpanded: (open) => {
    // 展开时若退场动画正在播，必须**取消那次关闭** ——
    // 否则定时器到点仍会把 expanded 置 false，表现成"点开反而关了"。
    if (open && closeExpandedTimer) {
      clearTimeout(closeExpandedTimer);
      closeExpandedTimer = null;
    }
    set(open ? { expanded: true, expandedClosing: false } : { expanded: open });
  },

  closeExpanded: () => {
    if (!get().expanded || get().expandedClosing) return;
    set({ expandedClosing: true });
    // 300ms 对应 app.css `.music-exp.is-closing` 的 0.3s（断言 ANIM.durationSync 双向盯着）
    closeExpandedTimer = setTimeout(() => {
      closeExpandedTimer = null;
      set({ expandedClosing: false, expanded: false });
    }, 300);
  },

  setSkin: (s) => {
    set({ skin: s });
    savePrefs({ skin: s });
  },

  toast: (message, type = 'warning') => set({ musicToast: { type, message } }),
  clearToast: () => set({ musicToast: null }),
}));
