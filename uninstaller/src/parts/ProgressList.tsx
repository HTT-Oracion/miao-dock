import type { ReactNode } from 'react';
import { Check, CircleDot, Loader2 } from 'lucide-react';
import type { LineState, ProgressLine } from '../tools/progress';

/** 各行状态的记号 —— 每步做到哪了，除了文字还得有形状可辨（颜色不是唯一信息载体） */
const MARK_BY_STATE: Record<LineState, ReactNode> = {
  done: <Check size={10} strokeWidth={3.2} />,
  now: <Loader2 size={10} />,
  pending: <CircleDot size={10} />,
};

/**
 * 卸载进度：顶部一根按百分比填充的条，下面是每一步当前在做的事。
 *
 * 百分比由调用方算好传进来（`progressPercent`）—— 组件自己再算一遍就会出现
 * "标题栏写 64%、条里画 62%"这种两处口径不一致的形态。
 */
export function ProgressList({ lines, percent }: { lines: ProgressLine[]; percent: number }) {
  return (
    <div className="uns-prog">
      {/* 类名带 `prog`：`.uns-bar` 是窗口标题栏的（同名过一次，把标题压成了 7px 高） */}
      <div className="uns-prog-bar">
        <i style={{ width: `${percent}%` }} />
      </div>
      {lines.map((line) => (
        <div key={line.id} className={`uns-line is-${line.state}`}>
          <span className="uns-line-mark">{MARK_BY_STATE[line.state]}</span>
          {line.text}
        </div>
      ))}
    </div>
  );
}
