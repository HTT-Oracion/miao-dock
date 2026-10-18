import type { ReactNode } from 'react';
import { Check } from 'lucide-react';

/**
 * 勾选项 —— 整行可点的一枚复选框（标题 + 一行说明）。
 *
 * 用 `<button role="checkbox">` 而不是 `<input>`：输入框的圆角与描边要跟到行内的大盒子
 * 形态上，纯 CSS 改不了原生的那个方块；换成自己画的小盒子后，键盘可达性由 button 免费带来。
 */
export function CheckRow({
  checked,
  title,
  desc,
  onToggle,
}: {
  checked: boolean;
  title: ReactNode;
  desc: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={checked ? 'isr-chk is-on' : 'isr-chk'}
      onClick={onToggle}
    >
      <span className="isr-chk-box">{checked ? <Check size={12} strokeWidth={3.2} /> : null}</span>
      <span className="isr-chk-tx">
        <b>{title}</b>
        <span>{desc}</span>
      </span>
    </button>
  );
}
