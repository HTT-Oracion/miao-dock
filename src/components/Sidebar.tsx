import type { ReactElement } from 'react';
import { SHELL, SIDEBAR } from '@/themes/tokens';
// 公共资源：不经构建、原样复制到 dist/assets/icons/，故用**绝对 URL** 而不是 import
// （import 会让 Vite 多产一份带指纹的副本，而这里要的就是"路径可预测"）。
const LOGO_SRC = '/assets/icons/miao-logo.png';
import { APP_LABEL, type AppId, type Screen } from '@/stores/nav';
import { Btn } from '@components/units';
import type { AnimeView } from '@anime/types';
import type { DownloadEntryState } from '@/ipc/engine-download';
import {
  CircleCheck,
  CirclePause,
  Clapperboard,
  Clock,
  Download,
  Languages,
  Loader2,
  Music4,
  Search,
  Settings,
  Sparkles,
  Star,
} from 'lucide-react';

/** 应用层入口（《09》§3.1）—— 三项：翻译 / 音乐 / 番剧（番剧自带 popover）。C8 断言的判据之一。 */
const APPS: { id: AppId; label: string; icon: () => ReactElement }[] = [
  { id: 'translate', label: APP_LABEL.translate, icon: () => <Languages size={20} /> },
  { id: 'music', label: APP_LABEL.music, icon: () => <Music4 size={20} /> },
];

/**
 * 侧边导航 —— ver2.0 两级结构，ver3.0 换上玻璃底板与弹簧微动效。
 *
 * ```
 * ┌─────────┐
 * │  ◉ 徽标  │ 41×41（点按回漫画翻译）
 * │ 漫画翻译 │ ← 应用层 58×52
 * │  音乐    │
 * │  番剧    │ ← hover 展开模块内子导航
 * │  ────    │ ← 分隔线 34×1
 * │   ⚙      │ ← 全局层 44×44
 * └─────────┘
 * ```
 *
 * 与 ver1.0 的差异只有一处，但它改变的是**分类学**：原来「队列/漫画库/投放」与
 * 「音乐」平级，会读成「音乐是翻译的第四步」。现在应用层只有应用，翻译的三个视图
 * 下沉为 Tab（见 `TRANSLATE_VIEWS`）。
 *
 * ⚠️ 设置在**分隔线以下** —— 这不是装饰，是断言 C8 的判据：
 * 分隔线是「应用 / 全局」的分界，跨层放置会让两级结构失去意义。
 *
 * ## 应用入口的两种形态（台账 D-84，「侧栏图标标签」偏好）
 *
 * `labels` 为真 → 「图标 + 文字」58×52；为假 → 纯图标 44×44。
 * 两套几何都来自 `SIDEBAR`，本组件不出现第二个数字。
 *
 * 🔴 **`aria-label` 是必须的，不是锦上添花**：关掉标签后按钮里就再没有可读文字，
 * 读屏用户只能听到「按钮」；开着标签时它与可见文字同值，也不会读两遍。
 */
/** 下载入口三态 → 图标与无障碍文案。完成态只用图标，不渲染可见文字。 */
const DOWNLOAD_META: Record<Exclude<DownloadEntryState, 'hidden'>, { label: string; icon: () => ReactElement }> = {
  running: {
    label: '引擎下载中',
    icon: () => (
      <span className="nav-dl-badge">
        <Download size={20} />
        <Loader2 size={11} className="nav-dl-spin nav-dl-sub" />
      </span>
    ),
  },
  paused: { label: '下载已中断，点击继续', icon: () => <CirclePause size={20} /> },
  done: { label: '引擎下载完成', icon: () => <CircleCheck size={20} /> },
};

