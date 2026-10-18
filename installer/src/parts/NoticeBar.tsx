import type { ReactNode } from 'react';
import { CheckCircle2, Info, TriangleAlert } from 'lucide-react';

export type NoticeKind = 'info' | 'ok' | 'warn';

/**
 * 各形态的图标。放在模块级而不是渲染里现判 —— 图标与语义的对应只有这一处，
 * 后面加形态不会在 JSX 里长出一条三元链。
 */
const ICON_BY_KIND: Record<NoticeKind, ReactNode> = {
  info: <Info size={14} />,
  ok: <CheckCircle2 size={14} strokeWidth={2.2} />,
  warn: <TriangleAlert size={14} />,
};

/** 盒式提示条：一条带底色的说明（设计稿里 tip / ok / warn 三种形态的同一实现） */
export function NoticeBar({ kind = 'info', children }: { kind?: NoticeKind; children: ReactNode }) {
  return (
    <div className={`isr-note is-${kind}`}>
      {ICON_BY_KIND[kind]}
      <span>{children}</span>
    </div>
  );
}
