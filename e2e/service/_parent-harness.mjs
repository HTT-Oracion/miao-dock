// 测试专用：充当 box-service 的「假父进程」
//
// 用途：验证父进程看守（service/src/parent-watch.mjs）。
// 自测进程不能亲自当父进程 —— 要验证看守，就必须把一个父进程**强杀**掉，
// 而 SIGKILL 会连自测一起带走。于是用一个中间进程顶替「Box 壳」的位置：
//
//   自测 ──spawn──> 假父进程 ──spawn──> box-service
//                     ↑ SIGKILL 这里，观察 service 是否自救
//
// **为什么子进程的 stdio 要落到文件而不是管道**：
// 若用管道，假父进程一死，管道的读端就没了，子进程下次写日志会因 EPIPE 而退出 ——
// 那样这个用例会变成**假阳性**：看着"看守生效"，实际只是管道破裂的副作用。
// 契约 B4 要验的是看守本身，所以这里必须杜绝 EPIPE。
//
// 不参与生产路径，仅被 e2e/service/selftest.mjs 的 A18 用例使用。
//
// 用法：node _parent-harness.mjs <entry.mjs>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// F0：靶子由 `_service-harness.mjs` 解析 —— 这样 `MIAO_SERVICE_IMPL=rust` 时，本假父进程
// 拉起的也是 **Rust 服务**（否则 A18 会静默变成"假父进程拉起的是 node、而别的用例打的是 rust"）。
import { targetFor } from './_service-harness.mjs';

const entry = process.argv[2];
if (!entry) {
  console.error('用法：node _parent-harness.mjs <entry.mjs>');
  process.exit(2);
}

const logPath = process.env.MIAO_HARNESS_LOG || path.join(os.tmpdir(), 'miao-harness-service.log');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const log = fs.openSync(logPath, 'a');

const { command, args } = targetFor(entry);
const child = spawn(command, args, {
  stdio: ['ignore', log, log], // ← 文件，不是管道：杜绝 EPIPE 这个干扰项
  env: process.env,
});
// 只报 pid：自测用 MIAO_PORT 显式指定端口，无需从 stdout 解析就绪行
console.log(`HARNESS_CHILD_PID ${child.pid}`);

// 只负责「当着父进程」，直到被强杀
setInterval(() => {}, 1 << 30);
