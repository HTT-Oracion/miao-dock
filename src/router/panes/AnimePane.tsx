/**
 * 番剧应用的屏装配件 —— 与 `MusicPane` 同构。
 *
 * 番剧屏不消费壳层数据（独立应用、自成工作区）；这一层存在的理由只有一个：
 * 让「路径 → 屏」在路由表里是齐的，而不是壳内部的又一个渲染分支。
 */
import { AnimeScreen } from '@screens/AnimeScreen';

export function AnimePane() {
  return <AnimeScreen />;
}
