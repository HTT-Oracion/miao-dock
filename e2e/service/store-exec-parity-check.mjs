#!/usr/bin/env node
/**
 * F3-b · store **执行态**同源钉子
 * =============================================================================
 * Rust(`boxsvc/store/exec.rs`) 与 Node(`manga/store.mjs`) 在**同一批固定场景**下
 * 的**最终持久化记录 / 事件序列 / 磁盘落点**逐条相同。
 *
 * 为什么必须有它：F3-a 的钉子只覆盖「纯函数 + serialize + 视图 + 计划」——那些是**静态**产物。
 * 真正会出事的是**执行态**：建单怎么记账、幂等短路什么时候生效、失败页保不保原图（G-11）、
 * 单项总预算耗尽时到底走的是"总预算"还是"单请求超时"、取消/重试/删除各把自己写成什么。
 * 这些失效形态**都不是崩溃**：任务照样跑完、状态照样落盘，只是某一格悄悄不同。
 *
 * ## 机制（输入的唯一事实源在 Rust）
 *   · `boxsvc --store-exec-selftest` 跑 7 个场景，打印 `{scenarios:[{...输入..., report:{...}}]}`
 *   · 本脚本**只读**那些输入，用**真 `store.mjs`** 跑同一份（每场景一个新进程 —— Node 的
 *     `config` 在模块加载期读 env），再与 Rust 的 `report` 比对
 *   · 翻译：Rust 用进程内脚本化翻译器，Node 用 `MIAO_ENGINE_PROTOCOL=mock` 打本脚本起的
 *     **伪引擎**（同一个 seq ⇒ 同一份字节）⇒ 两边拿到**逐字节相同**的翻译结果
 *
 * ## 断言
 *   SC.<name>.task / .events / .itemErrors / .disk / .outcome / .result / .error  —— 逐条相同
 *   SC.<name>.eventIdsConsecutive  —— 事件 id 严格 +1（两边各自）
 *   SC.<name>.expect               —— **独立预言**：最终状态必须是这个（防"两边一起错"的假绿）
 *   SC.budget-exhausted.budgetMsg  —— 失败详情必须是**总预算耗尽**（不是单请求超时）
 *   SC.partial-failed.g11          —— 失败页原图必须落盘、且**没有**译文
 *
 * ## 反证轮（--refute）
 *   M1 伪引擎对 `happy` 回错字节        ⇒ happy.task 必须变红（真·输入分叉）
 *   M2 伪引擎对 `happy` 挂住            ⇒ happy 必须变红（真·行为分叉）
 *   M3 伪引擎对 `happy` 回非图片字节    ⇒ happy 必须变红（真·行为分叉）
 *   M4 篡改 Rust `task.status`          ⇒ 变红
 *   M5 删掉 Rust 一条事件               ⇒ 变红
 *   M6 篡改 Rust `itemErrors`           ⇒ 变红
 *
 * 用法：node e2e/service/store-exec-parity-check.mjs [--refute]
 * 前置：`cd app/src-tauri && cargo build --bin boxsvc`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RUST_BIN } from './_service-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const RUNNER = path.join(HERE, '_store-exec-node-runner.mjs');
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

// ------------------------------------------------------------------ 伪引擎

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 与 Rust `exec_selftest::png("default-translated")` **逐字节相同**的兜底响应体。 */
const DEFAULT_BODY = Buffer.concat([PNG_MAGIC, Buffer.from('default-translated')]);

let currentScenario = null;
/** 反证用的全局覆盖：`{ [seq]: {mode,b64,code} }` */
let engineOverride = null;
const hanging = new Set();

const engine = http.createServer((req, res) => {
  req.resume();
  const seq = Number(req.headers['x-miao-seq']);
  const table = engineOverride || (currentScenario && currentScenario.translate) || {};
  const t = table[String(seq)];
  if (t && t.mode === 'hang') {
    hanging.add(res); // 不回、不断 —— 等客户端自己超时（把"总预算耗尽"逼出来）
    return;
  }
  if (t && t.mode === 'err') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: t.code || 'ENGINE_ERROR', message: t.message || '' } }));
    return;
  }
  const body = t && t.mode === 'ok' ? Buffer.from(t.b64, 'base64') : DEFAULT_BODY;
  res.writeHead(200, { 'content-type': 'image/png' });
  res.end(body);
});

