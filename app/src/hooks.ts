import { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiGet,
  errorText,
  isApiError,
  onQuitRequested,
  onServiceState,
  serviceStatus,
  type ServiceStatus,
} from './ipc';
import type { LibraryResponse, TaskListResponse } from './types';

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
 * 已记入 docs/spec-notes.md D-11。
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

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'good' | 'bad';
}

let toastSeq = 0;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, text, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'bad' ? 6500 : 3800);
  }, []);

  return { toasts, push };
}
