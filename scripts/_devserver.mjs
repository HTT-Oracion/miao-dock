/**
 * 前端 dev server 的按需拉起 —— `lifespan-selftest.mjs` 与 `capture.mjs` 共用。
 *
 * dev 构建下 Tauri 的 WebView 指向 `http://localhost:1420`，所以跑应用前它得先起来。
 * 已经有在跑的就直接用（不去抢），否则自己起一个并在结束时关掉。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function portOpen(port, timeout = 500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/**
 * 确保 dev server 在跑。返回它自己起的子进程（已有的则返回 null）。
 * 找不到 vite 或超时就 exit(2) —— 这是环境没准备好，不是测试失败。
 */
export async function ensureDevServer({ root, port = 1420 } = {}) {
  if (await portOpen(port)) return null;
  const vite = path.join(root, 'app', 'node_modules', '.bin', 'vite');
  if (!existsSync(vite)) {
    console.error(`找不到 vite：${vite}\n先在 app/ 下 npm install`);
    process.exit(2);
  }
  const child = spawn(vite, ['--port', String(port), '--strictPort'], {
    cwd: path.join(root, 'app'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (await portOpen(port)) return child;
  }
  child.kill('SIGTERM');
  console.error(`dev server 未在 15s 内就绪（端口 ${port}）`);
  process.exit(2);
}
