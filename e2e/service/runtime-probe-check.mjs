#!/usr/bin/env node
/**
 * B2 · 运行时就绪**检测**钉子 —— 「缺哪一项说得清，且说得具体」
 * =============================================================================
 * 对应计划文档 B2：检测项逐项独立报真伪，`detail` 必带绝对路径，`fix` 给装法。
 * 端点是 `GET /api/v1/engine/runtime`（Rust `boxsvc::engine::runtime_probe`）。
 *
 * ## 它钉的是什么
 * 检测若写成"一个大 if"或"全有或全无"，用户收到的就是"引擎没装好"这种无从下手的结论 ——
 * 而四项的装法完全不同（建 venv / 解源码 / pip 依赖）。故本钉子逐个**拆掉一样**，
 * 断言**只有对应那一项**翻转，其余三项纹丝不动。这一条同时证明了各判据真的作用在
 * 各自的绝对路径上（而不是在查同一个东西）。
 *
 * ## 为什么每个场景都自造 runtime 目录
 * 判据的默认落点是 `<appData>/runtimes/manga-translator`（B1）。验收若用真实落点，
 * 就会去 `stat` 用户机器上的引擎安装 ⇒ 结果随机器而变、且会误判。故每场景都用
 * `MIAO_RUNTIME_ROOT` / `MIAO_ENGINE_DIR` / `MIAO_ENGINE_PYTHON` 把判据指到 TMP，
 * 与 `MIAO_ROOT` / `MIAO_STATE_DIR` 一律指 TMP 是同一条纪律。
 *
 * ## 反证轮（--refute）
 * - M1 把 `source` 判据从"`server/main.py` 存在"弱化成"`src/` 非空" ⇒ S2 不再翻转
 *   （抓装机脚本注释里明确警告过的那个错法：`--link` 会先建 models 链接，src/ 非空但没源码）。
 * - M2 把 `detail` 里的路径去掉 ⇒ S0/S1/S2/S3 的"detail 带绝对路径"断言全红。
 * 两个变异都改 `runtime_probe.rs` 源码、跑完**按字节还原**（含重编译产物）。
 *
 * 用法：node e2e/service/runtime-probe-check.mjs [--refute]
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
const PROBE_RS = path.join(REPO_ROOT, 'app', 'src-tauri', 'src', 'boxsvc', 'engine', 'runtime_probe.rs');
const SRC_TAURI = path.join(REPO_ROOT, 'app', 'src-tauri');
/// `cargo` 可执行：`CARGO` env 覆盖，否则交给 PATH（libuv 在 Windows 上会补 `.exe`）。
const CARGO = process.env.CARGO || 'cargo';

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

// ------------------------------------------------------------------ 夹具：造一个 runtime

/** 建一份「全就位」的假引擎运行时；`missing` 指定要拆掉哪几样。 */
function buildRuntime(base, missing = []) {
  const rt = path.join(base, 'rt');
  const src = path.join(rt, 'manga-translator', 'src');
  const venv = path.join(rt, 'manga-translator', 'venv');
  fs.mkdirSync(path.join(src, 'server'), { recursive: true });
  fs.mkdirSync(path.join(src, 'manga_translator'), { recursive: true });
  if (process.platform === 'win32') {
    fs.mkdirSync(path.join(venv, 'Scripts'), { recursive: true });
    fs.mkdirSync(path.join(venv, 'Lib', 'site-packages', 'torch'), { recursive: true });
    fs.writeFileSync(path.join(venv, 'Scripts', 'python.exe'), 'MZ-fixture');
  } else {
    fs.mkdirSync(path.join(venv, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(venv, 'lib', 'python3.11', 'site-packages', 'torch'), { recursive: true });
    fs.writeFileSync(path.join(venv, 'bin', 'python'), '#!/bin/sh\n');
  }
  fs.writeFileSync(path.join(src, 'server', 'main.py'), '# fixture\n');
  if (missing.includes('python')) fs.rmSync(path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true, force: true });
  if (missing.includes('source')) fs.rmSync(path.join(src, 'server'), { recursive: true, force: true });
  if (missing.includes('deps')) fs.rmSync(path.join(venv, 'Lib', 'site-packages', 'torch'), { recursive: true, force: true });
  if (missing.includes('venvRoot')) fs.rmSync(path.join(rt, 'manga-translator'), { recursive: true, force: true });
  return {
    rt,
    env: {
      MIAO_RUNTIME_ROOT: rt,
      MIAO_ENGINE_DIR: src,
      MIAO_ENGINE_PYTHON: path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python'),
    },
  };
}

