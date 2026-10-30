/**
 * 契约数据模型的前端视图（《03》§3、§5）。
 *
 * 只声明**前端真正读到的字段**——不把契约里没用的字段抄进来，
 * 免得后续契约变更时误以为前端依赖了它。
 */

// ------------------------------------------------------------------ 任务 / 队列

export type TaskStatus = 'queued' | 'running' | 'done' | 'partial_failed' | 'failed' | 'canceled';

/** 来源归因（服务端按 `X-Box-Client` 判定，见 docs/internal/spec-notes.md G-04） */
export type TaskSource = 'extension' | 'desktop' | 'unknown';

export interface TaskProgress {
  total: number;
  done: number;
  failed: number;
  /** 当前正在翻译的序号；0 = 无 */
  current: number;
}

/** `GET /tasks` 的一行（契约外增量端点，docs/internal/spec-notes.md G-04） */
export interface TaskRow {
  taskId: string;
  comicName: string;
  /**
   * 归一化后的目录名（漫画库用它和 `ComicEntry` 对上，见 store 的 `listView` 注释）。
   *
   * **可选**：这是后加的字段，`state/tasks/*.json` 里恢复出来的旧任务快照没有它。
   * 消费方必须容忍 `undefined`（拿 `comicName` 兜底），别把它当必填。
   */
  normalizedComicName?: string;
  source: TaskSource;
  status: TaskStatus;
  queuePosition: number;
  progress: TaskProgress;
  outputDir: string;
  createdAt: string;
  finishedAt: string | null;
  /**
   * 失败页的原始原因（只含失败项）。
   *
   * 队列行原本只显示「N 页失败」，看不出**为什么**。这个字段带引擎原话，
   * 供行的 `title` / 失败提示直接展示。**可选**：旧任务快照没有它。
   */
  failedItems?: { seq: number; reason: string | null; errorMessage: string | null }[];
}

export interface TaskListResponse {
  count: number;
  total: number;
  running: number;
  queued: number;
  tasks: TaskRow[];
  updatedAt: string;
}

/** 契约 §5.2 的建单响应（前端只用其中几项：落盘预览、位次、eta） */
export interface CreateTaskResponse {
  taskId: string;
  comicName: string;
  normalizedComicName: string;
  outputDir: string;
  status: TaskStatus;
  queuePosition: number;
  eta: { minSeconds: number; maxSeconds: number; text: string } | null;
  createdAt: string;
}

/** 契约 §5.6 的取消响应 */
export interface CancelResponse {
  taskId: string;
  status: 'canceled';
  keptItems: number;
  outputDir: string;
}

// ------------------------------------------------------------------ 漫画库

export interface ComicEntry {
  comicName: string;
  dirName: string;
  outputDir: string;
  imageCount: number;
  translatedCount: number;
  /** G-01 口径：目录内所有文件字节数之和 */
  byteSize: number;
  seqMax: number;
  nextSeq: number;
  /**
   * 已译页码（升序）。**判定「哪一页已译」必须用它，不能用 `translatedCount`** ——
   * 缺页落在中间时（如 seq=3 翻译失败），`seq <= translatedCount` 会把后面每一页
   * 整体前移一位，把没译文的页标成「已译」。见 spec-notes G-10。
   */
  translatedSeqs: number[];
  /**
   * 1..seqMax 内**没有原图**的页码（正常为空数组）。
   * 引擎失败**不会**产生这种洞 —— 那些页的原图照落盘（G-11），它们属于「有原图、缺译文」，
   * 在网格卡上显示为「待译」。真正的来源是外部把文件拿掉了：用户自己删、目录没拷全。
   */
  missingSeqs: number[];
  modifiedAt: string | null;
}

/**
 * 漫画（本 / 大类）——「本 → 话 → 页」三层里的**顶层**（设计稿 §11.1）。
 *
 * 与 `ComicEntry` 的关系：`ComicEntry` 是**目录级**的平铺视图（一目录一条），
 * 大类目录也会出现在 `comics` 里；`BookEntry` 只对**带 `manifest.json` 的目录**产出，
 * 并把内部的每个话目录展开成 `chapters`。两者并存是有意的 —— `comics` 是既有消费方
 * （队列「查看」的定位、删除弹窗、返工端点）的口径，不能因为多了「话」这一层就换掉。
 */
export interface BookEntry {
  bookName: string;
  /** 归一化后的目录名；本体与 `bookName` 同值，留着是为了和 `TaskRow.normalizedComicName` 对得上 */
  dirName: string;
  outputDir: string;
  title: string;
  /** 空串 = 未署名（UI 显示「未署名」，判空**不能用** `!author` 之外的口径） */
  author: string;
  /**
   * 封面在书籍目录内的**文件名**（`cover.png` 等，不含目录）；无封面为 `null`。
   *
   * ⚠️ 它**不是**可直接渲染的 URL：WebView 读不了任意本地路径。取字节要走
   * `GET /library/{book}/cover`（见 spec-notes D-116），本字段只用来判「有没有封面」。
   */
  coverPath: string | null;
  chapterCount: number;
  totalPages: number;
  byteSize: number;
  modifiedAt: string | null;
  /** 本大类下的全部话（按话号升序，服务端已排好） */
  chapters: ChapterEntry[];
}

/**
 * 话。
 *
 * 同一形状服务两种来源（设计稿 §11.1 特意用一个类型）：
 * - **已归并**：大类目录里的 `01_第1话` 子目录 ⇒ `no` 有值、`merged: true`、`mergedTo` 有归属；
 * - **未归并单话**：库根下的普通目录 ⇒ `no`/`mergedTo` 均为 `null`、`merged: false`。
 *
 * `no` 与 `mergedTo` 恒存在（不用 `'no' in item` 之类"字段在不在"来判分支）——
 * 未归并时它们的值就是 `null`。
 */
