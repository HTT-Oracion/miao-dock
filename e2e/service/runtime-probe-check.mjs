#!/usr/bin/env node
/**
 * B2 · 运行时就绪**检测**钉子 —— 「缺哪一项说得清，且说得具体」
 * =============================================================================
 * 对应计划文档 B2：检测项逐项独立报真伪，`detail` 必带绝对路径，`fix` 给装法。
 * 端点是 `GET /api/v1/engine/runtime`（Rust `boxsvc::engine::runtime_probe`）。
 *
 * ## 它钉的是什么
 * 检测若写成"一个大 if"或"全有或全无"，用户收到的就是"引擎没装好"这种无从下手的结论 ——
 * 而五项（B2 四项 + B5 补丁一项）的装法完全不同（建 venv / 解源码 / pip 依赖 / 重放补丁）。
 * 故本钉子逐个**拆掉一样**，断言**只有对应那一项**翻转，其余纹丝不动。这一条同时证明了
 * 各判据真的作用在各自的绝对路径上（而不是在查同一个东西）。
 *
 * ## 为什么每个场景都自造 runtime 目录
 * 判据的默认落点是 `<appData>/runtimes/manga-translator`（B1）。验收若用真实落点，
 * 就会去 `stat` 用户机器上的引擎安装 ⇒ 结果随机器而变、且会误判。故每场景都用
 * `MIAO_RUNTIME_ROOT` / `MIAO_ENGINE_DIR` / `MIAO_ENGINE_PYTHON` 把判据指到 TMP，
 * 与 `MIAO_ROOT` / `MIAO_STATE_DIR` 一律指 TMP 是同一条纪律。
 * 夹具里的补丁文件按 **Node 侧 SSOT**（`ENGINE_PATCHES`）生成 ⇒ 顺带验证 Rust 镜像
 * （`boxsvc::engine::patches`）的落点与 SSOT 一致：镜像若指错文件，S0 就会报"缺补丁"。
 *
 * ## 反证轮（--refute）
 * - M1 把 `source` 判据从"`server/main.py` 存在"弱化成"`src/` 非空" ⇒ S2 不再翻转
 *   （抓装机脚本注释里明确警告过的那个错法：`--link` 会先建 models 链接，src/ 非空但没源码）。
 * - M2 把 `detail` 里的路径去掉 ⇒ S0/S1/S2/S3 的"detail 带绝对路径"断言全红。
 * - M3 把 `patches` 判据弱化成"源码目录存在即算打过" ⇒ S5 不再翻转
 *   （抓"拿目录在当补丁打过"这个错法 —— 它的症状正是 B5 要消灭的静默失败）。
 * 三个变异都改 `runtime_probe.rs` 源码、跑完**按字节还原**（含重编译产物）。
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
import { buildRuntime, relOf } from './_runtime-fixture.mjs';
import { ENGINE_PATCHES } from '../../engine/scripts/setup-engine.mjs';
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

// ------------------------------------------------------------------ 夹具：造一个 runtime（共享模块，见 _runtime-fixture.mjs）

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
    const to = setTimeout(() => {
      child.kill();
      reject(new Error('boxsvc 15s 内未就绪'));
    }, 15000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /MIAO_READY (\{.*\})/.exec(buf);
      if (m) {
        clearTimeout(to);
        resolve({ port: JSON.parse(m[1]).port, kill: () => child.kill() });
      }
    });
    child.stderr.on('data', (d) => (buf += d));
    child.on('close', (code) => {
      clearTimeout(to);
      reject(new Error(`boxsvc 退出 ${code}：${buf.slice(0, 500)}`));
    });
  });
}

async function probeRuntime(extraEnv) {
  const svc = await startService(extraEnv);
  try {
    const res = await fetch(`http://127.0.0.1:${svc.port}/api/v1/engine/runtime`, {
      headers: { 'x-box-token': TOKEN },
    });
    return { status: res.status, body: await res.json() };
  } finally {
    svc.kill();
  }
}

/** 场景 → 期望翻转的项（`null` = 期望全就位）。 */
const SCENARIOS = [
  { id: 'S0', missing: null, label: 'runtime 全就位 ⇒ 五项全真、ready=true、无 fix' },
  { id: 'S1', missing: ['python'], label: '只拆解释器 ⇒ **只有 python** 翻转' },
  { id: 'S2', missing: ['source'], label: '只拆 server/main.py ⇒ **只有 source** 翻转' },
  { id: 'S3', missing: ['deps'], label: '只拆 torch ⇒ **只有 deps** 翻转' },
  { id: 'S4', missing: ['venvRoot'], label: '整个运行时候选 ⇒ venvRoot 翻转（级联允许）' },
  { id: 'S5', missing: ['patches'], label: '只抹一个补丁的 mark ⇒ **只有 patches** 翻转且点名到 patch id' },
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
  const flips = Object.entries(items)
    .filter(([, v]) => !v.ok)
    .map(([k]) => k);
  if (sc.missing === null) {
    check(
      `${sc.id} ${sc.label}`,
      status === 200 &&
        body?.ready === true &&
        flips.length === 0 &&
        Object.values(items).every((v) => v.fix === null || v.fix === undefined),
      { status, ready: body?.ready, flips },
    );
  } else if (sc.missing.includes('venvRoot')) {
    // 级联场景：venvRoot 没了 ⇒ python/source/deps/patches 的判据路径都在它下面，必然一起翻。
    // 这里不断言"其余不动"（那是结构上不可能的），只钉 venvRoot **一定**翻、且 ready=false。
    check(
      `${sc.id} ${sc.label}`,
      status === 200 &&
        flips[0] === 'venvRoot' &&
        body?.ready === false &&
        items.venvRoot.fix &&
        items.venvRoot.fix.length > 0,
      { status, ready: body?.ready, flips },
    );
  } else if (sc.missing.length === 1) {
    // 单项场景：**只有**那一项翻转 —— 证明各判据作用在各自的绝对路径上
    const only = sc.missing[0];
    check(
      `${sc.id} ${sc.label}`,
      status === 200 && flips.length === 1 && flips[0] === only && items[only].fix && items[only].fix.length > 0,
      { status, flips, fix: items[only]?.fix },
    );
    // B5 验收①：缺补丁必须**点名到 patch id**（只说"缺 1 个补丁"等于没说），
    // 且路径要落在**被抹掉 mark 的那个文件**上（不是笼统的源码目录）。
    if (only === 'patches') {
      const p = ENGINE_PATCHES[0];
      const abs = path.join(fx.src, ...relOf(p));
      check(
        'S5.named — detail 点名到 patch id 且带该补丁目标文件的绝对路径',
        items.patches.detail.includes(p.id) && items.patches.detail.includes(abs),
        { id: p.id, abs, detail: items.patches.detail },
      );
    }
  } else {
    check(`${sc.id} ${sc.label}`, status === 200 && flips.includes('venvRoot') && body?.ready === false, {
      status,
      ready: body?.ready,
      flips,
    });
  }
  // 验收③：每一项的 detail 必带它自己的绝对路径
  for (const [id, v] of Object.entries(items)) {
    check(
      `${sc.id}.detail ${id} — detail 带绝对路径`,
      typeof v.detail === 'string' && v.detail.includes(v.path),
      v.detail,
    );
  }
  fs.rmSync(base, { recursive: true, force: true });
}

