/**
 * 设置屏的屏装配件（B1 改造的产物）。
 *
 * 设置屏是**全局层**（侧栏分隔线以下、纯图标入口），服务未就绪也不让位 —— 它承载的正是
 * "看状态 / 重启服务 / 跑规格自检"这些服务出问题时最需要的东西。故这里**不套**让位守卫。
 */
import { useOutletContext } from 'react-router-dom';
import type { ShellCtx } from '@/router/panes/shell-context';
import { SettingsScreen } from '@screens/SettingsScreen';

export function SettingsPane() {
  const { status, mode, setTheme, sidebarLabels, setLabels, autoStart, setServiceAutoStart, lib } =
    useOutletContext<ShellCtx>();

  return (
    <SettingsScreen
      status={status}
      mode={mode}
      onMode={setTheme}
      sidebarLabels={sidebarLabels}
      onSidebarLabels={setLabels}
      serviceAutoStart={autoStart}
      onServiceAutoStart={setServiceAutoStart}
      lib={lib}
    />
  );
}
