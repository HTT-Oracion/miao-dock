// 漫画库左栏：书架头 + 搜索框 + 书架行 + 容量脚（含已隐藏与翻页器）。
//
// 为什么从 `LibraryScreen.tsx` 抽出来（D-151）：屏本体 1,147 行里，左栏这段 JSX 独占 204 行，
// 且与「右侧头行 + 网格 / 话列表」是两件独立的事。抽出来只传 props（无 Context —— 守本仓
// 「零 Context」的裁定），屏本体只留状态与编排。
//
// 🔴 搜索的**结果**不在这里：设计稿的屏 A′ 是「左栏只列命中的作品、右栏才是分组结果」，
// 所以本件在搜索态只负责"按命中收窄书架"，分组 / 高亮 / 归并入口全在 `LibraryRight`。
import type { MouseEvent, ReactElement } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, EyeOff, MoreHorizontal, Search, X } from 'lucide-react';
import { LIBRARY } from '@/themes/tokens';
import { Btn, Tooltip } from '@components/units';
import { formatBytes, groupSearchResults, pageSlice, pageWindow } from '@tools';
import { CoverThumb, EmptyArt } from '@screens/manga/cards';
import { AUTHOR_FALLBACK, LIB_PAGE_SIZE } from '@screens/manga/libModel';
import type { LibItem } from '@screens/manga/libModel';

