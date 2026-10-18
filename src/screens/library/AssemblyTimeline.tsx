import type { ReactNode } from 'react';
import { ASSEMBLY_PHASES, type PhaseId, type StageNote } from '@screens/library/assembly';

/**
 * 装配五段时间线 —— 引导页与「已装配但服务没起来」两处**共用**同一个组件。
 *
 * ## 为什么是"每段一个形态"而不是"已完成段数"
 * 五段里 visual / llm 是两条独立资产链；只给一个数字时，"视觉好了、LLM 没好"
 * 与"视觉没好、LLM 好了"会画成同一张图。四态（done/active/failed/waiting）
 * 才能逐段说清。
 *
 * ## 为什么有 `extra`
 * 第一个未完成的模型段下方要挂「下载本地引擎 / 使用在线翻译」的决策区，
 * 它属于**那一段**的内容，而不是页面末尾一块无关的提示。
 *
 * 样式全部沿用 `.tl-*`（`src/styles/manga.scss` X-C3 段），不新增视觉体系。
 */
const NOTE_TEXT: Record<StageNote, string> = {
  done: '已完成',
  active: '进行中',
  failed: '失败',
  waiting: '待开始',
};

/** 节点形态与段形态收在同一处：状态词 → 类名，避免"写着进行中、圈却不转"。 */
const NODE_KIND: Record<StageNote, string> = {
  done: 'is-done',
  active: 'is-loading',
  failed: 'is-failed',
  waiting: '',
};
const STEP_KIND: Record<StageNote, string> = {
  done: ' is-done-step',
  active: ' is-current',
  failed: ' is-failed',
  waiting: '',
};

export function AssemblyTimeline({
  notes,
  detail,
  extra,
}: {
  /** 五段形态（`assemblyNotes()` 的返回值） */
  notes: StageNote[];
  /** 真实日志末行；只在当前进行中/失败的那一段显示 */
  detail: string | null;
  /** 段内插槽：键是段 id，值渲染在该段标题下方 */
  extra?: Partial<Record<PhaseId, ReactNode>>;
}) {
  return (
    <>
      {ASSEMBLY_PHASES.map((s, i) => {
        const note = notes[i] ?? 'waiting';
        const kind = NODE_KIND[note];
        const nodeClass = `tl-node num${kind ? ` ${kind}` : ''}`;
        const stepClass = `tl-step${STEP_KIND[note]}`;
        const mark = note === 'done' ? '✓' : note === 'failed' ? '✕' : String(i + 1);
        const showDetail = !!detail && (note === 'active' || note === 'failed');
        return (
          <div key={s.id} className={stepClass}>
            <div className="tl-rail">
              <span className={nodeClass}>{mark}</span>
              <span className="tl-line" />
            </div>
            <div className="tl-body">
              <div className="tl-head">
                <span className="tl-title">{s.text}</span>
                <span className="tl-state">{NOTE_TEXT[note]}</span>
              </div>
              {showDetail ? <div className="tl-detail">{detail}</div> : null}
              {extra?.[s.id]}
            </div>
          </div>
        );
      })}
    </>
  );
}
