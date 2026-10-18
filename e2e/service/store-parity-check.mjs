#!/usr/bin/env node
/**
 * F3 · store 同源钉子 —— Rust(`mangasvc/store.rs`) 对冻结 golden 快照
 * =============================================================================
 * 为什么必须有它：`store.mjs` 曾是**最大也最厚**的一块（1918 行、JSON 持久化 + 三层状态机）。
 * 它的失效形态全都**不是崩溃**，而是「看起来在工作、结果悄悄不同」——落盘字段序变了、
 * 批次状态判错一格、eta 回退区间不见了、原子写退化成了直接覆写。这些都不会让任何既有
 * 断言变红。于是这里把「Rust 版 store 在**同一份固定输入**下的产物」逐条钉住。
 *
 * ## 机制（F5 摘除 Node 后：Rust 输出 ⟷ 冻结 golden）
 *   · `mangasvc --store-selftest` 打印 `pure` / `serializedTask` / `views` / `plans` /
 *     `hidden` / `persistedBytes` / `atomic` / `ulidOk`（输入 `pureInputs`/`fixtures` 只作
 *     见证，不再回填给 Node）。
 *   · golden 快照 `e2e/service/golden/store-selftest.json` 是「Node 版 store 在同源对齐时代
 *     冻结的最后一份正确输出」——它与 Rust 逐字节同源**已在对拍全绿时验证过**，此后作为
 *     单向金标：Rust 侧任何一次悄然漂移（字段序 / 状态格 / eta 区间 / 原子写），这里必红。
 *   · `canon` 只剔 `updatedAt`（唯一的实时字段），其余（createdAt/finishedAt/outputDir）
 *     都是夹具固定值，无需路径归一化。
 *
 * ## 断言
 *   STORE.pure.*        纯函数逐条相同
 *   STORE.serializedTask / STORE.views.* / STORE.plans.* / STORE.hidden   结构与取值相同
 *   STORE.persistedBytes 落盘字节**逐字节**相同（唯一对字段序敏感的产物）
 *   STORE.atomic.*      原子写：中断后目标完好 + 无 tmp 残留
 *
 * ## 反证轮（--refute）
 *   M1 原子写退化成直接覆写（`MIAO_ATOMIC_DIRECT_WRITE=1`）⇒ `targetIntactAfterAbort` 必须变红
 *   M2 篡改 golden 一个纯函数结果 ⇒ 该场景变红
 *   M3 篡改 golden 的 `serializedTask` ⇒ 变红
 *   M4 删掉 golden 一个键            ⇒ 变红
 *
 * 用法：node e2e/service/store-parity-check.mjs [--refute]
 * 前置：`cd src-tauri && cargo build --bin mangasvc`
 * 重新生成 golden：`node e2e/service/store-parity-check.mjs --write-golden`
 *   （= `--store-selftest` 的 canon 输出；Node 版已摘除，勿再回填 Node）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RUST_BIN } from './_service-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const GOLDEN = path.join(HERE, 'golden', 'store-selftest.json');
const REFUTE = process.argv.includes('--refute');
const WRITE_GOLDEN = process.argv.includes('--write-golden');

// 路径归一化：golden 里凡是本机 home / 仓库根的绝对路径，都归一成占位符，
// 否则 golden 跨机器（不同用户名 / 不同仓库位置）会假红。
// 🔴 用正则而非精确串替换：persistedBytes 是 JSON 转义字符串，反斜杠层级不定
//    （1 层 / 2 层 / 4 层…），`[\\/]+` 一次覆盖任意层级。
const normStr = (s) =>
  s.replace(/[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+/g, '<HOME>').replaceAll(REPO_ROOT, '<REPO>');

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

/** 规范化：对象键排序、递归剔除不确定的 `updatedAt`、路径归一化。数组保序。 */
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
  if (typeof v === 'string') return normStr(v);
  return v;
}
function sameJSON(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

// ------------------------------------------------------------------ Rust 侧

async function dumpRust(extraEnv = {}) {
  if (!fs.existsSync(RUST_BIN)) {
    throw new Error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd src-tauri && cargo build --bin mangasvc`);
  }
  const env = { MIAO_ATOMIC_DIRECT_WRITE: '', ...extraEnv };
  return JSON.parse((await run(RUST_BIN, ['--store-selftest'], env)).trim());
}

// ------------------------------------------------------------------ 正向：Rust 输出 ⟷ 冻结 golden

console.log('=== F3 · store 同源（Rust mangasvc --store-selftest  ⟷  golden 快照）===');

let rustReport = null;
let golden = null;
try {
  rustReport = await dumpRust();
  golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
} catch (e) {
  check('SETUP — 取 Rust 报告 / 读 golden', false, String(e.message || e));
}

// 🔴 重冻是**有意变更契约**时的动作（默认路径/字段序变了才用），不是"红了就重冻"。
//    生成物与比对共用同一份 `canon`，故不会出现"生成与比对规则走散"的假绿。
if (WRITE_GOLDEN && rustReport) {
  fs.writeFileSync(GOLDEN, JSON.stringify(canon(rustReport), null, 2).replace(/\n/g, '\r\n'));
  console.log(`✓ golden → ${path.relative(REPO_ROOT, GOLDEN)}（${fs.statSync(GOLDEN).size} 字节）`);
  process.exit(0);
}

if (rustReport && golden) {
  for (const key of ['orderImages', 'endStatusOf', 'formatEtaText', 'sniffImageType', 'isSafeDirName', 'fileScan']) {
    check(
      `STORE.pure.${key} — 逐条相同`,
      sameJSON(rustReport.pure[key], golden.pure[key]),
      sameJSON(rustReport.pure[key], golden.pure[key])
        ? undefined
        : { rust: rustReport.pure[key], golden: golden.pure[key] },
    );
  }

  check(
    'STORE.serializedTask — serialize() 结构相同',
    sameJSON(rustReport.serializedTask, golden.serializedTask),
    sameJSON(rustReport.serializedTask, golden.serializedTask)
      ? undefined
      : { rust: canon(rustReport.serializedTask), golden: canon(golden.serializedTask) },
  );

  for (const key of Object.keys(golden.views)) {
    check(
      `STORE.views.${key} — 相同`,
      sameJSON(rustReport.views[key], golden.views[key]),
      sameJSON(rustReport.views[key], golden.views[key])
        ? undefined
        : { rust: rustReport.views[key], golden: golden.views[key] },
    );
  }

  for (const key of ['resume', 'retranslate', 'nextSeq']) {
    check(
      `STORE.plans.${key} — 相同`,
      sameJSON(rustReport.plans[key], golden.plans[key]),
      sameJSON(rustReport.plans[key], golden.plans[key])
        ? undefined
        : { rust: rustReport.plans[key], golden: golden.plans[key] },
    );
  }

  check('STORE.hidden — 隐藏清单视图相同', sameJSON(rustReport.hidden, golden.hidden), {
    rust: rustReport.hidden,
    golden: golden.hidden,
  });

  check(
    'STORE.persistedBytes — 落盘字节逐字节相同（归一化 home/仓库路径后）',
    normStr(rustReport.persistedBytes) === normStr(golden.persistedBytes),
    normStr(rustReport.persistedBytes) === normStr(golden.persistedBytes)
      ? undefined
      : { rustLen: rustReport.persistedBytes.length, goldenLen: golden.persistedBytes.length },
  );

  check(
    'STORE.atomic.targetIntactAfterAbort — 中断后目标文件完好',
    rustReport.atomic.targetIntactAfterAbort === true,
    rustReport.atomic,
  );
  check(
    'STORE.atomic.noTmpResidue — 正常原子写无 tmp 残留',
    rustReport.atomic.noTmpResidue === true,
    rustReport.atomic,
  );
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
  // M2：篡改 golden 一个纯函数结果 ⇒ 对比敏感
  mutations.push({
    id: 'M2',
    what: '篡改 golden orderImages 结果',
    red: !sameJSON(rustReport.pure.orderImages, { ...golden.pure.orderImages, byName: [0, 1, 2] }),
  });
  // M3：篡改 golden 的 serializedTask
  mutations.push({
    id: 'M3',
    what: '篡改 golden serializedTask.status',
    red: !sameJSON({ ...rustReport.serializedTask, status: 'ZZZ' }, golden.serializedTask),
  });
  // M4：删掉 golden 一个键
  mutations.push({
    id: 'M4',
    what: '删掉 golden 一个键（views.progress.failed）',
    red: (() => {
      const a = JSON.parse(JSON.stringify(golden.views.progress));
      delete a.failed;
      return !sameJSON(rustReport.views.progress, a);
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
    `\nF3 store 同源：正向 ${passed} / ${passed + failed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`,
  );
  process.exit(allRed ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(
  `\nF3 store 同源：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`,
);
process.exit(failed === 0 ? 0 : 1);