export interface ChapterEntry {
  /** 已归并：话号；未归并：`null`（它还没有话号） */
  no: number | null;
  /** 已归并 = `01_第1话`；未归并 = 原单话目录名 */
  dirName: string;
  /** 绝对路径（打开目录 / 取图用） */
  absDir: string;
  imageCount: number;
  translatedCount: number;
  seqMax: number;
  /** 已译页码（升序）。逐页判定必须用集合，禁用 `seq <= translatedCount`（G-10） */
  translatedSeqs: number[];
  missingSeqs: number[];
  /** 是否已被归并 —— 决定它能否被单独删除（已归并的不能，只能从所属漫画里删） */
  merged: boolean;
  /** 已归并时的归属；未归并为 `null` */
  mergedTo?: { bookName: string; no: number } | null;
  /**
   * 话目录最后修改时间（ISO 秒级，服务端 `modifiedAt`）。
   * 设计稿话卡的「更新于 …」用它；**可选**：旧服务端不返回。
   */
  modifiedAt?: string | null;
}

export interface LibraryResponse {
  root: string;
  count: number;
  totalImages: number;
  totalBytes: number;
  /**
   * **目录级**平铺视图（含大类目录与未归并单话，逐字节向后兼容旧服务端）。
   * 新代码做「本 → 话 → 页」的分层渲染时用 `books` / `others`，但定位/删除/返工仍按本字段。
   */
  comics: ComicEntry[];
  /** 大类（带 `manifest.json` 的目录）；**可选**：旧服务端不返回 */
  books?: BookEntry[];
  /** 未归并的单话（库根下没有 `manifest.json` 的目录，即左栏「其它」分组）；**可选** */
  others?: ChapterEntry[];
  /**
   * 被「只从库里移除、不删本地文件」的漫画名（服务端持久化在 `state/hidden-comics.json`）。
   *
   * 为什么需要它：漫画库是**目录即索引** —— 目录还在、扫描就一定会扫到它。
   * 于是「删除但不删文件」这个动作在文件系统里无处安放，只能另存一份"忽略名单"。
   * `comics` 里已排除它们；`POST /library/{name}/unhide` 可恢复。
   */
  hidden?: string[];
  hiddenCount?: number;
  updatedAt: string;
}

/** `POST /tasks/delete` 的响应（队列多选删除）：逐条回报，不整批失败 */
export interface DeleteTasksResponse {
  deleted: string[];
  /** 未删的原因：`not_found`（已被别处删掉）/ `not_deletable`（翻译中或排队中） */
  skipped: { taskId: string; reason: 'not_found' | 'not_deletable'; status?: TaskStatus }[];
  deletedCount: number;
  skippedCount: number;
}

/** `POST /library/{comicName}/delete` 的响应 */
export interface LibraryDeleteResponse {
  comicName: string;
  /** true = 连本地目录一起删了；false = 只从库里隐藏 */
  deletedFiles: boolean;
  outputDir?: string;
  hidden?: string[];
  hiddenCount?: number;
}

/** `GET /library/{comicName}/retranslate` 的响应（返工计划） */
export interface RetranslatePlan {
  comicName: string;
  /** 归一化后的目录名（= `TaskRow.normalizedComicName`），用于和任务列表对上 */
  dirName: string;
  outputDir: string;
  imageCount: number;
  translatedCount: number;
  /** 有原图的页数 = 本次默认返工的范围 */
  retranslateCount: number;
  /** 其中已有译文的页数 = 会被覆盖的页数（不可逆，UI 必须提示） */
  overwriteCount: number;
  candidates: { seq: number; ext: string; byteSize: number; originalFile: string; hadTranslation: boolean }[];
  /**
   * 前端补的字段（非服务端返回）：该漫画是否已有任务在队列中。
   *
   * 为什么放在计划对象上而不是单独一个 state：计划与"能不能点"是**同一个判断的两面**，
   * 拆成两个 state 就会出现"菜单按计划说能点、按钮按队列说在跑"的矛盾帧。
   */
  reworking?: boolean;
}

/** `POST /library/{comicName}/retranslate` 的响应（建单视图 + 覆盖信息） */
export interface RetranslateResponse extends CreateTaskResponse {
  overwriteCount: number;
  retranslateCount: number;
}

// ------------------------------------------------------------------ 健康

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'starting';
  service: string;
  version: string;
  apiVersion: string;
  sidecar: { state: string; port: number | null; engine: string | null };
  rootDir: string;
  startedAt: string;
}

// ------------------------------------------------------------------ 展示映射

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '等待中',
  running: '进行中',
  done: '已完成',
  partial_failed: '部分失败',
  failed: '全部失败',
  canceled: '已取消',
};

/** 状态色令牌名（《02》§5.2 ver1.0 修正表：色相一律由状态点承载，文字保持 ink） */
export const STATUS_DOT_VAR: Record<TaskStatus, string> = {
  running: '--md-blue',
  queued: '--md-muted',
  done: '--md-success',
  partial_failed: '--md-warning',
  failed: '--md-error',
  canceled: '--md-muted',
};

/** 来源列文案（《02》§5.2 行内容示例：「来自浏览器插件」） */
export const SOURCE_LABEL: Record<TaskSource, string> = {
  extension: '来自浏览器插件',
  desktop: '本机投放',
  unknown: '—',
};

export const TERMINAL_STATUSES: TaskStatus[] = ['done', 'partial_failed', 'failed', 'canceled'];

export function isTerminal(s: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}
