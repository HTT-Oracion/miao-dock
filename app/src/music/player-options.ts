/**
 * 播放/媒体的**选项常量表** —— 设置页与播放器共用同一份，
 * 避免「设置页写一套档位名、展开播放器写另一套」这种两处各写一遍的漂移。
 *
 * 这里的每一项都对应参考实现里的一个持久化设置（键名见各条注释），
 * 属于「可实现的媒体设置」的完整清单 —— 已剔除的部分（媒体键、音频输出、
 * 均衡器、音频缓存）见 `screens/settings/catalog.ts` 的 MEDIA 注释。
 *
 * 文件分两段：**展开播放器**用的一组（LYRICS_* / SKINS / QUALITY_OPTIONS / VINYL_*），
 * 与**桌面歌词独立**的一组（DL_*）。两段刻意不共用常量，理由见 DL_* 段开头。
 */
import type { PlayerSkin } from '@music/store';
import type { LyricsMode, PlaybackQuality } from '@music/types';

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
  { id: 'modern', label: '现代', cls: 'sk-modern', preview: '/style-previews/modern.png' },
  { id: 'glass', label: '通透', cls: 'sk-glass', preview: '/style-previews/glass.png', light: true },
  { id: 'immersive', label: '沉浸', cls: 'sk-immersive', preview: '/style-previews/immersive.png' },
  { id: 'spectrum', label: '音域回响', cls: 'sk-spectrum', preview: '/style-previews/spectrum.png' },
  { id: 'vinyl', label: '透明彩胶', cls: 'sk-vinyl', preview: '/style-previews/vinyl.png', light: true },
  { id: 'cover', label: '封面渐染', cls: 'sk-cover', preview: '/style-previews/cover.png', light: true },
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

/**
 * 歌词高亮方式（本项目新增，参考实现没有此开关）。
 * `line` = 整行一次性点亮（**D-137 起的默认**：用户报"整行高亮却还有逐渐移动的动画"，
 *   根因是整行走的是"双层 + width 写死 100%"，结构里仍留着可被改写的 width 通路；
 *   现改为整行单层渲染，推进从结构上不存在）；`word` = 逐字（yrc 精确到字，无则行级渐进）。
 * 与 `LYRICS_SIZE` 同纪律：设置页与展开播放器共读这一处，改这里两处一起变。
 */
export const LYRICS_MODE_OPTIONS: { value: LyricsMode; label: string }[] = [
  { value: 'line', label: '整行' },
  { value: 'word', label: '逐字' },
];
export const LYRICS_MODE_DEF: LyricsMode = 'line';

/** 透明彩胶自定义色（参考实现 `vinylCustomColor`） */
export const VINYL_COLOR_DEF = '#E8B04B';

// ------------------------------------------------------------------ 桌面歌词（独立于展开播放器）
//
// 参考实现里桌面歌词有**自己的一套**偏好字段（`desktopLyrics*`），与展开播放器的
// `lyricsFontSize` / `lyricsHighlightColor` 分开存、分开调。本移植照此办理，理由是
// 一个具体的回归：展开播放器的字号量程已对齐参考的 17–48，用户把展开播放器拉到 48
// 只说明"详情页想看清"，而桌面歌词窗只有 160px 高 —— 共用一个字号会让桌面歌词
// 被撑成两行巨大的字。**两个窗口的可用空间差一个量级，偏好就不该是同一个。**
//
// ⚠️ 这里的常量**刻意不与上面那组复用**（哪怕色值暂时相同）：一旦共用，日后调
// 展开播放器的配色就会顺手改到桌面歌词，又变回耦合 —— 那正是本任务要切断的。

/**
 * 桌面歌词字号范围（px，`desktopLyricsFontSize`）。
 *
 * 量程与展开播放器的 17–48 **不同**，上限压到 40：桌面歌词窗高 160px 且
 * `resizable(false)`（窗口几何在 Rust 侧，见 lyrics_window.rs 的 WIN_H），
 * 字号越大 + 行数越多越容易顶出窗口。默认 22 与改造前"当前行 ≈ 19×1.15"的观感对齐。
 *
 * 语义上它是**当前（高亮）那一行的字号**，其余行按 `.dl-side` 的 0.86em 缩小 ——
 * 不再用"当前行 ×1.15"那种相对放大：有了独立的底色之后，焦点已由颜色承担。
 */
export const DL_LYRICS_SIZE = { min: 16, max: 40, step: 1, def: 22 } as const;

/**
 * 桌面歌词一次显示几行（含当前行，当前行在最下方）。
 *
 * 下限 2 就是改造前的形态（上一行 + 当前行），上限 5 是 160px 窗高能容纳的
 * 上限附近（默认字号下 5 行约 155px）—— 再往上必然溢出。
 */
export const DL_LINE_COUNT = { min: 2, max: 5, def: 2 } as const;

/** 桌面歌词高亮色（正在唱的那一行）候选 + 默认 */
export const DL_HIGHLIGHT_COLORS = ['#FFE066', '#FF8FBF', '#8FC7FF', '#70D9AD', '#C9B5FF'] as const;
export const DL_HIGHLIGHT_COLOR_DEF = '#FFE066';

/**
 * 桌面歌词底色（未高亮的其余行）候选 + 默认。
 *
 * 默认 `#9C93C4` 是**实色**而不是改造前那条 `rgba(245,242,255,0.42)`：
 * 原生 `<input type="color">` 表达不了带透明度的颜色，若继续用半透明白，
 * 用户在这里选的颜色与窗里看到的就对不上（取色器会静默丢掉 alpha）。
 * 所以统一走实色 —— 这个值是按"深色玻璃底 + 42% 白"折算出来的近似，
 * 观感基本不变，而 WYSIWYG 成立。
 */
export const DL_BASE_COLORS = ['#9C93C4', '#8FC7FF', '#70D9AD', '#FFB3C7', '#C9B5FF'] as const;
export const DL_BASE_COLOR_DEF = '#9C93C4';
