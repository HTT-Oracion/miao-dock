import { useEffect, useMemo, useState } from 'react';
import { FolderOpen, Trash2 } from 'lucide-react';
import { QUEUE_TABLE } from '@/themes/tokens';
import { STATUS_DOT_VAR, STATUS_LABEL, SOURCE_LABEL, isTerminal, type TaskRow, type TaskStatus } from '@/types';
import { pageCount, pageSlice, relativeTime } from '@tools';
import { Btn, Dot, MagicCircle, MenuButton, MenuItem } from '@components/units';

/**
 * 队列每页条数。
 *
 * 为什么是 10：行高 58，一屏大约放得下 8~10 行 —— 定成 10 让「一页」与「一屏」大致对齐，
 * 翻页才不会变成"翻了个寂寞"。改这个数只需改这一处（分页器按它算总页数）。
 */
const PAGE_SIZE = 10;

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
 * 行首动作 —— 按状态取**语义最主要的那一个**：进行中/排队 → 取消；失败 → 重试；终态 → 查看。
 *
 * 「查看」跳的是**漫画库**（不是系统文件夹）—— 先判库里有没有这本（没有就提示、不跳），
 * 有则跳过去并定位。「打开目录」是另一件事，收进右侧 [更多]（见 `MenuButton`，spec-notes G-06 更新）。
 */
function PrimaryAction({
  t,
  canceling,
  onCancel,
  onRetry,
  onViewComic,
}: {
  t: TaskRow;
  canceling: boolean;
  onCancel: (t: TaskRow) => void;
  onRetry: (t: TaskRow) => void;
  onViewComic: (t: TaskRow) => void;
}) {
  if (t.status === 'running' || t.status === 'queued') {
    return (
      <Btn
        kind="danger"
        size="sm"
        disabled={canceling}
        onClick={() => onCancel(t)}
        title="取消该任务；已落盘的张数会保留"
      >
        {canceling ? '取消中…' : '取消'}
      </Btn>
    );
  }
  if (t.status === 'failed' || t.status === 'partial_failed') {
    return (
      <Btn kind="primary" size="sm" onClick={() => onRetry(t)} title="重跑这一行里失败的页（仍是同一个任务）">
        重试
      </Btn>
    );
  }
  return (
    <Btn kind="ghost" size="sm" onClick={() => onViewComic(t)} title="去漫画库查看这本漫画">
      查看
    </Btn>
  );
}

