/**
 * 音乐模块 IPC 层 —— 封装 Rust `music/` 模块的 98 条 Tauri 命令。
 *
 * 与 `../ipc/index.ts`（翻译服务的 IPC）同源：`invoke` 走 Tauri 的 IPC 通道，
 * 参数/返回值与 Rust `#[tauri::command]` 的签名一一对应。这里只做类型化封装，
 * 不塞业务逻辑 —— 业务逻辑在 `store.ts` 的状态机里。
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  Album,
  Artist,
  ArtistDetail,
  CacheStats,
  CommentPage,
  LocalSongInfo,
  LoginInfo,
  Lyrics,
  Mv,
  PlayMode,
  Playlist,
  QrCheckResult,
  Song,
  SongUrlResult,
} from '@music/types';

// ------------------------------------------------------------------ 网易云

/** offset 为 0 起的偏移量（分页）；null 表示不分页（等价 offset=0） */
export const musicSearch = (keywords: string, limit?: number, offset?: number) =>
  invoke<Song[]>('music_search', { keywords, limit: limit ?? null, offset: offset ?? null });

export const musicSongUrl = (id: string, quality?: string) =>
  invoke<SongUrlResult>('music_song_url', { id, quality: quality ?? null });

export const musicLoginQrKey = () => invoke<string>('music_login_qr_key');

export const musicLoginQrCreate = (key: string) => invoke<string>('music_login_qr_create', { key });

export const musicLoginQrCheck = (key: string) => invoke<QrCheckResult>('music_login_qr_check', { key });

export const musicLoginStatus = () => invoke<LoginInfo>('music_login_status');

export const musicLoginCookie = (cookie: string) => invoke<LoginInfo>('music_login_cookie', { cookie });

export const musicLogout = () => invoke<void>('music_logout');

export const musicUserPlaylist = () => invoke<Playlist[]>('music_user_playlist');

export const musicPlaylistTracks = (id: string) => invoke<[Playlist, Song[]]>('music_playlist_tracks', { id });

export const musicPlaylistTracksRange = (id: string, start: number, count: number) =>
  invoke<Song[]>('music_playlist_tracks_range', { id, start, count });

export const musicPlaylistInfoWithTrackIds = (id: string) =>
  invoke<[Playlist, string[]]>('music_playlist_info_with_track_ids', { id });

export const musicPlaylistDetail = (id: string) => invoke<Playlist>('music_playlist_detail', { id });

export const musicLikelist = () => invoke<string[]>('music_likelist');

export const musicLike = (id: string, like: boolean) => invoke<void>('music_like', { id, like });

export const musicPlaylistSubscribe = (id: string, subscribe: boolean) =>
  invoke<void>('music_playlist_subscribe', { id, subscribe });

export const musicLyric = (id: string) => invoke<Lyrics>('music_lyric', { id });

export const musicSongComments = (id: string, page?: number, pageSize?: number) =>
  invoke<CommentPage>('music_song_comments', { id, page: page ?? null, page_size: pageSize ?? null });

export const musicSendComment = (id: string, content: string) => invoke<void>('music_send_comment', { id, content });

export const musicPersonalized = () => invoke<Playlist[]>('music_personalized');

export const musicRecommendSongs = () => invoke<Song[]>('music_recommend_songs');

/** 推荐新歌（首页「今日精选」）：平台级新歌池，匿名可取 */
export const musicNewSongs = (limit = 20) => invoke<Song[]>('music_new_songs', { limit });

export const musicRecommendResource = () => invoke<Playlist[]>('music_recommend_resource');

export const musicSimiSong = (id: string, limit?: number) =>
  invoke<Song[]>('music_simi_song', { id, limit: limit ?? null });

/** 智能播放（心动模式官方接口，单次 ~149 条，需登录） */
export const musicIntelligenceList = (id: string) => invoke<Song[]>('music_intelligence_list', { id });

export const musicArtistSearch = (keywords: string, limit?: number) =>
  invoke<Artist[]>('music_artist_search', { keywords, limit: limit ?? null });

export const musicPlaylistSearch = (keywords: string, limit?: number) =>
  invoke<Playlist[]>('music_playlist_search', { keywords, limit: limit ?? null });

