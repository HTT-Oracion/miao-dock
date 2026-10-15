#!/usr/bin/env node
/**
 * F3-b · store **执行态**同源钉子 —— Rust(`boxsvc/store/exec.rs`) 对冻结 golden 快照
 * =============================================================================
 * 为什么必须有它：F3-a 的钉子只覆盖「纯函数 + serialize + 视图 + 计划」——那些是**静态**产物。
 * 真正会出事的是**执行态**：建单怎么记账、幂等短路什么时候生效、失败页保不保原图（G-11）、
 * 单项总预算耗尽时到底走的是"总预算"还是"单请求超时"、取消/重试/删除各把自己写成什么。
 * 这些失效形态**都不是崩溃**：任务照样跑完、状态照样落盘，只是某一格悄悄不同。
 *
 * ## 机制（F5 摘除 Node 后：Rust 输出 ⟷ 冻结 golden）
 *   · `boxsvc --store-exec-selftest` 跑 7 个场景，打印 `{scenarios:[{...输入..., report:{...}}]}`
 *   · golden 快照 `e2e/service/golden/store-exec-selftest.json` 是「Node 版 `store.mjs` 在同源
 *     对齐时代冻结的最后一份正确输出」（归一化后），此后作为**单向金标**：Rust 侧任何一次
 *     悄然漂移（状态格 / 事件序列 / 盘面 / 幂等短路 / 预算语义）这里必红。
 *   · 归一化规则**只有一份**：`_store-exec-report.mjs`（生成器与本办法共用），抹掉每跑必变的量
 *     （时间 / 运行目录 / taskId），其余保真。golden 可复现：`node e2e/service/_gen-golden.mjs store-exec`。
 *
 * ## 断言（逐场景）
 *   SC.<name>.outcome / .result / .error / .task / .events / .itemErrors / .disk / .remainingTaskIds
 *   SC.<name>.eventIdsConsecutive —— 事件 id 严格 +1（原始 id，未拉平 ⇒ 缺号真会红）
 *   SC.<name>.expect-status       —— **独立预言**：最终状态必须是这个（防"金标自己错"的假绿）
 *   SC.budget-exhausted.budget-msg —— 失败详情必须是**总预算耗尽**（不是单请求超时）
 *   SC.partial-failed.g11          —— 失败页原图必须落盘、且**没有**译文
 *   SC.skip-existing.short-circuit —— 幂等短路：skipped(already_exists) 且原图未落盘
 *   SC.delete-mixed.report         —— 逐条回报（删掉 1 / 不可删 2）
 *
 * ## 反证轮（--refute）
 *   M1 真实分叉：root 下预置 `01_顺跑/001_translated.png`（skipExisting=true）⇒ happy 必红
 *      —— 证明比的是**本次运行**的产物，不是缓存或常量
 *   M2 篡改 golden `happy.task.status`        ⇒ 变红
 *   M3 删 golden `happy` 一条事件             ⇒ 变红
 *   M4 篡改 golden `budget-exhausted.itemErrors` ⇒ 变红
 *   M5 删 golden `happy.task.finalProgress` 一个键 ⇒ 变红
 *
 * 用法：node e2e/service/store-exec-parity-check.mjs [--refute]
 * 前置：`cd src-tauri && cargo build --bin boxsvc`
 * 重新生成 golden：`node e2e/service/_gen-golden.mjs store-exec`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RUST_BIN } from './_service-harness.mjs';
import { freshDirs, projectScenario } from './_store-exec-report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'golden', 'store-exec-selftest.json');
const REFUTE = process.argv.includes('--refute');
const TOKEN = 'a'.repeat(64);

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

/** 起子进程收 stdout（🔴 异步 spawn：本机 execFileSync 会 EBUSY）。 */
function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', reject);
    c.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${err.slice(0, 800)}`)),
    );
  });
}

/** 跑一次 `--store-exec-selftest`，返回归一化后的 `[{name, report}]`。 */
async function dumpRust(dirs) {
  if (!fs.existsSync(RUST_BIN)) {
    throw new Error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd src-tauri && cargo build --bin boxsvc`);
  }
  const raw = await run(RUST_BIN, ['--store-exec-selftest'], {
    ...process.env,
    MIAO_ROOT: dirs.root,
    MIAO_STATE_DIR: dirs.state,
    MIAO_TOKEN: TOKEN,
    MIAO_ENGINE_PROTOCOL: 'mock',
  });
  return JSON.parse(raw.trim()).scenarios.map((sc) => projectScenario(sc, dirs));
}

/** 规范化：对象键排序（比对只看取值与结构，不看键序）。 */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}
const sameJSON = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const byName = (arr) => Object.fromEntries(arr.map((x) => [x.name, x.report]));

function idsConsecutive(events) {
  for (let i = 1; i < (events || []).length; i++) {
    if (events[i].id !== events[i - 1].id + 1) return false;
  }
  return true;
}

// ------------------------------------------------------------------ 独立预言（防"金标一起错"）

const EXPECT_STATUS = {
  happy: 'done',
  'partial-failed': 'partial_failed',
  'skip-existing': 'done',
  'cancel-queued': 'canceled',
  'retry-then-run': 'done',
  'budget-exhausted': 'failed',
  'delete-mixed': null,
};
const KEYS = ['outcome', 'result', 'error', 'task', 'events', 'itemErrors', 'disk', 'remainingTaskIds'];

// ------------------------------------------------------------------ 正向：Rust 输出 ⟷ golden

console.log('=== F3-b · store 执行态同源（Rust boxsvc --store-exec-selftest  ⟷  golden 快照）===');

