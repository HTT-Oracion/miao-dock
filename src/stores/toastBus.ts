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
 * ① 放进 zustand：吐司是**纯 UI 瞬时态**，放进音乐业务 store 会让一个非音乐模块
 *    依赖 `@music/store`，方向反了。
 * ② 用 React Context：本项目已裁定**全仓禁 React Context**。
 * ③ 提升到 App 再用 props 层层传：灵动岛是**并列**的浮层，不是某屏的子组件，
 *    透传会把它硬绑到树的一个位置，反而更糟。
 *
 * 所以用**模块级订阅表**：不引依赖、不违反禁 Context、不让吐司依赖业务 store，
 * 且任意模块都能 `toastBus.push(...)`（音乐屏、桌面歌词窗等）。
 *
 * ## 两级文案（设计稿 `toast-body`）
 * 设计稿的 toast 是 `strong` 标题 + `span` 说明两行：标题说"发生了什么"，
 * 说明补"这意味着什么"。`push(text)` 只给标题时说明行不渲染 —— 向后兼容既有调用。
 */
import { useEffect, useState } from 'react';

/**
 * 吐司语义色（**六态**）。
 *
 * ## 为什么保留 `good` / `bad` 两个旧名，而不是直接改名
 * 全仓有 16 处业务在用 `push(text, 'good' | 'bad' | 'info')`
 * （服务重启 / 漫画库 / 打开目录 / 设置页 / music/Toast 转发器）。
 * 直接改名会让这 16 处一起变红，且改动会溢出灵动岛以外 —— 越界。
 * 所以：**旧名保留、只做映射**（good→success、bad→error、info→info），
 * 另**新增**设计稿里另有语义的 `warning` / `loading` / `blue`。
 * 映射表落在渲染侧（`NotificationStack.tsx` 的 `KIND_TO_COLOR`），总线只负责搬运。
 */
export type ToastKind = 'info' | 'good' | 'bad' | 'warning' | 'loading' | 'blue';

export interface BusToast {
  id: number;
  /** 标题行（设计稿 `toast-body strong`） */
  text: string;
  /** 说明行（设计稿 `toast-body span`）；空串则不渲染 */
  detail: string;
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
  /**
   * 推一条提示。
   *
   * @param text 标题（必填，设计稿 `toast-body strong`）
   * @param kind 语义色
   * @param detail 说明行（可选，设计稿 `toast-body span`）
   * @param ttlMs 存活时长（可选；默认报错 6.5s、其余 3.8s）
   */
  push(text: string, kind: ToastKind = 'info', detail = '', ttlMs?: number) {
    const id = ++seq;
    queue = [...queue, { id, text, detail, kind }];
    emit();
    // 与 useToasts 原有时间长保持一致：报错给更长时间（用户要读完错误）
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
 * 订阅吐司总线（**全量列表**）—— 通知堆叠（NotificationStack）的读取口。
 *
 * 轻提示的承载从灵动岛剥离成 topRight 的通知堆叠，堆叠要**同时**展示多条，
 * 所以给全量列表而不是"最后一条"。总线本身不变：仍是唯一队列 + 单例订阅表。
 */
export function useToastList(): BusToast[] {
  const [list, setList] = useState<BusToast[]>(() => [...queue]);

  useEffect(() => {
    // 订阅时先同步一次：挂载前已入队的提示不能丢
    setList([...queue]);
    return toastBus.subscribe((l) => setList(l));
  }, []);

  return list;
}