export const musicArtistSongs = (artistId: string, limit?: number, offset?: number) =>
  invoke<Song[]>('music_artist_songs', { artist_id: artistId, limit: limit ?? null, offset: offset ?? null });

export const musicArtistDetail = (artistId: string) =>
  invoke<ArtistDetail>('music_artist_detail', { artist_id: artistId });

export const musicArtistAlbums = (artistId: string, limit?: number, offset?: number) =>
  invoke<Album[]>('music_artist_albums', { artist_id: artistId, limit: limit ?? null, offset: offset ?? null });

export const musicArtistMvs = (artistId: string, limit?: number, offset?: number) =>
  invoke<Mv[]>('music_artist_mvs', { artist_id: artistId, limit: limit ?? null, offset: offset ?? null });

export const musicAlbumDetail = (albumId: string) =>
  invoke<[Album, Song[]]>('music_album_detail', { album_id: albumId });

export const musicMvUrl = (mvId: string, resolution?: number) =>
  invoke<string>('music_mv_url', { mv_id: mvId, resolution: resolution ?? null });

// ------------------------------------------------------------------ 酷狗

export const kugouSearch = (keywords: string, limit?: number, offset?: number) =>
  invoke<Song[]>('kugou_search', { keywords, limit: limit ?? null, offset: offset ?? null });

export const kugouArtistSearch = (keywords: string, limit?: number) =>
  invoke<Artist[]>('kugou_artist_search', { keywords, limit: limit ?? null });

export const kugouPlaylistSearch = (keywords: string, limit?: number) =>
  invoke<Playlist[]>('kugou_playlist_search', { keywords, limit: limit ?? null });

export const kugouArtistSongs = (artistId: string, limit?: number, offset?: number) =>
  invoke<Song[]>('kugou_artist_songs', { artist_id: artistId, limit: limit ?? null, offset: offset ?? null });

export const kugouSongUrl = (
  hash: string,
  albumId?: string,
  albumAudioId?: string,
  quality?: string,
  hqHash?: string,
  sqHash?: string,
  resHash?: string,
) =>
  invoke<SongUrlResult>('kugou_song_url', {
    hash,
    album_id: albumId ?? null,
    album_audio_id: albumAudioId ?? null,
    quality: quality ?? null,
    hq_hash: hqHash ?? null,
    sq_hash: sqHash ?? null,
    res_hash: resHash ?? null,
  });

export const kugouLyric = (hash: string, albumAudioId?: string, duration?: number) =>
  invoke<Lyrics>('kugou_lyric', { hash, album_audio_id: albumAudioId ?? null, duration: duration ?? null });

export const kugouLoginStatus = () => invoke<LoginInfo>('kugou_login_status');

export const kugouLoginCookie = (cookie: string) => invoke<LoginInfo>('kugou_login_cookie', { cookie });

export const kugouLogout = () => invoke<void>('kugou_logout');

export const kugouUserPlaylists = () => invoke<Playlist[]>('kugou_user_playlists');

export const kugouPlaylistTracks = (id: string) => invoke<[Playlist, Song[]]>('kugou_playlist_tracks', { id });

export const kugouPlaylistTracksRange = (id: string, start: number, count: number) =>
  invoke<Song[]>('kugou_playlist_tracks_range', { id, start, count });

export const kugouGuessLike = (limit?: number) => invoke<Song[]>('kugou_guess_like', { limit: limit ?? null });

export const kugouRankList = () => invoke<Playlist[]>('kugou_rank_list');

export const kugouRankSongs = (rankId: string, limit?: number) =>
  invoke<Song[]>('kugou_rank_songs', { rank_id: rankId, limit: limit ?? null });

export const kugouLikeToggle = (song: Song, like: boolean) => invoke<boolean>('kugou_like_toggle', { song, like });

export const kugouLikedHashes = () => invoke<string[]>('kugou_liked_hashes');

// ------------------------------------------------------------------ QQ 音乐

export const qqSearch = (keywords: string, limit?: number, offset?: number) =>
  invoke<Song[]>('qq_search', { keywords, limit: limit ?? null, offset: offset ?? null });

export const qqSongUrl = (mid: string, mediaMid?: string, quality?: string) =>
  invoke<SongUrlResult>('qq_song_url', { mid, media_mid: mediaMid ?? null, quality: quality ?? null });

