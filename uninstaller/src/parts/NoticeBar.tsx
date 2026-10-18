import type { ReactNode } from 'react';
import { Heart, TriangleAlert } from 'lucide-react';

/** 两态：默认（说明性）/ warn（失败告警）。图标按语义各一枚，不共用一个糊弄 */
const ICON_BY_KIND = {
  plain: <Heart size={15} />,
  warn: <TriangleAlert size={15} />,
} as const;

export type NoticeKind = keyof typeof ICON_BY_KIND;

/**
 * 盒式提示条 —— 卸载页三处用它：确认前的"接下来会发生什么"、失败告警、
 * 完成后的"保留 / 删除汇总"。
 */
export function NoticeBar({ kind = 'plain', children }: { kind?: NoticeKind; children: ReactNode }) {
  return (
    <div className={`uns-note is-${kind}`}>
      {ICON_BY_KIND[kind]}
      <div className="uns-note-tx">{children}</div>
    </div>
  );
}
