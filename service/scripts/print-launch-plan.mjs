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
const { resolveEngineLaunch, resolveLlmLaunch } = await import('../src/engine-client.mjs');

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

let plan;
if (raw === 'mock') {
  // ── 模拟模式：两个 Node 替身（仓内 engine/src/*），用来在**秒级、可反证**的条件下
  //    跑通完整的三进程生命周期。真实模式才有 Python / llama-server。
  plan = {
    mode: 'mock',
    serviceEnv: { MIAO_ENGINE_PROTOCOL: 'mock', MIAO_ENGINE_PORT: String(ENGINE_PORT) },
    llm: {
      label: 'llm',
      cmd: [process.execPath, path.join(ROOT, 'engine', 'src', 'mock-llm.mjs'), '--port', String(LLM_PORT)],
      cwd: null,
      env: {},
      probes: [
        { kind: 'tcp', port: LLM_PORT },
        { kind: 'http', port: LLM_PORT, method: 'GET', path: '/v1/models', expect: 200 },
      ],
    },
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
  const llm = resolveLlmLaunch({ port: LLM_PORT });
  plan = {
    mode: 'real',
    serviceEnv: {
      MIAO_ENGINE_PROTOCOL: 'real',
      MIAO_ENGINE_PORT: String(ENGINE_PORT),
      SAKURA_API_BASE: `http://127.0.0.1:${LLM_PORT}/v1`,
    },
    // `watch: true` ⇒ Rust 起这两个外部二进制时会用 `engine/scripts/child-watch.mjs` 包一层。
    // 理由见该脚本头：python / llama-server 是外部二进制，改不了它们，指望不上"自退"；
    // 主进程被 SIGKILL 后它们会成为占住 8000/8001/8080 的孤儿（E11 要消灭的正是这个）。
    // mock 侧不需要：那两个替身是我们自己的 Node 进程，内部已装父死看管。
    // 探针预算按**真实首启耗时**给：python 要 import torch 全家桶、llama-server 要读几 GB 权重，
    // 默认的 20s 会把"还在加载"直接判成"起不来"（而这恰恰是最容易被误判成"引擎坏了"的场景）。
    llm: { ...llm, env: envPatch(llm), watch: true, probes: llm.probes, probe_timeout_ms: 180_000 },
    engine: {
      ...engine,
      env: envPatch(engine),
      watch: true,
      probes: engine.probes,
      probe_timeout_ms: 240_000,
    },
  };
}

console.log(JSON.stringify(plan));
