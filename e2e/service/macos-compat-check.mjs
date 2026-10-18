#!/usr/bin/env node
/**
 * D7 · 「macOS 兼容」钉子 —— 差异收缩到两处，且都是「写对一处即可」
 * =============================================================================
 * 对应计划文档 D7：差异只有两处 ——
 *   ① **解释器路径分叉**（POSIX `bin/python` vs Windows `Scripts/python.exe`）；
 *   ② **安装命令不同**（Xcode CLT / MPS vs MSVC / CUDA）—— 纯文档。
 *
 * ## 取证边界（如实记账，别把"没验"说成"验了"）
 * 本机只有一个平台的真二进制，"另一平台的分支"永远只能对**同源镜像表**（那是
 * `check:install-guide` 的活，它已如实标注边界）。所以这里钉的是**能真正执行到的部分**：
 *
 *   W1  解释器路径分叉在源码里**两个形态都在**，且**实跑** `--print-paths` 的形态
 *       与当前平台一致（Windows 上必须是 `Scripts\python.exe`，不许出现 `bin/python`）；
 *   W1b 检测侧（`--print-paths`）与启动侧（`--print-launch-plan` 的 `cmd[0]`）**逐字节相同**
 *       —— B3 已钉过，这里是 D7 视角的复验（解释器分叉最容易在两处各写一遍）；
 *   W2  **Windows 专用脚本在非 Windows 下真的拒绝**：退出码 2 + `PLATFORM_UNSUPPORTED`
 *       + 指向 macOS 文档 + **不含 `ENOENT`**（D7 验收②）。这条在 Windows 上**真跑得到**
 *       —— 靠 `MIAO_PLATFORM` 这个**取证接缝**（与 C3 用的是同一个键）。
 *   W3  那道守卫必须**早于任何 `fs` / `spawn`** —— 否则报错仍然先撞上 `ENOENT`。
 *   W4  文档分平台：macOS 引导里每一次 `deps:engine` 都在**"不能用"的语境**里；
 *       Windows 引导里有一条**普通调用**（不是"别跑"）。
 *   W5  `unverified` 记账在位：macOS 真机验收明确挂在 D7 名下，不许静默计入"已验"。
 *
 * ## 反证轮（--refute）
 * - M1 把守卫条件改宽（`!== 'linux'`，等于"只在 Linux 上拒绝"）⇒ W2 红。
 * - M2 把守卫整段删掉 ⇒ W2 + W3 红。
 * - M3 在 macOS 引导里把"不能用"写成普通调用 ⇒ W4 红。
 *
 * 用法：node e2e/service/macos-compat-check.mjs [--refute]
 * 前置：`cd src-tauri && cargo build --bin mangasvc`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RUST_BIN, REPO_ROOT } from './_service-harness.mjs';

const REFUTE = process.argv.includes('--refute');
const SELF = fileURLToPath(import.meta.url);
const PATHS_RS = path.join(REPO_ROOT, 'src-tauri', 'src', 'platform', 'paths.rs');
const DEPS_MJS = path.join(REPO_ROOT, 'engine', 'scripts', 'install-engine-deps.mjs');
const GUIDE_WIN = path.join(REPO_ROOT, 'docs', 'install-guide-windows.md');
const GUIDE_MAC = path.join(REPO_ROOT, 'docs', 'install-guide-macos.md');
const INSTALL_GUIDE_CHECK = path.join(REPO_ROOT, 'e2e', 'service', 'install-guide-check.mjs');
const README = path.join(REPO_ROOT, 'README.md');
const SRC_TAURI = path.join(REPO_ROOT, 'src-tauri');
/** `cargo` 可执行：`CARGO` env 覆盖，否则交给 PATH。 */
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