// S6：运行时根是**链接**（用户把 15 GB 挪到别盘后 junction / 软链回来）⇒ 五项仍全真。
// 🔴 判据必须**跟随**链接：Windows 的 junction 在 lstat 下报成 symlink（`is_dir()==false`）⇒
//    判据若停在链接本身上，「装好了却报没装」这种假阴性直接冒出来 —— 正是 B1/B3 要消灭的。
//    （原实现用的是 `symlink_metadata`，与它注释里的意图相反；本仓从未触发过，因为生产里
//    被查路径没有一个本身是链接，直到开发机把 runtime root 做成 junction 才暴露。）
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-rt-S6-'));
  const fx = buildRuntime(base, []);
  const linkBase = path.join(base, 'linked');
  fs.mkdirSync(linkBase, { recursive: true });
  const link = path.join(linkBase, 'manga-translator');
  const target = path.join(fx.rt, 'manga-translator');
  // junction 不需要提权（符号链接要），Windows 上优先它；POSIX 用目录软链
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  // 三项 env 全部**穿过链接**：只穿一项等于只测一项
  const { status, body } = await probeRuntime({
    MIAO_RUNTIME_ROOT: linkBase,
    MIAO_ENGINE_DIR: path.join(link, 'src'),
    MIAO_ENGINE_PYTHON: path.join(
      link,
      'venv',
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python',
    ),
  });
  const items = byId(body);
  const flips = Object.entries(items)
    .filter(([, v]) => !v.ok)
    .map(([k]) => k);
  check(
    'S6 运行时根是链接（junction/软链）⇒ 五项仍全真（判据必须跟随链接）',
    status === 200 && body?.ready === true && flips.length === 0,
    { status, ready: body?.ready, flips },
  );
  for (const [id, v] of Object.entries(items)) {
    check(`S6.detail ${id} — detail 带绝对路径`, typeof v.detail === 'string' && v.detail.includes(v.path), v.detail);
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
      const weak = original.replace(/let src_ok = is_file\(&main_py\);/, 'let src_ok = paths::engine_dir().is_dir();');
      if (weak === original) throw new Error('M1 锚点未命中（runtime_probe.rs 的 source 判据写法变了？）');
      fs.writeFileSync(PROBE_RS, weak);
    },
    probe: async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-rt-M1-'));
      const fx = buildRuntime(base, ['source']);
      const { body } = await probeRuntime(fx.env);
      const items = byId(body);
      const flips = Object.entries(items)
        .filter(([, v]) => !v.ok)
        .map(([k]) => k);
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

  // M3：patches 判据弱化成"源码目录存在即算打过" ⇒ S5 不再翻转
  // （抓"拿目录在当补丁打过"这个错法 —— 它的症状正是 B5 要消灭的静默失败）
  mutations.push({
    id: 'M3',
    what: 'patches 判据弱化为「源码目录存在」',
    edit: () => {
      const weak = original.replace(
        /let states = patches::patch_states\(src\);/,
        'let states = patches::patch_states(src).into_iter().map(|mut s| { s.applied = s.path.parent().map(|p| p.is_dir()).unwrap_or(false); s }).collect::<Vec<_>>();',
      );
      if (weak === original) throw new Error('M3 锚点未命中（patches_item 的写法变了？）');
      fs.writeFileSync(PROBE_RS, weak);
    },
    probe: async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-rt-M3-'));
      const fx = buildRuntime(base, ['patches']);
      const { body } = await probeRuntime(fx.env);
      const items = byId(body);
      const flips = Object.entries(items)
        .filter(([, v]) => !v.ok)
        .map(([k]) => k);
      fs.rmSync(base, { recursive: true, force: true });
      // 期望：patches **不再**翻转（弱判据下源码目录还在 ⇒ 报"全打过"）
      return !flips.includes('patches');
    },
  });

  // M4：判据改回 `symlink_metadata`（不跟随链接）⇒ S6 不再全真
  // （抓「停在链接本身上」这个错法：Windows 的 junction 在 lstat 下是 symlink 而非目录，
  //   于是「运行时被 junction 到别盘」会被判成没装 —— 装好了却报没装的假阴性）
  mutations.push({
    id: 'M4',
    what: 'is_file/is_dir 改回 symlink_metadata（不跟随链接）',
    edit: () => {
      const weak = original.replace(
        /std::fs::metadata\(p\)\.map\(\|m\| m\.is_(file|dir)\(\)\)/g,
        'std::fs::symlink_metadata(p).map(|m| m.is_$1())',
      );
      if (weak === original) throw new Error('M4 锚点未命中（is_file/is_dir 的写法变了？）');
      fs.writeFileSync(PROBE_RS, weak);
    },
    probe: async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-rt-M4-'));
      const fx = buildRuntime(base, []);
      const linkBase = path.join(base, 'linked');
      fs.mkdirSync(linkBase, { recursive: true });
      const link = path.join(linkBase, 'manga-translator');
      const target = path.join(fx.rt, 'manga-translator');
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      const { body } = await probeRuntime({
        MIAO_RUNTIME_ROOT: linkBase,
        MIAO_ENGINE_DIR: path.join(link, 'src'),
        MIAO_ENGINE_PYTHON: path.join(
          link,
          'venv',
          process.platform === 'win32' ? 'Scripts' : 'bin',
          process.platform === 'win32' ? 'python.exe' : 'python',
        ),
      });
      const items = byId(body);
      fs.rmSync(base, { recursive: true, force: true });
      // 期望：venvRoot 翻转（链接本身被判成"不存在"）⇒ 不再全真
      return body?.ready !== true;
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
  console.log(
    `\nB2 运行时就绪检测：正向 ${passed} / ${passed + failed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`,
  );
  process.exit(allRed && failed === 0 ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(
  `\nB2 运行时就绪检测：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`,
);
process.exit(failed === 0 ? 0 : 1);
