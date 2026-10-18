// 漫画库屏的**状态与派生收口**：25 个 useState + 全部 useMemo 派生 + 随之而来的副作用。
//
// 为什么从 `LibraryScreen.tsx` 抽出来（D-154）：屏本体 830 行里，绝大部分是"把 lib 投影成
// 一堆可渲染的值"（items / searchGroups / gridView / chapterRows / …）与它们的重置副作用，
// 与"渲染什么、点了做什么"是两件事。抽成钩子后屏本体只剩**动作 + JSX**。
//
// 返回的是"模型"：状态值、setter、派生值。动作（增删改 / 菜单）仍留在屏本体 ——
// 它们要发请求、要弹 toast，属于"用户做了什么"，不是"数据长什么样"。
import { useEffect, useMemo, useState } from 'react';
import { useToasts } from '@hooks';
import { useDebouncedValue } from '@hooks/useDebouncedValue';
import { apiGet, isApiError } from '@/ipc';
import { fuzzyMatch, groupSearchResults, pageCount, pageSlice } from '@tools';
import type { BookEntry, ChapterEntry, ComicEntry, LibraryResponse, RetranslatePlan, TaskRow } from '@/types';
import { bookFirstImagePath, chapterFilePath, coverPath, filePath, topLevelFirstImagePath } from '@screens/manga/blob';
import type { PageView } from '@screens/manga/blob';
import { CHAPTER_PAGE_SIZE, GRID_PAGE_SIZE, LIB_PAGE_SIZE } from '@screens/manga/libModel';
import type { LibItem } from '@screens/manga/libModel';

