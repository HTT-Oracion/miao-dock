#!/usr/bin/env node
/**
 * 通用子进程看守（E11）—— 把**任意**命令包起来，父进程一死就带着整棵子树退出。
 *
 * ## 为什么需要它（以及为什么不能用别的东西）
 * `service/src/parent-watch.mjs` / `engine/src/parent-watch.mjs` 只能装进**我们自己的
 * Node 进程**。而真模式下 ② 是 `python main.py`、③ 是 `llama-server` —— **外部二进制**，
 * 改不了、也指望不上它们自己看住 ppid。主进程被 SIGKILL 后它们会被 reparent 到 launchd
 * 并继续占着 8000 / 8001 / 8080，正是 E11 要消灭的孤儿。
 * ⇒ 用这个薄看守包一层：看守盯 ppid，被看守进程放进**独立进程组**，父死时整组带走。
 *
 * 为什么不靠 Rust 侧的进程组：Rust 主进程被 SIGKILL 时**没有任何代码会执行**，
 * 它对进程组做的任何事都不会发生。能自救的只有还活着的进程。
 *
 * ## 用法
 *   node engine/scripts/child-watch.mjs -- <cmd> [args...]
 *   MIAO_CHILD_CWD   被看守进程的工作目录（默认继承）
 *   MIAO_NO_PARENT_WATCH=1  逃生开关：只做透明转发（调试用；也是 E11 的反证开关）
 *
 * ## 退出码
 *   被看守进程的退出码；被信号杀死则 128+signal。看守自身不吞错。
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const sep = process.argv.indexOf('--');
const cmd = sep > -1 ? process.argv.slice(sep + 1) : [];
if (cmd.length === 0) {
  console.error('用法：node engine/scripts/child-watch.mjs -- <cmd> [args...]');
  process.exit(2);
}

const cwd = process.env.MIAO_CHILD_CWD || process.cwd();
const watchEnabled = process.env.MIAO_NO_PARENT_WATCH !== '1';
const log = (m) => console.log(`[child-watch] ${m}`);

const child = spawn(cmd[0], cmd.slice(1), {
  cwd,
  stdio: 'inherit',
  // POSIX：新会话/新进程组 ⇒ `kill(-pid)` 能带走整棵子树（含 llama-server 自己 fork 的东西）
  detached: process.platform !== 'win32',
  env: process.env,
});

/** 带走整棵子树。Windows 用 taskkill /T；POSIX 用对进程组发信号。 */
function killTree(sig) {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    // 🔴 Windows 上「先礼」（不带 /F）对**控制台进程无效**（D-89）：`taskkill /T` 不带
    // /F 对 node 返回 255、对 Python 返回 128，目标进程一个不死。所以 Windows 上无论
    // SIGTERM 还是 SIGKILL 都直接 /F —— 平台没有「优雅」这一档，硬保留先礼只会空等、
    // 还给孙进程（执行器）被 reparent 成孤儿占着 port+1 的窗口。
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* ignore */
    }
  }
}

let exiting = false;
function shutdown(reason, delayMs) {
  if (exiting) return;
  exiting = true;
  log(`${reason} ⇒ 带走子树 ${cmd[0]}`);
  killTree('SIGTERM');
  setTimeout(() => {
    killTree('SIGKILL');
    process.exit(0);
  }, delayMs).unref();
}

// ① 父进程死亡看守：ppid 变化（被 reparent）或直接变成 1，都说明主进程没了
if (watchEnabled) {
  const bootPpid = process.ppid;
  if (!bootPpid || bootPpid <= 1) {
    // **出生即孤儿**：看守还没起来、父进程就已经没了（ppid 直接是 1）。
    // 这个窗口是真实存在的（spawn 与 exec 之间父进程死掉），而旧写法会在这里**静默地不装看守**
    // ⇒ 整棵子树变孤儿，且看起来"跑得好好的"。实测踩到过（见 docs/spec-notes.md D-68）。
    shutdown('启动时父进程已不在（出生即孤儿）', 600);
  } else {
    setInterval(() => {
      if (process.ppid === 1 || process.ppid !== bootPpid) shutdown('父进程已消失', 1200);
      try {
        process.kill(bootPpid, 0);
      } catch {
        shutdown('父进程已消失(kill 0)', 1200);
      }
    }, 1000).unref();
  }
}

// ② 自己被要求停：把信号转给子树（否则只有看守退、被看守进程变孤儿）
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(`收到 ${sig}`, 1500));
}

const SIG_NUM = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
child.on('exit', (code, signal) => {
  process.exit(code ?? 128 + (SIG_NUM[signal] || 0));
});
child.on('error', (e) => {
  console.error(`[child-watch] 无法启动 ${cmd[0]}：${e.message}`);
  process.exit(1);
});
