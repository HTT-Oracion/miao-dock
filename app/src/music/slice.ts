// 音乐模块的**切片公共件**：slice 工厂的 set/get 签名 + 跨段共享的小常量（D-156）。
//
// 为什么单独一件：`store.ts` 的 `create()` 体按 action 段切成 `music/actions/*.ts` 后，
// 每个切片都要用同一套 set/get 签名；`PAGE_SIZE` 被左栏 / 右栏 / 搜索三段共用。
// 这些若留在 `store.ts`，切片文件 import store、store 又 import 切片 ⇒ 成环；
// 而 `MusicState` 是 **type-only** 引用（编译期擦除），不产生运行时环。
import type { StoreApi } from 'zustand';
import type { MusicState } from '@music/store';

export type { MusicState };

/** 切片工厂的 `set` / `get` —— 与 `create()` 回调拿到的同一套签名 */
export type StoreSet = StoreApi<MusicState>['setState'];
export type StoreGet = StoreApi<MusicState>['getState'];

/** 播放队列上限（防止无限追加撑爆内存）—— 播放段与队列段共用 */
export const MAX_PLAY_QUEUE = 2000;

/** 歌单分页拉取条数（左栏 / 右栏的滚动加载共用） */
export const PAGE_SIZE = 50;