if (!fs.existsSync(RUST_BIN)) {
  console.error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd src-tauri && cargo build --bin mangasvc`);
  process.exit(1);
}

/** 跑一条 `mangasvc` 子命令（异步 —— 本机 `spawnSync` 稳定 EBUSY）。 */
function mangasvc(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const c = spawn(RUST_BIN, args, {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => {
      out += d;
    });
    c.stderr.on('data', (d) => {
      err += d;
    });
    c.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

/**
 * `paths.rs::venv_python_rel` 的**函数体**（切点取列 0 的收尾大括号，结构上恒定）。
 *
 * ⚠️ 判据必须限定在函数体内，不能全文件搜：`paths.rs` 的**单测**里也写着这两个形态字面量，
 * 全文件搜的话，把推导（真正生效的那处）改成"两平台都返回 Windows 形态"之后，
 * 单测里那几行仍会让断言保持绿色 —— 反证轮实测到的假阳性（2026-10-14）。
 */
function venvRelBody() {
  const rs = fs.readFileSync(PATHS_RS, 'utf8');
  const start = rs.indexOf('pub fn venv_python_rel()');
  const end = start < 0 ? -1 : rs.indexOf('\n}', start);
  return start >= 0 && end > start ? rs.slice(start, end + 2) : '';
}

function runNode(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => {
      out += d;
    });
    c.stderr.on('data', (d) => {
      err += d;
    });
    c.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

// ------------------------------------------------------------------ W1/W1b：解释器分叉写在**一处**，且两侧同源

{
  /*
   * 两个形态都必须在**推导函数体里**（见 `venvRelBody()` 的说明）。
   *
   * 为什么这条非要钉：它是**编译期**分叉（`cfg!(target_os)`），本机只编得出一支，
   * "另一支还在不在"只能看源码；而它被删掉的后果是**另一平台**的引擎起不来，
   * 症状是一句「python 找不到」，离根因极远。
   */
  const body = venvRelBody();
  const hasWin = /PathBuf::from\("Scripts"\)\.join\("python\.exe"\)/.test(body);
  const hasPosix = /PathBuf::from\("bin"\)\.join\("python"\)/.test(body);
  check(
    'W1 `paths.rs` 的解释器推导**函数体内**两个平台形态都在（POSIX `bin/python` / Windows `Scripts/python.exe`）',
    hasWin && hasPosix,
    { hasWin, hasPosix, bodyLen: body.length },
  );

  const p = await mangasvc(['--print-paths']);
  const paths = JSON.parse(p.out);
  const py = String(paths.enginePython ?? '');
  const winForm = /[\\/]Scripts[\\/]python\.exe$/i.test(py);
  const posixForm = /[\\/]bin[\\/]python$/.test(py);
  const expectWin = process.platform === 'win32';
  check(
    'W1b 实跑 `--print-paths`：解释器形态与**当前平台**一致、且不与另一平台的形态串（Windows 上不许出现 `bin/python`）',
    expectWin ? winForm && !posixForm : posixForm && !winForm,
    { enginePython: py, platform: process.platform },
  );

  const lp = await mangasvc(['--print-launch-plan', 'real']);
  const engineCmd0 = (JSON.parse(lp.out).engine?.cmd ?? [])[0] ?? '';
  check(
    'W1c 检测侧（`--print-paths`）与启动侧（`--print-launch-plan` 的 `cmd[0]`）**逐字节相同**（分叉只在推导里写一次）',
    engineCmd0 !== '' && path.resolve(engineCmd0) === path.resolve(py),
    { launch: engineCmd0, print: py },
  );
}

// ------------------------------------------------------------------ W2/W3：Windows 专用脚本在非 Windows 下**明确拒绝**

{
  // 🔴 取证接缝：本机是 Windows，走不到"非 Windows"那支分支 ⇒ 用 `MIAO_PLATFORM`
  //    把平台**假装**成 darwin-arm64（与 C3 的 `platform_key` 是同一个键）。
  const r = await runNode([DEPS_MJS], { MIAO_PLATFORM: 'darwin-arm64' });
  const text = `${r.out}${r.err}`;
  check(
    'W2 非 Windows 下调 Windows 专用脚本 ⇒ 退出码 2 + `PLATFORM_UNSUPPORTED` + 指向 macOS 引导（不是 `ENOENT python.exe`）',
    r.code === 2 && /PLATFORM_UNSUPPORTED/.test(text) && /install-guide-macos\.md/.test(text),
    { code: r.code, text: text.slice(0, 240) },
  );
  check(
    'W2b 拒绝文案里**不出现** `ENOENT`（出现即说明它是撞上了找不到解释器，而不是先拒绝了平台）',
    !/ENOENT/.test(text),
    { text: text.slice(0, 240) },
  );
  check('W2c 拒绝分支**不落任何东西**（一个字节都不该写进用户目录）', !/\[deps\]/.test(r.out), {
    out: r.out.slice(0, 160),
  });

  // W3：守卫必须早于任何 fs / spawn。
  const src = fs.readFileSync(DEPS_MJS, 'utf8');
  const guardAt = src.indexOf('PLATFORM_UNSUPPORTED');
  const firstIo = Math.min(
    ...[src.indexOf('fs.readFileSync('), src.indexOf('fs.writeFileSync('), src.indexOf('spawnSync(')].filter(
      (i) => i >= 0,
    ),
  );
  check(
    'W3 平台守卫出现在**任何 `fs` / `spawnSync` 之前**（否则报错仍会先撞上 ENOENT）',
    guardAt > 0 && Number.isFinite(firstIo) && guardAt < firstIo,
    { guardAt, firstIo },
  );
}

// ------------------------------------------------------------------ W4：文档分平台

{
  const norm = (s) => s.replace(/\r\n/g, '\n');
  const macLines = norm(fs.readFileSync(GUIDE_MAC, 'utf8'))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('deps:engine'));
  const winLines = norm(fs.readFileSync(GUIDE_WIN, 'utf8'))
    .split('\n')
    .map((l) => l.trim())
    // 形态跟着命令收束走：`npm run task -- deps:engine`（老形态 `npm run deps:engine` 也认，
    // 免得这条过滤器在文档换写法时**静默匹配到 0 行** ⇒ W4b 变成永远红的假判断）
    .filter((l) => /^\s*(?:\$\s*)?(?:npm run (?:task -- )?)?deps:engine/.test(l));

  // 「不能用」的语境：那一行必须带否定词（不同平台引导里出现同一个命令，唯一正当的理由就是劝退）
  const NEG = /(不能|不要|禁止|别|不支持|仅 Windows|与 Windows 不同)/;
  const macPlain = macLines.filter((l) => !NEG.test(l));
  check(
    'W4 macOS 引导里**每一次** `deps:engine` 都出现在"不能用"的语境里（不许让 macOS 用户去跑 Windows 专用脚本）',
    macLines.length > 0 && macPlain.length === 0,
    { macLines, macPlain },
  );

  const winPlain = winLines.filter((l) => !NEG.test(l));
  check(
    'W4b Windows 引导里有**普通调用**（不是用"别跑"绕过去）—— 两侧合起来才说明文档真的分平台了',
    winPlain.length > 0,
    { winLines, winPlain },
  );
}

// ------------------------------------------------------------------ W5：unverified 记账

{
  const igc = fs.readFileSync(INSTALL_GUIDE_CHECK, 'utf8');
  const readme = fs.readFileSync(README, 'utf8');
  check(
    'W5 `check:install-guide` 明写「macOS 侧真机验收归 D7」+ `unverified`（未真机验的项不许静默计入"已验"）',
    /D7/.test(igc) && /unverified/.test(igc),
    null,
  );
  check(
    'W5b `README.md` 的 macOS 说明同样标出真机未验证',
    /macOS/.test(readme) && /(未验证|未真机|unverified)/.test(readme),
    null,
  );
}

// ------------------------------------------------------------------ 反证轮

if (REFUTE) {
  console.log('\n── 反证轮（改源码 ⇒ 指定断言必须红；跑完按字节还原）──\n');

  function mutateFile(file, from, to) {
    const original = fs.readFileSync(file);
    const text = original.toString('utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const f = from.replace(/\r?\n/g, eol);
    const t = to.replace(/\r?\n/g, eol);
    if (!text.includes(f)) throw new Error(`反证锚点未命中（写法变了？）：${file}\n  ${from.slice(0, 80)}`);
    fs.writeFileSync(file, Buffer.from(text.replace(f, t), 'utf8'));
    return () => fs.writeFileSync(file, original);
  }

  const runForward = () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [SELF], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => {
        out += d;
      });
      c.stderr.on('data', (d) => {
        out += d;
      });
      c.on('error', () => resolve({ code: -1, out }));
      c.on('close', (code) => resolve({ code, out }));
    });

  const hasRed = (out, name) => out.split('\n').some((l) => l.trimStart().startsWith('✗') && l.includes(name));
  const redOn = (out) =>
    out
      .split('\n')
      .filter((l) => l.trimStart().startsWith('✗'))
      .map((l) => l.trim().slice(0, 46));

  const LOSE_POSIX = 'PathBuf::from("bin").join("python")';
  // 🔴 锚点必须与**当前**守卫逐字一致。B4 给守卫加了只读旁路
  //    （`&& !ONLY_READONLY`，让 macOS 用户也能 `--print-plan` / `--wheel-entry`），
  //    锚点没跟着改 ⇒ 反证轮一进 M1 就抛「反证锚点未命中」，整轮**红着退出**。
  //    教训：反证锚点是**源码切片**，改那行源码时必须同步这个常量（同 A7 的双靶钉法）。
  const GUARD = "if (!PLATFORM.startsWith('win32') && !ONLY_READONLY) {";

  const rebuild = () =>
    new Promise((resolve) => {
      const b = spawn(CARGO, ['build', '--bin', 'mangasvc'], { cwd: SRC_TAURI, stdio: 'ignore' });
      b.on('close', (c) => resolve(c === 0));
      b.on('error', () => resolve(false));
    });

  // ---- M0：把另一平台的形态"统一"成当前平台的（最常见的"顺手合并"）----
  {
    const restore = mutateFile(PATHS_RS, LOSE_POSIX, 'PathBuf::from("Scripts").join("python.exe")');
    const built = await rebuild();
    const r = await runForward();
    const red = built && r.code !== 0 && hasRed(r.out, 'W1');
    check('M0 把 POSIX 形态也写成 Windows 形态 ⇒ W1 红（另一平台的引擎会起不来，且本机测不出来）', red, {
      built,
      code: r.code,
      redOn: redOn(r.out),
    });
    restore();
    await rebuild();
  }

  // ---- M1：守卫条件写反（"是 Windows 才拒绝"）----
  {
    // ⚠️ 变异要选"在**非 Windows** 下不再拒绝"的形态。把条件改成 `startsWith('linux')`
    //    是**无效**变异：`darwin-arm64` 同样不以 `linux` 开头 ⇒ 仍然照旧拒绝 ⇒ 断言照绿。
    const restore = mutateFile(DEPS_MJS, GUARD, "if (PLATFORM.startsWith('win32')) {");
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W2');
    check('M1 守卫条件写反（"是 Windows 才拒绝"）⇒ W2 红（非 Windows 上它会一路跑到 `ENOENT`）', red, {
      code: r.code,
      redOn: redOn(r.out),
    });
    restore();
  }

  // ---- M2：守卫整段删掉 ----
  {
    const restore = mutateFile(DEPS_MJS, GUARD, 'if (false) {');
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W2');
    check('M2 守卫失效（`if (false)`）⇒ W2 红 —— 报错会退化成 `ENOENT python.exe`', red, {
      code: r.code,
      redOn: redOn(r.out),
    });
    restore();
  }

  // ---- M3：macOS 引导里把"不能用"写成普通调用 ----
  {
    const restore = mutateFile(
      GUIDE_MAC,
      '# ② 依赖：⚠️ 见下，macOS 这一步不能用 npm run task -- deps:engine',
      'npm run task -- deps:engine     # ② 依赖',
    );
    const r = await runForward();
    const red = r.code !== 0 && hasRed(r.out, 'W4');
    check('M3 macOS 引导改成让用户直接跑 `deps:engine` ⇒ W4 红（平台文档串了）', red, {
      code: r.code,
      redOn: redOn(r.out),
    });
    restore();
  }

  // 收尾：确认还原到位（源码逐字节）
  {
    const bad = [];
    // 收尾只看**推导函数体** —— 单测里那几行同样含这两个字面量，用它当判据会把未还原的推导判成"已还原"
    if (!venvRelBody().includes(LOSE_POSIX)) bad.push('paths.rs 的推导未还原（残留 M0）');
    if (!fs.readFileSync(DEPS_MJS, 'utf8').includes(GUARD)) bad.push('install-engine-deps.mjs 残留 M1/M2');
    if (!fs.readFileSync(GUIDE_MAC, 'utf8').includes('macOS 这一步不能用 npm run task -- deps:engine'))
      bad.push('install-guide-macos.md 残留 M3');
    check('R1 变异收尾：三处文件按字节还原', bad.length === 0, bad);
  }
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
