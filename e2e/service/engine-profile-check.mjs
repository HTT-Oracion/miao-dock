#!/usr/bin/env node
/**
 * S4-a/b 硬件探测 / 档位映射 / 加速后端 / ③ 看守 —— **换靶后的断言门**。
 *
 * ## 这一版为什么是「跑 Rust 单测」而不是「import Node 模块」
 * 产品早已是 Rust（`boxsvc`），而这些判据原本靠 `import service/src/settings/*.mjs` 进程内取证。
 * `service/` 一经删除，那种写法连正向都跑不起来。于是判据**沉到实现层**：
 *   · H（档位映射 §7.2）· A（加速后端 §7.3/§7.4）· T（设置页档位 §5）· R（真机自检）
 *     → `boxsvc/engine/profile.rs` 的 `#[cfg(test)] mod tests`
 *   · D（降档 §8）→ `tier_downgrade.rs` · I（空闲卸载 §9）→ `idle_policy.rs`
 * 本门只做三件事：**跑全部具名用例并逐条断言**（条数写死）、**验 L 组归位指针**、**反证**。
 *
 * ## L 组（③ 看守）去哪了
 * 原来 L0–L6 在这里起真进程。换靶后：
 *   · L1/L2/L4/L5/L6 → **归位** `check:llm-supervisor`（`--llm-selftest` 的 `restart` 用例，
 *     见 `e2e/service/_llm-report.mjs` 的 `CASES`）；本门用 P3/P4 两条指针钉住"它真的在那儿"，
 *     否则"搬家"会静默变成"丢掉"。
 *   · L3（父死传播）→ 已由 `check:child-watch` 的**双靶**反证覆盖（那条门专门验 E11）。
 *   · L0（看守器路径）→ Node 版防的是"仓库根少算一级"；Rust 的看守器宿主是 `boxsvc` 自身，
 *     改为 `supervisor.rs` 的 `l0_watch_host_is_self_when_not_overridden` 单测。
 *
 * ## 反证轮（--refute）
 * 每条破坏只针对一个机制，跑「该判据现在的家」看它变红；改过源码的按字节还原（12+2 条）：
 *   · `cargo`   —— 改 Rust 源码 → `cargo test --lib` → 断言**具名用例**变红（12 条）
 *   · `parity`  —— 改 Rust 源码 → 重编译 `boxsvc` → 跑 `check:llm-supervisor` → 断言指定
 *                  `LLM.*.behavior` 变红（M6 一条）
 *   · `parity`+env —— **不动源码**，走产品自带的反证钩子（M5 用 `MIAO_LLM_NO_KILL`：源码里跳过
 *                  `terminate` 会被随后的 `child.kill()` 兜住，子进程照样死 ⇒ 源码变异测不出来）
 * 两道保险：**起点**先验 `check:llm-supervisor` 基线全绿（基线不绿则 parity 反证是空跑）；**收尾**
 * 按字节还原源码后**再重编 `boxsvc`** —— `parity` 条目编出的二进制仍是变异版，不重编会污染下一次验收。
 *
 * 用法：node e2e/service/engine-profile-check.mjs [--refute]
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC_TAURI = path.join(ROOT, 'app', 'src-tauri');
const CARGO = process.env.CARGO || 'cargo';
const REFUTE = process.argv.includes('--refute');

const PROFILE_RS = path.join(SRC_TAURI, 'src', 'boxsvc', 'engine', 'profile.rs');
const DOWNGRADE_RS = path.join(SRC_TAURI, 'src', 'boxsvc', 'engine', 'tier_downgrade.rs');
const IDLE_RS = path.join(SRC_TAURI, 'src', 'boxsvc', 'engine', 'idle_policy.rs');
const SUPERVISOR_RS = path.join(SRC_TAURI, 'src', 'boxsvc', 'engine', 'supervisor.rs');
const MODEL_RS = path.join(SRC_TAURI, 'src', 'boxsvc', 'store', 'model.rs');

const LLM_REPORT = path.join(ROOT, 'e2e', 'service', '_llm-report.mjs');
const LLM_PARITY = path.join(ROOT, 'e2e', 'service', 'llm-supervisor-parity-check.mjs');
const LLM_GOLDEN = path.join(ROOT, 'e2e', 'service', 'golden', 'llm-selftest.json');

// ------------------------------------------------------------------ 具名用例表（**条数写死**）

const T = 'boxsvc::engine::profile::tests::';
const G = 'boxsvc::engine::tier_downgrade::tests::';
const I = 'boxsvc::engine::idle_policy::tests::';
const S = 'boxsvc::engine::supervisor::tests::';

/** 本门负责的具名用例。少一条 ⇒ 计数断言红（"分子绿、分母缩小"的防法）。 */
const NAMED = [
  // H 档位映射（§7.2 逐行）
  `${T}h1_mac16_falls_to_tiny`,
  `${T}h2_metal_thresholds_are_exact_at_every_boundary`,
  `${T}h3_cuda_thresholds_are_exact_at_every_boundary`,
  `${T}h4_cpu_is_tiny_regardless_of_ram`,
  `${T}h5_unknown_or_missing_gpu_kind_is_tiny_and_never_panics`,
  `${T}h6_profile_view_injection_yields_medium_on_32gb_mac`,
  `${T}h7_profile_view_non_darwin_branch_uses_nvidia_vram`,
  `${T}h8_bytes_are_converted_to_gb_and_metal24_is_small`,
  // A 加速后端（§7.3/§7.4）
  `${T}a1_accel_mapping_covers_metal_cuda_cpu_and_unknown`,
  `${T}a2_accel_launch_flags`,
  `${T}a3_detect_gpu_order_is_metal_then_nvidia_then_cpu`,
  // T 设置页档位（§5）
  `${T}t1_feasible_tiers_on_mac16_exclude_medium`,
  `${T}t2_tier_options_mark_small_as_not_recommended`,
  `${T}t3_tier_peak_gb_matches_the_spec_table`,
  `${T}t4_feasible_tiers_are_decided_per_backend`,
  `${T}t5_tiers_enum_is_display_order_low_to_high`,
  // R 真机自检（非契约）
  `${T}r1_real_probe_is_platform_faithful`,
  // D 档位降档（§8）
  `${G}d1_next_lower_tier_walks_down_and_stops_at_the_bottom`,
  `${G}d2_d3_all_four_oom_classes_hit_and_normal_failures_do_not`,
  `${G}d4_oom_signature_penetrates_detail_and_flatten_keeps_json`,
  `${G}d7_apply_runs_once_history_has_one_entry_and_log_names_both`,
  `${G}d8_apply_failure_does_not_roll_back_the_latch`,
  `${G}oom_signatures_hit_and_normal_failures_do_not`,
  `${G}detail_is_flattened`,
  `${G}downgrade_walks_down_only_once`,
  `${G}lowest_tier_and_disabled_never_downgrade`,
  // I 空闲卸载（§9）
  `${I}i0_reason_tokens_are_machine_readable_and_all_distinct`,
  `${I}i5_queue_facts_uses_current_task_id_not_an_object_as_counter`,
  `${I}i6_last_activity_takes_the_larger_of_created_and_finished`,
  `${I}i7_manual_step_unloads_only_after_the_threshold`,
  `${I}i8_queued_task_vetoes_on_the_real_wiring`,
  `${I}i10_task_timestamp_keeps_millisecond_precision`,
  `${I}queue_busy_is_veto_regardless_of_idle`,
  `${I}zero_threshold_means_never`,
  `${I}never_ran_and_not_idle_enough`,
  `${I}runtime_scope_filters_previous_runs`,
  // L0（看守器宿主 = 自身）
  `${S}l0_watch_host_is_self_when_not_overridden`,
];
const EXPECTED_NAMED = 37; // 分母写死：改这张表必须同时改这里

