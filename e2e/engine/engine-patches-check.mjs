#!/usr/bin/env node
/**
 * engine-patches-check.mjs —— 上游源码补丁表（ENGINE_PATCHES）的取证（正向 + 反证）
 * =============================================================================
 * 为什么需要它：上游引擎源码**不入库**，我们对它的每一处修改都只存在于
 * `engine/scripts/setup-engine.mjs` 的 `ENGINE_PATCHES` 表里。表与实物的脱节**不会报错**：
 *   · 表里少写一条 ⇒ 换机/换版本装配出来的引擎静默缺一个补丁（症状是"翻译没字""译文崩坏"）；
 *   · 补丁体里漏写 marker ⇒ 幂等判据永不成立 ⇒ 每跑一次装配就往文件里堆第二份代码；
 *   · 锚点指向错文件/已失效 ⇒ 只有真正重放时才知道（而重放需要网络与时间）。
 * 本脚本把这些**在秒级、零网络、零 GPU** 的前提下钉死。
 *
 * 取证方式：把「断言」写成**纯函数** `evaluate(patches, readFile)` —— 正向轮喂**真实**的表与
 * 文件；反证轮喂**内存里变异过的**表/内容，证明每条断言都能真的变红，且**不动工作区一个字节**
 * （本项目已有教训：变异取证若落在真实文件上，被打断就会把垃圾留在树里）。
 *
 * 用法：node e2e/engine/engine-patches-check.mjs [--refute]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_PATCHES } from '../../engine/scripts/setup-engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const REFUTE = process.argv.includes('--refute');

/** 写死的期望补丁条数。加了补丁就必须同步改这里（否则分母漂移，见 AGENTS.md §2-3）。 */
const EXPECTED_PATCHES = 6;

/** marker 命名纪律：一眼能认出"这处被我们改过"，也便于全仓扫描。 */
const MARK_PREFIX = '# miao-dock 补丁 D-';

// ------------------------------------------------------------------ 断言收集

const results = [];
let group = '';
const setGroup = (g) => { group = g; console.log(`\n${g}`); };
function add(id, ok, detail = '') {
  results.push({ group, id, ok: !!ok });
  console.log(`  ${ok ? '✓' : '✗'} ${id}${detail ? `  ${detail}` : ''}`);
}

// ------------------------------------------------------------------ 纯函数断言（正向/反证共用）

/** 默认文件读取器：读不到返回 null（**不是**空串 —— "文件不存在"与"文件为空"要能分开）。 */
const readReal = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

/**
 * 对「一份补丁表 + 一个文件读取器」求值，返回**失败的断言 id 列表**。
 * 🔴 正向轮与反证轮共用它 —— 反证若另写一遍实现，证明的就是另一件事了。
 */
function evaluate(patches, readFile = readReal) {
  const bad = [];

  // A1 条数必须写死（比率型/自增型分母会吞掉"表被删空"这类事故）
  if (!Array.isArray(patches) || patches.length !== EXPECTED_PATCHES) bad.push('A1');

  // A2 结构完整 + id / mark 唯一
  let structOk = Array.isArray(patches) && patches.length > 0;
  const ids = new Set(); const marks = new Set();
  for (const p of patches || []) {
    if (!p || !p.id || !p.mark || !p.file || !p.desc
      || !Array.isArray(p.edits) || p.edits.length === 0) { structOk = false; continue; }
    for (const e of p.edits) if (!e || !e.anchor || !e.patch) structOk = false;
    if (ids.has(p.id) || marks.has(p.mark)) structOk = false;
    ids.add(p.id); marks.add(p.mark);
  }
  if (!structOk) bad.push('A2');

  // A3 marker 命名纪律
  if (!(patches || []).every((p) => String(p?.mark || '').startsWith(MARK_PREFIX))) bad.push('A3');

  // A4 目标源码都在（引擎未装 ⇒ 必须报错，不能静默当成"通过"）
  if (!(patches || []).every((p) => { try { return fs.existsSync(p.file); } catch { return false; } })) bad.push('A4');

  // A5 每个 marker 都在目标文件里 = 补丁真的打上了
  let allApplied = true;
  for (const p of patches || []) {
    const txt = readFile(p.file);
    if (txt == null || !txt.includes(p.mark)) allApplied = false;
  }
  if (!allApplied) bad.push('A5');

  // A6 补丁体里**必须含自己的 marker** —— 否则幂等判据永不成立，重跑装配会堆第二份代码
  const allSelfMarked = (patches || []).every(
    (p) => (p?.edits || []).some((e) => String(e?.patch || '').includes(p.mark)),
  );
  if (!allSelfMarked) bad.push('A6');

  return bad;
}

