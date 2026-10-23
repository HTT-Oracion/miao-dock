import { ArrowLeft, Heart, MoreHorizontal, Play, Plus } from 'lucide-react';
import { useMusicStore } from '@music/store';
import { coverProxyUrl, songKey } from '@music/convert';
import { Btn, Empty, IconButton, VirtualList } from '@components/units';
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
 */
export function PlaylistDetail() {
  const meta = useMusicStore((s) => s.leftPlaylistMeta);
  const tracks = useMusicStore((s) => s.leftPlaylistTracks);
  const loading = useMusicStore((s) => s.loadingLeftTracks);
  const error = useMusicStore((s) => s.leftTracksError);
  const back = useMusicStore((s) => s.backToPlaylists);
  const playPlaylist = useMusicStore((s) => s.playPlaylist);
  const appendToQueue = useMusicStore((s) => s.appendToQueue);
  const currentSong = useMusicStore((s) => s.currentSong);
  const proxyPort = useMusicStore((s) => s.proxyPort);

  const name = meta?.name ?? '歌单';
  const total = meta?.track_count ?? tracks.length;

  return (
    <>
      <div className="pd-top">
        <Btn kind="bare" className="pd-back" onClick={back}>
          <ArrowLeft size={12} /> 返回
        </Btn>
        <span className="chip">{meta?.isLiked ? '系统歌单' : '歌单'}</span>
        <IconButton title="更多">
          <MoreHorizontal size={14} />
        </IconButton>
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
        <div className="song-table">
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
                  meta={<span className="song-album">{s.album || '—'}</span>}
                  onClick={play}
                  onPlay={play}
                />
              );
            }}
          />
        </div>
      )}
    </>
  );
}
