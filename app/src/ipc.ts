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

export type ServiceState = 'stopped' | 'starting' | 'running' | 'error';

export interface ServiceStatus {
  state: ServiceState;
  /** box-service 实际端口（5180–5190 段内探测得出） */
  port: number | null;
  token: string | null;
  root_dir: string | null;
  /** sidecar 引擎实际端口（对用户不可见，仅诊断用） */
  sidecar_port: number | null;
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
