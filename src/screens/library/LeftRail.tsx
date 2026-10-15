// 漫画库左栏：搜索框 + 列表（浏览态 / 搜索分组态 / 无分层平铺态）+ 容量脚 + 分页器。
//
// 为什么从 `LibraryScreen.tsx` 抽出来（D-151）：屏本体 1,147 行里，左栏这段 JSX 独占 204 行，
// 且与「右侧头行 + 网格 / 话列表」是两件独立的事。抽出来只传 props（无 Context —— 守本仓
// 「零 Context」的裁定），屏本体只留状态与编排。
import type { MouseEvent } from 'react';
import { ChevronDown, EyeOff, GitMerge, Search, X } from 'lucide-react';
import { LIBRARY } from '@/theme/tokens';
import { Btn, Tooltip } from '@components/units';
import { formatBytes, groupSearchResults, pageSlice } from '@tools';
import { CoverThumb, Highlight } from '@screens/library/cards';
import { AUTHOR_FALLBACK, LIB_PAGE_SIZE, progressLabel } from '@screens/library/libModel';
import type { LibItem } from '@screens/library/libModel';

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
  foldedGroups,
  onToggleFolded,
  onCtxMenu,
  onMerge,
  libPage,
  libPages,
  onLibPage,
  totalBytes,
  hiddenCount,
  onShowHidden,
}: {
  queryInput: string;
  onQueryInput: (v: string) => void;
  /** **防抖后**的搜索词（高亮与过滤都用它，别用 `queryInput`） */
  query: string;
  searching: boolean;
  hasLayers: boolean;
  searchGroups: ReturnType<typeof groupSearchResults>;
  flatHits: LibItem[];
  items: LibItem[];
  /** 当前选中的键（= `comicName`）；`null` = 未选中 */
  activeKey: string | null;
  onActive: (key: string) => void;
  foldedGroups: Set<string>;
  onToggleFolded: (key: string) => void;
  onCtxMenu: (e: MouseEvent<HTMLButtonElement>, item: LibItem) => void;
  onMerge: (dirName: string) => void;
  libPage: number;
  libPages: number;
  onLibPage: (page: number) => void;
  totalBytes: number;
  hiddenCount: number;
  onShowHidden: () => void;
}) {
  return (
    <aside className="lib-left" style={{ width: LIBRARY.leftColumnWidth, flexBasis: LIBRARY.leftColumnWidth }}>
      <div className="lib-search">
        <Search size={13} className="lib-search-ico" />
        <input
          className="input lib-search-input"
          value={queryInput}
          onChange={(e) => onQueryInput(e.target.value)}
          placeholder="搜索漫画名 / 作者 / 话号…"
          spellCheck={false}
        />
        {queryInput ? (
          <button type="button" className="lib-search-clear" onClick={() => onQueryInput('')} aria-label="清空搜索">
            <X size={13} />
          </button>
        ) : null}
      </div>

      <div className="lib-left-list">
        {searching ? (
          /* ── 屏 A′：搜索结果分组态 ───────────────────────────────── */
          hasLayers ? (
            searchGroups.length > 0 ? (
              searchGroups.map((g) => {
                const folded = foldedGroups.has(g.key);
                return (
                  <div className="grp" key={g.key}>
                    {/* 分组标题可点选收起/展开（设计稿 §7.2「折叠」） */}
                    <button type="button" className="grp-head" onClick={() => onToggleFolded(g.key)}>
                      <ChevronDown size={12} className={folded ? 'grp-caret is-folded' : 'grp-caret'} />
                      <span className="grp-title" title={g.title}>
                        {/* 「其它」不加大类框，故不高亮书名号里的书名（它本来就不是书名） */}
                        {g.merged ? <Highlight text={g.title} query={query} /> : g.title}
                      </span>
                      <span className="num grp-count">{g.rows.length}</span>
                    </button>
                    {folded ? null : (
                      <div className="grp-body">
                        {g.merged ? null : (
                          <div className="other-hint">
                            未归并的单话会出现在这里，点「归并」把它挂到某本漫画的某一话。
                          </div>
                        )}
                        {g.rows.map((r) => (
                          <div className="grp-row" key={r.key}>
                            <button
                              type="button"
                              className={r.bookName === activeKey ? 'grp-row-main is-active' : 'grp-row-main'}
                              onClick={() => onActive(r.bookName)}
                              title={r.label}
                            >
                              <span className="grp-row-label">
                                <Highlight text={r.label} query={query} />
                              </span>
                              <span className="grp-row-status muted">· {progressLabel(r.target)}</span>
                            </button>
                            {r.mergeable ? (
                              <span className="grp-row-act">
                                <Btn kind="ghost" size="sm" onClick={() => onMerge(r.target.dirName)}>
                                  <GitMerge size={12} />
                                  归并
                                </Btn>
                              </span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="lib-empty">没有匹配「{query}」的漫画或话</div>
            )
          ) : (
            /* 旧服务端（无 books/others）：退回平铺过滤，行为与改造前一致 */
            <>
              {flatHits.map((it) => (
                <button
                  key={it.key}
                  type="button"
                  className={it.key === activeKey ? 'lib-item is-active' : 'lib-item'}
                  onClick={() => onActive(it.key)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onCtxMenu(e, it);
                  }}
                >
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
                    <span className="lib-item-meta">
                      <span className="num">{it.pageCount}</span> 张
                    </span>
                  </span>
                </button>
              ))}
              {flatHits.length === 0 ? <div className="lib-empty">没有匹配「{query}」的漫画</div> : null}
            </>
          )
        ) : (
          /* ── 屏 A：浏览态（封面缩略 + 名称 + 作者 · N 话 · M 页）────── */
          <>
            {pageSlice(items, libPage, LIB_PAGE_SIZE).map((it) => (
              <button
                key={it.key}
                type="button"
                className={it.key === activeKey ? 'lib-item is-active' : 'lib-item'}
                onClick={() => onActive(it.key)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onCtxMenu(e, it);
                }}
              >
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
                  <span className="lib-item-meta">
                    {it.author || AUTHOR_FALLBACK} · <span className="num">{it.chapterCount}</span> 话 ·{' '}
                    <span className="num">{it.pageCount}</span> 页
                  </span>
                </span>
              </button>
            ))}
            {items.length === 0 ? <div className="lib-empty">漫画库还是空的</div> : null}
          </>
        )}
      </div>

      <div className="lib-left-foot">
        <span>
          已用容量 <span className="num">{formatBytes(totalBytes)}</span>
        </span>
        {hiddenCount > 0 ? (
          <button type="button" className="lib-hidden-link" onClick={onShowHidden}>
            <EyeOff size={12} /> 已隐藏 {hiddenCount}
          </button>
        ) : null}
      </div>

      {/* 搜索态是分组的连续列表，不分页（设计稿 §7.2 的屏 A′ 里没有分页器） */}
      {!searching && libPages > 1 ? (
        <div className="lib-pager">
          <Btn kind="ghost" size="sm" disabled={libPage <= 1} onClick={() => onLibPage(libPage - 1)}>
            上一页
          </Btn>
          <span className="muted">
            <span className="num">{libPage}</span> / <span className="num">{libPages}</span>
          </span>
          <Btn kind="ghost" size="sm" disabled={libPage >= libPages} onClick={() => onLibPage(libPage + 1)}>
            下一页
          </Btn>
        </div>
      ) : null}
    </aside>
  );
}
