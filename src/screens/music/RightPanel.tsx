import {
  ChevronLeft,
  ChevronRight,
  Heart,
  ListOrdered,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { PLATFORMS, capsOf, providerLabel } from '@music/platform';
import { useMusicStore } from '@music/store';
import { coverProxyUrl, songKey } from '@music/convert';
import type { Song } from '@music/types';
import { Charts } from '@screens/music/Charts';
import { Btn, Empty, IconButton, VirtualList } from '@components/units';
import { Cover, SongRow } from '@screens/music/shared';

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
  // 平台胶囊（设计稿把它放在顶行，与搜索框同一行）
  const playbackSource = useMusicStore((s) => s.playbackSource);
  const loginInfos = useMusicStore((s) => s.loginInfos);
  const switchPlaybackSource = useMusicStore((s) => s.switchPlaybackSource);

  // 只要有关键词就进「搜索」态（而不是要求已有结果）：
  // 否则「搜索中」和「搜到 0 首」都会掉回发现页，用户会以为刚才那次搜索没发生
  const searchActive = searchText.trim().length > 0;

  return (
    <>
      {/*
        顶行（设计稿 `.music-topbar`）：平台胶囊 + 搜索框，**吸顶**在中间列顶部。
        搜索框此前住在内容卡里 —— 用户要先滚到卡片顶上才找得到它，而它是这一屏
        最高频的动作。平台胶囊也从左栏顶部挪到这里：设计稿把"换平台"与"搜什么"
        放在同一行，因为它们是同一个问题的两半（在哪个平台搜）。
      */}
      <div className="music-topbar">
        <div className="platform-bar" role="tablist" aria-label="播放平台">
          {PLATFORMS.map((p) => {
            const on = p.id === playbackSource;
            const li = loginInfos[p.id];
            return (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={on}
                className={on ? 'platform-pill is-active' : 'platform-pill'}
                title={`${p.label}${li?.logged_in ? ' · 已登录' : ' · 未登录'}`}
                onClick={() => {
                  if (!on) void switchPlaybackSource(p.id);
                }}
              >
                <span
                  className="prov-dot"
                  style={{ background: p.color, opacity: li?.logged_in ? 1 : 0.35 }}
                  aria-hidden="true"
                />
                {p.label.replace('音乐', '').trim()}
              </button>
            );
          })}
        </div>

        <div className="music-search-box">
          <Search size={13} className="music-search-ico" />
          <input
            className="music-search"
            placeholder="搜索歌曲 / 歌手 / 专辑"
            aria-label="搜索音乐"
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
            {searching ? '搜索中…' : '搜索'}
          </button>
        </div>
      </div>

      <section className="music-view">
        <SearchCaps />

        {searchError ? <div className="music-inline-err">搜索失败：{searchError}</div> : null}

        <div className="music-rightbody">{searchActive ? <SearchResults /> : <Discover />}</div>
      </section>
    </>
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

/** 搜索结果（单曲）：每行右侧「加入队列 / 红心 / 播放」；触底续拉下一页 */
function SearchResults() {
  const results = useMusicStore((s) => s.searchResults);
  const searchProvider = useMusicStore((s) => s.searchProvider);
  const searchText = useMusicStore((s) => s.searchText);
  const searching = useMusicStore((s) => s.searching);
  const hasMore = useMusicStore((s) => s.searchHasMore);
  const loadingMore = useMusicStore((s) => s.loadingMoreSearch);
  const loadMore = useMusicStore((s) => s.loadMoreSearch);
  const likedByProvider = useMusicStore((s) => s.likedByProvider);
  const proxyPort = useMusicStore((s) => s.proxyPort);
  const currentSong = useMusicStore((s) => s.currentSong);
  const appendToQueue = useMusicStore((s) => s.appendToQueue);
  const toggleLike = useMusicStore((s) => s.toggleLike);
  const playPlaylist = useMusicStore((s) => s.playPlaylist);
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

  if (searching && results.length === 0) return <Empty>搜索中…</Empty>;
  if (results.length === 0) return <Empty sub="试试更短的关键词，或切换搜索源。">没有找到「{searchText}」</Empty>;

  return (
    <>
      <div className="music-hint">
        在 {providerLabel(searchProvider)} 找到 {results.length} 首{hasMore ? ' · 向下滚动加载更多' : ''}
      </div>
      <VirtualList
        items={results}
        resetKey={`search:${searchProvider}:${searchText}`}
        itemKey={(s, i) => `${s.provider}:${s.id}:${i}`}
        onNearEnd={hasMore && !loadingMore ? () => void loadMore() : undefined}
        renderItem={(s, i) => {
          const liked = likedSet.has(s.id);
          // 搜索结果里点一首 = 把整个结果集设为队列（与左键点行同一个回调）
          const play = () => void playPlaylist(results, { index: i });
          return (
            <SongRow
              song={s}
              cover={coverProxyUrl(s.cover, proxyPort)}
              active={currentSong ? songKey(currentSong) === songKey(s) : false}
              onClick={play}
              onPlay={play}
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
                      play();
                    }}
                  >
                    <Play size={13} />
                  </IconButton>
                </>
              }
            />
          );
        }}
      />
      {hasMore ? <div className="music-more">{loadingMore ? '加载中…' : '上滑加载更多'}</div> : null}
    </>
  );
}

