/**
 * 播放/媒体的**选项常量表** —— 设置页与播放器共用同一份，
 * 避免「设置页写一套档位名、展开播放器写另一套」这种两处各写一遍的漂移。
 *
 * 这里的每一项都对应参考实现里的一个持久化设置（键名见各条注释），
 * 属于「可实现的媒体设置」的完整清单 —— 已剔除的部分（桌面歌词、媒体键、
 * 音频输出、均衡器、音频缓存）见 `screens/settings/catalog.ts` 的 MEDIA 注释。
 */
import type { PlayerSkin } from '@music/store';
import type { PlaybackQuality } from '@music/types';

/**
 * 展开播放器六皮肤（参考实现 `expandedStyle`）。
 * `cls` 是 app.css 里的皮肤类名；`preview` 是「切换样式」弹层里的预览图
 * （放在 public/style-previews/ 下，Vite 的 publicDir 直接映射到站点根，故写绝对路径）。
 * 预览图与皮肤元信息放同一张表，是为了避免「弹层写一套顺序/名字、皮肤选择器又写一套」的漂移。
 */
export const SKINS: {
  id: PlayerSkin;
  label: string;
  cls: string;
  preview: string;
  light?: boolean;
}[] = [
  { id: 'modern', label: '现代', cls: 'sk-modern', preview: '/style-previews/modern.webp' },
  { id: 'glass', label: '通透', cls: 'sk-glass', preview: '/style-previews/glass.webp', light: true },
  { id: 'immersive', label: '沉浸', cls: 'sk-immersive', preview: '/style-previews/immersive.webp' },
  { id: 'spectrum', label: '音域回响', cls: 'sk-spectrum', preview: '/style-previews/spectrum.webp' },
  { id: 'vinyl', label: '透明彩胶', cls: 'sk-vinyl', preview: '/style-previews/vinyl.webp', light: true },
  { id: 'cover', label: '封面渐染', cls: 'sk-cover', preview: '/style-previews/cover.webp', light: true },
];

/**
 * 「切换样式」弹层里卡片的**显示顺序**（照参考实现 `STYLE_PREVIEWS` 数组顺序：
 * 封面渐染 → 透明彩胶 → 沉浸 → 音域回响 → 现代 → 通透）。
 *
 * 为什么不直接用 SKINS 的顺序：SKINS 的先后是「设置页下拉里的排列」，
 * 与弹层里想给用户的引导顺序（先看最新/最花哨的样式）不是同一件事 —— 两处各表达各的意图，
 * 所以这里单独给一张顺序表，而不是让弹层去迁就设置页。
 */
export const STYLE_PREVIEW_ORDER: readonly PlayerSkin[] = [
  'cover',
  'vinyl',
  'immersive',
  'spectrum',
  'modern',
  'glass',
];

/**
 * 音质档位（参考实现 `quality`）—— 顺序由低到高，与平台 token 一一对应。
 * `desc` 是档位的规格简述（参考实现里菜单项的第二列：主标题 label + 描述 desc）。
 */
export const QUALITY_OPTIONS: { value: PlaybackQuality; label: string; desc: string }[] = [
  { value: 'standard', label: '标准', desc: '128k' },
  { value: 'exhigh', label: '极高', desc: '999k' },
  { value: 'lossless', label: '无损', desc: '1411k' },
  { value: 'hires', label: '高清臻音', desc: '1999k' },
  { value: 'jymaster', label: '超清母带', desc: 'SVIP 专属' },
];

/**
 * 歌词字号范围（参考实现 `lyricsFontSize`，单位 px）。
 * 上限对齐参考实现的 17–48 —— 设置页滑块与展开播放器滑块共读这一处，
 * 改这里两端一起变，不会出现「播放器能拉到 48、设置页只到 26」这种两套量程。
 */
export const LYRICS_SIZE = { min: 17, max: 48, step: 1, def: 19 } as const;

/** 歌词高亮色（参考实现 `lyricsHighlightColor`）—— 给几个常规色 + 允许自定义 */
export const LYRICS_COLORS = ['#FFE066', '#FF8FBF', '#8FC7FF', '#70D9AD', '#C9B5FF'] as const;
export const LYRICS_COLOR_DEF = '#FFE066';

/** 透明彩胶自定义色（参考实现 `vinylCustomColor`） */
export const VINYL_COLOR_DEF = '#E8B04B';
