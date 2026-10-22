import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Btn } from '@components/units';
import type { ServiceStatus } from '@/ipc';
import type { LibraryResponse } from '@/types';
import type { ThemeMode } from '@/themes/tokens';
import { SETTINGS } from '@/themes/tokens';
import { SETTINGS_SECTIONS, SECTION_ITEM_TOTAL, parseSection, sectionItemCount } from '@screens/settings/catalog';
import type { SectionId } from '@screens/settings/catalog';
import { searchSettings } from '@screens/settings/search';
import type { SettingHit } from '@screens/settings/search';
import { SECTION_ICON, SECTION_KICKER } from '@screens/settings/icons';
import { emphasis } from '@screens/settings/parts';
import { SpecFixtureHost } from '@screens/settings/SpecCheck';
import { AnimeSettingsSection } from '@screens/anime/AnimeSettingsSection';
import { ANIME_SETTING_GROUPS, ANIME_SETTING_TOTAL } from '@anime/settings-catalog';
import { Clapperboard } from 'lucide-react';
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

  /**
   * 搜索态（设计稿 `.settings-search-row`）。
   *
   * 非空时右栏**整块换成命中列表**，而不是在正文里插一段 —— 设计稿就是这么切的
   * （`renderSettings` 里 `if (state.query.trim()) body.innerHTML = renderSearchResults()`）。
   * 两者同时渲染会让"我在看分组"和"我在搜索"两个语义叠在一屏，滚到哪儿都说不清。
   */
  const [query, setQuery] = useState('');
  const hits = useMemo(() => searchSettings(query), [query]);

  /** 右栏滚动区（跳转后要把命中行滚进视野，必须滚这个盒子而不是 window） */
  const bodyRef = useRef<HTMLDivElement>(null);

  /**
   * 待高亮的行：`{ id, seq }`。
   *
   * `seq` 是**同一条命中被连点两次**时的去重键 —— 只用 `id` 的话第二次点击
   * 状态没变化，effect 不重跑，用户看到"点了没反应"。
   */
  const [flash, setFlash] = useState<{ id: string; seq: number } | null>(null);
  /** 递增计数（只做去重键，不参与渲染判断，故用 ref 而非 state） */
  const flashSeq = useRef(0);

  useEffect(() => {
    if (!flash) return;
    // 40ms：等这一帧的分组内容挂上去再找行（设计稿同样用 setTimeout 40）
    const timer = window.setTimeout(() => {
      const el = bodyRef.current?.querySelector<HTMLElement>(`[data-setting-id="${flash.id}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('is-flash');
      window.setTimeout(() => el.classList.remove('is-flash'), 1600);
    }, 40);
    return () => window.clearTimeout(timer);
  }, [flash]);

  /** 点命中行：切到那一组 + 清空搜索 + 高亮该行 */
  const goHit = (hit: SettingHit) => {
    setSection(hit.section);
    setQuery('');
    setFlash({ id: hit.id, seq: (flashSeq.current += 1) });
  };

  useEffect(() => {
    // 切换后写回地址栏，让"当前在哪个分组"可被分享/刷新保持。
    // `replaceState` 而非 `pushState`：切分组是"看同一页的不同部分"，
    // 不是"去了一个新地方"，不该在窗口历史里堆 5 条记录让返回键失效。
    //
    // 🔴 参数要写进 **hash** 而不是 search：HashRouter 下 `#/settings?section=x`
    // 才是合法形态；写到 search 会变成 `?section=x#/settings`，刷新后路由器读不到。
    const url = new URL(window.location.href);
    const [hashPath, hashQuery = ''] = url.hash.replace(/^#/, '').split('?');
    const q = new URLSearchParams(hashQuery);
    q.set('section', section);
    url.hash = `#${hashPath}?${q.toString()}`;
    window.history.replaceState(null, '', url.toString());
  }, [section]);

  // 浏览器前进/后退后同步分组（深链的另一半；不做的话地址栏与画面会各说各话）。
  // HashRouter 下前进/后退改的是 hash，浏览器主要发 `hashchange`，`popstate` 不保证 ——
  // 两个都听，且同一个分组重复 set 是幂等的，不会抖。
  useEffect(() => {
    const sync = () => setSection(parseSection(readSectionParam()));
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);

  const active = SETTINGS_SECTIONS.find((s) => s.id === section) ?? null;
  const isAnime = section === 'anime';
  /** 分组序号（仅用于页眉 kicker；番剧是域内设置，单独成一支） */
  const sectionIndex = SETTINGS_SECTIONS.findIndex((s) => s.id === section);

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

      <div className="settings-layout" style={{ gridTemplateColumns: `${SETTINGS.navWidth}px minmax(0, 1fr)` }}>
        <nav className="settings-nav" aria-label="设置分组">
          <div className="settings-nav-title">偏好设置</div>
          {SETTINGS_SECTIONS.map((s) => {
            const Icon = SECTION_ICON[s.id];
            const on = s.id === active?.id;
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

          {/* 第 6 组：番剧设置（数据住在 anime 域，渲染也由该域负责） */}
          <button
            type="button"
            className={isAnime ? 'set-nav-item is-active' : 'set-nav-item'}
            style={{
              padding: `${SETTINGS.navItemPadding.y}px ${SETTINGS.navItemPadding.x}px`,
              gap: SETTINGS.navItemGap,
            }}
            aria-current={isAnime ? 'page' : undefined}
            onClick={() => setSection('anime')}
          >
            <span className="set-nav-icon" style={{ width: SETTINGS.navItemIcon, height: SETTINGS.navItemIcon }}>
              <Clapperboard size={14} />
            </span>
            <span className="set-nav-label">番剧设置</span>
            <span className="set-nav-count">{ANIME_SETTING_TOTAL}</span>
          </button>
          <div className="settings-nav-note">
            所有偏好保存在本机。
            <br />共 {SECTION_ITEM_TOTAL} 项，改动即时生效。
          </div>
        </nav>

        <div className="settings-main">
          {/*
            搜索行：设计稿 `.settings-search-row` —— 吸顶在右栏滚动区顶部，
            左侧搜索框（260px，窄窗铺满）+ 右侧项数。项数文案两态：
            未搜索「5 组 · 34 项」/ 搜索中「N 项匹配 · 共 34 项」。
          */}
          <div className="settings-search-row">
            <label className="search-field">
              <Search size={13} />
              <input
                type="search"
                value={query}
                placeholder="搜索设置项"
                aria-label="搜索设置项"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Esc 退出搜索态（设计稿同口径：清空查询并回到当前分组）
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setQuery('');
                  }
                }}
              />
              {query ? (
                <Btn kind="bare" className="search-clear" ariaLabel="清空搜索" onClick={() => setQuery('')}>
                  <X size={11} />
                </Btn>
              ) : null}
            </label>
            <span className="settings-count">
              {query.trim()
                ? `${hits.length} 项匹配 · 共 ${SECTION_ITEM_TOTAL} 项`
                : `${SETTINGS_SECTIONS.length} 组 · ${SECTION_ITEM_TOTAL} 项`}
            </span>
          </div>

          {/* 设计稿 `.settings-body`：限制正文行长（max-width 880），宽窗下不摊成一整行 */}
          <div className="settings-body" ref={bodyRef}>
            {query.trim() ? (
              <section className="settings-section is-active" key="search">
                <div className="settings-section-head">
                  <span className="kicker">SEARCH</span>
                  <h2>搜索「{query.trim()}」</h2>
                  <p>{hits.length} 个设置项匹配</p>
                </div>
                {hits.length ? (
                  <div className="settings-search-results">
                    {hits.map((hit) => (
                      <Btn key={hit.id} kind="bare" className="search-hit-row" onClick={() => goHit(hit)}>
                        <Search size={14} />
                        <span>
                          <strong>{hit.label}</strong>
                          <small>{hit.desc}</small>
                        </span>
                        <span className="hit-section">{hit.sectionName}</span>
                      </Btn>
                    ))}
                  </div>
                ) : (
                  <div className="settings-empty">
                    <h3>没有找到匹配项</h3>
                    <p>试试「缓存」、「歌词」、「引擎」或「许可」。</p>
                  </div>
                )}
              </section>
            ) : (
              <>
                <header className="settings-section-head">
                  <span className="kicker">
                    {isAnime
                      ? '06 / ANIME'
                      : `${String(sectionIndex + 1).padStart(2, '0')} / ${SECTION_KICKER[section] ?? ''}`}
                  </span>
                  <h2>{isAnime ? '番剧设置' : active?.name}</h2>
                  {isAnime ? (
                    <p>
                      番剧库、播放、字幕、数据源、媒体选择、缓存与 BT、账号与同步、备份 —— {ANIME_SETTING_GROUPS.length}{' '}
                      组共 {ANIME_SETTING_TOTAL} 项。
                    </p>
                  ) : active?.blurb ? (
                    <p>{emphasis(active.blurb)}</p>
                  ) : null}
                </header>

                {isAnime ? <AnimeSettingsSection /> : null}
                {/* 设计稿 `.settings-section.is-active` 带进场动画：key 变化时重挂，切组即播一次 */}
                <section className="settings-section is-active" key={section}>
                  {!isAnime && active?.id === 'general' ? (
                    <GeneralSection
                      mode={mode}
                      onMode={onMode}
                      sidebarLabels={sidebarLabels}
                      onSidebarLabels={onSidebarLabels}
                      fixtureRef={fixtureRef}
                    />
                  ) : null}
                  {!isAnime && active?.id === 'translate' ? (
                    <TranslateSection status={status} autoStart={serviceAutoStart} onAutoStart={onServiceAutoStart} />
                  ) : null}
                  {!isAnime && active?.id === 'media' ? <MediaSection /> : null}
                  {!isAnime && active?.id === 'resource' ? <ResourceSection lib={lib} /> : null}
                  {!isAnime && active?.id === 'about' ? <AboutSection /> : null}
                </section>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * 读当前分组。
 *
 * 🔴 必须**同时看 hash 与 search**：本应用用的是 HashRouter，地址形如
 * `#/settings?section=media` —— 查询串在 **hash 里面**，`location.search` 是空的。
 * 只读 `location.search` 的旧写法会让所有分组深链静默回落到「通用」（点了没反应，
 * 而地址栏明明写着 `section=media`）。先 hash、后 search，兼容两种形态。
 */
function readSectionParam(): string | null {
  if (typeof window === 'undefined') return null;
  const fromHash = window.location.hash.includes('?')
    ? new URLSearchParams(window.location.hash.slice(window.location.hash.indexOf('?') + 1)).get('section')
    : null;
  return fromHash ?? new URLSearchParams(window.location.search).get('section');
}