// ------------------------------------------------------------------ 主流程

function main() {
  if (REFUTE) {
    // ── 反证轮：每条断言喂一个能打红它的变异，且**不改工作区**
    const real = readReal;

    setGroup('反证：每条断言都要能被一条变异打红');
    const mut = [
      {
        id: 'R1 表里少一条补丁 ⇒ A1 条数断言变红',
        patches: ENGINE_PATCHES.slice(0, -1), readFile: real, expect: 'A1',
      },
      {
        id: 'R2 补丁体漏写自己的 marker ⇒ A6 幂等自含断言变红',
        patches: ENGINE_PATCHES.map((p, i) => (i === 0
          ? { ...p, edits: p.edits.map((e) => ({ ...e, patch: e.patch.split(p.mark).join('') })) }
          : p)),
        readFile: real,
        expect: 'A6',
      },
      {
        id: 'R3 目标文件不存在 ⇒ A4 存在性断言变红',
        patches: ENGINE_PATCHES.map((p, i) => (i === 0 ? { ...p, file: `${p.file}.no-such` } : p)),
        readFile: real,
        expect: 'A4',
      },
      {
        id: 'R4 文件里的 marker 被抹掉 ⇒ A5 已应用断言变红',
        patches: ENGINE_PATCHES,
        // 只对第一条补丁的目标文件做变异：把它内容里的那个 marker 抹掉
        readFile: (f) => {
          const t = real(f);
          if (t == null) return t;
          return f === ENGINE_PATCHES[0].file ? t.split(ENGINE_PATCHES[0].mark).join('') : t;
        },
        expect: 'A5',
      },
    ];

    for (const m of mut) {
      const bad = evaluate(m.patches, m.readFile);
      add(m.id, bad.includes(m.expect), `（实际红：${bad.join(',') || '无'}）`);
    }

    const pass = results.filter((r) => r.ok).length;
    const fail = results.length - pass;
    console.log(`\n${'─'.repeat(56)}`);
    const EXPECTED = 4;
    if (results.length !== EXPECTED) {
      console.log(`✗ 反证条数 ${results.length} ≠ 写死的 ${EXPECTED}`);
      process.exit(1);
    }
    console.log(`通过 ${pass} / 失败 ${fail}（分母写死 ${EXPECTED}）`);
    if (fail) process.exit(1);
    console.log('✓ 全部反证成立：每条断言都能捕捉到它声称捕捉的机制。');
    return;
  }

  // ── 正向轮
  setGroup('补丁表 ↔ 实物 一致性（零网络 / 零 GPU）');
  const bad = evaluate(ENGINE_PATCHES, readReal);
  const checks = [
    ['A1', `补丁条数 = ${EXPECTED_PATCHES}（写死）`],
    ['A2', '结构完整（id/mark/file/desc/edits 且 id 与 mark 唯一）'],
    ['A3', `marker 命名纪律（前缀 "${MARK_PREFIX}"）`],
    ['A4', '目标源码文件全部存在（缺失必须报错，不静默跳过）'],
    ['A5', '每个 marker 都已出现在目标文件里（= 补丁真的打上了）'],
    ['A6', '每个补丁体自含 marker（幂等判据成立 ⇒ 重跑装配不堆代码）'],
  ];
  for (const [id, name] of checks) add(id, !bad.includes(id), name);

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n${'─'.repeat(56)}`);
  const EXPECTED_TOTAL = 6;
  if (results.length !== EXPECTED_TOTAL) {
    console.log(`✗ 断言条数 ${results.length} ≠ 写死的 ${EXPECTED_TOTAL}`);
    process.exit(1);
  }
  console.log(`通过 ${pass} / 失败 ${fail}（分母写死 ${EXPECTED_TOTAL}）`);
  if (fail) {
    console.log('✗ 有失败项：先判断是"补丁没打上"还是"表写错了"，不要为了转绿而放宽断言。');
    console.log('  提示：补丁由 `node engine/scripts/setup-engine.mjs --source` 重放。');
    process.exit(1);
  }
  console.log('✓ 全部通过。');
}

main();
