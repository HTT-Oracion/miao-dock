#!/usr/bin/env node
/**
 * 父死看守（E11）的**双靶双向取证** —— Node 版 `engine/scripts/child-watch.mjs`
 * 与 Rust 版 `boxsvc --child-watch`（A3c 移植）跑**同一份**用例。
 *
 * ## 为什么值得单列一条行为钉子
 * 真模式下 ② python / ③ llama-server 是**外部二进制**，改不了它们，
 * E11（主进程被 SIGKILL 后不留孤儿）**完全押在这个看手上**。而真模式 E11 要跑分钟级、
 * 几 GB 权重、还依赖本机 runtimes 就绪 —— 不适合当每轮回归的判据。
 * 这里用一个可心跳的假目标进程，把「父死 ⇒ 子树被带走」在**秒级**钉死。
 *
 * ## 判据不是"进程还在不在"
 * `pgrep -f` 会把看守器自己也匹配进去，分不清是哪个没死；而 Windows 上 `ps`/`pkill`
 * **根本不存在**（原版钉子因此在 Windows 上只能"凑合跑"）。这里改为
 * **目标进程自己写心跳文件** —— 只由被看守的那个写，指向唯一，且**跨平台**。
 *
 * ## 🔴 A3c 移植中实测到的三条真实缺陷（本脚本就是它们的回归护栏）
 * ① **管道 EOF ≠ 父死**：管道 EOF 只说明"没有写端了"，而"父进程没攥住写端"（接线错误）
 *    产生的字节流**一模一样**。照直觉"读到 EOF 就自杀" ⇒ 引擎/LLM 一起来就没了，
 *    而报错停在几层之外。故 Rust 版必须让 **ppid 通道复核**（用例 W2 钉这条）。
 * ② **`parent_pid()` 取不到 ≠ 父死**：ToolHelp32 快照在权限不足/进程数逼近上限时会失败，
 *    把它当"父死"会**杀掉一个好好活着的引擎**（失效方向最坏）。故取不到时按"未知"处理。
 * ③ **`parent_alive()` 必须判 `STILL_ACTIVE`**：父进程刚退出时句柄仍打得开，
 *    只判"句柄可开"会把已死的父当成活着 ⇒ 看守器**永远不自杀**（失效方向是留孤儿）。
 *
 * ## 用法
 *   node e2e/child-watch-check.mjs                正向：父死 ⇒ 心跳停（双靶）
 *   node e2e/child-watch-check.mjs --refute       反证：关看守（MIAO_NO_PARENT_WATCH=1）⇒ 心跳继续
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const REFUTE = process.argv.includes('--refute');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUST_BIN = path.join(
  ROOT,
  'app',
  'src-tauri',
  'target',
  'debug',
  'boxsvc' + (process.platform === 'win32' ? '.exe' : ''),
);

/**
 * 两个靶子：**Node 原版** vs **Rust 移植**（A3c），跑同一份用例。
 *
 * 🔴🔴 **两个靶子的"父进程"刻意用不同实现，这不是不一致，而是必需**（本轮实测踩出来的）：
 *
 *   · Node 靶：父是 node（`spawn` + 攥 `c.stdin`）—— Node 原版只看 ppid，够用。
 *   · Rust 靶：父是 **`boxsvc --child-watch-parent`**（Rust，按 `service.rs::spawn_inner`
 *     的完全相同接线起看守器）—— 见 `child_watch::run_as_parent` 的注释。
 *
 * 为什么 Rust 靶不能用 node 当父：node 在 Windows 上给子进程的 stdio **不是裸匿名管道**，
 * `process.exit()` 后那个写端**不会**让子进程读到 EOF ⇒ Rust 版的主通道失效；
 * 而 Windows 上父退出后 `th32ParentProcessID` **冻结**、未回收 pid 的 `OpenProcess` 仍报
 * `STILL_ACTIVE` ⇒ 两条通道都判不出父死。
 * 🔴 用 node 当父去测 Rust 版，测的是**一个产品里不存在的场景**，会得出
 *    「E11 失效」这个错误结论（本轮真的差点据此改坏产品）。产品的父是 Rust，必须照实测。
 */
