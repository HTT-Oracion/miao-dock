import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { apiPost, errorText, openPath, quitApp, serviceRestart, serviceStart } from '@/ipc';
import type { ServiceState } from '@/ipc';
import { useLibrary, useQuitRequest, useService, useTasks, useToasts, useTranslateSource } from '@hooks';
import { initialMode, persistMode, useThemeTokens } from '@/themes/apply';
import {
  initialServiceAutoStart,
  initialSidebarLabels,
  persistServiceAutoStart,
  persistSidebarLabels,
} from '@/stores/shell-prefs';
import type { ThemeMode } from '@/themes/tokens';
import { Badge, Btn, Notice, Pill } from '@components/units';
import { ProgressRing } from '@components/units';
import { DynamicIsland } from '@components/DynamicIsland';
import { NotificationStack } from '@components/NotificationStack';
import { MusicKernel } from '@components/MusicKernel';
import { QuitConfirm } from '@components/QuitConfirm';
import { Sidebar } from '@components/Sidebar';
import { Toolbar } from '@components/Toolbar';
import { ViewTabs } from '@components/ViewTabs';
import { DownloadPanel } from '@screens/engine/DownloadPanel';
// 展开播放器挂在**应用根**（不在 MusicScreen 内）—— 判据见渲染处注释：
// 它是 `position: fixed; inset: 0` 的全屏浮层，数据全部来自 store，本就不依赖任何一屏的 DOM。
import { ExpandedPlayer } from '@screens/music/ExpandedPlayer';
import { useMusicStore } from '@music/store';
import { isBlockedWhenNotReady, stateView } from '@/stores/nav';
import { useNav } from '@/router/use-nav';
import type { ShellCtx } from '@/router/panes/shell-context';
import type { TranslateSource } from '@screens/settings/translate-api';
import { engineStatus, downloadEngineModels, type ModelDownloadView } from '@screens/settings/engine-api';
import { engineDownloadChip, isDownloadActive } from '@/ipc/engine-download';
import type { CancelResponse, DeleteTasksResponse, LibraryResponse, TaskRow } from '@/types';
import { formatBytes } from '@tools';

/**
 * 喵坞应用外壳（《02》§5.1 / 《09》§3）：侧栏 78 + 工具条 62 + 应用区。
 *
 * ## 一处刻意的取舍：服务未就绪时，哪些屏让位
 *
 * 让位：翻译三视图（数据全在服务里，没服务毫无意义）→ 让位给 X-C3。
 * 不让位：设置页（承载「看状态、重启服务、复制令牌、切主题、跑规格自检」，
 * 恰恰是服务出问题时最需要用到的那一屏，挡掉只会让人更没辙）；音乐屏
 * （ver2.0 起为独立应用，与翻译引擎无依赖关系）。
 * 判定集中在 `isBlockedWhenNotReady` 一处，避免拦截纪律散落到多处失效。
 */
