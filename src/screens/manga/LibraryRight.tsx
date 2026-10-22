// 漫画库右栏：头行 + 屏 B 话列表 / 屏 A·C 页网格 + 空库提示。
//
// 为什么从 `LibraryScreen.tsx` 抽出来（D-152）：与左栏（`LeftRail.tsx`）对称 ——
// 屏本体的 return 由「左栏 + 右栏 + 一排弹窗」三块组成，前两块各自成件后
// 屏本体只剩状态与编排。只传 props（守本仓「零 Context」）。
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Btn, IconButton, Notice } from '@components/units';
import { ChapterCard } from '@screens/manga/chapters';
import { GRID_HINT, GRID_LABEL, Thumb } from '@screens/manga/cards';
import type { GridState } from '@screens/manga/cards';
import { AUTHOR_FALLBACK } from '@screens/manga/libModel';
import type { PageView } from '@screens/manga/blob';
import type { BookEntry, ChapterEntry, ComicEntry } from '@/types';

export function LibraryRight({
  searching,
  query,
  current,
  inChapter,
  headName,
  headPath,
  currentBook,
  onRefresh,
  chapterRows,
  reworkingComics,
  onOpenChapter,
  onExitChapter,
  onOpenDir,
  onResume,
  onRetranslate,
  onEditNoChapter,
  chPage,
  chPages,
  onChPage,
  gridView,
  gridSeqs,
  missingSeqs,
  translatedSeqs,
  seqMax,
  gridPage,
  gridPages,
  onGridPage,
  onCompare,
}: {
  searching: boolean;
  query: string;
  /** 当前选中「部」；`null` = 空库 */
  current: ComicEntry | null;
  /** 是否停在「话内页」（屏 C）—— 决定头行显示话号还是书名 */
  inChapter: boolean;
  headName: string;
  headPath: string;
  currentBook: BookEntry | null;
  onRefresh: () => void;
  chapterRows: ChapterEntry[];
  /** 有任务在跑的目录（`dirName` 与 `book/dir` 两种键）；话卡据此禁用返工 */
  reworkingComics: Set<string>;
  onOpenChapter: (no: number) => void;
  /** 「返回这一部的话列表」：把话号清掉（与 `onOpenChapter` 分开 —— 那个进话、这个出话） */
  onExitChapter: () => void;
  /** 打开该话的本地目录（父层负责 `openPath` + 失败提示） */
  onOpenDir: (absDir: string) => void;
  onResume: (base: string, name: string) => void;
  onRetranslate: (base: string, name: string) => void;
  onEditNoChapter: (payload: { bookName: string; chapter: ChapterEntry }) => void;
  chPage: number;
  chPages: number;
  onChPage: (page: number) => void;
  /** 页网格的投影（整本 / 一话）；`null` = 还没准备好 */
  gridView: PageView | null;
  gridSeqs: number[];
  missingSeqs: Set<number>;
  translatedSeqs: Set<number>;
  seqMax: number;
  gridPage: number;
  gridPages: number;
  onGridPage: (page: number) => void;
  onCompare: (seq: number) => void;
}) {
  return (
    <section className="lib-right">
      {current ? (
        <>
          {/*
            详情头（设计稿 `.book-hero`）：左侧大封面 96×130 + 右侧信息列
            （kicker / 标题 / 作者与更新时间 / 状态徽标 / 路径 / 动作）。
            旧写法是一行「标题 + 路径 + 刷新」，没有封面也没有状态徽标 ——
            用户看不出"这是哪部作品、译到什么程度"。
          */}
          <div className="book-hero">
            <div className="book-big-cover" aria-hidden="true">
              {Array.from(headName).slice(0, 4).join('')}
            </div>
            <div className="book-info">
              {inChapter ? (
                <IconButton title="返回这一部的话列表" onClick={onExitChapter}>
                  <ArrowLeft size={20} />
                </IconButton>
              ) : null}
              <span className="kicker">BOOK / {inChapter ? 'CHAPTER' : 'LIBRARY'}</span>
              <h2 title={headName}>{headName}</h2>
              {currentBook ? (
                <p className="book-author">
                  {inChapter
                    ? `《${currentBook.bookName}》`
                    : `${currentBook.author || AUTHOR_FALLBACK} · ${currentBook.chapterCount} 话 · ${currentBook.totalPages} 页`}
                </p>
              ) : null}
              {currentBook && !inChapter ? (
                <div className="book-meta-chips">
                  <span className="st-badge is-idle">{currentBook.chapterCount} 话</span>
                  <span className="st-badge is-idle">{currentBook.totalPages} 页</span>
                </div>
              ) : null}
              <p className="book-path" title={headPath}>
                {headPath}
              </p>
              <div className="book-actions">
                <Btn kind="ghost" size="sm" onClick={onRefresh} title="重新扫描漫画库">
                  <RefreshCw size={14} />
                  刷新
                </Btn>
              </div>
            </div>
          </div>

          {currentBook && !inChapter ? (
            /* ── 屏 B：话列表（设计稿 §7.3）── 话卡沿用 110×165 网格几何；
                大类自身没有"页"，所以它选中时右栏不渲染页网格 */
            <>
              <div className="card lib-grid-wrap">
                <div className="lib-grid">
                  {chapterRows.map((ch) => (
                    <ChapterCard
                      key={ch.dirName}
                      bookName={currentBook.bookName}
                      chapter={ch}
                      busy={
                        // 整本有任务在跑 ⇒ 它的话也在被写，本话再返工会互相覆盖
                        reworkingComics.has(currentBook.dirName) ||
                        reworkingComics.has(`${currentBook.dirName}/${ch.dirName}`)
                      }
                      onOpen={() => {
                        if (ch.no !== null) onOpenChapter(ch.no);
                      }}
                      onOpenDir={() => onOpenDir(ch.absDir)}
                      onResume={() => {
                        if (ch.no === null) return; // 无话号的目录拼不出话级端点，卡片入口也已禁用
                        onResume(
                          `/library/${encodeURIComponent(currentBook.bookName)}/chapters/${ch.no}`,
                          `《${currentBook.bookName}》第 ${ch.no} 话`,
                        );
                      }}
                      onRetranslate={() => {
                        if (ch.no === null) return; // 无话号的目录拼不出话级端点，卡片入口也已禁用
                        onRetranslate(
                          `/library/${encodeURIComponent(currentBook.bookName)}/chapters/${ch.no}`,
                          `《${currentBook.bookName}》第 ${ch.no} 话`,
                        );
                      }}
                      onEditNo={() => onEditNoChapter({ bookName: currentBook.bookName, chapter: ch })}
                    />
                  ))}
                </div>
              </div>

              <div className="lib-foot-note">
                <span>
                  共 <span className="num">{currentBook.chapters.length}</span> 话
                  {chPages > 1 ? (
                    <>
                      {' · 第 '}
                      <span className="num">{chPage}</span> / <span className="num">{chPages}</span> 页
                    </>
                  ) : null}
                </span>
                {chPages > 1 ? (
                  <span className="lib-grid-pager">
                    <Btn kind="ghost" size="sm" disabled={chPage <= 1} onClick={() => onChPage(chPage - 1)}>
                      上一页
                    </Btn>
                    <Btn kind="ghost" size="sm" disabled={chPage >= chPages} onClick={() => onChPage(chPage + 1)}>
                      下一页
                    </Btn>
                  </span>
                ) : (
                  <span>点任意一话看它的页 · 卡片「⋯」里可重译整话</span>
                )}
              </div>
            </>
          ) : (
            /* ── 屏 A（整本 / 未归并单话）与屏 C（话内页）：同一套页网格渲染 ──
                两处只差投影（gridView），格子本身零差别 */
            <>
              <div className="card lib-grid-wrap">
                <div className="lib-grid page-grid">
                  {gridSeqs.map((seq) => {
                    const state: GridState = missingSeqs.has(seq)
                      ? 'missing'
                      : translatedSeqs.has(seq)
                        ? 'done'
                        : 'pending';
                    return (
                      <button
                        key={seq}
                        type="button"
                        /*
                         * 页卡（设计稿 `.page-card`）：宽度交给网格（`minmax(112px,1fr)`），
                         * 缩略图用 `aspect-ratio: 3/4.16` 自适应 —— 不再写死 110×165。
                         * 写死尺寸时，窗口一变宽右栏就留一大片空白，且每格宽度与网格列宽脱节。
                         */
                        className={state === 'missing' ? 'page-card is-missing' : 'page-card'}
                        disabled={state === 'missing'}
                        onClick={() => onCompare(seq)}
                        title={
                          state === 'missing'
                            ? `第 ${seq} 页在本机没有原图，无法对照`
                            : `第 ${seq} 页 · 点开看原文 / 译文对照`
                        }
                      >
                        <span className="page-thumb">
                          <Thumb
                            path={state === 'done' && gridView ? gridView.imagePath(seq, 'translated') : ''}
                            seq={seq}
                            state={state}
                          />
                          {/* 状态角标（设计稿 `.page-stamp`）：右上角一枚小标签 */}
                          <span className={`page-stamp is-${state}`} title={GRID_HINT[state](seq)}>
                            {GRID_LABEL[state]}
                          </span>
                        </span>
                        <span className="page-label">
                          <b>
                            第 <span className="num">{seq}</span> 页
                          </b>
                          <em>{String(seq).padStart(3, '0')}.png</em>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="lib-foot-note">
                <span>
                  共 <span className="num">{seqMax}</span> 组
                  {gridPages > 1 ? (
                    <>
                      {' · 第 '}
                      <span className="num">{gridPage}</span> / <span className="num">{gridPages}</span> 页
                    </>
                  ) : null}
                </span>
                {gridPages > 1 ? (
                  <span className="lib-grid-pager">
                    <Btn kind="ghost" size="sm" disabled={gridPage <= 1} onClick={() => onGridPage(gridPage - 1)}>
                      上一页
                    </Btn>
                    <Btn
                      kind="ghost"
                      size="sm"
                      disabled={gridPage >= gridPages}
                      onClick={() => onGridPage(gridPage + 1)}
                    >
                      下一页
                    </Btn>
                  </span>
                ) : (
                  <span>点任意一格看原文 / 译文对照</span>
                )}
              </div>
            </>
          )}
        </>
      ) : (
        <Notice>
          {searching
            ? `没有匹配「${query}」的漫画或话。换个关键词，或清空搜索。`
            : '漫画库还是空的。点工具条的「新建漫画」创建一个，或从「本机投放」送翻译成品进来。'}
        </Notice>
      )}
    </section>
  );
}