// ------------------------------------------------------------------ 起服务 / 打端点

function startService(extraEnv) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-runtime-probe-'));
  const child = spawn(RUST_BIN, [], {
    env: {
      ...process.env,
      MIAO_TOKEN: TOKEN,
      MIAO_ROOT: path.join(tmp, 'root'),
      MIAO_STATE_DIR: path.join(tmp, 'state'),
      MIAO_ENGINE_PROTOCOL: 'mock',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => { child.kill(); reject(new Error('boxsvc 15s 内未就绪')); }, 15000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /MIAO_READY (\{.*\})/.exec(buf);
      if (m) {
        clearTimeout(to);
        resolve({ port: JSON.parse(m[1]).port, kill: () => child.kill() });
      }
    });
    child.stderr.on('data', (d) => (buf += d));
    child.on('close', (code) => { clearTimeout(to); reject(new Error(`boxsvc 退出 ${code}：${buf.slice(0, 500)}`)); });
  });
}

async function probeRuntime(extraEnv) {
  const svc = await startService(extraEnv);
  try {
    const res = await fetch(`http://127.0.0.1:${svc.port}/api/v1/engine/runtime`, { headers: { 'x-box-token': TOKEN } });
    return { status: res.status, body: await res.json() };
  } finally {
    svc.kill();
  }
}

/** 场景 → 期望翻转的项（`null` = 期望全就位）。 */
const SCENARIOS = [
  { id: 'S0', missing: null, label: 'runtime 全就位 ⇒ 四项全真、ready=true、无 fix' },
  { id: 'S1', missing: ['python'], label: '只拆解释器 ⇒ **只有 python** 翻转' },
  { id: 'S2', missing: ['source'], label: '只拆 server/main.py ⇒ **只有 source** 翻转' },
  { id: 'S3', missing: ['deps'], label: '只拆 torch ⇒ **只有 deps** 翻转' },
  { id: 'S4', missing: ['venvRoot'], label: '整个运行时候选 ⇒ venvRoot 翻转（级联允许）' },
];

if (!fs.existsSync(RUST_BIN)) {
  console.error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd app/src-tauri && cargo build --bin boxsvc`);
  process.exit(1);
}

const byId = (body) => Object.fromEntries((body?.items ?? []).map((i) => [i.id, i]));

// ------------------------------------------------------------------ 正向

// A0 端点契约：需鉴权（engine 组是 Box 专用端点，不是免鉴权例外）
{
  const svc = await startService({});
  try {
    const res = await fetch(`http://127.0.0.1:${svc.port}/api/v1/engine/runtime`);
    check('A0 /engine/runtime 无令牌 → 403（engine 组是 Box 专用端点）', res.status === 403, res.status);
  } finally {
    svc.kill();
  }
}

for (const sc of SCENARIOS) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `miao-rt-${sc.id}-`));
  const fx = buildRuntime(base, sc.missing ?? []);
  const { status, body } = await probeRuntime(fx.env);
  const items = byId(body);
  const expected = sc.missing ?? [];
  const flips = Object.entries(items).filter(([, v]) => !v.ok).map(([k]) => k);
  if (sc.missing === null) {
    check(`${sc.id} ${sc.label}`,
      status === 200 && body?.ready === true && flips.length === 0
      && Object.values(items).every((v) => v.fix === null || v.fix === undefined),
      { status, ready: body?.ready, flips });
  } else if (sc.missing.includes('venvRoot')) {
    // 级联场景：venvRoot 没了 ⇒ python/source/deps 的判据路径都在它下面，必然一起翻。
    // 这里不断言"其余不动"（那是结构上不可能的），只钉 venvRoot **一定**翻、且 ready=false。
    check(`${sc.id} ${sc.label}`,
      status === 200 && flips[0] === 'venvRoot' && body?.ready === false
      && items.venvRoot.fix && items.venvRoot.fix.length > 0,
      { status, ready: body?.ready, flips });
  } else if (sc.missing.length === 1) {
    // 单项场景：**只有**那一项翻转 —— 证明各判据作用在各自的绝对路径上
    const only = sc.missing[0];
    check(`${sc.id} ${sc.label}`,
      status === 200 && flips.length === 1 && flips[0] === only
      && items[only].fix && items[only].fix.length > 0,
      { status, flips, fix: items[only]?.fix });
  } else {
    check(`${sc.id} ${sc.label}`,
      status === 200 && flips.includes('venvRoot') && body?.ready === false,
      { status, ready: body?.ready, flips });
  }
  // 验收③：每一项的 detail 必带它自己的绝对路径
  for (const [id, v] of Object.entries(items)) {
    check(`${sc.id}.detail ${id} — detail 带绝对路径`, typeof v.detail === 'string' && v.detail.includes(v.path), v.detail);
  }
  fs.rmSync(base, { recursive: true, force: true });
}

