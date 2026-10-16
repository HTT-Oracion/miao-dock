import { useEffect, useRef, useState } from 'react';
import type { ServiceStatus } from '@/ipc';
import type { LibraryResponse } from '@/types';
import type { ThemeMode } from '@/themes/tokens';
import { SETTINGS } from '@/themes/tokens';
import { SETTINGS_SECTIONS, parseSection, sectionItemCount } from '@screens/settings/catalog';
import type { SectionId } from '@screens/settings/catalog';
import { SECTION_ICON } from '@screens/settings/icons';
import { emphasis } from '@screens/settings/parts';
import { SpecFixtureHost } from '@screens/settings/SpecCheck';
import {
  AboutSection,
  GeneralSection,
  MediaSection,
  ResourceSection,
  TranslateSection,
} from '@screens/settings/sections';

/**
 * 设置页 —— 两栏壳 + 5 分组 32 项（《09》§4.1 / §4.2）。
 *
 * ## 为什么从「单页平铺」改成两栏
 *
 * ver1.0 把服务状态、令牌、外观、生命周期、规格自检一路铺下来，读起来是"五种互不相干的
 * 提示堆在一页"。32 项若继续平铺会变成两屏半，而且**用户要什么就找什么**这件事
 * 彻底做不到 —— 令牌在第 7 行、模型目录在第 30 行，谁记得住。
 *
 * 两栏 + 单组渲染解决的是这个：一次只展示一组，左栏给出全部 5 个分组的入口与项数。
 * 项数写出来是有意的 —— 用户能立刻看出"音乐那 5 项还没接"，而不是以为设置页就这些。
 *
 * ## 一次只渲染一个分组（不是全部平铺）
 *
 * 这是刻意的，与"左栏导航"是两件不同的事。左栏只负责切换，右栏**只挂载当前组**。
 * 若把 5 组都渲染出来再靠 CSS 隐藏，DOM 里仍有 5 个待接入项的说明文字，
 * 读屏会念出一大段与当前画面无关的内容 —— 视觉上隐藏 ≠ 对辅助技术隐藏。
 */
