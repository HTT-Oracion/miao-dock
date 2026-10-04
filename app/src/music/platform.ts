/**
 * 音乐模块平台适配层 —— 四平台（网易云/酷狗/QQ/咪咕）的**能力矩阵**与**命令派发**。
 *
 * 为什么要独立一层：参考实现把「按平台选命令」的 switch 散落在 store 的十几个 action 里
 * （search / playlistTracks / rankList / lyric / likeToggle / loginStatus …），
 * 每加一个平台就要改十处、极易漏改。这里收敛成**一张能力表 + 一组派发函数**，
 * 平台差异只在这一个文件里表达，store 与 UI 一律面向统一接口。
 *
 * 汽水（qishui）按技术方案 PD-1 已延后（Windows-only 平台耦合 + 依赖仓库外二进制签名器），
 * 故不在此表内 —— 任何地方都不应出现它的分支。
 *
 * ⚠️ 参数名必须与 Rust `#[tauri::command]` 签名逐字对齐（Tauri v2 按参数名注入）：
 * 例如 kugou/qq/migu 的 song_url 是**字段展开**（hash / mid / content_id），不是 Song 对象。
 */
import * as ipc from './ipc';
import type {
  Album,
  Artist,
  ArtistDetail,
  Lyrics,
  LoginInfo,
  MusicProvider,
  Mv,
  Playlist,
  Song,
  SongUrlResult,
} from './types';

/** 便捷再导出：调用方从 platform 一处拿到平台类型与能力，不必再 import types */
export type { MusicProvider };

// ------------------------------------------------------------------ 元信息

export interface PlatformMeta {
  id: MusicProvider;
  /** 完整名称（顶行「当前平台：xx」、登录弹窗条目） */
  label: string;
  /** 单字标记（登录弹窗左侧色块、平台胶囊） */
  short: string;
  /** 品牌色，**仅用于来源标签圆点**，不属设计令牌、不参与主题切换 */
  color: string;
  /** 一句话介绍（登录弹窗） */
  desc: string;
}

export const PLATFORMS: PlatformMeta[] = [
  { id: 'netease', label: '网易云音乐', short: '网', color: '#C20C0C', desc: '海量曲库 · 歌单 · 云村社区' },
  { id: 'kugou', label: '酷狗音乐', short: '酷', color: '#00A0E9', desc: '千万曲库 · 高品质音效' },
  { id: 'qqmusic', label: 'QQ 音乐', short: 'Q', color: '#FEC135', desc: '海量曲库 · Hi-Res · 精准推荐' },
  { id: 'migu', label: '咪咕音乐', short: '咪', color: '#FF69B4', desc: '华语曲库 · 臻品音质' },
];

export const PLATFORM_MAP: Record<MusicProvider, PlatformMeta> = PLATFORMS.reduce(
  (acc, p) => {
    acc[p.id] = p;
    return acc;
  },
  {} as Record<MusicProvider, PlatformMeta>,
);

/** 平台展示名（未知 provider 原样返回，不猜） */
export function providerLabel(p: string): string {
  return PLATFORM_MAP[p as MusicProvider]?.label ?? p;
}

/** 平台品牌色（未知返回中性灰） */
export function providerColor(p: string): string {
  return PLATFORM_MAP[p as MusicProvider]?.color ?? '#8B93A7';
}

/** provider → Song.provider 的取值集合（含 'local'），用于来源标签判定 */
export const LOCAL_PROVIDER = 'local';

// ------------------------------------------------------------------ 能力矩阵

/**
 * 平台能力矩阵 —— UI 据此决定「显示什么 / 隐藏什么」，不再散落 if(provider===...)。
 *
 * · charts         官方榜单（四平台都有）
 * · chartGrid      榜单以 3 列网格铺满（酷狗/QQ）；false 则横向滚动小卡片（网易云/咪咕）
 * · chartByName    榜单卡片不显示封面、直接把榜单名写在渐变卡上（咪咕无可用封面）
 * · recommendPlaylists 右栏「推荐歌单」列表（网易云 recommend_resource / 咪咕 migu_recommend_playlists）
 * · dailySongs     每日推荐歌曲（仅网易云）
 * · comments       展开播放器评论区（仅网易云）
 * · likeWrite      红心可写回（网易云/酷狗；QQ 只读、咪咕不支持）
 * · artistExtra    歌手详情的 专辑/MV/简介 三标签（仅网易云）
 */
export interface PlatformCaps {
  charts: boolean;
  chartGrid: boolean;
  chartByName: boolean;
  recommendPlaylists: boolean;
  dailySongs: boolean;
  comments: boolean;
  likeWrite: boolean;
  artistExtra: boolean;
}