export const qqLyric = (mid: string, id?: string) => invoke<Lyrics>('qq_lyric', { mid, id: id ?? null });

export const qqLoginStatus = () => invoke<LoginInfo>('qq_login_status');

export const qqLoginCookie = (cookie: string) => invoke<LoginInfo>('qq_login_cookie', { cookie });

export const qqLogout = () => invoke<void>('qq_logout');

export const qqUserPlaylists = () => invoke<Playlist[]>('qq_user_playlists');

export const qqPlaylistTracks = (id: string) => invoke<[Playlist, Song[]]>('qq_playlist_tracks', { id });

export const qqPlaylistTracksRange = (id: string, start: number, count: number) =>
  invoke<Song[]>('qq_playlist_tracks_range', { id, start, count });

export const qqArtistSearch = (keywords: string, limit?: number) =>
  invoke<Artist[]>('qq_artist_search', { keywords, limit: limit ?? null });

export const qqArtistSongs = (artistId: string, limit?: number, offset?: number) =>
  invoke<Song[]>('qq_artist_songs', { artist_id: artistId, limit: limit ?? null, offset: offset ?? null });

export const qqPlaylistSearch = (keywords: string, limit?: number) =>
  invoke<Playlist[]>('qq_playlist_search', { keywords, limit: limit ?? null });

export const qqRankList = () => invoke<Playlist[]>('qq_rank_list');

export const qqRankSongs = (rankId: string, limit?: number) =>
  invoke<Song[]>('qq_rank_songs', { rank_id: rankId, limit: limit ?? null });

export const qqRecommendPlaylists = () => invoke<Playlist[]>('music_qq_recommend_playlists');

export const qqLikedHashes = () => invoke<string[]>('qq_liked_hashes');

export const qqLikeToggle = (song: Song, like: boolean) => invoke<boolean>('qq_like_toggle', { song, like });

// ------------------------------------------------------------------ 咪咕

export const miguSearch = (keywords: string, limit?: number, offset?: number) =>
  invoke<Song[]>('migu_search', { keywords, limit: limit ?? null, offset: offset ?? null });

export const miguPlaylistSearch = (keywords: string, limit?: number) =>
  invoke<Playlist[]>('migu_playlist_search', { keywords, limit: limit ?? null });

export const miguArtistSearch = (keywords: string, limit?: number) =>
  invoke<Artist[]>('migu_artist_search', { keywords, limit: limit ?? null });

export const miguArtistSongs = (artistName: string, limit?: number, offset?: number) =>
  invoke<Song[]>('migu_artist_songs', { artist_name: artistName, limit: limit ?? null, offset: offset ?? null });

export const miguSongUrl = (contentId: string, copyrightId: string, quality?: string) =>
  invoke<SongUrlResult>('migu_song_url', {
    content_id: contentId,
    copyright_id: copyrightId,
    quality: quality ?? null,
  });

export const miguLyric = (contentId: string, copyrightId: string) =>
  invoke<Lyrics>('migu_lyric', { content_id: contentId, copyright_id: copyrightId });

export const miguLoginStatus = () => invoke<LoginInfo>('migu_login_status');

export const miguLogout = () => invoke<void>('migu_logout');

export const miguUserPlaylists = () => invoke<Playlist[]>('migu_user_playlists');

export const miguPlaylistTracks = (id: string) => invoke<[Playlist, Song[]]>('migu_playlist_tracks', { id });

export const miguPlaylistTracksRange = (id: string, start: number, count: number) =>
  invoke<Song[]>('migu_playlist_tracks_range', { id, start, count });

export const miguRankList = () => invoke<Playlist[]>('migu_rank_list');

export const miguRankSongs = (rankId: string, limit?: number) =>
  invoke<Song[]>('migu_rank_songs', { rank_id: rankId, limit: limit ?? null });

export const miguRecommendPlaylists = () => invoke<Playlist[]>('migu_recommend_playlists');

// ------------------------------------------------------------------ 多平台管理

export const musicGetLoginStatuses = () => invoke<Record<string, LoginInfo>>('music_get_login_statuses');

export const musicSwitchProvider = (provider: string) => invoke<void>('music_switch_provider', { provider });

