import type { ReactElement } from 'react';
import { EyeOff, FolderUp, GitMerge, Pencil, Play, RotateCcw, Trash2 } from 'lucide-react';
import { apiDelete, apiPost, apiPostMultipart, errorText, openPath } from '@/ipc';
import type {
  ChapterEntry,
  ComicEntry,
  LibraryDeleteResponse,
  LibraryResponse,
  RetranslateResponse,
  TaskRow,
} from '@/types';
import { chapterNoOf } from '@tools';
import { LIBRARY } from '@/themes/tokens';
import { Btn, ContextMenu, Empty, ErrorState, MenuItem, MenuSeparator } from '@components/units';
import type { BookMetaIntent } from '@screens/manga/modals';
import {
  DeleteComicModal,
  EditBookModal,
  EditChapterNoModal,
  HiddenComicsModal,
  MergeModal,
  NewBookModal,
} from '@screens/manga/modals';
import { Compare } from '@screens/manga/viewer';
import { retranslateMeta, resumeMeta } from '@screens/manga/meta';
import { LeftRail } from '@screens/manga/LeftRail';
import { LibraryRight } from '@screens/manga/LibraryRight';
import { EmptyArt } from '@screens/manga/cards';
import { useLibraryModel } from '@hooks/useLibraryModel';
import { useEsc } from '@hooks/useEsc';
import type { LibItem } from '@screens/manga/libModel';

// ------------------------------------------------------------------ 左栏视图件

