/**
 * 壳层交给屏的数据（B1 改造的产物）。
 *
 * 为什么需要一个显式接口：屏装配件（`panes/*`）不再是 App 的子组件，而是**路由表里的元素**；
 * 壳层与它们之间只剩 `<Outlet context>` 这一条通道。写成具名接口而不是让类型散着推断 ——
 * 少一个字段时是 `tsc` 当场报错，而不是"点下去没反应"。
 *
 * 🔴 这不是"用 Context 管状态"：状态本身仍住在壳层（`useState` / hooks），这里传的是
 * **壳层那一份的只读视图 + 它的 setter**。`STATE.noReactContext` 禁的是把跨组件共享状态
 * 塞进 Provider（播放内核与 IPC 回调都在组件树外改状态，Provider 之外读不到）。
 */
import type { ServiceStatus } from '@/ipc';
import type { DownloadEntryState } from '@/ipc/engine-download';
import type { Screen, TranslateView } from '@/stores/nav';
import type { ThemeMode } from '@/themes/tokens';
import type { ModelDownloadView } from '@screens/settings/engine-api';
import type { TranslateSource } from '@screens/settings/translate-api';
import type { LibraryResponse, TaskRow } from '@/types';

/**
 * ①/②/③ 三进程的运行态快照（`/engine/status` 里和流程页运行态条共用的那部分）。
 *
 * ① 不在这里 —— 它的状态在 `ShellCtx.status.state`（Tauri 的 `ServiceStatus`）。
 * ②/③ 只在 ① running 时才有意义；服务停掉后壳层会把这一份置空。
 */
export interface EngineProcessView {
  engine: string | null;
  llm: string | null;
  warmed: boolean;
}

export interface ShellCtx {
  // 导航（`useNav()` 的那一份，壳层与屏共用同一个来源）
  screen: Screen;
  view: TranslateView;
  setScreen: (s: Screen) => void;
  setView: (v: TranslateView) => void;
  // 服务与翻译来源
  status: ServiceStatus | null;
  source: TranslateSource | null;
  platform: string | null;
  running: boolean;
  /** ②/③ 进程运行态快照（见 `EngineProcessView`）；① 停掉后壳层置为全空。 */
  engineProcess: EngineProcessView;
  /** 与桌面端主进程通信失败时的说明（壳层横幅） */
  ipcError: string | null;
  /** 服务未就绪且本屏让位（判定仍只在 `isBlockedWhenNotReady` 一处） */
  showNotReady: boolean;
  startService: () => Promise<void>;
  restart: () => Promise<void>;
  // 队列
  rows: TaskRow[];
  hasRows: boolean;
  queueDepth: number;
  cancelingIds: Set<string>;
  cancel: (t: TaskRow) => Promise<void>;
  retry: (t: TaskRow) => Promise<void>;
  viewComic: (t: TaskRow) => void;
  openTaskDir: (t: TaskRow) => void;
  deleteTasks: (taskIds: string[]) => Promise<boolean>;
  // 漫画库
  lib: LibraryResponse | null;
  libRoot: string;
  libSummary: string;
  libraryFocus: string | null;
  setLibraryFocus: (v: string | null) => void;
  newBookRequest: boolean;
  setNewBookRequest: (v: boolean) => void;
  refreshAll: () => void;
  refreshKey: number;
  // 本机投放（落盘根目录）
  rootDir: string | null;
  // 引擎下载（工具条芯片、侧栏入口与下载页的唯一真实来源）
  download: ModelDownloadView | null;
  engineMissing: boolean;
  /** 侧栏入口形态（`hidden` 时整枚按钮不渲染） */
  downloadEntry: DownloadEntryState;
  /** 打开独立下载页（`/engine-download`） */
  openEngineDownload: () => void;
  /** 完成态「关闭下载」：写 dismissal 并移除侧栏入口 */
  dismissDownload: () => void;
  /** 刚发起的下载视图：让下载页立刻有内容，不必等 1.5s 轮询 */
  applyDownload: (view: ModelDownloadView | null) => void;
  // 壳层偏好（设置屏）
  mode: ThemeMode;
  setTheme: (m: ThemeMode) => void;
  sidebarLabels: boolean;
  setLabels: (on: boolean) => void;
  autoStart: boolean;
  setServiceAutoStart: (on: boolean) => void;
}
