import { ChevronLeft, Heart, Play, Plus, RefreshCw, Search, X } from 'lucide-react';
import type { UIEvent } from 'react';
import { PLATFORMS, capsOf, providerLabel } from '../../music/platform';
import { coverProxyUrl, songKey, useMusicStore } from '../../music/store';
import type { Song } from '../../music/types';
import { Charts } from './Charts';
import { Cover, Empty, IconButton, SongRow } from './shared';

/**
 * 右栏「发现」。
 * 顶部是搜索框 + **搜索源胶囊行**：搜索源独立于播放源（可拿 A 平台搜、播 B 平台的歌），
 * 因此这里单独维护 searchProvider，并在胶囊上标出各平台登录态 —— 未登录的平台搜不了，直接禁用。
 * 正文按优先级分流：搜索结果 > 曲目视图 > 每日推荐 > 推荐歌单。
 */
export function RightPanel() {
  const searchText = useMusicStore((s) => s.searchText);
  const setSearchText = useMusicStore((s) => s.setSearchText);
  const search = useMusicStore((s) => s.search);
  const clearSearch = useMusicStore((s) => s.clearSearch);
  const searching = useMusicStore((s) => s.searching);
  const searchError = useMusicStore((s) => s.searchError);
  const searchResults = useMusicStore((s) => s.searchResults);

  const hasResults = searchText.trim().length > 0 && searchResults.length > 0;

  return (
    <section className="music-card">
      <div className="music-search-row">
        <input
          className="music-search"
          placeholder="搜索歌曲…（回车搜索）"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search();
          }}
        />
        {searchText ? (
          <button type="button" className="music-btn out" title="清空搜索" onClick={() => clearSearch()}>
            <X size={12} />
          </button>
        ) : null}
        <button type="button" className="music-btn pri" disabled={searching} onClick={() => void search()}>
          <Search size={12} /> {searching ? '搜索中…' : '搜索'}
        </button>
      </div>

      <SearchCaps />

      {searchError ? <div className="music-inline-err">搜索失败：{searchError}</div> : null}

      <div className="music-rightbody">
        {hasResults ? <SearchResults /> : <Discover />}
      </div>
    </section>
  );
}

/** 搜索源胶囊：一颗平台一个，绿点=已登录、灰点=未登录；未登录禁用并给出原因 */
function SearchCaps() {
  const searchProvider = useMusicStore((s) => s.searchProvider);
  const loginInfos = useMusicStore((s) => s.loginInfos);
  const setSearchProvider = useMusicStore((s) => s.setSearchProvider);

  return (
    <div className="cap-row">
      {PLATFORMS.map((p) => {
        const logged = !!loginInfos[p.id]?.logged_in;
        const on = p.id === searchProvider;
        return (
          <button
            key={p.id}
            type="button"
            className={on ? 'cap is-on' : 'cap'}
            disabled={!logged}
            title={logged ? `用 ${p.label} 搜索` : '未登录不可搜'}
            onClick={() => setSearchProvider(p.id)}
          >
            <i className="cap-dot" style={{ background: logged ? '#22C55E' : 'var(--md-muted)' }} />
            {p.label}
          </button>
        );
      })}
      <span className="cap-note">搜索源独立于播放源</span>
    </div>
  );
}

/** 搜索结果（单曲）：每行右侧「加入队列 / 红心 / 播放」 */
function SearchResults() {
  const results = useMusicStore((s) => s.searchResults);
  const searchProvider = useMusicStore((s) => s.searchProvider);
  const likedByProvider = useMusicStore((s) => s.likedByProvider);
  const proxyPort = useMusicStore((s) => s.proxyPort);
  const currentSong = useMusicStore((s) => s.currentSong);
  const appendToQueue = useMusicStore((s) => s.appendToQueue);
  const toggleLike = useMusicStore((s) => s.toggleLike);
  const playQueue = useMusicStore((s) => s.playQueue);
  const toast = useMusicStore((s) => s.toast);

  const likeWritable = capsOf(searchProvider).likeWrite;
  // 红心按**歌曲自身平台**取（搜索源可独立于播放源），避免跨源串台
  const likedSet = likedByProvider[searchProvider] ?? new Set<string>();

  const onLike = (song: Song) => {
    // 能力矩阵按**搜索源**判定（搜出来的歌属于搜索源平台），不能写回时明确提示而不是静默
    if (!likeWritable) {
      toast(
        searchProvider === 'qqmusic'
          ? 'QQ 音乐当前仅支持读取账号收藏，暂不支持写回'
          : `${providerLabel(searchProvider)} 暂不支持红心收藏`,
      );
      return;
    }
    void toggleLike(song);
  };

  return (
    <div className="music-list">
      <div className="music-hint">
        在 {providerLabel(searchProvider)} 找到 {results.length} 首
      </div>
      {results.map((s, i) => {
        const liked = likedSet.has(s.id);
        return (
          <SongRow
            key={`${s.provider}:${s.id}:${i}`}
            song={s}
            cover={coverProxyUrl(s.cover, proxyPort)}
            active={currentSong ? songKey(currentSong) === songKey(s) : false}
            onClick={() => void playQueue(results, i)}
            actions={
              <>
                <IconButton
                  title="加入队列"
                  onClick={(e) => {
                    e.stopPropagation();
                    appendToQueue([s]);
                  }}
                >
                  <Plus size={13} />
                </IconButton>
                <IconButton
                  title={liked ? '取消红心' : '红心'}
                  active={liked}
                  onClick={(e) => {
                    e.stopPropagation();
                    onLike(s as Song);
                  }}
                >
                  <Heart size={13} fill={liked ? 'currentColor' : 'none'} />
                </IconButton>
                <IconButton
                  title="播放"
                  onClick={(e) => {
                    e.stopPropagation();
                    void playQueue(results, i);
                  }}
                >
                  <Play size={13} />
                </IconButton>
              </>
            }
          />
        );
      })}
    </div>
  );
}