let golden = null;
let rust = null;
try {
  golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  rust = byName(await dumpRust(freshDirs('parity')));
} catch (e) {
  check('SETUP — 取 Rust 报告 / 读 golden', false, String(e.message || e));
}

if (golden && rust) {
  for (const g of golden.scenarios) {
    const r = rust[g.name];
    if (!r) {
      check(`SC.${g.name} — Rust 报告缺失该场景`, false);
      continue;
    }
    for (const key of KEYS) {
      const ok = sameJSON(r[key], g.report[key]);
      check(`SC.${g.name}.${key} — 相同`, ok, ok ? undefined : { rust: r[key], golden: g.report[key] });
    }
    console.log(''); // 场景之间留白，便于阅读

    const expect = EXPECT_STATUS[g.name];
    check(
      `SC.${g.name}.expect-status == ${JSON.stringify(expect)}`,
      r.task ? r.task.status === expect : expect === null,
      r.task ? r.task.status : null,
    );
    check(
      `SC.${g.name}.eventIdsConsecutive — 事件 id 严格 +1（原始 id）`,
      idsConsecutive(r.events),
      r.events.map((e) => e.id),
    );
  }

  // 定点断言：总预算耗尽 vs 单请求超时（两者 reason 相同，只能靠 errorMessage 分开）
  const budget = rust['budget-exhausted'];
  const bmsg = (budget && budget.itemErrors && budget.itemErrors['1']) || '';
  check(
    'SC.budget-exhausted.budget-msg — 失败详情必须是「总预算耗尽」',
    /已耗尽/.test(bmsg) && /第 2 次尝试/.test(bmsg),
    budget && budget.itemErrors,
  );
  // G-11：失败页原图落盘、且没有译文
  const partial = rust['partial-failed'];
  const pdisk = (partial && partial.disk) || [];
  check(
    'SC.partial-failed.g11 — 失败页原图落盘且无译文',
    pdisk.includes('002.png') && !pdisk.includes('002_translated.png'),
    pdisk,
  );
  // 幂等短路：seq1 必须是 skipped(already_exists)，且**没有**被送引擎（无 001.png）
  const skip = rust['skip-existing'];
  const s1 = skip && skip.task && skip.task.batches[0] && skip.task.batches[0].items[0];
  check(
    'SC.skip-existing.short-circuit — seq1 skipped(already_exists) 且原图未落盘',
    !!s1 && s1.status === 'skipped' && s1.reason === 'already_exists' && !(skip.disk || []).includes('001.png'),
    s1,
  );
  // 删除：逐条回报（一条删掉、两条不可删）
  const del = rust['delete-mixed'];
  check(
    'SC.delete-mixed.report — 删掉 1 条 / 不可删 2 条',
    !!del && del.result && del.result.deleted.length === 1 && del.result.skipped.length === 2,
    del && del.result,
  );
}

// ------------------------------------------------------------------ 反证

if (REFUTE) {
  if (failed > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }
  const mutations = [];
  const goldRep = (name) => golden.scenarios.find((s) => s.name === name).report;

  // M1：真实分叉 —— root 下预置 `01_顺跑/001_translated.png`（场景 skipExisting=true）⇒ happy 短路
  {
    let red = false;
    let info = null;
    try {
      const dirs = freshDirs('refute-m1');
      const p = path.join(dirs.root, '01_顺跑', '001_translated.png');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.from('pre-existing'));
      const r = byName(await dumpRust(dirs));
      red = !sameJSON(r.happy, goldRep('happy'));
      info = { happyTaskMatched: !red, firstItem: r.happy?.task?.batches?.[0]?.items?.[0]?.status };
    } catch (e) {
      red = true;
      info = String(e.message || e).slice(0, 200);
    }
    mutations.push({ id: 'M1', what: 'root 预置 001_translated.png ⇒ happy 应变红（本次真跑，非缓存）', red, info });
  }
  // M2：篡改 golden 的 task.status
  mutations.push({
    id: 'M2',
    what: '篡改 golden happy.task.status',
    red: !sameJSON({ ...goldRep('happy').task, status: 'ZZZ' }, rust.happy.task),
  });
  // M3：删 golden 一条事件
  mutations.push({
    id: 'M3',
    what: '删 golden happy 一条事件',
    red: (() => {
      const ev = JSON.parse(JSON.stringify(goldRep('happy').events));
      ev.splice(1, 1);
      return !sameJSON(ev, rust.happy.events);
    })(),
  });
  // M4：篡改 golden itemErrors
  mutations.push({
    id: 'M4',
    what: '篡改 golden budget-exhausted.itemErrors',
    red: !sameJSON({ ...goldRep('budget-exhausted').itemErrors, 1: 'tampered' }, rust['budget-exhausted'].itemErrors),
  });
  // M5：删 golden 一个键
  mutations.push({
    id: 'M5',
    what: '删 golden happy.task.finalProgress 一个键（done）',
    red: (() => {
      const t = JSON.parse(JSON.stringify(goldRep('happy').task));
      delete t.finalProgress.done;
      return !sameJSON(t, rust.happy.task);
    })(),
  });

  let allRed = true;
  for (const m of mutations) {
    if (!m.red) allRed = false;
    console.log(
      `  ${m.red ? '✓' : '✗'} ${m.id} ${m.what} → ${m.red ? '按预期变红' : '**没有红**（断言漏了它）'}${m.info ? ` ${JSON.stringify(m.info)}` : ''}`,
    );
  }
  console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed, allRed }));
  console.log(
    `\nF3-b store 执行态同源：正向 ${passed} / ${passed + failed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`,
  );
  process.exit(allRed ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(
  `\nF3-b store 执行态同源：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`,
);
process.exit(failed === 0 ? 0 : 1);
