/**
 * 「关闭下载」的确认记录。
 *
 * ## 为什么需要它
 * `done` 是**持久态**：下载完成后状态文件一直保留。没有 dismissal 时，侧栏的完成图标
 * 在关闭后仍会存在，重启应用又冒出来一次。这里按 `startedAt` 记账：用户关闭了**某一次**
 * 下载，下一次下载的 `startedAt` 不同 ⇒ 入口自动重现。
 */

const DISMISS_KEY = 'miao.engine-download.dismissed';

/** 已关闭的那一次下载的 `startedAt`；没有则为 null。 */
export function initialDismissedDownload(): string | null {
  return localStorage.getItem(DISMISS_KEY);
}

export function persistDismissedDownload(startedAt: string): void {
  localStorage.setItem(DISMISS_KEY, startedAt);
}
