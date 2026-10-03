/**
 * 父进程看门狗
 *
 * **为什么需要它**：ServiceManager 只在**正常退出**路径（`RunEvent::ExitRequested`）里
 * 调 `stop()`。主进程若崩溃或被强杀（SIGKILL 不可捕获），Rust 侧根本没有机会清理，
 * 此时子进程只能自救。
 *
 * **为什么不能靠现状**：Rust 用 `Stdio::piped()` 接子进程 stdout，主进程死后管道破裂，
 * 子进程下次写日志会因 EPIPE 退出 —— 但那是**副作用而非保障**：若不巧没有日志写入，
 * 进程就会一直赖着占住 5180。而契约《02》B4 要求「退出后 5180 释放、子进程无残留」，
 * 故这里做显式看守。
 *
 * **判据**：父进程消失后 `getppid()` 变为 1（被 launchd 收养）；另用 `kill(ppid, 0)`
 * 做存活探测兜底，覆盖尚未发生 reparent 的窗口。两条件任一命中即自我退出。
 */
export function watchParent({ intervalMs = 2000 } = {}) {
  // 逃生开关：调试时可能需要把服务独立于 Box 壳运行（例如手工压测、或用 curl 长时间观察）
  if (process.env.MIAO_NO_PARENT_WATCH === '1') return () => {};

  const bootPpid = process.ppid;
  // 不是被别的进程拉起来的（例如开发者直接 `node service/src/server.mjs`），无需看守
  if (!bootPpid || bootPpid <= 1) return () => {};

  const timer = setInterval(() => {
    if (process.ppid === 1 || process.ppid !== bootPpid) {
      process.exit(0);
    }
    try {
      process.kill(bootPpid, 0);
    } catch {
      process.exit(0);
    }
  }, intervalMs);
  // 看门狗本身不该阻止进程从其它路径正常退出
  if (typeof timer.unref === 'function') timer.unref();

  return () => clearInterval(timer);
}
