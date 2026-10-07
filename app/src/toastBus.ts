/**
 * 全局吐司总线 —— 灵动岛那条**唯一**通道的出口。
 *
 * ## 为什么需要它（这是个真实的结构问题，不是抽象偏好）
 * `useToasts()` 内部是 `useState`：**每次调用都得到一份独立 state**。
 * 所以 `App.tsx` 里的 `push` 和 `MusicScreen` 里的 `push` 是**两个互不相通的队列** ——
 * 如果灵动岛订阅的是 App 那一份，音乐屏推的提示它永远收不到，
 * 而音乐屏那套又会自己渲染一次 → 同一条提示要么丢、要么显示两次。
 *
 * 常见的替代方案（zustand store / context）都各有代价：
 * ① 放进 zustand：吐司是**纯 UI 瞬态**，放进音乐业务 store 里会让一个非音乐模块
 *    依赖 `@music/store`，方向反了。
 * ② 用 React Context：本项目已裁定**全仓零 React Context**（《09》§2.3.3）。
 * ③ 提升到 App 再用 props 层层传：灵动岛是**并列**的浮层，不是某屏的子组件，
 *    透传会把它硬绑到树的一个位置，反而更糟。
 *
 * 所以用**模块级订阅表**：不引依赖、不违反零 Context、不让吐司依赖业务 store，
 * 且任意模块都能 `toastBus.push(...)`（音乐屏、未来的桌面歌词窗等）。
 *
 * ## 它为什么该放在这里
 * 本文件是**唯一**入口，`useToasts` 与 `DynamicIsland` 都从这里收发 ——
 * 只有一个事实源，不存在"两边各自的队列"。
 */
import { useEffect, useState } from 'react';

/**
 * 吐司语义色（**六态**，对齐参考实现的 `IslandStatus`）。
 *
 * ## 为什么保留 `good` / `bad` 两个旧名，而不是直接改名
 * 全仓有 6 处业务在用 `push(text, 'good' | 'bad' | 'info')`
 * （服务重启 / 漫画库 / 打开目录 / 设置页 / music/Toast 转发器）。
 * 直接改名会让这 6 处一起变红，且改动会溢出灵动岛以外 —— 越界。
 * 所以：**旧名保留、只做映射**（good→success、bad→error、info→info），
 * 再**新增**参考实现里另有语义的 `warning` / `loading` / `blue`。
 * 映射表落在渲染侧（`DynamicIsland.tsx` 的 `KIND_TO_STATUS`），总线只负责搬运。
 */
export type ToastKind = 'info' | 'good' | 'bad' | 'warning' | 'loading' | 'blue';

export interface BusToast {
  id: number;
  text: string;
  kind: ToastKind;
}

type Listener = (list: BusToast[]) => void;

let seq = 0;
let queue: BusToast[] = [];
const listeners = new Set<Listener>();

function emit() {
  // 复制一份再发：监听方可能在回调里 push（会改 queue），直接传引用会读到半更新状态
  const snapshot = [...queue];
  for (const l of listeners) l(snapshot);
}

export const toastBus = {
  push(text: string, kind: ToastKind = 'info', ttlMs?: number) {
    const id = ++seq;
    queue = [...queue, { id, text, kind }];
    emit();
    // 与 useToasts 原有的时长保持一致：报错给更长时间（用户要读完错误）
    const ttl = ttlMs ?? (kind === 'bad' ? 6500 : 3800);
    window.setTimeout(() => toastBus.dismiss(id), ttl);
    return id;
  },

  dismiss(id: number) {
    if (!queue.some((t) => t.id === id)) return;
    queue = queue.filter((t) => t.id !== id);
    emit();
  },

  clear() {
    if (queue.length === 0) return;
    queue = [];
    emit();
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** 仅供 DynamicIsland 的 useSyncExternalStore 读取 */
  getSnapshot(): BusToast[] {
    return queue;
  },
};

/**
 * 订阅吐司总线。返回**最后一条**而非数组 —— 灵动岛一次只显示一条，
 * 少传一层数据、少一层无谓的重渲染。
 */
export function useToastsFromBus(): BusToast | null {
  const [last, setLast] = useState<BusToast | null>(() =>
    queue.length > 0 ? queue[queue.length - 1] : null,
  );

  useEffect(() => {
    // 订阅时先同步一次：挂载前已入队的提示不能丢
    setLast(queue.length > 0 ? queue[queue.length - 1] : null);
    return toastBus.subscribe((list) => {
      setLast(list.length > 0 ? list[list.length - 1] : null);
    });
  }, []);

  return last;
}
