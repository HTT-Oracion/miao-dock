import type { CSSProperties } from 'react';

/** 允许在 style 里写自定义属性（`--x`）：`CSSProperties` 只覆盖标准属性 */
type CSSVarStyle = CSSProperties & Record<`--${string}`, string>;

/**
 * 滑杆 + 右侧数值读数（通用单元）。
 *
 * 读数与滑杆同源于 `value`，不可能显示成两个数。
 *
 * ## 已填充比例为什么由组件算
 * 百分比取决于「值落在区间的哪儿」，CSS 算不出来（轨道宽度本身还是弹性的），
 * 只能由持有 `value` 的组件给出 —— 写成 CSS 变量 `--ui-range-fill`，
 * 样式侧只负责照这个比例画两种底色。
 *
 * ## 与播放进度条的关系（刻意不合并）
 * 音乐屏的 `.music-prog-bar`（播放进度）与 `.music-vol`（音量）几何与 `.ui-range` 逐值一致
 * （轨道 5px / 圆角 3 / 11×11 圆拇指），但**没有合并成同一个组件**：
 * 进度条是 `flex:1` 的弹性条、且展开播放器里要按皮肤换轨道色（深色皮肤用半透明白），
 * 而本组件的轨道色固定取 `--md-line`。强行合并会让"设置项滑杆"与"播放进度条"
 * 互相牵制 —— 判据是《09》§2.2 的"**共享样式，不强行共享形状**"。
 */
export function Range({
  min,
  max,
  step,
  value,
  onChange,
  label,
  suffix,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  label: string;
  suffix?: string;
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const fill: CSSVarStyle = { '--ui-range-fill': `${pct}%` };

  return (
    <>
      <input
        type="range"
        className="ui-range"
        style={fill}
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="ui-range-val">
        {value}
        {suffix ?? ''}
      </span>
    </>
  );
}
