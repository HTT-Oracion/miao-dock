import { SETTINGS_SECTIONS } from '@screens/settings/catalog';
import type { SectionId } from '@screens/settings/catalog';
import { plain } from '@screens/settings/parts';

/**
 * 设置搜索 —— 把 5 组 34 项摊平成一张可检索的索引（设计稿 `.settings-search-row` 的数据面）。
 *
 * ## 为什么从 catalog 现算，而不是另写一份索引表
 *
 * 索引表要写的字段（label / 说明 / 所属分组）**catalog 里已经全有**。另写一份的代价是
 * 两边漂移：catalog 改了一个项名，搜索里仍是旧词，用户搜新词搜不到 —— 而两处各自都
 * 语法正确、类型正确，没有任何一道门会红。
 *
 * ## 检索口径与设计稿一致
 *
 * 命中判据是「项名 + 说明 + 分组名」拼起来的小写子串包含（设计稿 `renderSearchResults`
 * 就是这么算的）。分组名必须参与：用户搜「歌词」时要能搜到 ③ 播放·媒体 下的那几项，
 * 搜「翻译」时也要能把 ② 整组带出来。
 */
export interface SettingHit {
  /** 稳定 id（= catalog 的 `SettingItem.id`，也是 DOM 上 `data-setting-id` 的取值） */
  id: string;
  label: string;
  /** 一行说明：取 catalog 的 `why`，去掉 markdown 强调标记（`**`） */
  desc: string;
  section: SectionId;
  sectionName: string;
}

/** 全量索引（顺序 = 分组顺序 × 组内顺序，与左栏导航一致） */
export const SETTINGS_INDEX: readonly SettingHit[] = SETTINGS_SECTIONS.flatMap((section) =>
  section.groups.flatMap((group) =>
    group.items.map((item) => ({
      id: item.id,
      label: item.label,
      desc: item.why ? plain(item.why) : '',
      section: section.id,
      sectionName: section.name,
    })),
  ),
);

/** 检索：空串返回空数组（调用方据此判断"没在搜索态"） */
export function searchSettings(query: string): SettingHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SETTINGS_INDEX.filter((hit) => `${hit.label} ${hit.desc} ${hit.sectionName}`.toLowerCase().includes(q));
}