await new Promise((r) => engine.listen(0, '127.0.0.1', r));
const ENGINE_PORT = engine.address().port;

// ------------------------------------------------------------------ 目录

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-store-exec-parity-'));
function freshDirs(tag) {
  const rootRaw = path.join(TMP, `${tag}-root`);
  const stateRaw = path.join(TMP, `${tag}-state`);
  fs.mkdirSync(rootRaw, { recursive: true });
  fs.mkdirSync(stateRaw, { recursive: true });
  return { root: fs.realpathSync(rootRaw), state: fs.realpathSync(stateRaw) };
}
const RUST_DIRS = freshDirs('rust');
const NODE_DIRS = freshDirs('node');

const scenarioEnv = (env) => ({
  MIAO_ROOT: NODE_DIRS.root,
  MIAO_STATE_DIR: NODE_DIRS.state,
  MIAO_TOKEN: TOKEN,
  MIAO_ENGINE_PROTOCOL: 'mock',
  MIAO_ENGINE_PORT: String(ENGINE_PORT),
  MIAO_SKIP_EXISTING: env && env.skipExisting === false ? '0' : '1',
  MIAO_ITEM_TIMEOUT_MS: String((env && env.itemTimeoutMs) ?? 150),
  MIAO_ENGINE_TIMEOUT_MS: String((env && env.engineTimeoutMs) ?? 600),
  MIAO_FAIL_SEQ: (env && env.failSeqs ? env.failSeqs : []).join(','),
  MIAO_DISK_FULL: env && env.diskFull ? '1' : '',
  MIAO_ETA_NULL: env && env.etaNull ? '1' : '',
  MIAO_ITEM_FAIL_RATE: String((env && env.itemFailRate) ?? 0),
});

async function runNode(sc, dirs = NODE_DIRS) {
  const file = path.join(TMP, `sc-${sc.name}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(sc));
  currentScenario = sc;
  const env = { ...process.env, ...scenarioEnv(sc.env), MIAO_ROOT: dirs.root, MIAO_STATE_DIR: dirs.state };
  const out = await run(process.execPath, [RUNNER, file], env);
  return JSON.parse(out.trim());
}

// ------------------------------------------------------------------ 归一化（**只在这里做一次**）

function norm(v, ctx) {
  if (Array.isArray(v)) return v.map((x) => norm(x, ctx));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      // 时间与墙钟量：不确定性来源，一律抹平
      if (k === 'createdAt' || k === 'finishedAt' || k === 'durationMs' || k === 'startedAt') {
        out[k] = null;
        continue;
      }
      out[k] = norm(v[k], ctx);
    }
    return out;
  }
  if (typeof v === 'string') {
    let s = v;
    for (const r of [ctx.root, ctx.root.replace(/\\/g, '/')]) {
      if (r) s = s.split(r).join('<ROOT>');
    }
    if (ctx.tid) s = s.split(ctx.tid).join('<TID>');
    return s;
  }
  return v;
}

/** 事件：id 拉平到 1..n（Rust 一个进程里 `eventSeq` 跨场景连续，Node 每场景新进程从 1 起）。 */
function normEvents(events, ctx) {
  return (events || []).map((e, i) => ({ id: i + 1, event: e.event, data: norm(e.data, ctx) }));
}
function idsConsecutive(events) {
  for (let i = 1; i < (events || []).length; i++) {
    if (events[i].id !== events[i - 1].id + 1) return false;
  }
  return true;
}
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

const normRep = (rep, root, tid) => {
  const ctx = { root, tid: tid || '' };
  return {
    outcome: norm(rep.outcome, ctx),
    result: norm(rep.result, ctx),
    error: norm(rep.error, ctx),
    task: norm(rep.task, ctx),
    events: normEvents(rep.events, ctx),
    itemErrors: norm(rep.itemErrors, ctx),
    disk: norm(rep.disk, ctx),
    remainingTaskIds: (rep.remainingTaskIds || []).filter((id) => (tid ? id === tid : true)),
  };
};
const tidOf = (sc, rep) =>
  (rep.outcome && rep.outcome.taskId) || (sc.kind === 'seed' ? sc.opArg || '' : '');

// ------------------------------------------------------------------ 独立预言（防"两边一起错"）

const EXPECT_STATUS = {
  happy: 'done',
  'partial-failed': 'partial_failed',
  'skip-existing': 'done',
  'cancel-queued': 'canceled',
  'retry-then-run': 'done',
  'budget-exhausted': 'failed',
  'delete-mixed': null,
};

// ------------------------------------------------------------------ 正向

console.log('=== F3-b · store 执行态同源（Rust boxsvc --store-exec-selftest  ⟷  Node manga/store.mjs）===');

let scenarios = null;
const rustReps = {};
const nodeReps = {};

try {
  if (!fs.existsSync(RUST_BIN)) {
    throw new Error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd app/src-tauri && cargo build --bin boxsvc`);
  }
  const raw = await run(RUST_BIN, ['--store-exec-selftest'], {
    ...process.env,
    MIAO_ROOT: RUST_DIRS.root,
    MIAO_STATE_DIR: RUST_DIRS.state,
    MIAO_TOKEN: TOKEN,
    MIAO_ENGINE_PROTOCOL: 'mock',
  });
  scenarios = JSON.parse(raw.trim()).scenarios;
} catch (e) {
  check('SETUP — 取 Rust 报告', false, String(e.message || e));
}

