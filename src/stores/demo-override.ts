/**
 * 演示态覆盖层（zustand）—— 只服务「演示面板」里那六个状态开关。
 *
 * ## 为什么是"覆盖"而不是"另造一套数据"
 * 任务书要求状态**与真实状态机绑定**、不许写死数据。真实状态机是：
 * `ServiceStatus.state`（stopped / starting / running / stopping / error）
 * ＋ `runtime.ready` / `runtime.items`（引擎装配）＋ `modelDownload.step`（五段进度）。
 * 演示面板要做的是"把这台状态机的输入换成演示输入"，**渲染与判定一行都不改** ——
 * 所以这里只存一份 `override`，由壳层在**派生层**套上去（`App.tsx` 的 `visibleStatus`），
 * 屏层读到的仍是同一个 `ServiceStatus`，走的仍是同一条渲染路径。
 *
 * ## 为什么覆盖只允许「演示」档
 * 覆盖一旦落到真机上就是"界面显示服务在跑、实际没跑"。故它只在
 * `import.meta.env.DEV` 且**用户真的点了演示面板**时存在；生产构建里演示面板本身不渲染。
 *
 * ## 六个状态（设计稿演示面板的【漫画服务】五项 → 本产品的六项）
 *   1 服务运行中 · 2 启动中 · 3 服务未启动 · 4 服务异常 · 5 引擎未装配 · 6 五段装配中
 * 前四项与服务五态一一对应（`stopping` 不单列：它在界面上是同一张"正在收尾"的卡）；
 * 第 5、6 项落到装配链上：5 = 缺件且没有下载活动，6 = 下载进行中（`step` 决定亮到第几段）。
 */
import { create } from 'zustand';

/** 演示可切换的六个状态（顺序即面板渲染顺序，与设计稿一致）。 */
export type DemoState = 'running' | 'starting' | 'stopped' | 'error' | 'unassembled' | 'assembling';

export const DEMO_STATES: { id: DemoState; label: string; hint: string }[] = [
  { id: 'running', label: '服务运行中', hint: '三进程就绪，可投放' },
  { id: 'starting', label: '启动中', hint: '正在拉起子进程' },
  { id: 'stopped', label: '服务未启动', hint: '手动启动前的形态' },
  { id: 'error', label: '服务异常', hint: '诊断 + 重启入口' },
  { id: 'unassembled', label: '引擎未装配', hint: '缺件，五段待装' },
  { id: 'assembling', label: '五段装配中', hint: '下载进行中' },
];

interface DemoOverrideState {
  /** `null` = 不覆盖，一切读真实状态 */
  active: DemoState | null;
  set: (s: DemoState | null) => void;
  /** 当前是否处在"演示中"（侧栏/工具条据此显示一枚提示，避免把演示态当真） */
  isActive: () => boolean;
}

export const useDemoOverride = create<DemoOverrideState>((set, get) => ({
  active: null,
  set: (s) => set({ active: s }),
  isActive: () => get().active !== null,
}));