export const musicGetPlaybackSource = () => invoke<string>('music_get_playback_source');

export const musicOpenLoginWindow = (provider: string) => invoke<string>('music_open_login_window', { provider });

// ------------------------------------------------------------------ 本地音乐

export const getMusicFiles = () => invoke<{ name: string; path: string }[]>('get_music_files');

export const importLocalMusic = (paths: string[]) => invoke<LocalSongInfo[]>('import_local_music', { paths });

export const importLocalMusicFolder = (folder: string) =>
  invoke<LocalSongInfo[]>('import_local_music_folder', { folder });

export const getLocalLyric = (path: string) => invoke<string>('get_local_lyric', { path });

export const verifyLocalCovers = (songs: { id: string; path: string; cover_path: string }[]) =>
  invoke<{ id: string; cover_path: string; cover_source: string }[]>('verify_local_covers', { songs });

export const deleteCoverCacheFiles = (paths: string[]) => invoke<void>('delete_cover_cache_files', { paths });

// ------------------------------------------------------------------ 桌面歌词窗口

/**
 * 主窗 → 歌词窗的推送载荷（**跨窗口冻结契约**）。
 *
 * ## 为什么类型定义在这里而不是歌词窗那边
 *
 * 歌词窗（`screens/lyrics/`）是**已完成的独立窗口**，本轮只消费、不改它；
 * 而这一层是"主窗发出侧"的唯一出口，类型与 `invoke` 写在一起才读得懂
 * 「这条命令到底带什么」。两侧字段名必须逐字一致 —— 改名等于两个窗口讲两种话，
 * 症状是「推了但什么都不显示」，且极难查。
 */
export interface LyricsPushLine {
  /** 该行的**起始**毫秒（不是结束），升序 */
  ms: number;
  text: string;
}

/**
 * 桌面歌词的**独立**偏好（与展开播放器的 `lyricsFontSize` / `lyricsHighlightColor`
 * 分开存、分开调；理由见 player-options 的 DL_* 段）。
 *
 * 为什么要跟着推送一起过去、而不是只靠 localStorage：
 * 两个窗口虽然共享同一份 `miaodock.music.prefs`（台账 D-47），但**同 origin 的不同
 * WebView 之间 `storage` 事件不保证触发**（WKWebView 已知差异）—— 靠它做实时同步
 * 会得到"有时生效有时不生效"的幽灵行为。所以实时生效走事件通道，localStorage
 * 只负责**新开的窗口首屏**拿到值。
 */
export interface DesktopLyricsPrefs {
  /** 当前（高亮）行字号，px */
  fontSize: number;
  /** 当前行颜色 */
  highlightColor: string;
  /** 其余（未高亮）行颜色 */
  baseColor: string;
  /** 一次显示几行（含当前行，当前行在最下方） */
  lineCount: number;
}

export interface LyricsPushPayload {
  /** null = 无当前歌曲（**必须推**，否则歌词窗会一直显示上一首） */
  songId: string | null;
  songName: string;
  artist: string;
  /** 已解析歌词行；空数组 = 无歌词 */
  lines: LyricsPushLine[];
  playing: boolean;
  /**
   * 推送时的播放进度（毫秒）。歌词窗以它为基准 + 本地计时自己往前走，
   * 之后不再指望主窗推进度（`timeupdate` 每秒数次，事件扛不住这个频率）。
   */
  startedAtMs: number;
  durationMs: number;
  /** 推送时的墙上时钟（`Date.now()`），供歌词窗校正两窗时钟漂移 */
  sentAtEpoch: number;
  /**
   * 当前播放模式。
   *
   * 为什么必须推：歌词窗的控制栏要显示**正确的模式图标**（列表循环 / 单曲 / 随机 / 心动），
   * 而两个窗口的 store 互不可见（独立 WebView）—— 不推的话图标永远停在初始值，
   * 用户在主窗切了模式，歌词窗上还是旧的，看起来像"点不动"。
   */
  playMode: PlayMode;
  /** 桌面歌词的当前偏好（每次完整推送都带上，新开的窗口首帧就拿到正确外观） */
  desktopLyrics: DesktopLyricsPrefs;
}

