import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { ChevronDown, Download, Power, Settings, Terminal } from 'lucide-react';
import { apiPost, errorText, openPath, quitApp, serviceRestart, serviceStart, serviceStop } from '@/ipc';
import { toastBus } from '@/stores/toastBus';
import type { ServiceState } from '@/ipc';
import {
  useAppVersion,
  useLibrary,
  useNav,
  useQuitRequest,
  useService,
  useTasks,
  useToasts,
  useTranslateSource,
} from '@hooks';
import { SETTINGS_SECTIONS, SECTION_ITEM_TOTAL } from '@screens/settings/catalog';
import { initialMode, persistMode, useThemeTokens } from '@/themes/apply';
import {
  initialServiceAutoStart,
  initialSidebarLabels,
  persistServiceAutoStart,
  persistSidebarLabels,
} from '@/stores/shell-prefs';
import type { ThemeMode } from '@/themes/tokens';
import { Badge, Btn, Dot } from '@components/units';
import { DynamicIsland } from '@components/DynamicIsland';
import { NotificationStack } from '@components/NotificationStack';
import { MusicKernel } from '@components/MusicKernel';
import { QuitConfirm } from '@components/QuitConfirm';
import { Sidebar } from '@components/Sidebar';
import { Toolbar } from '@components/Toolbar';
import { ViewTabs } from '@components/ViewTabs';
// 展开播放器挂在**应用根**（不在 MusicScreen 内）—— 判据见渲染处注释：
// 它是 `position: fixed; inset: 0` 的全屏浮层，数据全部来自 store，本就不依赖任何一屏的 DOM。
import { ExpandedPlayer } from '@screens/music/ExpandedPlayer';
import { LogConsole } from '@screens/settings/LogConsole';
import { useMusicStore } from '@music/store';
import { ToolbarAccount } from '@screens/music/ToolbarAccount';
import { useAnimeStore } from '@anime/store';
import { ANIME_VIEW_META } from '@anime/player-options';
import { isBlockedWhenNotReady, stateView } from '@/stores/nav';
import type { EngineProcessView, ShellCtx } from '@/router/panes/shell-context';
import type { TranslateSource } from '@screens/settings/translate-api';
import { engineStatus, type ModelDownloadView } from '@screens/settings/engine-api';
import { downloadEntryState } from '@/ipc/engine-download';
import { initialDismissedDownload, persistDismissedDownload } from '@/stores/download-dismiss';
import type { CancelResponse, DeleteTasksResponse, LibraryResponse, TaskRow } from '@/types';
import { formatBytes } from '@tools';

