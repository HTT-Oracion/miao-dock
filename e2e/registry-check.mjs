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
 * ## 断言（4 条）
 *   REG.npmCovered   npm 每个检查类脚本都在注册表中有 (script, args) 对应项
 *   REG.scriptsExist 注册表每项的 script 文件真实存在（防指向已搬迁/已删脚本）
 *   REG.tiersValid   每项 tier ∈ TIER_ORDER
 *   REG.idsUnique    id 无重复（含派生的 -refute）
 *
 * ## 反证轮（--refute，4 个内存变异，各打红对应一条）
 *   M1 注入假 npm 脚本            → npmCovered 红
 *   M2 注册项指向不存在路径        → scriptsExist 红
 *   M3 注册项 tier 改坏           → tiersValid 红
 *   M4 复制一个 id                → idsUnique 红
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
  const uncovered = npmChecks.filter((n) => !have.has(keyOf(n))).map((n) => `${n.name} → ${n.script}${n.args.length ? ` ${n.args.join(' ')}` : ''}`);
  const missing = entries.filter((e) => !fs.existsSync(path.join(ROOT, e.script))).map((e) => `${e.id}: ${e.script}`);
  const badTier = entries.filter((e) => !TIER_ORDER.includes(e.tier)).map((e) => `${e.id}: tier=${e.tier}`);
  const seen = new Set();
  const dups = [];
  for (const e of entries) {
    if (seen.has(e.id)) dups.push(e.id);
    seen.add(e.id);
  }
  return [
    { id: 'REG.npmCovered', label: 'npm 检查类脚本全部登记进注册表（script + args 逐项对上）', ok: uncovered.length === 0, detail: uncovered.length ? `未登记：${uncovered.join('；')}` : `${npmChecks.length} 个 npm 脚本全部有对应注册项` },
    { id: 'REG.scriptsExist', label: '注册表每项的 script 文件真实存在', ok: missing.length === 0, detail: missing.length ? `缺失：${missing.join('；')}` : `${entries.length} 个注册项的文件都在` },
    { id: 'REG.tiersValid', label: '注册表每项 tier 合法', ok: badTier.length === 0, detail: badTier.length ? `非法：${badTier.join('；')}` : `全部 ∈ {${TIER_ORDER.join(',')}}` },
    { id: 'REG.idsUnique', label: '注册表 id 无重复', ok: dups.length === 0, detail: dups.length ? `重复：${[...new Set(dups)].join(',')}` : `${entries.length} 个 id 互不重复` },
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
    console.log('\n[RESULT] ' + JSON.stringify({ results: forward, pass: forward.filter((r) => r.ok).length, fail: forward.filter((r) => !r.ok).length }));
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
  ];

  let allRed = true;
  for (const m of mutations) {
    const [mScripts, mEntries] = m.apply(pkg.scripts, entries);
    const got = runAssertions(mScripts, mEntries);
    const target = got.find((r) => r.id === m.expect);
    const red = target && !target.ok;
    if (!red) allRed = false;
    console.log(`  ${red ? '✓' : '✗'} ${m.id} ${m.what} → ${m.expect} ${red ? '按预期变红' : '**没有红**（断言漏了它）'}`);
  }

  const pass = forward.filter((r) => r.ok).length;
  console.log('\n[RESULT] ' + JSON.stringify({ results: forward, pass, fail: forward.length - pass }));
  console.log(`\n注册表完整性：正向 ${pass} / ${forward.length}，反证 ${mutations.filter((m) => m.expect).length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`);
  process.exit(forwardOk && allRed ? 0 : 1);
}

const pass = forward.filter((r) => r.ok).length;
console.log('\n[RESULT] ' + JSON.stringify({ results: forward, pass, fail: forward.length - pass }));
console.log(`\n注册表完整性：${pass} / ${forward.length} 通过`);
process.exit(forwardOk ? 0 : 1);