// ------------------------------------------------------------------ 结果收集

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}
const out = { pass: 0, fail: 0 };
function emit() {
  out.pass = results.filter((r) => r.ok).length;
  out.fail = results.length - out.pass;
}
function printResults(title) {
  emit();
  console.log(`\n### ${title}`);
  for (const r of results) console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.id}${r.detail ? `  ${r.detail}` : ''}`);
  console.log(`[RESULT] ${JSON.stringify({ results, pass: out.pass, fail: out.fail })}`);
  console.log(`\n通过 ${out.pass} / 失败 ${out.fail}`);
}
// ------------------------------------------------------------------ Rust 侧取证

function runCargoTest() {
  const r = spawnSync(CARGO, ['test', '--lib'], { cwd: SRC_TAURI, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const tests = new Map();
  for (const raw of text.split('\n')) {
    const m = /^test ([\w:]+) \.\.\. (ok|FAILED|ignored)/.exec(raw.trim());
    if (m) tests.set(m[1], m[2]);
  }
  const summary = /test result: \w+\. (\d+) passed; (\d+) failed/.exec(text);
  return {
    tests,
    text,
    passed: summary ? Number(summary[1]) : null,
    failed: summary ? Number(summary[2]) : null,
    code: r.status,
  };
}

// ------------------------------------------------------------------ 正向

function runPositive() {
  const t = runCargoTest();
  check(
    'P1 `cargo test --lib` 全绿（0 失败）—— 具名用例的家已经搬到实现层，本门不再 import Node 模块',
    t.failed === 0 && t.passed !== null,
    `passed=${t.passed} failed=${t.failed}`,
  );

  check(
    `P2 具名用例条数 == ${EXPECTED_NAMED}（写死；少一条就是"分子绿、分母缩小"）`,
    NAMED.length === EXPECTED_NAMED,
    `实际 ${NAMED.length}`,
  );

  // 逐条断言：缺一条、或它变红，都能一眼看出是哪条
  for (const name of NAMED) {
    const short = name.split('::tests::')[1];
    const state = t.tests.get(name);
    check(`${short}`, state === 'ok', state === undefined ? '未被执行（改名/被删？）' : state);
  }

  // ---- L 组归位指针：它必须**真的**在 check:llm-supervisor 里，而不是"搬家时丢掉"
  const reportSrc = fs.readFileSync(LLM_REPORT, 'utf8');
  check(
    'P3 L 组归位指针（一）：`_llm-report.mjs` 的 `CASES` 含 `restart` 用例',
    /name:\s*'restart'\s*,\s*scenario:\s*'restart'/.test(reportSrc),
    '见 e2e/service/_llm-report.mjs 的 CASES',
  );

  let goldenRestart = null;
  try {
    const j = JSON.parse(fs.readFileSync(LLM_GOLDEN, 'utf8'));
    goldenRestart = (j.results || []).find((r) => r.name === 'restart') || null;
  } catch (e) {
    goldenRestart = { __error: String(e.message) };
  }
  check(
    'P4 L 组归位指针（二）：llm-supervisor golden 含 `restart` 且 `pidChanged=true` / `restarts=1` —— ' +
      '「懒加载恢复真拉起」这件事没在搬家时丢掉',
    !!goldenRestart && goldenRestart.pidChanged === true && goldenRestart.restarts === 1,
    JSON.stringify(goldenRestart),
  );

  check(
    `P5 归位说明：L3（父死传播）由 \`check:child-watch\` 的双靶反证覆盖、L0 由 \`${S.split('::tests::')[0]}::tests::l0_watch_host_is_self_when_not_overridden\` 覆盖`,
    fs.existsSync(path.join(ROOT, 'e2e', 'child-watch-check.mjs')),
    'e2e/child-watch-check.mjs',
  );
}