export function SettingsScreen({
  status,
  mode,
  onMode,
  sidebarLabels,
  onSidebarLabels,
  serviceAutoStart,
  onServiceAutoStart,
  lib,
}: {
  status: ServiceStatus | null;
  mode: ThemeMode;
  onMode: (m: ThemeMode) => void;
  /** 侧栏标签偏好（真值来自 `App` 的 state，这里只透传给①通用组） */
  sidebarLabels: boolean;
  onSidebarLabels: (on: boolean) => void;
  /**
   * 「自动启动翻译服务」偏好（真值同样来自 `App` 的 state）。
   *
   * ⚠️ 刻意**不**在这里自己读 `localStorage`：`App` 的自动启动 effect 读的是它自己那份
   * state，若设置页另读一份，用户拨开关只会改到"设置页以为的值"，而真正决定要不要拉服务的
   * 那个 state 没动 —— 表现就是「关掉了，重启应用还是自动起」。一个偏好一个来源。
   */
  serviceAutoStart: boolean;
  onServiceAutoStart: (on: boolean) => void;
  /**
   * 漫画库盘点（译文库占用）。
   *
   * ⚠️ 它是**详情页已在用**的同一份数据（`App` 的 `useLibrary`），从这里透传给④资源与投放；
   * 刻意不让设置页自己再拉一次 —— 两处各拉一次会出现"详情页说 1.2 GB、设置页说 1.1 GB"，
   * 而两边都没错，只是取数时刻不同。同一份数据只有一个来源。
   */
  lib: LibraryResponse | null;
}) {
  // 深链 `?section=general|translate|media|resource|about`
  //
  // 用 `window.location.search` 而非 react-router：这个页面没有别的路由，
  // 为了一个 query 参数引入路由库不划算（且是新增依赖，本轮禁止）。
  const [section, setSection] = useState<SectionId>(() => parseSection(readSectionParam()));

  /**
   * 离屏样张的 ref 在**壳层**创建并常驻。
   *
   * 刻意不放进①通用组里：那一支切组时会卸载，样张跟着卸载后用户切回来点自检，
   * 量到的全是 0（假失败）。挂载责任归壳，别的组管不着。
   */
  const fixtureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 切换后写回地址栏，让"当前在哪个分组"可被分享/刷新保持。
    // `replaceState` 而非 `pushState`：切分组是"看同一页的不同部分"，
    // 不是"去了一个新地方"，不该在窗口历史里堆 5 条记录让返回键失效。
    const url = new URL(window.location.href);
    url.searchParams.set('section', section);
    window.history.replaceState(null, '', url.toString());
  }, [section]);

  // 浏览器前进/后退后同步分组（深链的另一半；不做的话地址栏与画面会各说各话）
  useEffect(() => {
    const onPop = () => setSection(parseSection(readSectionParam()));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const active = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0];

  return (
    <>
      {/*
        离屏样张：常驻挂载（切分组不卸载），保证「点自检」时布局已就绪。

        刻意放在两栏壳**外面**：`SpecFixtureHost` 自身是个普通 div（fixed 的是它内部的样张），
        若把它放进 `display:flex` 的 `.settings` 里，它就成了一个 0 宽的 flex item ——
        而壳上有 `gap:26px`，于是左栏会被硬生生右推 26+26，左栏 180 的断言当场不成立。
        这种错位在任何截图里都只看得出"好像歪了一点"，很难定位到 gap 上。
      */}
      <SpecFixtureHost fixtureRef={fixtureRef} />

      <div className="settings">
        <nav
          className="settings-nav"
          aria-label="设置分组"
          style={{ flex: `0 0 ${SETTINGS.navWidth}px`, top: SETTINGS.navStickyTop }}
        >
          {SETTINGS_SECTIONS.map((s) => {
            const Icon = SECTION_ICON[s.id];
            const on = s.id === active.id;
            return (
              <button
                key={s.id}
                type="button"
                className={on ? 'set-nav-item is-active' : 'set-nav-item'}
                style={{
                  padding: `${SETTINGS.navItemPadding.y}px ${SETTINGS.navItemPadding.x}px`,
                  gap: SETTINGS.navItemGap,
                }}
                aria-current={on ? 'page' : undefined}
                onClick={() => setSection(s.id)}
              >
                <span className="set-nav-icon" style={{ width: SETTINGS.navItemIcon, height: SETTINGS.navItemIcon }}>
                  <Icon size={14} />
                </span>
                <span className="set-nav-label">{s.name}</span>
                <span className="set-nav-count">{sectionItemCount(s)}</span>
              </button>
            );
          })}
        </nav>

        <div className="settings-main">
          <header className="settings-head">
            <div className="settings-title" style={{ fontSize: SETTINGS.pageTitleSize }}>
              {active.name}
            </div>
            {/* blurb 缺省即不渲染这一行（显隐由 catalog 数据决定，不留空行、不崩） */}
            {active.blurb ? <div className="settings-blurb">{emphasis(active.blurb)}</div> : null}
          </header>

          {active.id === 'general' ? (
            <GeneralSection
              mode={mode}
              onMode={onMode}
              sidebarLabels={sidebarLabels}
              onSidebarLabels={onSidebarLabels}
              fixtureRef={fixtureRef}
            />
          ) : null}
          {active.id === 'translate' ? (
            <TranslateSection status={status} autoStart={serviceAutoStart} onAutoStart={onServiceAutoStart} />
          ) : null}
          {active.id === 'media' ? <MediaSection /> : null}
          {active.id === 'resource' ? <ResourceSection lib={lib} /> : null}
          {active.id === 'about' ? <AboutSection /> : null}
        </div>
      </div>
    </>
  );
}

function readSectionParam(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('section');
}
