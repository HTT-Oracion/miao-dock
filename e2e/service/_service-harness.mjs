// 服务靶子抽象（F0）—— **服务入口解析的唯一事实源**
//
// ## 为什么要有它
// F 组之前的现状是：**19 个 `e2e/service/*.mjs` 各自硬编码 Node 靶子**
// （`SERVICE_ENTRY = path.join(ROOT, 'service', 'src', 'server.mjs')` + `spawn(process.execPath, [SERVICE_ENTRY])`），
// 且 `e2e/` 下**没有任何服务相关的共享 harness**。这带来两个后果：
//   1. 「换一整套服务实现」要改 19 个文件、19 个入口推导 —— 必然漏、且漏了不报错；
//   2. Rust 服务在 app 进程内时，e2e **无从 spawn**（没有可执行文件给你起）。
//
// 因此 F0 把「靶子是谁」收敛到**这一个文件**：各脚本只声明「我要起一个服务」，由本模块决定
// 起的是 Node 版还是 Rust 版。⇒ 这就是文档 §0 说的「e2e 改靶子抽象、**不改断言**」。
//
// ## 切换方式
//   `MIAO_SERVICE_IMPL=node`（默认）→ `spawn(process.execPath, [service/src/server.mjs, ...argv])`
//   `MIAO_SERVICE_IMPL=rust`         → `spawn(<boxsvc 可执行>, argv)`
// Rust 靶子路径：`MIAO_BOXSVC_BIN` 显式覆盖 → 否则在 `<repo>/app/src-tauri/target/{debug,release}/` 里找
// `boxsvc[.exe]`（迁移期用 dev profile，见计划文档 R8：release 编译以分钟计）。
//
// ## 为什么不改断言
// 本模块**只决定「起谁」**，不碰任何 HTTP 断言：端口 / 令牌 / 就绪行协议 / 端点契约全部不变
// （Rust 侧同样打印 `MIAO_READY {...}` 就绪行、同样读 `MIAO_*` 环境变量）。于是同一套断言
// 天然能在两个靶子上跑 —— 这正是「契约等价」**唯一能反证**的机制（R17）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/e2e/service
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** 目标实现：`node`（默认）或 `rust`。大小写不敏感；未知值一律落回 `node` 并**吵一声**。 */
export const IMPL = (() => {
  const raw = (process.env.MIAO_SERVICE_IMPL || 'node').trim().toLowerCase();
  if (raw === 'rust') return 'rust';
  if (raw !== 'node' && raw !== '') {
    // 🔴 R16：拼错 `MIAO_SERVICE_IMPL` 会**静默落回 node**（"两边都绿"其实是 node 跑了两遍）。
    //    这里不报错（夹具不该因为一个环境变量拼错就崩），但**必须可见** —— 由断言侧核对
    //    「落到 node 的文件数 = 预期」来兜底（见 harness-check.mjs）。
    process.stderr.write(`[service-harness] ⚠️ 未知 MIAO_SERVICE_IMPL=${JSON.stringify(raw)}，落回 node\n`);
  }
  return 'node';
})();

/** Node 靶子入口（唯一推导点）。 */
export const NODE_ENTRY = path.join(REPO_ROOT, 'service', 'src', 'server.mjs');

/**
 * Rust 靶子（`boxsvc` 可执行）路径。
 * 迁移期在 dev profile 下构建；找不到时**不在这里抛**（很多脚本只想跑 node，不该被带崩），
 * 只在真正要用 rust 且找不到时抛（见 `targetFor`）。
 */
export function resolveRustBin() {
  const fromEnv = process.env.MIAO_BOXSVC_BIN;
  if (fromEnv && fromEnv.trim() !== '') return path.resolve(fromEnv.trim());
  const exe = process.platform === 'win32' ? 'boxsvc.exe' : 'boxsvc';
  const base = path.join(REPO_ROOT, 'app', 'src-tauri', 'target');
  for (const profile of ['debug', 'release']) {
    const p = path.join(base, profile, exe);
    if (fs.existsSync(p)) return p;
  }
  return path.join(base, 'debug', exe); // 未构建时的「应该是这里」——供报错文本使用
}

export const RUST_BIN = resolveRustBin();

/**
 * 向后兼容别名：历史上各脚本用它拼 `spawn(process.execPath, [SERVICE_ENTRY, ...])`。
 * 语义上它就是 **Node 靶子入口**；真正的「起谁」由 `targetFor` 决定。
 */
export const SERVICE_ENTRY = NODE_ENTRY;

/** 判断一个入口是不是「服务靶子」（服务 vs 引擎 vs 其它脚本）—— 逐字节比，避免路径写法差异。 */
export function isServiceEntry(entry) {
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(NODE_ENTRY);
  } catch {
    return false;
  }
}

/**
 * 把「入口 + 附加参数」解析成「真正要 spawn 的 command + args」。
 *
 * · 入口是服务 ⇒ 按 `MIAO_SERVICE_IMPL` 选靶子：
 *     node → `process.execPath [service/src/server.mjs, ...extraArgv]`
 *     rust → `<boxsvc>, ...extraArgv`（`boxsvc` 自身读 `MIAO_*` 环境变量，无位置参数）
 * · 入口**不是**服务（例如 mock 引擎、其它脚本）⇒ 原样走 node，**不被本开关影响**。
 *   这一点是刻意的：夹具里 engine / parent-harness / refute-child 都不是服务，混进来会
 *   让「切服务实现」意外改掉别的进程。
 */
export function targetFor(entry, extraArgv = []) {
  if (isServiceEntry(entry)) {
    if (IMPL === 'rust') {
      if (!fs.existsSync(RUST_BIN)) {
        throw new Error(
          `MIAO_SERVICE_IMPL=rust 但找不到 Rust 靶子：${RUST_BIN}\n` +
            `先构建：cd app/src-tauri && cargo build --bin boxsvc\n` +
            `或设 MIAO_BOXSVC_BIN 指向已构建的 boxsvc。`,
        );
      }
      return { command: RUST_BIN, args: [...extraArgv] };
    }
    return { command: process.execPath, args: [NODE_ENTRY, ...extraArgv] };
  }
  return { command: process.execPath, args: [entry, ...extraArgv] };
}

/**
 * 起一个进程（服务或其它），env/stdio 默认与各脚本既有写法一致。
 * 调用方保留自己的 ready 行解析与状态对象 —— 本函数只管「command/args 怎么定」。
 */
export function spawnTarget(entry, env, extraArgv = [], opts = {}) {
  const { command, args } = targetFor(entry, extraArgv);
  return spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}