/** ②/③ 进程快照的「空」值：① 停掉后壳层交给屏的占位，不保留上一份 running 假象。 */
const EMPTY_ENGINE_PROCESS: EngineProcessView = { engine: null, llm: null, warmed: false };

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
  const { screen, view, overlay, setScreen, setView } = useNav();
  const navigate = useNavigate();
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
  /** 运行日志抽屉（设计稿：设置页工具条上的「运行日志」按钮） */
  const [logsOpen, setLogsOpen] = useState(false);
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
   * 已完成下载的「关闭」确认（按 `startedAt` 记账）。
   * `done` 是持久态；没有它，侧栏完成图标关不掉、重启又冒出来。
   */
  const [dismissedDownload, setDismissedDownload] = useState<string | null>(() => initialDismissedDownload());
  /** `/engine/status` 的 `modelDownload` —— 工具条芯片、侧栏入口与下载页的唯一真实来源。 */
  const [download, setDownload] = useState<ModelDownloadView | null>(null);
  /** ②/③ 进程运行态快照（`/engine/status` 的 `engine.state` / `llm.state` / `warmed`）。 */
  const [engineProcess, setEngineProcess] = useState<EngineProcessView>(EMPTY_ENGINE_PROCESS);

  const openEngineDownload = useCallback(() => {
    if (overlay === 'engine-download') return;
    navigate('/engine-download');
  }, [navigate, overlay]);
  const dismissDownload = useCallback(() => {
    const key = download?.startedAt ?? 'done';
    setDismissedDownload(key);
    persistDismissedDownload(key);
  }, [download?.startedAt]);
  /** 发起下载后立刻把返回的视图写回壳层：下载页不必等下一次 1.5s 轮询才有内容。 */
  const applyDownload = useCallback((view: ModelDownloadView | null) => {
    if (view) setDownload(view);
  }, []);

  useThemeTokens(mode);

  const { status, ipcError } = useService();
  const running = status?.state === 'running';

  /*
   * 服务停掉后 `/engine/status` 读不到：保留上一次的 `running` 会让侧栏一直转圈。
   * 这里用**派生值**而不是 effect 里 setState：后者会多一轮渲染，且 lint 会判
   * "setState in effect"；派生值在下一帧直接生效。
   */
  const svcDown = status?.state === 'stopped' || status?.state === 'error';
  const visibleDownload = svcDown ? null : download;
  /** ① 停掉后 ②/③ 快照一并置空：屏里不残留「上一份 running」的假象。 */
  const visibleEngineProcess = svcDown ? EMPTY_ENGINE_PROCESS : engineProcess;
  /*
   * 视觉资产（② 的视觉模型）是否就位。
   *
   * 🔴 在线翻译**只替代 ③ LLM**：图片仍要经 ② 做检测 / OCR / 抹字，
   *    视觉没装好时哪怕在线能用也翻不出东西 ⇒ 准入必须连它一起看。
   *    `entries === 0` = 当前平台没有这一档（不算缺失），与 `setOf` 同口径。
   */
  const visualSet = status?.runtime?.sets?.visual;
  const visualReady = !!visualSet && visualSet.entries > 0 && visualSet.ready;
  /** 侧栏入口形态（三处共用同一份映射，不各自判断）。 */
  const downloadEntry = downloadEntryState(visibleDownload, dismissedDownload);

  /**
   * 轮询 `modelDownload`（G5）：进度/中断态只来自真实事件，前端不编造。
   * 1.5s 一次即可（进度聚合在 Rust 侧已节流，界面不必更密）。服务不可达时静默失败。
   */
  useEffect(() => {
    let alive = true;
    const tick = () => {
      engineStatus()
        .then((r) => {
          if (alive) {
            setDownload(r.modelDownload);
            setEngineProcess({
              engine: r.engine.state,
              llm: r.llm.state,
              warmed: r.warmed,
            });
          }
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
   * ## 触发时机是"应用启动"，不是"进入漫画翻译屏"
   * 偏好开着的人希望一打开喵坞就能投放/翻译，不必先切到某一屏；关掉的人要的是
   * 「**我不翻译就别把引擎拉起来**」—— 引擎是重资源（python + llama-server + 执行器，
   * GB 级内存与显存），所以关着时这里什么都不做，由未就绪页的「启动本地服务」手动拉起。
   *
   * ## 🔴 依赖里**不能**放 `screen` / `status`
   * `screen` 会把语义退回"进翻译屏才拉"；`status` 会变成"只要服务不是 running 就拉一次"——
   * 用户刚在设置页点完「停止本地服务」，下一秒就被原地复活，现场表现是"停不掉"。
   * 打开开关（关 → 开）时立即拉起是期望行为，所以依赖保留 `autoStart` 一个。
   *
   * ## 幂等由 Rust 兜底，前端不做去重
   * `service_start` 在 Rust 侧是幂等的（`ServiceManager::start_once`），
   * 而 `React.StrictMode` 在开发期**会故意把 effect 跑两遍** —— 前端再写一层
   * 去重只会把"到底谁负责"弄糊。失败也不弹吐司：未就绪屏自己会解释原因（X-C3）。
   */
  useEffect(() => {
    if (!autoStart) return;
    void serviceStart().catch(() => undefined);
  }, [autoStart]);

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

  // 番剧模块内视图：popover 与工具条标题都读这一份（与音乐的 store 同一套口径）
  const animeView = useAnimeStore((s) => s.view);
  const setAnimeView = useAnimeStore((s) => s.setView);

  /** 构建版本号（真值来自宿主；取不到就不出徽标，见 hook 注释） */
  const appVersion = useAppVersion();

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
   * 首启流程最后一步：**装配完成 ⇒ 自动重启一次服务链**，把 ②/③ 拉起来。
   *
   * 🔴 为什么必须有：D6 闸门在"运行时未装配"时只放 ① 服务进来（否则引导页那个
   *    「开始下载」会报"本地翻译服务未运行"，见 D-229）。而 ②/③ 是应用**按启动配方**
   *    起的 —— 只有重启服务才会重走一遍配方。少了这一步，用户会觉得"下完了却还是不能
   *    用"，而正确动作（去设置页点重启）没有任何地方提示他。
   *
   * 一次性：按 `startedAt` 记账，同一次下载只重启一次 —— 否则 1.5s 轮询会让它反复重启。
   */
  const restartedFor = useRef<string | null>(null);
  const prevDownloadState = useRef<string | null>(null);
  const pendingRestart = useRef(false);
  useEffect(() => {
    const state = visibleDownload?.state ?? null;
    const prev = prevDownloadState.current;
    prevDownloadState.current = state;

    // 只认**本次会话内**的跃迁（running/interrupted → done）。应用启动时读到的历史
    // done 不能触发重启，否则每次开应用都会先起服务再白等一次 stop。
    if ((prev === 'running' || prev === 'interrupted') && state === 'done') {
      pendingRestart.current = true;
    }
    if (state !== 'done' || !pendingRestart.current || !status?.runtime?.ready) return;

    const key = visibleDownload?.startedAt ?? 'done';
    if (restartedFor.current === key) return;
    restartedFor.current = key;
    pendingRestart.current = false;
    void restart();
  }, [visibleDownload?.state, visibleDownload?.startedAt, status?.runtime?.ready, restart]);

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
  /** 队列总条数（含历史）：标题徽标「共 N 条」用，与汇总条同一个数 */
  const queueTotal = tasks?.total ?? rows.length;
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
  /*
   * local 来源下「① 服务在跑」不等于「能翻译」：D6 闸门会只放 ① 进来、把 ②/③ 跳过，
   * 此时 state 仍是 running（degraded=true）。准入必须同时看 `engineMissing`，
   * 否则装配流程页在最需要它的那一刻被挡掉。
   * 🔴 online 来源**不是**「不需要本地引擎」：它只替代 ③ LLM，图片仍要 ② 处理，
   *    所以在线分支也要看视觉资产就位（`visualReady`）—— 视觉没装好就不放行。
   */
  const blocked = source === 'online' ? svcDown || !visualReady : !running || engineMissing;
  // 哪些屏在服务未就绪时让位，判定集中在 nav.ts 一处（设置页与音乐屏有例外）
  const showNotReady = blocked && isBlockedWhenNotReady(screen);

  const libSummary = useMemo(() => {
    const l = lib as LibraryResponse | null;
    if (!l) return '扫描中…';
    return `${l.count} 部 · ${l.totalImages} 张 · 占 ${formatBytes(l.totalBytes)} · ${l.root}`;
  }, [lib]);

  const toolbar = useMemo(() => {
    if (showNotReady) {
      return {
        title: '服务未就绪',
        subtitle: '本地翻译服务没有运行 · 已完成的作品与任务不会丢失',
        // 设计稿在标题旁挂「离线」徽标：一眼说明"现在为什么什么都点不了"
        badge: '离线',
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
        subtitle: '本地音乐与在线音源 · 网易云 / 酷狗 / QQ / 咪咕',
        // 账号是**全应用级**身份状态：放工具条右侧动作组，切 Tab / 切屏位置都不动
        actions: <ToolbarAccount />,
      };
    }
    /*
     * 番剧屏：标题随模块内视图变（十屏共用壳层工具条）。
     * 与翻译应用的区别：那边切的是 Tab（壳层 `view`），这边切的是模块内 `view`。
     */
    if (screen === 'anime') {
      const meta = ANIME_VIEW_META[animeView];
      return {
        title: meta.title,
        subtitle: meta.sub,
        actions: (
          <>
            <Badge>独立服务 · 零 Node</Badge>
            <Btn kind="ghost" size="sm" onClick={() => void useAnimeStore.getState().refreshLibrary()}>
              刷新番剧库
            </Btn>
          </>
        ),
      };
    }
    if (screen === 'settings') {
      return {
        title: '设置',
        // 设计稿工具条：分组数 / 项数都算自 catalog，界面里没有写死的 5 与 34
        subtitle: `${SETTINGS_SECTIONS.length} 组 · ${SECTION_ITEM_TOTAL} 项 · 改动即时保存在本机`,
        actions: (
          <>
            {appVersion ? <Badge>v{appVersion}</Badge> : null}
            <Btn kind="ghost" size="sm" onClick={() => setLogsOpen(true)}>
              <Terminal size={13} />
              运行日志
            </Btn>
          </>
        ),
      };
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
          subtitle: '拖入图片或文件夹 · 每批 20 张 · 超出的部分自动排队',
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
          subtitle: `串行执行 · 同一时刻只跑 1 个 · 队内 ${queueDepth} 个等待`,
          // 设计稿的标题徽标「共 N 条」：与汇总条同一个数，都来自 /tasks
          badge: `共 ${queueTotal} 条`,
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
    animeView,
    appVersion,
    libRoot,
    libSummary,
    platform,
    push,
    queueDepth,
    queueTotal,
    screen,
    showNotReady,
    source,
    status?.state,
    view,
  ]);

  // 翻译应用的视图 Tab 行；音乐屏不加（《09》§3.3），设置页是全局页也不加；
  // 下载页是覆盖层，也不该顶着翻译视图 Tab。
  const showViewTabs = !showNotReady && screen === 'translate' && overlay === null;

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
    engineProcess: visibleEngineProcess,
    ipcError,
    showNotReady,
    startService,
    restart,
    rows,
    hasRows,
    tasksError,
    queueDepth,
    cancelingIds,
    cancel,
    retry,
    viewComic,
    openTaskDir,
    deleteTasks,
    lib,
    libError,
    libRoot,
    libSummary,
    libraryFocus,
    setLibraryFocus,
    newBookRequest,
    setNewBookRequest,
    refreshAll,
    refreshKey,
    rootDir: status?.root_dir ?? null,
    download: visibleDownload,
    engineMissing,
    downloadEntry,
    openEngineDownload,
    dismissDownload,
    applyDownload,
    mode,
    setTheme,
    sidebarLabels,
    setLabels,
    autoStart,
    setServiceAutoStart,
  };

  return (
    <div className="app" data-screen={screen}>
      <Sidebar
        screen={screen}
        onScreen={setScreen}
        labels={sidebarLabels}
        downloadEntry={downloadEntry}
        onOpenDownload={openEngineDownload}
        animeView={animeView}
        onAnimeView={(v) => {
          setAnimeView(v);
          setScreen('anime');
        }}
      />

      <div className="shell">
        <Toolbar title={toolbar.title} subtitle={toolbar.subtitle} badge={toolbar.badge} actions={toolbar.actions} />

        {showViewTabs ? <ViewTabs view={view} onView={setView} queueCount={queueDepth} rootDir={libRoot} /> : null}

        <div className="content">
          {/*
           * IPC 不可用（浏览器里跑 vite dev / 主进程还没起来）**不占内容区**。
           *
           * 原先是 `.content` 顶部一块 `Notice kind="bad"`，于是无论什么屏、什么状态，
           * 内容区永久挂着一条红条 —— 它把真正的屏内容往下挤，而这条信息本身
           * 是"壳层与主进程之间"的事，不属于任何一屏。改成右下角的轻提示（.shell-ipc-warn）：
           * 不占布局、不遮挡内容，且只在真的连不上时出现一次。
           */}
          {ipcError ? (
            <div className="shell-ipc-warn" role="status">
              <b>桌面端主进程未就绪</b>
              <span>{ipcError}</span>
            </div>
          ) : null}

          {/* 下载页走独立路由（`/engine-download`），由 `DownloadPane` 渲染；
              切页 / 返回不卸载壳层，下载继续在后台跑。 */}
          <Outlet context={shell} />
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
          onStay={() => {
            setQuitOpen(false);
            // 设计稿：留在后台后给一条两级轻提示 —— 否则按完不确定"到底留下了没有"
            toastBus.push('已留到后台', 'info', '翻译服务保持运行');
          }}
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
        运行日志抽屉：由设置页工具条的「运行日志」打开（设计稿 `.side-drawer`）。
        数据取**本地服务**自己的输出（`status.log`），不是引擎阶段日志 —— 两者在排障时
        回答的是不同的问题（服务起没起 / 翻译跑到哪一步）。
      */}
      {/* 按需挂载：抽屉关闭时整块不渲染，读屏不会念到日志内容 */}
      {logsOpen ? <LogConsole log={status?.log ?? []} onClose={() => setLogsOpen(false)} /> : null}

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
 * 状态胶囊（设计稿 `.service-pill`）：**可点**，点开「服务状态与操作」菜单。
 *
 * 旧实现是一枚静态胶囊 —— 它告诉你"服务在跑"，但想问"那我能停它吗 / 日志在哪"
 * 就只能自己去设置页翻。设计稿把它做成入口：三个动作都是服务状态的直接后续。
 *
 * 菜单用 `MenuButton` 同款的浮层样式（`.ui-menu`），触发器则保持胶囊外观 ——
 * 胶囊是这一处的识别符号，换成普通按钮会丢掉"这是一个状态"的语义。
 */
function ServicePill({ status }: { status: ServiceState }) {
  const v = stateView(status);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点外部 / Esc 收起：与其它浮层同一套收场方式
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const running = status === 'running';

  // 状态写进胶囊的 `title`：窄窗会收起 `.svc-text`（只剩圆点），
  // 没有这句就成了"颜色是唯一载体"（《02》§5.2 禁止的那种）。
  return (
    <div className="svc-wrap" ref={wrapRef}>
      {/*
       * 这一枚**刻意**用裸 `<button>`：它需要 `aria-haspopup="menu"`，
       * 而 `Btn` 刻意不开放这个属性（只放 tab / option 两个角色）。
       * 语义正确优先于"统一用 Btn"—— 少这一句，读屏用户不会知道点它会弹出菜单。
       */}
      <button
        type="button"
        className="svc-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`服务状态：${v.text} · 点按查看操作`}
        onClick={() => setOpen((o) => !o)}
      >
        <Dot colorVar={v.colorVar} pulse={running} />
        <span className="svc-text">{v.text}</span>
        <ChevronDown size={12} className="svc-chev" />
      </button>

      {open ? (
        <div className="ui-menu svc-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="ui-menu-item"
            disabled={!running}
            onClick={() => {
              setOpen(false);
              void serviceStop().catch(() => undefined);
            }}
          >
            <Power size={13} />
            <span className="ui-menu-label">
              <b>停止服务</b>
              <small>队列中的任务会被保留</small>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="ui-menu-item"
            onClick={() => {
              setOpen(false);
              navigate('/settings?section=translate');
            }}
          >
            <Settings size={13} />
            <span className="ui-menu-label">
              <b>打开翻译服务设置</b>
              <small>端口 / 令牌 / 引擎与模型</small>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="ui-menu-item"
            onClick={() => {
              setOpen(false);
              navigate('/engine-download');
            }}
          >
            <Download size={13} />
            <span className="ui-menu-label">
              <b>查看引擎下载</b>
              <small>装配进度与模型体积</small>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
