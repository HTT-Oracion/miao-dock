// 音乐模块的**偏好层**：偏好形状（`Prefs`）+ 合并式写入（`savePrefs`）。
//
// 为什么从 `store.ts` 抽出来（D-156）：`create()` 体切成 action 切片后，`savePrefs` 被
// 「播放 / 平台 / UI」三段共用；留在 `store.ts` 里，切片 import store、store 又 import 切片 ⇒ 成环。
// `PlayerSkin` / `IslandView` 是 **type-only** 引用（编译期擦除），不产生运行时环。
import { LS_PREFS, readLS, writeLS } from '@music/persist';
import type { LyricsMode, MusicProvider, PlaybackQuality, PlayMode } from '@music/types';
import type { IslandView, PlayerSkin } from '@music/store';

export interface Prefs {
  /**
   * 上次使用的播放平台。
   *
   * ⚠️ 这一项**以前根本没持久化**（store 初始值硬编码 `'netease'`），
   * 于是重启后播放平台恒为网易云，即使用户上次用的是 QQ —— 而
   * 「启动恢复上次播放」要求"按**上次那个**平台校验登录态"，
   * 连"上次是哪个平台"都不知道。补上这一项是该功能的必要前提。
   */
  playbackSource: MusicProvider;
  playbackQuality: PlaybackQuality;
  volume: number;
  playMode: PlayMode;
  skin: PlayerSkin;
  /** 展开播放器歌词字号（px） */
  lyricsFontSize: number;
  /** 展开播放器歌词高亮色 */
  lyricsHighlightColor: string;
  /** 歌词高亮方式：word 逐字 / line 整行一次性点亮 */
  lyricsMode: LyricsMode;
  /**
   * 桌面歌词的**独立**偏好 —— 与上面两条分开存、分开调。
   *
   * 为什么必须独立（不是"多一个字段好看"）：展开播放器可以铺满整屏、桌面歌词窗
   * 只有 160px 高。共用一个 `lyricsFontSize` 时，用户为详情页调到 48 会把桌面歌词
   * 撑成两行巨字 —— 这是真实回归，不是假想。参考实现也是两套字段。
   */
  desktopLyricsFontSize: number;
  desktopLyricsHighlightColor: string;
  desktopLyricsBaseColor: string;
  desktopLyricsLineCount: number;
  /** 动态背景：modern/immersive 皮肤的渐变缓慢流动 */
  dynamicEnabled: boolean;
  /** 碟片模式：展开播放器的封面变成旋转唱片 */
  discMode: boolean;
  /** 透明彩胶配色：auto=跟随封面主色 / custom=固定色 */
  vinylColorMode: 'auto' | 'custom';
  vinylCustomColor: string;
  /**
   * 灵动岛展开后进哪个视图（播放卡 / 歌词卡）。
   *
   * ⚠️ 这是**唯一一次**为灵动岛新增的偏好：歌词字号/高亮色一律**不新增** ——
   * 高亮色复用 `lyricsHighlightColor`（用户选的颜色应当三处一致），字号用卡片自己的
   * 固定值（设置页那条 17–48 的量程给 320px 宽的卡片用会一行放不下几个字）。
   */
  islandView: IslandView;
}

/**
 * 合并式写入偏好：每项只改自己那个键。
 * 为什么用合并而不是整份覆盖 —— 各项分别由不同的 setter 写入，整份覆盖会把
 * 「同时改两项」编排成互相覆盖（后写的赢），是一个只在特定操作序列下复现的 bug。
 */
export function savePrefs(patch: Partial<Prefs>): void {
  writeLS(LS_PREFS, { ...readLS<Partial<Prefs>>(LS_PREFS, {}), ...patch });
}
