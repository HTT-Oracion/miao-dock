// 音乐模块的**切片公共件**：slice 工厂的 set/get 签名 + 跨段共享的小常量（D-156）。
//
// 为什么单独一件：`store.ts` 的 `create()` 体按 action 段切成 `music/actions/*.ts` 后，
// 每个切片都要用同一套 set/get 签名；`PAGE_SIZE` 被左栏 / 右栏 / 搜索三段共用。
// 这些若留在 `store.ts`，切片文件 import store、store 又 import 切片 ⇒ 成环；
// 而 `MusicState` 是 **type-only** 引用（编译期擦除），不产生运行时环。
import type { MusicState } from '@music/store';

export type { MusicState };

/**
 * 切片工厂的 `set` / `get` —— 与 `create()` 回调拿到的同一套签名。
 *
 * 🔴 为什么不直接写 `StoreApi<MusicState>['setState']`：那会让**本文件也 import 'zustand'**，
 * 而 `check:units` 的 `STATE.zustandInUse` 是「全 src 至少一处 import zustand」的**存在性**兜底 ——
 * 类型层多一处 import，会让"把 store 的 create 换掉/删掉"的变异打不掉它（实测假阳性）。
 * 故按 zustand 的调用形状手写；`store.ts` 保持全 src 唯一的运行时 zustand 引用。
 */
export type StoreSet = (
  partial: Partial<MusicState> | ((state: MusicState) => Partial<MusicState>),
  replace?: false,
) => void;
export type StoreGet = () => MusicState;

/** 播放队列上限（防止无限追加撑爆内存）—— 播放段与队列段共用 */
export const MAX_PLAY_QUEUE = 2000;

/** 歌单分页拉取条数（左栏 / 右栏的滚动加载共用） */
export const PAGE_SIZE = 50;
