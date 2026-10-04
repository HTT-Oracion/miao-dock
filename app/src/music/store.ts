/**
 * 音乐模块状态层（zustand）—— 播放队列 + 本地导入 + 搜索 + 播放控制。
 *
 * 从参考实现（Zustand store）移植**逻辑**、剥离 Chakra UI 绑定（PD-1「界面重写」）。
 * 本文件只持状态与副作用，不渲染任何 UI；UI 在 screens/MusicScreen.tsx。
 *
 * 播放地址解析（关键技术点，见 docs/spec-notes.md M3 结论）：
 * - 本地歌曲：`convertFileSrc(绝对路径)` 转 asset 协议，WebView 内可直接播放；
 * - 在线歌曲：先按平台调 song_url 命令拿真实 URL，再走音频代理
 *   `http://127.0.0.1:{port}/audio?url=...`（加 Referer/CORS/流式，Range 透传）。
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import { create } from 'zustand';
import * as ipc from './ipc';
import type { LocalSongInfo, LoginInfo, Playlist, PlayMode, Song } from './types';

/** 本地导入的 LocalSongInfo → 可播放的统一 Song（provider = "local"） */
export function localToSong(info: LocalSongInfo): Song {
  return {
    provider: 'local',
    id: info.id,
    name: info.title || info.name,
    artist: info.artist || '未知艺术家',
    album: info.album,
    cover: info.cover_path ? convertFileSrc(info.cover_path) : '',
    duration: Math.round(info.duration_ms / 1000),
    fee: 0,
    playable: true,
    language: 0,
    artists: [],
    _localPath: info.path,
    _localCoverPath: info.cover_path,
    _localHasLyric: info.has_lyric,
  };
}

/** 按平台把 Song 的字段展开，调对应 song_url 命令拿真实播放地址 */
async function resolveOnlineUrl(song: Song): Promise<string> {
  const q = 'hires';
  const r: { url: string | null } = await (() => {
    switch (song.provider) {
      case 'kugou':
        return ipc.kugouSongUrl(song.hash ?? '', song.album_id, song.album_audio_id, q, song.hq_hash, song.sq_hash, song.res_hash);
      case 'qqmusic':
        return ipc.qqSongUrl(song.mid ?? '', song.media_mid, q);
      case 'migu':
        return ipc.miguSongUrl(song.content_id ?? song.id, song.id, q);
      default:
        return ipc.musicSongUrl(song.id, q);
    }
  })();
  if (!r.url) return '';
  const port = await ipc.getProxyPort();
  return `http://127.0.0.1:${port}/audio?url=${encodeURIComponent(r.url)}`;
}

/** 统一解析一首歌的可播放 URL（本地 asset 协议 / 在线音频代理） */
async function resolvePlayUrl(song: Song): Promise<string> {
  if (song._localPath) return convertFileSrc(song._localPath);
  return resolveOnlineUrl(song);
}

interface MusicState {
  // 本地
  localSongs: LocalSongInfo[];
  /** 本地歌曲对应的可播放队列（Song，引用稳定，由 importLocal 同步维护） */
  localQueue: Song[];
  // 播放
  currentSong: Song | null;
  queue: Song[];
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  volume: number;
  playMode: PlayMode;
  playUrl: string;
  // 搜索
  searchText: string;
  searchResults: Song[];
  searching: boolean;
  searchError: string;
  // 发现（右栏推荐歌单 + 歌单曲目）
  recommendPlaylists: Playlist[];
  loadingRecommend: boolean;
  currentPlaylist: { playlist: Playlist; songs: Song[] } | null;
  loadingPlaylist: boolean;
  // 登录状态（网易云）
  loginInfo: LoginInfo | null;

  importLocal: (paths: string[]) => Promise<void>;
  importFolder: (folder: string) => Promise<void>;
  playSong: (song: Song) => Promise<void>;
  playQueue: (songs: Song[], startIndex: number) => Promise<void>;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  seek: (ms: number) => void;
  setVolume: (v: number) => void;
  cycleMode: () => void;
  search: (kw: string) => Promise<void>;
  setSearchText: (t: string) => void;
  setProgress: (ms: number) => void;
  setDuration: (ms: number) => void;
  loadRecommend: () => Promise<void>;
  openPlaylist: (p: Playlist) => Promise<void>;
  closePlaylist: () => void;
  loadLoginStatus: () => Promise<void>;
}

