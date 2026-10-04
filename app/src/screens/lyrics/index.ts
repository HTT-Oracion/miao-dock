/**
 * 桌面歌词窗口的入口与统一出口。
 *
 * ## 为什么这个桶文件同时是「入口」
 * `app/lyrics.html`（Vite 第二入口，Rust 侧 `WebviewUrl::App("lyrics.html")` 加载）
 * 的脚本指向本文件，而不是直接指向 `DesktopLyrics.tsx`。两个原因：
 *
 * ① **挂载点是窗口级的，不是组件级的**。歌词窗没有 `App.tsx`、没有路由、
 *   也没有主窗那套 ThemeProvider —— 它就是「把一个组件挂到 #root 上」这一件事。
 *   把 createRoot 放在入口文件里，与主窗 `main.tsx` 的做法一致（同一形状、两处对称）。
 * ② **组件不该带副作用**。若在 `DesktopLyrics.tsx` 顶层自己 createRoot，
 *   任何人 import 它（哪怕只是为了拿类型）都会顺带挂出一个窗口 —— 那是隐式全局副作用。
 *
 * ## 为什么桶里只导出组件与类型
 * 调用方（目前只有本窗自己）记一个路径 `@screens/lyrics` 即可，
 * 内部怎么拆分是内部事。
 */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopLyrics } from '@screens/lyrics/DesktopLyrics';

export { DesktopLyrics };
export type { LyricsPayload, LyricsLine } from '@screens/lyrics/DesktopLyrics';

const el = document.getElementById('root');
if (!el) throw new Error('缺少 #root 挂载点');

/**
 * 刻意**不套** `React.StrictMode`。
 *
 * 原因：StrictMode 在开发模式下会故意双调用 effect，用来暴露副作用不幂等的问题。
 * 本窗的 effect 里有 `requestAnimationFrame` 循环与 Tauri 事件订阅 —— 双挂载虽然
 * 会被清理函数正确撤销（不泄漏），但会让「首帧收到两次推送」这类时序问题在开发时
 * 被放大成偶发的视觉抖动，而本窗是置顶小窗，用户对抖动的容忍度比主窗低得多。
 * 主窗保留 StrictMode，本窗不保留 —— 两者的取舍不同，不是漏写。
 *
 * 用 `createElement` 而非 JSX：本文件名按入口约定是 `.ts`（`.ts` 不能含 JSX）。
 * 一行挂载不值得为此把文件改成 `.tsx` —— 改了会让「入口文件名」这个约定本身变松。
 */
createRoot(el).render(createElement(DesktopLyrics));
