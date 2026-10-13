#!/usr/bin/env node
/**
 * F2 · 路径**同源**钉子 —— Rust(`paths.rs`) 与 Node(`config.mjs`) 算出的路径必须逐字节相同
 * =============================================================================
 * 为什么必须有它：F 组要把服务运行时换成 Rust，而「检测到的路径」与「启动时用的路径」一旦
 * 分属两份实现，就会漂移成 R1 那种最难查的故障 —— 「检测说没装、启动却起了」，且两边**都
 * 看起来在工作**。B3 的验收要求「检测与启动同出一源、逐字节相同」；本钉子把这个要求钉在
 * **迁移期的过渡物**上：只要 Node 版还在服务里跑（F5 之前），它的路径就必须与 Rust 版逐字节一致。
 *
 * ## 机制
 *   · Rust 侧：`boxsvc --print-paths`（毫秒级，不起服务、不拉 node）打印 `paths.rs::snapshot()`
 *   · Node 侧：起一个 node 子进程 import `service/src/config.mjs`，打印同名的 13 个键
 *   · 逐键逐字节比对；键集合也必须一致（少一个键 = 少一条断言）
 *   · 工具链侧：再起一个子进程 import `engine/scripts/runtime-root.mjs`，与 Node 快照比对
 *
 * ## 断言
 *   PATH.default    无覆盖时的 13 个路径逐字节相同
 *   PATH.override   `MIAO_STATE_DIR/ROOT/ENGINE_DIR/ENGINE_PYTHON/ENGINE_SERVER_DIR` 覆盖后仍逐字节相同
 *   PATH.keys       两侧键集合完全一致
 *   PATH.appData    未设 `MIAO_*` 时引擎落点锚在 `<appData>/runtimes`（逐字节相同**不保证**落点对）
 *   PATH.tooling    装配脚本（setup-engine / install-engine-deps / fetch-models）的落点与产品同源
 *
 * ## 反证轮（--refute，5 个内存变异）
 *   M1 篡改 Node 侧某个值 → 该场景变红
 *   M2 篡改 Rust 侧某个值 → 该场景变红
 *   M3 删掉一个键          → keys 变红
 *   M4 Node 侧默认值退回仓库布局 → 同源与落点两条同时红
 *   M5 装配脚本落点退回仓库 runtimes/ → PATH.tooling 变红
 *
 * 用法：node e2e/service/paths-parity-check.mjs [--refute]
 * 前置：`cd app/src-tauri && cargo build --bin boxsvc`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RUST_BIN } from './_service-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
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
    console.log(`  ✗ ${name}${extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
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
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} 退出码 ${code}：${err.slice(0, 800)}`))));
  });
}

const NODE_DUMP = `
const m = await import(${JSON.stringify('file://' + path.join(REPO_ROOT, 'service', 'src', 'config.mjs').replace(/\\/g, '/'))});
const c = m.config;
process.stdout.write(JSON.stringify({
  repoRoot: m.REPO_ROOT, pkgDir: m.PKG_DIR, stateDir: m.STATE_DIR, tasksStateDir: m.TASKS_STATE_DIR,
  idempotencyFile: m.IDEMPOTENCY_FILE, tokenFile: m.TOKEN_FILE, rootDir: m.ROOT_DIR,
  runtimeRoot: m.RUNTIME_ROOT,
  engineDir: c.engineDir, engineServerDir: c.engineServerDir, enginePython: c.enginePython, engineModelDir: c.engineModelDir,
  modelManifest: m.MODEL_MANIFEST,
}));
`;

async function dumpRust(env) {
  if (!fs.existsSync(RUST_BIN)) {
    throw new Error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd app/src-tauri && cargo build --bin boxsvc`);
  }
  return JSON.parse((await run(RUST_BIN, ['--print-paths'], env)).trim());
}
async function dumpNode(env) {
  return JSON.parse((await run(process.execPath, ['--input-type=module', '-e', NODE_DUMP], { MIAO_TOKEN: TOKEN, ...env })).trim());
}

const TOOLING_DUMP = `
const m = await import(${JSON.stringify('file://' + path.join(REPO_ROOT, 'engine', 'scripts', 'runtime-root.mjs').replace(/\\/g, '/'))});
process.stdout.write(JSON.stringify({ runtimeRoot: m.runtimeRoot(), runtimesDir: m.runtimesDir() }));
`;

async function dumpTooling(env) {
  return JSON.parse((await run(process.execPath, ['--input-type=module', '-e', TOOLING_DUMP], { MIAO_TOKEN: TOKEN, ...env })).trim());
}

/** 逐键逐字节比对；返回差异数组（空 = 完全一致）。导出以便反证轮复用它。 */
export function diffPaths(a, b) {
  const out = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) out.push(`Rust 缺键 ${k}`);
    else if (!(k in b)) out.push(`Node 缺键 ${k}`);
    else if (a[k] !== b[k]) out.push(`${k}: rust=${JSON.stringify(a[k])} node=${JSON.stringify(b[k])}`);
  }
  return out;
}

