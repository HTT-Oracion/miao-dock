import { ChevronDown, Pause, Play, RefreshCw, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { errorText, serviceRestart, serviceStart, serviceStop, type ServiceState } from '@/ipc';
import { toastBus } from '@/stores/toastBus';
import { stateView } from '@/stores/nav';
import { Btn, Dot, MenuButton, MenuItem } from '@components/units';

/**
 * 服务状态胶囊（设计稿 `.service-pill` + `js/shell.js:367-380` 的 `serviceMenu`）。
 *
 * ## 为什么是应用级组件
 *
 * 它出现在**每个屏的工具条**上（投放 / 队列 / 漫画库 / 未就绪），
 * 且菜单里的动作（启动 / 停止 / 重启 / 跳设置）都是**服务级**的，不属于任何一屏。
 * 与 `Sidebar` / `Toolbar` / `QuitConfirm` 同级，理应住 `components/`。
 *
 * ## 实现：复用 `MenuButton` 的自定义触发器
 *
 * 浮层、Portal 定位、点外部 / Esc / 滚动 / 缩放收起 —— 这些 `MenuButton` 全都做过了。
 * 这里只用它的 `trigger` 槽渲染胶囊外观（圆点 + 状态 + 端口号 + 箭头），
 * 菜单项用 `MenuItem`。**不自己写 `<button>`，也不自己写收起逻辑**
 * （手写一份的代价是两套收起逻辑迟早不一致：`MenuButton` 连 `scroll`/`resize` 都收，
 * 手写很容易漏掉）。
 *
 * ## 菜单项
 *
 * 设计稿有 6 项（标题 + 启动 / 停止 / 重启 + 分隔 + 设置 + 查看引擎下载）；
 * 按用户要求**去掉「查看引擎下载」** ⇒ 5 项 —— 引擎下载有自己的入口（侧栏 + 未就绪屏），
 * 胶囊菜单里再放一条是重复入口。
 *
 * 三个动作的禁用条件照设计稿 `shell.js:372-374`：
 * · 启动：已在 running / starting / stopping 时禁用；
 * · 停止：只有 running 可点；
 * · 重启：starting / stopping 时禁用。
 */
export function ServicePill({ status }: { status: ServiceState }) {
  const v = stateView(status);
  const navigate = useNavigate();

  const running = status === 'running';
  const starting = status === 'starting';
  const stopping = status === 'stopping';

  return (
    <MenuButton
      menuClass="svc-menu"
      title={`服务状态：${v.text} · 点按查看操作`}
      trigger={({ open, toggle }) => (
        <Btn
          kind="bare"
          className="svc-pill"
          ariaHasPopup="menu"
          ariaExpanded={open}
          title={`服务状态：${v.text} · 点按查看操作`}
          onClick={toggle}
        >
          <Dot colorVar={v.colorVar} pulse={running} />
          <span className="svc-text">{v.text}</span>
          <span className="svc-port">:5180</span>
          <ChevronDown size={12} className="svc-chev" />
        </Btn>
      )}
    >
      {(close) => (
        <>
          <div className="svc-menu-head" role="presentation">
            本地翻译服务
          </div>
          <MenuItem
            icon={<Play size={13} />}
            label="启动服务"
            sub="拉起本地翻译服务"
            disabled={running || starting || stopping}
            onClick={() => {
              close();
              void serviceStart().catch((e: unknown) => toastBus.push(errorText(e), 'bad'));
            }}
          />
          <MenuItem
            icon={<Pause size={13} />}
            label="停止服务"
            sub="队列中的任务会被保留"
            disabled={!running}
            onClick={() => {
              close();
              void serviceStop().catch(() => undefined);
            }}
          />
          <MenuItem
            icon={<RefreshCw size={13} />}
            label="重启本地服务"
            sub="先停后起，正在跑的任务会中断"
            disabled={starting || stopping}
            onClick={() => {
              close();
              void serviceRestart().catch((e: unknown) => toastBus.push(errorText(e), 'bad'));
            }}
          />
          <div className="ui-menu-sep" role="separator" />
          <MenuItem
            icon={<Settings size={13} />}
            label="打开翻译服务设置"
            sub="端口 / 令牌 / 引擎与模型"
            onClick={() => {
              close();
              navigate('/settings?section=translate');
            }}
          />
        </>
      )}
    </MenuButton>
  );
}