export function App() {
  const { screen, view, setScreen, setView } = useNav();
  const [mode, setMode] = useState<ThemeMode>(() => initialMode());
  /**
   * 侧栏是否显示文字标签（`shell-prefs.ts`）。
   *
   * 与 `mode` 一样是**壳层偏好**：值的家（localStorage + 回落规则）在偏好模块里，
   * 这里只持有"当前这一份"。`Sidebar` 与设置页①读的是**同一个 state** ——
   * 设置页一拨开关，侧栏同帧就变，不存在"存了但界面没跟"。
   */
  const [sidebarLabels, setSidebarLabels] = useState(() => initialSidebarLabels());
  /**
   * 翻译服务是否**随应用自动启动**（壳层偏好，`shell-prefs.ts`）。
   *
   * 与 `sidebarLabels` 完全同构：值的家在偏好模块里，这里只持有"当前这一份"，
   * 设置页的开关与 `Sidebar` 读的是**同一个 state** —— 拨一下开关不必重载。
   */
  const [autoStart, setAutoStart] = useState(() => initialServiceAutoStart());
  const [quitOpen, setQuitOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  /**
   * 正在取消中的任务 id（乐观标记）。
   *
   * 为什么需要它：服务端 `cancelTask` 对**执行中**的任务会等到一个安全点才回（最长 30s），
   * 这期间按钮若还长得像可点，用户会以为"点了没反应"而反复点。
   * 所以点下的**同一帧**就把该行标成「取消中…」并禁用 —— 反馈先于服务端响应。
   * （配合 `api_post` 的 `(async)` 修法，主线程本身也不再被这段等待冻住。）
   */
  const [cancelingIds, setCancelingIds] = useState<Set<string>>(() => new Set());
  /** 待漫画库定位的漫画名（队列行「查看」→ 切到漫画库并选中它） */
  const [libraryFocus, setLibraryFocus] = useState<string | null>(null);
  /**
   * 「新建漫画」一次性信号。
   *
   * 按钮长在本组件算出来的工具条里，而弹窗与它提交后要做的事（刷新库、选中新项、发 Toast）
   * 全在 `LibraryScreen` 内。把整摊弹窗状态抬上来会把它劈成两半，故沿用与 `libraryFocus`
   * **同构**的一次性信号：本组件只负责"置一次真"，LibraryScreen 消费后回调清空。
   */
  const [newBookRequest, setNewBookRequest] = useState(false);

  /**
   * 引擎下载视图开关（G5）。下载在后台继续，用户可随时打开/关闭本视图去别的屏。
   * 🔴 与 `isBlockedWhenNotReady` 的纪律不冲突：下载视图是**信息主场**，不是拦截屏；
   *    它开着时漫画库 / 设置 / 音乐照常可用（下载不阻塞任何一屏）。
   */
  const [downloadViewOpen, setDownloadViewOpen] = useState(false);
  /** `/engine/status` 的 `modelDownload` —— 工具条芯片与下载视图的唯一真实来源。 */
  const [download, setDownload] = useState<ModelDownloadView | null>(null);

  useThemeTokens(mode);

  const { status, ipcError } = useService();
  const running = status?.state === 'running';

  /**
   * 轮询 `modelDownload`（G5）：进度/中断态只来自真实事件，前端不编造。
   * 1.5s 一次即可（进度聚合在 Rust 侧已节流，界面不必更密）。服务不可达时静默失败。
   */
  useEffect(() => {
    let alive = true;
    const tick = () => {
      engineStatus()
        .then((r) => {
          if (alive) setDownload(r.modelDownload);
        })
        .catch(() => undefined);
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  /** 运行时是否缺件（未装配）—— 决定工具条要不要给「需下载引擎」芯片。 */
  const engineMissing = status?.mode === 'real' && !!status?.runtime && !status.runtime.ready;
  /** 翻译来源（P-D1）：服务的设置。读不到时 source=null，按本地档处理（见 hook 注释） */
  const { source, platform, reload: reloadSource } = useTranslateSource();
  const { data: tasks, error: tasksError, reload: reloadTasks } = useTasks(running);
  const { data: lib, error: libError } = useLibrary(running, refreshKey);
  const { push } = useToasts();

  useQuitRequest(() => setQuitOpen(true));

  const setTheme = useCallback((m: ThemeMode) => {
    setMode(m);
    persistMode(m);
  }, []);

  /** 侧栏标签开关：先改 state（界面立刻变），再落盘 —— 顺序与 `setTheme` 一致 */
  const setLabels = useCallback((on: boolean) => {
    setSidebarLabels(on);
    persistSidebarLabels(on);
  }, []);

  /** 自动启动开关：同上（界面立刻变 → 再落盘）。落盘后 effect 会按新值决定要不要立刻拉服务 */
  const setServiceAutoStart = useCallback((on: boolean) => {
    setAutoStart(on);
    persistServiceAutoStart(on);
  }, []);

  /**
   * 自动启动本地翻译服务（「设置 → 翻译服务 → 服务与配对 → 自动启动翻译服务」）。
   *
   * ## 触发时机是"进入漫画翻译应用"，不是"应用一启动"
   * 关掉这个开关的人要的是「**我不翻译就别把引擎拉起来**」—— 引擎是重资源
   *（真模式下 python + llama-server + 执行器，GB 级内存与显存）。所以挂在 `screen` 上。
   *
   * ## 🔴 依赖里**不能**放 `status`
   * 放了就会变成"只要服务不是 running 就拉一次"：用户刚在设置页点完
   * 「停止本地服务」，下一秒就被这个 effect 原地复活 —— 开关看着像失灵，
   * 而且现场表现是"停不掉"。判定必须在**屏切换那一瞬**做完，之后不再回头。
   * 顺带也省掉了"失败后无限重试"（那会让一个坏掉的引擎反复冷启动）。
   *
   * ## 幂等由 Rust 兜底，前端不做去重
   * `service_start` 在 Rust 侧是幂等的（`ServiceManager::start_once`），
   * 而 `React.StrictMode` 在开发期**会故意把 effect 跑两遍** —— 前端再写一层
   * 去重只会把"到底谁负责"弄糊。失败也不弹吐司：未就绪屏自己会解释原因（X-C3）。
   */
  useEffect(() => {
    if (screen !== 'translate' || !autoStart) return;
    void serviceStart().catch(() => undefined);
  }, [screen, autoStart]);

  /**
   * 翻译来源的**补读时机**（P-D3 分档的保鲜）—— `useTranslateSource` 挂载时只读一次，
   * 这两个时机不补，分档就会一直拿旧值：
   *
   * ① 服务起到 running：冷启动时 `/translate/options` 必然读不到（`source=null` 按本地档，
   *    理由见 hook 注释）。不补的话，配了在线来源的用户会在服务起来后一直拿着本地档的
   *    chip 与准入判据 —— 分档集成在最常见的场景里失效；
   * ② 屏幕切换：来源可能在设置页刚被改过（P-D1：它是**服务的设置**，不是任务属性），
   *    回到翻译屏时 chip 与分档都要反映新值。
   *
   * 🔴 两条都**只在 running 时补读**：服务停下时选项接口必然读失败，而那时若把
   *    `source` 冲成 null，在线用户点完「停止本地服务」看到的会是四段时间线而不是
   *    P-D3 的精简页 —— 分档恰好在它最该出现的场景里失效。保持上一次读到的值即可。
   */
  useEffect(() => {
    if (running) void reloadSource();
  }, [screen, running, reloadSource]);

  /* ---- 展开播放器（挂应用根，故它的 Esc / seek 也归这里）----
   * 判据与 MusicKernel 同款："离开本屏之后还该继续存在的，就不能住在本屏里"。
   * 灵动岛（DynamicIsland）常驻应用根，它上面的「打开播放器」在**任何屏**都能点，
   * 浮层就必须同样在**任何屏**都能出现 —— 否则从设置页点开就是"按了没反应"。 */
  const seekMusic = useMusicStore((s) => s.seek);
  const musicExpanded = useMusicStore((s) => s.expanded);
  const closeMusicExpanded = useMusicStore((s) => s.closeExpanded);

  // Esc 收起展开播放器：与音乐屏内那条同源，但**只判 expanded**。
  // 队列抽屉仍归音乐屏（它只在那一屏存在，Esc 连带关它才是对的）。
  useEffect(() => {
    if (!musicExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMusicExpanded();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [musicExpanded, closeMusicExpanded]);

  const onMusicSeek = useCallback((ms: number) => seekMusic(ms), [seekMusic]);

  const refreshAll = useCallback(() => {
    setRefreshKey((k) => k + 1);
    void reloadTasks();
  }, [reloadTasks]);

  /**
   * 翻译完成后自动刷新漫画库（用户反馈：翻完了，库页却还是旧的）。
   *
   * 为什么**不给漫画库也加轮询**：库读的是**整个根目录**（逐目录 stat + 逐页清点），
   * 代价远高于读一次任务列表，空闲时反复扫盘纯属浪费。而"库内容变了"这件事，
   * 任务列表**已经知道** —— `running+queued` 从「有活」落到「没活」，就是一批任务刚收尾。
   * 在那一刻补一次库刷新，正好覆盖用户真正会遇到的情形（翻完就该看到成品）。
   * 其余边缘情形（外部往根目录里拷了东西）交给库页的「刷新」按钮。
   */
  const activeTasks = (tasks?.running ?? 0) + (tasks?.queued ?? 0);
  const prevActiveTasks = useRef(0);
  useEffect(() => {
    if (prevActiveTasks.current > 0 && activeTasks === 0) refreshAll();
    prevActiveTasks.current = activeTasks;
  }, [activeTasks, refreshAll]);

  /**
   * 队列多选删除（`POST /tasks/delete`）。
   *
   * 只删记录、**不碰漫画目录** —— 队列删的是"任务"，漫画库删的才是"漫画"。
   * 服务端逐条回报（翻译中/排队中的会被跳过），所以这里把两个数一起说出来，
   * 而不是笼统地报"删除成功"。返回值供调用方决定是否清空勾选。
   */
  const deleteTasks = useCallback(
    async (taskIds: string[]): Promise<boolean> => {
      try {
        const r = await apiPost<DeleteTasksResponse>('/tasks/delete', { taskIds });
        if (r.deletedCount > 0 && r.skippedCount > 0) {
          push(`已删除 ${r.deletedCount} 条记录；${r.skippedCount} 条翻译中/排队中，未删除`, 'info');
        } else if (r.deletedCount > 0) {
          push(`已删除 ${r.deletedCount} 条任务记录`, 'good');
        } else {
          push('没有可删除的任务（翻译中/排队中的不能删除）', 'info');
        }
        refreshAll();
        return true;
      } catch (e) {
        push(errorText(e), 'bad');
        return false;
      }
    },
    [push, refreshAll],
  );

  const restart = useCallback(async () => {
    try {
      push('正在重启本地服务…', 'info');
      await serviceRestart();
    } catch (e) {
      push(errorText(e), 'bad');
    }
  }, [push]);

  /**
   * 手动启动（未就绪屏「启动本地服务」）。与上面的自动启动走**同一条** IPC，
   * 区别只在"谁点的"与要不要给反馈 —— 用户点的必须给一句，自动拉起的不能给（会变噪音）。
   */
  const startService = useCallback(async () => {
    try {
      push('正在启动本地服务…', 'info');
      await serviceStart();
    } catch (e) {
      push(errorText(e), 'bad');
    }
  }, [push]);

  const rows = tasks?.tasks ?? [];
  const hasRows = rows.length > 0;
  const queueDepth = (tasks?.running ?? 0) + (tasks?.queued ?? 0);
  const libRoot = (lib as LibraryResponse | null)?.root ?? status?.root_dir ?? '';

  /**
   * 取消任务。
   *
   * 🔴 **先乐观标记再发请求**：服务端对 running 任务会挂到安全点才回（最长 30s）。
   * 若等响应回来才给反馈，这半分钟里界面看着像死的 —— 表现就是"取消按钮点下去卡死"。
   * 所以这里立刻把该行标成「取消中…」（禁用按钮、给出进行态），响应回来再 `refreshAll`
   * 用服务端真实状态覆盖。这是"感知上的即时响应"，不是伪造结果：数字仍全部来自服务端。
   */
  const cancel = async (t: TaskRow) => {
    setCancelingIds((prev) => new Set(prev).add(t.taskId));
    try {
      const r = await apiPost<CancelResponse>(`/tasks/${t.taskId}/cancel`, {});
      push(`已取消「${t.comicName}」，保留了 ${r.keptItems} 张已落盘的译文`, 'info');
    } catch (e) {
      push(errorText(e), 'bad');
    } finally {
      setCancelingIds((prev) => {
        const next = new Set(prev);
        next.delete(t.taskId);
        return next;
      });
      refreshAll();
    }
  };

  /**
   * 队列行「查看」—— 跳漫画库并**定位**到该漫画。
   *
   * 先判存在性（R3）：库里没有对应的成品（还没落盘 / 已被删 / 只隐藏了）就只提示、不跳，
   * 避免把用户带到一个空白库页上。判据用**归一化目录名**（`normalizedComicName`）去对
   * `ComicEntry.comicName`/`dirName`：库里显示的是目录名，任务上的原名可能差一个空格或大小写。
   */
  const viewComic = (t: TaskRow) => {
    const name = t.normalizedComicName ?? t.comicName;
    const comics = (lib as LibraryResponse | null)?.comics ?? [];
    const hit = comics.find((c) => c.comicName === name || c.dirName === name);
    if (!hit) {
      push(`漫画库里还没有「${name}」的成品（可能尚未落盘或已被删除）`, 'bad');
      return;
    }
    setLibraryFocus(hit.comicName);
    setView('library');
  };

  /**
   * 「重试」= **同一个任务重跑一次**（`POST /tasks/{taskId}/retry`）。
   *
   * 为什么不再走 `POST /library/{name}/resume`：resume 的语义是「按**漫画目录**找缺页」，
   * 它会**新建一个 taskId** ⇒ 队列页上原失败行留在历史里、旁边又冒出一条新行。
   * 用户看到的是「点了重试，历史里多出一个任务」，而他要的是「**这一行**变回翻译中」。
   * 队列行上的「重试」指的是这一行重来一遍，所以复用 taskId 才对得上语义。
   *
   * ⚠️ `resume` 那条路仍然在（漫画库 X-D1 的「继续翻译」用它）—— 两条路的字节来源相同
   *（都从磁盘读原图、都不重传），差的是**任务的身份**。
   */
  const retry = async (t: TaskRow) => {
    try {
      await apiPost(`/tasks/${encodeURIComponent(t.taskId)}/retry`, {});
      push(`「${t.comicName}」已重新加入队列`, 'good');
      refreshAll();
    } catch (e) {
      push(errorText(e), 'bad');
    }
  };

  const openTaskDir = (t: TaskRow) => {
    openPath(t.outputDir).catch((e: unknown) => push(errorText(e), 'bad'));
  };

  /*
   * 准入分档（P-D3）：来源是**本地**时维持 ver2.1 现状（服务没 running 就拦）；
   * 来源是**在线**时只看 manga-service 五态 —— `stopped` / `error` 才拦，
   * `starting` / `degraded` 都不拦（本地引擎起没起来不挡在线翻译的界面准入，
   * 真翻不动由服务端在任务上如实报，不在准入上预拦）。
   * 读不到来源（`null`：服务没起来 / 选项请求失败）按本地处理 —— 回落到最严判据，
   * 不会比 ver2.1 更松（理由见 `useTranslateSource` 注释）。
   */
  const svcDown = status?.state === 'stopped' || status?.state === 'error';
  const blocked = source === 'online' ? svcDown : !running;
  // 哪些屏在服务未就绪时让位，判定集中在 nav.ts 一处（设置页与音乐屏有例外）
  const showNotReady = blocked && isBlockedWhenNotReady(screen);

  const libSummary = useMemo(() => {
    const l = lib as LibraryResponse | null;
    if (!l) return '扫描中…';
    return `${l.count} 部 · ${l.totalImages} 张 · 占 ${formatBytes(l.totalBytes)} · ${l.root}`;
  }, [lib]);

  const toolbar = useMemo(() => {
    // G5：下载态优先于服务五态 —— 引擎在下载/中断/缺件时，工具条右侧显示「引擎下载中 /
    // 下载中断 / 需下载引擎」芯片（带细环或播放按钮），点击回下载视图。
    // 🔴 不替换服务五态的语义：下载完（done）芯片消失、回落服务五态（见 engineDownloadChip）。
    const downloadChip = engineDownloadChip(download, engineMissing);
    if (downloadChip) {
      return {
        title: downloadChip.isAlert ? '下载中断' : '引擎下载中',
        subtitle: downloadChip.isAlert ? '点这里继续下载或从头重下' : '下载在后台继续，可随时去漫画库、设置或音乐页',
        actions: (
          <>
            <Badge>{sourceChipLabel(source, platform)}</Badge>
            <button
              type="button"
              onClick={() => setDownloadViewOpen((v) => !v)}
              title={downloadChip.isAlert ? '继续下载 / 重新下载' : '查看下载进度'}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
              }}
            >
              {downloadChip.showRing ? (
                <ProgressRing percent={downloadChip.percent} size={16} />
              ) : downloadChip.isAlert ? (
                <span style={{ color: 'var(--md-error)', fontSize: 13 }}>▶</span>
              ) : null}
              <Pill colorVar={downloadChip.colorVar}>{downloadChip.text}</Pill>
            </button>
          </>
        ),
      };
    }
    if (showNotReady) {
      return {
        title: '服务未就绪',
        subtitle: '本地翻译服务还没起来；起来之后这里会显示任务队列',
        actions: (
          <>
            <Badge>{sourceChipLabel(source, platform)}</Badge>
            <ServicePill status={status?.state ?? 'starting'} />
          </>
        ),
      };
    }
    // 音乐屏不随翻译服务状态变化：它的标题恒定，占位内容自己说明进度
    if (screen === 'music') {
      return {
        title: '音乐',
        subtitle: '本地音乐与在线音源 · 网易云 / 酷狗 / QQ / 咪咕四平台（汽水延后）',
        actions: null,
      };
    }
    if (screen === 'settings') {
      return { title: '设置', subtitle: '应用外观、翻译服务、媒体与资源', actions: null };
    }
    // 翻译应用内：工具条随视图切换（与 ver1.0 同一套文案，只是判定源从 screen 变成 view）
    switch (view) {
      case 'library':
        return {
          title: '本地漫画库',
          subtitle: libSummary,
          actions: (
            <>
              {/* 来源 chip：翻译三视图 + 未就绪工具条一致（P-D1：来源是服务的设置，常亮） */}
              <Badge>{sourceChipLabel(source, platform)}</Badge>
              {/* 「新建漫画」是**库级动作**（作用于整个库，不是某一项），故与「打开根目录」同层
                  （设计稿 §7.1.1 的位置裁决：不放左栏底部，免得与分页器抢位置） */}
              <Btn kind="primary" onClick={() => setNewBookRequest(true)}>
                新建漫画
              </Btn>
              <Btn kind="ghost" onClick={() => openPath(libRoot).catch((e: unknown) => push(errorText(e), 'bad'))}>
                打开根目录
              </Btn>
            </>
          ),
        };
      case 'drop':
        return {
          title: '本机投放',
          subtitle: '拖入图片或文件夹 · 与插件共用同一条队列',
          actions: (
            <>
              <Badge>{sourceChipLabel(source, platform)}</Badge>
              <Badge>每批 20 张 · 自动排队</Badge>
            </>
          ),
        };
      default:
        return {
          title: '任务队列',
          subtitle: `串行执行 · 同一时刻只跑 1 个任务 · 队内 ${queueDepth} 个`,
          actions: (
            <>
              <Badge>{sourceChipLabel(source, platform)}</Badge>
              <Badge>每批 20 张 · 自动排队</Badge>
              <ServicePill status={status?.state ?? 'starting'} />
            </>
          ),
        };
    }
  }, [
    libRoot,
    libSummary,
    platform,
    push,
    queueDepth,
    screen,
    showNotReady,
    source,
    status?.state,
    view,
    download,
    engineMissing,
  ]);

  // 翻译应用的视图 Tab 行；音乐屏不加（《09》§3.3），设置页是全局页也不加
  const showViewTabs = !showNotReady && screen === 'translate';

  /**
   * 壳层交给屏装配件的唯一一份数据（`panes/shell-context.ts`）。
   *
   * 刻意**不包** useMemo：这些值本来就随壳每帧重算，屏组件过去也是壳的子组件
   * （同样的重渲染频率）；包一层 memo 只会多一份要手写全依赖的负担，而漏一项
   * 就是"屏里读到旧值"那种最难查的 bug。
   */
  const shell: ShellCtx = {
    screen,
    view,
    setScreen,
    setView,
    status,
    source,
    platform,
    running,
    ipcError,
    showNotReady,
    startService,
    restart,
    rows,
    hasRows,
    queueDepth,
    cancelingIds,
    cancel,
    retry,
    viewComic,
    openTaskDir,
    deleteTasks,
    lib,
    libRoot,
    libSummary,
    libraryFocus,
    setLibraryFocus,
    newBookRequest,
    setNewBookRequest,
    refreshAll,
    refreshKey,
    rootDir: status?.root_dir ?? null,
    download,
    engineMissing,
    downloadViewOpen,
    setDownloadViewOpen,
    mode,
    setTheme,
    sidebarLabels,
    setLabels,
    autoStart,
    setServiceAutoStart,
  };

  return (
    <div className="shell">
      <Sidebar screen={screen} onScreen={setScreen} state={status?.state ?? 'starting'} labels={sidebarLabels} />

      <div className="main">
        <Toolbar title={toolbar.title} subtitle={toolbar.subtitle} actions={toolbar.actions} />

        {showViewTabs ? <ViewTabs view={view} onView={setView} /> : null}

        <div className="content">
          {ipcError ? (
            <Notice kind="bad">
              <b>无法与桌面端主进程通信。</b> {ipcError}
            </Notice>
          ) : null}

          {/* G5：下载视图（屏 2 / 屏 3）。**覆盖**内容区但不弹模态、不拦截其它屏 ——
              用户可随时点工具条芯片关掉它去漫画库 / 设置 / 音乐，下载在后台照常继续。
              它优先于屏内容：开着它的时候后面那一屏照常在，只是被盖住。 */}
          {downloadViewOpen && isDownloadActive(download) && download ? (
            <DownloadPanel
              view={download}
              requiredBytes={status?.runtime?.requiredBytes}
              onContinue={() => void downloadEngineModels()}
              onRedownload={() => void downloadEngineModels(true)}
              onBack={() => setDownloadViewOpen(false)}
            />
          ) : (
            <Outlet context={shell} />
          )}

          {tasksError ? <Notice kind="bad">任务列表读取失败：{tasksError}</Notice> : null}
          {libError ? <Notice kind="bad">漫画库读取失败：{libError}</Notice> : null}
        </div>
      </div>

      {/*
        音乐播放内核：挂在**应用根**，不随屏切换卸载 ——
        这是"播放中切到设置页音乐不断播"的全部机制（原先 <audio> 在 MusicScreen 内，
        切屏即销毁音频元素）。它只渲染一个 display:none 的 <audio>，不参与布局；
        放在 shell 末尾，是为了让"它不属于任何一屏"这件事在代码顺序上也读得出来。
      */}
      <MusicKernel />

      {/*
        展开播放器：与 MusicKernel 同理挂**应用根**，不随屏切换卸载。
        它是 `position: fixed; inset: 0; z-index: 70` 的全屏浮层，数据全来自 store，
        不读音乐屏的任何 DOM —— 所以从设置页/漫画库页点灵动岛的「打开播放器」也能正常铺开，
        不必先跳回音乐屏（那样等于让用户为"看播放器"额外付一次换屏的视觉跳转）。
        Esc / seek 的归属也一并搬到这里，见上方 effect。
      */}
      <ExpandedPlayer onSeek={onMusicSeek} />

      {quitOpen ? (
        <QuitConfirm
          onStay={() => setQuitOpen(false)}
          onQuit={() => {
            // 失败**不再静默**：旧版写的是 `void quitApp()`，一旦这条 IPC 被拒
            //（命令报错、主线程上 `exit` 没生效…）就什么都不发生 —— 用户看到的是
            //「点了『退出喵坞』没反应」，而控制台里那点信息他根本看不到。
            // 把原因摆到灵动岛上，至少能知道该往哪儿查（Rust 侧的 `quit_app` 见 D-87）。
            void quitApp().catch((e: unknown) => push(errorText(e), 'bad'));
          }}
        />
      ) : null}

      {/*
        灵动岛：只承载**音乐播放态**（2026-10-11 起，轻提示的承载已剥离给 NotificationStack ——
        一条胶囊一次只能显示一条提示、且会被播放态顶掉，批量操作的反馈会互相覆盖）。
        右上角 `<NotificationStack />` 是轻提示的**唯一**渲染层（antd notification 形态）。
        两者共用 toastBus 这条唯一队列（ISLAND.singleSource 的裁定不变）。
      */}
      <DynamicIsland />
      <NotificationStack />
    </div>
  );
}

/**
 * 平台 id → 展示名（来源 chip 用，P-D1）。
 *
 * 只映射**已知** id：契约当前只有 `youdao` 一把。未知 id 原样显示而不猜 ——
 * 猜一个译名比显示 id 更糟（用户拿着错的名字去设置里找，找不到）。
 */
const PLATFORM_LABELS: Record<string, string> = { youdao: '有道智云' };

/**
 * 来源 chip 文案：本地 → 「本地引擎」；在线 → 「在线 · 平台中文名」。
 *
 * 抽成具名函数而不是 JSX 里的长链三元（工程纪律第 8 条）：四个工具条分支
 * （未就绪 + 翻译三视图）共用同一句，写四遍必然会漂。
 */
function sourceChipLabel(source: TranslateSource | null, platform: string | null): string {
  if (source !== 'online') return '本地引擎';
  if (!platform) return '在线';
  return `在线 · ${PLATFORM_LABELS[platform] ?? platform}`;
}

/**
 * 状态胶囊。参数类型直接用 `ServiceState`（而不是再抄一份字面量联合）——
 * 抄一份的代价是 Rust 加第五态 `stopping` 时这里静默漏掉，`tsc` 反而报不出来。
 */
function ServicePill({ status }: { status: ServiceState }) {
  const v = stateView(status);
  return <Pill colorVar={v.colorVar}>{v.text}</Pill>;
}