if (scenarios) {
  for (const sc of scenarios) {
    const { report: rustRep, ...scDef } = sc; // 场景定义（去掉 Rust 产物）= Node 的输入
    rustReps[sc.name] = rustRep;
    let nodeRep = null;
    try {
      nodeRep = await runNode(scDef);
    } catch (e) {
      check(`SC.${sc.name}.node — 跑 Node`, false, String(e.message || e));
    }
    nodeReps[sc.name] = nodeRep;

    const r = normRep(rustRep, RUST_DIRS.root, tidOf(scDef, rustRep));
    const n = nodeRep ? normRep(nodeRep, NODE_DIRS.root, tidOf(scDef, nodeRep)) : null;

    for (const key of ['outcome', 'result', 'error', 'task', 'events', 'itemErrors', 'disk']) {
      const ok = n !== null && sameJSON(r[key], n[key]);
      check(`SC.${sc.name}.${key} — 相同`, ok, ok ? undefined : { rust: r[key], node: n === null ? '<Node 未产出>' : n[key] });
    }
    console.log(''); // 场景之间留白，便于阅读

    // 独立预言（不依赖两边一致）
    const expect = EXPECT_STATUS[sc.name];
    check(
      `SC.${sc.name}.expect-status == ${JSON.stringify(expect)}`,
      rustRep.task ? rustRep.task.status === expect : expect === null,
      rustRep.task ? rustRep.task.status : null,
    );
    check(`SC.${sc.name}.eventIdsConsecutive（Rust）`, idsConsecutive(rustRep.events));
    if (nodeRep) check(`SC.${sc.name}.eventIdsConsecutive（Node）`, idsConsecutive(nodeRep.events));
  }

  // 定点断言：总预算耗尽 vs 单请求超时（两者 reason 相同，只能靠 errorMessage 分开）
  const budget = rustReps['budget-exhausted'];
  check(
    'SC.budget-exhausted.budget-msg — 失败详情必须是「总预算耗尽」',
    !!budget && /已耗尽/.test(budget.itemErrors['1'] || '') && /第 2 次尝试/.test(budget.itemErrors['1'] || ''),
    budget && budget.itemErrors,
  );
  // G-11：失败页原图落盘、且没有译文
  const partial = rustReps['partial-failed'];
  const pdisk = (partial && partial.disk) || [];
  check('SC.partial-failed.g11 — 失败页原图落盘且无译文', pdisk.includes('002.png') && !pdisk.includes('002_translated.png'), pdisk);
  // 幂等短路：seq1 必须是 skipped(already_exists)，且**没有**被送引擎（无 001.png）
  const skip = rustReps['skip-existing'];
  const s1 = skip && skip.task && skip.task.batches[0].items[0];
  check(
    'SC.skip-existing.short-circuit — seq1 skipped(already_exists) 且原图未落盘',
    !!s1 && s1.status === 'skipped' && s1.reason === 'already_exists' && !((skip.disk) || []).includes('001.png'),
    s1,
  );
  // 删除：逐条回报（一条删掉、一条运行中、一条不存在）
  const del = rustReps['delete-mixed'];
  check(
    'SC.delete-mixed.report — 删掉 / not_deletable / not_found 各一',
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
  const happyDef = scenarios.find((s) => s.name === 'happy');
  const { report: _drop, ...happyInput } = happyDef;

  // 真实分叉：伪引擎对 happy 回错字节 / 挂住 / 回非图片 —— 都必须在 `happy.task` 上变红
  const realDivergence = async (id, what, override) => {
    let red = false;
    let info = null;
    try {
      const dirs = freshDirs(`refute-${id}`);
      engineOverride = override;
      const rep = await runNode(happyInput, dirs);
      engineOverride = null;
      const n = normRep(rep, dirs.root, tidOf(happyInput, rep));
      const r = normRep(rustReps.happy, RUST_DIRS.root, tidOf(happyInput, rustReps.happy));
      red = !sameJSON(r.task, n.task);
      info = { nodeStatus: rep.task && rep.task.status };
    } catch (e) {
      red = true;
      info = String(e.message || e).slice(0, 200);
    } finally {
      engineOverride = null;
      for (const res of hanging) {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      }
      hanging.clear();
    }
    mutations.push({ id, what, red, info });
  };

  await realDivergence('M1', '伪引擎对 happy 回错字节 ⇒ happy.task 应变红', {
    1: { mode: 'ok', b64: Buffer.concat([PNG_MAGIC, Buffer.from('tampered')]).toString('base64') },
  });
  await realDivergence('M2', '伪引擎对 happy 挂住 ⇒ happy 应变红', { 1: { mode: 'hang' } });
  await realDivergence('M3', '伪引擎对 happy 回非图片 ⇒ happy 应变红', {
    1: { mode: 'ok', b64: Buffer.from('not-an-image').toString('base64') },
  });

  // 合成篡改（证明比对确实看这些字段）
  {
    const a = JSON.parse(JSON.stringify(rustReps.happy.task));
    a.status = 'ZZZ';
    mutations.push({
      id: 'M4',
      what: '篡改 Rust task.status',
      red: !sameJSON(a, normRep(nodeReps.happy, NODE_DIRS.root, tidOf(happyInput, nodeReps.happy)).task),
    });
  }
  {
    const ev = JSON.parse(JSON.stringify(rustReps.happy.events));
    ev.splice(1, 1);
    mutations.push({
      id: 'M5',
      what: '删掉 Rust 一条事件',
      red: (() => {
        const ctxN = { root: NODE_DIRS.root, tid: tidOf(happyInput, nodeReps.happy) };
        const ctxR = { root: RUST_DIRS.root, tid: tidOf(happyInput, rustReps.happy) };
        return !sameJSON(normEvents(ev, ctxR), normEvents(nodeReps.happy.events, ctxN));
      })(),
    });
  }
  {
    const ie = { ...rustReps['budget-exhausted'].itemErrors, 1: 'tampered' };
    mutations.push({
      id: 'M6',
      what: '篡改 Rust itemErrors',
      red: !sameJSON(ie, nodeReps['budget-exhausted'].itemErrors),
    });
  }

  let allRed = true;
  for (const m of mutations) {
    if (!m.red) allRed = false;
    console.log(`  ${m.red ? '✓' : '✗'} ${m.id} ${m.what} → ${m.red ? '按预期变红' : '**没有红**（断言漏了它）'}${m.info ? ` ${JSON.stringify(m.info)}` : ''}`);
  }
  console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed, allRed }));
  console.log(
    `\nF3-b store 执行态同源：正向 ${passed} / ${passed + failed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`,
  );
  engine.close();
  for (const res of hanging) {
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  }
  process.exit(allRed ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(`\nF3-b store 执行态同源：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`);
engine.close();
process.exit(failed === 0 ? 0 : 1);
