import { ChevronLeft, Play } from 'lucide-react';
import { providerLabel } from '@music/platform';
import { useMusicStore } from '@music/store';
import { coverProxyUrl, songKey } from '@music/convert';
import type { LeftView } from '@music/store';
import { HistoryView } from '@screens/music/HistoryView';
import { LocalView } from '@screens/music/LocalView';
import { Empty, VirtualList } from '@components/units';
import { Cover, SongRow } from '@screens/music/shared';

const TABS: { id: LeftView; label: string }[] = [
  { id: 'playlists', label: '我的歌单' },
  { id: 'local', label: '本地' },
  { id: 'history', label: '播放历史' },
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
    <section className="music-card">
      <div className="ltabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={active === t.id ? 'ltab is-on' : 'ltab'}
            onClick={() => {
              // 点「我的歌单」时若正处在曲目下钻态，要一路退回去，不能只切高亮
              if (t.id === 'playlists') backToPlaylists();
              else setLeftView(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {leftView === 'playlists' ? (
        <PlaylistsView />
      ) : leftView === 'tracks' ? (
        <LeftTracksView />
      ) : leftView === 'local' ? (
        <LocalView />
      ) : (
        <HistoryView />
      )}
    </section>
  );
}

/** 我的歌单：未登录是空态（store 不会去拉），登录后列出当前平台账号的歌单 */
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
  if (userPlaylists.length === 0) return <Empty>这个平台账号下还没有歌单</Empty>;

  return (
    <div className="music-body">
      <div className="music-card-hd">
        <span className="music-card-sub">{userPlaylists.length} 个歌单</span>
        <div className="grow" />
        <button type="button" className="music-btn out" disabled={loading} onClick={() => void loadUserPlaylists()}>
          刷新
        </button>
      </div>
      <VirtualList
        items={userPlaylists}
        resetKey={`left-playlists:${playbackSource}`}
        itemKey={(pl) => pl.id}
        renderItem={(pl) => (
          <div className="music-row" onClick={() => void openLeftPlaylist(pl)}>
            <Cover url={coverProxyUrl(pl.cover, proxyPort)} />
            <div className="music-row-tx">
              <b>{pl.name}</b>
              <span>
                {pl.track_count} 首 · {providerLabel(pl.provider)}
              </span>
            </div>
          </div>
        )}
      />
    </div>
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
  const loading = useMusicStore((s) => s.loadingLeftTracks);
  const loadingMore = useMusicStore((s) => s.loadingMoreLeft);
  const loadMore = useMusicStore((s) => s.loadMoreLeft);
  const back = useMusicStore((s) => s.backToPlaylists);
  const playQueue = useMusicStore((s) => s.playQueue);
  const currentSong = useMusicStore((s) => s.currentSong);
  const proxyPort = useMusicStore((s) => s.proxyPort);

  const total = meta?.track_count ?? 0;

  return (
    <div className="music-body">
      <div className="music-card-hd">
        <button type="button" className="music-btn out" onClick={back}>
          <ChevronLeft size={12} /> 返回
        </button>
        <span className="music-card-title">{meta?.name ?? '歌单'}</span>
        <span className="music-card-sub">
          {tracks.length}
          {total ? ` / ${total}` : ''} 首
        </span>
        <div className="grow" />
        <button
          type="button"
          className="music-btn pri"
          disabled={tracks.length === 0}
          onClick={() => void playQueue(tracks, 0)}
        >
          <Play size={12} /> 播放全部
        </button>
      </div>

      {loading ? (
        <Empty>加载曲目中…</Empty>
      ) : tracks.length === 0 ? (
        <Empty>这个歌单是空的</Empty>
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
              const play = () => void playQueue(tracks, i);
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
