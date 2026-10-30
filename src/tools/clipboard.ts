/**
 * 剪贴板写入的唯一接缝。
 *
 * ## 为什么不用 `navigator.clipboard`
 * 桌面端跑在 Tauri 的 WebView 里，`navigator.clipboard.writeText` 要求**安全上下文 + 用户手势**，
 * 且被拒时只抛一个 DOMException —— 在打包后的 `tauri://` 协议下它与开发态行为并不一致，
 * 表现为"点了复制没反应，也不报错"。
 *
 * 所以走宿主自己的能力：`@tauri-apps/plugin-clipboard-manager` 的 `writeText`。
 * 它由 Rust 侧执行，与页面上下文无关，失败时是**可捕获的 IPC 错误**。
 *
 * ## 为什么要留浏览器回退
 * `npm run dev`（纯 Vite，无 Rust 宿主）与自动化探针里没有 Tauri IPC。
 * 那里退回 `navigator.clipboard`，并在它也不可用时抛错 —— **绝不静默成功**
 * （静默成功与静默失败在界面上长得一模一样，是本仓反复记过的一类缺陷）。
 */
import { writeText as tauriWriteText } from '@tauri-apps/plugin-clipboard-manager';

/** 当前是否跑在 Tauri 宿主里（与 `@tauri-apps/api` 的判定同一口径） */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 把文本写进系统剪贴板。
 *
 * @throws 两条路都不可用时抛错（调用方负责把它变成可见的失败反馈）
 */
export async function copyText(text: string): Promise<void> {
  if (inTauri()) {
    await tauriWriteText(text);
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error('当前环境没有可用的剪贴板');
}
