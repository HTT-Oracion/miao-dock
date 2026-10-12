import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  ArrowLeft,
  FolderUp,
  GitMerge,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPostMultipart, errorText, isApiError, openPath } from '@/ipc';
import { useToasts } from '@hooks';
import { LIBRARY } from '@/theme/tokens';
import type {
  BookEntry,
  ChapterEntry,
  ComicEntry,
  LibraryDeleteResponse,
  LibraryResponse,
  RetranslatePlan,
  RetranslateResponse,
  TaskRow,
} from '@/types';
import {
  chapterNoOf,
  fuzzyMatch,
  groupSearchResults,
  pageCount,
  pageSlice,
} from '@tools';
import { useDebouncedValue } from '@hooks/useDebouncedValue';
import { Btn, ContextMenu, IconButton, MenuItem, MenuSeparator, Notice } from '@components/units';
import {
  bookFirstImagePath,
  chapterFilePath,
  coverPath,
  filePath,
  topLevelFirstImagePath,
} from '@screens/library/blob';
import type { PageView } from '@screens/library/blob';
import { GRID_LABEL, Thumb } from '@screens/library/cards';
import type { GridState } from '@screens/library/cards';
import { ChapterCard } from '@screens/library/chapters';
import type { BookMetaIntent } from '@screens/library/modals';
import {
  DeleteComicModal, EditBookModal, EditChapterNoModal, HiddenComicsModal, MergeModal, NewBookModal,
} from '@screens/library/modals';
import { Compare } from '@screens/library/viewer';
import { retranslateMeta, resumeMeta } from '@screens/library/meta';
import { LeftRail } from '@screens/library/LeftRail';
import { AUTHOR_FALLBACK, LIB_PAGE_SIZE } from '@screens/library/libModel';
import type { LibItem } from '@screens/library/libModel';

/** 网格每页张数（110×165 卡 + 12 间距；24 张约两行多，翻页不至于太空） */
const GRID_PAGE_SIZE = 24;
/**
 * 屏 B 话列表每页话数（设计稿 §7.3 明写 `CHAPTER_PAGE_SIZE = 24`，与 `GRID_PAGE_SIZE` 同值）。
 *
 * 与网格分页同值不是巧合：话卡与页卡是**同一个 110×165 的格子**（设计稿 §7.3「沿用
 * `LIBRARY.card` 令牌，不新增几何」），所以每屏装得下的个数天然相同。两处各写一个数，
 * 迟早出现"话列表 24/页、页网格 30/页"这种没理由的不一致。
 */
const CHAPTER_PAGE_SIZE = 24;




// ------------------------------------------------------------------ 左栏视图件

/**
 * 左栏一项的**展示视图**：大类与未归并单话归一成同一形状，左栏与搜索分组共用。
 *
 * 为什么不直接用 `BookEntry`/`ChapterEntry`：左栏要显示的是「漫画」这一个概念
 * （「N 话 · M 页」），其中大类有作者有封面、未归并单话没有 —— 两个类型各写一条渲染分支
 * 就会长出两套几乎一样的 DOM。归一到 `LibItem` 后只有"取哪些字段"的差别，
 * 而那个差别已经由 `buildItems()` 一次性吸收掉了。
 */

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


/**
 * 画面 X-D1 · 本地漫画库（《02》§5.5）。
 *
 * 左栏 260 以漫画名为索引（目录即索引，不维护第二份），右栏为头行 + 110×165 网格卡。
 * 「继续翻译」走契约外增量的 `POST /library/{name}/resume`（spec-notes G-07）：
 * 它只补「有原图、缺译文」的页，且**不新增编号、不覆盖原图**。
 *
 * ## 本屏较原型的增量（保真度之外的可用性补充）
 * · **搜索**：左栏按漫画名模糊匹配（子序列、不区分大小写，见 util `fuzzyMatch`）。
 * · **分页**：左栏 + 网格各一套分页 —— 漫画可能上百部，单部漫画也可能上千页。
 * · **删除**：`POST /library/{name}/delete`，带勾选框决定是否连本地目录一起删。
 * · **刷新**：手动刷新按钮（翻译完成后的自动刷新由 App 的"任务收尾"信号负责）。
 * · **全屏看图**：点对照视图里任一张图。开图即「整张可见」（100% = 恰好铺满，不需滚动）；
 *   全屏内用 `Ctrl/⌘ + 滚轮`（向上放大、向下缩小）或工具栏 −/+ 缩放 50%–200%、
 *   放大后可拖拽或双指滑动平移，点图可收起/展开底部工具栏。
 * · **返工重译**：`POST /library/{name}/retranslate`，覆盖已有译文（原图永不覆盖）。
 */
