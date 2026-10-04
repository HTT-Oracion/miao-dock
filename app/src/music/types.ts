/**
 * 音乐模块前端类型 —— 与 Rust `app/src-tauri/src/music/models.rs` 一一对应。
 *
 * 命名刻意用 snake_case（与 serde 序列化出的 JSON 字段名一致），前端不做驼峰转换，
 * 避免 IPC 边界上再引入一层字段映射。唯一例外是 `_local*` 前缀的本地导入扩展字段。
 */

/** 统一歌曲结构 */
export interface Song {
  provider: string;
  id: string;
  mid?: string;
  media_mid?: string;
  name: string;
  artist: string;
  artists: Artist[];
  album: string;
  cover: string;
  duration: number;
  fee: number;
  playable: boolean;
  language: number;
  // === 酷狗扩展字段 ===
  hash?: string;
  album_id?: string;
  album_audio_id?: string;
  hq_hash?: string;
  sq_hash?: string;
  res_hash?: string;
  // === QQ 音乐扩展字段 ===
  qq_song_id?: number;
  // === 咪咕扩展字段（id 存 copyrightId，播放用 contentId）===
  content_id?: string;
  // === 本地导入扩展字段 ===
  _localPath?: string;
  _localCoverPath?: string;
  _localHasLyric?: boolean;
}

/** 持久化播放历史条目：一次成功播放记一条，按 playedAt 倒序（最近在前） */
export interface PlayHistoryEntry {
  song: Song;
  playedAt: number;
}

export interface Artist {
  provider?: string;
  id?: string;
  mid?: string;
  name: string;
  pic_url?: string;
  music_size?: number;
}

export interface Playlist {
  provider: string;
  id: string;
  name: string;
  cover: string;
  track_count: number;
  creator: string;
  subscribed: boolean;
}

export interface SongUrlResult {
  url: string | null;
  playable: boolean;
  trial: boolean;
  level: string;
  quality: string;
  br: number;
  reason?: string;
  message?: string;
  fee?: number;
}

export interface LoginInfo {
  provider: string;
  logged_in: boolean;
  user_id: string;
  nickname: string;
  avatar: string;
  vip_type: number;
  vip_level: string;
  is_vip: boolean;
  is_svip: boolean;
}

export interface Lyrics {
  lyric: string;
  translation?: string;
  roma?: string;
  yrc?: string;
}

export interface QrCheckResult {
  code: number; // 801=等待扫码, 802=待确认, 803=成功, 800=过期
  message: string;
  cookie?: string;
  nickname?: string;
  avatar?: string;
}

export interface MusicComment {
  comment_id: number;
  content: string;
  time: number;
  liked_count: number;
  liked: boolean;
  user_id: number;
  nickname: string;
  avatar: string;
}

export interface CommentPage {
  total: number;
  has_more: boolean;
  comments: MusicComment[];
  hot_comments: MusicComment[];
}

export interface Album {
  id: string;
  name: string;
  cover: string;
  publish_time: number;
  song_count: number;
  artist_name: string;
}

export interface Mv {
  id: string;
  name: string;
  cover: string;
  duration: number;
  play_count: number;
  artist_name: string;
}

export interface ArtistDetail {
  id: string;
  name: string;
  brief_desc: string;
}

/** 本地导入歌曲元信息（Rust `music/local.rs` 的 LocalSongInfo） */
export interface LocalSongInfo {
  id: string;
  name: string;
  path: string;
  size: number;
  extension: string;
  title: string;
  artist: string;
  album: string;
  duration_ms: number;
  cover_path: string;
  cover_source: string;
  has_lyric: boolean;
}

/** 播放模式：list 列表循环 / heartbeat 心动模式 / shuffle 随机 / one 单曲循环 */
export type PlayMode = 'list' | 'heartbeat' | 'shuffle' | 'one';

export type PlaybackQuality = 'jymaster' | 'hires' | 'lossless' | 'exhigh' | 'standard';

/**
 * 音乐平台类型 —— 汽水（qishui）已延后（技术方案 PD-1：Windows-only 平台耦合 +
 * 依赖仓库外二进制签名器），故从类型里移除。
 */
export type MusicProvider = 'netease' | 'kugou' | 'qqmusic' | 'migu';

/** 平台显示信息 */
export interface ProviderInfo {
  id: MusicProvider;
  name: string;
  color: string;
}
