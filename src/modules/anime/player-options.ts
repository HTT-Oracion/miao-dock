/**
 * 番剧模块的播放 / 数据源选项常量 —— 设置页、播放器、时间表共用一处。
 *
 * 与 `modules/music/player-options.ts` 同纪律：档位与顺序只写一遍，
 * 改这里所有入口一起变；散开写必然出现「设置页 1.5×、播放器 1.25×」的漂移。
 */
import type { AnimeView } from '@anime/types';

/** 新番时间表列（0 = 周一 … 6 = 周日）；顺序即渲染顺序 */
export const WEEKDAYS: { idx: number; label: string }[] = [
  { idx: 0, label: '周一' },
  { idx: 1, label: '周二' },
  { idx: 2, label: '周三' },
  { idx: 3, label: '周四' },
  { idx: 4, label: '周五' },
  { idx: 5, label: '周六' },
  { idx: 6, label: '周日' },
];

/** 数据源类型 → 人话名称（源列表与选择来源浮层共用） */
export const SOURCE_KIND_LABEL: Record<string, string> = {
  builtin: '内置源',
  web: '在线网页源',
  rss: 'RSS 订阅源',
  selector: '选择器源',
  jellyfin: 'Jellyfin',
  emby: 'Emby',
  local: '本地缓存',
  bt: 'BT / 磁力',
  anime1: 'Anime1 在线源',
};

/** 倍速档位：控制条点一下按此顺序轮转（也是设置页的候选值） */
export const RATE_STEPS: number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** 播放器快捷键行（底部提示） */
export const PLAYER_KEYS: { key: string; label: string }[] = [
  { key: 'Space', label: '播放 / 暂停' },
  { key: '← →', label: '±5 秒' },
  { key: '↑ ↓', label: '音量' },
  { key: 'F', label: '全屏' },
  { key: 'A / D', label: '微调倍速' },
  { key: 'S', label: '复位倍速' },
  { key: 'M', label: '静音' },
  { key: '截图', label: '存一张当前帧' },
];

/** 模块内十屏的标题/副标题 —— 壳层工具条与屏内面包屑共用（只写一遍） */
export const ANIME_VIEW_META: Record<AnimeView, { title: string; sub: string }> = {
  explore: { title: '探索', sub: '新番时间表 · 热度 · 继续观看 · 为你推荐' },
  collection: { title: '追番', sub: '溜了 / 想补 / 在看 / 囤着 / 看完' },
  cache: { title: '缓存', sub: '本地下载 · 边下边播 · 占用统计' },
  detail: { title: '条目详情', sub: '信息栏 + 内容流 · 双栏' },
  player: { title: '播放器', sub: '画面 + 选集侧栏 · 双轨内核' },
  history: { title: '播放历史', sub: '续播位置 · 本地与云端同步状态' },
  account: { title: '账号与同步', sub: '登录 · 待同步队列 · 双侧冲突合并' },
  source: { title: '数据源与 BT', sub: '媒体源 · 编辑器 · BT 任务 · Peer 过滤' },
  states: { title: '三态规范', sub: '骨架 / 空态 / 错误态 · 全模块统一语汇' },
};
