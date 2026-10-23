import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  HardDrive,
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
import { LocalPanel } from '@screens/music/LocalPanel';
import { PlaylistDetail } from '@screens/music/PlaylistDetail';
import { Btn, Empty, IconButton, OverlayScrollbar, VirtualList } from '@components/units';
import type { OverlayThumb } from '@components/units';
import { Cover, SongRow } from '@screens/music/shared';

/**
 * 右栏「发现」。
 * 顶部是搜索框 + **搜索源胶囊行**：搜索源独立于播放源（可拿 A 平台搜、播 B 平台的歌），
 * 因此这里单独维护 searchProvider，并在胶囊上标出各平台登录态 —— 未登录的平台搜不了，直接禁用。
 * 正文按优先级分流：搜索结果 > 曲目视图 > 每日推荐 > 推荐歌单。
 */
export function RightPanel({
  centerScrollRef,
  centerThumb,
}: {
  /** 中栏滚动容器的 ref（由 MusicScreen 传进来，供覆盖式滚动条与"回到顶部"用） */
  centerScrollRef?: RefObject<HTMLDivElement>;
  /** 中栏滚动条的滑块几何 */
  centerThumb?: OverlayThumb;
}) {
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
  const openLogin = useMusicStore((s) => s.openLogin);
  const leftView = useMusicStore((s) => s.leftView);
  const setLeftView = useMusicStore((s) => s.setLeftView);

  // 只要有关键词就进「搜索」态（而不是要求已有结果）：
  // 否则「搜索中」和「搜到 0 首」都会掉回发现页，用户会以为刚才那次搜索没发生
  const searchActive = searchText.trim().length > 0;

  /*
   * 中栏滚动层（`.music-view`）—— 由 MusicScreen 提供 ref 与滑块几何，
   * 这样覆盖式滚动条与"换视图回顶部"用的是**同一个** DOM 节点。
   */
  const localScrollRef = useRef<HTMLDivElement>(null);
  const scrollRef = centerScrollRef ?? localScrollRef;

  /* 换视图（发现 ↔ 搜索 ↔ 歌单详情 ↔ 本地）时**把中栏滚回顶部**。
   *
   * 中栏是这一屏唯一的滚动容器，滚动位置会跨视图保留：从榜单底部点进歌单、
   * 再退回发现页时，页面仍停在很下面的位置 —— 看上去就是"整块内容不见了 / 被盖住了"。
   * 视图是一个新的上下文，滚动位置必须跟着复位。
   */
  const viewKey = searchActive ? 'search' : leftView;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [viewKey, scrollRef]);

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
            const logged = !!li?.logged_in;
            return (
              <Btn
                key={p.id}
                kind="bare"
                role="tab"
                ariaSelected={on}
                className={on ? 'platform-pill is-active' : 'platform-pill'}
                title={`${p.label}${logged ? ' · 已登录' : ' · 未登录'}`}
                onClick={() => {
                  /*
                   * 未登录的平台**先登录再切**：直接切过去只会得到一个空列表，
                   * 用户会以为"这个平台没歌"。登录成功后 `openLogin` 会自己切播放源。
                   */
                  if (!logged) {
                    void openLogin(p.id);
                    return;
                  }
                  if (!on) void switchPlaybackSource(p.id);
                }}
              >
                <span
                  className="prov-dot"
                  style={{ background: p.color, opacity: logged ? 1 : 0.35 }}
                  aria-hidden="true"
                />
                {p.label.replace('音乐', '').trim()}
              </Btn>
            );
          })}
          {/*
           * 「本地」（设计稿 topbar 的第五枚 pill）：它不是平台、没有登录态，
           * 所以不放进 PLATFORMS；点它把左栏切到「本地」页签（那里是导入的本地曲库）。
           */}
          <Btn
            kind="bare"
            className={leftView === 'local' ? 'platform-pill is-active' : 'platform-pill'}
            ariaSelected={leftView === 'local'}
            title="本地曲库"
            onClick={() => setLeftView('local')}
          >
            <HardDrive size={11} aria-hidden="true" />
            本地
          </Btn>
        </div>

        {/*
         * 搜索框（设计稿 `.search-field`）：**一整块**内凹底 + 描边 + r10，
         * 图标 / 输入 / 清空都在框**内部**；焦点时整块边框转主色 + 3px wash 光晕。
         * 搜索按钮在框外右侧（设计稿 `.music-search-box` = 框 + 按钮两件）。
         */}
        <div className="music-search-box">
          <label className="search-field">
            <Search size={13} className="search-field-ico" aria-hidden="true" />
            <input
              placeholder={leftView === 'tracks' ? '在歌单内搜索' : '搜索歌曲 / 歌手 / 专辑'}
              aria-label="搜索音乐"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void search();
              }}
            />
            {searchText ? (
              <Btn
                kind="bare"
                className="search-clear"
                ariaLabel="清空搜索"
                title="清空搜索"
                onClick={() => clearSearch()}
              >
                <X size={11} />
              </Btn>
            ) : null}
          </label>
          <Btn kind="bare" className="btn btn-primary btn-sm" disabled={searching} onClick={() => void search()}>
            {searching ? '搜索中…' : '搜索'}
          </Btn>
        </div>
      </div>

      {/*
       * 中栏视图（设计稿 `.music-view`）：**直接**承载各个视图的节，没有中间包裹层。
       *
       * 产品此前在 `.music-view` 里多出两层 —— `.cap-row`（搜索源胶囊）与 `.music-rightbody`。
       * 前者位置错了：设计稿的搜索源胶囊只住在**搜索结果页**里（`.search-sources`），
       * 首页 / 榜单 / 歌单页不该有它；后者是纯包裹层，删掉不影响布局。
       */}
      <section className="music-view" ref={scrollRef}>
        {searchError ? <div className="music-inline-err">搜索失败：{searchError}</div> : null}
        {/*
         * 分流：搜索态 > 歌单详情 > 本地视图 > 发现页。
         *
         * 「歌单详情」排在这里是设计稿的交互：**点左栏的歌单，右侧整块换成这个歌单**
         * （左栏保持不动）。产品此前是在左栏下钻 —— 点一下屏幕上两个区域同时变，
         * 且左栏再也回不到列表。
         */}
        {searchActive ? (
          <SearchResults />
        ) : leftView === 'tracks' ? (
          <PlaylistDetail />
        ) : leftView === 'local' ? (
          <LocalPanel />
        ) : (
          <Discover />
        )}
        {/* 覆盖式滚动条：挂在滚动层自己身上，浮在内容右缘、不占布局宽度 */}
        {centerThumb ? <OverlayScrollbar thumb={centerThumb} /> : null}
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
    <div className="search-sources">
      {PLATFORMS.map((p) => {
        const logged = !!loginInfos[p.id]?.logged_in;
        const on = p.id === searchProvider;
        return (
          <Btn
            key={p.id}
            kind="bare"
            className={on ? 'search-source is-active' : 'search-source'}
            ariaPressed={on}
            disabled={!logged}
            title={logged ? `用 ${p.label} 搜索` : '登录后才能作为搜索源'}
            onClick={() => setSearchProvider(p.id)}
          >
            <i className="search-source-dot" data-on={logged ? 'yes' : 'no'} />
            {p.label}
          </Btn>
        );
      })}
      {/* 设计稿渲染层这一句是两半：后半截正是上面那些禁用胶囊的所以然，漏掉它只说"独立"不说"为什么点不动" */}
      <span className="search-source-hint">搜索源独立于播放源；未登录平台不可用</span>
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

  if (searching && results.length === 0) {
    return (
      <>
        {/* 搜索中也要能看见/切换搜索源：否则用户只能等这一次搜完才知道选错了平台 */}
        <SearchCaps />
        {/* 设计稿：搜索中要说清"在搜哪个平台" —— 只写「搜索中…」时用户不知道搜的是谁 */}
        <Empty sub="搜索结果会同时出现歌曲与专辑">正在搜索 {providerLabel(searchProvider)}…</Empty>
      </>
    );
  }
  if (results.length === 0) {
    return (
      <>
        <SearchCaps />
        <Empty art sub="试试更短的关键词，或切换搜索源。">
          没有找到「{searchText}」
        </Empty>
      </>
    );
  }

  return (
    <>
      {/* 搜索源胶囊（设计稿 `.search-sources`）：只住在搜索结果页，不在首页/榜单页 */}
      <SearchCaps />
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
              // 搜索结果按设计稿的表格口径给「歌手 · 专辑」：同名歌曲只能靠专辑区分
              meta={s.album ? `${s.artist} · ${s.album}` : s.artist}
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

/**
 * 发现正文：按 rightView 分流。
 *
 * ⚠️ `tracks` 分支已移除：推荐歌单 / 榜单 / 左栏歌单现在**统一走 `openLeftPlaylist`**，
 * 由右侧的 `PlaylistDetail` 渲染（`leftView === 'tracks'`）。
 * 原先 `rightView === 'tracks'` 走独立的 `RightTracksView`，与歌单详情是两套代码两套样式，
 * 改一处漏一处 —— 那个组件已随之删除。
 */
function Discover() {
  const rightView = useMusicStore((s) => s.rightView);
  if (rightView === 'daily') return <DailyView />;
  return <Recommendations />;
}

/** 推荐页：Hero + 三枚入口卡 + 官方榜单 + 推荐歌单（后者按能力矩阵显示） */
function Recommendations() {
  const playbackSource = useMusicStore((s) => s.playbackSource);
  const recommendPlaylists = useMusicStore((s) => s.recommendPlaylists);
  const loading = useMusicStore((s) => s.loadingRecommend);
  const recommendError = useMusicStore((s) => s.recommendError);
  const proxyPort = useMusicStore((s) => s.proxyPort);
  const loadRecommend = useMusicStore((s) => s.loadRecommend);
  // 推荐歌单 / 榜单 / 左栏歌单**共用同一个详情组件**（`PlaylistDetail`），
  // 统一走 openLeftPlaylist：设计稿里它们是同一个视图，此前各走一套导致改一处漏一处。
  const openLeftPlaylist = useMusicStore((s) => s.openLeftPlaylist);
  // 今日精选：平台级推荐新歌（匿名可取）
  const newSongs = useMusicStore((s) => s.newSongs);
  const loadingNewSongs = useMusicStore((s) => s.loadingNewSongs);
  const playPlaylist = useMusicStore((s) => s.playPlaylist);
  const currentSong = useMusicStore((s) => s.currentSong);

  const caps = capsOf(playbackSource);

  return (
    <>
      <HomeHero />
      <EntryGrid />
      {/* 榜单节自带 .mc-section 容器（Charts 内部），外面不再套一层裸 div */}
      <Charts />
      {caps.recommendPlaylists ? (
        <div className="mc-section">
          <div className="mc-section-head">
            <span className="music-card-title">推荐歌单</span>
            {/* 副标题按设计稿：一句话说清"这批是怎么来的" */}
            <span className="music-card-sub">按你最近的循环生成</span>
            <div className="grow" />
            <Btn kind="bare" className="link-btn" disabled={loading} onClick={() => void loadRecommend()}>
              <RefreshCw size={12} /> {loading ? '换一批中…' : '换一批'}
            </Btn>
          </div>
          {recommendPlaylists.length === 0 ? (
            recommendError ? (
              /* 三段全读失败：说明原因并给重试（右上那枚按钮就是重试入口，名字要与按钮一致） */
              <Empty bad inline sub={`${recommendError}（点右上「换一批」重新加载）`}>
                推荐读取失败
              </Empty>
            ) : (
              <Empty inline>{loading ? '加载推荐歌单中…' : '暂无推荐歌单（可能需要登录或网络）'}</Empty>
            )
          ) : (
            /*
             * 推荐歌单（设计稿 `.card-grid` + `.playlist-card`）：**四列封面卡**，不是列表行。
             * 每张卡 = 封面（1:1，r12）+ 歌单名 + 「N 首 · 作者」，右下角一枚圆形播放钮浮在封面上。
             * 这里不能用 VirtualList：设计稿是网格，行高由列宽决定，不是定高列表。
             */
            <div className="card-grid">
              {recommendPlaylists.map((pl) => (
                <div
                  className="playlist-card"
                  key={pl.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => void openLeftPlaylist(pl)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void openLeftPlaylist(pl);
                    }
                  }}
                >
                  <div className="playlist-card-cv">
                    <Cover url={coverProxyUrl(pl.cover, proxyPort)} />
                    <span className="pl-play" aria-hidden="true">
                      <Play size={13} />
                    </span>
                  </div>
                  <strong>{pl.name}</strong>
                  <small>
                    {pl.track_count} 首 · {pl.creator || providerLabel(pl.provider)}
                  </small>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/*
        今日精选（设计稿最后一节）：**平台级推荐新歌**，匿名可取 ——
        未登录用户也该在首页看到"今天有什么可听的"。能力矩阵里没有这一节的平台整块不渲染。
      */}
      {caps.newSongs ? (
        <div className="mc-section">
          <div className="mc-section-head">
            <span className="music-card-title">今日精选</span>
            <span className="music-card-sub">
              {providerLabel(playbackSource)} · 为你挑选 {newSongs.length} 首
            </span>
            <div className="grow" />
            <Btn kind="bare" className="link-btn" disabled={loadingNewSongs} onClick={() => void loadRecommend()}>
              <RefreshCw size={12} /> {loadingNewSongs ? '刷新中…' : '换一批'}
            </Btn>
          </div>
          {newSongs.length === 0 ? (
            <Empty art sub="换一个平台，或登录账号同步更多内容。">
              {loadingNewSongs ? '加载中…' : '这个平台还没有歌曲'}
            </Empty>
          ) : (
            /*
             * 今日精选（设计稿 `.song-table`）：**带表头的曲目表**，不是裸列表。
             * 表头五列与设计稿同序：序号 / 歌曲 / 专辑 / 时长 / 操作。
             * 行仍复用 `SongRow`（搜索、历史、本地、队列都用它）—— 这里只在 `.song-table` 作用域内
             * 把行的列宽对齐表头，不改共享组件本身，避免牵连另外 6 个调用点。
             */
            <div className="song-table">
              <div className="song-head" aria-hidden="true">
                {/* 序号列表头留空（同歌单详情） */}
                <span />
                <span>歌曲</span>
                <span>专辑</span>
                <span>时长</span>
                <span />
              </div>
              <VirtualList
                items={newSongs}
                resetKey={`new-songs:${playbackSource}`}
                itemKey={(s, i) => `${songKey(s)}:${i}`}
                renderItem={(s, i) => {
                  const play = () => void playPlaylist(newSongs, { index: i });
                  return (
                    <SongRow
                      song={s}
                      cover={coverProxyUrl(s.cover, proxyPort)}
                      active={currentSong ? songKey(currentSong) === songKey(s) : false}
                      leading={<span className="song-index">{i + 1}</span>}
                      aside={<span className="song-album">{s.album || '—'}</span>}
                      onClick={play}
                      onPlay={play}
                    />
                  );
                }}
              />
            </div>
          )}
        </div>
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
      <div className="mc-section-head">
        <Btn kind="bare" className="music-btn out" ariaLabel="返回" onClick={back}>
          <ChevronLeft size={12} /> 返回
        </Btn>
        <span className="music-card-title">每日推荐</span>
        <span className="music-card-sub">{songs.length} 首</span>
        <div className="grow" />
        <Btn
          kind="bare"
          className="music-btn pri"
          disabled={songs.length === 0}
          onClick={() => void playPlaylist(songs)}
        >
          <Play size={12} /> 播放全部
        </Btn>
      </div>

      {loading ? (
        <Empty>加载每日推荐中…</Empty>
      ) : songs.length === 0 ? (
        <Empty art>暂无每日推荐（可能需要登录网易云）</Empty>
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
                meta={s.album ? `${s.artist} · ${s.album}` : s.artist}
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
