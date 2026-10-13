#!/usr/bin/env node
/**
 * F3 · store **同源**钉子 —— Rust(`boxsvc/store.rs`) 与 Node(`manga/store.mjs`) 的产物逐条相同
 * =============================================================================
 * 为什么必须有它：F 组把服务运行时换成 Rust 的过程中，`store.mjs` 是**最大也最厚**的一块
 * （1918 行、JSON 持久化 + 三层状态机）。它的失效形态全都**不是崩溃**，而是「看起来在工作、
 * 结果悄悄不同」——落盘字段序变了、批次状态判错一格、eta 回退区间不见了、原子写退化成了
 * 直接覆写。这些都不会让任何既有断言变红。于是这里把「Rust 版 store 与 Node 版 store 在
 * **同一份固定输入**下的产物」逐条钉住。
 *
 * ## 机制（输入的唯一事实源在 Rust）
 *   · `boxsvc --store-selftest` 打印 `pureInputs`（各用例输入）+ `pure`（Rust 输出）+
 *     `fixtures`（任务夹具）+ `serializedTask` / `views` / `plans` / `hidden` / `persistedBytes`
 *   · 本脚本**只读** Rust 给的输入，跑**真 `store.mjs`** 算同一份，再与 Rust 的输出比对
 *     —— 夹具只写一份，两边不会各写一份而悄悄走散
 *
 * ## 断言
 *   STORE.pure.*        纯函数（orderImages / endStatusOf / formatEtaText / sniffImageType /
 *                       isSafeDirName / 目录扫描）逐条相同
 *   STORE.serializedTask / STORE.views.* / STORE.plans.* / STORE.hidden   结构与取值相同
 *   STORE.persistedBytes 落盘字节**逐字节**相同（唯一对字段序敏感的产物）
 *   STORE.atomic.*      原子写：中断后目标完好 + 无 tmp 残留
 *
 * ## 反证轮（--refute）
 *   M1 原子写退化成直接覆写（`MIAO_ATOMIC_DIRECT_WRITE=1`）⇒ `targetIntactAfterAbort` 必须变红
 *   M2 篡改 Node 侧一个纯函数结果 ⇒ 该场景变红
 *   M3 篡改 Rust 侧 `serializedTask` ⇒ 变红
 *   M4 删掉 Rust 侧一个键            ⇒ 变红
 *
 * 用法：node e2e/service/store-parity-check.mjs [--refute]
 * 前置：`cd app/src-tauri && cargo build --bin boxsvc`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { RUST_BIN } from './_service-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
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
    console.log(`  ✗ ${name}${extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
  }
}

/** 起子进程收 stdout（🔴 异步 spawn：本机 execFileSync 会 EBUSY）。 */
function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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

