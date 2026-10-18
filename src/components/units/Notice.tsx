import type { ReactNode } from 'react';

/** 盒式提示条（通用单元）：带边框与底色的整条提示；`bad` 走错误配色。 */
export function Notice({ kind, className, children }: { kind?: 'bad'; className?: string; children: ReactNode }) {
  const cls = ['notice', kind === 'bad' ? 'is-bad' : '', className ?? ''].filter(Boolean).join(' ');
  return <div className={cls}>{children}</div>;
}
