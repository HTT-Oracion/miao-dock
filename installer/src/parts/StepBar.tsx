import { Fragment } from 'react';
import { Check } from 'lucide-react';
import { STEP_ORDER, stepIndex, stepMeta, type StepKey } from '../data';

/**
 * 三步指示器 —— 已在后面的步骤显示序号，(0 起) 之前的步骤画 ✓。
 *
 * 形态判断收进 `stateOf()`：序号只在这里算一处，渲染处不再出现比较运算，
 * 免得"到底谁是当前步"在不同分支里被判两遍。
 */
export function StepBar({ current }: { current: StepKey }) {
  const active = stepIndex(current);

  return (
    <div className="isr-steps">
      {STEP_ORDER.map((key, i) => (
        <Fragment key={key}>
          {i === 0 ? null : <span className="isr-step-line" />}
          <span className={['isr-step', stateOf(i, active)].filter(Boolean).join(' ')}>
            <span className="isr-step-no">{i < active ? <Check size={12} strokeWidth={3} /> : i + 1}</span>
            {stepMeta(key).name}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/** 某一步的形态类名：已完成 / 当前 / 未到（未到不需要额外类名，走默认灰） */
function stateOf(i: number, active: number): string {
  if (i < active) return 'is-done';
  if (i === active) return 'is-on';
  return '';
}
