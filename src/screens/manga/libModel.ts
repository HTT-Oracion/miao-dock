// 漫画库屏的**共享小件**：左栏分页尺寸 · 作者占位 · 页级计数短语 · 左栏列表项类型。
//
// 为什么单开（D-151）：屏本体与 `LeftRail`（左栏）**都要**这些，留在 `LibraryScreen.tsx`
// 会形成 `LibraryScreen ↔ LeftRail` 的循环 import（同 D-148 的 `meta.ts` 理由）。

/** 左栏每页漫画数（窄栏 + 每项约 48px 高，12 项差不多一屏） */
export const LIB_PAGE_SIZE = 12;

/** 网格每页张数（110×165 卡 + 12 间距；24 张约两行多，翻页不至于太空） */
export const GRID_PAGE_SIZE = 24;

/**
 * 屏 B 话列表每页话数（设计稿 §7.3 明写 `CHAPTER_PAGE_SIZE = 24`，与 `GRID_PAGE_SIZE` 同值）。
 *
 * 与网格分页同值不是巧合：话卡与页卡是**同一个 110×165 的格子**（设计稿 §7.3「沿用
 * `LIBRARY.card` 令牌，不新增几何」），所以每屏装得下的个数天然相同。两处各写一个数，
 * 迟早出现"话列表 24/页、页网格 30/页"这种没理由的不一致。
 */
export const CHAPTER_PAGE_SIZE = 24;

/** 作者为空时的占位文案（设计稿 §7.1 中下 / §7.3 头部卡**同一口径**，故只写一份常量） */
export const AUTHOR_FALLBACK = '未署名';

/**
 * 一「部」的状态短语。
 *
 * 原先这里只写 `缺 ${imageCount - translatedCount}`，而那个数其实是**没有译文的**页数
 * —— 于是同一屏上冒出两个含义相反的「缺」：左栏说「缺 1」（那一页其实有原图，只是待译），
 * 网格卡说「缺页」（专指**没有原图**）。字面同源、意思不同，正是 G-11 里
 * 「同一张图、两屏两个故事」的翻版。逐页集合（G-10）已经能分开算，就没理由继续含糊。
 *
 * 收参按**结构**而不是 `ComicEntry`：大类、话、未归并单话三者的页级计数同名同义，
 * 逐页判定的口径也只有一个（G-10），没必要为每种来源各写一份。
 */
export interface PageCounts {
  imageCount: number;
  translatedCount: number;
  missingSeqs: number[];
}

export function progressLabel(c: PageCounts): string {
  if (c.imageCount === 0) return '空目录';
  const missing = c.missingSeqs.length;
  const pending = c.imageCount - c.translatedCount - missing;
  if (pending <= 0 && missing <= 0) return '已译完';
  const parts: string[] = [];
  if (pending > 0) parts.push(`待译 ${pending}`);
  if (missing > 0) parts.push(`缺页 ${missing}`);
  return parts.join(' · ');
}

/** 左栏列表项（浏览态一「部」；搜索态的分组行在 `groupSearchResults` 里另有一套） */
export interface LibItem {
  /** 选中态键 = 点击后要选中的 `comicName`（= `comics` 的键，故与既有选中逻辑天然对齐） */
  key: string;
  name: string;
  /** 空串 = 未署名 */
  author: string;
  chapterCount: number;
  pageCount: number;
  /** 缩略图字节路径；`null` = 无图（显示占位） */
  thumbPath: string | null;
  /** 是否大类（决定该项是否参与「编辑信息 / 删除」那套动作） */
  merged: boolean;
}
