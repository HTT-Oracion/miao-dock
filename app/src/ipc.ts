/**
 * 与 Rust 层的唯一通道。
 *
 * 桌面端**不直接从 WebView 请求 box-service**，一律经 IPC 转发，理由见
 * `src-tauri/src/commands.rs` 的文件头：① 契约 Origin 白名单不放行 WebView 的 Origin；
 * ② 令牌不进 WebView；③ 错误信封在 Rust 侧统一解析，前端拿到的是结构化错误。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// ------------------------------------------------------------------ 服务状态

/**
 * 服务五态（《02》§2.1）。
 *
 * ⚠️ `stopping` 是 S2 加的第五态（Rust `ServiceState::Stopping`），**TS 侧一度漏同步** ——
 * 症状是「正在停止」期间前端把它当未知值：`stateView()` 取到 `undefined` 会直接崩，
 * 而崩之前的表现是"状态点不显示"。所以这里必须与 `service.rs` 逐值对齐。
 */
export type ServiceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

/** 子进程一览（Rust 的 `ChildView`）：`name` ∈ `service` / `engine` / `llm` */
export interface ChildStatus {
  name: string;
  pid: number | null;
  alive: boolean;
}

export interface ServiceStatus {
  state: ServiceState;
  /** box-service 实际端口（5180–5190 段内探测得出） */
  port: number | null;
  token: string | null;
  root_dir: string | null;
  /** sidecar 引擎实际端口（对用户不可见，仅诊断用） */
  sidecar_port: number | null;
  /** ③ LLM 的实际端口（S2 新增） */
  llm_port: number | null;
  /** `real` | `mock` —— 必须显式暴露：否则"以为在跑真引擎、其实跑的替身"最难查 */
  mode: string;
  /**
   * 启动期细分阶段 `L1` / `L2` / `L3`（《02》§4）。
   *
   * 不在启动期时为 `null`。**这是「准备中」界面的唯一事实源** —— 早先的写法是拿
   * `sidecar_port` 是否存在去猜"到第几段了"，那既不知道 L3 只做到一半，也会在
   * 端口先于阶段就绪时把 L1 显示成 L2。
   */
  phase: string | null;
  /** ② 或 ③ 挂了但 ① 还在 ⇒ degraded（任务会失败，服务本身仍可应答） */
  degraded: boolean;
  children: ChildStatus[];
  /** 状态机实际走过的轨迹（自检断言用） */
  transitions: string[];
  log: string[];
  last_error: string | null;
}

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export function isApiError(e: unknown): e is ApiError {
  return typeof e === 'object' && e !== null && 'code' in e && 'message' in e && 'status' in e;
}

export function errorText(e: unknown): string {
  if (isApiError(e)) return e.message || e.code;
  if (e instanceof Error) return e.message;
  return String(e);
}

// ------------------------------------------------------------------ 服务生命周期

export const serviceStatus = () => invoke<ServiceStatus>('service_status');
export const serviceRestart = () => invoke<ServiceStatus>('service_restart');
export const quitApp = () => invoke<void>('quit_app');
export const hideWindow = () => invoke<void>('hide_window');
export const showWindow = () => invoke<void>('show_window');
/**
 * 把主题同步给原生窗口（标题栏 / 红绿灯按钮配色）。
 * `mode` 为 `'light' | 'dark' | null`，null 表示跟随系统。
 */
export const setWindowTheme = (mode: 'light' | 'dark' | null) =>
  invoke<void>('set_theme', { mode });

// ------------------------------------------------------------------ 契约端点代理

export const apiGet = <T,>(path: string) => invoke<T>('api_get', { path });

export const apiPost = <T,>(path: string, body?: unknown) =>
  invoke<T>('api_post', { path, body: body ?? null });

/** `multipart/form-data` 提交（契约 §5.2）：files 为本地绝对路径，前端已按 ≤20 分批 */
export const apiPostMultipart = <T,>(path: string, payload: unknown, files: string[]) =>
  invoke<T>('api_post_multipart', { path, payload, files });

/**
 * 取库内文件字节。返回 `ArrayBuffer`（Rust 侧走 `tauri::ipc::Response` 二进制通道），
 * 前端转 `Blob` → `URL.createObjectURL` 显示；用完必须 `revokeObjectURL`。
 */
export const apiBytes = (path: string) => invoke<ArrayBuffer>('api_bytes', { path });

// ------------------------------------------------------------------ 本机能力

/** 在系统文件管理器里定位路径（契约 §5.8：reveal 由 Box 执行） */
export const openPath = (path: string) => invoke<void>('open_path', { path });

/** 把投放的文件/目录展开为图片绝对路径列表（已按文件名自然序排序） */
export const expandPaths = (paths: string[]) => invoke<string[]>('expand_paths', { paths });

// ------------------------------------------------------------------ 事件

/** 服务四态变化（Rust 侧 emit，前端据此切 X-C3 / 显示状态点） */
export const onServiceState = (cb: (s: ServiceStatus) => void): Promise<UnlistenFn> =>
  listen<ServiceStatus>('miao://service-state', (e) => cb(e.payload));

/** 托盘「退出喵坞…」→ 前端弹二次确认（文案见契约 §2.1） */
export const onQuitRequested = (cb: () => void): Promise<UnlistenFn> =>
  listen('miao://quit-requested', () => cb());
