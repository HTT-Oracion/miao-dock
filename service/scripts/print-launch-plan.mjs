#!/usr/bin/env node
/**
 * 打印**引擎栈启动配方**（JSON 到 stdout）—— 供 Rust 侧 `ServiceManager` 消费。
 *
 * 为什么要有这么一个"打印器"：
 *   S2 起，`ServiceManager` 要按进程类型分派 spawn（Node / Python 可执行 / llama-server），
 *   也就是 Rust 必须知道「拿什么命令、什么 cwd、什么环境变量、按什么探针判就绪」。
 *   而这些**全是引擎侧细节**，已经在 `service/src/engine-client.mjs` 里（唯一耦合点）。
 *   若在 Rust 里再写一份 ⇒ 换引擎版本时必然漏改一处。
 *   ⇒ Rust 在启动时问一次这里，把"怎么拼"留在 JS，"怎么管"留在 Rust。
 *
 * 用法：
 *   node service/scripts/print-launch-plan.mjs [real|mock]
 *   未给参数时读 `MIAO_ENGINE_PROTOCOL`（与 service 侧同一个开关，默认 real）。
 *
 * ⚠️ S4 起 ③（LLM）的**归属权移交给了 box-service**（《04》§9.1：Tier1 空闲卸载的实现方是
 *    box-service，③ 不在引擎 TTL 范围内）。本脚本仍**照常给出 ③ 的完整配方**，但会带上
 *    `owner: "service"` —— Rust 只拿它**打印生效参数快照**（E1），不再据它 spawn，
 *    真正的拉起由 `service/src/settings/llm-supervisor.mjs` 按**同一份** `resolveLlmLaunch()` 执行。
 *
 * ⚠️ 本脚本 import `config.mjs`，而它在模块顶层会 `ensureToken()` **写 state/token 文件**。
 *    打印配方是只读操作，不该有落盘副作用 ⇒ 先把 `MIAO_TOKEN` 置成固定值
 *    （`ensureToken()` 见到 override 会直接返回，不碰磁盘）。
 */
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODES = new Set(['real', 'mock']);

const raw = (process.argv[2] || process.env.MIAO_ENGINE_PROTOCOL || 'real').trim().toLowerCase();
if (!MODES.has(raw)) {
  console.error(`模式非法：${JSON.stringify(raw)}（可选：real | mock）`);
  process.exit(2);
}

// 只读：别让 config 顶层写 token 文件
process.env.MIAO_TOKEN ||= '0'.repeat(64);
// **必须在 import config 之前**把协议钉成命令行要的那个：
// `config.enginePort` 是**按协议分档**的（real=8000 / mock=5003，见 config.mjs）。
// 若这里不设，mock 配方会拿到 8000 —— 于是模拟引擎被起在真引擎的水位上，
// 端口语义整体错位，而 `lifespan-selftest` 之类的外部观察者还在盯 5003。
process.env.MIAO_ENGINE_PROTOCOL = raw;

const { config } = await import('../src/config.mjs');
const { resolveEngineLaunch, resolveLlmLaunch, LLM_OWNER } = await import('../src/engine-client.mjs');

const ENGINE_PORT = config.enginePort;
const LLM_PORT = Number.parseInt(process.env.MIAO_LLM_PORT || '8080', 10);

/** 把配方里的 `env`（含 `...process.env`）压成"相对当前进程环境的差分"，Rust 只该设差量。 */
function envPatch(plan) {
  const out = {};
  for (const [k, v] of Object.entries(plan.env || {})) {
    if (process.env[k] !== v) out[k] = v;
  }
  return out;
}

/**
 * ③ 的条目：**只给 Rust 打印用，不给 Rust 拉起**（`owner: 'service'`）。
 *
 * 为什么保留这条条目而不是直接给 `null`：E1 的判据是「**日志打印生效参数快照**」——
 * 快照本该逐条列出真正会被执行的东西。③ 仍然会被执行（只是执行者是 box-service），
 * 把它从快照里删掉，等于让 E1 从"四条"退化成"三条"，**看着仍然绿，覆盖却悄悄少一块**。
 *
 * 为什么归属权要显式写在配方里：Rust 若照旧拉起 ③，就会和 box-service 拉起的那个
 * **抢同一个 8080**（症状是两个 llama-server 互相踩、谁报错都看不出根因）。
 * 把归属写成契约字段，是让"谁拉起"这件事**只能有一个答案**。
 */
function llmEntry() {
  const llm = resolveLlmLaunch({ port: LLM_PORT });
  return {
    ...llm,
    env: envPatch(llm),
    owner: LLM_OWNER,
    // 真档是外部二进制（改不了、指望不上自退）⇒ 由 box-service 用 child-watch 包一层，
    // 保住 E11 的"主进程被强杀后不留孤儿"；mock 档是自家 Node 替身，内部已装父死看管。
    watch: config.engineProtocol === 'real',
    probes: llm.probes,
    ...(config.engineProtocol === 'real' ? { probe_timeout_ms: 180_000 } : {}),
  };
}

let plan;
if (raw === 'mock') {
  // ── 模拟模式：两个 Node 替身（仓内 engine/src/*），用来在**秒级、可反证**的条件下
  //    跑通完整的三进程生命周期。真实模式才有 Python / llama-server。
  plan = {
    mode: 'mock',
    serviceEnv: { MIAO_ENGINE_PROTOCOL: 'mock', MIAO_ENGINE_PORT: String(ENGINE_PORT) },
    llm: llmEntry(),
    engine: {
      label: 'engine',
      cmd: [process.execPath, path.join(ROOT, 'engine', 'src', 'server.mjs')],
      cwd: null,
      env: { MIAO_ENGINE_PORT: String(ENGINE_PORT) },
      probes: [
        { kind: 'tcp', port: ENGINE_PORT },
        { kind: 'http', port: ENGINE_PORT, method: 'GET', path: '/ready', expect: 200 },
      ],
    },
  };
} else {
  const engine = resolveEngineLaunch();
  plan = {
    mode: 'real',
    serviceEnv: {
      MIAO_ENGINE_PROTOCOL: 'real',
      MIAO_ENGINE_PORT: String(ENGINE_PORT),
      SAKURA_API_BASE: `http://127.0.0.1:${LLM_PORT}/v1`,
    },
    llm: llmEntry(),
    engine: {
      ...engine,
      env: envPatch(engine),
      // `watch: true` ⇒ Rust 起 ② 时会用 `engine/scripts/child-watch.mjs` 包一层。
      // 理由见该脚本头：python 是外部二进制，改不了、指望不上自退；主进程被 SIGKILL 后
      // 它会连执行器（孙进程）一起变成占住 8000/8001 的孤儿（E11 要消灭的正是这个）。
      // 探针预算按**真实首启耗时**给：python 要 import torch 全家桶，默认 20s 会把
      // "还在加载"直接判成"起不来"（而这恰恰是最容易被误判成"引擎坏了"的场景）。
      watch: true,
      probes: engine.probes,
      probe_timeout_ms: 240_000,
    },
  };
}

console.log(JSON.stringify(plan));
