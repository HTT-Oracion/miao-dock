#!/usr/bin/env node
/**
 * F4-b · engine **HTTP 运行期** 同源钉子 —— Rust(`mangasvc/engine/client.rs`) 对冻结 golden 快照
 * =========================================================================================
 * F4-a（`engine-parity-check.mjs`）钉住的是**纯函数**（启动配方 / 参数快照 / 帧解析）。
 * 这条钉住的是**真的发了 HTTP 的那一半**：`requestOnce` / `probeTcp` / `translateImage`(real+mock)
 * / `probeEngine`（三重判定）与阶段日志环 —— 它们改错时**一条断言都不会崩**，只会表现为
 * 「翻译静默变差 / 引擎看着在跑但第一张必挂 / 卡住后无法归因」。
 *
 * ## 机制（F5 摘除 Node 后：Rust 输出 ⟷ 冻结 golden）
 *   · 本脚本按用例起一个 **Node http 伪引擎**（返回固定的 5 字节帧 / 状态码 / 慢响应），
 *     并**记录**收到的请求（method/path/headers/body）—— 它是**夹具**，不是对照端。
 *   · Rust 侧：`mangasvc --engine-http-selftest '<cases>'`（新建 tokio runtime 真发 HTTP）。
 *   · golden 快照 `e2e/service/golden/engine-http-selftest.json` 是「Node 版 `engine-client.mjs`
 *     在同源对齐时代冻结的最后一份正确输出」，此后作为**单向金标**。
 *   · 伪引擎 / 用例表 / 「怎么跑 Rust」只有一份（`_engine-http-report.mjs`，生成器与本办法共用）。
 *
 * ## 断言
 *   HTTP.<name>.translate / .probe — 每例 `{ok,code,ext,mime,bytesB64,frames,stageLines}` / probe 九字段相同
 *   HTTP.<name>.payload            — 请求体相同（data URI + config）
 *   HTTP.用例表                     — live 取到的例数 == `CASES.length`（少跑一条与跑错一样要紧）
 *
 * ## 反证轮（--refute）
 *   M1 篡改 golden 的 ext（png→jpg）              → translate 变红
 *   M2 删 golden 一条阶段日志行                    → translate 变红（阶段是诊断视图唯一来源）
 *   M3 篡改 golden 的 probe state（running→prewarming）→ probe 变红
 *   M4 删 golden 请求体里 translator 的一个键       → payload 变红
 *   M5 篡改 golden mock 例的 mime                  → translate 变红
 *   M6 删 golden 超时例里的「排队位次」那一帧        → translate 变红（超时不带走证据就不可归因）
 *
 * 用法：node e2e/service/engine-http-parity-check.mjs [--refute]
 * 前置：`cd src-tauri && cargo build --bin mangasvc`
 * 重新生成 golden：`node e2e/service/_gen-golden.mjs engine-http`
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { CASES, collect, projPayload, projProbe, projTranslate } from './_engine-http-report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'golden', 'engine-http-selftest.json');
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

/**
 * 用例种类由 `CASES` 决定，**不能**看 Rust 返回的结果 —— Rust 的 results 里没有 `kind` 字段，
 * 凭它判会把 probe 例也塞进 `projTranslate`（两边全 null ⇒ 恒真假绿）。
 */
const kindOf = (name) => (CASES.find((c) => c.name === name) || {}).kind;

// ------------------------------------------------------------------ 正向：Rust 输出 ⟷ golden

console.log('=== F4-b · engine HTTP 运行期同源（Rust mangasvc --engine-http-selftest  ⟷  golden 快照）===');

let golden = null;
let live = null;
try {
  golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  live = await collect();
} catch (e) {
  check('SETUP — 取 Rust 报告 / 读 golden', false, String(e.message || e));
}

