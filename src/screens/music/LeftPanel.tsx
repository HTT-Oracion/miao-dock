import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useMusicStore } from '@music/store';
import { coverProxyUrl } from '@music/convert';
import type { LeftView } from '@music/store';
import type { Playlist } from '@music/types';
import { HistoryView } from '@screens/music/HistoryView';
import { LocalView } from '@screens/music/LocalView';
import { Btn, Empty } from '@components/units';
import { PlaylistListSkeleton } from '@screens/music/skeletons';
import { Cover } from '@screens/music/shared';

// Tab 文案与设计稿左栏一致：`歌单 / 本地 / 历史`（不写"我的歌单 / 播放历史"的长名，
// 三个 Tab 并排时短名才排得下且不换行）
const TABS: { id: LeftView; label: string }[] = [
  { id: 'playlists', label: '歌单' },
  { id: 'local', label: '本地' },
  { id: 'history', label: '历史' },
];

/**
 * 左栏「我的音乐」—— 三个 Tab 承载四个视图：
 * playlists / local / history 各一个 Tab；`tracks`（歌单曲目）是 playlists 的下钻态，
 * 所以它高亮的是「我的歌单」Tab，返回也走 backToPlaylists。
 */
export function LeftPanel() {
  const leftView = useMusicStore((s) => s.leftView);
  const setLeftView = useMusicStore((s) => s.setLeftView);
  const backToPlaylists = useMusicStore((s) => s.backToPlaylists);

  const active: LeftView = leftView === 'tracks' ? 'playlists' : leftView;

  return (
    <>
      {/* 三枚 Tab 是**一组**（设计稿 `.ms-tabs` 带 `role="tablist"`）：
          缺 role/aria-selected 时，读屏听到的是三个互不相干的按钮，
          听不出"当前在哪个视图"。 */}
      <div className="ms-tabs" role="tablist">
        {TABS.map((t) => (
          <Btn
            key={t.id}
            kind="bare"
            role="tab"
            ariaSelected={active === t.id}
            className={active === t.id ? 'ms-tab is-active' : 'ms-tab'}
            onClick={() => {
              // 点「我的歌单」时若正处在曲目下钻态，要一路退回去，不能只切高亮
              if (t.id === 'playlists') backToPlaylists();
              else setLeftView(t.id);
            }}
          >
            {t.label}
          </Btn>
        ))}
      </div>

      {/* 视图区自带滚动（设计稿 `.ms-scroll`）：滚动条只出现在这一层，
          而不是整张左卡一起滚（那样 Tab 会跟着滚走） */}
      <div className="ms-scroll">
        {/*
         * 左栏只渲染「列表」这一类视图：歌单 / 本地 / 历史。
         * `tracks`（歌单曲目）**不在这里渲染** —— 设计稿把歌单详情放在右侧主体，
         * 点歌单时左栏保持列表不动（否则屏幕上两个区域同时变，且左栏回不去）。
         */}
        {leftView === 'local' ? <LocalView /> : leftView === 'history' ? <HistoryView /> : <PlaylistsView />}
      </div>
    </>
  );
}

