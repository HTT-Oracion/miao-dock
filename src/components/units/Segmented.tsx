import type { ReactNode } from 'react';
import { Btn } from '@components/units/atoms';

/** 一个分段选项：`value` 是写回 store 的值，`label` 是按钮上显示的字。 */
export type SegOption<T extends string | number> = { value: T; label: ReactNode };

/**
 * 分段选择（设计稿 `.seg`）：两到五个**互斥**选项，选中项浮起来。
 *
 * 用在"选项少、要一眼看全、点一下就换"的场合（歌词高亮方式、彩胶配色、桌面歌词行数…）。
 * 选项多、或者要看完整清单时才用 `Select` —— 两者不是同一个控件，别互相顶替：
 * 把设计稿的分段控件做成下拉，等于把"当前选了哪个"藏进要点开才看得见的一层里。
 *
 * `role="group"` + 每颗 `aria-pressed` 是设计稿那套 `.seg` 的可及性等价物：
 * 读屏念得出"这一组里当前按下的是哪一颗"，而不是一串同名按钮。
 */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  /** 当前值 */
  value: T;
  /** 选项列表（按显示顺序） */
  options: readonly SegOption<T>[];
  /** 点某一项时写回 */
  onChange: (v: T) => void;
  /** 这一组的可及性名字（`role="group"` 的 label） */
  label: string;
}) {
  return (
    <div className="ui-seg" role="group" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Btn
            key={String(o.value)}
            kind="bare"
            className={on ? 'ui-seg-btn is-on' : 'ui-seg-btn'}
            ariaPressed={on}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </Btn>
        );
      })}
    </div>
  );
}
