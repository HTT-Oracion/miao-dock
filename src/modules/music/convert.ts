// 音乐模块的**纯转换函数**收口：本地歌曲映射 · 唯一键 · 时长格式化 · 音质档位名 · 封面代理地址。
//
// 为什么从 `store.ts` 抽出来（D-156）：`store.ts` 的 `create()` 体要按 action 段切成
// `music/actions/*.ts`，而这些函数被 **action 段与 UI 同时依赖** —— 留在 `store.ts` 里，
// 切出去的段 import store、store 又 import 段 ⇒ 成环。它们零状态、只做值变换，
// 本就该住在这里（与 D-149 把歌词解析下沉 `tools/lyrics.ts` 同一判断）。
import { convertFileSrc } from '@tauri-apps/api/core';
import type { LocalSongInfo, Song } from '@music/types';

/** 平台音质 token → 中文档位名（认不出的原样显示，不猜） */
const QUALITY_LABELS: Record<string, string> = {
  jymaster: '超清母带',
  master: '超清母带',
  hi_res: '高清臻音',
  hires: '高清臻音',
  lossless: '无损',
  flac: '无损',
  exhigh: '极高',
  highest: '极高',
  higher: '较高',
  high: '较高',
  hq: '较高',
  standard: '标准',
  normal: '标准',
  medium: '标准',
};

export function qualityLabel(raw: string): string {
  if (!raw) return '';
  return QUALITY_LABELS[raw.trim().toLowerCase()] ?? raw;
}

/** 封面走本地代理（加 Referer / 绕 CORS）；asset 协议与 data/blob 原样返回 */
export function coverProxyUrl(url: string, proxyPort: number): string {
  if (!url) return '';
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  if (url.startsWith('http://asset.localhost/') || url.startsWith('https://asset.localhost/')) return url;
  if (!proxyPort) return url;
  return `http://127.0.0.1:${proxyPort}/cover?url=${encodeURIComponent(url)}`;
}

/** 本地导入的 LocalSongInfo → 可播放的统一 Song（provider = "local"） */
export function localToSong(info: LocalSongInfo): Song {
  return {
    provider: 'local',
    id: info.id,
    name: info.title || info.name,
    artist: info.artist || '未知艺术家',
    album: info.album,
    cover: info.cover_path ? convertFileSrc(info.cover_path) : '',
    // Song.duration 全链路单位是毫秒（含本地导入），这里不做换算
    duration: Math.round(info.duration_ms),
    fee: 0,
    playable: true,
    language: 0,
    artists: [],
    _localPath: info.path,
    _localCoverPath: info.cover_path,
    _localHasLyric: info.has_lyric,
  };
}

/** 统一歌曲唯一键（跨列表去重 / 队列定位用） */
export function songKey(s: Song): string {
  return `${s.provider}:${s.id}`;
}

/** 格式化毫秒 → m:ss（播放条时间显示） */
export function fmtTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 会员状态的两个字（登录弹窗的账号卡与设置页③的平台卡共用一句）。
 *
 * ⚠️ 只说**能确定的那半句**：各平台对"等级"的判定口径不同（网易云按 `vipType` 阈值、
 * QQ / 酷狗另有 SVIP 探测分支），所以不替平台起会员名，只回答"是不是会员"。
 */
export function memberLabel(vip: { is_vip?: boolean; is_svip?: boolean }): string {
  return vip.is_vip || vip.is_svip ? '会员' : '非会员';
}
