import { useEffect } from 'react';
import { ArrowLeft, Heart, Play, Plus } from 'lucide-react';
import { useMusicStore } from '@music/store';
import { coverProxyUrl, songKey } from '@music/convert';
import { Btn, Empty, OverlayScrollbar, VirtualList } from '@components/units';
import { useOverlayScrollbar } from '@hooks/useOverlayScrollbar';
import { Cover, SongRow } from '@screens/music/shared';

/**
 * 右侧「歌单详情」（设计稿 `renderPlaylistDetail()`）。
 *
 * 设计稿里**点左栏歌单 → 右侧整块换成这个歌单**，左栏保持原样（页签不动）。
 * 产品此前是"在左栏里下钻"：左栏整块被曲目列表占掉、右侧还是首页 —— 用户点了一下，
 * 屏幕上**两个**区域同时变了，且左栏再也回不到歌单列表（除了一个"返回"）。
 *
 * 结构照设计稿四段：
 *   ① `.pd-top`：返回 + 类型 chip + 右侧更多；
 *   ② `.pd-hero`：封面 + kicker + 标题 + 描述 + meta（作者 / N 首 / 创建时间）+ 三个动作；
 *   ③ `.pd-toolbar`：一句"按推荐顺序 · 共 N 首"；
 *   ④ `.song-table`：曲目表（复用共享 SongRow）。
 *
 * ## 分页（#14）
 * 曲目表**分页加载**（一页 PAGE_SIZE 首，滚到底再拉下一页），不是一次拉全量 ——
 * 千首级别的歌单一次拉完会让首屏等好几秒。`loadMoreLeft` 已按歌单 id 分页，
 * 这里只负责在滚到底时调它。
 */
export function PlaylistDetail() {
  const meta = useMusicStore((s) => s.leftPlaylistMeta);
  const tracks = useMusicStore((s) => s.leftPlaylistTracks);
  const loading = useMusicStore((s) => s.loadingLeftTracks);
  const loadingMore = useMusicStore((s) => s.loadingMoreLeft);
  const error = useMusicStore((s) => s.leftTracksError);
  const back = useMusicStore((s) => s.backToPlaylists);
  const playPlaylist = useMusicStore((s) => s.playPlaylist);
  const appendToQueue = useMusicStore((s) => s.appendToQueue);
  const currentSong = useMusicStore((s) => s.currentSong);
  const proxyPort = useMusicStore((s) => s.proxyPort);
  const loadMoreLeft = useMusicStore((s) => s.loadMoreLeft);

  const name = meta?.name ?? '歌单';
  const total = meta?.track_count ?? tracks.length;
  const hasMore = tracks.length < total;

  /*
   * 曲目表自己的滚动容器：**占满剩余高度**，只有内容超出时才滚（#14）。
   * 滚动条是覆盖式的（`useOverlayScrollbar`）—— 不占布局宽度。
   */
  const { ref: scrollRef, thumb } = useOverlayScrollbar();

  /* 滚到底拉下一页（距底 120px 就开始，免得用户"看到底了才动"） */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !hasMore) return;
    const onScroll = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) void loadMoreLeft();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef, hasMore, loadMoreLeft, tracks.length]);

  return (
    <>
      <div className="pd-top">
        <Btn kind="bare" className="pd-back" onClick={back}>
          <ArrowLeft size={12} /> 返回
        </Btn>
        <span className="chip">{meta?.isLiked ? '系统歌单' : '歌单'}</span>
        {/*
         * 「更多」按钮**暂不显示**：设计稿 `.pd-top` 右侧那枚 `playlist-more`
         * 打开的是歌单操作菜单（重命名 / 删除 / 分享），而产品侧这些动作
         * 还没有实现 —— 摆一个点了没反应的按钮，比不放更糟。
         * 动作齐了再把这段连同 IconButton 的导入一起放回来。
         */}
      </div>

      <section className="pd-hero">
        <div className="pd-cover">
          <Cover url={coverProxyUrl(meta?.cover ?? '', proxyPort)} />
        </div>
        <div className="pd-info">
          <span className="kicker">{meta?.isLiked ? 'LIKED' : 'PLAYLIST'}</span>
          <h2>{name}</h2>
          {meta?.creator ? <p>{meta.creator}</p> : null}
          <div className="pd-meta">
            <span>{meta?.creator || '—'}</span>
            <span>{total} 首</span>
          </div>
          <div className="pd-actions">
            <Btn
              kind="primary"
              disabled={tracks.length === 0}
              onClick={() => void playPlaylist(tracks, { playlist: meta ?? undefined })}
            >
              <Play size={12} /> 播放全部
            </Btn>
            {meta?.isLiked ? null : (
              <Btn kind="ghost">
                <Heart size={12} /> 收藏
              </Btn>
            )}
            <Btn kind="ghost" disabled={tracks.length === 0} onClick={() => appendToQueue(tracks)}>
              <Plus size={12} /> 全部加入队列
            </Btn>
          </div>
        </div>
      </section>

      <div className="pd-toolbar">
        <span className="caption">按推荐顺序 · 共 {total} 首</span>
      </div>

      {loading ? (
        <Empty>加载曲目中…</Empty>
      ) : error ? (
        <Empty bad sub={error}>
          曲目读取失败
        </Empty>
      ) : tracks.length === 0 ? (
        <Empty art sub="这张歌单里还没有曲目。">
          歌单是空的
        </Empty>
      ) : (
        <div className="song-table is-fill" ref={scrollRef}>
          <div className="song-head" aria-hidden="true">
            <span>#</span>
            <span>歌曲</span>
            <span>专辑</span>
            <span>时长</span>
            <span />
          </div>
          <VirtualList
            items={tracks}
            resetKey={`playlist:${meta?.id ?? ''}`}
            itemKey={(s, i) => `${songKey(s)}:${i}`}
            renderItem={(s, i) => {
              const play = () => void playPlaylist(tracks, { index: i, playlist: meta ?? undefined });
              return (
                <SongRow
                  song={s}
                  cover={coverProxyUrl(s.cover, proxyPort)}
                  active={currentSong ? songKey(currentSong) === songKey(s) : false}
                  leading={<span className="song-index">{i + 1}</span>}
                  /*
                   * 两处文字的分工照设计稿 `.song-table`：
                   *   标题下面那行 = **歌手**（SongRow 默认取 `song.artist`，不用 meta 覆盖）；
                   *   `aside` 那一列 = **专辑**（设计稿 `.song-album`，单独一列）。
                   * 曾经把歌手填进 meta、专辑整个丢掉 —— 于是"专辑没有回显"（#15），
                   * 而歌手又跑到专辑列上、标题底下空着（#17）。
                   */
                  aside={<span className="song-album">{s.album || '—'}</span>}
                  onClick={play}
                  onPlay={play}
                />
              );
            }}
          />
          {/* 分页脚：还有更多时给一个"再拉一页"的入口（不依赖滚动 —— 触屏/键盘也能用） */}
          {hasMore ? (
            <div className="song-table-more">
              <Btn
                kind="ghost"
                size="sm"
                disabled={loadingMore}
                onClick={() => (loadingMore ? undefined : void loadMoreLeft())}
              >
                {loadingMore ? '加载中…' : `加载更多（还有 ${total - tracks.length} 首）`}
              </Btn>
            </div>
          ) : (
            <div className="song-table-more is-end">已到底 · 共 {total} 首</div>
          )}
          <OverlayScrollbar thumb={thumb} />
        </div>
      )}
    </>
  );
}