/** 规范化：对象键排序、递归剔除不确定的 `updatedAt`。数组保序。 */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (k === 'updatedAt') continue;
      out[k] = canon(v[k]);
    }
    return out;
  }
  return v;
}
function sameJSON(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

// ------------------------------------------------------------------ 夹具环境（Rust 与 Node 共用）

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-store-parity-'));
const ROOT_RAW = path.join(TMP, 'root');
const STATE_RAW = path.join(TMP, 'state');
fs.mkdirSync(ROOT_RAW, { recursive: true });
fs.mkdirSync(STATE_RAW, { recursive: true });

// 计划夹具：原图 001/002、译文 003 + 001_translated、噪声 cover.jpg / 1000.png（4 位不匹配）
const COMIC = path.join(ROOT_RAW, '测试漫画');
fs.mkdirSync(COMIC, { recursive: true });
fs.writeFileSync(path.join(COMIC, '001.png'), Buffer.from([1, 2, 3]));
fs.writeFileSync(path.join(COMIC, '002.jpg'), Buffer.from([1, 2, 3, 4]));
fs.writeFileSync(path.join(COMIC, '003_translated.png'), Buffer.from([9, 9]));
fs.writeFileSync(path.join(COMIC, '001_translated.webp'), Buffer.from([9]));
fs.writeFileSync(path.join(COMIC, 'cover.jpg'), Buffer.from([7]));
fs.writeFileSync(path.join(COMIC, '1000.png'), Buffer.from([7, 7, 7, 7, 7]));

// 传**规范化后**的绝对路径，避免「谁先 canonicalize」带来的系统差异（两边的 Store 都会再规范化一次）
const ROOT = fs.realpathSync(ROOT_RAW);
const STATE = fs.realpathSync(STATE_RAW);
const ENV = { MIAO_ROOT: ROOT, MIAO_STATE_DIR: STATE, MIAO_TOKEN: 'a'.repeat(64) };

// ------------------------------------------------------------------ Rust 侧

async function dumpRust(extraEnv = {}) {
  if (!fs.existsSync(RUST_BIN)) {
    throw new Error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd app/src-tauri && cargo build --bin boxsvc`);
  }
  const env = { ...ENV, MIAO_ATOMIC_DIRECT_WRITE: '', ...extraEnv };
  return JSON.parse((await run(RUST_BIN, ['--store-selftest'], env)).trim());
}

// ------------------------------------------------------------------ Node 侧（真 store.mjs）

let S = null;
let CFG = null;
let sniffImageType = null;
let isSafeDirName = null;
let atomicWriteJson = null;

async function loadNodeModules() {
  const imp = (rel) => import(pathToFileURL(path.join(REPO_ROOT, rel)).href);
  S = await imp('service/src/manga/store.mjs');
  CFG = await imp('service/src/config.mjs');
  ({ sniffImageType } = await imp('service/src/image.mjs'));
  ({ isSafeDirName } = await imp('service/src/manga/names.mjs'));
  ({ atomicWriteJson } = await imp('service/src/atomic-file.mjs'));
}

/** 用 Rust 给的输入，跑 Node 实现，交出与 Rust 同形的报告。 */
function buildNodeReport(rust) {
  const inp = rust.pureInputs;
  const fx = rust.fixtures;

  // ---- 纯函数 ----
  const orderImages = {};
  for (const [id, c] of Object.entries(inp.orderImages)) {
    const imgs = c.files.map((f) => (f == null ? {} : { filename: f }));
    orderImages[id] = S.orderImages(imgs, c.order).map((o) => imgs.indexOf(o));
  }
  const endStatusOf = {};
  for (const [id, c] of Object.entries(inp.endStatusOf)) {
    endStatusOf[id] = S.endStatusOf(c.statuses.map((s) => ({ status: s })));
  }
  const formatEtaText = {};
  for (const [id, c] of Object.entries(inp.formatEtaText)) formatEtaText[id] = S.formatEtaText(c.min, c.max);
  const sniff = {};
  for (const [id, c] of Object.entries(inp.sniffImageType)) sniff[id] = sniffImageType(Buffer.from(c.bytes));
  const safe = {};
  for (const [id, c] of Object.entries(inp.isSafeDirName)) safe[id] = isSafeDirName(c.name);
  const fileScan = {};
  for (const name of inp.fileScan.names) {
    const mo = CFG.ORIGINAL_SCAN_RE.exec(name);
    const mt = CFG.TRANSLATED_SCAN_RE.exec(name);
    fileScan[name] = { original: mo ? Number(mo[1]) : null, translated: mt ? Number(mt[1]) : null };
  }
  const pure = { orderImages, endStatusOf, formatEtaText, sniffImageType: sniff, isSafeDirName: safe, fileScan };

  // ---- 单任务：serialize / 视图 ----
  const store = new S.Store(ROOT);
  const task = fx.task;
  const batchesTask = fx.batchesTask;
  store._syncBatchStatuses(batchesTask);

  const views = {
    progress: store.progressOf(task),
    create: store.createView(task),
    detail: store.detailView(task, {}),
    detailFiltered: store.detailView(task, { itemsFrom: 2, itemsTo: 3 }),
    list: store.listView(task),
    batchStatuses: batchesTask.batches.map((b) => b.status),
  };

  // ---- 列表：taskList / queue ----
  const listStore = new S.Store(ROOT);
  for (const t of fx.tasks) listStore.tasks.set(t.taskId, t);
  listStore.queue = fx.queueIds.map((id) => listStore.tasks.get(id));
  listStore.currentTaskId = fx.currentTaskId;
  views.taskList = listStore.taskListView({});
  views.taskListFiltered = listStore.taskListView({ status: 'done,failed', limit: 2 });
  views.queue = listStore.queueSnapshot();

  // ---- 计划 ----
  const plans = {
    resume: store.resumePlan(fx.planComicDir),
    retranslate: store.retranslatePlan(fx.planComicDir),
    nextSeq: store._nextSeqFor(fx.planComicDir),
  };

  // ---- 隐藏清单 ----
  const hstore = new S.Store(ROOT);
  for (const name of fx.hiddenSeeds) hstore.hideComic(name);
  const hidden = hstore.hiddenComicsView();

  // ---- 落盘字节（逐字节）----
  const persistFile = path.join(STATE, 'node-persist');
  atomicWriteJson(persistFile, store.serialize(task));
  const persistedBytes = fs.readFileSync(persistFile, 'utf8');

  return { pure, serializedTask: store.serialize(task), views, plans, hidden, persistedBytes };
}

// ------------------------------------------------------------------ 正向

console.log('=== F3 · store 同源（Rust boxsvc --store-selftest  ⟷  Node manga/store.mjs）===');

let rustReport = null;
let nodeReport = null;
try {
  rustReport = await dumpRust();
  await loadNodeModules();
  nodeReport = buildNodeReport(rustReport);
} catch (e) {
  check('SETUP — 取 Rust / Node 报告', false, String(e.message || e));
}

if (rustReport && nodeReport) {
  for (const key of ['orderImages', 'endStatusOf', 'formatEtaText', 'sniffImageType', 'isSafeDirName', 'fileScan']) {
    check(
      `STORE.pure.${key} — 逐条相同`,
      sameJSON(rustReport.pure[key], nodeReport.pure[key]),
      sameJSON(rustReport.pure[key], nodeReport.pure[key]) ? undefined : { rust: rustReport.pure[key], node: nodeReport.pure[key] },
    );
  }

  check(
    'STORE.serializedTask — serialize() 结构相同',
    sameJSON(rustReport.serializedTask, nodeReport.serializedTask),
    sameJSON(rustReport.serializedTask, nodeReport.serializedTask)
      ? undefined
      : { rust: canon(rustReport.serializedTask), node: canon(nodeReport.serializedTask) },
  );

  for (const key of Object.keys(rustReport.views)) {
    check(
      `STORE.views.${key} — 相同`,
      sameJSON(rustReport.views[key], nodeReport.views[key]),
      sameJSON(rustReport.views[key], nodeReport.views[key]) ? undefined : { rust: rustReport.views[key], node: nodeReport.views[key] },
    );
  }

  for (const key of ['resume', 'retranslate', 'nextSeq']) {
    check(
      `STORE.plans.${key} — 相同`,
      sameJSON(rustReport.plans[key], nodeReport.plans[key]),
      sameJSON(rustReport.plans[key], nodeReport.plans[key]) ? undefined : { rust: rustReport.plans[key], node: nodeReport.plans[key] },
    );
  }

  check(
    'STORE.hidden — 隐藏清单视图相同',
    sameJSON(rustReport.hidden, nodeReport.hidden),
    { rust: rustReport.hidden, node: nodeReport.hidden },
  );

  check(
    'STORE.persistedBytes — 落盘字节逐字节相同',
    rustReport.persistedBytes === nodeReport.persistedBytes,
    rustReport.persistedBytes === nodeReport.persistedBytes
      ? undefined
      : { rustLen: rustReport.persistedBytes.length, nodeLen: nodeReport.persistedBytes.length },
  );

  check('STORE.atomic.targetIntactAfterAbort — 中断后目标文件完好', rustReport.atomic.targetIntactAfterAbort === true, rustReport.atomic);
  check('STORE.atomic.noTmpResidue — 正常原子写无 tmp 残留', rustReport.atomic.noTmpResidue === true, rustReport.atomic);
  check('STORE.ulidOk — ULID 形状（26 位 Crockford）', rustReport.ulidOk === true);
}

// ------------------------------------------------------------------ 反证

if (REFUTE) {
  if (failed > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }
  const mutations = [];

  // M1：原子写退化成直接覆写 ⇒ 中断模拟必然污染目标
  {
    let red = false;
    let info = null;
    try {
      const r = await dumpRust({ MIAO_ATOMIC_DIRECT_WRITE: '1' });
      red = r.atomic.targetIntactAfterAbort === false;
      info = r.atomic;
    } catch (e) {
      info = String(e.message || e);
    }
    mutations.push({ id: 'M1', what: '原子写退化直接覆写 ⇒ 中断后目标应被污染（红）', red, info });
  }
  // M2：篡改 Node 侧一个纯函数结果
  mutations.push({
    id: 'M2',
    what: '篡改 Node orderImages 结果',
    red: !sameJSON(rustReport.pure.orderImages, { ...nodeReport.pure.orderImages, byName: [0, 1, 2] }),
  });
  // M3：篡改 Rust 侧 serializedTask
  mutations.push({
    id: 'M3',
    what: '篡改 Rust serializedTask.status',
    red: !sameJSON({ ...rustReport.serializedTask, status: 'ZZZ' }, nodeReport.serializedTask),
  });
  // M4：删掉 Rust 侧一个键
  mutations.push({
    id: 'M4',
    what: '删掉 Rust 侧一个键（views.progress.failed）',
    red: (() => {
      const a = JSON.parse(JSON.stringify(rustReport.views.progress));
      delete a.failed;
      return !sameJSON(a, nodeReport.views.progress);
    })(),
  });

  let allRed = true;
  for (const m of mutations) {
    if (!m.red) allRed = false;
    console.log(`  ${m.red ? '✓' : '✗'} ${m.id} ${m.what} → ${m.red ? '按预期变红' : '**没有红**（断言漏了它）'}${m.info ? ` ${JSON.stringify(m.info)}` : ''}`);
  }
  console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed, allRed }));
  console.log(`\nF3 store 同源：正向 ${passed} / ${passed + failed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`);
  process.exit(allRed ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(`\nF3 store 同源：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`);
process.exit(failed === 0 ? 0 : 1);
