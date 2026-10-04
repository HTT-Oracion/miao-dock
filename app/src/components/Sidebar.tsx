import type { ReactElement } from 'react';
import type { ServiceState } from '../ipc';
import { SHELL, SIDEBAR } from '../theme/tokens';
import { Dot } from './units';
import logo from '../assets/brand/miao-logo.svg';
import { APP_LABEL, stateView, type AppId, type Screen } from '../nav';
import { Languages, Music4, Settings } from 'lucide-react';

/** 应用层入口（《09》§3.1）—— 恒为 2 项。C8 断言的判据之一，故不在别处重复定义。 */
const APPS: { id: AppId; label: string; icon: () => ReactElement }[] = [
  { id: 'translate', label: APP_LABEL.translate, icon: () => <Languages size={20} /> },
  { id: 'music', label: APP_LABEL.music, icon: () => <Music4 size={20} /> },
];

/**
 * 侧边导航 —— ver2.0 改为**两级结构**（《09》§3.1）。
 *
 * ```
 * ┌─────────┐
 * │  ◉ 徽标  │ 40×40
 * │ 漫画翻译 │ ← 应用层 58×52（active = pink-soft）
 * │  音乐    │ ← 应用层 58×52
 * │  ────    │ ← 分隔线 34×1（居中短横线，非通栏）
 * │  ◍ 状态点 │ ← 全局层
 * │   ⚙      │ ← 全局层（纯图标 44×44，去文字）
 * └─────────┘
 * ```
 *
 * 与 ver1.0 的差异只有一处，但它改变的是**分类学**：原来「队列/漫画库/投放」与
 * 「音乐」平级，会读成「音乐是翻译的第四步」。现在应用层只有两项，
 * 翻译的三个视图下沉为 Tab（见 `TRANSLATE_VIEWS`）。
 *
 * ⚠️ 状态点与设置都在**分隔线以下** —— 这不是装饰，是断言 C8 的判据：
 * 分隔线是「应用 / 全局」的分界，跨层放置会让两级结构失去意义。
 * 全局层通过 `.sidebar-status` 的 `margin-top: auto` 贴到侧栏底部 —— 这只是
 * 撑开分隔线以下的空隙，分隔线仍在应用层之下、全局层之上，C8c 不受影响。
 */
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

      {/* ── 应用层 ──
          `aria-current="page"` 而非 `aria-selected`：后者属于 tablist/option 语义，
          侧栏是导航（nav landmark）不是选项组。少了它读屏用户无法判断自己在哪一屏，
          而「当前屏」正是两级结构里唯一需要被感知的信息。 */}
      {APPS.map((a) => (
        <button
          key={a.id}
          type="button"
          className={screen === a.id ? 'nav-item is-app is-active' : 'nav-item is-app'}
          style={{ width: SIDEBAR.appItem.w, height: SIDEBAR.appItem.h }}
          aria-current={screen === a.id ? 'page' : undefined}
          title={a.label}
          onClick={() => onScreen(a.id)}
        >
          <a.icon />
          <span>{a.label}</span>
        </button>
      ))}

      {/* ── 分隔线：应用层与全局层的分界 ──
          纯装饰（aria-hidden）：它不表达任何可操作语义，念出来只会是噪声。 */}
      <div
        className="sidebar-divider"
        style={{ width: SIDEBAR.divider.w, height: SIDEBAR.divider.h }}
        aria-hidden="true"
      />

      {/* ── 全局层 ── */}
      <div className="sidebar-status" title={v.text}>
        <Dot colorVar={v.colorVar} pulse={state === 'starting'} />
        <span>{v.text}</span>
      </div>

      {/*
       * 全局层设置：去掉了文字，所以 `title` 不是锦上添花而是唯一的可发现性线索。
       * 但 `title` 单独兜不住无障碍 —— 它不进可访问名称的计算优先级前列，
       * 读屏与键盘焦点都可能读不出「这是什么按钮」。故 `aria-label` 给名称、
       * `title` 给鼠标悬停提示，两者是分工不是重复。
       */}
      <button
        type="button"
        className={screen === 'settings' ? 'nav-item is-global is-active' : 'nav-item is-global'}
        style={{ width: SIDEBAR.globalItem.w, height: SIDEBAR.globalItem.h }}
        aria-current={screen === 'settings' ? 'page' : undefined}
        aria-label="设置"
        title="设置"
        onClick={() => onScreen('settings')}
      >
        <Settings size={20} />
      </button>
    </nav>
  );
}
