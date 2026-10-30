/**
 * 「记忆回放」：每个源上一次播的那一条（R2-3）。
 *
 * 只存**最小信息**（源 id → 条目），跨会话保存在 localStorage；条目本身来自源测试的返回，
 * 不是重新构造的假对象。读坏了就当没有 —— 一条记忆不该让整个数据源屏起不来。
 */
import type { AnimeSourceTestItem } from '@anime/types';

const KEY = 'miao.anime.sourceMemory.v1';

export interface SourceMemoryEntry {
  item: AnimeSourceTestItem;
  /** 记录时刻（毫秒），只用于「上次」排序/展示 */
  at: number;
}

export type SourceMemory = Record<string, SourceMemoryEntry>;

/** 读全部记忆（坏数据 → 空表，不抛） */
export function loadSourceMemory(): SourceMemory {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: SourceMemory = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Partial<SourceMemoryEntry> | null;
      const item = e?.item as AnimeSourceTestItem | undefined;
      if (item && typeof item.title === 'string' && typeof e?.at === 'number') {
        out[id] = { item, at: e.at };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** 记一条「这个源上次播的是它」；写失败（隐私模式/配额）静默忽略 */
export function rememberSource(sourceId: string, item: AnimeSourceTestItem): void {
  try {
    const all = loadSourceMemory();
    all[sourceId] = { item, at: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 记忆是锦上添花：写不进去不影响播放
  }
}
