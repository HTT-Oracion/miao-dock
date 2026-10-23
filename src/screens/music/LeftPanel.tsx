import { ChevronLeft, Play, RefreshCw } from 'lucide-react';
import { useMusicStore } from '@music/store';
import { coverProxyUrl, songKey } from '@music/convert';
import type { LeftView } from '@music/store';
import type { Playlist } from '@music/types';
import { HistoryView } from '@screens/music/HistoryView';
import { LocalView } from '@screens/music/LocalView';
import { Btn, Empty, VirtualList } from '@components/units';
import { Cover, SongRow } from '@screens/music/shared';

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
        {leftView === 'playlists' ? (
          <PlaylistsView />
        ) : leftView === 'tracks' ? (
          <LeftTracksView />
        ) : leftView === 'local' ? (
          <LocalView />
        ) : (
          <HistoryView />
        )}
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

  const logged = !!loginInfos[playbackSource]?.logged_in;

  if (!logged) return <Empty>登录后查看我的歌单</Empty>;
  if (error) return <Empty bad>歌单读取失败：{error}</Empty>;
  if (loading && userPlaylists.length === 0) return <Empty>加载歌单中…</Empty>;
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
   */
  const renderGroup = (label: string, items: Playlist[], refresh: boolean) => (
    <div className="ms-group" key={label}>
      <div className="ms-caption">
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
      </div>
      {items.length > 0 ? (
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

/**
 * 歌单曲目：定高虚拟列表 + 滚动接近底部自动续拉下一页（loadMoreLeft）。
 * 触发交给 VirtualList 的 onNearEnd（距底两行）—— 到底才触发会白等一个 RTT，
 * 用阈值把网络耗时藏在滚动里；分页仍由 store 负责（本组件只负责「什么时候要」）。
 */
function LeftTracksView() {
  const meta = useMusicStore((s) => s.leftPlaylistMeta);
  const tracks = useMusicStore((s) => s.leftPlaylistTracks);
  const tracksError = useMusicStore((s) => s.leftTracksError);
  const loading = useMusicStore((s) => s.loadingLeftTracks);
  const loadingMore = useMusicStore((s) => s.loadingMoreLeft);
  const loadMore = useMusicStore((s) => s.loadMoreLeft);
  const back = useMusicStore((s) => s.backToPlaylists);
  const playPlaylist = useMusicStore((s) => s.playPlaylist);
  const currentSong = useMusicStore((s) => s.currentSong);
  const proxyPort = useMusicStore((s) => s.proxyPort);

  const total = meta?.track_count ?? 0;

  return (
    <div className="music-body">
      <div className="mc-section-head">
        <Btn kind="bare" className="music-btn out" ariaLabel="返回" onClick={back}>
          <ChevronLeft size={12} /> 返回
        </Btn>
        <span className="music-card-title">{meta?.name ?? '歌单'}</span>
        <span className="music-card-sub">
          {tracks.length}
          {total ? ` / ${total}` : ''} 首
        </span>
        <div className="grow" />
        <Btn
          kind="bare"
          className="music-btn pri"
          disabled={tracks.length === 0}
          onClick={() => void playPlaylist(tracks, { playlist: meta ?? undefined })}
        >
          <Play size={12} /> 播放全部
        </Btn>
      </div>

      {loading ? (
        <Empty>加载曲目中…</Empty>
      ) : tracksError ? (
        /* 读失败与"歌单是空的"分开说：前者能重试（再点一次这个歌单），后者重试也没用 */
        <Empty bad sub={tracksError}>
          曲目读取失败
        </Empty>
      ) : tracks.length === 0 ? (
        <Empty>这个歌单还没有歌曲</Empty>
      ) : (
        <>
          <VirtualList
            items={tracks}
            resetKey={meta?.id ?? 'left-tracks'}
            itemKey={(s, i) => `${s.provider}:${s.id}:${i}`}
            onNearEnd={loadingMore ? undefined : () => void loadMore()}
            renderItem={(s, i) => {
              // 「播放」在歌单曲目里的语义是"把整个歌单设为队列并从这一首开始" ——
              // 左键点行与右键菜单的「播放」必须是同一个回调，否则两处行为会各走各的
              const play = () => void playPlaylist(tracks, { playlist: meta ?? undefined, index: i });
              return (
                <SongRow
                  song={s}
                  cover={coverProxyUrl(s.cover, proxyPort)}
                  active={currentSong ? songKey(currentSong) === songKey(s) : false}
                  onClick={play}
                  onPlay={play}
                />
              );
            }}
          />
          {total > 0 && tracks.length < total ? (
            <div className="music-more">{loadingMore ? '加载中…' : '上滑加载更多'}</div>
          ) : null}
        </>
      )}
    </div>
  );
}
