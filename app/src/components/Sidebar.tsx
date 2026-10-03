import type { ReactElement } from 'react';
import type { ServiceState } from '../ipc';
import { SHELL } from '../theme/tokens';
import { Dot, IconDrop, IconLibrary, IconQueue, IconSettings } from './atoms';
import logo from '../assets/brand/miao-logo.svg';

export type Screen = 'queue' | 'library' | 'drop' | 'settings';

const NAV: { id: Screen; label: string; icon: () => ReactElement }[] = [
  { id: 'queue', label: '队列', icon: IconQueue },
  { id: 'library', label: '漫画库', icon: IconLibrary },
  { id: 'drop', label: '投放', icon: IconDrop },
];

/** 服务四态 → 文字 + 色相令牌（《02》§2.1 的四态机；颜色只由点承载，文字同步给出） */
const STATE_VIEW: Record<ServiceState, { text: string; colorVar: string }> = {
  stopped: { text: '服务未启动', colorVar: '--md-muted' },
  starting: { text: '启动中', colorVar: '--md-blue' },
  running: { text: '服务运行中', colorVar: '--md-success' },
  error: { text: '服务异常', colorVar: '--md-error' },
};

export function stateView(s: ServiceState) {
  return STATE_VIEW[s];
}

/** 侧边导航：宽 78（《02》§5.1）—— 徽标 40 + 应用入口 + 服务状态点 + 设置 */
export function Sidebar({
  screen,
  onScreen,
  state,
}: {
  screen: Screen;
  onScreen: (s: Screen) => void;
  state: ServiceState;
}) {
  const v = stateView(state);
  return (
    <nav className="sidebar" style={{ width: SHELL.sidebarWidth, flexBasis: SHELL.sidebarWidth }}>
      <div className="sidebar-logo" style={{ width: SHELL.logoSize, height: SHELL.logoSize }}>
        <img src={logo} alt="喵坞" width={30} height={30} />
      </div>

      {NAV.map((n) => (
        <button
          key={n.id}
          type="button"
          className={screen === n.id ? 'nav-item is-active' : 'nav-item'}
          onClick={() => onScreen(n.id)}
        >
          <n.icon />
          <span>{n.label}</span>
        </button>
      ))}

      <div className="sidebar-spacer" />

      <div className="sidebar-status" title={v.text}>
        <Dot colorVar={v.colorVar} pulse={state === 'starting'} />
        <span>{v.text}</span>
      </div>

      <button
        type="button"
        className={screen === 'settings' ? 'nav-item is-active' : 'nav-item'}
        onClick={() => onScreen('settings')}
      >
        <IconSettings />
        <span>设置</span>
      </button>
    </nav>
  );
}
