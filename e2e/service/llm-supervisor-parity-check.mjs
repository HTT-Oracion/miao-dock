#!/usr/bin/env node
/**
 * F4-b2 · 引擎③ supervisor **行为** 同源钉子 —— Rust(`mangasvc/engine/supervisor.rs`) 对冻结 golden 快照
 * ==========================================================================================================
 * 这条钉住的是**进程生命周期**：状态机（`stopped→starting→running→unloading→stopped`，异常进 `error`）、
 * 就绪探针、停止时「等 `exit` + 回探端口」、串行链语义。它改错时**一条契约断言都不会崩**——
 * 只会表现为「日志说卸载了、8080 还占着」「以为它退了其实没退」「start 与 stop 交错留下孤儿进程」。
 *
 * ## 机制（F5 摘除 Node 后：Rust 输出 ⟷ 冻结 golden）
 *   · 每个用例一个**真进程**：mock 档喂 `engine/src/mock-llm.mjs`（`/v1/models` → 200），
 *     never-ready 档喂一个**永不监听**的进程。
 *   · Rust 侧：`mangasvc --llm-selftest '<cases>'`（内部 `std::process::Command` 起子进程 + 同步探针）。
 *   · golden 快照 `e2e/service/golden/llm-selftest.json` 是「Node 版 `llm-supervisor.mjs` 在同源
 *     对齐时代冻结的最后一份正确输出」，此后作为**单向金标**。用例表与「怎么跑 Rust」只有一份
 *     （`_llm-report.mjs`，生成器与本办法共用）。
 *   · 归一化在 Rust 侧就已完成：端口 / pid 这类必然不同的数被归一成**布尔语义**
 *     （`portMatchesSpec` / `pidIsInt` / `pidStable`），所以 golden 可直接冻结、跨运行逐字节一致。
 *
 * ## 断言
 *   LLM.<name>.behavior — 每例的 `{states, model, portMatchesSpec, pidIsInt, pidStable, errorPresent, stopResult}` 相同
 *
 * ## 反证轮（--refute）
 *   M1 Rust `MIAO_LLM_NO_WAIT_READY=1`（不等就绪就置 running） → never-ready 变红
 *   M2 Rust `MIAO_LLM_PROBE_ALWAYS_OK=1`（探针恒真）          → never-ready 变红
 *   M3 Rust `MIAO_LLM_NO_KILL=1`（stop 不终止也不等）         → ready 变红
 *   M4 篡改 golden 的 ready.states                            → 变红
 *   M5 篡改 golden 的 ready.model                             → 变红
 *
 * 用法：node e2e/service/llm-supervisor-parity-check.mjs [--refute]
 * 前置：`cd src-tauri && cargo build --bin mangasvc`
 * 重新生成 golden：`node e2e/service/_gen-golden.mjs llm-supervisor`
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { CASES, runRust } from './_llm-report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'golden', 'llm-selftest.json');
const REFUTE = process.argv.includes('--refute');

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
    console.log(`  ✗ ${name}${extra !== undefined ? `  → ${JSON.stringify(extra).slice(0, 400)}` : ''}`);
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
/** 取 golden 里某个用例的结果（反证轮复用）。 */
const gold = (name) => golden.results.find((r) => r.name === name);

// ------------------------------------------------------------------ 正向：Rust 输出 ⟷ golden

console.log('=== F4-b2 · 引擎③ supervisor 行为同源（Rust mangasvc --llm-selftest  ⟷  golden 快照）===');

let golden = null;
let rustByName = new Map();
try {
  golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  rustByName = await runRust({});
} catch (e) {
  check('SETUP — 取 Rust 报告 / 读 golden', false, String(e.message || e));
}

if (golden && rustByName.size > 0) {
  const goldByName = new Map(golden.results.map((r) => [r.name, r]));
  for (const c of CASES) {
    const r = rustByName.get(c.name);
    const g = goldByName.get(c.name);
    check(`LLM.${c.name}.behavior — 相同`, !!r && !!g && sameJSON(r, g), { rust: r, golden: g });
  }
}

// ------------------------------------------------------------------ 反证

if (REFUTE) {
  if (failed > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const mutations = [];

  // M1：不等就绪就置 running ⇒ never-ready 必须与 golden 对不上
  {
    const m = await runRust({ MIAO_LLM_NO_WAIT_READY: '1' });
    mutations.push({
      id: 'M1',
      what: 'Rust MIAO_LLM_NO_WAIT_READY=1（不等就绪）→ never-ready',
      red: !sameJSON(m.get('never-ready'), gold('never-ready')),
    });
  }
  // M2：探针恒真 ⇒ never-ready 必须与 golden 对不上
  {
    const m = await runRust({ MIAO_LLM_PROBE_ALWAYS_OK: '1' });
    mutations.push({
      id: 'M2',
      what: 'Rust MIAO_LLM_PROBE_ALWAYS_OK=1（探针恒真）→ never-ready',
      red: !sameJSON(m.get('never-ready'), gold('never-ready')),
    });
  }
  // M3：stop 不终止也不等退出 ⇒ ready 必须与 golden 对不上
  {
    const m = await runRust({ MIAO_LLM_NO_KILL: '1' });
    mutations.push({
      id: 'M3',
      what: 'Rust MIAO_LLM_NO_KILL=1（stop 不杀不等）→ ready.stopResult',
      red: !sameJSON(m.get('ready'), gold('ready')),
    });
  }
  // M4：篡改 golden 的 ready.states（自证比对不是恒真）
  {
    const g = clone(gold('ready'));
    g.states = ['stopped', 'error', 'stopped'];
    mutations.push({ id: 'M4', what: '篡改 golden ready.states', red: !sameJSON(rustByName.get('ready'), g) });
  }
  // M5：篡改 golden 的 ready.model（自证字段确实参与比对）
  {
    const g = clone(gold('ready'));
    g.model = 'wrong-model';
    mutations.push({ id: 'M5', what: '篡改 golden ready.model', red: !sameJSON(rustByName.get('ready'), g) });
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
console.log(
  `\nF4-b2 supervisor 同源：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`,
);
process.exit(failed === 0 ? 0 : 1);