// ================================================================ 反证轮

/**
 * 每条破坏**只针对一个机制**。
 *
 * `runner`:
 *   · `cargo`  —— 改 Rust 源码 → `cargo test --lib` → 断言 `expect` 里的**具名用例**变红
 *   · `parity` —— 改 Rust 源码 → 重编译 boxsvc → 跑 check:llm-supervisor → 断言 `expect` 里的
 *                 `LLM.*.behavior` 变红；带 `env` 的条目**不改源码**，只用环境钩子
 *
 * ⚠️ 有 `file` 的条目，锚点一律是**源码切片**：改那行源码必须同步这里的 `find`（本项目已踩过
 *    `macos-compat` 的 `GUARD` 过期锚点 —— 锚点过期时反证轮会抛"锚点未命中"而非静默通过）。
 * ⚠️ 锚点里的多行切片按 LF 书写，运行时按目标文件**实际行尾**适配（Rust 源码是 CRLF，
 *    照 LF 比对会静默失配 ⇒ 反证轮变成"跳过"）。
 * ⚠️ 父死看守（E11）**刻意不在本门**：它的靶子 `engine/src/parent-watch.mjs` 与 E11 的判据都在
 *    `check:child-watch`（双靶），搬过来只会两处维护同一件事。这是**归位**，不是丢断言。
 */