/**
 * 「只带偏好」的轻量推送 —— 用户拖字号滑杆 / 换颜色时走这条。
 *
 * ## 为什么必须单独一条，而不是复用 `LyricsPushPayload`
 *
 * 拖一次滑杆会在一次拖动里触发几十次 `onChange`。若每次都发完整载荷，就得把
 * **整首歌词行**（几十到一两百行）重新序列化一遍跨进程送过去 —— 正是 store 里
 * `setProgress` 注释警告的那种"事件通道被打爆"的打法，只是换了个触发点。
 * 偏好推送只带 4 个字段，代价恒定。
 *
 * ## 为什么能和完整载荷共用同一个事件
 *
 * Rust 侧 `lyrics_push` 收的是 `serde_json::Value` 并原样 emit（见 lyrics_window.rs），
 * 不解析结构，所以多一种载荷形状**不需要改 Rust**。两侧靠 `prefsOnly` 这个
 * 判别字段区分（见协议处理处 `isPrefsOnly`）—— 名字必须与歌词窗逐字一致。
 */
export interface LyricsPrefsPayload {
  /** 判别字段：true 表示这条只带偏好、不含歌词行与进度 */
  prefsOnly: true;
  desktopLyrics: DesktopLyricsPrefs;
}

/**
 * 歌词窗 → 主窗：控制播放的指令。
 *
 * ## 为什么需要一条反方向的通道
 *
 * 两个窗口是**独立的 WebView**，JS 堆互不可见 —— 歌词窗里的 store 是另一个实例
 *（只有 localStorage 共享，那是磁盘态）。所以歌词窗控制栏上的「下一首」按不动主窗的歌，
 * 必须发一条指令让主窗执行。Rust 只做转发（`lyrics://control`），不解析载荷。
 *
 * ## 动作表为什么是这几个
 * 对齐参考实现的控制栏构成：上一句 / 播放暂停 / 下一句 / 播放模式 / 音量。
 * 「上一句/下一句」在歌词语境下就是**切上一首/下一首**（参考实现同此义）。
 * 锁定与关闭不走这里 —— 它们只影响歌词窗自身，本地就能处理。
 */
export interface LyricsControlPayload {
  action: 'toggle-play' | 'prev' | 'next' | 'cycle-mode' | 'volume';
  /** 仅 `volume` 用：0..1 */
  value?: number;
}

/**
 * 平台事实（Rust `desktop_platform` 是唯一出处，见该命令的注释）。
 *
 * 为什么不用 UA 判：UA 会撒谎（Edge/WebView2 的 UA 字符串不保证含平台词），
 * 而这里要拿它做**能力裁决**（桌面歌词窗提不提供），判错的代价是"留着入口但不符合预期"。
 */
export type DesktopPlatform = 'windows' | 'macos' | 'linux';
export const fetchDesktopPlatform = () => invoke<DesktopPlatform>('desktop_platform');

/** 打开桌面歌词窗口；已存在则聚焦（幂等） */
export const openLyricsWindow = () => invoke<void>('open_lyrics_window');
/** 关闭桌面歌词窗口；不存在时静默成功（幂等） */
export const closeLyricsWindow = () => invoke<void>('close_lyrics_window');

/** 桌面歌词窗当前是否开着（只答"开没开"，不含锁定态） */
export const lyricsWindowOpen = () => invoke<boolean>('lyrics_window_open');

/**
 * 主窗 → 歌词窗推状态。两种载荷共用这一条命令与 `lyrics://state` 事件：
 * 完整载荷（`LyricsPushPayload`）与只带偏好的轻量载荷（`LyricsPrefsPayload`）。
 * 窗口不存在时 Rust 侧静默成功，不报错。
 */
export const lyricsPush = (payload: LyricsPushPayload | LyricsPrefsPayload) => invoke<void>('lyrics_push', { payload });

/**
 * 歌词窗挂载后**主动补拉**最后一次状态（Rust 侧缓存的那份）。
 *
 * 解决的是「刚打开桌面歌词没歌词、暂停再播放才正常」：主窗建窗后立刻推送，
 * 而那一刻歌词窗的 `listen` 还没注册，事件必然丢失（Rust 侧事件不缓存、不回放）。
 * 返回 `null` = 主窗还没推过任何东西（先开窗口后播歌），此时等事件即可。
 */
