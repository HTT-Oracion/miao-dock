// 漫画库右栏：搜索分组态 / 详情头 + 屏 B 话列表 / 屏 A·C 页网格 + 空库提示。
//
// 为什么从 `LibraryScreen.tsx` 抽出来（D-152）：与左栏（`LeftRail.tsx`）对称 ——
// 屏本体的 return 由「左栏 + 右栏 + 一排弹窗」三块组成，前两块各自成件后
// 屏本体只剩状态与编排。只传 props（守本仓「零 Context」）。
import { useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  Copy,
  FileText,
  FolderOpen,
  GitMerge,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { Btn, ContextMenu, Empty, IconButton, MenuItem } from '@components/units';
import { groupSearchResults } from '@tools';
import { ChapterCard, chapterStatusOf } from '@screens/manga/chapters';
import type { ChapterState } from '@screens/manga/chapters';
import { EmptyArt, GRID_HINT, GRID_LABEL, Highlight, Thumb } from '@screens/manga/cards';
import type { GridState } from '@screens/manga/cards';
import { AUTHOR_FALLBACK } from '@screens/manga/libModel';
import type { PageView } from '@screens/manga/blob';
import type { BookEntry, ChapterEntry, ComicEntry } from '@/types';
import { errorText } from '@/ipc';
import { toastBus } from '@/stores/toastBus';

/**
 * 搜索行状态徽标的修饰类（与话卡同一套判定：`chapterStatusOf` 给状态词，这里只选色档）。
 *
 * 单独一张表而不是在 JSX 里写嵌套三元：四种状态 → 四个修饰类，
 * 内联写成三元链既难读，加第五种状态时还会悄悄落进 `else` 分支。
 */
const SEARCH_BADGE: Record<ChapterState, string> = {
  done: 'st-badge is-ok',
  pending: 'st-badge is-warn',
  missing: 'st-badge is-bad',
  empty: 'st-badge is-idle',
};

export function LibraryRight({
  searching,
  query,
  searchGroups,
  foldedGroups,
  onToggleFolded,
  onActive,
  onOpenChapterNo,
  onMerge,
  onGoDrop,
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
  onEditBook,
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
  /** 搜索分组（设计稿屏 A′ 的右栏内容）；`hasLayers` 为假时为空数组 */
  searchGroups: ReturnType<typeof groupSearchResults>;
  foldedGroups: Set<string>;
  onToggleFolded: (key: string) => void;
  /** 点分组标题右侧「打开书架」：选中这一本 */
  onActive: (key: string) => void;
  /** 点搜索命中的一话：选中它所属的书并进入那一话 */
  onOpenChapterNo: (no: number) => void;
  /** 未归并单话行尾的「归并」 */
  onMerge: (dirName: string) => void;
  onGoDrop: () => void;
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
  onRetranslate: (base: string, name: string, seqs?: number[]) => void;
  /** 打开「编辑信息」弹窗（改封面 / 作者）。详情头与左栏右键菜单同一个出口 */
  onEditBook: (book: BookEntry) => void;
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
  /*
   * 搜索分组态（设计稿 §7.2 屏 A′）的「有没有找到」判定。
   *
   * 用 `searchGroups.length` 而不是 `hasLayers`：没有分层数据的旧服务端不产分组，
   * 那时搜索态该退回左栏平铺过滤，右栏显示"没找到"会把旧服务端判成空库。
   */
  const hasGroups = searchGroups.length > 0;

  /**
   * 页卡右键菜单（设计稿 `.page-card` 的菜单：查看对照 / 重新翻译本页 / 复制文件名 / 打开所在目录）。
   *
   * 左键点页卡 = 看对照（更直接，保留）；右键给"同一页上的其它动作"。
   * 位置取光标坐标，与书架 / 话卡的右键菜单同一套 `ContextMenu`。
   */
  const [pageMenu, setPageMenu] = useState<{ x: number; y: number; seq: number } | null>(null);

  /** 页文件名的命名口径：序号补零 3 位 + `.png`（与服务端落盘一致） */
  const pageFileName = (seq: number) => `${String(seq).padStart(3, '0')}.png`;

  /** 页所在目录：话内取该话的 absDir，整本取书目录（拿不到就禁用那一项，不猜） */
  const pageDir = (() => {
    if (!gridView) return '';
    if (inChapter) {
      const no = Number(gridView.base.split('/').pop());
      return chapterRows.find((c) => c.no === no)?.absDir ?? '';
    }
    return currentBook?.outputDir ?? '';
  })();

  return (
    <section className="lib-right">
      {searching ? (
        /* ── 屏 A′：搜索结果分组态（右栏）───────────────────────────── */
        hasGroups ? (
          <>
            <div className="search-result-head">
              <div>
                <h2 title={query}>搜索「{query}」</h2>
                <p>
                  <span className="num">{searchGroups.length}</span> 本作品 ·{' '}
                  <span className="num">{searchGroups.reduce((s, g) => s + g.rows.length, 0)}</span> 个话命中
                </p>
              </div>
              {/* 「清除搜索」在左栏脚与搜索框的 ✕ 上已有一份，这里不再重复第三个入口 */}
            </div>

            <div>
              {searchGroups.map((g) => {
                const folded = foldedGroups.has(g.key);
                return (
                  <div className="search-group" key={g.key}>
                    <div className="search-group-head">
                      <Btn
                        kind="bare"
                        className="search-group-main"
                        onClick={() => onToggleFolded(g.key)}
                        title={g.title}
                      >
                        <ChevronDown size={12} className={folded ? 'ico is-collapsed' : 'ico'} />
                        <span className="book-thumb" aria-hidden="true">
                          {Array.from(g.merged ? g.key : '单')[0] ?? '?'}
                        </span>
                        <strong>
                          {/* 「其它」不加大类框，故不高亮书名号里的书名（它本来就不是书名） */}
                          {g.merged ? <Highlight text={g.title} query={query} /> : g.title}
                        </strong>
                        <span>
                          <span className="num">{g.rows.length}</span> 个话命中
                        </span>
                      </Btn>
                      {g.merged ? (
                        <Btn
                          kind="text"
                          className="book-jump"
                          title="打开这本漫画的书架"
                          onClick={() => onActive(g.key)}
                        >
                          打开书架
                        </Btn>
                      ) : null}
                    </div>
                    {folded ? null : (
                      <>
                        {g.merged ? null : (
                          <div className="other-hint">
                            未归并的单话会出现在这里，点「归并」把它挂到某本漫画的某一话。
                          </div>
                        )}
                        {g.rows.map((r) => {
                          const status = chapterStatusOf(r.target);
                          return (
                            <div className="search-result-row" key={r.key}>
                              <FileText size={13} className="ico" aria-hidden="true" />
                              <Btn
                                kind="bare"
                                className="sr-main"
                                title={r.label}
                                disabled={r.no === null}
                                onClick={() => {
                                  if (r.no === null) return; // 未归并单话没有话号，进不了屏 C
                                  onOpenChapterNo(r.no);
                                }}
                              >
                                <span className="sr-title">
                                  <Highlight text={r.label} query={query} />
                                </span>
                              </Btn>
                              <span className={SEARCH_BADGE[status.state]}>{status.text}</span>
                              <span className="sr-sub">
                                <span className="num">{r.target.translatedCount}</span> /{' '}
                                <span className="num">{r.target.imageCount}</span> 页
                              </span>
                              {r.mergeable ? (
                                <Btn
                                  kind="text"
                                  title="把这一话挂到某本漫画的某一话（物理移动，不可逆）"
                                  onClick={() => onMerge(r.target.dirName)}
                                >
                                  <GitMerge size={11} />
                                  归并
                                </Btn>
                              ) : null}
                            </div>
                          );
                        })}
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="cv-foot">
              <span>搜索命中会高亮 · 单话结果可以直接归并到另一本</span>
              <span className="spacer" />
              <span>Esc 退出搜索</span>
            </div>
          </>
        ) : (
          <Empty>
            <EmptyArt />
            <h3 className="empty-title">没有找到「{query}」</h3>
            <p className="empty-sub">试试漫画名、作者名，或直接输入话号。搜索结果会按「本 → 话」分组。</p>
            <div className="empty-actions">
              <Btn kind="primary" size="sm" onClick={onGoDrop}>
                去投放
              </Btn>
            </div>
          </Empty>
        )
      ) : current ? (
        <>
          {/*
            详情头（设计稿 `.book-hero`）：左侧大封面 96×130 + 右侧信息列
            （kicker / 标题 / 作者与更新时间 / 状态徽标 / 路径 / 动作）。
            旧写法是一行「标题 + 路径 + 刷新」，没有封面也没有状态徽标 ——
            用户看不出"这是哪部作品、译到什么程度"。
          */}
          <div className="book-hero">
            <div className="book-big-cover" aria-hidden="true">
              <span className="obi">{Array.from(headName).slice(0, 4).join('')}</span>
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
                    ? `《${currentBook.bookName}》 · 更新于 ${currentBook.modifiedAt ?? '—'}`
                    : `${currentBook.author || AUTHOR_FALLBACK} · 更新于 ${currentBook.modifiedAt ?? '—'}`}
                </p>
              ) : null}
              {currentBook && !inChapter ? (
                <div className="book-meta-chips">
                  <span className="st-badge is-idle">{currentBook.chapterCount} 话</span>
                  <span className="st-badge is-idle">{currentBook.totalPages} 页</span>
                  <span
                    className={
                      currentBook.totalPages > 0 &&
                      currentBook.chapters.reduce((s, c) => s + c.translatedCount, 0) >= currentBook.totalPages
                        ? 'st-badge is-ok'
                        : 'st-badge is-idle'
                    }
                  >
                    已译{' '}
                    {currentBook.totalPages > 0
                      ? Math.round(
                          (currentBook.chapters.reduce((s, c) => s + c.translatedCount, 0) / currentBook.totalPages) *
                            100,
                        )
                      : 0}
                    %
                  </span>
                  <span className="st-badge is-ok">在书架</span>
                </div>
              ) : null}
              <p className="book-path" title={headPath}>
                {headPath}
              </p>
              <div className="book-actions">
                {/*
                  详情头的三个动作（设计稿 `.book-actions`）：继续翻译（primary）/ 编辑信息 / 刷新。
                  「继续翻译」与「编辑信息」此前**只**在左栏右键菜单里 —— 详情头是用户看这本书
                  时最自然的落点，把主行动藏进右键菜单等于让他先猜。
                */}
                <Btn
                  kind="primary"
                  size="sm"
                  disabled={!currentBook || reworkingComics.has(currentBook.dirName)}
                  title={
                    currentBook && reworkingComics.has(currentBook.dirName)
                      ? '这本书已有任务在跑'
                      : '把还没译的页加进队列（已完成的页不动）'
                  }
                  onClick={() => {
                    if (!currentBook) return;
                    onResume(`/library/${encodeURIComponent(currentBook.bookName)}`, `《${currentBook.bookName}》`);
                  }}
                >
                  继续翻译
                </Btn>
                <Btn
                  kind="ghost"
                  size="sm"
                  disabled={!currentBook}
                  title="改封面（本地图片 / 取第 1 话首图 / 移除）与作者"
                  onClick={() => {
                    if (currentBook) onEditBook(currentBook);
                  }}
                >
                  编辑信息
                </Btn>
                <Btn kind="ghost" size="sm" onClick={onRefresh} title="重新扫描漫画库">
                  <RefreshCw size={14} />
                  刷新
                </Btn>
              </div>
            </div>
          </div>

          {currentBook && !inChapter ? (
            /* ── 屏 B：话列表（设计稿 §7.3）── 话卡是文字卡（第 N 话 / 页数 / 进度条） */
            <>
              <div className="book-section-head">
                <h3>章节</h3>
                <span className="count">
                  共 <span className="num">{currentBook.chapters.length}</span> 话 · 点卡片进入页列表
                </span>
                {/*
                  整本重译（设计稿「重译整本」）：与话卡的「重译本话」是同一个端点，
                  只是 base 换成整本。放在章节区标题右侧 —— 它作用于这本书的全部话，
                  放进某一话的菜单里会被读成"只影响这一话"。
                */}
                <Btn
                  kind="ghost"
                  size="sm"
                  className="book-retranslate"
                  disabled={reworkingComics.has(currentBook.dirName)}
                  title="重跑这本书的全部页（覆盖已有译文，原图不动）"
                  onClick={() =>
                    onRetranslate(`/library/${encodeURIComponent(currentBook.bookName)}`, `《${currentBook.bookName}》`)
                  }
                >
                  重译整本
                </Btn>
              </div>

              <div className="chapter-grid">
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

              {/*
                这本书还没有任何话时的空态（设计稿 `.chapter-empty`）：
                此前这里什么都不渲染 —— 用户看到的是一片空白区域，
                分不清"这本书确实没话"还是"列表加载失败"。
              */}
              {chapterRows.length === 0 ? (
                <Empty
                  sub="去「投放」拖入图片，完成后会自动出现在这里。"
                  actions={
                    <Btn kind="primary" size="sm" onClick={onGoDrop}>
                      去投放
                    </Btn>
                  }
                >
                  这本漫画还没有章节
                </Empty>
              ) : null}

              <div className="cv-foot">
                <span>
                  共 <span className="num">{currentBook.chapters.length}</span> 话 ·{' '}
                  <span className="num">{currentBook.totalPages}</span> 页
                  {chPages > 1 ? (
                    <>
                      {' · 第 '}
                      <span className="num">{chPage}</span> / <span className="num">{chPages}</span> 页
                    </>
                  ) : null}
                </span>
                <span className="spacer" />
                {chPages > 1 ? (
                  <span className="cv-top-pager">
                    <Btn kind="ghost" size="sm" disabled={chPage <= 1} onClick={() => onChPage(chPage - 1)}>
                      上一页
                    </Btn>
                    <Btn kind="ghost" size="sm" disabled={chPage >= chPages} onClick={() => onChPage(chPage + 1)}>
                      下一页
                    </Btn>
                  </span>
                ) : (
                  <span>右键书架或话卡片可以管理</span>
                )}
              </div>
            </>
          ) : (
            /* ── 屏 A（整本 / 未归并单话）与屏 C（话内页）：同一套页网格渲染 ──
                两处只差投影（gridView），格子本身零差别 */
            <>
              {/*
                话内头部（设计稿 `.cv-head`）：返回话列表 + 标题 + 动作，底部虚线分隔。
                只在话内出现 —— 屏 A（整本）没有"上一级"可返回，不该出现返回键。
              */}
              {inChapter ? (
                <>
                  <div className="cv-head">
                    <Btn kind="bare" className="cv-back" onClick={onExitChapter} title="返回这一部的话列表">
                      <ArrowLeft size={14} />
                      返回话列表
                    </Btn>
                    <div className="cv-title">
                      <strong>{headName}</strong>
                      <span>
                        《{currentBook?.bookName ?? ''}》 · <span className="num">{seqMax}</span> 页
                      </span>
                    </div>
                    <div className="cv-actions">
                      <Btn kind="ghost" size="sm" onClick={onRefresh}>
                        <RefreshCw size={13} />
                        刷新
                      </Btn>
                    </div>
                  </div>
                  {/* 话信息（设计稿 `.cv-info`）：状态徽标 + 已译进度 + 更新时间 */}
                  <div className="cv-info">
                    <span className="st-badge is-idle">
                      <span className="num">{translatedSeqs.size}</span> /{' '}
                      <span className="num">{gridSeqs.length}</span> 页已译
                    </span>
                    {missingSeqs.size > 0 ? (
                      <span className="st-badge is-warn">
                        缺 <span className="num">{missingSeqs.size}</span> 页
                      </span>
                    ) : null}
                  </div>
                </>
              ) : null}

              <div className="page-grid">
                {gridSeqs.map((seq) => {
                  const state: GridState = missingSeqs.has(seq)
                    ? 'missing'
                    : translatedSeqs.has(seq)
                      ? 'done'
                      : 'pending';
                  return (
                    <Btn
                      key={seq}
                      kind="bare"
                      /*
                       * 页卡（设计稿 `.page-card`）：宽度交给网格（`minmax(112px,1fr)`），
                       * 缩略图用 `aspect-ratio: 3/4.16` 自适应 —— 不再写死 110×165。
                       * 写死尺寸时，窗口一变宽右栏就留一大片空白，且每格宽度与网格列宽脱节。
                       */
                      className={state === 'missing' ? 'page-card is-missing' : 'page-card'}
                      disabled={state === 'missing'}
                      onClick={() => onCompare(seq)}
                      onContextMenu={(e) => {
                        // 缺页也允许右键：至少能「复制文件名」去核对目录
                        e.preventDefault();
                        setPageMenu({ x: e.clientX, y: e.clientY, seq });
                      }}
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
                    </Btn>
                  );
                })}
              </div>

              <div className="cv-foot">
                <span>
                  共 <span className="num">{seqMax}</span> 页
                  {gridPages > 1 ? (
                    <>
                      {' · 第 '}
                      <span className="num">{gridPage}</span> / <span className="num">{gridPages}</span> 页
                    </>
                  ) : null}
                </span>
                <span className="spacer" />
                {gridPages > 1 ? (
                  <span className="cv-top-pager">
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
                  <span>点任意一页查看原文 / 译文对照 · 缺页不可打开</span>
                )}
              </div>
            </>
          )}
        </>
      ) : (
        <Empty>
          <EmptyArt />
          <h3 className="empty-title">漫画库还是空的</h3>
          <p className="empty-sub">投放几张漫画图片，翻译完成后作品会自动按「本 → 话 → 页」整理在这里。</p>
          <div className="empty-actions">
            <Btn kind="primary" size="sm" onClick={onGoDrop}>
              去投放
            </Btn>
          </div>
        </Empty>
      )}

      {/* 页卡右键菜单：位置取光标，菜单内容与书架 / 话卡同属一套 `.ui-ctx` */}
      {pageMenu ? (
        <ContextMenu x={pageMenu.x} y={pageMenu.y} onClose={() => setPageMenu(null)}>
          {(close) => {
            const seq = pageMenu.seq;
            const name = pageFileName(seq);
            const missing = missingSeqs.has(seq);
            return (
              <>
                <MenuItem
                  icon={<BookOpen size={13} />}
                  label="查看对照"
                  disabled={missing}
                  title={missing ? '这一页在本机没有原图，无法对照' : `看第 ${seq} 页的原文 / 译文对照`}
                  onClick={() => {
                    close();
                    onCompare(seq);
                  }}
                />
                <MenuItem
                  icon={<RotateCcw size={13} />}
                  label="重新翻译本页"
                  sub={`第 ${seq} 页`}
                  disabled={missing || !gridView}
                  title={missing ? '缺页无法重译，请重新投放这张图片' : `只重译第 ${seq} 页`}
                  onClick={() => {
                    close();
                    if (gridView) onRetranslate(gridView.base, gridView.comicName, [seq]);
                  }}
                />
                <MenuItem
                  icon={<Copy size={13} />}
                  label="复制文件名"
                  sub={name}
                  onClick={() => {
                    close();
                    void navigator.clipboard
                      .writeText(name)
                      .then(() => toastBus.push('已复制文件名', 'good', name))
                      .catch((e: unknown) => toastBus.push('复制失败', 'bad', errorText(e)));
                  }}
                />
                <MenuItem
                  icon={<FolderOpen size={13} />}
                  label="打开所在目录"
                  disabled={!pageDir}
                  title={pageDir ? pageDir : '拿不到这一页的目录'}
                  onClick={() => {
                    close();
                    if (pageDir) onOpenDir(pageDir);
                  }}
                />
              </>
            );
          }}
        </ContextMenu>
      ) : null}
    </section>
  );
}