const MUTATIONS = [
  {
    name: 'M1 Metal 阈值"顺手优化"：24→16（16GB Mac 于是"够得着" Small）',
    runner: 'cargo',
    file: PROFILE_RS,
    find: 'if unified >= 24.0 {',
    replace: 'if unified >= 16.0 {',
    expect: [`${T}h1_mac16_falls_to_tiny`, `${T}h2_metal_thresholds_are_exact_at_every_boundary`],
  },
  {
    name: 'M2 加速后端把 metal 报成 cpu（GPU 没坏却说没 GPU ⇒ 白白退回 CPU）',
    runner: 'cargo',
    file: PROFILE_RS,
    find: '        return "mps".to_string();',
    replace: '        return "cpu".to_string();',
    expect: [`${T}a1_accel_mapping_covers_metal_cuda_cpu_and_unknown`],
  },
  {
    name: 'M3 取消「物理不可行档位不出现」的过滤（三档全渲染 ⇒ 16GB Mac 上 Medium 会点击必崩）',
    runner: 'cargo',
    file: PROFILE_RS,
    find: '            if **tier == "tiny" {\n                return true;\n            }',
    replace: '            if true {\n                return true;\n            }',
    expect: [`${T}t1_feasible_tiers_on_mac16_exclude_medium`, `${T}t2_tier_options_mark_small_as_not_recommended`],
  },
  {
    name: 'M4 CPU 后端仍开 GPU（引擎加 --use-gpu、LLM 层数不归零 ⇒ 无 GPU 机器必启动失败）',
    runner: 'cargo',
    file: PROFILE_RS,
    find: '    (!on_cpu, if on_cpu { 0 } else { -1 })',
    replace: '    let _ = on_cpu;\n    (true, -1)',
    expect: [`${T}a2_accel_launch_flags`],
  },
  {
    // 这条**没有源码锚点**，走产品自带的反证钩子：源码里跳过 `terminate` 会被随之而来的
    // `child.kill()` 兜住（子进程照样死、端口照样释放 ⇒ `LLM.ready.behavior` 不变红），
    // 即「源码变异被兜底掩盖」。真正的"既不等也不杀"只有 `MIAO_LLM_NO_KILL` 这条路径。
    name: 'M5 `stop()` 只改状态、不真停进程（"我以为它退了"与"它退了"的差别）',
    runner: 'parity',
    env: { MIAO_LLM_NO_KILL: '1' },
    expect: ['LLM.ready.behavior'],
  },
  {
    name: 'M6 `restart()` 只报数、不真拉起（懒加载恢复于是变成"什么都没发生"）',
    runner: 'parity',
    file: SUPERVISOR_RS,
    find: '        inner.restarts += 1;\n        op_start(&self.logs, &self.diag, &mut inner, timeout_ms);',
    replace: '        inner.restarts += 1;\n        let _ = timeout_ms;',
    expect: ['LLM.restart.behavior'],
  },
  {
    name: 'M7 看守器宿主改成不存在的路径（"服务起得来但 ③ 拉不起来"的错位）',
    runner: 'cargo',
    file: SUPERVISOR_RS,
    find: '    std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("boxsvc"))',
    replace: '    std::path::PathBuf::from("C:\\\\no-such-dir\\\\boxsvc.exe") // refute',
    expect: [`${S}l0_watch_host_is_self_when_not_overridden`],
  },
  {
    name: 'M8 OOM 签名放宽成"什么错都算"（任何一次失败都降档 ⇒ 用户质量莫名下降）',
    runner: 'cargo',
    file: DOWNGRADE_RS,
    find: '.any(|p| regex::Regex::new(p).map(|re| re.is_match(text)).unwrap_or(false))',
    replace: '.any(|p| regex::Regex::new(p).map(|_re| true).unwrap_or(false))',
    expect: [`${G}d2_d3_all_four_oom_classes_hit_and_normal_failures_do_not`],
  },
  {
    name: 'M9 去掉「仅降一次」的闩（每次 OOM 都降 ⇒ 一路降到最低档，且与 item 级重试叠加）',
    runner: 'cargo',
    file: DOWNGRADE_RS,
    find: '        if inner.used {\n            return Plan { downgrade: false, reason: "already-downgraded".into(), from: None, to: None };\n        }',
    replace:
      '        if false {\n            return Plan { downgrade: false, reason: "already-downgraded".into(), from: None, to: None };\n        }',
    expect: [`${G}downgrade_walks_down_only_once`, `${G}d8_apply_failure_does_not_roll_back_the_latch`],
  },
  {
    name: 'M10 删掉「有任务排队时不卸载」这条前置条件（§9.2 安全铁律被破：任务等着，引擎被停）',
    runner: 'cargo',
    file: IDLE_RS,
    find: '    if queued > 0 {\n        return Decision { unload: false, reason: REASON_BUSY_QUEUED.into(), idle_for_ms };\n    }',
    replace:
      '    if false {\n        return Decision { unload: false, reason: REASON_BUSY_QUEUED.into(), idle_for_ms };\n    }',
    expect: [`${I}queue_busy_is_veto_regardless_of_idle`, `${I}i8_queued_task_vetoes_on_the_real_wiring`],
  },
  {
    name: 'M11 空闲阈值方向写反（`< idleMs` 改成 `> idleMs` ⇒ 越热闹越卸）',
    runner: 'cargo',
    file: IDLE_RS,
    find: '    if idle_for < idle_ms {',
    replace: '    if idle_for > idle_ms {',
    expect: [`${I}never_ran_and_not_idle_enough`, `${I}i7_manual_step_unloads_only_after_the_threshold`],
  },
  {
    name: 'M12 空闲判定拿"对象当计数器"（`{} > 0` 恒 false ⇒ **恒判空闲**，有任务在跑也照卸）',
    runner: 'cargo',
    file: IDLE_RS,
    find: '    let running = if store.current_task_id.is_some() { 1 } else { 0 };',
    replace: '    let running = 0; // refute：不看 current_task_id',
    expect: [`${I}i5_queue_facts_uses_current_task_id_not_an_object_as_counter`],
  },
  {
    name: 'M13 去掉「阈值 0 = 从不卸载」这一句（于是"0 分钟"变成"立刻卸载"—— 用户拿到他要的反面）',
    runner: 'cargo',
    file: IDLE_RS,
    find: '    if never_unload || idle_ms <= 0 {',
    replace: '    if never_unload {',
    expect: [`${I}zero_threshold_means_never`],
  },
  {
    name:
      'M14 任务时间戳退回**秒精度**（`now_iso_ms` → `now_iso`）⇒ 「与 Store 构造同一秒内创建的任务」' +
      '必须变红（精度错配 = 空闲卸载整轮失效）',
    runner: 'cargo',
    file: MODEL_RS,
    find: '            created_at: now_iso_ms(),',
    replace: '            created_at: now_iso(),',
    expect: [`${I}i10_task_timestamp_keeps_millisecond_precision`],
  },
];

