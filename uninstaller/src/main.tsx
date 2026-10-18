import { createRoot } from 'react-dom/client';
import { applyTokens } from './theme';
import { UninstallerApp } from './UninstallerApp';
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
  host.close();
});
const mount = document.getElementById('root');
if (!mount) throw new Error('缺少 #root 挂载点');
const root = createRoot(mount);

// 先渲染"统计中"（probe 为 null），拿到三类数据的实时画像后再渲染一次 ——
// 界面那一刻才挂载，初始勾选等状态因此建立在真数据上（同一组件续渲染不会重取初值）。
// 探测失败也渲染一屏（停在"统计中"），不白屏：失败原因在宿主那边。
root.render(<UninstallerApp host={host} probe={null} />);
host.probe().then(
  (probe) => root.render(<UninstallerApp host={host} probe={probe} />),
  () => root.render(<UninstallerApp host={host} probe={null} />),
);