/** 发现正文：按 rightView 分流 */
function Discover() {
  const rightView = useMusicStore((s) => s.rightView);
  if (rightView === 'tracks') return <RightTracksView />;
  if (rightView === 'daily') return <DailyView />;
  return <Recommendations />;
}

/** 推荐页：官方榜单 + 推荐歌单（后者按能力矩阵显示，且自身可滚动） */
function Recommendations() {
  const playbackSource = useMusicStore((s) => s.playbackSource);
  const recommendPlaylists = useMusicStore((s) => s.recommendPlaylists);
  const loading = useMusicStore((s) => s.loadingRecommend);
  const proxyPort = useMusicStore((s) => s.proxyPort);
  const loadRecommend = useMusicStore((s) => s.loadRecommend);
  const openRightPlaylist = useMusicStore((s) => s.openRightPlaylist);

  const caps = capsOf(playbackSource);

  return (
    <>
      <Charts />
      {caps.recommendPlaylists ? (
        <>
          <div className="music-card-hd">
            <span className="music-card-title">推荐歌单</span>
            <div className="grow" />
            <button type="button" className="music-btn out" disabled={loading} onClick={() => void loadRecommend()}>
              <RefreshCw size={12} /> {loading ? '刷新中…' : '刷新'}
            </button>
          </div>
          <div className="music-list">
            {recommendPlaylists.length === 0 ? (
              <Empty inline>{loading ? '加载推荐歌单中…' : '暂无推荐歌单（可能需要登录或网络）'}</Empty>
            ) : (
              recommendPlaylists.map((pl) => (
                <div key={pl.id} className="music-row" onClick={() => void openRightPlaylist(pl)}>
                  <Cover url={coverProxyUrl(pl.cover, proxyPort)} />
                  <div className="music-row-tx">
                    <b>{pl.name}</b>
                    <span>
                      {pl.track_count} 首 · {providerLabel(pl.provider)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      ) : null}
    </>
  );
}

/** 歌单/榜单曲目（右栏下钻态）：滚动到底加载下一页 */
function RightTracksView() {
  const meta = useMusicStore((s) => s.rightPlaylistMeta);
  const tracks = useMusicStore((s) => s.rightPlaylistTracks);
  const loading = useMusicStore((s) => s.loadingRightTracks);
  const loadingMore = useMusicStore((s) => s.loadingMoreRight);
  const loadMore = useMusicStore((s) => s.loadMoreRight);
  const back = useMusicStore((s) => s.backToRecommendations);
  const playQueue = useMusicStore((s) => s.playQueue);
  const currentSong = useMusicStore((s) => s.currentSong);
  const proxyPort = useMusicStore((s) => s.proxyPort);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (!loadingMore && el.scrollTop + el.clientHeight >= el.scrollHeight - 60) void loadMore();
  };

  const total = meta?.track_count ?? 0;

  return (
    <div className="music-body">
      <div className="music-card-hd">
        <button type="button" className="music-btn out" onClick={back}>
          <ChevronLeft size={12} /> 返回
        </button>
        <span className="music-card-title">{meta?.name ?? '曲目'}</span>
        <span className="music-card-sub">{tracks.length} 首</span>
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
        <Empty>没有拿到曲目</Empty>
      ) : (
        <>
          <div className="music-list" onScroll={onScroll}>
            {tracks.map((s, i) => (
              <SongRow
                key={`${s.provider}:${s.id}:${i}`}
                song={s}
                cover={coverProxyUrl(s.cover, proxyPort)}
                active={currentSong ? songKey(currentSong) === songKey(s) : false}
                onClick={() => void playQueue(tracks, i)}
              />
            ))}
          </div>
          {total > 0 && tracks.length < total ? (
            <div className="music-more">{loadingMore ? '加载中…' : '上滑加载更多'}</div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** 每日推荐（仅网易云有数据；其余平台入口不出现） */
function DailyView() {
  const songs = useMusicStore((s) => s.dailySongs);
  const loading = useMusicStore((s) => s.loadingDaily);
  const back = useMusicStore((s) => s.backToRecommendations);
  const playQueue = useMusicStore((s) => s.playQueue);
  const currentSong = useMusicStore((s) => s.currentSong);
  const proxyPort = useMusicStore((s) => s.proxyPort);

  return (
    <div className="music-body">
      <div className="music-card-hd">
        <button type="button" className="music-btn out" onClick={back}>
          <ChevronLeft size={12} /> 返回
        </button>
        <span className="music-card-title">每日推荐</span>
        <span className="music-card-sub">{songs.length} 首</span>
        <div className="grow" />
        <button
          type="button"
          className="music-btn pri"
          disabled={songs.length === 0}
          onClick={() => void playQueue(songs, 0)}
        >
          <Play size={12} /> 播放全部
        </button>
      </div>

      {loading ? (
        <Empty>加载每日推荐中…</Empty>
      ) : songs.length === 0 ? (
        <Empty>暂无每日推荐（可能需要登录网易云）</Empty>
      ) : (
        <div className="music-list">
          {songs.map((s, i) => (
            <SongRow
              key={`${s.provider}:${s.id}:${i}`}
              song={s}
              cover={coverProxyUrl(s.cover, proxyPort)}
              active={currentSong ? songKey(currentSong) === songKey(s) : false}
              onClick={() => void playQueue(songs, i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