export const PLATFORM_CAPS: Record<MusicProvider, PlatformCaps> = {
  netease: {
    charts: true,
    chartGrid: false,
    chartByName: false,
    recommendPlaylists: true,
    dailySongs: true,
    comments: true,
    likeWrite: true,
    artistExtra: true,
  },
  kugou: {
    charts: true,
    chartGrid: true,
    chartByName: false,
    recommendPlaylists: false,
    dailySongs: false,
    comments: false,
    likeWrite: true,
    artistExtra: false,
  },
  qqmusic: {
    charts: true,
    chartGrid: true,
    chartByName: false,
    recommendPlaylists: false,
    dailySongs: false,
    comments: false,
    likeWrite: false,
    artistExtra: false,
  },
  migu: {
    charts: true,
    chartGrid: false,
    chartByName: true,
    recommendPlaylists: true,
    dailySongs: false,
    comments: false,
    likeWrite: false,
    artistExtra: false,
  },
};

export function capsOf(p: MusicProvider): PlatformCaps {
  return PLATFORM_CAPS[p] ?? PLATFORM_CAPS.netease;
}

// ------------------------------------------------------------------ 搜索

export function search(provider: MusicProvider, keywords: string, limit = 30): Promise<Song[]> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouSearch(keywords, limit);
    case 'qqmusic':
      return ipc.qqSearch(keywords, limit);
    case 'migu':
      return ipc.miguSearch(keywords, limit);
    default:
      return ipc.musicSearch(keywords, limit);
  }
}

export function searchArtists(provider: MusicProvider, keywords: string, limit = 30): Promise<Artist[]> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouArtistSearch(keywords, limit);
    case 'qqmusic':
      return ipc.qqArtistSearch(keywords, limit);
    case 'migu':
      return ipc.miguArtistSearch(keywords, limit);
    default:
      return ipc.musicArtistSearch(keywords, limit);
  }
}

export function searchPlaylists(provider: MusicProvider, keywords: string, limit = 30): Promise<Playlist[]> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouPlaylistSearch(keywords, limit);
    case 'qqmusic':
      return ipc.qqPlaylistSearch(keywords, limit);
    case 'migu':
      return ipc.miguPlaylistSearch(keywords, limit);
    default:
      return ipc.musicPlaylistSearch(keywords, limit);
  }
}

// ------------------------------------------------------------------ 歌单曲目

export function playlistTracks(provider: MusicProvider, id: string): Promise<[Playlist, Song[]]> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouPlaylistTracks(id);
    case 'qqmusic':
      return ipc.qqPlaylistTracks(id);
    case 'migu':
      return ipc.miguPlaylistTracks(id);
    default:
      return ipc.musicPlaylistTracks(id);
  }
}

export function playlistTracksRange(
  provider: MusicProvider,
  id: string,
  start: number,
  count: number,
): Promise<Song[]> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouPlaylistTracksRange(id, start, count);
    case 'qqmusic':
      return ipc.qqPlaylistTracksRange(id, start, count);
    case 'migu':
      return ipc.miguPlaylistTracksRange(id, start, count);
    default:
      return ipc.musicPlaylistTracksRange(id, start, count);
  }
}

/** 歌单详情（榜单卡片点击进入曲目视图时补 meta；网易云有独立接口） */
export function playlistDetail(provider: MusicProvider, id: string): Promise<Playlist> {
  if (provider === 'netease') return ipc.musicPlaylistDetail(id);
  // 酷狗/QQ/咪咕没有独立「歌单详情」命令：榜单/歌单 meta 由列表接口本身返回
  return Promise.reject(new Error(`playlist_detail 不适用于 ${provider}`));
}

// ------------------------------------------------------------------ 榜单

export function rankList(provider: MusicProvider): Promise<Playlist[]> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouRankList();
    case 'qqmusic':
      return ipc.qqRankList();
    case 'migu':
      return ipc.miguRankList();
    default:
      // 网易云没有榜单列表接口：内部用硬编码榜单 ID + playlist_detail 拼出（见 store.loadCharts）
      return Promise.resolve([]);
  }
}

export function rankSongs(provider: MusicProvider, rankId: string, limit: number): Promise<Song[]> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouRankSongs(rankId, limit);
    case 'qqmusic':
      return ipc.qqRankSongs(rankId, limit);
    case 'migu':
      return ipc.miguRankSongs(rankId, limit);
    default:
      return Promise.reject(new Error(`rank_songs 不适用于 ${provider}`));
  }
}

/** 榜单点击走「榜单歌曲」还是「歌单歌曲」（参考实现：QQ/咪咕走榜单接口，其余走歌单接口） */
export function chartUsesRankSongs(provider: MusicProvider): boolean {
  return provider === 'qqmusic' || provider === 'migu';
}

// ------------------------------------------------------------------ 推荐

/** 推荐歌单（网易云 recommend_resource / 咪咕 migu_recommend_playlists；酷狗/QQ 无） */
export function recommendPlaylists(provider: MusicProvider): Promise<Playlist[]> {
  if (provider === 'migu') return ipc.miguRecommendPlaylists();
  if (provider === 'netease') return ipc.musicRecommendResource();
  return Promise.resolve([]);
}

