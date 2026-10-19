/**
 * 派生数据 —— 纯函数，输入 store 快照或显式列表，输出列表/计数。
 *
 * 为什么单独一件：同一份筛选口径在追番、探索、历史三屏都要用；
 * 散在组件里必然出现「追番按中文名搜、探索按原名搜」的两套行为。
 */
import type { AnimeState } from '@anime/slice';
import type { AnimeEpisode, AnimeSubject, CollectionType } from '@anime/types';
import { COLLECTION_ORDER } from '@anime/types';
import { progressOf } from '@anime/convert';

/** 按「隐藏 NSFW + 关键词 + 收藏筛选」过滤条目（探索/搜索用） */
export function visibleSubjects(s: AnimeState): AnimeSubject[] {
  const q = s.query.trim().toLowerCase();
  return s.subjects
    .filter((x) => {
      if (s.prefs.hideNsfw && x.tags.some((t) => t.toLowerCase() === 'nsfw')) return false;
      if (s.filter !== 'all' && x.collection !== s.filter) return false;
      if (!q) return true;
      const hay = [x.title, x.titleOriginal ?? '', ...x.tags].join(' ').toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 只按收藏态筛选（追番页专用）。
 * 与 `visibleSubjects` 分开：那一份还吃关键词与 NSFW 开关，追番页不参与搜索 ——
 * 共用会让"搜索框里剩的字"悄悄影响追番列表，用户看不出原因。
 */
export function byCollection(subjects: AnimeSubject[], filter: CollectionType): AnimeSubject[] {
  return subjects.filter((x) => x.collection === filter).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 五个状态各有多少条（tab 计数），顺序与 `COLLECTION_ORDER` 一致 */
export function collectionCounts(subjects: AnimeSubject[]): Record<CollectionType | 'all', number> {
  const out = { all: subjects.length } as Record<CollectionType | 'all', number>;
  for (const c of COLLECTION_ORDER) out[c] = subjects.filter((x) => x.collection === c).length;
  return out;
}

/** 某条目的集（按集号升序） */
export function episodesOf(subjectId: string | null, episodes: AnimeEpisode[]): AnimeEpisode[] {
  if (!subjectId) return [];
  return episodes.filter((e) => e.subjectId === subjectId).sort((a, b) => a.index - b.index);
}

/** 条目进度（集汇总） */
export function subjectProgress(subject: AnimeSubject, episodes: AnimeEpisode[]): number {
  return progressOf(subject, episodes);
}

/** 播放历史行（纯参数版；屏里只订阅 subjects/episodes 时用，避免造假 state） */
export function historyFrom(
  subjects: AnimeSubject[],
  episodes: AnimeEpisode[],
): { episode: AnimeEpisode; subject: AnimeSubject }[] {
  return episodes
    .filter((e) => e.positionMs > 0 || e.watched)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((episode) => ({ episode, subject: subjects.find((x) => x.id === episode.subjectId) }))
    .filter((r): r is { episode: AnimeEpisode; subject: AnimeSubject } => !!r.subject);
}

/** 播放历史行（state 版） */
export function historyRows(s: AnimeState): { episode: AnimeEpisode; subject: AnimeSubject }[] {
  return historyFrom(s.subjects, s.episodes);
}

/** 当前选中条目 */
export function selectedSubject(s: AnimeState): AnimeSubject | null {
  return s.subjects.find((x) => x.id === s.selectedId) ?? null;
}

/** 当前选中集（播放器用） */
export function selectedEpisode(s: AnimeState): AnimeEpisode | null {
  return s.episodes.find((e) => e.id === s.selectedEpisodeId) ?? null;
}