/** 重编译 boxsvc。🔴 变异改了 Rust 源码，靶子是**另一个进程**，不重编等于没改。 */
function rebuild() {
  const build = spawn(CARGO, ['build', '--bin', 'boxsvc'], { cwd: SRC_TAURI, stdio: 'ignore' });
  return new Promise((resolve) => {
    build.on('close', (c) => resolve(c === 0));
    build.on('error', () => resolve(false));
  });
}

// ------------------------------------------------------------------ 反证
if (REFUTE) {
  if (failed > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }
  const original = fs.readFileSync(PROBE_RS, 'utf8');
  const mutations = [];

  // M1：source 判据弱化成"src/ 非空" ⇒ S2 场景不再翻转（抓装机脚本明确警告过的错法）
  mutations.push({
    id: 'M1',
    what: 'source 判据弱化为「src/ 非空」',
    edit: () => {
      const weak = original.replace(
        /let src_ok = is_file\(&main_py\);/,
        'let src_ok = paths::engine_dir().is_dir();',
      );
      if (weak === original) throw new Error('M1 锚点未命中（runtime_probe.rs 的 source 判据写法变了？）');
      fs.writeFileSync(PROBE_RS, weak);
    },
    probe: async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-rt-M1-'));
      const fx = buildRuntime(base, ['source']);
      const { body } = await probeRuntime(fx.env);
      const items = byId(body);
      const flips = Object.entries(items).filter(([, v]) => !v.ok).map(([k]) => v);
      fs.rmSync(base, { recursive: true, force: true });
      // 期望：source **不再**翻转（弱判据下 src/ 还在 ⇒ 报就绪）
      return !flips.includes('source');
    },
  });

  // M2：detail 去掉路径 ⇒ "detail 带绝对路径"断言全红
  mutations.push({
    id: 'M2',
    what: 'detail 不再带绝对路径',
    edit: () => {
      // 🔴 必须把**参数一起吃掉**（换成 `String::from`）：只换字符串字面量会留下没用上的参数，
      //    而 Rust 把「format! 参数未使用」列为 **error**（不是 warning）⇒ 编译失败 ⇒
      //    "变异失败"与"断言没红"是两件事，后者才是要判的。
      //    这些 `format!` 调用都是单行，故 `[^\n]*` 足够吃到行末的右括号。
      const stripped = original.replace(
        /format!\("(?:解释器不在位|引擎源码标志文件缺失|运行时根不存在|依赖缺失)[^"]*",[^\n]*\)/g,
        'String::from("缺少必要组件")',
      );
      if (stripped === original) throw new Error('M2 锚点未命中');
      fs.writeFileSync(PROBE_RS, stripped);
    },
    probe: async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-rt-M2-'));
      const fx = buildRuntime(base, ['python']);
      const { body } = await probeRuntime(fx.env);
      const items = byId(body);
      fs.rmSync(base, { recursive: true, force: true });
      return Object.values(items).some((v) => !v.detail.includes(v.path));
    },
  });

  let allRed = true;
  for (const m of mutations) {
    try {
      m.edit();
      // 🔴 源码改了必须**重编译**：Rust 靶子是另一个进程，不重编就等于没改（A1 的教训）
      if (!(await rebuild())) throw new Error('cargo build 失败');
      const red = await m.probe();
      if (!red) allRed = false;
      console.log(`  ${red ? '✓' : '✗'} ${m.id} ${m.what} → ${red ? '按预期变红' : '**没有红**'}`);
    } catch (e) {
      allRed = false;
      console.log(`  ✗ ${m.id} ${m.what} → 变异本身失败：${String(e.message || e).slice(0, 200)}`);
    } finally {
      fs.writeFileSync(PROBE_RS, original);
      await rebuild();
    }
  }
  const restored = fs.readFileSync(PROBE_RS, 'utf8');
  check('REFUTE.restore — runtime_probe.rs 已按字节还原', restored === original);
  console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed, allRed }));
  console.log(`\nB2 运行时就绪检测：正向 ${passed} / ${passed + failed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`);
  process.exit(allRed && failed === 0 ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(`\nB2 运行时就绪检测：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`);
process.exit(failed === 0 ? 0 : 1);