/** 每日推荐歌曲（仅网易云） */
export function dailySongs(provider: MusicProvider): Promise<Song[]> {
  if (provider === 'netease') return ipc.musicRecommendSongs();
  return Promise.resolve([]);
}

// ------------------------------------------------------------------ 账号 / 登录

export function userPlaylists(provider: MusicProvider): Promise<Playlist[]> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouUserPlaylists();
    case 'qqmusic':
      return ipc.qqUserPlaylists();
    case 'migu':
      return ipc.miguUserPlaylists();
    default:
      return ipc.musicUserPlaylist();
  }
}

export function loginStatus(provider: MusicProvider): Promise<LoginInfo> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouLoginStatus();
    case 'qqmusic':
      return ipc.qqLoginStatus();
    case 'migu':
      return ipc.miguLoginStatus();
    default:
      return ipc.musicLoginStatus();
  }
}

export function loginWithCookie(provider: MusicProvider, cookie: string): Promise<LoginInfo> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouLoginCookie(cookie);
    case 'qqmusic':
      return ipc.qqLoginCookie(cookie);
    case 'migu':
      // 咪咕无 cookie 登录命令（走网页登录窗口回读）
      return Promise.reject(new Error('migu 不支持 cookie 登录'));
    default:
      return ipc.musicLoginCookie(cookie);
  }
}

export function logout(provider: MusicProvider): Promise<void> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouLogout();
    case 'qqmusic':
      return ipc.qqLogout();
    case 'migu':
      return ipc.miguLogout();
    default:
      return ipc.musicLogout();
  }
}

/** 打开官方网页登录窗口（四平台统一，登录后从窗口回读 Cookie） */
export function openLoginWindow(provider: MusicProvider): Promise<string> {
  return ipc.musicOpenLoginWindow(provider);
}

// ------------------------------------------------------------------ 红心

/** 已喜欢 id 集合（网易云 id / 酷狗 hash / QQ mid；咪咕不支持 → 空集） */
export function likedIds(provider: MusicProvider): Promise<string[]> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouLikedHashes();
    case 'qqmusic':
      return ipc.qqLikedHashes();
    default:
      // 咪咕不支持红心读取；网易云走 likelist
      return provider === 'migu' ? Promise.resolve([]) : ipc.musicLikelist();
  }
}

export function likeToggle(provider: MusicProvider, song: Song, like: boolean): Promise<boolean> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouLikeToggle(song, like);
    case 'qqmusic':
      return ipc.qqLikeToggle(song, like);
    default:
      // 网易云 like 命令返回空；统一成 boolean 给调用方一致的签名
      return ipc.musicLike(song.id, like).then(() => like);
  }
}

// ------------------------------------------------------------------ 歌词 / 播放地址

export function lyric(provider: MusicProvider, song: Song): Promise<Lyrics> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouLyric(song.hash ?? song.id, song.album_audio_id, song.duration);
    case 'qqmusic':
      return ipc.qqLyric(song.mid ?? song.id, song.id);
    case 'migu':
      return ipc.miguLyric(song.content_id ?? song.id, song.id);
    default:
      return ipc.musicLyric(song.id);
  }
}

export function songUrl(provider: MusicProvider, song: Song, quality: string): Promise<SongUrlResult> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouSongUrl(
        song.hash ?? song.id,
        song.album_id,
        song.album_audio_id,
        quality,
        song.hq_hash,
        song.sq_hash,
        song.res_hash,
      );
    case 'qqmusic':
      return ipc.qqSongUrl(song.mid ?? song.id, song.media_mid, quality);
    case 'migu':
      return ipc.miguSongUrl(song.content_id ?? song.id, song.id, quality);
    default:
      return ipc.musicSongUrl(song.id, quality);
  }
}

// ------------------------------------------------------------------ 歌手 / 专辑（仅网易云完整，其余仅热门歌曲）

export function artistSongs(
  provider: MusicProvider,
  artistId: string,
  limit = 50,
  offset = 0,
): Promise<Song[]> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouArtistSongs(artistId, limit, offset);
    case 'qqmusic':
      return ipc.qqArtistSongs(artistId, limit, offset);
    case 'migu':
      return ipc.miguArtistSongs(artistId, limit, offset);
    default:
      return ipc.musicArtistSongs(artistId, limit, offset);
  }
}

export function artistDetail(provider: MusicProvider, artistId: string): Promise<ArtistDetail> {
  if (provider !== 'netease') return Promise.reject(new Error(`artist_detail 仅网易云`));
  return ipc.musicArtistDetail(artistId);
}

export function artistAlbums(provider: MusicProvider, artistId: string, limit = 30, offset = 0): Promise<Album[]> {
  if (provider !== 'netease') return Promise.resolve([]);
  return ipc.musicArtistAlbums(artistId, limit, offset);
}

export function artistMvs(provider: MusicProvider, artistId: string, limit = 30, offset = 0): Promise<Mv[]> {
  if (provider !== 'netease') return Promise.resolve([]);
  return ipc.musicArtistMvs(artistId, limit, offset);
}