const TARGETS = [
  {
    id: 'node',
    label: 'child-watch.mjs（Node 原版，node 父）',
    argv: [process.execPath, [path.join(ROOT, 'engine', 'scripts', 'child-watch.mjs')]],
    parentStdin: null,
  },
  {
    id: 'rust',
    label: 'boxsvc --child-watch（A3c Rust 移植，Rust 父 = 产品同源）',
    argv: [RUST_BIN, ['--child-watch']],
    parentStdin: 'pipe',
  },
];

// 🔴 argv **不能**内联进 `-e` 源码：JSON.stringify 一个含 `.exe` 的数组会被 node
//    当成 ESM 入口去 import（`ERR_UNKNOWN_FILE_EXTENSION`）—— 本轮真踩过。
//    用环境变量传 JSON 是唯一稳的跨平台做法（env 不能带 null 字节，分隔符方案会炸）。
const ENV_ARGS = '__CW_ARGS';
const ENV_TARGET = '__CW_TARGET';

/** 被看守的目标：每 150ms 写一次心跳，并把自己的 pid 落盘（供收尾用）。 */
function targetSource(beat) {
  return [
    "const fs = require('fs');",
    `const p = ${JSON.stringify(beat)};`,
    'fs.writeFileSync(p + ".pid", String(process.pid));',
    'setInterval(() => fs.writeFileSync(p, String(Date.now())), 150);',
  ].join('\n');
}

const readBeat = (beat) => {
  try {
    return fs.readFileSync(beat, 'utf8');
  } catch {
    return '';
  }
};

/** 连续两次采样**不同** ⇒ 心跳还在跳 ⇒ 目标还活着。 */
async function beating(beat, windowMs = 1200) {
  const a = readBeat(beat);
  await sleep(windowMs);
  const b = readBeat(beat);
  return { alive: Boolean(a) && Boolean(b) && a !== b, a, b };
}

