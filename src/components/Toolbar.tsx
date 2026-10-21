import type { ReactNode } from 'react';
import { SHELL } from '@/themes/tokens';

/**
 * 工具条：高 62（《02》§5.1）—— 标题组（标题 + 副标题）+ 弹性占位 + 右侧操作组。
 *
 * 页头标题/副标题属于工具条而非内容区，这一点很关键：它让四个画面共享同一条
 * 「我在哪儿 + 我会发生什么」的信息带，切屏时不会跳动。
 *
 * ver3.0 起标题使用 display 字体并放大一档，工具条本身改为透明——
 * 视觉重量交给内容卡，顶部只保留一条安静的导航带。
 */
export function Toolbar({
  title,
  subtitle,
  actions,
  badge,
}: {
  title: string;
  subtitle: ReactNode;
  actions?: ReactNode;
  /** 标题旁的轻量徽标（例如「独立服务」），不传则不占位 */
  badge?: ReactNode;
}) {
  return (
    <header className="toolbar" style={{ height: SHELL.toolbarHeight, flexBasis: SHELL.toolbarHeight }}>
      <div className="toolbar-titles">
        <div className="toolbar-title-row">
          <h1 className="toolbar-title">{title}</h1>
          {badge ? <span className="toolbar-badge">{badge}</span> : null}
        </div>
        <p className="toolbar-sub">{subtitle}</p>
      </div>
      <div className="toolbar-spacer" />
      {actions ? <div className="toolbar-actions">{actions}</div> : null}
    </header>
  );
}