const EXPECTED_MUTATIONS = 14; // 分母写死

function sha(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/**
 * 锚点 / 替换串按**目标文件的实际行尾**适配。
 * Rust 源码是 CRLF：多行锚点若照 LF 写，`includes` 会静默失配 —— 反证轮于是"跳过"而不是变红。
 */
function adaptEol(body, text) {
  return text.includes('\r\n') ? body.replace(/\n/g, '\r\n') : body;
}

/**
 * 跑 check:llm-supervisor（正向轮），返回变红的 `LLM.*.behavior` id 列表。
 * `rebuild=false` 用于**没有源码变异**的那条（环境钩子反证）：不必重编译，用现成靶子。
 */
function runParity({ env = {}, rebuild = true } = {}) {
  if (rebuild) {
    const build = spawnSync(CARGO, ['build', '--bin', 'boxsvc'], {
      cwd: SRC_TAURI,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (build.status !== 0)
      return { built: false, reds: [], tail: `${build.stdout || ''}${build.stderr || ''}`.slice(-400) };
  }
  const r = spawnSync(process.execPath, [LLM_PARITY], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const reds = [];
  for (const raw of text.split('\n')) {
    const m = /^\s*✗\s+(LLM\.[\w.-]+)\s/.exec(raw);
    if (m) reds.push(m[1]);
  }
  return { built: true, reds, tail: text.slice(-300) };
}

function runRefute() {
  console.log('S4-a/b 硬件探测 / 档位映射 / 加速后端 / ③ 看守 · 反证轮（换靶后：改 Rust 源码）');
  console.log(`破坏 Rust 源文件 → 该判据现在的家必须变红 → 按字节恢复（应执行 ${EXPECTED_MUTATIONS} 条）\n`);

  const restored = [];
  const problems = [];
  const restoreAll = () => {
    for (const r of restored) {
      if (!r.done) {
        fs.writeFileSync(r.file, r.bytes);
        r.done = true;
      }
    }
  };
  /** 编译靶子（`boxsvc`）；失败返回尾部日志。 */
  const buildTarget = () => {
    const rb = spawnSync(CARGO, ['build', '--bin', 'boxsvc'], {
      cwd: SRC_TAURI,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return rb.status === 0 ? null : `${rb.stdout || ''}${rb.stderr || ''}`.slice(-200);
  };
  // 🔴 源码还原 ≠ 靶子还原：`parity` 条目编译过 `boxsvc`，还原源码后那个**二进制仍是变异版**。
  //    不收尾重编，就等于把"变异过的靶子"留给下一次验收 —— 比红更坏（后续门莫名红，甚至假绿）。
  const restoreAllAndRebuild = () => {
    restoreAll();
    const err = buildTarget();
    if (err) {
      problems.push(`还原源码后重编 boxsvc 失败（靶子可能仍是变异版）：${err}`);
      process.exitCode = 1;
    }
  };
  const onSignal = () => {
    restoreAllAndRebuild();
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // 🔴 起点必须全绿：反证的前提是「没变异时不红」。基线不绿 ⇒ `parity` 类条目会**假反证**
  //    （变异前后都红，看着"按预期变红"其实什么都没证明）。
  const baseErr = buildTarget();
  if (baseErr) {
    problems.push(`反证轮起点：boxsvc 编译失败（${baseErr}）`);
  } else {
    const base = runParity({ rebuild: false });
    if (!base.built || base.reds.length > 0) {
      problems.push(
        `反证轮起点：check:llm-supervisor 基线不全绿（${base.reds.join('、') || '未产出'}）⇒ parity 类条目是假反证`,
      );
    } else {
      console.log('起点：check:llm-supervisor 基线全绿（parity 类反证不是空跑）\n');
    }
  }

  let executed = 0;
  let asExpected = 0;
  try {
    for (const mut of MUTATIONS) {
      // 有源码锚点 ⇒ 改源码再测；没有（`env` 类）⇒ 直接跑现成靶子。
      let record = null;
      let before = null;
      if (mut.file) {
        const original = fs.readFileSync(mut.file);
        record = { file: mut.file, bytes: original, done: false };
        restored.push(record);
        before = sha(mut.file);
        const txt = original.toString('utf8');
        const find = adaptEol(mut.find, txt);
        const repl = adaptEol(mut.replace, txt);
        if (!txt.includes(find)) {
          problems.push(`${mut.name}：锚点未找到（源码变了？必须同步 find 切片）`);
          continue;
        }
        fs.writeFileSync(mut.file, txt.replace(find, repl));
      }

      let reds = [];
      let note = '';
      if (mut.runner === 'cargo') {
        const t = runCargoTest();
        if (!t || t.tests.size === 0) {
          note = `子进程未产出用例行（编译失败？）：${String(t?.text || '').slice(-200)}`;
        }
        for (const name of mut.expect) if (t?.tests.get(name) === 'FAILED') reds.push(name);
      } else {
        const p = runParity({ env: mut.env || {}, rebuild: !!mut.file });
        if (!p.built) note = `重编译失败：${p.tail}`;
        reds = mut.expect.filter((id) => p.reds.includes(id));
      }

      if (record) {
        fs.writeFileSync(record.file, record.bytes);
        record.done = true;
        const after = sha(record.file);
        if (before !== after) problems.push(`${mut.name}：恢复后字节不一致（${before} ≠ ${after}）`);
      }

      executed += 1;
      const missed = mut.expect.filter((code) => !reds.includes(code));
      console.log(`🔴 ${mut.name}`);
      for (const code of mut.expect) {
        const short = code.split('::tests::').pop();
        console.log(
          `   ${reds.includes(code) ? '✓' : '✗'} ${short} ${reds.includes(code) ? '按预期变红' : '**没有变红**'}`,
        );
      }
      if (note) console.log(`   ⚠ ${note}`);
      if (missed.length === 0) asExpected += 1;
      else problems.push(`${mut.name}：${missed.map((c) => c.split('::tests::').pop()).join(',')} 未变红`);
    }
  } finally {
    restoreAllAndRebuild();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`反证：${asExpected} / ${EXPECTED_MUTATIONS} 条按预期变红（应执行 ${EXPECTED_MUTATIONS}）`);
  if (executed !== EXPECTED_MUTATIONS || asExpected !== EXPECTED_MUTATIONS || problems.length) {
    console.log('\n下面是未达预期的条目：');
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exitCode = 1;
  }
}

// ================================================================ 入口

if (REFUTE) {
  runRefute();
} else {
  console.log('S4-a/b 硬件探测 / 档位映射 / 加速后端 / ③ 看守 断言（Rust 实现层）');
  try {
    runPositive();
  } catch (err) {
    check(
      'RUN 断言脚本未预期崩溃（视为失败：脚本崩溃 ≠ 断言通过）',
      false,
      `抛错 ${err?.code || err?.name}: ${err?.message}`,
    );
  }
  printResults('汇总（H 硬件/映射 · A 加速后端 · T 设置页档位 · D 降档 · I 空闲卸载 · L0 看守器宿主 · R 真机自检）');
  process.exitCode = out.fail === 0 ? 0 : 1;
}
