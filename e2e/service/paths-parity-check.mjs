#!/usr/bin/env node
/**
 * F2 · 路径**同源**钉子 —— Rust(`paths.rs`) 对冻结 golden 快照
 * =============================================================================
 * 为什么必须有它：F 组要把服务运行时换成 Rust，而「检测到的路径」与「启动时用的路径」一旦
 * 分属两份实现，就会漂移成 R1 那种最难查的故障 —— 「检测说没装、启动却起了」，且两边**都
 * 看起来在工作」。B3 的验收要求「检测与启动同出一源、逐字节相同」。
 *
 * ## 机制（F5 摘除 Node 后：Rust 输出 ⟷ 冻结 golden）
 *   · Rust 侧：`mangasvc --print-paths`（毫秒级，不起服务、不拉 node）打印 `paths.rs::snapshot()`
 *   · golden 快照 `e2e/service/golden/paths-selftest.json` 是「Node 版 `config.mjs` 在同源
 *     对齐时代冻结的最后一份正确输出」（归一化后），此后作为**单向金标**：Rust 侧任何一次
 *     悄然漂移（默认落点 / 覆盖语义 / 键集合）这里必红。
 *   · 归一化规则**只有一份**：`_paths-report.mjs`（生成器与本办法共用）—— 临时目录 `<TMP>`、
 *     仓库根 `<REPO>`、用户 home `<HOME>`，顺序固定「先精确后模糊」。
 *   · `PATH.appData` 与 `PATH.tooling` 是**独立预言**（不依赖任何对照端）：前者盯「引擎落点
 *     必须锚在 `<appData>/runtimes`」，后者盯「装配脚本与产品同源」—— 它们防的是"金标一起错"。
 *
 * ## 断言
 *   PATH.default   无覆盖时的 13 个路径与 golden 逐字节相同
 *   PATH.override  `MIAO_STATE_DIR/ROOT/ENGINE_DIR/ENGINE_PYTHON/ENGINE_SERVER_DIR/MODEL_MANIFEST`
 *                  覆盖后仍与 golden 逐字节相同
 *   PATH.keys      两侧键集合完全一致（少一个键 = 少一条断言）
 *   PATH.appData   未设 `MIAO_*` 时引擎落点锚在 `<appData>/runtimes`（逐字节相同**不保证**落点对）
 *   PATH.tooling   装配脚本（setup-engine / install-engine-deps / fetch-models）的落点与产品同源
 *
 * ## 反证轮（--refute）
 *   M1 篡改 golden 的 override.enginePython  → PATH.override 变红
 *   M2 篡改 golden 的 default.rootDir        → PATH.default 变红
 *   M3 删 golden 的一个键                    → PATH.keys 变红
 *   M4 Rust 快照落点换成仓库布局             → PATH.appData 变红（证明落点断言不是恒真）
 *   M5 装配脚本落点退回仓库 runtimes/        → PATH.tooling 变红
 *   M6 真实分叉：Rust 用「只覆盖 MIAO_ROOT」的 env 跑 → PATH.override 变红（证明比的是本次运行）
 *
 * 用法：node e2e/service/paths-parity-check.mjs [--refute]
 * 前置：`cd src-tauri && cargo build --bin mangasvc`
 * 重新生成 golden：`node e2e/service/_gen-golden.mjs paths`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildScenarios, dumpRust, makeCtx, normSnapshot } from './_paths-report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const GOLDEN = path.join(HERE, 'golden', 'paths-selftest.json');
const REFUTE = process.argv.includes('--refute');
const TOOLING = path.join(REPO_ROOT, 'engine', 'scripts', 'runtime-root.mjs');

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

/** 起一个子进程、收 stdout（🔴 异步 spawn：本机 execFileSync 会 EBUSY）。 */
function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', reject);
    c.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} 退出码 ${code}：${err.slice(0, 800)}`)),
    );
  });
}

const TOOLING_DUMP = `
const m = await import(${JSON.stringify('file://' + TOOLING.split(path.sep).join('/'))});
process.stdout.write(JSON.stringify({ runtimeRoot: m.runtimeRoot(), runtimesDir: m.runtimesDir() }));
`;

async function dumpTooling() {
  return JSON.parse((await run(process.execPath, ['--input-type=module', '-e', TOOLING_DUMP])).trim());
}

/** 逐键逐字节比对；返回差异数组（空 = 完全一致）。 */
function diffPaths(a, b) {
  const out = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) out.push(`Rust 缺键 ${k}`);
    else if (!(k in b)) out.push(`golden 缺键 ${k}`);
    else if (a[k] !== b[k]) out.push(`${k}: rust=${JSON.stringify(a[k])} golden=${JSON.stringify(b[k])}`);
  }
  return out;
}

/** 期望的应用数据目录（与 `paths.rs::app_data_dir` 同一套平台分叉）。 */
function expectAppData() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  }
  return path.join(home, '.local', 'share');
}

/**
 * B1 验收①：一份快照的引擎落点必须锚在 `<appData>/runtimes` 下。
 * 返回不合规的条目数组（空 = 合规）。
 */
function appDataViolations(snap) {
  const rt = path.join(expectAppData(), 'runtimes');
  const venvRel = process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python');
  const want = {
    runtimeRoot: rt,
    engineDir: path.join(rt, 'manga-translator', 'src'),
    enginePython: path.join(rt, 'manga-translator', 'venv', venvRel),
  };
  const bad = [];
  for (const [k, v] of Object.entries(want)) {
    if (snap[k] !== v) bad.push(`${k}=${JSON.stringify(snap[k])} 期望 ${JSON.stringify(v)}`);
  }
  // 引擎路径不得留在仓库根下 —— 防默认值被悄悄改回 `repo_root()` 布局
  if (snap.engineDir && snap.repoRoot && snap.engineDir.startsWith(snap.repoRoot)) {
    bad.push(`engineDir 仍在仓库根下（${snap.engineDir}）`);
  }
  return bad;
}

/**
 * B1 收尾：**装配脚本**的落点必须与产品同源。
 * 返回差异数组（空 = 一致）。
 */
function diffTooling(tooling, snap) {
  if (!tooling || !snap) return ['缺少快照'];
  const out = [];
  if (tooling.runtimeRoot !== snap.runtimeRoot) {
    out.push(`runtimeRoot: 工具链=${JSON.stringify(tooling.runtimeRoot)} 产品=${JSON.stringify(snap.runtimeRoot)}`);
  }
  // 模型根 = `engineDir/..`（config.mjs 的 engineModelDir 就是这么派生的）
  const want = path.resolve(snap.engineDir, '..');
  if (tooling.runtimesDir !== want) {
    out.push(`runtimesDir: 工具链=${JSON.stringify(tooling.runtimesDir)} 产品=${JSON.stringify(want)}`);
  }
  return out;
}

// ------------------------------------------------------------------ 正向：Rust 输出 ⟷ golden

console.log('=== F2 · 路径同源（Rust mangasvc --print-paths  ⟷  golden 快照）===');

let golden = null;
const scenarios = buildScenarios();
const rustRaw = {}; // 原始快照（appData / tooling 两条独立预言要用未归一化的值）
const rustNorm = {}; // 归一化快照（与 golden 比对）

try {
  golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  for (const sc of scenarios) {
    const snap = await dumpRust(sc.env);
    rustRaw[sc.id] = snap;
    rustNorm[sc.id] = normSnapshot(snap, makeCtx(sc, REPO_ROOT));
  }
} catch (e) {
  check('SETUP — 取 Rust 报告 / 读 golden', false, String(e.message || e));
}

if (golden && rustNorm.default && rustNorm.override) {
  for (const sc of scenarios) {
    const d = diffPaths(rustNorm[sc.id], golden[sc.id]);
    check(
      `PATH.${sc.id} — ${sc.id === 'default' ? '无覆盖时 13 个路径' : 'env 覆盖后 13 个路径'}与 golden 逐字节相同`,
      d.length === 0,
      d,
    );
  }

  // PATH.keys：键集合一致（与 default 场景同物，但单独成条 —— 它是 M3 的目标）
  {
    const a = Object.keys(rustNorm.default).sort();
    const b = Object.keys(golden.default).sort();
    check('PATH.keys — Rust 与 golden 的路径键集合完全一致', a.length > 0 && a.join(',') === b.join(','), {
      rust: a,
      golden: b,
    });
  }

  // PATH.appData（B1 验收①）：未设 `MIAO_*` 时引擎落点必须锚在 `<appData>/runtimes`。
  //    为什么单独一条：逐字节相同**不保证**落点正确 —— Rust 与金标一起锚在仓库根上同样"相同"，
  //    而打包后那就是错的（A1 已论证 `repo_root()` 在打包态算不出根）。
  {
    const bad = appDataViolations(rustRaw.default);
    check('PATH.appData — B1：未设 MIAO_* 时引擎落点在 <appData>/runtimes', bad.length === 0, bad);
  }

  // PATH.tooling（B1 收尾）：装配脚本（setup-engine / install-engine-deps / fetch-models）
  //    共用的落点必须与产品同源。没有这条，「装到 A、读到 B」会一直静默。
  {
    const bad = [];
    let tooling = null;
    try {
      tooling = await dumpTooling();
    } catch (e) {
      bad.push(`工具链 dump 失败：${e.message || e}`);
    }
    bad.push(...diffTooling(tooling, rustRaw.default));
    check('PATH.tooling — B1：引擎装配脚本落点与产品同源', bad.length === 0, bad);
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

  // M1：篡改 golden 的 override.enginePython ⇒ PATH.override 必须红
  mutations.push({
    id: 'M1',
    what: '篡改 golden override.enginePython',
    red: (() => {
      const g = clone(golden.override);
      g.enginePython = 'X:/wrong/python';
      return diffPaths(rustNorm.override, g).length > 0;
    })(),
  });
  // M2：篡改 golden 的 default.rootDir ⇒ PATH.default 必须红
  mutations.push({
    id: 'M2',
    what: '篡改 golden default.rootDir',
    red: (() => {
      const g = clone(golden.default);
      g.rootDir = 'X:/wrong/root';
      return diffPaths(rustNorm.default, g).length > 0;
    })(),
  });
  // M3：删 golden 一个键 ⇒ PATH.keys 必须红
  mutations.push({
    id: 'M3',
    what: '删 golden default 的一个键（tokenFile）',
    red: (() => {
      const g = clone(golden.default);
      delete g.tokenFile;
      return diffPaths(rustNorm.default, g).length > 0;
    })(),
  });
  // M4：把 Rust 快照的落点换成仓库布局 ⇒ 落点断言必须红（证明它真在看 engineDir）
  {
    const rt = path.join(rustRaw.default.repoRoot, 'runtimes');
    const repo = {
      ...rustRaw.default,
      runtimeRoot: rt,
      engineDir: path.join(rt, 'manga-translator', 'src'),
      enginePython: path.join(rt, 'manga-translator', 'venv', 'Scripts', 'python.exe'),
    };
    mutations.push({
      id: 'M4',
      what: 'Rust 快照落点换成仓库根布局 ⇒ PATH.appData',
      red: appDataViolations(repo).length > 0,
    });
  }
  // M5：装配脚本落点退回仓库 runtimes/ ⇒ PATH.tooling 必须红
  {
    const rt = path.join(rustRaw.default.repoRoot, 'runtimes');
    mutations.push({
      id: 'M5',
      what: '装配脚本落点退回仓库 runtimes/ ⇒ PATH.tooling',
      red: diffTooling({ runtimeRoot: rt, runtimesDir: path.join(rt, 'manga-translator') }, rustRaw.default).length > 0,
    });
  }
  // M6：真实分叉 —— Rust 用「只覆盖 MIAO_ROOT」的 env 跑，与 golden.override 必然对不上
  {
    let red = false;
    let info = null;
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-paths-refute-'));
      const snap = await dumpRust({ MIAO_ROOT: path.join(tmp, 'root', 'Box 漫画') });
      const g = normSnapshot(snap, { tmp, repo: REPO_ROOT });
      const diffs = diffPaths(g, golden.override);
      red = diffs.length > 0;
      info = { diffs: diffs.slice(0, 3) };
    } catch (e) {
      red = true;
      info = String(e.message || e).slice(0, 200);
    }
    mutations.push({ id: 'M6', what: 'Rust 只覆盖 MIAO_ROOT（与 golden.override 对不上）', red, info });
  }

  let allRed = true;
  for (const m of mutations) {
    if (!m.red) allRed = false;
    console.log(
      `  ${m.red ? '✓' : '✗'} ${m.id} ${m.what} → ${m.red ? '按预期变红' : '**没有红**（断言漏了它）'}${m.info ? ` ${JSON.stringify(m.info)}` : ''}`,
    );
  }
  console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed, allRed }));
  console.log(
    `\nF2 路径同源：正向 ${passed} / ${passed + failed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`,
  );
  process.exit(allRed ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(
  `\nF2 路径同源：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`,
);
process.exit(failed === 0 ? 0 : 1);