/** 发现正文：按 rightView 分流 */
function Discover() {
  const rightView = useMusicStore((s) => s.rightView);
  if (rightView === 'tracks') return <RightTracksView />;
  if (rightView === 'daily') return <DailyView />;
  return <Recommendations />;
}

/** 推荐页：Hero + 三枚入口卡 + 官方榜单 + 推荐歌单（后者按能力矩阵显示） */
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
      <HomeHero />
      <EntryGrid />
      <div id="music-charts">
        <Charts />
      </div>
      {caps.recommendPlaylists ? (
        <>
          <div className="music-card-hd">
            <span className="music-card-title">推荐歌单</span>
            <div className="grow" />
            <button type="button" className="music-btn out" disabled={loading} onClick={() => void loadRecommend()}>
              <RefreshCw size={12} /> {loading ? '刷新中…' : '刷新'}
            </button>
          </div>
          {recommendPlaylists.length === 0 ? (
            <Empty inline>{loading ? '加载推荐歌单中…' : '暂无推荐歌单（可能需要登录或网络）'}</Empty>
          ) : (
            <VirtualList
              items={recommendPlaylists}
              resetKey={`recommend:${playbackSource}`}
              itemKey={(pl) => pl.id}
              renderItem={(pl) => (
                <div className="music-row" onClick={() => void openRightPlaylist(pl)}>
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
          )}
        </>
      ) : null}
    </>
  );
}

/**
 * 首页 Hero（设计稿 `.music-hero`）：左侧文案 + 右侧黑胶，主行动是「播放全部」。
 *
 * 设计稿的标题与描述取自"每日推荐"这张歌单本身；本产品的每日推荐是**曲目列表**
 * （`dailySongs`），没有歌单标题/简介可引用，所以标题写「每日推荐」、描述写真实的曲目数。
 * 日期取当天 —— 每日推荐本来就按天换。
 */
function HomeHero() {
  const dailySongs = useMusicStore((s) => s.dailySongs);
  const loading = useMusicStore((s) => s.loadingDaily);
  const playPlaylist = useMusicStore((s) => s.playPlaylist);
  const setRightView = useMusicStore((s) => s.setRightView);

  const now = new Date();
  const kicker = `每日推荐 · ${now.getMonth() + 1} 月 ${now.getDate()} 日`;
  const desc = loading
    ? '正在取今天的推荐…'
    : dailySongs.length
      ? `今天也有 ${dailySongs.length} 首新歌`
      : '登录网易云后每天更新';

  return (
    <section className="music-hero">
      <div className="hero-copy">
        <span className="hero-kicker kicker">
          <Sparkles size={12} />
          {kicker}
        </span>
        <h2>每日推荐</h2>
        <p>{desc}</p>
        <div className="hero-actions">
          <Btn kind="primary" disabled={dailySongs.length === 0} onClick={() => void playPlaylist(dailySongs)}>
            <Play size={14} /> 播放全部
          </Btn>
          <Btn kind="ghost" onClick={() => setRightView('daily')}>
            查看歌单
          </Btn>
        </div>
      </div>
      <div className="hero-art" aria-hidden="true">
        <span className="hero-vinyl" />
      </div>
    </section>
  );
}