/** 期望的应用数据目录（与两侧 `defaultAppDataDir` / `app_data_dir` 同一套平台分叉）。 */
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
  const venvRel = process.platform === 'win32'
    ? path.join('Scripts', 'python.exe')
    : path.join('bin', 'python');
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
 * B1 收尾：**装配脚本**的落点必须与产品快照同源。
 * 返回差异数组（空 = 一致）。导出以便反证轮复用它。
 *
 * 为什么值得单独一条：`engine/scripts/runtime-root.mjs` 是 `config.mjs` 之外的第二份实现
 * （config.mjs import 即有副作用、且必须是 Rust 的逐字节对照端，不能被工具链反向依赖）。
 * 两份实现必然面临漂移 —— 而漂移的症状是「装到 A、读到 B」，**两边都不报错**。
 */
export function diffTooling(tooling, nodeSnap) {
  if (!tooling || !nodeSnap) return ['缺少快照'];
  const out = [];
  if (tooling.runtimeRoot !== nodeSnap.runtimeRoot) {
    out.push(`runtimeRoot: 工具链=${JSON.stringify(tooling.runtimeRoot)} 产品=${JSON.stringify(nodeSnap.runtimeRoot)}`);
  }
  // 模型根 = `engineDir/..`（config.mjs 的 engineModelDir 就是这么派生的）
  const want = path.resolve(nodeSnap.engineDir, '..');
  if (tooling.runtimesDir !== want) {
    out.push(`runtimesDir: 工具链=${JSON.stringify(tooling.runtimesDir)} 产品=${JSON.stringify(want)}`);
  }
  return out;
}

// ------------------------------------------------------------------ 正向

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-paths-parity-'));
const SCENARIOS = [
  { id: 'PATH.default', label: '无覆盖时 13 个路径逐字节相同', env: {} },
  {
    id: 'PATH.override',
    label: 'env 覆盖后 13 个路径仍逐字节相同',
    env: {
      MIAO_STATE_DIR: path.join(TMP, 'state'),
      MIAO_ROOT: path.join(TMP, 'root', 'Box 漫画'),
      MIAO_ENGINE_DIR: path.join(TMP, 'eng', 'src'),
      MIAO_ENGINE_PYTHON: path.join(TMP, 'eng', 'venv', 'Scripts', 'python.exe'),
      MIAO_ENGINE_SERVER_DIR: path.join(TMP, 'eng', 'src', 'server'),
      MIAO_MODEL_MANIFEST: path.join(TMP, 'models.json'),
    },
  },
];

let rustDefault = null;
let nodeDefault = null;
for (const sc of SCENARIOS) {
  try {
    const rust = await dumpRust(sc.env);
    const node = await dumpNode(sc.env);
    if (sc.id === 'PATH.default') {
      rustDefault = rust;
      nodeDefault = node;
    }
    const d = diffPaths(rust, node);
    check(`${sc.id} — ${sc.label}`, d.length === 0, d);
  } catch (e) {
    check(`${sc.id} — ${sc.label}`, false, String(e.message || e));
  }
}

