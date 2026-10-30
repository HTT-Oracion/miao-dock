import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

/**
 * 预检的一格（设计稿 `.ed-check`）：标签 → 主值 → 副行（图标 + 一句话）。
 *
 * `is-ok` / `is-bad` 只换图标与副行文字色，**底色不动** —— 四格并排时
 * 四块不同底色会读成四张独立的卡，而不是一条检查行。
 */
export function CheckCell({
  label,
  value,
  hint,
  ok,
  children,
}: {
  label: string;
  value: string;
  hint: string;
  ok: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={ok ? 'ed-check is-ok' : 'ed-check is-bad'}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>
        {ok ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
        {hint}
      </small>
      {children}
    </div>
  );
}