export function LibraryScreen({
  lib,
  tasks,
  focus,
  onFocusHandled,
  newBookSignal,
  onNewBookHandled,
  onRefresh,
  refreshKey,
}: {
  lib: LibraryResponse | null;
  /** 队列快照，只用来判「该漫画是否已有任务在跑」（→ 显示返工中） */
  tasks: TaskRow[];
  /** 队列行「查看」带过来的漫画名：进入本屏后选中并翻到它那一页（消费一次即回调清空） */
  focus?: string | null;
  onFocusHandled?: () => void;
  /**
   * 工具条「新建漫画」按下的一次性信号。
   *
   * 为什么用信号而不是把弹窗 state 抬到 App：按钮长在 App 的工具条里，而弹窗的提交
   * 要 `onRefresh()`、要 `setActive()` —— 那些都在本屏。抬 state 上去等于把"漫画库的
   * 三个弹窗"劈成两半；信号只传"按过了"这一个事实，消费一次即清（与 `focus` 同构）。
   */
  newBookSignal?: boolean;
  onNewBookHandled?: () => void;
  onRefresh: () => void;
  refreshKey: number;
}): ReactElement {
  // 吐司单例总线：直接取用，不必由宿主透传（见 useToasts 注释）
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
            thumbPath: b.coverPath
              ? coverPath(b.bookName, b.modifiedAt)
              : bookFirstImagePath(b.bookName, b.chapters),
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
    () =>
      currentBook && chapterNo !== null
        ? currentBook.chapters.find((c) => c.no === chapterNo) ?? null
        : null,
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
    () => pageSlice(Array.from({ length: seqMax }, (_, i) => i + 1), gridPage, GRID_PAGE_SIZE),
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

  /**
   * 提交返工重译（`POST {base}/retranslate`；`base` 由调用方给 —— 整本、话两个层级同一形态）。
   *
   * 覆盖已有译文是**不可逆**的，所以回执必须说清"覆盖了几张"、覆盖的是**哪一本/哪一话**，
   * 而不是笼统报"已加入队列"—— 用户需要知道自己刚覆盖了什么。
   */
  const retranslate = async (base: string, name: string, seqs?: number[]) => {
    setRtBusy(true);
    try {
      const r = await apiPost<RetranslateResponse>(`${base}/retranslate`, seqs ? { seqs } : {});
      const scope = seqs ? `第 ${seqs.join('、')} 页` : `全部 ${r.retranslateCount} 张`;
      onToast(`已开始返工：${name} ${scope}（覆盖 ${r.overwriteCount} 张已有译文）`, 'good');
      setCompareSeq(null);
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setRtBusy(false);
    }
  };

  const resume = async (base: string, name: string) => {
    setBusy(true);
    try {
      const res = await apiPost<{ comicName: string; queuePosition: number }>(`${base}/resume`, {});
      onToast(`已加入队列：${name}（第 ${res.queuePosition} 位）`, 'good');
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (deleteFiles: boolean) => {
    const target = toDelete?.comic;
    if (!target) return;
    setDeleting(true);
    try {
      const r = await apiPost<LibraryDeleteResponse>(
        `/library/${encodeURIComponent(target.comicName)}/delete`,
        { deleteFiles },
      );
      if (r.deletedFiles) onToast(`已删除「${r.comicName}」及其本地目录`, 'good');
      else onToast(`已从库里移除「${r.comicName}」（本地文件保留，可在「已隐藏」里恢复）`, 'good');
      if (target.comicName === active) setActive(null);
      setCompareSeq(null);
      setToDelete(null);
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setDeleting(false);
    }
  };

  /** `LibItem.key` → 顶层目录条目（comics 含**所有**顶层目录，大类也在内） */
  const comicOf = (key: string): ComicEntry | null =>
    comics.find((c) => c.comicName === key) ?? null;

  const doUnhide = async (name: string) => {
    setUnhiding(true);
    try {
      await apiPost(`/library/${encodeURIComponent(name)}/unhide`, {});
      onToast(`已恢复「${name}」`, 'good');
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setUnhiding(false);
    }
  };

  /**
   * 新建漫画（`POST /library/create`）。
   *
   * 成功后的三步**缺一不可**：① 关弹窗；② 清搜索词；③ 选中新项。
   * ② 是必需的 —— 若搜索框里还留着"夏"，新建出来的《夏日》虽然已在库里，
   * 却可能被当前过滤条件挡在左栏之外，于是 `setActive` 选中了一个**看不见的项**，
   * 用户看到的仍是旧的那本（"点了创建什么都没发生"）。
   */
  const createBook = async (name: string, author: string) => {
    setCreating(true);
    try {
      const r = await apiPost<{ bookName: string }>('/library/create', { name, author });
      const created = r.bookName || name;
      onToast(`已创建《${created}》`, 'good');
      setNewBookOpen(false);
      setQueryInput('');
      setActive(created);
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setCreating(false);
    }
  };

  /**
   * 保存漫画信息（封面 + 作者）。
   *
   * 四种意图落到**三条**不同的端点上（契约如此，不是可以随便合并的）：
   * · `meta` / `cover-first` → `POST /meta`（后者带 `coverFromFirstChapter:true`）；
   * · `cover-local` → `POST /cover`（multipart 单文件，字段名 `cover`；作者随 `payload` 同一次写入）；
   * · `cover-remove` → `DELETE /cover`（**只有这一个动词**）—— 它按契约保留 `author`，
   *   所以"移除封面同时改作者"要再补一次 `POST /meta`。顺序不能颠倒：
   *   先删封面（失败就整个失败，作者不动），再写作者。
   */
  const saveMeta = async (intent: BookMetaIntent, author: string) => {
    const book = editBook;
    if (!book) return;
    const base = `/library/${encodeURIComponent(book.bookName)}`;
    setSavingMeta(true);
    try {
      if (intent.kind === 'cover-local') {
        await apiPostMultipart(`${base}/cover`, { author }, [intent.srcPath], 'cover');
      } else if (intent.kind === 'cover-remove') {
        await apiDelete(`${base}/cover`);
        await apiPost(`${base}/meta`, { author });
      } else if (intent.kind === 'cover-first') {
        await apiPost(`${base}/meta`, { author, coverFromFirstChapter: true });
      } else {
        await apiPost(`${base}/meta`, { author });
      }
      onToast(`已更新《${book.bookName}》的信息`, 'good');
      setEditBook(null);
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setSavingMeta(false);
    }
  };

  /**
   * 归并（`POST /library/{name}/merge`）。
   *
   * 目标已经占号时服务端回 409 `CHAPTER_NO_TAKEN`，弹窗会在**提交前**就把它拦成
   * 「改话号 / 顺延 / 取消」三选一，所以走到这里还撞上 409 只可能是库在这一瞬变了
   * —— 如实把服务端的话转给用户，别自己编一个。
   */
  const mergeInto = async (target: string, no: number) => {
    const src = mergeTarget;
    if (!src) return;
    setMerging(true);
    try {
      await apiPost(`/library/${encodeURIComponent(src)}/merge`, { target, no });
      onToast(`已归并为《${target}》第 ${no} 话`, 'good');
      setMergeTarget(null);
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setMerging(false);
    }
  };

  /**
   * 编辑话数（`POST /library/{book}/chapters/{no}/renumber`，2026-10-11 用户需求）。
   * 改号 = 服务端把话目录改名 + episodes 重建（页文件原地不动）；成功后刷新库 ——
   * 左栏计数、话卡角标、URL 缓存键（含话号）都会跟着新目录走。
   */
  const renumberChapter = async (bookName: string, chapter: ChapterEntry, no: number) => {
    if (chapter.no === null) return; // 无话号的目录拼不出话级端点，弹窗也不会为它打开
    setRenumbering(true);
    try {
      await apiPost(`/library/${encodeURIComponent(bookName)}/chapters/${chapter.no}/renumber`, { no });
      onToast(`已改为《${bookName}》第 ${no} 话`, 'good');
      setEditNoChapter(null);
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    } finally {
      setRenumbering(false);
    }
  };

  if (comics.length === 0 && hidden.length === 0) {
    return (
      <>
        <Notice>
          漫画库还是空的。点工具条的「新建漫画」创建一个，或从「本机投放」送翻译成品进来。
        </Notice>
        {/* ⚠️ 空库也要渲染「新建漫画」弹窗：工具条上的按钮在 App 里、永远可点，
            若这里直接 return 掉弹窗，用户点「新建漫画」会看到**什么都没发生** */}
        {newBookOpen ? (
          <NewBookModal
            root={lib?.root ?? ''}
            existing={[]}
            busy={creating}
            onCancel={() => setNewBookOpen(false)}
            onConfirm={(name, author) => void createBook(name, author)}
            onViewExisting={() => setNewBookOpen(false)}
          />
        ) : null}
      </>
    );
  }

  if (compareSeq !== null && gridView) {
    return (
      <Compare
        view={gridView}
        seq={compareSeq}
        retranslate={rtPlan}
        submitting={rtBusy}
        onSeq={setCompareSeq}
        onBack={() => setCompareSeq(null)}
        onRetranslate={(seqs) => void retranslate(gridView.base, gridView.comicName, seqs)}
      />
    );
  }

  // 「更多操作」菜单的两组文案：与 Compare 同源口径（见 retranslateMeta / resumeMeta）。
  // 头部不再放菜单后，它们服务的是**右键菜单里被选中的那一项**（是当前项时才有真数据）。
  const rtInfo = retranslateMeta(
    rtPlan,
    rtBusy,
    rtPlan?.reworking ?? false,
    rtPlan !== null && rtPlan.retranslateCount === 0,
  );
  const resumeInfo = resumeMeta(pending, busy);

  /**
   * 右键菜单的内容（漫画级动作的**唯一**入口）。
   *
   * 项序按「看得见的在前、破坏性的在后」：打开目录 / ─ / 继续翻译 / 重新翻译 /
   * 编辑信息（大类）或 归并到（单话）/ 删除（大类「删除整本」、单话「删除本话」）。
   *
   * 预检文案（待续做几张 / 会覆盖几张）只有**当前项**有（计划是为 current 拉的）；
   * 右键别的项时不预取 —— 动作本身会先选中语义地打向该项的端点，服务端是权威校验，
   * 拒绝的理由会经 `errorText` 进 Toast。为一个右键菜单给库里每项都拉一遍计划，不值。
   */
  const renderComicMenu = (it: LibItem, close: () => void): ReactElement => {
    const comic = comicOf(it.key);
    const base = `/library/${encodeURIComponent(it.key)}`;
    const isCur = it.key === current?.comicName;
    const busyRt = rtBusy || reworkingComics.has(it.key);
    const rtSub = isCur ? rtInfo.sub : busyRt ? '返工中' : undefined;
    const resSub = isCur ? resumeInfo.sub : undefined;
    /** 右键项对应的**大类**（编辑信息需要 manifest 数据，单话没有 ⇒ null） */
    const bookOfItem = it.merged ? (books.find((b) => b.bookName === it.key) ?? null) : null;
    return (
      <>
        <MenuItem
          icon={<FolderUp size={13} />}
          label="打开目录"
          disabled={!comic}
          title="在文件管理器里打开这个漫画的目录"
          onClick={() => {
            close();
            if (comic) openPath(comic.outputDir).catch((e: unknown) => onToast(errorText(e), 'bad'));
          }}
        />
        <MenuSeparator />
        <MenuItem
          icon={<Play size={13} />}
          label="继续翻译"
          sub={resSub}
          disabled={busy || (isCur && resumeInfo.disabled)}
          title={isCur ? resumeInfo.title : '把待译的页加入队列（只补缺的，不覆盖已有译文）'}
          onClick={() => {
            close();
            void resume(base, it.name);
          }}
        />
        <MenuItem
          icon={<RotateCcw size={13} />}
          label="重新翻译"
          sub={rtSub}
          disabled={busyRt || (isCur && rtInfo.blocked)}
          title={
            busyRt
              ? '该漫画已有任务在队列中，等它跑完再返工'
              : isCur
                ? rtInfo.title
                : '重新翻译全部页（覆盖已有译文，原图不动）'
          }
          onClick={() => {
            close();
            void retranslate(base, it.name);
          }}
        />
        {it.merged ? (
          <MenuItem
            icon={<Pencil size={13} />}
            label="编辑信息"
            disabled={!bookOfItem}
            title={
              bookOfItem
                ? '改封面（本地图片 / 取第 1 话首图 / 移除）与作者'
                : '漫画信息还没就绪，稍后再试'
            }
            onClick={() => {
              close();
              if (bookOfItem) setEditBook(bookOfItem);
            }}
          />
        ) : books.length > 0 ? (
          <MenuItem
            icon={<GitMerge size={13} />}
            label="归并到"
            sub="挂到某本漫画的某一话"
            title="把这一话物理移动进某个大类目录（不可逆）"
            onClick={() => {
              close();
              setMergeTarget(it.key);
            }}
          />
        ) : null}
        <MenuItem
          icon={<Trash2 size={13} />}
          label={it.merged ? '删除整本' : '删除本话'}
          danger
          disabled={!comic}
          title={
            it.merged
              ? '从漫画库删除整部漫画（可选择是否连本地文件一起删）'
              : '从漫画库删除这一话（可选择是否连本地文件一起删）'
          }
          onClick={() => {
            close();
            if (comic) setToDelete({ comic, kind: it.merged ? '整本' : '本话' });
          }}
        />
      </>
    );
  };

  /** 折叠 / 展开搜索结果里的一个分组（左栏自持 UI 态，但 updater 留在屏本体） */
  const toggleFolded = (key: string) => {
    setFoldedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="lib">
      <LeftRail
        queryInput={queryInput}
        onQueryInput={setQueryInput}
        query={query}
        searching={searching}
        hasLayers={hasLayers}
        searchGroups={searchGroups}
        flatHits={flatHits}
        items={items}
        activeKey={current?.comicName ?? null}
        onActive={setActive}
        foldedGroups={foldedGroups}
        onToggleFolded={toggleFolded}
        onCtxMenu={(e, item) => setCtxMenu({ x: e.clientX, y: e.clientY, item })}
        onMerge={setMergeTarget}
        libPage={libPage}
        libPages={libPages}
        onLibPage={setLibPage}
        totalBytes={lib?.totalBytes ?? 0}
        hiddenCount={hidden.length}
        onShowHidden={() => setShowHidden(true)}
      />

      <section className="lib-right">
        {current ? (
          <>
            <div className="lib-head card">
              {/* 屏 C 的返回（设计稿 §5.3：任何层级可「返回」且不丢选中态）——
                  返回的是屏 B 话列表，左栏选中保持不动 */}
              {inChapter ? (
                <IconButton title="返回这一部的话列表" onClick={() => setChapterNo(null)}>
                  <ArrowLeft size={20} />
                </IconButton>
              ) : null}
              <div className="lib-head-titles">
                <div className="lib-head-name" title={headName}>
                  {headName}
                </div>
                <div className="lib-head-path" title={headPath}>
                  {headPath}
                </div>
              </div>
              {/* 大类的补充信息：话内归因到所属大类，话列表给出作者与规模（设计稿 §7.1 同一口径） */}
              {currentBook ? (
                <span className="lib-head-sub muted">
                  {inChapter
                    ? `《${currentBook.bookName}》`
                    : `${currentBook.author || AUTHOR_FALLBACK} · ${currentBook.chapterCount} 话 · ${currentBook.totalPages} 页`}
                </span>
              ) : null}
              <Btn kind="ghost" onClick={onRefresh} title="重新扫描漫画库">
                <RefreshCw size={14} />
                刷新
              </Btn>
              {/* 头部按钮只留「刷新」：打开目录 / 续做 / 返工 / 编辑信息 / 删除 / 归并
                  全部迁往**左栏漫画项的右键菜单**（renderComicMenu）—— 操作的主语是
                  "被右键的那部漫画"，比"头部当前显示的这部"更不容易错位 */}
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
                          if (ch.no !== null) setChapterNo(ch.no);
                        }}
                        onOpenDir={() =>
                          openPath(ch.absDir).catch((e: unknown) => onToast(errorText(e), 'bad'))}
                        onResume={() => {
                          if (ch.no === null) return; // 无话号的目录拼不出话级端点，卡片入口也已禁用
                          void resume(
                            `/library/${encodeURIComponent(currentBook.bookName)}/chapters/${ch.no}`,
                            `《${currentBook.bookName}》第 ${ch.no} 话`,
                          );
                        }}
                        onRetranslate={() => {
                          if (ch.no === null) return; // 无话号的目录拼不出话级端点，卡片入口也已禁用
                          void retranslate(
                            `/library/${encodeURIComponent(currentBook.bookName)}/chapters/${ch.no}`,
                            `《${currentBook.bookName}》第 ${ch.no} 话`,
                          );
                        }}
                        onEditNo={() => setEditNoChapter({ bookName: currentBook.bookName, chapter: ch })}
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
                      <Btn kind="ghost" size="sm" disabled={chPage <= 1} onClick={() => setChPage(chPage - 1)}>
                        上一页
                      </Btn>
                      <Btn
                        kind="ghost"
                        size="sm"
                        disabled={chPage >= chPages}
                        onClick={() => setChPage(chPage + 1)}
                      >
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
                  <div className="lib-grid">
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
                          className="grid-card"
                          style={{
                            width: LIBRARY.card.w,
                            height: LIBRARY.card.h,
                            borderRadius: LIBRARY.card.radius,
                          }}
                          disabled={state === 'missing'}
                          onClick={() => setCompareSeq(seq)}
                          title={
                            state === 'missing'
                              ? `第 ${seq} 页在本机没有原图，无法对照`
                              : `第 ${seq} 页 · 点开看原文 / 译文对照`
                          }
                        >
                          <Thumb
                            path={state === 'done' && gridView ? gridView.imagePath(seq, 'translated') : ''}
                            seq={seq}
                            state={state}
                          />
                          <span className="grid-foot">
                            <span className="num">{String(seq).padStart(3, '0')}</span>
                            <span
                              className={state === 'missing' ? 'is-bad' : undefined}
                              title={
                                state === 'done'
                                  ? `第 ${seq} 页：本地已有译文`
                                  : state === 'pending'
                                    ? `第 ${seq} 页：有原图、缺译文 —— 点「继续翻译」可以补`
                                    : `第 ${seq} 页：本机没有这一页`
                              }
                            >
                              {GRID_LABEL[state]}
                            </span>
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
                      <Btn kind="ghost" size="sm" disabled={gridPage <= 1} onClick={() => setGridPage(gridPage - 1)}>
                        上一页
                      </Btn>
                      <Btn
                        kind="ghost"
                        size="sm"
                        disabled={gridPage >= gridPages}
                        onClick={() => setGridPage(gridPage + 1)}
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

      {toDelete ? (
        <DeleteComicModal
          comic={toDelete.comic}
          kind={toDelete.kind}
          busy={deleting}
          onCancel={() => setToDelete(null)}
          onConfirm={(deleteFiles) => void confirmDelete(deleteFiles)}
        />
      ) : null}

      {showHidden ? (
        <HiddenComicsModal
          hidden={hidden}
          busy={unhiding}
          onClose={() => setShowHidden(false)}
          onUnhide={(name) => void doUnhide(name)}
        />
      ) : null}

      {newBookOpen ? (
        <NewBookModal
          root={lib?.root ?? ''}
          existing={comics.map((c) => c.dirName)}
          busy={creating}
          onCancel={() => setNewBookOpen(false)}
          onConfirm={(name, author) => void createBook(name, author)}
          onViewExisting={(name) => {
            // 同名时「查看它」：关弹窗 + 清搜索词（否则可能被过滤条件挡在左栏外）+ 选中
            setNewBookOpen(false);
            setQueryInput('');
            setActive(name);
          }}
        />
      ) : null}

      {editBook ? (
        <EditBookModal
          book={editBook}
          busy={savingMeta}
          onCancel={() => setEditBook(null)}
          onSubmit={(intent, author) => void saveMeta(intent, author)}
        />
      ) : null}

      {mergeTarget ? (
        <MergeModal
          source={mergeTarget}
          books={books}
          busy={merging}
          onCancel={() => setMergeTarget(null)}
          onConfirm={(target, no) => void mergeInto(target, no)}
        />
      ) : null}

      {editNoChapter ? (
        <EditChapterNoModal
          bookName={editNoChapter.bookName}
          chapter={editNoChapter.chapter}
          takenNos={(books.find((b) => b.bookName === editNoChapter.bookName)?.chapters ?? [])
            .map((c) => chapterNoOf(c.dirName))
            .filter((n): n is number => n !== null && n !== editNoChapter.chapter.no)}
          busy={renumbering}
          onCancel={() => setEditNoChapter(null)}
          onConfirm={(no) => void renumberChapter(editNoChapter.bookName, editNoChapter.chapter, no)}
        />
      ) : null}

      {ctxMenu ? (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
          {(close) => renderComicMenu(ctxMenu.item, close)}
        </ContextMenu>
      ) : null}
    </div>
  );
}
