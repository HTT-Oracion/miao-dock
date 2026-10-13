#!/usr/bin/env node
/**
 * F4-b2 · 引擎③ supervisor **行为** 同源钉子 —— Rust(`boxsvc/engine/supervisor.rs`) ⟷ Node(`settings/llm-supervisor.mjs`)
 * ==========================================================================================================
 * F4-a 钉住「引擎配方/协议的**纯函数**」，F4-b1 钉住「引擎 HTTP **运行期**」。这条钉住的是
 * **进程生命周期**：状态机（`stopped→starting→running→unloading→stopped`，异常进 `error`）、
 * 就绪探针、停止时「等 `exit` + 回探端口」、串行链语义。它改错时**一条契约断言都不会崩**——
 * 只会表现为「日志说卸载了、8080 还占着」「以为它退了其实没退」「start 与 stop 交错留下孤儿进程」。
 *
 * ## 机制（真起子进程）
 *   · 每个用例一个**真进程**：mock 档喂 `engine/src/mock-llm.mjs`（`/v1/models` → 200），
 *     never-ready 档喂一个**永不监听**的进程。
 *   · Rust 侧：`boxsvc --llm-selftest '<cases>'`（内部 `std::process::Command` 起子进程 + 同步探针）。
 *   · Node 侧：本脚本内**真 import** `LlmSupervisor`，用同一份 launch spec 跑同一组场景。
 *   · 两边结果**归一化后逐例比对**：把「端口/pid 这类必然不同的数」换成
 *     「是不是整数 / 是否等于配方端口」，只留**行为语义**在同一位面上。
 *
 * ## 反证轮（--refute）
 *   M1 Rust `MIAO_LLM_NO_WAIT_READY=1`（不等就绪就置 running） → never-ready 变红
 *   M2 Rust `MIAO_LLM_PROBE_ALWAYS_OK=1`（探针恒真）            → never-ready 变红
 *   M3 Rust `MIAO_LLM_NO_KILL=1`（stop 不终止也不等）           → ready 的 stopResult 变红
 *   M4 篡改 **Node** 的 ready states（自证比对面不是恒真）      → 红
 *   M5 篡改 **Rust** 的 model（自证字段确实参与比对）           → 红
 *
 * 用法：node e2e/service/llm-supervisor-parity-check.mjs [--refute]
 * 前置：`cd app/src-tauri && cargo build --bin boxsvc`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { RUST_BIN } from './_service-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const REFUTE = process.argv.includes('--refute');
const NODE_EXEC = process.execPath;
const MOCK_LLM = path.join(REPO_ROOT, 'engine', 'src', 'mock-llm.mjs');

const { LlmSupervisor } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'service', 'src', 'settings', 'llm-supervisor.mjs')).href
);

// ------------------------------------------------------------------ 结果收集
let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
  }
}
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  }
  return v;
}
const sameJSON = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// ------------------------------------------------------------------ 端口
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
const firstPort = (launch) => {
  const p = (launch.probes || []).find((x) => Number.isInteger(x.port));
  return p ? p.port : null;
};
function buildLaunch(scenario, port) {
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

const CASES = [
  { name: 'ready', scenario: 'ready', timeoutMs: 9000 },
  { name: 'never-ready', scenario: 'never-ready', timeoutMs: 900 },
  { name: 'double-start', scenario: 'double-start', timeoutMs: 9000 },
  { name: 'stop-when-stopped', scenario: 'stop-when-stopped', timeoutMs: 2000 },
];

// ------------------------------------------------------------------ Rust 侧
function runCmd(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', reject);
    c.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${err.slice(0, 600)}`)),
    );
  });
}

async function runRust(envExtra) {
  const cases = [];
  for (const c of CASES) {
    const port = await allocPort();
    cases.push({
      name: c.name,
      scenario: c.scenario,
      watch: false,
      timeoutMs: c.timeoutMs,
      spec: buildLaunch(c.scenario, port),
    });
  }
  const out = await runCmd(RUST_BIN, ['--llm-selftest', JSON.stringify({ cases })], envExtra || {});
  const byName = new Map();
  for (const r of JSON.parse(out).results) byName.set(r.name, r);
  return byName;
}

// ------------------------------------------------------------------ Node 侧（真 LlmSupervisor）
async function nodeCase(c) {
  const launch = buildLaunch(c.scenario, await allocPort());
  const sup = new LlmSupervisor({ launch, watch: false });
  const states = [sup.snapshot().state];
  let portMatchesSpec = null;
  let pidIsInt = null;
  let stopResult = null;
  let pidStable = null;

  if (c.scenario === 'ready') {
    const s1 = await sup.start({ timeoutMs: c.timeoutMs });
    states.push(s1.state);
    portMatchesSpec = s1.port === firstPort(launch);
    pidIsInt = Number.isInteger(s1.pid);
    stopResult = await sup.stop({});
    states.push(sup.snapshot().state);
  } else if (c.scenario === 'never-ready') {
    const s1 = await sup.start({ timeoutMs: c.timeoutMs });
    states.push(s1.state);
    await sup.stop({});
    states.push(sup.snapshot().state);
  } else if (c.scenario === 'double-start') {
    const s1 = await sup.start({ timeoutMs: c.timeoutMs });
    states.push(s1.state);
    portMatchesSpec = s1.port === firstPort(launch);
    pidIsInt = Number.isInteger(s1.pid);
    const s2 = await sup.start({ timeoutMs: c.timeoutMs });
    states.push(s2.state);
    pidStable = s1.pid === s2.pid;
    await sup.stop({});
  } else if (c.scenario === 'stop-when-stopped') {
    stopResult = await sup.stop({});
    states.push(sup.snapshot().state);
  }
  return {
    name: c.name,
    states,
    model: sup.snapshot().model,
    portMatchesSpec,
    pidIsInt,
    stopResult,
    errorPresent: sup.lastError != null,
    pidStable,
  };
}

// ------------------------------------------------------------------ 正向
console.log('=== F4-b2 · 引擎③ supervisor 行为同源（Rust boxsvc --llm-selftest  ⟷  Node llm-supervisor.mjs）===');

let rustByName = new Map();
const nodeByName = new Map();

try {
  if (!fs.existsSync(RUST_BIN)) {
    throw new Error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd app/src-tauri && cargo build --bin boxsvc`);
  }
  rustByName = await runRust({});
  for (const c of CASES) nodeByName.set(c.name, await nodeCase(c));

  for (const c of CASES) {
    const r = rustByName.get(c.name);
    const n = nodeByName.get(c.name);
    check(`LLM.${c.name}.behavior — 相同`, r && n && sameJSON(r, n), { rust: r, node: n });
  }
} catch (e) {
  check('SETUP — 取 Rust / Node 结果', false, String(e.message || e));
}

// ------------------------------------------------------------------ 反证
if (REFUTE) {
  if (failed > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const mutations = [];

  // M1 Rust：不等就绪就置 running
  {
    const m = await runRust({ MIAO_LLM_NO_WAIT_READY: '1' });
    const red = !sameJSON(m.get('never-ready'), nodeByName.get('never-ready'));
    mutations.push({ id: 'M1', what: 'Rust MIAO_LLM_NO_WAIT_READY=1（不等就绪）→ never-ready', red });
  }
  // M2 Rust：探针恒真
  {
    const m = await runRust({ MIAO_LLM_PROBE_ALWAYS_OK: '1' });
    const red = !sameJSON(m.get('never-ready'), nodeByName.get('never-ready'));
    mutations.push({ id: 'M2', what: 'Rust MIAO_LLM_PROBE_ALWAYS_OK=1（探针恒真）→ never-ready', red });
  }
  // M3 Rust：stop 不终止也不等退出
  {
    const m = await runRust({ MIAO_LLM_NO_KILL: '1' });
    const red = !sameJSON(m.get('ready'), nodeByName.get('ready'));
    mutations.push({ id: 'M3', what: 'Rust MIAO_LLM_NO_KILL=1（stop 不杀不等）→ ready.stopResult', red });
  }
  // M4 篡改 Node 的 ready states（自证比对面不是恒真）
  {
    const m = clone(nodeByName.get('ready'));
    m.states = ['stopped', 'error', 'stopped'];
    const red = !sameJSON(rustByName.get('ready'), m);
    mutations.push({ id: 'M4', what: '篡改 Node 的 ready.states → 不比不知道', red });
  }
  // M5 篡改 Rust 的 model（自证字段确实参与比对）
  {
    const m = clone(rustByName.get('ready'));
    m.model = 'wrong-model';
    const red = !sameJSON(m, nodeByName.get('ready'));
    mutations.push({ id: 'M5', what: '篡改 Rust 的 ready.model → 字段确实参与比对', red });
  }

  let allRed = true;
  for (const m of mutations) {
    if (!m.red) allRed = false;
    console.log(`  ${m.red ? '✓' : '✗'} ${m.id} ${m.what} → ${m.red ? '按预期变红' : '**没有红**（断言漏了它）'}`);
  }
  console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed, allRed }));
  console.log(
    `\nF4-b2 supervisor 同源：正向 ${passed} / ${passed + failed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`,
  );
  process.exit(allRed ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(`\nF4-b2 supervisor 同源：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`);
process.exit(failed === 0 ? 0 : 1);