export function useLibraryModel({
  lib,
  tasks,
  focus,
  onFocusHandled,
  newBookSignal,
  onNewBookHandled,
  refreshKey,
}: {
  lib: LibraryResponse | null;
  tasks: TaskRow[];
  focus?: string | null;
  onFocusHandled?: () => void;
  newBookSignal?: boolean;
  onNewBookHandled?: () => void;
  refreshKey: number;
}) {
  /** 整本 / 未归并单话的投影：取图走**顶层**端点（与旧口径一致） */
  function flatViewOf(c: ComicEntry): PageView {
    return {
      base: `/library/${encodeURIComponent(c.comicName)}`,
      comicName: c.comicName,
      seqMax: c.seqMax,
      translatedSeqs: c.translatedSeqs,
      missingSeqs: c.missingSeqs,
      imagePath: (seq, variant) => filePath(c.comicName, seq, variant),
    };
  }

  /** 大类里一话的投影：取图走**话级**端点（`GET /library/{书}/chapters/{话}/files/{seq}`） */
  function chapterViewOf(b: BookEntry, ch: ChapterEntry): PageView {
    // 屏 C 的入口（话卡）对 `no === null` 是禁用的，走到这里话号必在；`?? 0` 只是让类型闭合
    const no = ch.no ?? 0;
    return {
      base: `/library/${encodeURIComponent(b.bookName)}/chapters/${no}`,
      comicName: `${b.bookName} · 第 ${no} 话`,
      seqMax: ch.seqMax,
      translatedSeqs: ch.translatedSeqs,
      missingSeqs: ch.missingSeqs,
      imagePath: (seq, variant) => chapterFilePath(b.bookName, no, seq, variant),
    };
  }

  const { push: onToast } = useToasts();
  const [active, setActive] = useState<string | null>(null);
  const [compareSeq, setCompareSeq] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // 返工：计划（能不能返工 / 会覆盖几张）+ 提交中
  const [rtPlan, setRtPlan] = useState<RetranslatePlan | null>(null);
  const [rtBusy, setRtBusy] = useState(false);
  // 搜索 / 分页 / 删除 / 隐藏管理
  // 输入框受控值是原始态（保证按键即时回显），过滤用防抖后的值 —— 见 filtered 下方注释
  const [queryInput, setQueryInput] = useState('');
  const query = useDebouncedValue(queryInput, 200);
  const [libPage, setLibPage] = useState(1);
  const [gridPage, setGridPage] = useState(1);
  /**
   * 屏 C 正在看的**话号**（`null` = 不在话内）。仅当当前选中是大类时才有意义：
   * 未归并单话没有话，右栏直接是页网格（屏 A）。
   */
  const [chapterNo, setChapterNo] = useState<number | null>(null);
  /** 屏 B（话列表）的分页；与页网格分页各自独立 —— 两屏来回翻页互不干扰 */
  const [chPage, setChPage] = useState(1);
  /**
   * 待删除的目标 + **删除口径**（大类 = 删除整本；未归并单话 = 删除本话）。
   *
   * 两种口径走的是同一个端点（`POST /library/{name}/delete`，主语都是顶层目录），
   * 分开的只是**说法** —— 单话没有"整本"可言，话都删了当然就是删这一话；
   * 弹窗标题跟着口径走，否则用户在删单话时看到「删除整本」会以为自己删多了。
   */
  const [toDelete, setToDelete] = useState<{ comic: ComicEntry; kind: '整本' | '本话' } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [unhiding, setUnhiding] = useState(false);
  // 三个新增弹窗：新建 / 编辑信息 / 归并（各自一个"是否打开"+ 一个提交中标记）
  const [newBookOpen, setNewBookOpen] = useState(false);
  const [editBook, setEditBook] = useState<BookEntry | null>(null);
  /** 归并弹窗的**源目录名**（左栏单话 / 右键菜单「归并到」共用这一个入口） */
  const [mergeTarget, setMergeTarget] = useState<string | null>(null);
  /** 编辑话数弹窗：改某本已归并话的话号（话卡菜单入口） */
  const [editNoChapter, setEditNoChapter] = useState<{ bookName: string; chapter: ChapterEntry } | null>(null);
  const [creating, setCreating] = useState(false);
  const [savingMeta, setSavingMeta] = useState(false);
  const [merging, setMerging] = useState(false);
  const [renumbering, setRenumbering] = useState(false);
  /**
   * 右键菜单（漫画操作的家）：记录**被右键的那一项**与弹出坐标。
   *
   * 头部按钮只留「刷新」之后，打开目录 / 续做 / 返工 / 编辑信息 / 删除这些动作全部
   * 迁到这里 —— 右键的是**哪一项就操作哪一项**，与"当前选中"无关（右键不改选中，
   * 这是文件管理器的通用惯例；混在一起会出现"右键 A 却删了 B"的事故）。
   */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; item: LibItem } | null>(null);
  /** 搜索态里被收起的**分组键**集合（设计稿 §7.2：折叠不跨搜索保留，见下方 effect） */
  const [foldedGroups, setFoldedGroups] = useState<Set<string>>(() => new Set());

  const comics = lib?.comics ?? [];
  const hidden = lib?.hidden ?? [];
  const books = lib?.books ?? [];
  const others = lib?.others ?? [];

  /**
   * 服务端是否给了分层数据（`books` / `others`）。
   *
   * 旧服务端只回 `comics`。没有这条兜底，升级到新版面前端的用户会看到**空左栏**
   * —— 那看起来像"漫画全丢了"，而实际只是少了一个字段。
   */
  const hasLayers = books.length > 0 || others.length > 0;

  /**
   * 左栏（浏览态）的行数据。
   *
   * 排序按 `key`（= 目录名，`zh-Hans-CN`）—— 与服务端对 `comics` 的排序**同一口径**，
   * 于是左栏顺序与前端的"上一页 / 下一页"、`focus` 定位的行号计算仍然一致。
   */
  const items = useMemo<LibItem[]>(() => {
    const build: LibItem[] = hasLayers
      ? [
          ...books.map<LibItem>((b) => ({
            key: b.bookName,
            name: b.bookName,
            author: b.author,
            chapterCount: b.chapterCount,
            pageCount: b.totalPages,
            // 有封面用封面，没有就退回首话首图（设计稿 §7.1 左）
            thumbPath: b.coverPath ? coverPath(b.bookName, b.modifiedAt) : bookFirstImagePath(b.bookName, b.chapters),
            merged: true,
          })),
          ...others.map<LibItem>((o) => ({
            key: o.dirName,
            name: o.dirName,
            // 未归并单话没有 manifest ⇒ 没有作者（显示「未署名」）
            author: '',
            chapterCount: 1,
            pageCount: o.imageCount,
            thumbPath: topLevelFirstImagePath(o.dirName, o),
            merged: false,
          })),
        ]
      : comics.map<LibItem>((c) => ({
          key: c.comicName,
          name: c.comicName,
          author: '',
          chapterCount: 1,
          pageCount: c.imageCount,
          thumbPath: topLevelFirstImagePath(c.comicName, c),
          merged: false,
        }));
    return build.sort((a, b) => a.key.localeCompare(b.key, 'zh-Hans-CN'));
  }, [hasLayers, books, others, comics]);

  const searching = query.trim().length > 0;

  /**
   * 搜索态（屏 A′）的分组结果。
   *
   * 只在有分层数据时按「本 → 话」分组；否则退回按 `comics` 平铺过滤 ——
   * 分组的前提是有「话」，旧服务端给不出话，硬分组只会得到一堆空组。
   */
  const searchGroups = useMemo(
    () => (searching && hasLayers ? groupSearchResults(books, others, query) : []),
    [searching, hasLayers, books, others, query],
  );
  /** 无分层的旧服务端：搜索态仍是平铺过滤（与改造前的行为一致） */
  const flatHits = useMemo(
    () => (searching && !hasLayers ? items.filter((it) => fuzzyMatch(it.name, query)) : []),
    [searching, hasLayers, items, query],
  );

  // 逐键过滤很便宜，但过滤会改 `current`，进而重挂载右栏网格、重拉整页缩略图。
  // 故喂给过滤的是**防抖后的 query**：连续输入期间只回显、不级联，停手 200ms 才过滤一次。
  const filtered = useMemo(() => comics.filter((c) => fuzzyMatch(c.comicName, query)), [comics, query]);
  const libPages = pageCount(filtered.length, LIB_PAGE_SIZE);
  // 行数变少（搜索结果变窄 / 删完一部）→ 把页码夹回合法区间，否则停在空白页
  useEffect(() => {
    setLibPage((p) => (p > libPages ? libPages : p));
  }, [libPages]);
  // 换搜索词从头看（分组折叠也一并复位：设计稿 §7.2 要求「折叠状态不跨搜索保留」）
  useEffect(() => {
    setLibPage(1);
    setFoldedGroups(new Set());
  }, [query]);
  const libRows = useMemo(() => pageSlice(filtered, libPage, LIB_PAGE_SIZE), [filtered, libPage]);

  /**
   * 外部定位（队列行「查看」带来的 `focus`）。
   *
   * 三步缺一不可：① 选中该漫画；② 清掉搜索词（否则它可能被当前过滤条件滤掉，选中即失效）；
   * ③ 把左栏翻到它所在的那一页（否则高亮落在一页之外的列表上，看着像"没定位"）。
   * 消费一次即 `onFocusHandled()`，上层据此清空 focus —— 否则之后每次手动浏览都会被拉回来。
   *
   * 依赖只写 `focus`：这是"一次性的定位指令"，取挂载/变更当帧的 `filtered` 快照即可。
   */
  useEffect(() => {
    if (!focus) return;
    const idx = filtered.findIndex((c) => c.comicName === focus || c.dirName === focus);
    if (idx >= 0) {
      setActive(filtered[idx]!.comicName);
      setQueryInput('');
      setLibPage(Math.floor(idx / LIB_PAGE_SIZE) + 1);
    }
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  /**
   * 工具条「新建漫画」→ 开弹窗。
   *
   * 与 `focus` 同构的一次性信号：消费一次即回调清空，否则之后每次重挂载都会自动弹出来。
   * 这里**不**清搜索词也不改选中态 —— 新建成功后由 `createBook()` 自己去选中新项。
   */
  useEffect(() => {
    if (!newBookSignal) return;
    setNewBookOpen(true);
    onNewBookHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newBookSignal]);

  // 当前选中：优先沿用 active；它被搜索滤掉时落到第一项。搜索结果为空则无选中。
  const current = useMemo(() => {
    if (filtered.length === 0) return null;
    return filtered.find((c) => c.comicName === active) ?? libRows[0] ?? filtered[0] ?? null;
  }, [filtered, active, libRows]);

  // 切库或刷新后，若当前选中的漫画没了就回到第一本
  useEffect(() => {
    if (current && current.comicName !== active) setActive(current.comicName);
  }, [current, active]);

  /**
   * 当前选中的**大类**；选中的是未归并单话时为 `null`。
   *
   * 「编辑信息」只对大类成立 —— 未归并单话在磁盘上没有 `manifest.json`，
   * 拿它去调 `POST /meta` 会被 `resolveBookDir` 以 404 拒绝。置灰比"点了才被拒"好。
   */
  const currentBook = useMemo(
    () => books.find((b) => b.bookName === (current?.comicName ?? '')) ?? null,
    [books, current],
  );

  // 换一部漫画 → 话内定位与两套分页一并归零（话号留着会指向另一部的话，必清）
  useEffect(() => {
    setChapterNo(null);
    setGridPage(1);
    setChPage(1);
  }, [current?.comicName]);
  // 换一话 → 页网格回第一页
  useEffect(() => {
    setGridPage(1);
  }, [chapterNo]);

  /**
   * 当前选中的**话**（屏 C 的数据源）。话号在但话没了（刷新后目录被动过）⇒ `null`，
   * 调用方按「不在话内」处理、退回屏 B —— 而不是白屏。
   */
  const currentChapter = useMemo(
    () => (currentBook && chapterNo !== null ? (currentBook.chapters.find((c) => c.no === chapterNo) ?? null) : null),
    [currentBook, chapterNo],
  );
  /** 是否在话内（屏 C）。`currentChapter` 非空 ⇒ `currentBook` 也非空，二者同涨同落 */
  const inChapter = currentBook !== null && currentChapter !== null;

  /**
   * 页网格（屏 A / 屏 C）与对照视图（屏 D）的投影。
   *
   * 只有两处有"逐页"这回事：整本 / 未归并单话（屏 A，顶层取图）与话内（屏 C，话内取图）。
   * 大类本身（屏 B）没有页 —— 页的宿主是它的话，故这里返回 `null`，右栏改渲染话卡。
   */
  const gridView = useMemo<PageView | null>(() => {
    if (currentBook) return currentChapter ? chapterViewOf(currentBook, currentChapter) : null;
    return current ? flatViewOf(current) : null;
  }, [currentBook, currentChapter, current]);

  const seqMax = gridView?.seqMax ?? 0;
  const gridPages = pageCount(seqMax, GRID_PAGE_SIZE);
  useEffect(() => {
    setGridPage((p) => (p > gridPages ? gridPages : p));
  }, [gridPages]);
  const gridSeqs = useMemo(
    () =>
      pageSlice(
        Array.from({ length: seqMax }, (_, i) => i + 1),
        gridPage,
        GRID_PAGE_SIZE,
      ),
    [seqMax, gridPage],
  );

  // 逐页判定用集合，不用张数（G-10）。`?? []` 只是防御：服务由本应用自己拉起，
  // 正常情况下这两个字段一定在；真缺了也只是退化成「全部待译」，不会白屏。
  const translatedSeqs = useMemo(() => new Set(gridView?.translatedSeqs ?? []), [gridView]);
  const missingSeqs = useMemo(() => new Set(gridView?.missingSeqs ?? []), [gridView]);

  // 屏 B 话列表的分页（与左栏同一手法：行数变少时夹回合法区间）
  const chPages = pageCount(currentBook?.chapters.length ?? 0, CHAPTER_PAGE_SIZE);
  useEffect(() => {
    setChPage((p) => (p > chPages ? chPages : p));
  }, [chPages]);
  const chapterRows = useMemo(
    () => pageSlice(currentBook?.chapters ?? [], chPage, CHAPTER_PAGE_SIZE),
    [currentBook, chPage],
  );

  /**
   * 当前生效的**操作目标**：头部菜单「继续翻译 / 重新翻译」与两条计划端点打向哪里。
   *
   * 屏 C（话内）→ 该话；其余（屏 A / 屏 B）→ 选中的顶层目录。三者的端点形态完全相同
   * （`{base}/resume`、`{base}/retranslate`）—— 服务端内部才区分"目录怎么来的"
   * （顶层名 vs `书/NN_第N话` 相对路径），前端只换基址，不换逻辑。
   */
  const actionBase = inChapter
    ? `/library/${encodeURIComponent(currentBook.bookName)}/chapters/${chapterNo}`
    : `/library/${encodeURIComponent(current?.comicName ?? '')}`;
  /** 头部卡的标题与路径：话内显示话号 + 该话目录，否则显示目录名 + 顶层目录 */
  const headName = inChapter ? `第 ${chapterNo} 话` : (current?.comicName ?? '');
  const headPath = inChapter ? (currentChapter?.absDir ?? '') : (current?.outputDir ?? '');

  // 选中目标后拉一次「缺页清单」，用于给「继续翻译」置灰 / 显示待续做张数（话内即该话的）
  useEffect(() => {
    if (!current) {
      setPending(null);
      return;
    }
    let alive = true;
    apiGet<{ pendingCount: number }>(`${actionBase}/resume`)
      .then((p) => {
        if (alive) setPending(p.pendingCount);
      })
      .catch((e: unknown) => {
        // 目录不存在（404）等价于「没有待续做的页」
        if (alive) setPending(isApiError(e) && e.status === 404 ? 0 : null);
      });
    return () => {
      alive = false;
    };
  }, [current, actionBase, refreshKey]);

  /**
   * 该漫画是否**已有任务在队列里**（queued / running）。
   *
   * 为什么前端自己算而不是让服务端给：任务列表本来就在 `App` 手里每秒刷新，
   * 服务端再扫一遍 `this.tasks` 是重复劳动。判据用 `dirName`（归一化后的目录名）
   * 而不是 `comicName` —— 库里显示的是原始漫画名，落盘用的是归一化名，两者可能差一个
   * 空格/大小写；拿原始名去比会漏判，于是已经排队的漫画还能再点一次返工，
   * 结果是同一本被两个任务前后脚跑、译文互相覆盖。
   */
  const reworkingComics = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) {
      if (t.status === 'queued' || t.status === 'running') set.add(t.normalizedComicName ?? t.comicName);
    }
    return set;
  }, [tasks]);

  // 选中目标后拉一次返工计划：告诉「操作」菜单能不能点、会覆盖几张（话内即该话的计划）
  useEffect(() => {
    if (!current) {
      setRtPlan(null);
      return;
    }
    let alive = true;
    apiGet<RetranslatePlan>(`${actionBase}/retranslate`)
      .then((p) => {
        // 把「是否在队列中」一并带上：计划是静态的，任务状态是动态的，分开拿会闪
        if (alive) setRtPlan({ ...p, reworking: reworkingComics.has(p.dirName) });
      })
      .catch((e: unknown) => {
        if (alive) setRtPlan(isApiError(e) && e.status === 404 ? null : null);
      });
    return () => {
      alive = false;
    };
  }, [current, actionBase, refreshKey, reworkingComics]);
  return {
    onToast,
    active,
    setActive,
    compareSeq,
    setCompareSeq,
    pending,
    busy,
    setBusy,
    rtPlan,
    rtBusy,
    setRtBusy,
    queryInput,
    setQueryInput,
    query,
    libPage,
    setLibPage,
    gridPage,
    setGridPage,
    setChapterNo,
    chPage,
    setChPage,
    toDelete,
    setToDelete,
    deleting,
    setDeleting,
    showHidden,
    setShowHidden,
    unhiding,
    setUnhiding,
    newBookOpen,
    setNewBookOpen,
    editBook,
    setEditBook,
    mergeTarget,
    setMergeTarget,
    editNoChapter,
    setEditNoChapter,
    creating,
    setCreating,
    savingMeta,
    setSavingMeta,
    merging,
    setMerging,
    renumbering,
    setRenumbering,
    ctxMenu,
    setCtxMenu,
    foldedGroups,
    setFoldedGroups,
    comics,
    hidden,
    books,
    hasLayers,
    items,
    searching,
    searchGroups,
    flatHits,
    libPages,
    current,
    currentBook,
    inChapter,
    gridView,
    seqMax,
    gridPages,
    gridSeqs,
    translatedSeqs,
    missingSeqs,
    chPages,
    chapterRows,
    headName,
    headPath,
    reworkingComics,
  };
}
