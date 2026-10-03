/**
 * 父进程看门狗（与 service/src/parent-watch.mjs 同构，刻意各自独立）
 *
 * 引擎是被 Rust 壳拉起的子进程，同样面临「主进程崩溃后变孤儿、占住端口」的问题。
 * 之所以不复用 service 那份、而在这里再放一份：引擎是**可被真实 mangatranslator
 * sidecar 整体顶替**的模块（见 docs/spec-notes.md D-09），让它 import 仓库里的共享
 * 代码会制造错误的耦合 —— 顶替时整目录废弃即可。二十行重复换一个干净边界，值得。
 *
 * 注意：真实 sidecar 接入后本文件随之废弃，届时引擎残留要靠 sidecar 自身或
 * 启动前的端口探测来兜底（Box 侧在端口段内自动让位，见契约 §1）。
 */
export function watchParent({ intervalMs = 2000 } = {}) {
  // 逃生开关：与 service 侧同名，便于手工调试时把引擎独立运行
  if (process.env.MIAO_NO_PARENT_WATCH === '1') return () => {};

  const bootPpid = process.ppid;
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
  if (typeof timer.unref === 'function') timer.unref();

  return () => clearInterval(timer);
}
