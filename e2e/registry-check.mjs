#!/usr/bin/env node
/**
 * 注册表完整性钉子 —— `package.json` 的检查类脚本 ↔ `_check-registry.mjs` 的双向覆盖。
 *
 * ## 为什么必须有它
 * 聚合 runner（`run-checks.mjs`）按注册表分流/过滤/并行。新写一个 `check:X` 却忘了
 * 登记进注册表，后果不是报错，而是**静默消失在分层之外**：`--changed` 永远想不起
 * 跑它、`check:nightly` 永远不含它 —— 典型的「该红没红」。本钉子把「登记」从
 * 散文纪律变成可反证的断言。
 *
 * ## 断言（5 条）
 *   REG.npmCovered   npm 每个检查类脚本都在注册表中有 (script, args) 对应项
 *   REG.scriptsExist 注册表每项的 script 文件真实存在（防指向已搬迁/已删脚本）
 *   REG.tiersValid   每项 tier ∈ TIER_ORDER
 *   REG.idsUnique    id 无重复（含派生的 -refute）
 *   REG.tierCounts   各层条数 == 写死的常量（E4 计数门：防「全绿但少一块」）
 *
 * ## 反证轮（--refute，5 个内存变异，各打红对应一条）
 *   M1 注入假 npm 脚本            → npmCovered 红
 *   M2 注册项指向不存在路径        → scriptsExist 红
 *   M3 注册项 tier 改坏           → tiersValid 红
 *   M4 复制一个 id                → idsUnique 红
 *   M5 删掉一条注册项              → tierCounts 红
 * 反证前先要求**正向全绿** —— 正向就红时反证证明不了任何事（该红没红 vs 本来红分不清）。
 *
 * 用法：node e2e/registry-check.mjs [--refute]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { buildRegistry, TIER_ORDER } from './_check-registry.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const REFUTE = process.argv.includes('--refute');

/** 聚合器入口自身：跑了会递归，不纳入覆盖要求（它们在注册表外是有意的） */
const AGGREGATORS = new Set(['e2e/run-checks.mjs']);

/**
 * **各层条数写死并断言**（E4 计数门；AGENTS §2.3「断言条数要写死并断言」）。
 *
 * 为什么这不算形式主义：`run-checks.mjs` 按层分流，一条判据被**误删**、或 tier 被写错时，
 * 它只是"不在那一层里跑了" —— 输出依旧全绿，**没有任何一行会变红**。
 * 反向同样成立：新加的钉子若忘了登记（或登记成 nightly），`check:full` 永远不含它。
 * 分子变绿、分母变小，正是"假绿"的标准形态；把分母钉住，减一条就得先改这个常量。
 *
 * 🔴 改这个常量时，请顺手确认 AGENTS.md §3 的条数也同步（`check:docs` 管不到这一节）。
 */
const EXPECTED_TIER_COUNTS = { static: 16, service: 44, nightly: 9, refute: 58 };

/** npm 脚本 → { name, script, args }；复合脚本（`a && b`）与非 node 调用跳过 */
function parseNpmChecks(scripts) {
  const out = [];
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value !== 'string') continue;
    if (!/^(check:|selftest|e2e$)/.test(name)) continue;
    if (!value.startsWith('node ')) continue;
    const [script, ...args] = value.slice(5).trim().split(/\s+/);
    if (AGGREGATORS.has(script)) continue;
    out.push({ name, script, args });
  }
  return out;
}

const keyOf = (e) => `${e.script}|${(e.args ?? []).join(' ')}`;