export function LeftRail({
  queryInput,
  onQueryInput,
  query,
  searching,
  hasLayers,
  searchGroups,
  flatHits,
  items,
  activeKey,
  onActive,
  onCtxMenu,
  libPage,
  libPages,
  onLibPage,
  totalBytes,
  hiddenCount,
  onShowHidden,
  onGoDrop,
}: {
  queryInput: string;
  onQueryInput: (v: string) => void;
  /** **防抖后**的搜索词（收窄书架用，别用 `queryInput`） */
  query: string;
  searching: boolean;
  hasLayers: boolean;
  searchGroups: ReturnType<typeof groupSearchResults>;
  flatHits: LibItem[];
  items: LibItem[];
  /** 当前选中的键（= `comicName`）；`null` = 未选中 */
  activeKey: string | null;
  onActive: (key: string) => void;
  onCtxMenu: (e: MouseEvent<HTMLButtonElement>, item: LibItem) => void;
  libPage: number;
  libPages: number;
  onLibPage: (page: number) => void;
  totalBytes: number;
  hiddenCount: number;
  onShowHidden: () => void;
  /** 空书架上的「去投放」（设计稿 `.empty-actions` 的第一条出口） */
  onGoDrop: () => void;
}) {
  /** 行尾「⋯」：与右键菜单同一份内容，入口从右键换成可见按钮（设计稿 `.book-more`） */
  const moreBtn = (it: LibItem) => (
    <Btn
      kind="bare"
      className="lib-more"
      title="更多操作"
      ariaLabel={`${it.name} 的更多操作`}
      onClick={(e) => {
        // 行本身是「选中」按钮：点 ⋯ 不该顺带选中另一本
        e.stopPropagation();
        onCtxMenu(e, it);
      }}
    >
      <MoreHorizontal size={13} />
    </Btn>
  );

  /** 一行（设计稿 `.book-row`）：封面缩略 + 名称 + 副标题 + 行尾 ⋯ */
  const bookRow = (it: LibItem, sub: string) => (
    <div
      key={it.key}
      className={it.key === activeKey ? 'lib-item is-active' : 'lib-item'}
      onContextMenu={(e) => {
        // 右键落在整行上（含行内按钮），菜单锚点取鼠标位置
        e.preventDefault();
        onCtxMenu(e as unknown as MouseEvent<HTMLButtonElement>, it);
      }}
    >
      <Btn kind="bare" className="lib-item-main" onClick={() => onActive(it.key)}>
        <CoverThumb
          path={it.thumbPath}
          name={it.name}
          className="cover-thumb"
          w={LIBRARY.cover.thumb.w}
          h={LIBRARY.cover.thumb.h}
          radius={LIBRARY.cover.thumb.radius}
        />
        <span className="lib-item-text">
          <Tooltip label={it.name}>
            <span className="lib-item-name">{it.name}</span>
          </Tooltip>
          <span className="lib-item-meta">{sub}</span>
        </span>
      </Btn>
      {moreBtn(it)}
    </div>
  );

  /*
   * 搜索态的书架行：只列**命中的作品**（设计稿 `renderShelf` 在 `q` 存在时用
   * `groups.map(g => g.book)` 取代分页列表），副标题换成「N 个结果 · 作者」——
   * 用户此刻关心的是"这一本里命中了几话"，不是它总共几话。
   */
  const searchRows = (() => {
    if (!searching) return null;
    if (!hasLayers) return flatHits.map((it) => bookRow(it, `${it.pageCount} 张`));
    return searchGroups
      .map((g) => {
        const it = items.find((x) => x.key === g.key);
        if (!it) return null;
        return bookRow(it, `${g.rows.length} 个结果 · ${it.author || AUTHOR_FALLBACK}`);
      })
      .filter((x): x is ReactElement => x !== null);
  })();

  const browseRows = pageSlice(items, libPage, LIB_PAGE_SIZE).map((it) =>
    bookRow(it, `${it.author || AUTHOR_FALLBACK} · ${it.chapterCount} 话 · ${it.pageCount} 页`),
  );

  const rows = searchRows ?? browseRows;

  return (
    <aside className="lib-left">
      {/* 书架头（设计稿 `.shelf-head`）：标题 + 部数，说明"这一栏装的是什么" */}
      <div className="shelf-head">
        <h2>
          <BookOpen size={14} />
          我的书架
        </h2>
        <span className="shelf-count">{items.length} 部</span>
      </div>

      <div className="lib-search">
        <Search size={13} className="lib-search-ico" />
        <input
          className="input lib-search-input"
          value={queryInput}
          onChange={(e) => onQueryInput(e.target.value)}
          placeholder="搜索漫画名 / 作者 / 话号…"
          aria-label="搜索书架"
          spellCheck={false}
        />
        {queryInput ? (
          <Btn
            kind="bare"
            className="lib-search-clear"
            ariaLabel="清空搜索"
            title="清空搜索"
            onClick={() => onQueryInput('')}
          >
            <X size={13} />
          </Btn>
        ) : null}
      </div>

      <div className="lib-left-list">
        {rows.length > 0 ? (
          rows
        ) : searching ? (
          /* 搜索态的空书架只是一句短提示：分组结果与「没有找到」都在右栏（设计稿的分工） */
          <div className="lib-empty">没有与「{query}」相关的作品</div>
        ) : (
          <div className="empty lib-empty-state">
            <EmptyArt />
            <h3>书架还是空的</h3>
            <p>投放几张漫画图片，翻译完成后作品会自动按「本 → 话 → 页」整理在这里。</p>
            <div className="empty-actions">
              <Btn kind="primary" size="sm" onClick={onGoDrop}>
                去投放
              </Btn>
            </div>
          </div>
        )}
      </div>

      {/* 书架脚（设计稿 `.shelf-foot`）：容量 / 已隐藏 / （搜索态给「清除搜索」，否则给翻页器） */}
      <div className="lib-left-foot">
        <span className="shelf-stat">
          已用容量 <b>{formatBytes(totalBytes)}</b>
        </span>
        {hiddenCount > 0 ? (
          <Btn kind="bare" className="lib-hidden-link" onClick={onShowHidden} title="管理已隐藏的漫画">
            <EyeOff size={12} /> 已隐藏 {hiddenCount}
          </Btn>
        ) : null}
        {searching ? (
          <Btn kind="text" onClick={() => onQueryInput('')}>
            清除搜索
          </Btn>
        ) : libPages > 1 ? (
          <span className="shelf-pager">
            <Btn
              kind="bare"
              className="shelf-pager-btn"
              disabled={libPage <= 1}
              onClick={() => onLibPage(libPage - 1)}
              ariaLabel="上一页"
            >
              <ChevronLeft size={12} />
            </Btn>
            {pageWindow(libPage, libPages).map((p, i) =>
              p === '…' ? (
                <span className="pager-gap" key={`gap-${i}`}>
                  …
                </span>
              ) : (
                <Btn
                  kind="bare"
                  className="shelf-pager-btn"
                  key={p}
                  active={p === libPage}
                  onClick={() => onLibPage(p)}
                  ariaLabel={`第 ${p} 页`}
                >
                  {p}
                </Btn>
              ),
            )}
            <Btn
              kind="bare"
              className="shelf-pager-btn"
              disabled={libPage >= libPages}
              onClick={() => onLibPage(libPage + 1)}
              ariaLabel="下一页"
            >
              <ChevronRight size={12} />
            </Btn>
          </span>
        ) : null}
      </div>
    </aside>
  );
}