// PATH.keys：键集合一致（与 default 场景同物，但单独成条 —— 它是 M3 的目标）
{
  const a = rustDefault ? Object.keys(rustDefault).sort() : [];
  const b = nodeDefault ? Object.keys(nodeDefault).sort() : [];
  check('PATH.keys — 两侧路径键集合完全一致', a.length > 0 && a.join(',') === b.join(','), { rust: a, node: b });
}

// PATH.appData（B1 验收①）：未设 `MIAO_*` 时引擎落点必须锚在 `<appData>/runtimes`，两侧都是。
//    为什么单独一条：逐字节相同**不保证**落点正确 —— 两边一起锚在仓库根上同样"逐字节相同"，
//    而打包后那就是错的（A1 已论证 `repo_root()` 在打包态算不出根）。
{
  const bad = [];
  for (const [side, snap] of [['rust', rustDefault], ['node', nodeDefault]]) {
    if (!snap) {
      bad.push(`${side} 无快照`);
      continue;
    }
    bad.push(...appDataViolations(snap).map((v) => `${side}: ${v}`));
  }
  check('PATH.appData — B1：未设 MIAO_* 时引擎落点在 <appData>/runtimes（两侧）', bad.length === 0, bad);
}

// PATH.tooling（B1 收尾）：装配脚本（setup-engine / install-engine-deps / fetch-models）
//    共用的落点必须与产品同源。没有这条，「装到 A、读到 B」会一直静默。
{
  const bad = [];
  let tooling = null;
  try {
    tooling = await dumpTooling(SCENARIOS[0].env);
  } catch (e) {
    bad.push(`工具链 dump 失败：${e.message || e}`);
  }
  if (!nodeDefault) bad.push('node 无快照');
  else bad.push(...diffTooling(tooling, nodeDefault));
  check('PATH.tooling — B1：引擎装配脚本落点与产品同源', bad.length === 0, bad);
}

// ------------------------------------------------------------------ 反证
if (REFUTE) {
  if (failed > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }
  const mutations = [
    {
      id: 'M1',
      what: '篡改 Node 侧 enginePython',
      run: () => diffPaths(rustDefault, { ...nodeDefault, enginePython: 'X:/wrong/python' }).length > 0,
    },
    {
      id: 'M2',
      what: '篡改 Rust 侧 rootDir',
      run: () => diffPaths({ ...rustDefault, rootDir: 'X:/wrong/root' }, nodeDefault).length > 0,
    },
    {
      id: 'M3',
      what: '删掉 Node 侧一个键',
      run: () => {
        const b = { ...nodeDefault };
        delete b.tokenFile;
        return diffPaths(rustDefault, b).some((x) => x.includes('Node 缺键 tokenFile'));
      },
    },
    {
      id: 'M4',
      what: 'Node 侧默认值退回仓库布局（B1 的回归）',
      run: () => {
        const repoRt = path.join(nodeDefault.repoRoot, 'runtimes');
        const repo = {
          ...nodeDefault,
          runtimeRoot: repoRt,
          engineDir: path.join(repoRt, 'manga-translator', 'src'),
          enginePython: path.join(repoRt, 'manga-translator', 'venv', 'Scripts', 'python.exe'),
        };
        // 必须同时让「同源」与「落点」两边都不成立 —— 只红一条说明另一条是死的
        return appDataViolations(repo).length > 0 && diffPaths(rustDefault, repo).length > 0;
      },
    },
    {
      id: 'M5',
      what: '装配脚本落点退回仓库 runtimes/（B1 收尾的回归）',
      run: () => {
        const repoRt = path.join(nodeDefault.repoRoot, 'runtimes');
        return diffTooling(
          { runtimeRoot: repoRt, runtimesDir: path.join(repoRt, 'manga-translator') },
          nodeDefault,
        ).length > 0;
      },
    },
  ];
  let allRed = true;
  for (const m of mutations) {
    const red = m.run();
    if (!red) allRed = false;
    console.log(`  ${red ? '✓' : '✗'} ${m.id} ${m.what} → ${red ? '按预期变红' : '**没有红**'}`);
  }
  console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed, allRed }));
  console.log(`\nF2 路径同源：正向 ${passed} / ${passed + failed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`);
  process.exit(allRed ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(`\nF2 路径同源：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`);
process.exit(failed === 0 ? 0 : 1);