export const useMusicStore = create<MusicState>((set, get) => ({
  localSongs: [],
  localQueue: [],
  currentSong: null,
  queue: [],
  isPlaying: false,
  progressMs: 0,
  durationMs: 0,
  volume: 0.8,
  playMode: 'list',
  playUrl: '',
  searchText: '',
  searchResults: [],
  searching: false,
  searchError: '',
  recommendPlaylists: [],
  loadingRecommend: false,
  currentPlaylist: null,
  loadingPlaylist: false,
  loginInfo: null,

  importLocal: async (paths) => {
    try {
      const infos = await ipc.importLocalMusic(paths);
      if (infos.length > 0) {
        const songs = infos.map(localToSong);
        set({ localSongs: infos, localQueue: songs });
        // 导入后立即把本地歌单作为播放队列，自动播第一首
        await get().playQueue(songs, 0);
      }
    } catch {
      // 导入失败静默：不打断用户，UI 层不展示假数据
    }
  },

  importFolder: async (folder) => {
    try {
      const infos = await ipc.importLocalMusicFolder(folder);
      if (infos.length > 0) {
        const songs = infos.map(localToSong);
        set({ localSongs: infos, localQueue: songs });
        await get().playQueue(songs, 0);
      }
    } catch {
      // 同上
    }
  },

  playSong: async (song) => {
    await get().playQueue([song], 0);
  },

  playQueue: async (songs, startIndex) => {
    const song = songs[startIndex];
    if (!song) return;
    const url = await resolvePlayUrl(song);
    set({
      queue: songs,
      currentSong: song,
      playUrl: url,
      progressMs: 0,
      durationMs: song.duration || 0,
      isPlaying: true,
    });
  },

  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),

  next: () => {
    const { queue, currentSong, playMode } = get();
    if (queue.length === 0) return;
    let idx = queue.findIndex((s) => s === currentSong);
    if (idx < 0) idx = 0;
    const nextIdx = playMode === 'one' ? idx : (idx + 1) % queue.length;
    void get().playQueue(queue, nextIdx);
  },

  prev: () => {
    const { queue, currentSong } = get();
    if (queue.length === 0) return;
    let idx = queue.findIndex((s) => s === currentSong);
    if (idx < 0) idx = 0;
    const prevIdx = (idx - 1 + queue.length) % queue.length;
    void get().playQueue(queue, prevIdx);
  },

  seek: (ms) => set({ progressMs: ms }),

  setVolume: (v) => set({ volume: v }),

  cycleMode: () => {
    const order: PlayMode[] = ['list', 'shuffle', 'one'];
    const cur = get().playMode;
    const idx = order.indexOf(cur);
    set({ playMode: order[(idx + 1) % order.length] });
  },

  search: async (kw) => {
    if (!kw.trim()) {
      set({ searchResults: [], searchError: '' });
      return;
    }
    set({ searching: true, searchError: '' });
    try {
      const results = await ipc.musicSearch(kw.trim(), 30);
      set({ searchResults: results, searching: false });
    } catch (e) {
      set({ searchResults: [], searching: false, searchError: String(e) });
    }
  },

  setSearchText: (t) => set({ searchText: t }),

  setProgress: (ms) => set({ progressMs: ms }),
  setDuration: (ms) => set({ durationMs: ms }),

  loadRecommend: async () => {
    set({ loadingRecommend: true });
    try {
      const list = await ipc.musicPersonalized();
      set({ recommendPlaylists: list, loadingRecommend: false });
    } catch {
      set({ loadingRecommend: false });
    }
  },

  openPlaylist: async (p) => {
    set({ loadingPlaylist: true });
    try {
      const [playlist, songs] = await ipc.musicPlaylistTracks(p.id);
      set({ currentPlaylist: { playlist, songs }, loadingPlaylist: false });
    } catch {
      set({ loadingPlaylist: false });
    }
  },

  closePlaylist: () => set({ currentPlaylist: null }),

  loadLoginStatus: async () => {
    try {
      const statuses = await ipc.musicGetLoginStatuses();
      const info = statuses['netease'];
      set({ loginInfo: info && info.logged_in ? info : null });
    } catch {
      // 静默：未登录 / 网络未就绪不打扰用户
    }
  },
}));

/** 格式化毫秒 → m:ss（播放条时间显示） */
export function fmtTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
