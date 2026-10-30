import type { MouseEvent, ReactNode } from 'react';
import { Btn } from '@components/units/Btn';

/**
 * 圆形图标按钮（通用单元）—— 播放条、展开播放器、列表行内操作共用一套热区。
 *
 * `onClick` 收事件对象：行内的操作按钮需要 `stopPropagation`，避免顺带触发整行点击
 * —— 由调用方决定哪些点击要冒泡，本组件不替它假设。
 * `primary` 给"播放/暂停"这类实心主按钮，`active` 给"已选中/已激活"态。
 */
export function IconButton({
  title,
  onClick,
  disabled,
  active,
  primary,
  children,
}: {
  title: string;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
  primary?: boolean;
  children: ReactNode;
}) {
  const cls = ['ui-cbtn', primary ? 'main' : '', active ? 'is-on' : ''].filter(Boolean).join(' ');
  return (
    <Btn
      kind="bare"
      type="button"
      className={cls}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Btn>
  );
}
