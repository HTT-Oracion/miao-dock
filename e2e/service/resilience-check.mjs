#!/usr/bin/env node
/**
 * box-service **顶层异常兜底**的根因钉子 —— 且必须可反证
 * ================================================================
 * ## 为什么钉源码，而不是"制造一次崩溃看看"
 *
 * 目的是让「进程因未捕获错误死掉时**不留孤儿子进程**」这件事可被秒级、零依赖地回归。
 * 真造一次崩溃要拉起 ①②③ 三个真进程（分钟级、依赖本机 runtimes），不适合当常规门。
 * 成因全在 `service/src/server.mjs` 的收尾结构里，钉住结构即可。
 *
 * ## 钉的不是风格，是机制
 *
 *   R1 注册了 `process.on('unhandledRejection', …)`。
 *      Node ≥15 下未处理的 rejection 默认**直接终止进程** —— 本进程是 ①②③ 的宿主，
 *      一死就把子进程留成孤儿。
 *
 *   R2 注册了 `process.on('uncaughtException', …)`。同上。
 *
 *   R3 两个崩溃处理器都调用 `shutdown(...)`，**不是**直接 `process.exit`。
 *      直接 `process.exit` 会绕过收尾 ⇒ ③ 不被停 ⇒ 8080 留给孤儿。
 *
 *   R4 信号处理器（SIGINT/SIGTERM）也走同一个 `shutdown`。
 *      单一收尾路径：否则"信号退"与"崩溃退"有一天会各收一半（改一处漏一处）。
 *
 *   R5 `shutdown` 内确实收 ③（`llm.stop`）—— 这是"不留孤儿"的实际动作，不是空壳。
 *
 *   R6 `shutdown` 有重入闸（`shuttingDown`）。信号与崩溃可能先后到达；无闸则收尾跑两遍。
 *
 *   R7 崩溃处理器以**非零**码退出（`, 1)`）—— 接住异常不等于吞掉故障：进程仍以失败退出。
 *
 * ## 反证轮（`--refute`）
 *   逐条把结构改回缺陷形态（**只在内存里改源码字符串**，不碰工作区），
 *   对应断言**必须变红**。
 *
 * ⚠️ 边界，别误读：本脚本证明的是**"顶层兜底的结构在"**，不是"真的崩溃过且没留孤儿"。
 *   后者由 `selftest:app:e11`（SIGKILL 场景）从外部补充取证 —— 那条测的是**不可捕获**的死法，
 *   与本处的**可捕获**死法互补，不是替代。
 *
 * 用法：
 *   node e2e/service/resilience-check.mjs            正向跑（期望全绿）
 *   node e2e/service/resilience-check.mjs --refute   反证轮（内存变异 → 变红）
 *
 * 约束：纯 Node、零依赖、不起任何进程、不动工作区。
 * 见 ~/.workbuddy/skills/falsifiable-verification。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER = path.join(ROOT, 'service', 'src', 'server.mjs');
const REFUTE = process.argv.includes('--refute');

/** 取某处理器/函数体的源码段：自 `marker` 起，到下一个 `stopAt` 或文件末 */
function sliceFrom(src, marker, stopAt) {
  const i = src.indexOf(marker);
  if (i < 0) return '';
  const rest = src.slice(i);
  if (!stopAt) return rest;
  const j = rest.indexOf(stopAt, marker.length);
  return j < 0 ? rest : rest.slice(0, j);
}

/**
 * 纯函数：给定源码文本，产出断言结果。
 * 反证轮把变异后的文本喂进来，跑同一套判据 —— 判据与"读盘"解耦，才测得住。
 */
function evaluate(src) {
  const out = [];
  const add = (id, label, ok, detail) => out.push({ id, label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

  const rej = sliceFrom(src, "process.on('unhandledRejection'", 'process.on(');
  const unc = sliceFrom(src, "process.on('uncaughtException'", 'process.on(');
  const sigLoop = sliceFrom(src, 'for (const sig of', '\n}');
  const shutdownBody = sliceFrom(src, 'function shutdown(', '\nfor (const sig of');

  add('R1', "注册了 process.on('unhandledRejection')", src.includes("process.on('unhandledRejection'"));
  add('R2', "注册了 process.on('uncaughtException')", src.includes("process.on('uncaughtException'"));
  add('R3', '两个崩溃处理器都调用 shutdown（而非直接 process.exit）',
    rej.includes('shutdown(') && unc.includes('shutdown('),
    `rejection=${rej.includes('shutdown(')} exception=${unc.includes('shutdown(')}`);
  add('R4', '信号处理器（SIGINT/SIGTERM）走同一个 shutdown', sigLoop.includes('shutdown('));
  add('R5', 'shutdown 内确实收 ③（llm.stop）', shutdownBody.includes('llm.stop('));
  add('R6', 'shutdown 有重入闸（if (shuttingDown) return）',
    /if\s*\(\s*shuttingDown\s*\)\s*return/.test(shutdownBody));
  add('R7', '崩溃处理器以非零码退出', /shutdown\([^)]*,\s*1\)/.test(rej) && /shutdown\([^)]*,\s*1\)/.test(unc));

  return out;
}