export function Sidebar({
  screen,
  onScreen,
  labels,
  downloadEntry,
  onOpenDownload,
  animeView,
  onAnimeView,
}: {
  screen: Screen;
  onScreen: (s: Screen) => void;
  /** 是否显示应用入口的文字标签（`shell-prefs.ts` 的偏好，设置页①可改） */
  labels: boolean;
  /** 侧栏下载入口形态（`hidden` 时不渲染） */
  downloadEntry: DownloadEntryState;
  onOpenDownload: () => void;
  /** 番剧模块内当前子页（popover 高亮用；真值住在 anime store） */
  animeView: AnimeView;
  /** 点 popover 子项：切到番剧屏并落到对应子页 */
  onAnimeView: (v: AnimeView) => void;
}) {
  // 尺寸与标签同源：一个 `labels` 同时决定"有没有 span"与"用哪套几何"
  const appItem = labels ? SIDEBAR.appItem : SIDEBAR.iconOnlyItem;
  return (
    <nav className="sidebar" style={{ width: SHELL.sidebarWidth, flexBasis: SHELL.sidebarWidth }} aria-label="应用导航">
      <div className="sidebar-brand">
        <Btn
          kind="bare"
          className="brand-btn"
          ariaLabel="喵坞 · 返回漫画翻译"
          title="喵坞"
          onClick={() => onScreen('translate')}
        >
          <img src={LOGO_SRC} alt="喵坞" width={41} height={41} />
          <span className="brand-halo" aria-hidden="true" />
        </Btn>
      </div>

      {/* ── 应用层 ──
          `aria-current="page"` 而非 `aria-selected`：后者属于 tablist/option 语义，
          侧栏是导航（nav landmark）不是选项组。少了它读屏用户无法判断自己在哪一屏，
          而「当前屏」正是两级结构里唯一需要被感知的信息。 */}
      <div className="nav-apps">
        {APPS.map((a) => (
          <Btn
            key={a.id}
            kind="bare"
            className={screen === a.id ? 'nav-item is-app is-active' : 'nav-item is-app'}
            style={{ width: appItem.w, height: appItem.h }}
            ariaCurrent={screen === a.id ? 'page' : undefined}
            ariaLabel={a.label}
            title={a.label}
            onClick={() => onScreen(a.id)}
          >
            <i className="nav-ico">
              <a.icon />
            </i>
            {labels ? <span className="nav-label">{a.label}</span> : null}
          </Btn>
        ))}

        {/*
         * ── 番剧（第三个应用）──
         * 主入口与其它应用同形（图标 + 可选文字），次级导航收进 hover 向右展开的浮层：
         * 模块内十屏是**工作区**，不该长期占用一级侧栏。
         * 浮层用纯 CSS hover（`app.scss` 的 `.nav-wrap:hover .nav-pop`）——不额外持 state，
         * 避免"鼠标移开后浮层还挂着"的第二份真相。
         */}
        <div className="nav-wrap">
          <Btn
            kind="bare"
            type="button"
            className={screen === 'anime' ? 'nav-item is-app is-active' : 'nav-item is-app'}
            style={{ width: appItem.w, height: appItem.h }}
            aria-current={screen === 'anime' ? 'page' : undefined}
            aria-label={APP_LABEL.anime}
            title={APP_LABEL.anime}
            onClick={() => onScreen('anime')}
          >
            <i className="nav-ico">
              <Clapperboard size={20} />
            </i>
            {labels ? <span className="nav-label">{APP_LABEL.anime}</span> : null}
          </Btn>

          <div className="nav-pop" role="menu" aria-label="番剧导航">
            <div className="nav-pop-hd">
              <b>番剧</b>
              <span>工作区</span>
            </div>
            {(
              [
                { view: 'explore', label: '搜索', hint: '探索 · 搜索 · 全网聚合', Icon: Search },
                { view: 'collection', label: '追番', hint: '五状态收藏 · 观看进度', Icon: Star },
                { view: 'cache', label: '缓存', hint: '下载管理 · 边下边播', Icon: Download },
                { view: 'history', label: '播放历史', hint: '续播位置 · 同步状态', Icon: Clock },
              ] as { view: AnimeView; label: string; hint: string; Icon: typeof Search }[]
            ).map(({ view, label, hint, Icon }) => (
              <Btn
                kind="bare"
                key={view}
                type="button"
                role="menuitem"
                className={screen === 'anime' && animeView === view ? 'nav-pop-item is-on' : 'nav-pop-item'}
                onClick={() => onAnimeView(view)}
              >
                <span className="npi-ic">
                  <Icon size={15} />
                </span>
                <span className="npi-tx">
                  <b>{label}</b>
                  <span>{hint}</span>
                </span>
              </Btn>
            ))}
            <div className="nav-pop-sep" />
            <Btn
              kind="bare"
              type="button"
              role="menuitem"
              className={screen === 'anime' && animeView === 'states' ? 'nav-pop-item is-on' : 'nav-pop-item'}
              onClick={() => onAnimeView('states')}
            >
              <span className="npi-ic">
                <Sparkles size={15} />
              </span>
              <span className="npi-tx">
                <b>三态与示例</b>
                <span>骨架 / 空态 / 错误态</span>
              </span>
            </Btn>
          </div>
        </div>
      </div>

      {/* ── 分隔线：应用层与全局层的分界 ──
          纯装饰（aria-hidden）：它不表达任何可操作语义，念出来只会是噪声。 */}
      <div
        className="sidebar-divider"
        style={{ width: SIDEBAR.divider.w, height: SIDEBAR.divider.h }}
        aria-hidden="true"
      />

      {/*
       * ── 全局层（分隔线以下）──
       * 下载入口在设置之上，两者都靠 `.sidebar-global` 的 `margin-top:auto` 贴底；
       * 分隔线仍夹在应用层与全局层之间，C8c 的上下序不变。
       * 下载入口是**纯图标**，故 `aria-label` 给名称、`title` 给悬停提示。
       */}
      <div className="sidebar-global">
        {downloadEntry !== 'hidden' ? (
          <Btn
            kind="bare"
            type="button"
            className="nav-item is-global is-download"
            /*
             * 🔴 `data-state` 是设计稿的状态载体（`setDownloadEntry` 里 `btn.dataset.state = state`）：
             *    旋转小圈与"完成/中断"的着色全由 CSS 按这个属性给，不在 JS 里判。
             *    少了它，三态在侧栏里是同一个灰，用户分不出"在下"与"断了"。
             */
            data-state={downloadEntry}
            style={{ width: SIDEBAR.globalItem.w, height: SIDEBAR.globalItem.h }}
            aria-label={DOWNLOAD_META[downloadEntry].label}
            title={DOWNLOAD_META[downloadEntry].label}
            onClick={onOpenDownload}
          >
            <i className="nav-ico">{DOWNLOAD_META[downloadEntry].icon()}</i>
          </Btn>
        ) : null}

        {/*
         * 全局层设置：纯图标，所以 `title` 不是锦上添花而是唯一的可发现性线索；
         * 但 `title` 单独兜不住无障碍，故 `aria-label` 给名称、`title` 给悬停提示。
         */}
        <Btn
          kind="bare"
          type="button"
          className={screen === 'settings' ? 'nav-item is-global is-active' : 'nav-item is-global'}
          style={{ width: SIDEBAR.globalItem.w, height: SIDEBAR.globalItem.h }}
          aria-current={screen === 'settings' ? 'page' : undefined}
          aria-label="设置"
          title="设置"
          onClick={() => onScreen('settings')}
        >
          <i className="nav-ico">
            <Settings size={20} />
          </i>
        </Btn>
      </div>
    </nav>
  );
}
