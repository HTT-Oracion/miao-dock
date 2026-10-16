#!/usr/bin/env node
/**
 * D6 · 启动前预检闸门钉子 —— 「缺 python 时秒级进未装配态，而不是白等 240 s」
 * =============================================================================
 * 对应计划文档 D6：`service.rs` 在 spawn ② 之前先问运行时就绪（B2 判据），
 * 不就绪 ⇒ 直接进「运行时未装配」，不做 240 s 探针。
 *
 * ## 它钉的是什么
 * real 档引擎探针预算是 **240 s**（`mangasvc::engine::REAL_PROBE_TIMEOUT_MS`）。
 * 旧行为：② 起不来 → 降级继续 → L2 探针空等 240 s → 报一句离根因极远的「服务启动失败」。
 * 用户看到的是**卡住**，不是**没装**。闸门把这段变成秒级收场，且 `last_error` 里
 * 就是缺什么、缺在哪、怎么装。
 *
 * 🔴 **D-229（2026-10-16）改了闸门的口径：只挡引擎 ②/③，不挡服务本体 ①。**
 *    原因：闸门原来 `return self.fail(...)`（一个子进程都不起），而 D1 引导页恰恰只在
 *    "运行时未装配"时出现 —— 它唯一的行动按钮必须 POST 到 ① 的 `/engine/models/download`
 *    ⇒ 真机实测现场是「点开始下载 → 本地翻译服务未运行（请确认喵坞的服务已启动）」。
 *    现在 ① 照常起（下载/进度/续传仍以服务为唯一事实源），②/③ 跳过、状态报 `degraded`，
 *    引导页照旧由 `runtime.ready === false` 驱动。**G6 就是钉这条口径的**。
 *
 * ## 取证入口：`mangasvc --check-runtime-gate [real|mock]`
 * 打的是服务侧 `start_blocking` 调的**同一个** `gate_message()` ⇒ 这里绿即那里绿。
 * 被拦 ⇒ 退出码 1；放行 ⇒ 0。它不起服务、不绑端口，毫秒级。
 *
 * ## 为什么还要一条源码钉（G5）
 * CLI 绿只证明「闸门函数存在且判得对」，**不证明产品接了线** ——
 * 把 `service.rs` 里那行调用删掉，本脚本其余断言照样全绿，而产品回到 240 s。
 * 所以 G5 直接钉「`gate_message(` 的调用位置早于 `spawn_spec(&plan.engine`」，
 * 反证 M3 专门删那行调用 ⇒ G5 必须红。
 *
 * ## 反证轮（--refute）
 * - M1 `gate_message_for` 恒返 None（绕过闸门）⇒ G1 不再被拦。
 * - M2 删掉 mock 旁路 ⇒ G2（mock 放行）变红 —— 证明「mock 不过闸」不是碰巧。
 * - M3 把闸门改回**旧口径**（一命中就 `return self.fail`）⇒ G6 源码钉变红
 *   （G5 仍绿：调用仍在 spawn 之前 —— 两条钉钉的是不同的东西）。
 * 三个变异都改 Rust 源码、跑完**按字节还原**（含重编译产物）。
 *
 * 用法：node e2e/service/launch-gate-check.mjs [--refute]
 * 前置：`cd src-tauri && cargo build --bin mangasvc`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RUST_BIN, REPO_ROOT } from './_service-harness.mjs';
import { buildRuntime, relOf } from './_runtime-fixture.mjs';
import { ENGINE_PATCHES } from '../../engine/scripts/setup-engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REFUTE = process.argv.includes('--refute');
const PROBE_RS = path.join(REPO_ROOT, 'src-tauri', 'src', 'mangasvc', 'engine', 'runtime_probe.rs');
const SERVICE_RS = path.join(REPO_ROOT, 'src-tauri', 'src', 'service', 'mod.rs');
const SRC_TAURI = path.join(REPO_ROOT, 'src-tauri');
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

// ------------------------------------------------------------------ 打闸门

/** 跑一次 `mangasvc --check-runtime-gate <mode>`，返回 { code, json, ms }。 */
async function gate(mode, extraEnv) {
  const t0 = Date.now();
  const r = await new Promise((resolve, reject) => {
    const c = spawn(RUST_BIN, ['--check-runtime-gate', mode], {
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
    c.on('error', reject);
    c.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* 交给调用方判 */
  }
  return { code: r.code, json, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
}

/// 文案里是否带**绝对路径**（Windows 盘符 或 POSIX 的 `~/`、`/` 开头）。
const hasAbs = (s) => typeof s === 'string' && (/[A-Z]:\\/.test(s) || /(^|[\s（(])(\/|~\/)/.test(s));

// ------------------------------------------------------------------ 源码钉（G5）

/** `service.rs` 里闸门调用是否出现在 spawn 引擎之前。 */
function gateWiredBeforeEngineSpawn() {
  const src = fs.readFileSync(SERVICE_RS, 'utf8');
  const at = src.indexOf('runtime_probe::gate_message(');
  const spawn = src.indexOf('spawn_spec(&plan.engine');
  if (at < 0) return { ok: false, why: 'service.rs 里没有 gate_message 调用（闸门没接上线）' };
  if (spawn < 0) return { ok: false, why: '找不到 spawn_spec(&plan.engine（写法变了？）' };
  return { ok: at < spawn, why: `调用在 ${at}、spawn 在 ${spawn}` };
}

/**
 * 闸门**只挡引擎**（②/③），不把服务本体（①）一起挡下。
 *
 * 🔴 为什么这条必须钉住（D-229，2026-10-16 真机实测）：原先闸门是
 *    `if let Some(msg) = gate_message(..) { return self.fail(app, Some("L0"), msg); }`
 *    —— **一个子进程都不起**。于是 D1 引导页成了死结：那一页恰恰只在"运行时未装配"时
 *    出现，而它唯一的行动按钮必须 POST 到 ① 的 `/engine/models/download`
 *    ⇒ 现场表现就是「点开始下载 → 本地翻译服务未运行（请确认喵坞的服务已启动）」。
 *    现在的口径：① 照常起（下载/进度/续传仍以服务为唯一事实源），②/③ 跳过，
 *    状态报 `degraded`，引导页照旧由 `runtime.ready === false` 驱动。
 */
function gateOnlyBlocksEngines() {
  const src = fs.readFileSync(SERVICE_RS, 'utf8');
  if (!src.includes('runtime_probe::gate_message(')) {
    return { ok: false, why: 'service.rs 里没有 gate_message 调用（闸门没接上线）' };
  }
  // 旧口径的指纹：闸门一出结果就 `return self.fail(app, Some("L0"), …)`（把 ① 也挡了）
  const bailsOut = /runtime_probe::gate_message\([^)]*\)[\s\S]{0,120}?return self\.fail\(\s*app,\s*Some\("L0"\)/.test(
    src,
  );
  return {
    ok: !bailsOut,
    why: bailsOut ? '闸门一命中就 return self.fail(...) —— ① 服务会被一起挡下，引导页的下载按钮是死结' : '只挡引擎',
  };
}

if (!fs.existsSync(RUST_BIN)) {
  console.error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd src-tauri && cargo build --bin mangasvc`);
  process.exit(1);
}

// ------------------------------------------------------------------ 正向

{
  // G1：real 档 + 运行时整个不在 ⇒ 被拦、秒级、点名到每一项且带绝对路径
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-gate-empty-'));
  const r = await gate('real', { MIAO_RUNTIME_ROOT: path.join(base, 'nope') });
  check('G1 real 档 + 运行时未装配 ⇒ 被拦（退出码 1 + blocked=true）', r.code === 1 && r.json?.blocked === true, {
    code: r.code,
    body: r.json,
  });
  check(
    'G1.failing — 五项全部点名（venvRoot/python/source/deps/patches）',
    Array.isArray(r.json?.failing) && r.json.failing.length === 5,
    r.json?.failing,
  );
  check(
    'G1.msg — 文案以「运行时未装配：」开头且每项各带一次绝对路径',
    typeof r.json?.message === 'string' &&
      r.json.message.startsWith('运行时未装配：') &&
      r.json.failing.every((id) => hasAbs(r.json.message.split(id)[1] ?? '')),
    r.json?.message?.slice(0, 200),
  );
  // D6 的卖点：秒级。对照物是 240 s 探针预算，故 5 s 已是极宽松的上界。
  check('G1.fast — 秒级收场（< 5 s；对照 real 档 240 s 探针预算）', r.ms < 5000, r.ms);
  fs.rmSync(base, { recursive: true, force: true });
}

{
  // G2：mock 档 + 同样的空运行时 ⇒ **放行**（30+ 个 mock e2e 靠它活着）
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-gate-mock-'));
  const r = await gate('mock', { MIAO_RUNTIME_ROOT: path.join(base, 'nope') });
  check('G2 mock 档 + 运行时未装配 ⇒ 放行（退出码 0 + blocked=false）', r.code === 0 && r.json?.blocked === false, {
    code: r.code,
    body: r.json,
  });
  fs.rmSync(base, { recursive: true, force: true });
}

{
  // G3：real 档 + 齐全的假运行时 ⇒ 放行（闸门不得把装好的用户挡在门外）
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-gate-ready-'));
  const fx = buildRuntime(base, []);
  const r = await gate('real', fx.env);
  check(
    'G3 real 档 + 运行时就绪 ⇒ 放行（退出码 0 + ready=true）',
    r.code === 0 && r.json?.blocked === false && r.json?.ready === true,
    { code: r.code, body: r.json },
  );
  fs.rmSync(base, { recursive: true, force: true });
}

{
  // G4：real 档 + 只缺一个补丁 ⇒ 仍被拦，且文案点名到那个 patch id
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-gate-patch-'));
  const fx = buildRuntime(base, ['patches']);
  const r = await gate('real', fx.env);
  const p = ENGINE_PATCHES[0];
  check(
    'G4 real 档 + 只缺一个补丁 ⇒ 被拦且点名到 patch id 与其文件',
    r.code === 1 &&
      r.json?.blocked === true &&
      r.json.failing.length === 1 &&
      r.json.failing[0] === 'patches' &&
      r.json.message.includes(p.id) &&
      r.json.message.includes(path.join(fx.src, ...relOf(p))),
    { failing: r.json?.failing, message: r.json?.message?.slice(0, 160) },
  );
  fs.rmSync(base, { recursive: true, force: true });
}

{
  // G5：源码钉 —— 闸门调用必须接在 `service.rs` 的 spawn 之前
  const w = gateWiredBeforeEngineSpawn();
  check('G5 源码钉 — service.rs 的 gate_message 调用早于 spawn 引擎（否则 CLI 全绿而产品没接线）', w.ok, w.why);
}

{
  // G6：闸门**只挡引擎**（D-229）—— 它不得再 `return self.fail(...)`（那会把 ① 一起挡下）
  const g = gateOnlyBlocksEngines();
  check('G6 闸门只挡 ②/③、不得连 ① 服务一起挡（否则引导页的「开始下载」是死结，见 D-229）', g.ok, g.why);
}

// ------------------------------------------------------------------ 反证

/** 重编译 mangasvc。🔴 变异改了 Rust 源码，靶子是**另一个进程**，不重编等于没改。 */
function rebuild() {
  return new Promise((resolve) => {
    const b = spawn(CARGO, ['build', '--bin', 'mangasvc'], { cwd: SRC_TAURI, stdio: 'ignore' });
    b.on('error', () => resolve(false));
    b.on('close', (c) => resolve(c === 0));
  });
}

if (REFUTE) {
  if (failed > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }

  // 正向条数在变异之前定格：反证阶段还会插一条「按字节还原」断言，
  // 不定格的话汇总会把还原检查也算进正向（报 10/10 而实际正向 9 条）。
  const fwdPassed = passed;
  const fwdFailed = failed;

  const emptyEnv = () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-gate-refute-'));
    return { base, env: { MIAO_RUNTIME_ROOT: path.join(base, 'nope') } };
  };
  const probeOriginal = fs.readFileSync(PROBE_RS, 'utf8');
  const serviceOriginal = fs.readFileSync(SERVICE_RS, 'utf8');
  const mutations = [];

  // M1：闸门恒放行 ⇒ G1 不再被拦
  mutations.push({
    id: 'M1',
    what: 'gate_message_for 恒返 None（绕过闸门）',
    file: PROBE_RS,
    original: probeOriginal,
    edit: () => {
      const weak = probeOriginal.replace(
        /if mode != "real" \|\| probe\.ready \{\r?\n\s*return None;\r?\n\s*\}/,
        'if true {\n        return None;\n    }',
      );
      if (weak === probeOriginal) throw new Error('M1 锚点未命中（gate_message_for 的判据写法变了？）');
      fs.writeFileSync(PROBE_RS, weak);
    },
    probe: async () => {
      const { base, env } = emptyEnv();
      const r = await gate('real', env);
      fs.rmSync(base, { recursive: true, force: true });
      return r.json?.blocked !== true; // 期望：不再被拦
    },
  });

  // M2：删掉 mock 旁路 ⇒ G2（mock 放行）变红
  mutations.push({
    id: 'M2',
    what: '删掉 mock 旁路（mock 档也要过闸）',
    file: PROBE_RS,
    original: probeOriginal,
    edit: () => {
      const weak = probeOriginal.replace('if mode != "real" || probe.ready {', 'if probe.ready {');
      if (weak === probeOriginal) throw new Error('M2 锚点未命中');
      fs.writeFileSync(PROBE_RS, weak);
    },
    probe: async () => {
      const { base, env } = emptyEnv();
      const r = await gate('mock', env);
      fs.rmSync(base, { recursive: true, force: true });
      return r.json?.blocked === true; // 期望：mock 也被拦（即旁路失效）
    },
  });

  // M3：把闸门改回**旧口径**（连 ① 一起挡）⇒ G6 源码钉变红（G5 仍绿：调用仍在 spawn 之前）
  //    ⚠️ 这条在 2026-10-16（D-229）改过形态：原来它删的是"闸门调用"，
  //    现在那种删法会让 `engine_blocked` 悬空 ⇒ **编译不过**，变异本身就失败（验不到东西）。
  mutations.push({
    id: 'M3',
    what: '闸门改回旧口径：一命中就 return self.fail（把 ① 服务一起挡下 ⇒ 引导页死结）',
    file: SERVICE_RS,
    original: serviceOriginal,
    edit: () => {
      const call = '        let engine_blocked = mangasvc::engine::runtime_probe::gate_message(&plan.mode);';
      if (!serviceOriginal.includes(call)) throw new Error('M3 锚点未命中（service.rs 的闸门调用写法变了？）');
      const eol = serviceOriginal.includes('\r\n') ? '\r\n' : '\n';
      const oldStyle = [
        call,
        '        if let Some(msg) = &engine_blocked {',
        '            return self.fail(app, Some("L0"), msg.clone());',
        '        }',
      ].join(eol);
      fs.writeFileSync(SERVICE_RS, serviceOriginal.replace(call, oldStyle));
    },
    probe: async () => {
      const g = gateOnlyBlocksEngines();
      return !g.ok; // 期望：G6 源码钉红
    },
  });

  let allRed = true;
  for (const m of mutations) {
    try {
      m.edit();
      // 🔴 源码改了必须**重编译**：靶子是另一个进程，不重编就等于没改（A1 的教训）
      if (!(await rebuild())) throw new Error('cargo build 失败');
      const red = await m.probe();
      if (!red) allRed = false;
      console.log(`  ${red ? '✓' : '✗'} ${m.id} ${m.what} → ${red ? '按预期变红' : '**没有红**'}`);
    } catch (e) {
      allRed = false;
      console.log(`  ✗ ${m.id} ${m.what} → 变异本身失败：${String(e.message || e).slice(0, 200)}`);
    } finally {
      fs.writeFileSync(m.file, m.original);
      await rebuild();
    }
  }
  const restoredProbe = fs.readFileSync(PROBE_RS, 'utf8');
  const restoredService = fs.readFileSync(SERVICE_RS, 'utf8');
  check(
    'REFUTE.restore — runtime_probe.rs 与 service.rs 已按字节还原',
    restoredProbe === probeOriginal && restoredService === serviceOriginal,
  );
  console.log('\n[RESULT] ' + JSON.stringify({ pass: fwdPassed, fail: fwdFailed, allRed }));
  console.log(
    `\nD6 启动前预检闸门：正向 ${fwdPassed} / ${fwdPassed + fwdFailed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`,
  );
  process.exit(allRed && failed === 0 ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(
  `\nD6 启动前预检闸门：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`,
);
process.exit(failed === 0 ? 0 : 1);
