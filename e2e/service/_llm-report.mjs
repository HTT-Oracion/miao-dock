#!/usr/bin/env node
/**
 * F4-b2 引擎③ supervisor 的用例表 + Rust 侧取证 —— golden 生成器与对拍脚本**共用的唯一一份**。
 * =============================================================================
 * 为什么单独一个文件：`check:llm-supervisor` 原先是「Rust `boxsvc --llm-selftest` ⟷ Node
 * 真 `LlmSupervisor`」双靶对拍。F5 摘除 Node 服务层后没有对照对象，改以冻结 golden 快照作
 * **单向金标**。用例表（场景 / 超时 / launch spec）与「怎么跑 Rust」必须两边同一份 ——
 * 各写一遍 = 用例悄悄少一个都不会有人发现。
 *
 * ## 为什么 mock-llm.mjs 仍要留着
 * 它是**测试替身**（`/v1/models` → 200 的最小 LLM），不是产品运行时：Rust 侧要有一个
 * 「真的会监听端口」的子进程来验就绪探针，Node 侧原本也喂同一份。与 engine-http 的伪引擎
 * 同理 —— 摘 Node 摘的是**产品运行时与随包**，不是夹具。
 *
 * ## 输出形态（无需额外归一化）
 * Rust 每例回 `{name, states, model, portMatchesSpec, pidIsInt, pidStable, errorPresent,
 * stopResult:{exited,portFreed,stopped}}` —— 端口 / pid 这类必然不同的数**在 Rust 侧就已
 * 归一成布尔语义**，所以 golden 可以直接冻结、跨运行逐字节一致。
 *
 * 用法：`import { CASES, runRust } from './_llm-report.mjs'`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RUST_BIN } from './_service-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
export const NODE_EXEC = process.execPath;
const MOCK_LLM = path.join(REPO_ROOT, 'engine', 'src', 'mock-llm.mjs');

// ------------------------------------------------------------------ 端口分配
const used = new Set();
let cursor = 6300;
const isPortFree = (p) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
  });
async function allocPort() {
  for (let i = 0; i < 500; i++) {
    cursor += 2;
    const p = cursor;
    if (used.has(p) || used.has(p + 1)) continue;
    if (!(await isPortFree(p))) continue;
    used.add(p);
    used.add(p + 1);
    return p;
  }
  throw new Error('找不到空闲端口');
}

// ------------------------------------------------------------------ launch spec 构造
export function buildLaunch(scenario, port) {
  if (scenario === 'never-ready') {
    // 起了个「永不监听端口」的进程：探针永远打不通 ⇒ 必须超时进 error
    return {
      label: 'llm',
      tier: 'tiny',
      model: 'never-ready-proc',
      cmd: [NODE_EXEC, '-e', 'setTimeout(()=>{}, 60000)'],
      cwd: REPO_ROOT,
      env: {},
      probes: [{ kind: 'tcp', port }],
    };
  }
  if (scenario === 'stop-when-stopped') {
    return {
      label: 'llm',
      tier: 'tiny',
      model: 'idle-proc',
      cmd: [NODE_EXEC, '-e', '0'],
      cwd: REPO_ROOT,
      env: {},
      probes: [{ kind: 'tcp', port }],
    };
  }
  // ready / double-start：真 mock-llm（/v1/models → 200）
  return {
    label: 'llm',
    tier: 'tiny',
    model: 'sakura-mock:tiny',
    cmd: [NODE_EXEC, MOCK_LLM, '--port', String(port), '--model', 'tiny'],
    cwd: REPO_ROOT,
    env: {},
    probes: [
      { kind: 'tcp', port },
      { kind: 'http', port, method: 'GET', path: '/v1/models', expect: 200 },
    ],
  };
}

/**
 * 用例表（与原双靶对拍的 `CASES` 逐字同物）。
 *
 * `restart`（L5/L6）是**从 `engine-profile-check.mjs` 的 L 组搬过来的**：
 * 那条检查删掉 Node 靶子时，③ 的启动/停止/重启取证归位到它自己的门（`check:llm-supervisor`），
 * 于是「懒加载恢复真拉起」这件事不再散落在硬件档位检查里。判据形态也更强：
 * `pidChanged` 直接问"新 pid 与旧的是不是同一个"，而不是靠 `restarts` 计数自证。
 */
export const CASES = [
  { name: 'ready', scenario: 'ready', timeoutMs: 9000 },
  { name: 'never-ready', scenario: 'never-ready', timeoutMs: 900 },
  { name: 'double-start', scenario: 'double-start', timeoutMs: 9000 },
  { name: 'stop-when-stopped', scenario: 'stop-when-stopped', timeoutMs: 2000 },
  { name: 'restart', scenario: 'restart', timeoutMs: 9000 },
];

// ------------------------------------------------------------------ Rust 侧取证

/** 跑一次 `boxsvc --llm-selftest`，返回 `Map<name, result>`（键序与 CASES 一致）。 */
export async function runRust(envExtra = {}) {
  if (!fs.existsSync(RUST_BIN)) {
    throw new Error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd src-tauri && cargo build --bin boxsvc`);
  }
  const cases = [];
  for (const c of CASES) {
    cases.push({
      name: c.name,
      scenario: c.scenario,
      watch: false,
      timeoutMs: c.timeoutMs,
      spec: buildLaunch(c.scenario, await allocPort()),
    });
  }
  const out = await new Promise((resolve, reject) => {
    const c = spawn(RUST_BIN, ['--llm-selftest', JSON.stringify({ cases })], {
      env: { ...process.env, ...envExtra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let o = '';
    let e = '';
    c.stdout.on('data', (d) => (o += d));
    c.stderr.on('data', (d) => (e += d));
    c.on('error', reject);
    c.on('close', (code) =>
      code === 0 ? resolve(o) : reject(new Error(`--llm-selftest 退出码 ${code}：${e.slice(0, 600)}`)),
    );
  });
  const byName = new Map();
  for (const r of JSON.parse(out).results) byName.set(r.name, r);
  return byName;
}

/** golden 用的数组形态（保 CASES 顺序，便于人读与 diff）。 */
export async function collectRust(envExtra) {
  const byName = await runRust(envExtra);
  return CASES.map((c) => byName.get(c.name));
}
