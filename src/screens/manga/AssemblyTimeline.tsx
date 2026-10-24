import { ASSEMBLY_PHASES, NOTE_TEXT, type StageNote } from '@screens/manga/assembly';

/**
 * 装配五段时间线 —— 引导页与「已装配但服务没起来」两处**共用**同一个组件。
 *
 * ## 结构照设计稿 `.timeline`
 * `.timeline`（五列等分）→ 每个 `.timeline-step[data-state]`（节点 + 段名 + 状态词）。
 * 连接线由 `.timeline-step::before` 画，首尾两段各收一半 —— 所以它是"一条线串五颗节点"，
 * 而不是五张各自带边的卡。
 *
 * ## 为什么是"每段一个形态"而不是"已完成段数"
 * 五段里 visual / llm 是两条独立资产链；只给一个数字时，"视觉好了、LLM 没好"
 * 与"视觉没做好、LLM 好了"会画成同一张图。四态（done / active / failed / waiting）
 * 才能逐段说清。
 *
 * ## 为什么没有 `extra` 插槽
 * 段内额外内容（下载入口 / 在线翻译提示）在引导页是**页面级**的两处：
 * 时间线上方一行现状、时间线下方一排动作。挂进某一段会让时间线高度随状态跳动，
 * 五颗节点也就对不齐了。
 */
export function AssemblyTimeline({ notes, detail }: { notes: StageNote[]; detail?: string | null }) {
  const failed = notes.some((n) => n === 'failed');
  return (
    <>
      <div className="timeline">
        {ASSEMBLY_PHASES.map((s, i) => {
          const note = notes[i] ?? 'waiting';
          // 段号由下标派生（不写死 1..5）：新增/删段时序号自动跟着走
          const step = i + 1;
          return (
            <div
              key={s.id}
              className="timeline-step"
              data-state={note}
              data-step={step}
              aria-label={`第 ${step} 段：${s.text}（${NOTE_TEXT[note]}）`}
            >
              <span className="timeline-node" aria-hidden="true" />
              <strong>{s.text}</strong>
              <small>{NOTE_TEXT[note]}</small>
            </div>
          );
        })}
      </div>
      {detail && failed ? <div className="timeline-detail">{detail}</div> : null}
    </>
  );
}
