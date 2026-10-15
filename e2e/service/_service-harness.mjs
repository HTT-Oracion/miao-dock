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
// ## 靶子：**只剩一个**（node 档已随 `service/` 退役，D-205）
//   `spawn(<boxsvc 可执行>, argv)`
// Rust 靶子路径：`MIAO_BOXSVC_BIN` 显式覆盖 → 否则在 `<repo>/src-tauri/target/{debug,release}/` 里找
// `boxsvc[.exe]`（迁移期用 dev profile，见计划文档 R8：release 编译以分钟计）。
//
// 🔴 为什么只剩一个：F5 摘除 Node 服务层之后，本轮又把**仓库里的 `service/`** 删了。
//    双靶（`MIAO_SERVICE_IMPL=rust|node`）存在的唯一理由是「两套实现打同一套断言、证明契约等价」——
//    而对照端早已逐块改成 **冻结 golden**（无对照端也能验，D-199/200/203）。
//    ⇒ `MIAO_SERVICE_IMPL=node` 现在**抛错**，不静默落回：静默落回会把「双靶对拍」悄悄变成
//    「同一个靶子跑了两遍」的**假绿**，而它看起来完全正常（R16 的教训：错的绿比红危险）。
//
// ## 为什么不改断言
// 本模块**只决定「起谁」**，不碰任何 HTTP 断言：端口 / 令牌 / 就绪行协议 / 端点契约全部不变
// （Rust 侧同样打印 `MIAO_READY {...}` 就绪行、同样读 `MIAO_*` 环境变量）。于是同一套断言
// 天然能在两个靶子上跑 —— 这正是「契约等价」**唯一能反证**的机制（R17）。
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/e2e/service
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** ③ 护栏目录：空目录 ⇒ ③ 被懒加载也秒失（详见 `spawnTarget` 里的注释）。 */
const NO_MODELS_DIR = path.join(os.tmpdir(), 'miao-fixture-no-models');

/**
 * 目标实现。node 档退役后**只剩 `rust`**，它是个常量而不是 env 推导 —— 保留这个名字是给
 * `targetFor` / 断言侧留一个可读的语义锚点（而不是到处写 `'rust'` 字面量）。
 *
 * 🔴 三条 env 语义（区别很重要，别合并）：
 *   · 未设 / 空 / `rust` ⇒ 正常。
 *   · `node` ⇒ **抛错**。它不是"未知值"，而是一个**曾经合法、现已退役**的值 ——
 *     使用者多半是在跑双靶对拍。那种情况下静默落回 rust 会**同时**做两件坏事：
 *     把"两套实现对拍"变成"一套跑两遍"（假绿），且让人以为 node 那侧还在被测。
 *   · 其它任何值 ⇒ 落回 rust 但**吵一声**（R16：拼错环境变量导致的假绿最难查），
 *     并由 `harness-check` 的 H7 断言「stderr 里确实有这句话」兜底。
 */
export const IMPL = 'rust';

(() => {
  const raw = (process.env.MIAO_SERVICE_IMPL || '').trim().toLowerCase();
  if (raw === 'node') {
    throw new Error(
      'MIAO_SERVICE_IMPL=node 已退役：Node 服务实现（service/）已从仓库删除。\n' +
        'e2e 现在只有一个靶子（boxsvc）。原先靠 node 档做对照端的检查已改**冻结 golden**\n' +
        '（D-199 / D-200 / D-203），不再需要第二个实现。',
    );
  }
  if (raw !== '' && raw !== 'rust') {
    process.stderr.write(`[service-harness] ⚠️ 未知 MIAO_SERVICE_IMPL=${JSON.stringify(raw)}，落回 rust\n`);
  }
})();

/**
 * Rust 靶子（`boxsvc` 可执行）路径。
 * 迁移期在 dev profile 下构建；找不到时**不在这里抛**（很多脚本只想跑 node，不该被带崩），
 * 只在真正要用 rust 且找不到时抛（见 `targetFor`）。
 */
export function resolveRustBin() {
  const fromEnv = process.env.MIAO_BOXSVC_BIN;
  if (fromEnv && fromEnv.trim() !== '') return path.resolve(fromEnv.trim());
  const exe = process.platform === 'win32' ? 'boxsvc.exe' : 'boxsvc';
  const base = path.join(REPO_ROOT, 'src-tauri', 'target');
  for (const profile of ['debug', 'release']) {
    const p = path.join(base, profile, exe);
    if (fs.existsSync(p)) return p;
  }
  return path.join(base, 'debug', exe); // 未构建时的「应该是这里」——供报错文本使用
}

export const RUST_BIN = resolveRustBin();

