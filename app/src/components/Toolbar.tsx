import type { ReactNode } from 'react';
import { SHELL } from '@/theme/tokens';

/**
 * 工具条：高 62（《02》§5.1）—— 标题组（标题 + 副标题）+ 弹性占位 + 右侧操作组。
 *
 * 页头标题/副标题属于工具条而非内容区，这一点很关键：它让四个画面共享同一条
 * 「我在哪儿 + 我会发生什么」的信息带，切屏时不会跳动。
 */
export function Toolbar({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="toolbar" style={{ height: SHELL.toolbarHeight, flexBasis: SHELL.toolbarHeight }}>
      <div className="toolbar-titles">
        <div className="toolbar-title">{title}</div>
        <div className="toolbar-sub">{subtitle}</div>
      </div>
      <div className="toolbar-spacer" />
      {actions ? <div className="toolbar-actions">{actions}</div> : null}
    </header>
  );
}
