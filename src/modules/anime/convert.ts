/**
 * 番剧模块的纯转换函数 —— 只做「数据 → 展示值」，不碰 store、不碰 IPC。
 *
 * 为什么单独一件：这些函数在列表、详情、进度、历史四处被复用，
 * 散在组件里会出现「同一部番在列表显示 11/12、在详情显示 12/12」的两套口径。
 */
import type { AnimeEpisode, AnimeSubject, CollectionType } from '@anime/types';
import { COLLECTION_LABELS } from '@anime/types';

/** 毫秒 → `mm:ss`（超过 1 小时给 `h:mm:ss`） */
export function fmtClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '--:--';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 集号展示：整数显示 `12`，一位小数显示 `12.5` */
export function epLabel(index: number): string {
  return Number.isInteger(index) ? String(index) : index.toFixed(1);
}

/**
 * 语言词 → 文件名里可能出现的写法。
 *
 * 字幕文件名是字幕组起的（`01.chs.ass` / `01.zh-Hans.ass` / `01.繁体.ass` 都见过），
 * 所以每种语言给一组别名，命中任意一个就算。
 */
const SUB_LANG_ALIASES: Record<string, string[]> = {
  简中: ['chs', 'sc', 'zh-hans', 'zh_cn', 'zh-cn', '简体', '简'],
  繁中: ['cht', 'tc', 'zh-hant', 'zh_tw', 'zh-tw', '繁体', '繁'],
  日语: ['jpn', 'ja', 'jp', '日'],
  英语: ['eng', 'en', '英'],
  双语: ['dual', '双语', '简繁'],
};

/**
 * 按设置里的「字幕语言优先级」挑一条字幕，返回下标（-1 = 没命中，保持关闭）。
 *
 * 优先级是自由文本（`简中 → 繁中 → 日语`），按 `→` / 逗号 / 空格切成词，
 * **顺序即偏好**：先试第一个词的全部别名，都不中再试下一个词。
 * 只有文件名可用 —— 番剧库里的外挂字幕没有语言元数据，硬猜会挑错。
 */
export function pickSubtitleIndex(subs: { name: string }[], priority: string): number {
  if (!priority || subs.length === 0) return -1;
  const tokens = priority
    .split(/[→>,、\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  for (const token of tokens) {
    const aliases = SUB_LANG_ALIASES[token] ?? [token];
    const at = subs.findIndex((s) => {
      const name = s.name.toLowerCase();
      return aliases.some((a) => name.includes(a));
    });
    if (at >= 0) return at;
  }
  return -1;
}

/** 条目进度百分比（总集数缺失时按 0 处理） */
export function progressPct(progress: number, total?: number): number {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((progress / total) * 100)));
}

/** 从集列表汇总条目进度（只数正片：一位小数的特别篇不算集数） */
export function progressOf(subject: AnimeSubject, episodes: AnimeEpisode[]): number {
  return episodes.filter((e) => e.subjectId === subject.id && e.watched && Number.isInteger(e.index)).length;
}

/** 续看位置：最近一次有进度且未看完的集 */
export function resumeEpisode(subjectId: string, episodes: AnimeEpisode[]): AnimeEpisode | null {
  const list = episodes
    .filter((e) => e.subjectId === subjectId && e.positionMs > 0 && !e.watched)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return list[0] ?? null;
}

/** 收藏态文案；未收藏给「未收藏」而不是空串（列表里要能看出区别） */
export function collectionLabel(c: CollectionType | null | undefined): string {
  return c ? COLLECTION_LABELS[c] : '未收藏';
}

/** 路径最后一节（面包屑 / 路径展示用） */
export function pathTail(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** IPC 错误 → 一句能显示的话（Tauri 抛的可能是字符串、Error 或其他） */
export function errText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