function Row({
  t,
  canceling,
  onCancel,
  onRetry,
  onViewComic,
  onOpenDir,
  onDeleteRow,
  pickMode,
  picked,
  onTogglePick,
}: {
  t: TaskRow;
  canceling: boolean;
  onCancel: (t: TaskRow) => void;
  onRetry: (t: TaskRow) => void;
  onViewComic: (t: TaskRow) => void;
  onOpenDir: (t: TaskRow) => void;
  onDeleteRow: (t: TaskRow) => void;
  pickMode: boolean;
  picked: boolean;
  onTogglePick: (id: string) => void;
}) {
  const running = t.status === 'running';
  // 翻译中 / 排队中的任务不可删（契约：删除只删「记录」，跑到一半的记录删了没法自洽）
  const deletable = isTerminal(t.status);
  return (
    <div className={running ? 'qt-row is-running' : 'qt-row'} style={{ height: QUEUE_TABLE.rowHeight }}>
      <div className="qt-name">
        {pickMode ? (
          <input
            type="checkbox"
            className="ck"
            checked={picked}
            disabled={!deletable}
            onChange={() => onTogglePick(t.taskId)}
            title={deletable ? '选中该任务' : `${STATUS_LABEL[t.status]}的任务不能删除`}
            aria-label={`选择 ${t.comicName}`}
          />
        ) : null}
        <div className="qt-name-col">
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
        <PrimaryAction t={t} canceling={canceling} onCancel={onCancel} onRetry={onRetry} onViewComic={onViewComic} />
        <MenuButton label="更多" size="sm">
          {(close) => (
            <>
              <MenuItem
                icon={<FolderOpen size={13} />}
                label="打开目录"
                sub="在文件管理器中定位"
                onClick={() => {
                  close();
                  onOpenDir(t);
                }}
              />
              <MenuItem
                icon={<Trash2 size={13} />}
                label="删除"
                sub="只删记录 · 不动文件"
                danger
                disabled={!deletable}
                title={deletable ? '删除这条任务记录（不动漫画库里的文件）' : `${STATUS_LABEL[t.status]}的任务不能删除`}
                onClick={() => {
                  close();
                  onDeleteRow(t);
                }}
              />
            </>
          )}
        </MenuButton>
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
 *
 * ## 本屏较原型的增量（都在保真度之外，属可用性补充）
 * · **分页**：行数只增不减（历史永久保留），不分页会越拖越长。每页 `PAGE_SIZE` 行。
 * · **多选删除**：删除**只删记录**（`POST /tasks/delete`），不动漫画目录里的任何文件；
 *   翻译中 / 排队中不可选 —— 复选框直接置灰并给出悬停原因，而不是等提交后再报错。
 *   勾选状态**只针对当前页操作**（"全选"= 全选本页），否则跨页的全选/取消很难讲清。
 */
export function QueueTable({
  rows,
  cancelingIds,
  onCancel,
  onRetry,
  onViewComic,
  onOpenDir,
  onDelete,
}: {
  rows: TaskRow[];
  /** 正在取消中的任务 id（乐观标记，用于把行首「取消」置灰为「取消中…」） */
  cancelingIds?: Set<string>;
  onCancel: (t: TaskRow) => void;
  onRetry: (t: TaskRow) => void;
  /** 「查看」= 跳漫画库并定位（存在性判断与跳转都在 App） */
  onViewComic: (t: TaskRow) => void;
  /** 「更多 → 打开目录」= 用系统文件管理器打开该任务的落盘目录 */
  onOpenDir: (t: TaskRow) => void;
  onDelete: (taskIds: string[]) => Promise<boolean>;
}) {
  const [pickMode, setPickMode] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);

  const totalPages = pageCount(rows.length, PAGE_SIZE);
  // 行数变少（删完一批、或别处取消）时把页码夹回合法区间，否则会停在空白页
  useEffect(() => {
    setPage((p) => (p > totalPages ? totalPages : p));
  }, [totalPages]);

  const pageRows = useMemo(() => pageSlice(rows, page, PAGE_SIZE), [rows, page]);

  // 选中项里若有任务已经不在列表（被别处删掉 / 列表刷新掉了），剔除掉 —— 免得删到不存在的 id
  useEffect(() => {
    setPicked((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(rows.map((r) => r.taskId));
      const next = new Set<string>();
      let changed = false;
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [rows]);

  const deletableOnPage = pageRows.filter((r) => isTerminal(r.status));
  const allPickedOnPage = deletableOnPage.length > 0 && deletableOnPage.every((r) => picked.has(r.taskId));

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const togglePage = () =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (allPickedOnPage) for (const r of deletableOnPage) next.delete(r.taskId);
      else for (const r of deletableOnPage) next.add(r.taskId);
      return next;
    });

  const exitPick = () => {
    setPickMode(false);
    setPicked(new Set());
  };

  const doDelete = async () => {
    if (picked.size === 0 || busy) return;
    setBusy(true);
    const ok = await onDelete([...picked]);
    setBusy(false);
    if (ok) exitPick();
  };

  return (
    <div className="queue">
      <div className="queue-bar">
        {pickMode ? (
          <>
            <span className="queue-sel">
              已选 <span className="num">{picked.size}</span> 项
            </span>
            <Btn kind="ghost" size="sm" onClick={togglePage} disabled={deletableOnPage.length === 0}>
              {allPickedOnPage ? '取消本页' : '全选本页'}
            </Btn>
            <Btn kind="danger" size="sm" disabled={picked.size === 0 || busy} onClick={() => void doDelete()}>
              删除选中{picked.size ? `（${picked.size}）` : ''}
            </Btn>
            <Btn kind="ghost" size="sm" onClick={exitPick} disabled={busy}>
              取消多选
            </Btn>
            <span className="queue-hint">删除只清记录，不动漫画库里的文件</span>
          </>
        ) : (
          <>
            <span className="queue-hint">
              共 <span className="num">{rows.length}</span> 条 · 翻译中的任务不能删除
            </span>
            <div style={{ flex: 1 }} />
            <Btn kind="ghost" size="sm" onClick={() => setPickMode(true)} disabled={rows.length === 0}>
              多选
            </Btn>
          </>
        )}
      </div>

      <div className="qt-head">
        <div className="qt-name">
          {pickMode ? (
            <input
              type="checkbox"
              className="ck"
              checked={allPickedOnPage}
              disabled={deletableOnPage.length === 0}
              onChange={togglePage}
              title="全选本页可删除的任务"
              aria-label="全选本页"
            />
          ) : null}
          <div className="qt-name-col">任务 / 漫画名</div>
        </div>
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
        {pageRows.map((t) => (
          <Row
            key={t.taskId}
            t={t}
            canceling={cancelingIds?.has(t.taskId) ?? false}
            onCancel={onCancel}
            onRetry={onRetry}
            onViewComic={onViewComic}
            onOpenDir={onOpenDir}
            onDeleteRow={(row) => void onDelete([row.taskId])}
            pickMode={pickMode}
            picked={picked.has(t.taskId)}
            onTogglePick={togglePick}
          />
        ))}
      </div>

      {totalPages > 1 ? (
        <div className="queue-pager">
          <Btn kind="ghost" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            上一页
          </Btn>
          <span className="muted">
            第 <span className="num">{page}</span> / <span className="num">{totalPages}</span> 页
          </span>
          <Btn kind="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
            下一页
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 画面 X-C2 · 队列空态（《02》§5.3）。
 *
 * **仅队列为空时渲染** —— 有任务时整块隐藏，不与任务列表争夺注意力。
 *
 * ⚠️ 按钮文案必须与动作一致：Box 是桌面端，**打不开浏览器里的插件面板** ——
 * 「去插件选图」这种说法兑现不了。这里给一条真能走通的路：跳到设置页的
 * 「令牌配对」（插件连不上、没配对的用户，要去的就是那里）。
 */
export function QueueEmpty({ onGoSettings, onGoDrop }: { onGoSettings: () => void; onGoDrop: () => void }) {
  return (
    <div className="empty">
      <MagicCircle />
      <div className="empty-title">还没有翻译任务</div>
      <div className="empty-sub">在漫画页用插件提交，或把图片拖进这个窗口</div>
      <div className="empty-actions">
        <Btn kind="ghost" onClick={onGoSettings}>
          去设置里配对插件
        </Btn>
        <Btn kind="primary" onClick={onGoDrop}>
          本机投放
        </Btn>
      </div>
    </div>
  );
}