function runAssertions(scripts, entries) {
  const npmChecks = parseNpmChecks(scripts);
  const have = new Set(entries.map(keyOf));
  const uncovered = npmChecks
    .filter((n) => !have.has(keyOf(n)))
    .map((n) => `${n.name} → ${n.script}${n.args.length ? ` ${n.args.join(' ')}` : ''}`);
  const missing = entries.filter((e) => !fs.existsSync(path.join(ROOT, e.script))).map((e) => `${e.id}: ${e.script}`);
  const badTier = entries.filter((e) => !TIER_ORDER.includes(e.tier)).map((e) => `${e.id}: tier=${e.tier}`);
  const seen = new Set();
  const dups = [];
  for (const e of entries) {
    if (seen.has(e.id)) dups.push(e.id);
    seen.add(e.id);
  }
  // 各层条数（分母）—— 与写死的常量逐层比。
  const gotCounts = {};
  for (const t of TIER_ORDER) gotCounts[t] = 0;
  for (const e of entries) gotCounts[e.tier] = (gotCounts[e.tier] ?? 0) + 1;
  const countDiff = TIER_ORDER.filter((t) => (gotCounts[t] ?? 0) !== (EXPECTED_TIER_COUNTS[t] ?? 0)).map(
    (t) => `${t}: 实际 ${gotCounts[t] ?? 0} ≠ 写死 ${EXPECTED_TIER_COUNTS[t] ?? 0}`,
  );
  return [
    {
      id: 'REG.npmCovered',
      label: 'npm 检查类脚本全部登记进注册表（script + args 逐项对上）',
      ok: uncovered.length === 0,
      detail: uncovered.length ? `未登记：${uncovered.join('；')}` : `${npmChecks.length} 个 npm 脚本全部有对应注册项`,
    },
    {
      id: 'REG.scriptsExist',
      label: '注册表每项的 script 文件真实存在',
      ok: missing.length === 0,
      detail: missing.length ? `缺失：${missing.join('；')}` : `${entries.length} 个注册项的文件都在`,
    },
    {
      id: 'REG.tiersValid',
      label: '注册表每项 tier 合法',
      ok: badTier.length === 0,
      detail: badTier.length ? `非法：${badTier.join('；')}` : `全部 ∈ {${TIER_ORDER.join(',')}}`,
    },
    {
      id: 'REG.idsUnique',
      label: '注册表 id 无重复',
      ok: dups.length === 0,
      detail: dups.length ? `重复：${[...new Set(dups)].join(',')}` : `${entries.length} 个 id 互不重复`,
    },
    {
      id: 'REG.tierCounts',
      label: '各层条数 == 写死的常量（E4 计数门：减一条就得先改常量，不会"全绿但少一块"）',
      ok: countDiff.length === 0,
      detail: countDiff.length
        ? `层条数不符：${countDiff.join('；')}（改常量前先确认不是误删/误改 tier）`
        : `static=${gotCounts.static} service=${gotCounts.service} nightly=${gotCounts.nightly} refute=${gotCounts.refute}（共 ${entries.length}）`,
    },
  ];
}

// ------------------------------------------------------------------ 正向
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const entries = buildRegistry();
const forward = runAssertions(pkg.scripts, entries);
const forwardOk = forward.every((r) => r.ok);

for (const r of forward) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.id} — ${r.label}\n      ${r.detail}`);
}

// ------------------------------------------------------------------ 反证
if (REFUTE) {
  if (!forwardOk) {
    // 正向就红 ⇒ 反证无意义（分不清「变异打红」与「本来红」）。按失败收场。
    console.log(
      '\n[RESULT] ' +
        JSON.stringify({
          results: forward,
          pass: forward.filter((r) => r.ok).length,
          fail: forward.filter((r) => !r.ok).length,
        }),
    );
    console.log('正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }

  const mutations = [
    {
      id: 'M1',
      what: 'npm 注入未登记的检查脚本',
      apply: (scripts, list) => [{ ...scripts, 'check:zzz-fake': 'node e2e/zzz-fake-check.mjs' }, list],
      expect: 'REG.npmCovered',
    },
    {
      id: 'M2',
      what: '注册项指向不存在的脚本路径',
      apply: (scripts, list) => [scripts, list.map((e, i) => (i === 0 ? { ...e, script: 'e2e/__nope__.mjs' } : e))],
      expect: 'REG.scriptsExist',
    },
    {
      id: 'M3',
      what: '注册项 tier 改成非法值',
      apply: (scripts, list) => [scripts, list.map((e, i) => (i === 0 ? { ...e, tier: 'bogus' } : e))],
      expect: 'REG.tiersValid',
    },
    {
      id: 'M4',
      what: '复制一个注册项（id 撞车）',
      apply: (scripts, list) => [scripts, [...list, { ...list[0] }]],
      expect: 'REG.idsUnique',
    },
    {
      id: 'M5',
      what: '删掉一条注册项（分母悄悄变小 = 「全绿但少一块」）',
      apply: (scripts, list) => [scripts, list.slice(1)],
      expect: 'REG.tierCounts',
    },
  ];

  let allRed = true;
  for (const m of mutations) {
    const [mScripts, mEntries] = m.apply(pkg.scripts, entries);
    const got = runAssertions(mScripts, mEntries);
    const target = got.find((r) => r.id === m.expect);
    const red = target && !target.ok;
    if (!red) allRed = false;
    console.log(
      `  ${red ? '✓' : '✗'} ${m.id} ${m.what} → ${m.expect} ${red ? '按预期变红' : '**没有红**（断言漏了它）'}`,
    );
  }

  const pass = forward.filter((r) => r.ok).length;
  console.log('\n[RESULT] ' + JSON.stringify({ results: forward, pass, fail: forward.length - pass }));
  console.log(
    `\n注册表完整性：正向 ${pass} / ${forward.length}，反证 ${mutations.filter((m) => m.expect).length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`,
  );
  process.exit(forwardOk && allRed ? 0 : 1);
}

const pass = forward.filter((r) => r.ok).length;
console.log('\n[RESULT] ' + JSON.stringify({ results: forward, pass, fail: forward.length - pass }));
console.log(`\n注册表完整性：${pass} / ${forward.length} 通过`);
process.exit(forwardOk ? 0 : 1);
