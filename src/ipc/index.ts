/**
 * 与 Rust 层的唯一通道。
 *
 * 桌面端**不直接从 WebView 请求 manga-service**，一律经 IPC 转发，理由见
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

/**
 * 引擎**运行时就绪检测**里的一项（D1）—— 与 `GET /engine/runtime` 同形。
 *
 * `path` 是判据**真正作用的那个绝对路径**；`ok` 为真时没有 `fix`（"已经好了还给人装法"是噪声）。
 */
export interface RuntimeItem {
  id: string;
  ok: boolean;
  path: string;
  detail: string;
  /** 没就绪时给怎么装；就绪时**不存在这个键** */
  fix?: string;
}

/**
 * 一个装配档位的就绪与字节（D-233 五段流程）。
 *
 * `entries === 0` = 当前平台没有该档位（不是"已就绪"）；`readyBytes` 只算在位条目。
 */
export interface RuntimeSetView {
  entries: number;
  ready: boolean;
  totalBytes: number;
  readyBytes: number;
}

export interface RuntimeProbe {
  items: RuntimeItem[];
  /** 七项全真 = 引擎具备启动的最低条件 */
  ready: boolean;
  /**
   * 按清单档位细分：`visual` / `translation` / `llm` / `runtime`。
   *
   * 🔴 只用于五段流程逐段推进；`ready` 仍是七项全真，不能拿 `sets` 取代它。
   */
  sets?: Record<string, RuntimeSetView>;
  /** 当前平台要下的**模型资产**字节和（不含用户自己的 Python/torch；0 = 清单读不到） */
  requiredBytes: number;
}

export interface ServiceStatus {
  state: ServiceState;
  /** manga-service 实际端口（5180–5190 段内探测得出） */
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
  /**
   * 引擎运行时就绪检测（D1）—— 与 `GET /engine/runtime` **同一份** `probe()`。
   *
   * 🔴 它随 `service_status` 一起来、而不是让界面去请求 HTTP：D1 要覆盖的场景恰恰是
   *    「real 档未装配 ⇒ 一个子进程都不起」（D6 闸门在 spawn 前就失败），那一刻
   *    HTTP 通道根本不存在，而界面必须答得出「缺 python（<绝对路径>）」。
   */
  runtime: RuntimeProbe;
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
/**
 * 手动启动本地服务（**幂等**：已在启动中/运行中时原样返回当前状态，不会起第二套进程树）。
 *
 * 调用方会让它被调用得比想象中频繁 —— `React.StrictMode` 下 effect 开发期故意跑两遍，
 * 加上"进入翻译模块自动启动"与用户连点。幂等性在 Rust 侧 `start_once` 里保证，
 * 前端**不必**自己去重。
 */
export const serviceStart = () => invoke<ServiceStatus>('service_start');
/** 手动停止本地服务（回收整棵三进程树，Rust 侧是阻塞操作、最坏约 5s） */
export const serviceStop = () => invoke<ServiceStatus>('service_stop');
export const serviceRestart = () => invoke<ServiceStatus>('service_restart');
export const quitApp = () => invoke<void>('quit_app');
export const hideWindow = () => invoke<void>('hide_window');
export const showWindow = () => invoke<void>('show_window');
/**
 * 把主题同步给原生窗口（标题栏 / 红绿灯按钮配色）。
 * `mode` 为 `'light' | 'dark' | null`，null 表示跟随系统。
 */
export const setWindowTheme = (mode: 'light' | 'dark' | null) => invoke<void>('set_theme', { mode });

// ------------------------------------------------------------------ 契约端点代理

export const apiGet = <T>(path: string) => invoke<T>('api_get', { path });

export const apiPost = <T>(path: string, body?: unknown) => invoke<T>('api_post', { path, body: body ?? null });

/** `DELETE` 代理（带可选 JSON 体）。目前唯一用途是移除封面 —— 契约里它只有 DELETE 一种动词 */
export const apiDelete = <T>(path: string, body?: unknown) => invoke<T>('api_delete', { path, body: body ?? null });

/**
 * `multipart/form-data` 提交（契约 §5.2）：files 为本地绝对路径，前端已按 ≤20 分批。
 *
 * `field` = 文件分片的**字段名**，默认 `images[]`（批量投放用）。封面走同一条通道但
 * 服务端按契约认的是 `cover`，故那里必须显式传 `'cover'`。
 */
export const apiPostMultipart = <T>(path: string, payload: unknown, files: string[], field?: string) =>
  invoke<T>('api_post_multipart', { path, payload, files, field: field ?? null });

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

/**
 * 把一段文本写到**用户刚在保存对话框里选定**的那个路径（设置页「全部日志」抽屉的「导出 .txt」）。
 *
 * 路径来自系统保存对话框，本函数不拼接、不猜测、不创建目录 —— 因而也不需要宽泛的
 * 文件系统权限：能力边界正好是"用户自己选的那一个文件"。
 */
export const writeTextFile = (path: string, contents: string) => invoke<void>('write_text_file', { path, contents });

// ------------------------------------------------------------------ 事件

/** 服务四态变化（Rust 侧 emit，前端据此切 X-C3 / 显示状态点） */
export const onServiceState = (cb: (s: ServiceStatus) => void): Promise<UnlistenFn> =>
  listen<ServiceStatus>('miao://service-state', (e) => cb(e.payload));

/** 托盘「退出喵坞…」→ 前端弹二次确认（文案见契约 §2.1） */
export const onQuitRequested = (cb: () => void): Promise<UnlistenFn> => listen('miao://quit-requested', () => cb());