/**
 * 左栏一项的**展示视图**：大类与未归并单话归一成同一形状，左栏与搜索分组共用。
 *
 * 为什么不直接用 `BookEntry`/`ChapterEntry`：左栏要显示的是「漫画」这一个概念
 * （「N 话 · M 页」），其中大类有作者有封面、未归并单话没有 —— 两个类型各写一条渲染分支
 * 就会长出两套几乎一样的 DOM。归一到 `LibItem` 后只有"取哪些字段"的差别，
 * 而那个差别已经由 `buildItems()` 一次性吸收掉了。
 */

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
  error,
  onGoDrop,
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
  /** 库读取失败的原因；非空且无数据时整屏走错误态，不把「读不到」冒充成「空库」 */
  error?: string | null;
  /**
   * 空态里的「去投放」。
   *
   * 设计稿把这条出口放在**空书架**与**搜索无结果**两种空态上（"没东西可看"时下一步
   * 该是送东西进来），而左栏是 `LeftRail` 的子件、拿不到壳层的 `setView` ——
   * 故由装配件把动作透传下来，左栏只管画。
   */
  onGoDrop: () => void;
}): ReactElement {
  // 吐司单例总线：直接取用，不必由宿主透传（见 useToasts 注释）
  const {
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
  } = useLibraryModel({
    lib,
    tasks,
    focus,
    onFocusHandled,
    newBookSignal,
    onNewBookHandled,
    refreshKey,
  });

  /*
   * Esc 退出搜索（设计稿 §7.2 的搜索态脚注写着「Esc 退出搜索」，且全局键位处理器
   * 确实在库屏里把 Esc 交给"清空搜索词"）。
   *
   * 三道闸门缺一不可：① 不在搜索态就没有可退出的东西；② 任一浮层开着时 Esc 属于浮层
   * （关弹窗优先，否则用户按 Esc 会连搜索一起清掉）；③ 对照视图开着时 Esc 是"返回网格"。
   * 判定只读状态、不发请求，故放在屏本体而不是模型里。
   */
  const overlayOpen =
    toDelete !== null ||
    showHidden ||
    newBookOpen ||
    editBook !== null ||
    mergeTarget !== null ||
    editNoChapter !== null ||
    ctxMenu !== null;
  useEsc(() => {
    if (!searching || overlayOpen || compareSeq !== null) return;
    setQueryInput('');
  });

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

  /**
   * 隐藏作品：`delete{deleteFiles:false}` —— 从书架移除、**本地文件与译文都不动**。
   * 之后可在「已隐藏」里一键恢复（服务端 `/library/{name}/unhide`）。
   */
  const hideBook = async (name: string) => {
    try {
      await apiPost(`/library/${encodeURIComponent(name)}/delete`, { deleteFiles: false });
      if (name === active) setActive(null);
      setCompareSeq(null);
      onToast(`已隐藏「${name}」—— 可在「已隐藏」里恢复`, 'good');
      onRefresh();
    } catch (e) {
      onToast(errorText(e), 'bad');
    }
  };

  const confirmDelete = async (deleteFiles: boolean) => {
    const target = toDelete?.comic;
    if (!target) return;
    setDeleting(true);
    try {
      const r = await apiPost<LibraryDeleteResponse>(`/library/${encodeURIComponent(target.comicName)}/delete`, {
        deleteFiles,
      });
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
  const comicOf = (key: string): ComicEntry | null => comics.find((c) => c.comicName === key) ?? null;

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

  // 库读失败时**整屏走错误态**：`lib === null` 时 `useLibraryModel` 会给出空列表，
  // 若照常往下走就会把「读不到」画成「漫画库还是空的」—— 空态与错误态语义完全不同。
  // 有错误但数据仍在时（上次成功、本次失败）保留旧数据继续展示，错误由下次刷新自然消除。
  if (error && !lib) {
    return (
      <ErrorState
        title="漫画库读取失败"
        message={error}
        actions={
          <Btn kind="primary" size="sm" onClick={onRefresh}>
            重试
          </Btn>
        }
      />
    );
  }

  if (comics.length === 0 && hidden.length === 0) {
    /*
     * 空库（设计稿 `renderLibrary` 的空分支）：**单栏 + 居中空态卡**，而不是一条提示条。
     *
     * 旧写法是一条 `Notice`，且左栏照样渲染一张空面板 —— 页面上于是同时存在
     * "左侧空书架"与"一条提示"，两个都在说"没有东西"，却都没给下一步。
     * 设计稿的做法是：左栏让位（`grid-template-columns: 1fr`），整页只留一块空态，
     * 出口按"最可能的下一步"排：去投放（primary）→ 新建漫画 → 已隐藏 N。
     */
    return (
      <>
        <div className="lib lib-solo">
          <section className="lib-right lib-empty-page">
            <Empty>
              <EmptyArt />
              <h3 className="empty-title">漫画库还是空的</h3>
              <p className="empty-sub">投放几张漫画图片，翻译完成后作品会自动按「本 → 话 → 页」整理在这里。</p>
              <div className="empty-actions">
                <Btn kind="primary" size="sm" onClick={onGoDrop}>
                  去投放
                </Btn>
                <Btn kind="ghost" size="sm" onClick={() => setNewBookOpen(true)}>
                  新建漫画
                </Btn>
                {hidden.length > 0 ? (
                  <Btn kind="ghost" size="sm" onClick={() => setShowHidden(true)}>
                    已隐藏 {hidden.length}
                  </Btn>
                ) : null}
              </div>
            </Empty>
          </section>
        </div>
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
          label="重新翻译整本"
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
            title={bookOfItem ? '改封面（本地图片 / 取第 1 话首图 / 移除）与作者' : '漫画信息还没就绪，稍后再试'}
            onClick={() => {
              close();
              if (bookOfItem) setEditBook(bookOfItem);
            }}
          />
        ) : books.length > 0 ? (
          <MenuItem
            icon={<GitMerge size={13} />}
            label="归并到…"
            sub="挂到某本漫画的某一话"
            title="把这一话物理移动进某个大类目录（不可逆）"
            onClick={() => {
              close();
              setMergeTarget(it.key);
            }}
          />
        ) : null}
        {/*
          隐藏作品（设计稿右键菜单的一项）：与「删除整本」走同一个端点，只是**不删文件** ——
          服务端的 `delete{deleteFiles:false}` 就是"从书架移除、文件留着"，之后可在「已隐藏」恢复。
          单独给一项是因为"我只是不想在书架上看到它"与"我要删掉它"是两种意图，
          让前者也必须走一遍带删除字样的确认框，是在逼用户点一个他不想点的按钮。
        */}
        {it.merged ? (
          <MenuItem
            icon={<EyeOff size={13} />}
            label="隐藏作品"
            sub="可在「已隐藏」里恢复"
            disabled={!comic}
            title="从书架移除这本漫画（本地文件与译文都保留）"
            onClick={() => {
              close();
              void hideBook(it.name);
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
    <div className="lib" style={{ '--lib-left-w': `${LIBRARY.leftColumnWidth}px` } as React.CSSProperties}>
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
        onCtxMenu={(e, item) => setCtxMenu({ x: e.clientX, y: e.clientY, item })}
        libPage={libPage}
        libPages={libPages}
        onLibPage={setLibPage}
        totalBytes={lib?.totalBytes ?? 0}
        hiddenCount={hidden.length}
        onShowHidden={() => setShowHidden(true)}
        onGoDrop={onGoDrop}
      />

      <LibraryRight
        searching={searching}
        query={query}
        searchGroups={searchGroups}
        foldedGroups={foldedGroups}
        onToggleFolded={toggleFolded}
        onActive={setActive}
        onOpenChapterNo={setChapterNo}
        onMerge={setMergeTarget}
        onGoDrop={onGoDrop}
        current={current}
        inChapter={inChapter}
        headName={headName}
        headPath={headPath}
        currentBook={currentBook}
        onRefresh={onRefresh}
        chapterRows={chapterRows}
        reworkingComics={reworkingComics}
        onOpenChapter={setChapterNo}
        onExitChapter={() => setChapterNo(null)}
        onOpenDir={(absDir) => void openPath(absDir).catch((e: unknown) => onToast(errorText(e), 'bad'))}
        onResume={resume}
        onRetranslate={retranslate}
        onEditBook={setEditBook}
        onClearSearch={() => setQueryInput('')}
        onEditNoChapter={setEditNoChapter}
        chPage={chPage}
        chPages={chPages}
        onChPage={setChPage}
        gridView={gridView}
        gridSeqs={gridSeqs}
        missingSeqs={missingSeqs}
        translatedSeqs={translatedSeqs}
        seqMax={seqMax}
        gridPage={gridPage}
        gridPages={gridPages}
        onGridPage={setGridPage}
        onCompare={setCompareSeq}
      />

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
