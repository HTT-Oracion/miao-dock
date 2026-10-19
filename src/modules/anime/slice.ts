/**
 * 番剧模块的切片公共件 —— 与 `modules/music/slice.ts` 同构（D-156 的范式）。
 *
 * 为什么手写 `StoreSet` / `StoreGet` 而不 import zustand 的类型：
 * `check:units` 的 `STATE.zustandInUse` 是「全 src 至少一处 import zustand」的存在性兜底，
 * 多一处类型层 import 会让「把 store 的 create 换掉」这类变异打不掉它 —— 实测假阳性。
 */
import type { AnimeState } from '@anime/store';

export type { AnimeState };

export type StoreSet = (
  partial: Partial<AnimeState> | ((state: AnimeState) => Partial<AnimeState>),
  replace?: false,
) => void;
export type StoreGet = () => AnimeState;

/** 番剧模块的 `localStorage` 键前缀 —— 与壳层偏好、音乐偏好分域，避免撞键 */
export const ANIME_LS_PREFIX = 'miao.anime.';
