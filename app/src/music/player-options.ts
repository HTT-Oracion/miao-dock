/**
 * 播放/媒体的**选项常量表** —— 设置页与播放器共用同一份，
 * 避免「设置页写一套档位名、展开播放器写另一套」这种两处各写一遍的漂移。
 *
 * 这里的每一项都对应参考实现里的一个持久化设置（键名见各条注释），
 * 属于「可实现的媒体设置」的完整清单 —— 已剔除的部分（桌面歌词、媒体键、
 * 音频输出、均衡器、音频缓存）见 `screens/settings/catalog.ts` 的 MEDIA 注释。
 */
import type { PlayerSkin } from './store';
import type { PlaybackQuality } from './types';

/** 展开播放器六皮肤（参考实现 `expandedStyle`）—— `cls` 是 app.css 里的皮肤类名 */
export const SKINS: { id: PlayerSkin; label: string; cls: string; light?: boolean }[] = [
  { id: 'modern', label: '现代', cls: 'sk-modern' },
  { id: 'glass', label: '通透', cls: 'sk-glass', light: true },
  { id: 'immersive', label: '沉浸', cls: 'sk-immersive' },
  { id: 'spectrum', label: '音域回响', cls: 'sk-spectrum' },
  { id: 'vinyl', label: '透明彩胶', cls: 'sk-vinyl', light: true },
  { id: 'cover', label: '封面渐染', cls: 'sk-cover', light: true },
];

/** 音质档位（参考实现 `quality`）—— 顺序由低到高，与平台 token 一一对应 */
export const QUALITY_OPTIONS: { value: PlaybackQuality; label: string }[] = [
  { value: 'standard', label: '标准' },
  { value: 'exhigh', label: '极高' },
  { value: 'lossless', label: '无损' },
  { value: 'hires', label: '高清臻音' },
  { value: 'jymaster', label: '超清母带' },
];

/** 歌词字号范围（参考实现 `lyricsFontSize`，单位 px） */
export const LYRICS_SIZE = { min: 14, max: 26, step: 1, def: 19 } as const;

/** 歌词高亮色（参考实现 `lyricsHighlightColor`）—— 给几个常规色 + 允许自定义 */
export const LYRICS_COLORS = ['#FFE066', '#FF8FBF', '#8FC7FF', '#70D9AD', '#C9B5FF'] as const;
export const LYRICS_COLOR_DEF = '#FFE066';

/** 透明彩胶自定义色（参考实现 `vinylCustomColor`） */
export const VINYL_COLOR_DEF = '#E8B04B';