if (golden && live) {
  const goldByName = new Map(golden.results.map((r) => [r.name, r]));
  for (const r of live.results) {
    const g = goldByName.get(r.name);
    if (!g) {
      check(`HTTP.${r.name} — golden 缺失该例`, false);
      continue;
    }
    const kind = kindOf(r.name);
    const label = kind === 'probe' ? 'probe' : 'translate';
    const pr = kind === 'probe' ? projProbe(r) : projTranslate(r);
    const pg = kind === 'probe' ? projProbe(g) : projTranslate(g);
    check(`HTTP.${r.name}.${label} — 相同`, sameJSON(pr, pg), { rust: pr, golden: pg });
  }
  // 请求体（data URI + config）逐例比对
  for (const [name, p] of Object.entries(live.payloads)) {
    const g = golden.payloads && golden.payloads[name];
    check(`HTTP.${name}.payload — 请求体相同（data URI + config）`, !!g && sameJSON(p, g), { rust: p, golden: g });
  }
  // 🔴 分母写死：`live.results` 少一条时下面那个循环**根本不会执行到**，于是"少跑一例"看起来
  //    像"全部通过"。Rust 侧漏回一例、或某个用例被静默跳过，只有这条会红。
  check(`HTTP.用例表 — live 取到 ${CASES.length} 例（与用例表同数）`, live.results.length === CASES.length, {
    live: live.results.length,
    cases: CASES.length,
    names: live.results.map((r) => r.name),
  });
}

// ------------------------------------------------------------------ 反证

if (REFUTE) {
  if (failed > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const goldT = golden.results.find((r) => r.name === 'real.ok_ja_zh');
  const goldM = golden.results.find((r) => r.name === 'mock.ok');
  const goldP = golden.results.find((r) => r.name === 'real.probe_running');
  const liveT = live.results.find((r) => r.name === 'real.ok_ja_zh');
  const liveM = live.results.find((r) => r.name === 'mock.ok');
  const liveP = live.results.find((r) => r.name === 'real.probe_running');
  const goldPair = golden.payloads && golden.payloads['real.ok_ja_zh'];
  const goldQ = golden.results.find((r) => r.name === 'real.queue_position_then_silent');
  const liveQ = live.results.find((r) => r.name === 'real.queue_position_then_silent');

  const mutations = [];

  // M1：篡改 golden 的 ext
  mutations.push({
    id: 'M1',
    what: '篡改 golden 返回的 ext（png→jpg）',
    red: (() => {
      const g = clone(goldT);
      g.ext = 'jpg';
      return !sameJSON(projTranslate(liveT), projTranslate(g));
    })(),
  });
  // M2：删 golden 一条阶段日志行
  mutations.push({
    id: 'M2',
    what: '删 golden 一条阶段日志行',
    red: (() => {
      const g = clone(goldT);
      g.stageLines = g.stageLines.slice(1);
      return !sameJSON(projTranslate(liveT), projTranslate(g));
    })(),
  });
  // M3：篡改 golden 的 probe state
  mutations.push({
    id: 'M3',
    what: '篡改 golden 的 probe state（running→prewarming）',
    red: (() => {
      const g = clone(goldP);
      g.probe = { ...g.probe, state: 'prewarming' };
      return !sameJSON(projProbe(liveP), projProbe(g));
    })(),
  });
  // M4：删 golden 请求体里 translator 的一个键
  mutations.push({
    id: 'M4',
    what: '删 golden 请求体 config.translator 的一个键',
    red: (() => {
      const g = clone(goldPair);
      delete g.config.translator.target_lang;
      return !sameJSON(live.payloads['real.ok_ja_zh'], g);
    })(),
  });
  // M5：篡改 golden mock 例的 mime
  mutations.push({
    id: 'M5',
    what: '篡改 golden mock 例的 mime（png→jpeg）',
    red: (() => {
      const g = clone(goldM);
      g.mime = 'image/jpeg';
      return !sameJSON(projTranslate(liveM), projTranslate(g));
    })(),
  });

  // M6：删掉超时例里「排队位次 0」那一帧
  // 这条专盯 `frames` 判据：只看 `stageLines` 的话，把帧整个丢掉也能对得上（两处同源），
  // 于是"超时不带走结构化证据"这条退化**无人拦**。删掉它必须让 translate 变红。
  mutations.push({
    id: 'M6',
    what: '删 golden 超时例里的「排队位次」那一帧',
    red: (() => {
      const g = clone(goldQ);
      g.frames = g.frames.filter((f) => f.code !== 3);
      return !sameJSON(projTranslate(liveQ), projTranslate(g));
    })(),
  });

  let allRed = true;
  for (const m of mutations) {
    if (!m.red) allRed = false;
    console.log(`  ${m.red ? '✓' : '✗'} ${m.id} ${m.what} → ${m.red ? '按预期变红' : '**没有红**（断言漏了它）'}`);
  }
  console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed, allRed }));
  console.log(
    `\nF4-b engine HTTP 同源：正向 ${passed} / ${passed + failed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`,
  );
  process.exit(allRed ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(
  `\nF4-b engine HTTP 同源：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`,
);
process.exit(failed === 0 ? 0 : 1);
