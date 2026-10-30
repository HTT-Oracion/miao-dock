import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';

/**
 * 错误态（通用单元）。
 *
 * 纪律：说清「哪坏了 + 能干嘛」—— 标题给一句人话，正文给原始原因（可复制），
 * 下方给下一步动作。只写「出错了」等于让用户去猜，而猜错的成本是重装。
 */
export function ErrorState({
  title,
  message,
  actions,
}: {
  title: string;
  /** 原始错误信息（保留原文，别翻译成"网络异常"这种无信息量的话） */
  message?: string;
  /** 下一步动作（重试 / 换源 / 查看日志…） */
  actions?: ReactNode;
}) {
  return (
    <div className="ui-err" role="alert">
      <div className="ui-err-hd">
        <TriangleAlert size={16} />
        <b>{title}</b>
      </div>
      {message ? <div className="ui-err-msg">{message}</div> : null}
      {actions ? <div className="ui-err-acts">{actions}</div> : null}
    </div>
  );
}
