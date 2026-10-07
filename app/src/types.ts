/**
 * 契约数据模型的前端视图（《03》§3、§5）。
 *
 * 只声明**前端真正读到的字段**——不把契约里没用的字段抄进来，
 * 免得后续契约变更时误以为前端依赖了它。
 */

// ------------------------------------------------------------------ 任务 / 队列

export type TaskStatus = 'queued' | 'running' | 'done' | 'partial_failed' | 'failed' | 'canceled';

/** 来源归因（服务端按 `X-Box-Client` 判定，见 docs/spec-notes.md G-04） */
export type TaskSource = 'extension' | 'desktop' | 'unknown';

export interface TaskProgress {
  total: number;
  done: number;
  failed: number;
  /** 当前正在翻译的序号；0 = 无 */
  current: number;
}

/** `GET /tasks` 的一行（契约外增量端点，spec-notes.md G-04） */
export interface TaskRow {
  taskId: string;
  comicName: string;
  source: TaskSource;
  status: TaskStatus;
  queuePosition: number;
  progress: TaskProgress;
  outputDir: string;
  createdAt: string;
  finishedAt: string | null;
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

export interface LibraryResponse {
  root: string;
  count: number;
  totalImages: number;
  totalBytes: number;
  comics: ComicEntry[];
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
  queued: '排队中',
  running: '翻译中',
  done: '已完成',
  partial_failed: '部分失败',
  failed: '失败',
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