/**
 * 三枚入口卡（设计稿 `.entry-grid`）：每日推荐 / 官方榜单 / 我喜欢的音乐。
 *
 * 三者都跳到真实去处：每日推荐切右栏的 daily 视图；官方榜单滚到下面那张榜单区；
 * 我喜欢的音乐打开左栏那张被统一命名的收藏歌单（未登录时没有它，卡片置灰并说明原因）。
 */
function EntryGrid() {
  const dailySongs = useMusicStore((s) => s.dailySongs);
  const setRightView = useMusicStore((s) => s.setRightView);
  const userPlaylists = useMusicStore((s) => s.userPlaylists);
  const openLeftPlaylist = useMusicStore((s) => s.openLeftPlaylist);

  const liked = userPlaylists.find((pl) => pl.isLiked) ?? null;

  const toCharts = () => {
    document.getElementById('music-charts')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="entry-grid">
      <Btn kind="bare" className="entry-card" onClick={() => setRightView('daily')}>
        <span className="entry-ico">
          <Sparkles size={17} />
        </span>
        <span>
          <strong>每日推荐</strong>
          <small>{dailySongs.length ? `今天也有 ${dailySongs.length} 首新歌` : '登录后每天更新'}</small>
        </span>
        <span className="entry-arrow">
          <ChevronRight size={13} />
        </span>
      </Btn>

      <Btn kind="bare" className="entry-card" onClick={toCharts}>
        <span className="entry-ico">
          <ListOrdered size={17} />
        </span>
        <span>
          <strong>官方榜单</strong>
          <small>四个平台 · 每日更新</small>
        </span>
        <span className="entry-arrow">
          <ChevronRight size={13} />
        </span>
      </Btn>

      <Btn
        kind="bare"
        className="entry-card"
        disabled={!liked}
        title={liked ? '打开「我喜欢的音乐」' : '登录后同步收藏歌单'}
        onClick={() => {
          if (liked) void openLeftPlaylist(liked);
        }}
      >
        <span className="entry-ico">
          <Heart size={17} />
        </span>
        <span>
          <strong>我喜欢的音乐</strong>
          <small>{liked ? `${liked.track_count} 首 · 心动模式` : '登录后可查看'}</small>
        </span>
        <span className="entry-arrow">
          <ChevronRight size={13} />
        </span>
      </Btn>
    </div>
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
  const playPlaylist = useMusicStore((s) => s.playPlaylist);
  const currentSong = useMusicStore((s) => s.currentSong);
  const proxyPort = useMusicStore((s) => s.proxyPort);

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
          onClick={() => void playPlaylist(tracks, { playlist: meta ?? undefined })}
        >
          <Play size={12} /> 播放全部
        </button>
      </div>

      {loading ? (
        <Empty>加载曲目中…</Empty>
      ) : tracks.length === 0 ? (
        <Empty sub="去搜索一些歌曲，加入喜欢的歌单。">歌单是空的</Empty>
      ) : (
        <>
          <VirtualList
            items={tracks}
            resetKey={meta?.id ?? 'right-tracks'}
            itemKey={(s, i) => `${s.provider}:${s.id}:${i}`}
            onNearEnd={loadingMore ? undefined : () => void loadMore()}
            renderItem={(s, i) => {
              // 榜单/歌单曲目：把整张单子设为队列
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

/** 每日推荐（仅网易云有数据；其余平台入口不出现） */
function DailyView() {
  const songs = useMusicStore((s) => s.dailySongs);
  const loading = useMusicStore((s) => s.loadingDaily);
  const back = useMusicStore((s) => s.backToRecommendations);
  const playPlaylist = useMusicStore((s) => s.playPlaylist);
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
          onClick={() => void playPlaylist(songs)}
        >
          <Play size={12} /> 播放全部
        </button>
      </div>

      {loading ? (
        <Empty>加载每日推荐中…</Empty>
      ) : songs.length === 0 ? (
        <Empty>暂无每日推荐（可能需要登录网易云）</Empty>
      ) : (
        <VirtualList
          items={songs}
          resetKey="daily"
          itemKey={(s, i) => `${s.provider}:${s.id}:${i}`}
          renderItem={(s, i) => {
            // 每日推荐：把推荐列表设为队列
            const play = () => void playPlaylist(songs, { index: i });
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
      )}
    </div>
  );
}
