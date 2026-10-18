import { createRoot } from 'react-dom/client';
import { applyTokens } from './theme';
import { InstallerApp } from './InstallerApp';
import { resolveHost } from './host';
import { installDesktopGuards } from './tools/guards';
import { bindClose } from './tools/window';
import './styles/index.scss';

applyTokens();

const host = resolveHost();

// 桌面窗口 vs 浏览器预览：CSS 靠这个标记决定"卡面是否就是窗口本身"
// （浏览器里要保持设计稿那种"画布上浮着一张卡"的展示形态）
document.documentElement.dataset.host = '__TAURI_INTERNALS__' in window ? 'tauri' : 'web';
installDesktopGuards();
bindClose(() => {
  void host.close();
});
const mount = document.getElementById('root');
if (!mount) throw new Error('缺少 #root 挂载点');
const root = createRoot(mount);

// 先渲染"探测中"（env 为 null），拿到环境后再渲染一次 —— Wizard 那一刻才挂载，
// useState 的初始值因此拿得到真数据（同一组件续渲染不会重取初值）。
// 探测失败也渲染一屏（停在"探测中"），不白屏：失败原因在宿主那边。
root.render(<InstallerApp host={host} env={null} />);
host.probe().then(
  (env) => root.render(<InstallerApp host={host} env={env} />),
  () => root.render(<InstallerApp host={host} env={null} />),
);