/** 我的歌单：未登录是空态（store 不会去拉），登录后按「创建 / 收藏」分组列出 */
function PlaylistsView() {
  const playbackSource = useMusicStore((s) => s.playbackSource);
  const loginInfos = useMusicStore((s) => s.loginInfos);
  const userPlaylists = useMusicStore((s) => s.userPlaylists);
  const loading = useMusicStore((s) => s.loadingUserPlaylists);
  const error = useMusicStore((s) => s.userPlaylistsError);
  const proxyPort = useMusicStore((s) => s.proxyPort);
  const openLeftPlaylist = useMusicStore((s) => s.openLeftPlaylist);
  const loadUserPlaylists = useMusicStore((s) => s.loadUserPlaylists);

  /*
   * 组头折叠态（#16）—— 必须在任何早返回**之前**声明：
   * React Hook 的调用顺序在一次渲染里必须恒定，放在 early return 之后会直接报错。
   */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (label: string) => setCollapsed((c) => ({ ...c, [label]: !c[label] }));

  const logged = !!loginInfos[playbackSource]?.logged_in;

  if (!logged) return <Empty>登录后查看我的歌单</Empty>;
  if (error) return <Empty bad>歌单读取失败：{error}</Empty>;
  if (loading && userPlaylists.length === 0) return <PlaylistListSkeleton rows={6} />;
  if (userPlaylists.length === 0) return <Empty>还没有创建歌单</Empty>;

  /*
   * 分组：按 `subscribed` 分——false = 用户自己创建的（含统一改名后的「我喜欢的音乐」），
   * true = 收藏别人的。这个标记是接口给的语义位，不是猜的。
   * 空分组**整组不渲染**（连组头一起）：没有收藏歌单时留一个"收藏的歌单 0"的组头，
   * 只会让用户以为点了没反应。
   */
  const created = userPlaylists.filter((pl) => pl.subscribed !== true);
  const subscribed = userPlaylists.filter((pl) => pl.subscribed === true);

  /*
   * 渲染方式：**不用 `VirtualList`**（与曲目列表不同）。
   *
   * 设计稿这里的两类行**不等高** —— 组头 32、歌单行 46 —— 而定高虚拟列表要求
   * 所有行同高（`itemHeight`），套上去要么把组头撑到 46、要么把行压到 32，
   * 两种都与设计稿不符。歌单数量是"几十条"量级（曲目才是上千），
   * 全量渲染的节点数完全可控，因此这里按分组直接铺。
   *
   * ## 组头可折叠（#16）
   * 歌单一多起来，「收藏的歌单」常常有上百条，把「创建的歌单」顶到看不见。
   * 于是组头本身可点：点一下收起 / 展开。
   * ⚠️ **不画额外图标**：设计稿的 `.ms-caption` 里没有箭头，折叠态只靠
   * "行不见了"表达 —— 加一枚箭头会让组头从"一行小标签"变成"一个按钮"。
   */
  const renderGroup = (label: string, items: Playlist[], refresh: boolean) => (
    <div className="ms-group" key={label}>
      {/*
       * 组头走 `Btn`（kind="bare"）而不是裸 `<button>`：`type="button"`、disabled 语义、
       * 无障碍属性都由这个单元统一给，屏内各处不再手写一遍原生按钮。
       * `kind="bare"` 时 className 是唯一类名，所以 `ms-caption` 原样生效。
       */}
      <Btn
        kind="bare"
        className={collapsed[label] ? 'ms-caption is-collapsed' : 'ms-caption'}
        ariaExpanded={!collapsed[label]}
        onClick={() => toggle(label)}
      >
        {label}
        {refresh ? (
          <Btn
            kind="bare"
            className="text-btn"
            ariaLabel="刷新歌单"
            disabled={loading}
            title="刷新歌单"
            onClick={() => void loadUserPlaylists()}
          >
            <RefreshCw size={11} />
          </Btn>
        ) : null}
      </Btn>
      {collapsed[label] ? null : items.length > 0 ? (
        items.map((pl) => (
          <div className="music-row" key={pl.id} onClick={() => void openLeftPlaylist(pl)}>
            <Cover url={coverProxyUrl(pl.cover, proxyPort)} className="ms-row-cover" />
            <div className="music-row-tx">
              <b>{pl.name}</b>
              {/* 第二行按设计稿 `.ms-row-meta small`：作者 · N 首（平台由当前账号决定，不必每行重复） */}
              <span>
                {pl.creator ? `${pl.creator} · ` : ''}
                {pl.track_count} 首
              </span>
            </div>
          </div>
        ))
      ) : (
        <div className="ms-empty">还没有创建歌单</div>
      )}
    </div>
  );

  return (
    <>
      {created.length > 0 ? renderGroup('创建的歌单', created, true) : null}
      {subscribed.length > 0 ? renderGroup('收藏的歌单', subscribed, false) : null}
    </>
  );
}
