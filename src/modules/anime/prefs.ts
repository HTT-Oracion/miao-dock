/**
 * 番剧模块的偏好层 —— 值的家在这里（默认值 + 落盘键），组件只持有「当前这一份」。
 *
 * 与 `modules/music/prefs.ts` 同构：默认值与读写键集中一处，避免「设置页写一套默认、
 * 播放器写另一套」的漂移。落盘用 `localStorage`（壳层与音乐偏好都是这个口径）。
 */
import type { SkipMode } from '@anime/types';
import { ANIME_LS_PREFIX } from '@anime/slice';

export interface AnimePrefs {
  /** 番剧根目录；留空 = 用服务端默认落点（`<数据根>/anime/resources`） */
  libraryRoot: string;
  /** 条目名显示：中文名 / 原名 */
  titleMode: 'cn' | 'original';
  /** 隐藏 NSFW 条目 */
  hideNsfw: boolean;
  /** 收藏列表进场动画 */
  listAnim: boolean;
  /** 记忆播放位置（续看） */
  resume: boolean;
  /** 自动连播下一集 */
  autoNext: boolean;
  /** 自动跳过片头 / 片尾 */
  skip: SkipMode;
  /** 默认播放倍速 */
  defaultRate: number;
  /** 强制硬件解码 */
  forceHwDecode: boolean;
  /** 字幕字号（相对基准百分比） */
  subtitleSize: 100 | 120 | 140;
  /** 字幕描边 */
  subtitleStroke: 'thin' | 'mid' | 'bold';
  /** 字幕语言优先级 */
  subtitlePriority: string;
  /** 允许 BT / 磁力来源 */
  allowBt: boolean;
  /** BT 边下边播 */
  btStream: boolean;
  /** 自动选源策略 */
  selectStrategy: string;
  /** 优先分辨率 */
  preferRes: 'auto' | '1080p' | '2160p';
  /** 优先字幕语言 */
  preferSub: 'zh' | 'zh-hant' | 'ja';
  /** 播放前确认来源 */
  confirmSource: boolean;
  /** 缓存目录 */
  cacheDir: string;
  /** 缓存占用上限（GB） */
  cacheLimitGb: number;
  /** 代理 */
  proxy: 'off' | 'system' | 'custom';
  /** BT 监听端口（「随机」或数字串） */
  btPort: string;
  /** Peer 过滤规则订阅地址 */
  peerFilterUrl: string;
  /** PikPak 云离线 */
  pikpak: boolean;
  /** 自动同步队列 */
  autoSync: boolean;
  /** 冲突处理 */
  conflictPolicy: 'ask' | 'local' | 'cloud';
}

/**
 * 出厂默认值。
 * 目录类默认留空：真实落点由服务端给（`anime_paths`），
 * 不预设 `D:\…` 这种只有开发机成立的路径。
 */
export const DEFAULT_PREFS: AnimePrefs = {
  libraryRoot: '',
  titleMode: 'cn',
  hideNsfw: true,
  listAnim: true,
  resume: true,
  autoNext: true,
  skip: 'ed',
  defaultRate: 1,
  forceHwDecode: false,
  subtitleSize: 120,
  subtitleStroke: 'mid',
  subtitlePriority: '简中 → 简繁 → 日语',
  allowBt: true,
  btStream: true,
  selectStrategy: '匹配度 → 分辨率 → 做种 → 字幕',
  preferRes: '1080p',
  preferSub: 'zh',
  confirmSource: true,
  cacheDir: '',
  cacheLimitGb: 50,
  proxy: 'off',
  btPort: '随机',
  peerFilterUrl: '',
  pikpak: false,
  autoSync: true,
  conflictPolicy: 'ask',
};

const LS_KEY = `${ANIME_LS_PREFIX}prefs`;

/** 读偏好：坏 JSON / 缺键一律回落默认值，绝不让坏存档把设置页炸掉 */
export function loadPrefs(): AnimePrefs {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_PREFS };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<AnimePrefs>;
    // 只接受已知键，且类型对得上 —— 旧版本遗留键不污染当前形状
    const next: AnimePrefs = { ...DEFAULT_PREFS };
    for (const k of Object.keys(DEFAULT_PREFS) as (keyof AnimePrefs)[]) {
      if (k in parsed && typeof parsed[k] === typeof DEFAULT_PREFS[k]) {
        (next as unknown as Record<string, unknown>)[k] = parsed[k];
      }
    }
    return next;
  } catch (e) {
    console.error('[anime] 偏好读取失败，已回落默认值', e);
    return { ...DEFAULT_PREFS };
  }
}

/** 写偏好：整份覆盖（键少且都是标量，没必要做增量合并） */
export function savePrefs(p: AnimePrefs): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch (e) {
    console.error('[anime] 偏好写入失败', e);
  }
}

/** 备份导出 / 导入（设置页「备份」组用；真动作，不是占位按钮） */
export function prefsKey(): string {
  return LS_KEY;
}
