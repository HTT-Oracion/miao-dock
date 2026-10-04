/**
 * 音乐模块 IPC 层 —— 封装 Rust `music/` 模块的 90 条 Tauri 命令。
 *
 * 与 `../ipc.ts`（翻译服务的 IPC）同源：`invoke` 走 Tauri 的 IPC 通道，
 * 参数/返回值与 Rust `#[tauri::command]` 的签名一一对应。这里只做类型化封装，
 * 不塞业务逻辑 —— 业务逻辑在 `store.ts` 的状态机里。
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  Album,
  Artist,
  ArtistDetail,
  CommentPage,
  LocalSongInfo,
  LoginInfo,
  Lyrics,
  Mv,
  Playlist,
  QrCheckResult,
  Song,
  SongUrlResult,
} from './types';

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

export const musicPlaylistTracks = (id: string) =>
  invoke<[Playlist, Song[]]>('music_playlist_tracks', { id });

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

export const musicSendComment = (id: string, content: string) =>
  invoke<void>('music_send_comment', { id, content });

export const musicPersonalized = () => invoke<Playlist[]>('music_personalized');

export const musicRecommendSongs = () => invoke<Song[]>('music_recommend_songs');

export const musicRecommendResource = () => invoke<Playlist[]>('music_recommend_resource');

export const musicSimiSong = (id: string, limit?: number) =>
  invoke<Song[]>('music_simi_song', { id, limit: limit ?? null });

export const musicArtistSearch = (keywords: string, limit?: number) =>
  invoke<Artist[]>('music_artist_search', { keywords, limit: limit ?? null });

export const musicPlaylistSearch = (keywords: string, limit?: number) =>
  invoke<Playlist[]>('music_playlist_search', { keywords, limit: limit ?? null });

export const musicArtistSongs = (artistId: string, limit?: number, offset?: number) =>
  invoke<Song[]>('music_artist_songs', { artist_id: artistId, limit: limit ?? null, offset: offset ?? null });

export const musicArtistDetail = (artistId: string) => invoke<ArtistDetail>('music_artist_detail', { artist_id: artistId });

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

export const kugouPlaylistTracks = (id: string) =>
  invoke<[Playlist, Song[]]>('kugou_playlist_tracks', { id });

export const kugouPlaylistTracksRange = (id: string, start: number, count: number) =>
  invoke<Song[]>('kugou_playlist_tracks_range', { id, start, count });

export const kugouGuessLike = (limit?: number) => invoke<Song[]>('kugou_guess_like', { limit: limit ?? null });

export const kugouRankList = () => invoke<Playlist[]>('kugou_rank_list');

export const kugouRankSongs = (rankId: string, limit?: number) =>
  invoke<Song[]>('kugou_rank_songs', { rank_id: rankId, limit: limit ?? null });

export const kugouLikeToggle = (song: Song, like: boolean) =>
  invoke<boolean>('kugou_like_toggle', { song, like });

export const kugouLikedHashes = () => invoke<string[]>('kugou_liked_hashes');

// ------------------------------------------------------------------ QQ 音乐

export const qqSearch = (keywords: string, limit?: number, offset?: number) =>
  invoke<Song[]>('qq_search', { keywords, limit: limit ?? null, offset: offset ?? null });

export const qqSongUrl = (mid: string, mediaMid?: string, quality?: string) =>
  invoke<SongUrlResult>('qq_song_url', { mid, media_mid: mediaMid ?? null, quality: quality ?? null });

export const qqLyric = (mid: string, id?: string) =>
  invoke<Lyrics>('qq_lyric', { mid, id: id ?? null });

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
  invoke<SongUrlResult>('migu_song_url', { content_id: contentId, copyright_id: copyrightId, quality: quality ?? null });

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

export const musicGetLoginStatuses = () =>
  invoke<Record<string, LoginInfo>>('music_get_login_statuses');

export const musicSwitchProvider = (provider: string) =>
  invoke<void>('music_switch_provider', { provider });

export const musicGetPlaybackSource = () => invoke<string>('music_get_playback_source');

export const musicOpenLoginWindow = (provider: string) =>
  invoke<string>('music_open_login_window', { provider });

// ------------------------------------------------------------------ 本地音乐

export const getMusicFiles = () => invoke<{ name: string; path: string }[]>('get_music_files');

export const importLocalMusic = (paths: string[]) => invoke<LocalSongInfo[]>('import_local_music', { paths });

export const importLocalMusicFolder = (folder: string) =>
  invoke<LocalSongInfo[]>('import_local_music_folder', { folder });

export const getLocalLyric = (path: string) => invoke<string>('get_local_lyric', { path });

export const verifyLocalCovers = (songs: { id: string; path: string; cover_path: string }[]) =>
  invoke<{ id: string; cover_path: string; cover_source: string }[]>('verify_local_covers', { songs });

export const deleteCoverCacheFiles = (paths: string[]) =>
  invoke<void>('delete_cover_cache_files', { paths });

// ------------------------------------------------------------------ 音频代理

/** 获取音频代理端口（未启动则启动），返回 127.0.0.1 上的监听端口 */
export const getProxyPort = () => invoke<number>('cmd_get_proxy_port');
