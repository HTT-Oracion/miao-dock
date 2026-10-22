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
import * as ipc from '@music/ipc';
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
} from '@music/types';

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
  /** 平台级推荐新歌（首页「今日精选」的数据面） */
  newSongs: boolean;
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
    newSongs: true,
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
    newSongs: false,
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
    newSongs: false,
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
    newSongs: false,
    comments: false,
    likeWrite: false,
    artistExtra: false,
  },
};

export function capsOf(p: MusicProvider): PlatformCaps {
  return PLATFORM_CAPS[p] ?? PLATFORM_CAPS.netease;
}

// ------------------------------------------------------------------ 搜索

/**
 * 各平台搜索接口的**单页上限** —— 取 Rust 侧各自 clamp 之后的真实生效值。
 *
 * 为什么需要这张表：判断「还有没有下一页」只能靠「本页是否被填满」，
 * 而四个平台的上限并不一样（酷狗 20 / 咪咕 50）。若统一按 30 判，
 * 酷狗会被误判成「已到底」而提前停止分页。
 * Rust 侧对应位置：`kugou.rs limit.clamp(1,20)` / `qqmusic.rs clamp(1,30)` /
 * `migu.rs clamp(1,50)` / 网易云不 clamp（沿用调用方给的 limit）。
 */
export const SEARCH_PAGE_SIZE: Record<MusicProvider, number> = {
  netease: 30,
  kugou: 20,
  qqmusic: 30,
  migu: 50,
};

export function searchPageSize(p: MusicProvider): number {
  return SEARCH_PAGE_SIZE[p] ?? 30;
}

/** offset 为 0 起的偏移量（分页） */
export function search(provider: MusicProvider, keywords: string, limit = 30, offset = 0): Promise<Song[]> {
  switch (provider) {
    case 'kugou':
      return ipc.kugouSearch(keywords, limit, offset);
    case 'qqmusic':
      return ipc.qqSearch(keywords, limit, offset);
    case 'migu':
      return ipc.miguSearch(keywords, limit, offset);
    default:
      return ipc.musicSearch(keywords, limit, offset);
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

/**
 * 推荐新歌（首页「今日精选」）：平台级新歌池，**不需要登录**。
 *
 * 与 `dailySongs` 的分工：那个是"按你口味的每日推荐"（要 cookie、一天一份）；
 * 这个是"平台今天有什么新的"（匿名可取）—— 首页要的是后者，未登录用户也该看到内容。
 * 目前只有网易云提供（其余平台能力矩阵里 `newSongs: false`，界面上不出现这一节）。
 */
export function newSongs(provider: MusicProvider, limit = 20): Promise<Song[]> {
  if (provider === 'netease') return ipc.musicNewSongs(limit);
  return Promise.resolve([]);
}

/**
 * 相似歌曲（心动模式的续播来源）。
 *
 * **仅网易云可得**：它有"传入 songid 返回相似歌曲"的接口；酷狗的 `guess_like`
 * 是"全站个人 FM"、**不接收 songid**；QQ / 咪咕无对应接口。所以其余平台返回
 * 空数组，由调用方**降级为随机**（见 `cycleMode` / `canUseHeartbeat`）。
 *
 * ⚠️ 不要用「同歌手 / 同歌单 / 每日推荐」冒充"相似" —— 那是歌手循环或歌单循环，
 * 语义完全不同，用户点开就知道不对。
 *
 * 网易云内部走**主路 + 回落**两条（实测 2026-10-12，见 `netease::intelligence_list`）：
 *   ① `playmode/intelligence/list`（智能播放）—— 单次 ~149 条，是客户端"心动模式"
 *      真正用的接口；但**要求登录**，且 `pid` 只能是「我喜欢的音乐」；
 *   ② `simiSong` —— 单次**硬顶 5 条**，但不需要登录。
 * ① 报错或返回空（冷门歌 / 未登录 / 歌单定位失败）时回落 ②，
 * 两条都空才算"没有相似歌曲"，由调用方提示用户。
 */
export async function similarSongs(provider: MusicProvider, songId: string, limit = 20): Promise<Song[]> {
  if (provider !== 'netease') return Promise.resolve([]);
  try {
    const smart = await ipc.musicIntelligenceList(songId);
    if (smart.length > 0) return smart;
  } catch {
    // 落 simi_song：智能播放失败（未登录 / 上游 4xx-5xx）时，
    // simi_song 仍然是可用的（它不需要登录），不要在这里把错误抛给调用方。
  }
  return ipc.musicSimiSong(songId, limit);
}

/** 该平台是否支持"按歌曲取相似"（UI 据此提示用户，不做无声降级） */
export function supportsSimilar(provider: MusicProvider): boolean {
  return provider === 'netease';
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
      // 酷狗歌词接口的 duration 参数是**秒**，而 Song.duration 是毫秒 → 这里换算
      return ipc.kugouLyric(song.hash ?? song.id, song.album_audio_id, Math.round(song.duration / 1000));
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

export function artistSongs(provider: MusicProvider, artistId: string, limit = 50, offset = 0): Promise<Song[]> {
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
