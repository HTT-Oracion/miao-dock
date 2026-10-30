import { useEffect } from 'react';
import { useMusicStore } from '@music/store';
import { toastBus } from '@/stores/toastBus';

/**
 * 音乐模块轻提示 —— 现在是**转发器**，不再自己渲染。
 *
 * ## 为什么改成转发
 * 拍板第 4 项（方案 B）：轻提示由**灵动岛**统一承载。
 * 而 `store.musicToast` 只存在音乐屏里 —— 原实现把 `<Toast />` 挂在 `MusicScreen` 内，
 * 所以音乐屏的提示**切到设置页就看不见**。用户反馈的正是这类"提示消失"问题。
 *
 * ## 转发后必须清空源 store（否则同一条被渲染两次）
 * 与参考实现一致：它把 `musicToast` 推给灵动岛后立刻
 * `useMusicStore.setState({ musicToast: null })`。这里用 `clearToast` action 达同效果。
 *
 * ## 为什么不直接给 store 一个 toast action
 * 因为**应用级 toast 有 6 处业务在用**（服务重启 / 漫画库 / 打开目录 / 设置页），
 * 它们走的是 `useToasts().push`。若音乐屏另起一条通道，就会有两个互不相通的 toast 源，
 * 而灵动岛只能显示一套 —— 那等于音乐屏的提示又丢了。
 * `toastBus`（src/stores/toastBus.ts）是那条**唯一通道**的出口（见 DynamicIsland 的说明）。
 */
export function Toast() {
  const musicToast = useMusicStore((s) => s.musicToast);
  const clearToast = useMusicStore((s) => s.clearToast);

  useEffect(() => {
    if (!musicToast) return;
    // 三种语义 → 全局通道的对应色（success→good / warning→bad / info→info）
    const kind = musicToast.type === 'success' ? 'good' : musicToast.type === 'info' ? 'info' : 'bad';
    // `sub` 原样透传：设计稿的两行 toast（标题 + 说明）在这里接上总线
    toastBus.push(musicToast.message, kind, musicToast.sub);
    clearToast();
  }, [musicToast, clearToast]);

  // 不再渲染任何 DOM：承载已交给灵动岛
  return null;
}
