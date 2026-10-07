/**
 * IA 导航模型 —— ver2.0 的**两级结构**（《09》§3.1 / §3.2）。
 *
 * ver1.0 把「队列 / 漫画库 / 投放」三个入口平铺在侧栏，那是**分类学错误**：
 * 它们其实是「漫画翻译」这一个应用的三个内部视图，与独立应用「音乐」平级会读成
 * 「音乐是翻译的第四步」。本文件把层级拆开：
 *
 * - **壳层 `Screen`** = 2 个应用 + 1 个全局设置。侧栏只渲染这一层。
 * - **应用内 `TranslateView`** = 投放 / 队列 / 漫画库。收进 Tab 行，按工作流时序排列。
 *
 * 刻意**不新增 Screen 枚举值**去承载三个视图 —— 它们不是屏，是 Tab。
 * 这样 `showNotReady` 只需在一处判定（App.tsx），也避免"拦截纪律"散落到多处失效。
 */
import type { ServiceState } from '@/ipc';

/** 应用层：两个独立应用。顺序即侧栏渲染顺序。 */
export type AppId = 'translate' | 'music';

/**
 * 壳层屏 = 应用层 + 全局层。
 *
 * `settings` 属全局层（侧栏分隔线以下、纯图标入口），它不是应用 —— 没有工具条标题、
 * 不参与翻译视图 Tab，因此单列而不并入 `AppId`。
 */
export type Screen = AppId | 'settings';

/** 漫画翻译应用内的视图（《09》§3.2）。 */
export type TranslateView = 'drop' | 'queue' | 'library';

/**
 * 视图 Tab 的**唯一事实源** —— 渲染、C9 断言、深链解析都从这里读。
 *
 * 顺序是断言对象而非实现细节：ver1.0 的「队列→漫画库→投放」与真实工作流**逆序**
 * （先看队列其实什么也看不到，得先投），本轮按工作流时序纠正为 投放→队列→漫画库。
 * 刻意不给它加可选的排序参数 —— 一旦允许调用方决定顺序，C9 就没有稳定判据了。
 */
export const TRANSLATE_VIEWS: { id: TranslateView; label: string; hint: string }[] = [
  { id: 'drop', label: '投放', hint: '拖入图片或文件夹' },
  { id: 'queue', label: '队列', hint: '任务列表' },
  { id: 'library', label: '漫画库', hint: '已完成译文' },
];

export const APP_LABEL: Record<AppId, string> = {
  translate: '漫画翻译',
  music: '音乐',
};

/** 应用名 → 它有哪些视图（音乐为 null：内部自成一个工作区，不加 Tab，见《09》§3.3） */
export const APP_VIEWS: Record<AppId, TranslateView[] | null> = {
  translate: TRANSLATE_VIEWS.map((v) => v.id),
  music: null,
};

/**
 * 服务五态 → 文字 + 色相令牌（《02》§2.1 的五态机；颜色只由点承载，文字同步给出）。
 *
 * ⚠️ `stopping` 必须在这里出现，且**不是**可省项：`Record<ServiceState, …>` 是穷尽映射，
 * 少一个键 TS 就报错（这正是当初能挡住"Rust 加了状态、TS 没跟"的原因）；
 * 运行时若拿到未知值，`stateView()` 会返回 `undefined`，调用方取 `.text` 即崩。
 */
const STATE_VIEW: Record<ServiceState, { text: string; colorVar: string }> = {
  stopped: { text: '服务未启动', colorVar: '--md-muted' },
  starting: { text: '启动中', colorVar: '--md-blue' },
  running: { text: '服务运行中', colorVar: '--md-success' },
  stopping: { text: '正在停止', colorVar: '--md-muted' },
  error: { text: '服务异常', colorVar: '--md-error' },
};

export function stateView(s: ServiceState) {
  return STATE_VIEW[s];
}

/**
 * 服务未就绪时**哪些屏让位**（《09》§3.2）。
 *
 * - 翻译三视图：数据全在服务里，没服务毫无意义 → 让位给 X-C3。
 * - 设置页：**不让位**。它承载「看状态、重启服务、复制令牌、切主题、跑规格自检」，
 *   恰恰是服务出问题时最需要的那一屏，挡掉只会让人更没辙。
 * - 音乐屏：**不让位**（ver2.0 新增）。引擎是翻译的专属依赖，与音乐无关 ——
 *   沿用 ver1.0 的拦截纪律时若忘了开这个例外，音乐会在引擎未就绪时整片不可用，
 *   而这与「音乐是独立应用」的立意直接矛盾。
 */
export function isBlockedWhenNotReady(s: Screen): boolean {
  return s === 'translate';
}