/**
 * 服务靶子的**哨兵入口** —— 注意它**不再是文件路径**。
 *
 * 各脚本仍按老样子 `spawnTarget(SERVICE_ENTRY, env)` 表达「我要起一个服务」，由 `targetFor`
 * 决定起谁 —— 20+ 个脚本**零改动**。「只决定起谁、不碰任何断言」这条 F0 纪律，
 * 在退役这一侧同样成立。
 *
 * 🔴 为什么退化成字符串而不是删掉：删掉就要改 20+ 个调用点，而每个调用点都得换一个
 *    「表示服务」的说法 —— 那是在**表示法**上做迁移，会把一次机制退役摊成几十处无关改动，
 *    反而看不清真正变了什么（变了的是**靶子的数量**，不是"怎么表达要起服务"）。
 *    ⚠️ 也因此它**不是路径**：任何 `path.resolve(SERVICE_ENTRY)` / `fs.existsSync(SERVICE_ENTRY)`
 *    都是 bug —— 原先这么写的地方随 node 档一并消失了（`isServiceEntry` 已改为等值比较）。
 */
export const SERVICE_ENTRY = '__miao_service_target__';

/** 判断一个入口是不是「服务靶子」（服务 vs 引擎 vs 其它脚本）—— 等值比，因为它是哨兵不是路径。 */
export function isServiceEntry(entry) {
  return entry === SERVICE_ENTRY;
}

/**
 * 把「入口 + 附加参数」解析成「真正要 spawn 的 command + args」。
 *
 * · 入口是服务 ⇒ `<boxsvc>, ...extraArgv`（`boxsvc` 自身读 `MIAO_*` 环境变量，无位置参数）
 * · 入口**不是**服务（例如 mock 引擎、其它脚本）⇒ 原样走 node，**不受服务靶子影响**。
 *   这一点是刻意的：夹具里 engine / parent-harness / refute-child 都不是服务，
 *   混进来会让「换服务实现」意外改掉别的进程。
 */
export function targetFor(entry, extraArgv = []) {
  if (isServiceEntry(entry)) {
    if (!fs.existsSync(RUST_BIN)) {
      throw new Error(
        `找不到 Rust 靶子：${RUST_BIN}\n` +
          `先构建：cd src-tauri && cargo build --bin boxsvc\n` +
          `或设 MIAO_BOXSVC_BIN 指向已构建的 boxsvc。`,
      );
    }
    return { command: RUST_BIN, args: [...extraArgv] };
  }
  return { command: process.execPath, args: [entry, ...extraArgv] };
}

/**
 * 杀**进程树**（清理夹具子进程用）。
 *
 * 🔴 为什么不能只用 `child.kill()`：rust 服务进程序列化后会派生子进程（引擎② sidecar、
 *    ③ llama-server），Windows 上 `child.kill()` **只结束主进程**，孙进程全成孤儿 ——
 *    实测攒了 12 个 llama-server（每个 3.5 GB 权重）把机器卡死、别的应用跟着崩（D-202）。
 *    `taskkill /T /F` 连子树一起收；主进程已退出时它返回非 0，那不是失败。
 *
 * ⚠️ **只用于"清理"**，不要用于语义性 kill：`SIGSTOP`（挂起后验中断落盘）、`SIGKILL`
 *    （模拟崩溃、不给清理机会）、"只杀假父进程验看守"这类用法，杀棵树会改变被测语义。
 *
 * @param {import('node:child_process').ChildProcess} child
 */
export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* 进程已退出 */
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

/**
 * 起一个进程（服务或其它），env/stdio 默认与各脚本既有写法一致。
 * 调用方保留自己的 ready 行解析与状态对象 —— 本函数只管「command/args 怎么定」。
 */
export function spawnTarget(entry, env, extraArgv = [], opts = {}) {
  const { command, args } = targetFor(entry, extraArgv);
  const merged = { ...process.env, ...env };
  // 🔴🔴 **③ 的护栏**（D-202 第四节）：rust 服务进程序列化后会派生子进程，其中 ③（llama-server）
  //    每个背着几 GB 权重。`MIAO_NO_LLM_AUTOSTART` 只挡**预拉起**，挡不住"翻译那一刻"的
  //    **懒加载**（`server.mjs` 原注释明说那条路有懒加载兜底）⇒ 每轮测试拉一个，几轮下来
  //    攒十来个，直接把机器卡死、别的应用跟着崩（实测 12 个 llama-server 吃掉一半内存）。
  //    ⇒ 模型根默认指向一个**空目录**：③ 就算被懒加载也秒失（找不到权重），不占内存。
  //    ⚠️ 只在**调用方没显式给**时才注入：真要读模型的检查（models-guide / model-runner /
  //    size-guide / contract 的夹具）都自己传 `MIAO_MODEL_ROOT`，让位给它们；
  //    要"③ 在跑"的实例（contract 的 H）自己占住 `MIAO_LLM_PORT`，同样不受影响。
  if (command === RUST_BIN && !merged.MIAO_MODEL_ROOT) {
    try {
      fs.mkdirSync(NO_MODELS_DIR, { recursive: true });
    } catch {
      /* 建不了就不注入 —— 护栏失效好过把检查搞挂 */
    }
    merged.MIAO_MODEL_ROOT = NO_MODELS_DIR;
  }
  return spawn(command, args, {
    env: merged,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}