function printResults(rows) {
  console.log('\n【box-service 顶层兜底 · 结构钉子】');
  let fail = 0;
  for (const r of rows) {
    if (!r.ok) fail++;
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.id} ${r.label}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log('\n' + '─'.repeat(56));
  console.log(`通过 ${rows.length - fail} / 失败 ${fail}`);
  return fail;
}

/// 每条变异 = 把结构改回缺陷形态（内存变异），并声明哪些断言必须变红。
const MUTATIONS = [
  {
    name: 'M1 删掉 unhandledRejection 注册（改名即等于未注册）',
    apply: (s) => s.replace("process.on('unhandledRejection',", "process.on('__off_unhandledRejection',"),
    expect: ['R1', 'R3', 'R7'],
  },
  {
    name: 'M2 删掉 uncaughtException 注册（改名即等于未注册）',
    apply: (s) => s.replace("process.on('uncaughtException',", "process.on('__off_uncaughtException',"),
    expect: ['R2', 'R3', 'R7'],
  },
  {
    name: "M3 崩溃处理器绕过收尾，直接 process.exit(1)",
    apply: (s) => s.replace("shutdown('未处理的 Promise rejection', 1);", 'process.exit(1);'),
    expect: ['R3', 'R7'],
  },
  {
    name: 'M4 信号处理器绕过 shutdown，直接 process.exit',
    apply: (s) => s.replace('process.on(sig, () => shutdown(`收到 ${sig}`, 0));', 'process.on(sig, () => process.exit(0));'),
    expect: ['R4'],
  },
  {
    name: 'M5 shutdown 不再收 ③（删 llm.stop）',
    apply: (s) => s.replace('llm.stop({ reason, graceMs: 3000 }).catch(() => {}).finally(finish);', 'finish();'),
    expect: ['R5'],
  },
  {
    name: 'M6 shutdown 去掉重入闸',
    apply: (s) => s.replace('if (shuttingDown) return;', 'if (false) return;'),
    expect: ['R6'],
  },
];

const main = () => {
  console.log(`box-service 顶层兜底钉子${REFUTE ? ' · 反证轮' : ''}`);
  const src = fs.readFileSync(SERVER, 'utf8');

  if (!REFUTE) {
    process.exitCode = printResults(evaluate(src)) === 0 ? 0 : 1;
    return;
  }

  const baseline = evaluate(src);
  const wasGreen = {};
  for (const r of baseline) wasGreen[r.id] = r.ok;
  const baselineRed = baseline.filter((r) => !r.ok).map((r) => r.id);

  const expectedTotal = MUTATIONS.reduce((n, m) => n + m.expect.length, 0);
  let total = 0;
  let red = 0;
  let skipped = 0;
  const falsePositives = [];

  console.log('\n内存变异源码 → 断言必须变红（不碰工作区）\n');
  for (const mut of MUTATIONS) {
    const mutated = mut.apply(src);
    if (mutated === src) {
      console.log(`⚠ ${mut.name}\n    变异锚点未命中（源码已改？）—— 本条无法反证`);
      skipped += mut.expect.length;
      continue;
    }
    const res = evaluate(mutated);
    const byId = {};
    for (const r of res) byId[r.id] = r;

    console.log(`🔴 ${mut.name}`);
    for (const id of mut.expect) {
      total++;
      if (byId[id] && byId[id].ok === false) {
        red++;
        console.log(`  ✓ ${id} 按预期变红`);
      } else {
        falsePositives.push(id);
        console.log(`  ✗ ${id} 该红没红 ← 假阳性`);
      }
      if (!wasGreen[id]) console.log('     注：该条基线本就是红，无法据此判定断言有效性');
    }
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`REFUTE: ${red}/${total} 条按预期变红（应执行 ${expectedTotal} 条）`);
  if (baselineRed.length) console.log(`✗ 基线存在红条：${baselineRed.join(', ')} —— 先修基线再谈反证`);
  if (skipped) console.log(`✗ 有 ${skipped} 条未能反证（变异锚点未命中）—— 跳过 ≠ 通过`);
  if (falsePositives.length) console.log(`✗ 假阳性：${falsePositives.join(', ')}`);
  process.exitCode = red === expectedTotal && skipped === 0 && baselineRed.length === 0 ? 0 : 1;
};

try {
  main();
} catch (err) {
  console.error(`\n脚本异常：${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
}
