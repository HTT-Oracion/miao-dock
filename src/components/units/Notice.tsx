import type { ReactNode } from 'react';

/**
 * 盒式提示条（通用单元）：带边框与底色的整条提示。
 *
 * `bad` = 错误 / 失败；`ok` = 成功落地；`info` = 中性说明。
 * 三档全部走 ver3 的语义色（danger / success / primary），不允许出现"只有一句灰字"的提示。
 */
export function Notice({
  kind,
  className,
  children,
}: {
  kind?: 'bad' | 'ok' | 'info';
  className?: string;
  children: ReactNode;
}) {
  const cls = ['notice', kind ? `is-${kind}` : '', className ?? ''].filter(Boolean).join(' ');
  return <div className={cls}>{children}</div>;
}
