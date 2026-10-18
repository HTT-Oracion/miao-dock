import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { BadgeKind } from '../data';

/**
 * 勾选项 —— 整行可点的一枚复选框：左侧小盒子，中间标题（可挂徽章）+ 说明，
 * 右侧是行尾信息（数据项那里是体积与路径，主开关那里没有）。
 *
 * `variant="master"` 表示它是控制其余几行的**总开关**，视觉上用粉描边区分；
 * `locked` 表示这一行当前不可选（主开关没打开时的三个数据项），除了置灰还会
 * 真的禁用 —— 光靠颜色的话键盘照样能把它们勾上。
 */
export function CheckRow({
  checked,
  variant = 'plain',
  locked = false,
  title,
  badge,
  badgeKind = 'keep',
  desc,
  side,
  onToggle,
}: {
  checked: boolean;
  variant?: 'plain' | 'master';
  locked?: boolean;
  title: string;
  /** 行内徽章（删除风险提示）；不传则不渲染 */
  badge?: string;
  badgeKind?: BadgeKind;
  desc: string;
  /** 行尾信息 */
  side?: ReactNode;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={locked}
      className={rowClass(checked, variant, locked)}
      onClick={onToggle}
    >
      <span className="uns-chk-box">{checked ? <Check size={12} strokeWidth={3.2} /> : null}</span>
      <span className="uns-chk-tx">
        <b>
          {title}
          {badge === undefined ? null : <span className={`uns-badge is-${badgeKind}`}>{badge}</span>}
        </b>
        <span>{desc}</span>
      </span>
      {side === undefined ? null : <span className="uns-chk-side">{side}</span>}
    </button>
  );
}

/** 行的类名：三种状态各自独立取布尔，避免"主开关 + 已勾选 + 锁定"叠出一条长三元 */
function rowClass(checked: boolean, variant: 'plain' | 'master', locked: boolean): string {
  const names = ['uns-chk'];
  if (variant === 'master') names.push('is-master');
  if (checked) names.push('is-on');
  if (locked) names.push('is-locked');
  return names.join(' ');
}
