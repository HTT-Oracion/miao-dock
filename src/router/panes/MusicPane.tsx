/**
 * 音乐应用的屏装配件（B1 改造的产物）。
 *
 * 音乐屏本身**不消费壳层数据**（它是独立应用，自成一个工作区）—— 之所以仍有这一层，
 * 是为了让"路径 → 屏"在路由表里是齐的：少一个元素，`/music` 就还是"壳内部的又一个分支"。
 */
import { MusicScreen } from '@screens/MusicScreen';

export function MusicPane() {
  return <MusicScreen />;
}
