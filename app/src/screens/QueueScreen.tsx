import { QUEUE_TABLE } from '../theme/tokens';
import { STATUS_DOT_VAR, STATUS_LABEL, SOURCE_LABEL, type TaskRow, type TaskStatus } from '../types';
import { relativeTime } from '../util';
import { Btn, Dot, MagicCircle } from '../components/atoms';

/** 进度列的中文后缀（《02》§5.2 行内容示例：「12 / 20 · 进行中」） */
function progressLabel(t: TaskRow): string {
  switch (t.status) {
    case 'running':
      return '进行中';
    case 'queued':
      return '等待中';
    case 'done':
      return '已完成';
    case 'partial_failed':
      return `${t.progress.failed} 张失败`;
    case 'failed':
      return '全部失败';
    default:
      return '已取消';
  }
}

function barClass(s: TaskStatus): string {
  if (s === 'done') return 'bar is-done';
  if (s === 'partial_failed' || s === 'failed') return 'bar is-bad';
  return 'bar';
}

/**
 * 进度单元格。
 *
 * 《02》§5.8「中英混排」要求「N / M」型计数**拆两个文本节点**：数字走 Inter Medium、
 * 其余走 Noto Sans SC。所以这里刻意不拼成一整串文字 —— 拼了就没法给数字单独指定字体。
 */
function ProgressCell({ t }: { t: TaskRow }) {
  const { done, total } = t.progress;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="qt-c-progress" style={{ width: QUEUE_TABLE.colProgress }}>
      <span className="num">{done}</span>
      <span> / </span>
      <span className="num">{total}</span>
      <span> · {progressLabel(t)}</span>
      <div className={barClass(t.status)}>
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * 操作列只有一个位置（宽 90，《02》§5.2）。
 *
 * 按状态取**语义最主要的那一个**动作：进行中/排队 → 取消；失败 → 重试；已完成 → 查看。
 * 「打开目录」是同一条信息在漫画库里的另一种视图，故留在 X-D1，不挤占这 90px。
 * 已记入 docs/spec-notes.md G-06。
 */
function ActionButton({
  t,
  onCancel,
  onRetry,
  onOpen,
}: {
  t: TaskRow;
  onCancel: (t: TaskRow) => void;
  onRetry: (t: TaskRow) => void;
  onOpen: (t: TaskRow) => void;
}) {
  if (t.status === 'running' || t.status === 'queued') {
    return (
      <Btn kind="danger" size="sm" onClick={() => onCancel(t)} title="取消该任务；已落盘的张数会保留">
        取消
      </Btn>
    );
  }
  if (t.status === 'failed' || t.status === 'partial_failed') {
    return (
      <Btn kind="primary" size="sm" onClick={() => onRetry(t)} title="用同一漫画名重新提交">
        重试
      </Btn>
    );
  }
  return (
    <Btn kind="ghost" size="sm" onClick={() => onOpen(t)} title={t.outputDir}>
      查看
    </Btn>
  );
}

function Row({
  t,
  onCancel,
  onRetry,
  onOpen,
}: {
  t: TaskRow;
  onCancel: (t: TaskRow) => void;
  onRetry: (t: TaskRow) => void;
  onOpen: (t: TaskRow) => void;
}) {
  const running = t.status === 'running';
  return (
    <div className={running ? 'qt-row is-running' : 'qt-row'} style={{ height: QUEUE_TABLE.rowHeight }}>
      <div className="qt-name">
        <div className="qt-name-main" title={t.comicName}>
          {t.comicName}
        </div>
        <div className="qt-name-sub">
          {t.status === 'queued'
            ? `队内第 ${t.queuePosition} 位`
            : t.finishedAt
              ? `完成于 ${relativeTime(t.finishedAt)}`
              : `提交于 ${relativeTime(t.createdAt)}`}
        </div>
      </div>

      <div className="qt-c-source" style={{ width: QUEUE_TABLE.colSource }}>
        {SOURCE_LABEL[t.source]}
      </div>

      <ProgressCell t={t} />

      <div className="qt-c-status" style={{ width: QUEUE_TABLE.colStatus }}>
        <Dot colorVar={STATUS_DOT_VAR[t.status]} pulse={running} />
        <span>{STATUS_LABEL[t.status]}</span>
      </div>

      <div className="qt-c-action" style={{ width: QUEUE_TABLE.colAction }}>
        <ActionButton t={t} onCancel={onCancel} onRetry={onRetry} onOpen={onOpen} />
      </div>
    </div>
  );
}

/**
 * 画面 X-C1 · 任务队列（《02》§5.2）。
 *
 * 表头列宽 弹性 / 120 / 160 / 150 / 90，行高 58；运行行抬到 surface 底 + line 描边。
 * 数据来自 `GET /tasks`（契约外增量，spec-notes G-04）—— 它同时给出进行中与历史行，
 * 所以任务跑完后这一屏**不会清空**。
 */
export function QueueTable({
  rows,
  onCancel,
  onRetry,
  onOpen,
}: {
  rows: TaskRow[];
  onCancel: (t: TaskRow) => void;
  onRetry: (t: TaskRow) => void;
  onOpen: (t: TaskRow) => void;
}) {
  return (
    <div className="queue">
      <div className="qt-head">
        <div className="qt-name">任务 / 漫画名</div>
        <div className="qt-c-source" style={{ width: QUEUE_TABLE.colSource }}>
          来源
        </div>
        <div className="qt-c-progress" style={{ width: QUEUE_TABLE.colProgress }}>
          进度
        </div>
        <div className="qt-c-status" style={{ width: QUEUE_TABLE.colStatus }}>
          状态
        </div>
        <div className="qt-c-action" style={{ width: QUEUE_TABLE.colAction }}>
          操作
        </div>
      </div>
      <div className="qt-body">
        {rows.map((t) => (
          <Row key={t.taskId} t={t} onCancel={onCancel} onRetry={onRetry} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

/**
 * 画面 X-C2 · 队列空态（《02》§5.3）。
 *
 * **仅队列为空时渲染** —— 有任务时整块隐藏，不与任务列表争夺注意力。
 */
export function QueueEmpty({
  onGoPlugin,
  onGoDrop,
}: {
  onGoPlugin: () => void;
  onGoDrop: () => void;
}) {
  return (
    <div className="empty">
      <MagicCircle />
      <div className="empty-title">还没有翻译任务</div>
      <div className="empty-sub">在漫画页用插件提交，或把图片拖进这个窗口</div>
      <div className="empty-actions">
        <Btn kind="ghost" onClick={onGoPlugin}>
          去插件选图
        </Btn>
        <Btn kind="primary" onClick={onGoDrop}>
          本机投放
        </Btn>
      </div>
    </div>
  );
}
