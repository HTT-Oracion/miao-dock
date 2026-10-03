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
  /** 1..seqMax 内**没有原图**的页码（正常为空数组）—— 任务中途被取消会留下这种洞 */
  missingSeqs: number[];
  modifiedAt: string | null;
}

export interface LibraryResponse {
  root: string;
  count: number;
  totalImages: number;
  totalBytes: number;
  comics: ComicEntry[];
  updatedAt: string;
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
