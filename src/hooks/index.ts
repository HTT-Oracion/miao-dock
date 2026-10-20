/**
 * hooks 唯一收口的**业务桶**（spec-notes D-41）：服务状态 / 任务列表 / 漫画库 / 翻译来源 / 托盘退出 / 吐司。
 * `use*` 命名的 hook 一律住 `src/hooks/`：业务数据类进本桶（经 `@hooks` 引入），
 * 纯 DOM 行为类单放同目录（如 `@hooks/useEsc`），units 组件不得 import 本目录任何东西。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
// 吐司的**唯一实现**在这里，本文件只做类型与 hook 转发（原因见本文件末尾的吐司段注释）
import { toastBus, type BusToast } from '@/stores/toastBus';
import {
  apiGet,
  errorText,
  isApiError,
  onQuitRequested,
  onServiceState,
  serviceStatus,
  type ServiceStatus,
} from '@/ipc';
import type { LibraryResponse, TaskListResponse } from '@/types';
// 翻译来源的三个端点是 Box 专用契约，形状与调用收口在设置页的 translate-api.ts（P-D1）
import { translateOptions } from '@screens/settings/translate-api';
import type { TranslateSource } from '@screens/settings/translate-api';

// ------------------------------------------------------------------ 服务状态

/**
 * 服务四态 + 端口/令牌/日志。
 *
 * 初始值取一次 IPC，之后只靠 Rust 侧推的 `miao://service-state` 事件更新 ——
 * 不轮询，因为「服务什么时候起来」是 Rust 层唯一知道的事，前端猜不出来。
 */
export function useService() {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [ipcError, setIpcError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    serviceStatus()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch((e) => {
        // 只有在 IPC 本身不可用时才发生（例如浏览器里跑 vite dev，没有 Rust 侧）
        if (alive) setIpcError(errorText(e));
      });
    onServiceState((s) => {
      if (alive) setStatus(s);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return { status, ipcError };
}

// ------------------------------------------------------------------ 任务列表

const POLL_ACTIVE_MS = 1000;
const POLL_IDLE_MS = 4000;

/**
 * 任务列表（`GET /tasks`）。
 *
 * **为什么是轮询而不是 SSE**：桌面端所有请求都经 Rust IPC 转发，而 `api_get` 是
 * 缓冲式请求-响应，无法承载事件流（SSE 是给插件端用的，契约 §5.5）。轮询读的是
 * **同一个 store**，所以进度数字与插件端 SSE 看到的一致 —— 只是到达方式不同。
 * 已记入 docs/internal/spec-notes.md D-11。
 *
 * 有任务在跑时 1s 一次，空转时 4s 一次 —— 空闲时不要拿轮询去磨电池。
 */
export function useTasks(enabled: boolean) {
  const [data, setData] = useState<TaskListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<TaskListResponse | null>(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (!enabled || busy.current) return;
    busy.current = true;
    try {
      const r = await apiGet<TaskListResponse>('/tasks');
      latest.current = r;
      setData(r);
      setError(null);
    } catch (e) {
      // 服务未就绪时不要用错误糊满界面：X-C3 已经在解释原因了
      if (!isApiError(e) || e.code !== 'SERVICE_UNAVAILABLE') setError(errorText(e));
    } finally {
      busy.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      await load();
      if (stopped) return;
      const d = latest.current;
      // 读 ref 而不是闭包里的 data：否则整条定时链会被第一轮的空值钉死
      const active = d === null || d.running + d.queued > 0;
      timer = window.setTimeout(() => void tick(), active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [enabled, load]);

  return { data, error, reload: load };
}

// ------------------------------------------------------------------ 漫画库

export function useLibrary(enabled: boolean, refreshKey: number) {
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      setData(await apiGet<LibraryResponse>('/library'));
      setError(null);
    } catch (e) {
      if (!isApiError(e) || e.code !== 'SERVICE_UNAVAILABLE') setError(errorText(e));
    }
  }, [enabled]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return { data, error, reload: load };
}

// ------------------------------------------------------------------ 翻译来源

/**
 * 翻译来源（P-D1）：**服务的设置，不是任务的属性** —— 用户只在设置里选一次，
 * manga-service 记住它；投放 / 队列 / 重试 / 返工 / 浏览器插件都不加来源控件。
 *
 * 读一次 `/translate/options`。服务没起来（或请求被拒）时 `source=null`，
 * 调用方按**本地**处理：设置读失败不该把翻译屏锁死 —— 那意味着此刻没有任何
 * HTTP 通道，准入判据回落到"服务没 running 就拦"（ver2.1 现状），不会更松。
 * 服务起到 running 之后由调用方调 `reload()` 补读（见 App.tsx 的补读时机注释）。
 */
export function useTranslateSource() {
  const [source, setSource] = useState<TranslateSource | null>(null);
  const [platform, setPlatform] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /*
   * 自取消守卫与设置页 `loadSrc` 同款（含 StrictMode 双调用那次教训）：
   * `alive.current = true` 必须写在挂载 effect 里 —— 只写卸载那一半的话，
   * 开发模式下第一次 cleanup 会把它永久钉成 false，来源永远停在初始值。
   */
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const o = await translateOptions();
      if (!alive.current) return;
      setSource(o.settings.source);
      setPlatform(o.settings.platform);
    } catch {
      // 读不到按本地处理（见上方注释）：不设错误态 —— 这一读失败没有"用户该做什么"，
      // 服务没起来时 X-C3 已经在解释原因了
      if (!alive.current) return;
      setSource(null);
      setPlatform(null);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  return { source, platform, loading, reload: load };
}

// ------------------------------------------------------------------ 托盘退出请求

/** 托盘「退出喵坞…」→ Rust 只负责把窗口拉到前台并发事件，二次确认在这里弹 */
export function useQuitRequest(onRequest: () => void) {
  const cb = useRef(onRequest);
  cb.current = onRequest;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onQuitRequested(() => cb.current())
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);
}

// ------------------------------------------------------------------ 吐司

/**
 * 吐司类型。**实现在 `src/stores/toastBus.ts`（基础设施，与 ipc/types 同级）**（模块级单例），这里只做类型转发。
 *
 * 迁移原因（结构问题，不是偏好）：原先状态是 `useState`，而 **useState 每次调用各得一份** ——
 * `App.tsx` 的 push 与 `MusicScreen` 的 push 是两个互不相通的队列。
 * 灵动岛只订阅其中一份，于是另一份推的提示**永远收不到**（症状：提示偶尔丢失）。
 * 单例总线消除"哪一份"这个问题，且不引依赖、不违反《09》§2.3.3 的零 Context 裁定。
 */
export type Toast = BusToast;

export function useToasts() {
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    toastBus.push(text, kind);
  }, []);
  // dismiss 直接给总线的方法（引用稳定，不需要再包一层 useCallback）
  // 渲染由 components/NotificationStack 承担（它自己 useToastList 订阅全量），这里只出「推」
  return { push, dismiss: toastBus.dismiss };
}

// ------------------------------------------------------------------ 引擎下载

// 先确保 ① 在运行、再发起下载的服务层 hook（单飞守卫不当错误处理）。
export { useEngineDownload } from './useEngineDownload';
export type { StartDownloadResult } from './useEngineDownload';

// 番剧播放器：取播放事实 + 建 WebView 轨播放器 + 回写续看位置
export { useAnimePlayback } from './useAnimePlayback';
export type { AnimePlayback, AnimePlaybackOptions } from './useAnimePlayback';