/** 目标 pid 是否还活着（跨平台，不依赖 ps/pgrep）。 */
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanup(beat) {
  try {
    const pid = Number(fs.readFileSync(`${beat}.pid`, 'utf8'));
    if (Number.isFinite(pid) && pid > 1) process.kill(pid, 'SIGKILL');
  } catch {
    /* 目标没起来 */
  }
  for (const f of [beat, `${beat}.pid`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}

/// 父进程存活时长：必须**明显长于**一次心跳采样窗口，否则"目标曾经在跳"这一步会与
/// "父已死、目标被杀"重叠 ⇒ 误报成「目标根本没在跳」（原版钉子的注释，此处沿用）。
const PARENT_ALIVE_MS = 4000;

/**
 * 造一个"会死的父进程"：它起看守器，看守器再起心跳目标，活一会儿后退出。
 * 这就是 E11 的场景缩影 —— 父进程没了，剩下的进程只能自救。
 *
 * 返回 `{ exit }`，在父进程真正退出后 resolve。调用方要**先**在父还活着时采样心跳
 * （证明目标确实在跑），再 `await exit`，然后再采样。
 */
function spawnDyingParent(target, beat) {
  const innerArgs = [...target.argv[1], '--', process.execPath, '-e', targetSource(beat)];
  const env = { ...process.env };
  if (REFUTE) env.MIAO_NO_PARENT_WATCH = '1';

  // ── Rust 靶：直接用产品同源的 Rust 父夹具 ──
  if (target.parentStdin === 'pipe') {
    const p = spawn(
      RUST_BIN,
      ['--child-watch-parent', String(PARENT_ALIVE_MS), ...innerArgs],
      { stdio: 'ignore', env },
    );
    return { exit: new Promise((r) => p.once('exit', () => r(p))) };
  }

  // ── Node 靶：node 自己扮演会死的父 ──
  // ⚠️ `MIAO_NO_PARENT_WATCH=1` 只能**传进看守器**：node 的 `spawn` 会把自己加进
  //    一个隐式 job，父进程一 `process.exit()`，Windows 就可能连带清掉目标 ——
  //    那样即使看守器被关掉目标也会死，**反证轮就会假失败**
  //    （"说明它不是被看守带走的"）。所以 Node 靶只作为**正向**参照，
  //    反证的权威判据由与产品同源的 Rust 靶给出。
  // 三点都不能省：
  //  ① `unref()` —— 否则这个"父进程"会**等着子进程退出**才退，"父进程已死"这个前提就不成立。
  //  ② 活够 PARENT_ALIVE_MS —— 让看守完成启动并记下 `bootPpid`（走"ppid 变化"这条主路径，
  //     而不是"出生即孤儿"那条兜底分支）。
  const src = [
    `const c = require('child_process').spawn(${JSON.stringify(target.argv[0])}, ${JSON.stringify(innerArgs)},`,
    `  { stdio: ['ignore', 'ignore', 'ignore'], env: process.env });`,
    'c.unref();',
    `setTimeout(() => process.exit(0), ${PARENT_ALIVE_MS});`,
  ].join('\n');
  // 🔴 反证轮**不给** Node 靶设 MIAO_NO_PARENT_WATCH（理由见上）。
  const nodeEnv = REFUTE ? { ...process.env } : env;
  const p = spawn(process.execPath, ['-e', src], { stdio: 'ignore', env: nodeEnv });
  return { exit: new Promise((r) => p.once('exit', () => r(p))) };
}

/** 跑一个靶子的完整用例，返回 `{ id, label, beforeAlive, afterAlive, pidAliveAfter, ok, why }`。 */
async function runTarget(target) {
  const beat = path.join(os.tmpdir(), `miao-cw-${target.id}-${process.pid}-${Date.now()}.txt`);
  try {
    const parent = spawnDyingParent(target, beat);
    await sleep(1100); // 让看守器与目标起来

    // ① 先在**父进程还活着**时采样：证明目标确实在跳（否则后面的"停了"什么都证明不了）
    const before = await beating(beat);
    if (!before.alive) {
      return {
        id: target.id,
        label: target.label,
        beforeAlive: false,
        afterAlive: false,
        ok: false,
        why: '前置失败：目标进程根本没在跳（看守器或目标没起来），本轮结论无效',
      };
    }

    // ② 父进程退出，再看目标
    await parent.exit;
    // 看守器走的是"先礼后兵"，窗口 1500ms + 巡检 1000ms ⇒ 给足余量。
    await sleep(2200);
    const after = await beating(beat, 1500);
    let targetPid = 0;
    try {
      targetPid = Number(fs.readFileSync(`${beat}.pid`, 'utf8'));
    } catch {
      /* ignore */
    }

    if (REFUTE) {
      // 关掉看守：没人负责带走目标 ⇒ 心跳必须**继续跳**（孤儿）。
      // 若它停了，说明带走它的另有其人 ⇒ 本轮反证不成立。
      return {
        id: target.id,
        label: target.label,
        beforeAlive: true,
        afterAlive: after.alive,
        ok: after.alive,
        why: after.alive
          ? `反证成立：关掉父死看守 ⇒ 目标存活（心跳仍在跳：${after.a} → ${after.b}）`
          : '反证失败：关掉看守后目标**仍然**死了 —— 说明它不是被看守带走的',
      };
    }
    return {
      id: target.id,
      label: target.label,
      beforeAlive: true,
      afterAlive: after.alive,
      pidAliveAfter: pidAlive(targetPid),
      ok: !after.alive,
      why: !after.alive
        ? `父进程退出后目标被带走（心跳停止于 ${after.b || after.a || '(空)'}；此前在跳：${before.a} → ${before.b}）`
        : `父进程退出后目标**仍在跳**（${after.a} → ${after.b}）—— 看守没生效，真模式 E11 会留孤儿`,
    };
  } finally {
    cleanup(beat);
  }
}

// ------------------------------------------------------------------ W2：接线错误必须被拦下

/**
 * W2：`MIAO_NO_PARENT_WATCH=1` 时看守器必须**完全不自杀**。
 *
 * 这条不是重复 W1 的反证 —— 它验的是**缺陷 ① 的修法**：管道 EOF 在接线错误时也会到达，
 * 若看守器"读到 EOF 就自杀"，那么任何没攥住写端的父进程都会让引擎一起来就死。
 * 这里故意**不给 stdin 管道**（给 null，模拟接线错误），要求目标仍能活到自然结束。
 */
async function runWiringGuard() {
  const beat = path.join(os.tmpdir(), `miao-cw-wire-${process.pid}-${Date.now()}.txt`);
  const target = TARGETS[1]; // Rust 版
  try {
    // 父进程给 **null** stdin（接线错误），且**一直活着**（不退），看守器不该自杀。
    const argv = [...target.argv[1], '--', process.execPath, '-e', targetSource(beat)];
    const src = [
      `const c = require('child_process').spawn(${JSON.stringify(target.argv[0])}, ${JSON.stringify(argv)},`,
      `  { stdio: ['ignore', 'ignore', 'ignore'], env: process.env });`,
      'c.unref();',
      'setTimeout(() => {}, 5000);',
    ].join('\n');
    const p = spawn(process.execPath, ['-e', src], { stdio: 'ignore' });
    await sleep(2500);
    const beatState = await beating(beat, 1200);
    const ok = beatState.alive;
    p.kill('SIGKILL');
    return {
      id: 'wiring',
      label: '父进程没攥住 stdin 管道时，看守器不得自杀（否则引擎一起来就没）',
      ok,
      why: ok
        ? `目标仍存活（心跳在跳：${beatState.a} → ${beatState.b}）—— 接线错误被复核正确拦下`
        : `目标已死（${beatState.a} → ${beatState.b}）—— 管道 EOF 未复核，误杀了健康的引擎`,
    };
  } finally {
    cleanup(beat);
  }
}

// ------------------------------------------------------------------ 跑

console.log(`父死看守 · 双靶${REFUTE ? '反证轮' : '正向轮'}（node=${process.version} / ${process.platform}）\n`);

const results = [];
for (const t of TARGETS) {
  process.stdout.write(`  … ${t.label}\n`);
  const r = await runTarget(t);
  // 🔴 反证轮只判 **Rust 靶**：Node 父进程退出会连带清理目标（Windows 的隐式 job），
  //    关掉看守目标也会死 ⇒ 该靶在反证轮**结构上无法给出有效结论**。
  //    不是"跳过它红着不管"，而是明确标注原因（跳过 ≠ 通过，见脚本末尾的判定）。
  if (REFUTE && t.id === 'node') {
    r.skipped = true;
    r.why =
      '不参与反证：node 父进程退出会连带清理目标（Windows 隐式 job），' +
      '关掉看守目标也会死 ⇒ 该靶在反证轮结构上无法给出有效结论。反证权威由 Rust 靶（产品同源）给出。';
  }
  results.push(r);
}

if (!REFUTE) {
  results.push(await runWiringGuard());
}

let fail = 0;
let skipped = 0;
console.log('');
for (const r of results) {
  if (r.skipped) {
    skipped++;
    console.log(`  ⊘ [${r.id}] ${r.label}\n      ${r.why}`);
    continue;
  }
  if (!r.ok) fail++;
  console.log(`  ${r.ok ? '✓' : '✗'} [${r.id}] ${r.label}\n      ${r.why}`);
}

console.log(`\n${'─'.repeat(60)}`);
if (REFUTE) {
  const judged = results.length - skipped;
  const passed = judged - fail;
  console.log(`REFUTE: ${passed} / ${judged} 条反证成立（另有 ${skipped} 个靶点按结构跳过）`);
  console.log(
    fail === 0
      ? '✓ 带走目标的责任确实在看守器身上（关掉它目标就留下）'
      : '✗ 有靶点在关掉看守后目标仍然死了 —— 带走它的另有其人，本轮反证无效',
  );
} else {
  console.log(`通过 ${results.length - fail} / 失败 ${fail}`);
}
process.exit(fail ? 1 : 0);