export const getLyricsState = () => invoke<LyricsPushPayload | LyricsPrefsPayload | null>('get_lyrics_state');

/** 歌词窗 → 主窗：发一条播放控制指令（Rust 转发 `lyrics://control`） */
export const lyricsControl = (payload: LyricsControlPayload) => invoke<void>('lyrics_control', { payload });

// ------------------------------------------------------------------ 音频代理

/** 获取音频代理端口（未启动则启动），返回 127.0.0.1 上的监听端口 */
export const getProxyPort = () => invoke<number>('cmd_get_proxy_port');

// ------------------------------------------------------------------ 音乐缓存

/**
 * 查本地是否已有**整首**音频缓存。
 *
 * 命中返回**绝对路径**，未命中返回 `null`。
 *
 * ## 为什么是 `string | null` 而不是抛错
 *
 * `null` 同时覆盖「没缓存」与「缓存不可用」（磁盘满 / 权限不足 / 目录被清）。
 * 这两种情况下调用方的正确反应**完全相同** —— 走原来的代理路径在线播。
 * 缓存是优化，它坏掉不该让用户看到一个错误弹窗。
 *
 * ## ⚠️ `quality` 必须传 `state.playbackQuality`，不能传 `SongUrlResult.quality`
 *
 * 查缓存发生在 `songUrl()` **之前**，那一刻只有「用户请求的档位」已知。
 * 而四个平台返回的 `quality` / `level` **既不同名也不同值域**：
 * 网易云的 `quality` 是中文 label（`高清臻音`）、QQ 是英文 label（`Hi-Res FLAC`）、
 * 咪咕的 `level` 干脆是 `PQ`/`HQ`/`SQ`/`ZQ` 这种音质等级而非档位名。
 * 拿它们当 key 会导致同一首歌每次算出的 key 都不同 ⇒ **缓存永不命中**，
 * 且全程不报错（用户只会觉得"缓存好像没起作用"）。
 *
 * 空 `quality` 会被 Rust 侧判为「无法寻址」→ 永远不命中，这是**刻意**的：
 * 宁可不下缓存，也不能猜错音质（猜错＝用户以为在听高音质，实际是标准音质）。
 */
export const musicAudioCached = (provider: string, id: string, quality: string) =>
  invoke<string | null>('music_audio_cached', { provider, id, quality });

/**
 * 整首下载落盘（用于后台预热）。成功返回绝对路径，**任何失败返回 `null`**。
 *
 * ## 调用纪律：绝不能 await 它
 *
 * 它是**后台优化**，不是播放的前置条件。必须在拿到播放地址之后
 * 以 `void ... .catch(() => {})` 的形式 fire-and-forget：
 * 一旦 `await`，慢网下整首歌要等几十秒才响 —— 而下载失败若被 `throw` 到
 * 播放链路上，用户会看到"播放失败"并被自动跳到下一首，
 * 症状是「网络不好的时候歌放不出来」，而根因只是个可有可无的缓存。
 *
 * `url` 传**源站真实地址**（`SongUrlResult.url`），不是代理地址 ——
 * Rust 侧自己带 UA/Referer 直连源站。
 */
export const musicCacheDownload = (provider: string, id: string, quality: string, url: string) =>
  invoke<string | null>('music_cache_download', { provider, id, quality, url });

/**
 * 缓存统计（只读，不触发清理）。
 *
 * 给设置页「音乐缓存」用：显示占用、按平台下拉清除、打开缓存目录。
 * ⚠️ 容量上限（`limit_lyric` / `limit_audio`）由 Rust 给出，
 * **不要在前端写死 100MB / 1GB** —— 改了 Rust 那边就会与显示不符。
 */
export const musicCacheStats = () => invoke<CacheStats>('music_cache_stats');

/**
 * 清缓存。`provider` 为空 ⇒ 全平台清。
 *
 * ⚠️ Rust 侧返回 `()` 而不是 `Result`：清缓存失败对用户没有可执行的下一步，
 * 弹错误框只会让人困惑；且它只删**目录内容**、保留目录本身，
 * 所以清完之后「打开缓存目录」按钮依然可用（不会变成"刚做完的操作把自己的按钮弄坏"）。
 */
export const musicCacheClear = (provider?: string) => invoke<void>('music_cache_clear', { provider: provider ?? null });
