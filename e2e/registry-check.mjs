#!/usr/bin/env node
/**
 * 命令清单 ↔ 分层注册表 的双向覆盖钉子（`check:registry`）。
 *
 * ## 它守的是什么（一句话）
 * **「一条检查存在」这件事，在清单、注册表、`package.json` 三处必须同时成立；
 * 任何一处少一块，都必须变红 —— 而不是静默消失在分层之外。**
 *
 * ## 为什么必须有它（收束之前与之后各有一个坑）
 * · 收束**之前**：`package.json` 里新写一个 `check:X` 却忘了登记进注册表 ⇒ `--changed`
 *   永远想不起跑它、`check:nightly` 永远不含它 —— 典型的「该红没红」。
 * · 收束**之后**：149 条 scripts 搬进 `e2eScripts.json`（`npm run task -- <id>`），
 *   于是又多了两个同源的坑：**漏搬一条**（命令还在 `package.json` 之外消失）、
 *   **偷偷加回一条**（"收束"名存实亡）。两者都不报错，只是分层里少/多一块。
 * 本钉子把这两个方向都变成可反证的断言。
 *
 * ## 连接键
 * 清单的 id 与注册表的 id **不要求同名**（清单沿用 `npm run` 时代的名字：`check:units`、
 * `selftest:service`…；注册表用 `--only` 时代的短名：`units`、`svc-selftest`…），
 * 两侧靠 `(script, args)` 这个**连接键**对上 —— 名字可以各自演进，
 * "跑的东西是不是同一个"必须逐字节一致。
 *
 * ## 断言（15 条）
 *   MAN.cmdShape        清单每条 cmd 都是 `node <相对路径> [args…]` 形态
 *   MAN.scriptsExist    清单每条指向的脚本真实存在（防"搬完之后脚本没了"）
 *   MAN.filesCovered    `e2e/` 下每个脚本都在清单里（新写检查却忘了登记 ⇒ 红）
 *   MAN.idsUnique       清单 id 无重复（含派生的 `:refute`）
 *   MAN.refuteDerived   反证轮**只许派生**：清单里不得出现手写的 `:refute` 条目
 *   MAN.groupCounts     清单各分组条数 == 写死的常量（E4 计数门 · 分母不许悄悄变小）
 *   PKG.kept            `package.json` 的命令**恰好**等于三类入口白名单（收束这件事本身）
 *   REG.cmdsRegistered  清单里每条检查都在注册表里（script + args 逐项对上）
 *   REG.registryCovered 注册表每一项在清单里都有命令（反向：注册表有、命令没了）
 *   REG.tierMatch       同一 (script,args) 在两侧的分层一致
 *   REG.noNonTierOverlap 非分层分组（supply / dev）不得混进注册表
 *   REG.tiersValid · REG.idsUnique · REG.scriptsExist · REG.tierCounts   注册表自身完整性
 *
 * ## 反证轮（--refute，13 个内存变异，各打红指定的一条）
 *   M1  清单注入注册表没有的检查     → REG.cmdsRegistered
 *   M2  清单一条指向不存在的脚本     → MAN.scriptsExist
 *   M3  清单一条 cmd 改成非 node 形态 → MAN.cmdShape
 *   M4  复制一条（id 撞车）          → MAN.idsUnique
 *   M5  删掉一条（分母悄悄变小）     → MAN.groupCounts
 *   M6  手写一条 `:refute` 条目      → MAN.refuteDerived
 *   M7  `package.json` 加回一条 check → PKG.kept
 *   M8  注册表多一项（清单没搬）     → REG.registryCovered
 *   M9  清单把一条挪到别的层         → REG.tierMatch
 *   M10 supply 分组塞一条真检查      → REG.noNonTierOverlap
 *   M11 注册表 tier 改坏             → REG.tiersValid
 *   M12 注册表删一条                 → REG.tierCounts
 *   M13 清单删掉一条（= 盘上有脚本没登记）→ MAN.filesCovered
 * 反证前先要求**正向全绿** —— 正向就红时反证证明不了任何事（该红没红 vs 本来红分不清）。
 *
 * 用法：node e2e/registry-check.mjs [--refute]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** 递归列出 `e2e/` 下所有 `.mjs`（相对仓库根、正斜杠） */
function walkMjs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMjs(p, out);
    else if (e.name.endsWith('.mjs')) out.push(path.relative(ROOT, p).split(path.sep).join('/'));
  }
  return out;
}

/**
 * `e2e/` 下**不是命令**的那几个 .mjs（写死并带理由；`_` 前缀的助手由命名约定豁免）。
 *
 * 🔴 这张表的用途只有一个：让 `MAN.filesCovered` 能说"**e2e/ 下每个脚本都在清单里**"。
 *    没有它就只能靠"*-check.mjs 命名后缀"来猜，而历史命名并不统一
 *    （`packaged-smoke.mjs` / `e2e.mjs` / `lifespan-selftest.mjs` 都不带那个后缀）——
 *    靠猜的后果是：新加一个检查脚本而**忘了登记**，门全绿，命令却没人跑得起来。
 */
const NOT_A_COMMAND = new Map([
  ['e2e/run-checks.mjs', '分层聚合器（跑的是别的一堆命令，不派发自己）'],
  ['e2e/run-script.mjs', '清单派发器本体（`npm run task -- <id>` 的落地）'],
  ['e2e/service/llm-real-timing.mjs', '真 ③ 冷启动与内存实测：要真权重、人手跑一次，不进清单也不分层'],
]);

import { buildRegistry, TIER_ORDER } from './_check-registry.mjs';
import {
  CHECK_GROUPS,
  DISPATCH_SCRIPT,
  expandManifest,
  GROUP_ORDER,
  KEPT_SCRIPTS,
  keyOf,
  loadManifest,
  MANIFEST_PATH,
  NON_TIER_GROUPS,
  ROOT,
  scriptExists,
} from './_commands.mjs';

const REFUTE = process.argv.includes('--refute');
const PKG_PATH = path.join(ROOT, 'package.json');

/** `e2e/` 下**应当出现在清单里**的脚本：去掉 `_` 助手、聚合器与例外表 */
const SCRIPTS_ON_DISK = walkMjs(path.join(ROOT, 'e2e')).filter(
  (p) => !path.basename(p).startsWith('_') && !NOT_A_COMMAND.has(p),
);

/**
 * **各层条数写死并断言**（E4 计数门；AGENTS §2.3「断言条数要写死并断言」）。
 *
 * 为什么这不算形式主义：`run-checks.mjs` 按层分流，一条判据被**误删**、或 tier 被写错时，
 * 它只是"不在那一层里跑了" —— 输出依旧全绿，**没有任何一行会变红**。
 * 分子变绿、分母变小，正是"假绿"的标准形态；把分母钉住，减一条就得先改这个常量。
 *
 * 🔴 改这个常量时，请顺手确认 AGENTS.md §3 的条数也同步（`check:docs` 管不到那一节）。
 */
const EXPECTED_TIER_COUNTS = { static: 18, service: 45, nightly: 9, refute: 60 };

/**
 * 清单各分组条数写死（与上面的分层常量**分别写死**：一个写错不该让另一个跟着错）。
 * `supply` / `dev` 不是分层门，它们只需要"别丢、别串"。
 */
const EXPECTED_GROUP_COUNTS = { static: 18, service: 45, nightly: 9, supply: 10, dev: 3 };

/** (script,args) → 出现次数（两份列表都要先变成这张表，才能做双向覆盖） */
const keyCount = (list) => {
  const m = new Map();
  for (const e of list) m.set(keyOf(e), (m.get(keyOf(e)) ?? 0) + 1);
  return m;
};

function runAssertions(pkgScripts, entries, raw) {
  const cmds = expandManifest(raw);
  const base = cmds.filter((c) => c.derived === null);

  // ── 清单自身 ──────────────────────────────────────────────────────────
  const badShape = cmds.filter((c) => !c.script).map((c) => `${c.id}: ${c.cmd}`);
  const missingScript = cmds.filter((c) => c.script && !scriptExists(c.script)).map((c) => `${c.id}: ${c.script}`);
  const listedScripts = new Set(cmds.map((c) => c.script));
  const unlisted = SCRIPTS_ON_DISK.filter((p) => !listedScripts.has(p));
  const seen = new Set();
  const dupIds = [];
  for (const c of cmds) {
    if (seen.has(c.id)) dupIds.push(c.id);
    seen.add(c.id);
  }
  const explicitRefute = cmds.filter((c) => c.derived === null && c.id.endsWith(':refute')).map((c) => c.id);
  const gotGroupCounts = {};
  for (const g of GROUP_ORDER) gotGroupCounts[g] = 0;
  for (const c of base) gotGroupCounts[c.group] = (gotGroupCounts[c.group] ?? 0) + 1;
  const groupDiff = Object.keys(EXPECTED_GROUP_COUNTS)
    .filter((g) => (gotGroupCounts[g] ?? 0) !== EXPECTED_GROUP_COUNTS[g])
    .map((g) => `${g}: 实际 ${gotGroupCounts[g] ?? 0} ≠ 写死 ${EXPECTED_GROUP_COUNTS[g]}`);

  // ── package.json 的收束 ───────────────────────────────────────────────
  const pkgNames = Object.keys(pkgScripts).sort();
  const extraInPkg = pkgNames.filter((n) => !KEPT_SCRIPTS.includes(n));
  const missingInPkg = KEPT_SCRIPTS.filter((n) => !pkgNames.includes(n));

  // ── 清单 ↔ 注册表 ─────────────────────────────────────────────────────
  const regKeys = keyCount(entries);
  const cmdKeys = keyCount(cmds);
  const checkCmds = cmds.filter((c) => CHECK_GROUPS.includes(c.group));
  const uncoveredCmds = checkCmds
    .filter((c) => !regKeys.has(keyOf(c)))
    .map((c) => `${c.id} → ${c.script}${c.args.length ? ` ${c.args.join(' ')}` : ''}`);
  const orphanReg = entries
    .filter((e) => !cmdKeys.has(keyOf(e)))
    .map((e) => `${e.id} → ${e.script}${(e.args ?? []).length ? ` ${e.args.join(' ')}` : ''}`);
  const tierMismatch = [];
  for (const c of checkCmds) {
    const reg = entries.find((e) => keyOf(e) === keyOf(c));
    if (reg && reg.tier !== c.group) tierMismatch.push(`${c.id}: 清单 ${c.group} ≠ 注册表 ${reg.tier}`);
  }
  const nonTierOverlap = cmds
    .filter((c) => NON_TIER_GROUPS.includes(c.group) && regKeys.has(keyOf(c)))
    .map((c) => `${c.id}（${c.group}）在注册表里`);

  // ── 注册表自身 ────────────────────────────────────────────────────────
  const regMissing = entries.filter((e) => !scriptExists(e.script)).map((e) => `${e.id}: ${e.script}`);
  const badTier = entries.filter((e) => !TIER_ORDER.includes(e.tier)).map((e) => `${e.id}: tier=${e.tier}`);
  const regSeen = new Set();
  const regDups = [];
  for (const e of entries) {
    if (regSeen.has(e.id)) regDups.push(e.id);
    regSeen.add(e.id);
  }
  const gotTierCounts = {};
  for (const t of TIER_ORDER) gotTierCounts[t] = 0;
  for (const e of entries) gotTierCounts[e.tier] = (gotTierCounts[e.tier] ?? 0) + 1;
  const tierCountDiff = TIER_ORDER.filter((t) => (gotTierCounts[t] ?? 0) !== (EXPECTED_TIER_COUNTS[t] ?? 0)).map(
    (t) => `${t}: 实际 ${gotTierCounts[t] ?? 0} ≠ 写死 ${EXPECTED_TIER_COUNTS[t] ?? 0}`,
  );

  return [
    {
      id: 'MAN.cmdShape',
      label: '清单每条 cmd 都是 node 形态（`node <相对路径> [args…]`）',
      ok: badShape.length === 0,
      detail: badShape.length ? `非法形态：${badShape.join('；')}` : `${cmds.length} 条全部可解析`,
    },
    {
      id: 'MAN.scriptsExist',
      label: '清单每条指向的脚本真实存在',
      ok: missingScript.length === 0,
      detail: missingScript.length ? `缺失：${missingScript.join('；')}` : `${cmds.length} 条指向的文件都在`,
    },
    {
      id: 'MAN.filesCovered',
      label: 'e2e/ 下每个脚本都在清单里（新写一个检查却忘了登记 ⇒ 红，而不是"没人跑得起来"）',
      ok: unlisted.length === 0,
      detail: unlisted.length
        ? `没登记进清单：${unlisted.join('、')}（要么加进 e2eScripts.json，要么写进 registry-check.mjs 的 NOT_A_COMMAND 并给理由）`
        : `${SCRIPTS_ON_DISK.length} 个脚本全在清单里（另有 ${NOT_A_COMMAND.size} 个写死的非命令 + \`_\` 助手豁免）`,
    },
    {
      id: 'MAN.idsUnique',
      label: '清单 id 无重复（含派生的 :refute）',
      ok: dupIds.length === 0,
      detail: dupIds.length ? `重复：${[...new Set(dupIds)].join(',')}` : `${cmds.length} 个 id 互不重复`,
    },
    {
      id: 'MAN.refuteDerived',
      label: '反证轮只许派生：清单里不得手写 `:refute` 条目',
      ok: explicitRefute.length === 0,
      detail: explicitRefute.length
        ? `手写的反证条目：${explicitRefute.join(',')}（改为在基条目上写 refute: true）`
        : `派生 ${cmds.length - base.length} 条，均来自基条目的 refute: true`,
    },
    {
      id: 'MAN.groupCounts',
      label: '清单各分组条数 == 写死的常量（E4 计数门：减一条就得先改常量）',
      ok: groupDiff.length === 0,
      detail: groupDiff.length
        ? `分组条数不符：${groupDiff.join('；')}（改常量前先确认不是误删/误改分组）`
        : `static=${gotGroupCounts.static} service=${gotGroupCounts.service} nightly=${gotGroupCounts.nightly} supply=${gotGroupCounts.supply} dev=${gotGroupCounts.dev}（基条目 ${base.length} + 派生 ${cmds.length - base.length} = ${cmds.length}）`,
    },
    {
      id: 'PKG.kept',
      label: `package.json 只剩三类入口（恰好 ${KEPT_SCRIPTS.length} 条：代码校验 / 启停打包 / 测试入口）`,
      ok: extraInPkg.length === 0 && missingInPkg.length === 0,
      detail:
        extraInPkg.length || missingInPkg.length
          ? `不该在 package.json 里的：${extraInPkg.join(', ') || '无'}；缺失的入口：${missingInPkg.join(', ') || '无'}（其余命令一律进 e2eScripts.json，跑法 npm run ${DISPATCH_SCRIPT} -- <id>）`
          : `${pkgNames.length} 条入口，全部在白名单内`,
    },
    {
      id: 'REG.cmdsRegistered',
      label: '清单里每条检查都登记进注册表（script + args 逐项对上）',
      ok: uncoveredCmds.length === 0,
      detail: uncoveredCmds.length
        ? `未登记：${uncoveredCmds.join('；')}`
        : `${checkCmds.length} 条检查全部有对应注册项`,
    },
    {
      id: 'REG.registryCovered',
      label: '注册表每一项在清单里都有命令（反向覆盖：注册表有、命令没了 = 静默消失）',
      ok: orphanReg.length === 0,
      detail: orphanReg.length ? `清单里没有：${orphanReg.join('；')}` : `${entries.length} 个注册项都有对应命令`,
    },
    {
      id: 'REG.tierMatch',
      label: '同一 (script,args) 在清单与注册表里的分层一致',
      ok: tierMismatch.length === 0,
      detail: tierMismatch.length ? `分层不一致：${tierMismatch.join('；')}` : `${checkCmds.length} 条两侧分层一致`,
    },
    {
      id: 'REG.noNonTierOverlap',
      label: `非分层分组（${NON_TIER_GROUPS.join(' / ')}）不得混进注册表`,
      ok: nonTierOverlap.length === 0,
      detail: nonTierOverlap.length
        ? `混进来了：${nonTierOverlap.join('；')}（它们不是检查，不进任何分层门）`
        : `${NON_TIER_GROUPS.map((g) => `${g}=${gotGroupCounts[g]}`).join(' ')} 条都不在注册表里`,
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
      ok: regDups.length === 0,
      detail: regDups.length ? `重复：${[...new Set(regDups)].join(',')}` : `${entries.length} 个 id 互不重复`,
    },
    {
      id: 'REG.scriptsExist',
      label: '注册表每项的 script 文件真实存在',
      ok: regMissing.length === 0,
      detail: regMissing.length ? `缺失：${regMissing.join('；')}` : `${entries.length} 个注册项的文件都在`,
    },
    {
      id: 'REG.tierCounts',
      label: '注册表各层条数 == 写死的常量（E4 计数门：减一条就得先改常量，不会"全绿但少一块"）',
      ok: tierCountDiff.length === 0,
      detail: tierCountDiff.length
        ? `层条数不符：${tierCountDiff.join('；')}（改常量前先确认不是误删/误改 tier）`
        : `static=${gotTierCounts.static} service=${gotTierCounts.service} nightly=${gotTierCounts.nightly} refute=${gotTierCounts.refute}（共 ${entries.length}）`,
    },
  ];
}

// ------------------------------------------------------------------ 正向
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
const entries = buildRegistry();
const raw = loadManifest(MANIFEST_PATH);
const forward = runAssertions(pkg.scripts ?? {}, entries, raw);
const forwardOk = forward.every((r) => r.ok);

for (const r of forward) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.id} — ${r.label}\n      ${r.detail}`);
}

// ------------------------------------------------------------------ 反证
const clone = (o) => JSON.parse(JSON.stringify(o));

/** 取某一组的 cmds 数组（变异用） */
const grp = (m, g) => m.groups[g].cmds;

const MUTATIONS = [
  {
    id: 'M1',
    what: '清单里注入一条注册表没有的检查',
    apply: (scripts, list, m) => [
      scripts,
      list,
      inject(m, 'static', { id: 'check:zzz-fake', cmd: 'node e2e/zzz-fake-check.mjs', desc: '假的' }),
    ],
    expect: 'REG.cmdsRegistered',
  },
  {
    id: 'M2',
    what: '清单一条指向不存在的脚本',
    apply: (scripts, list, m) => [scripts, list, edit(m, 'static', 0, { cmd: 'node e2e/__nope__.mjs' })],
    expect: 'MAN.scriptsExist',
  },
  {
    id: 'M3',
    what: '清单一条 cmd 改成非 node 形态（npx / && 串接）',
    apply: (scripts, list, m) => [scripts, list, edit(m, 'static', 0, { cmd: 'npx eslint .' })],
    expect: 'MAN.cmdShape',
  },
  {
    id: 'M4',
    what: '复制一条（id 撞车）',
    apply: (scripts, list, m) => [scripts, list, inject(m, 'static', { ...grp(m, 'static')[0] })],
    expect: 'MAN.idsUnique',
  },
  {
    id: 'M5',
    what: '删掉一条基条目（分母悄悄变小 = 「全绿但少一块」）',
    apply: (scripts, list, m) => [scripts, list, dropFirst(m, 'static')],
    expect: 'MAN.groupCounts',
  },
  {
    id: 'M6',
    what: '手写一条 `:refute` 条目（两套机制并存）',
    apply: (scripts, list, m) => [
      scripts,
      list,
      inject(m, 'static', {
        id: 'check:units:refute',
        cmd: 'node e2e/units-structure-check.mjs --refute',
        desc: '手写的反证轮',
      }),
    ],
    expect: 'MAN.refuteDerived',
  },
  {
    id: 'M7',
    what: '`package.json` 加回一条 check（收束名存实亡）',
    apply: (scripts) => [{ ...scripts, 'check:units': 'node e2e/units-structure-check.mjs' }, entries, raw],
    expect: 'PKG.kept',
  },
  {
    id: 'M8',
    what: '注册表多一项（清单里没有对应命令）',
    apply: (scripts, list) => [
      scripts,
      [...list, { id: 'zzz-orphan', script: 'e2e/e2e.mjs', args: ['--nope'], tier: 'service' }],
      raw,
    ],
    expect: 'REG.registryCovered',
  },
  {
    id: 'M9',
    what: '清单把一条检查挪到别的层（注册表没跟）',
    apply: (scripts, list, m) => [scripts, list, moveFirst(m, 'static', 'service')],
    expect: 'REG.tierMatch',
  },
  {
    id: 'M10',
    what: '非分层分组里塞一条真检查（supply 混进分层门）',
    apply: (scripts, list, m) => [
      scripts,
      list,
      inject(m, 'supply', { id: 'check:units-dup', cmd: 'node e2e/units-structure-check.mjs', desc: '重复的真检查' }),
    ],
    expect: 'REG.noNonTierOverlap',
  },
  {
    id: 'M11',
    what: '注册表某项 tier 改成非法值',
    apply: (scripts, list) => [scripts, list.map((e, i) => (i === 0 ? { ...e, tier: 'bogus' } : e)), raw],
    expect: 'REG.tiersValid',
  },
  {
    id: 'M12',
    what: '注册表删掉一项（层条数变小）',
    apply: (scripts, list) => [scripts, list.slice(1), raw],
    expect: 'REG.tierCounts',
  },
  {
    id: 'M13',
    what: '清单删掉一条（等价于：e2e/ 下多了个脚本却没登记）',
    apply: (scripts, list, m) => [scripts, list, dropFirst(m, 'static')],
    expect: 'MAN.filesCovered',
  },
];

/** 往某组的 cmds 里插一条（返回新的清单对象，不改原对象） */
function inject(m, group, entry) {
  const c = clone(m);
  grp(c, group).push(entry);
  return c;
}

/** 改某组第 i 条（返回新的清单对象） */
function edit(m, group, i, patch) {
  const c = clone(m);
  grp(c, group)[i] = { ...grp(c, group)[i], ...patch };
  return c;
}

/** 删掉某组的第一条（返回新的清单对象） */
function dropFirst(m, group) {
  const c = clone(m);
  grp(c, group).shift();
  return c;
}

/** 把某组的第一条挪到另一组（返回新的清单对象） */
function moveFirst(m, from, to) {
  const c = clone(m);
  grp(c, to).push(grp(c, from).shift());
  return c;
}

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

  let allRed = true;
  for (const m of MUTATIONS) {
    const [mScripts, mEntries, mRaw] = m.apply(pkg.scripts ?? {}, entries, raw);
    const got = runAssertions(mScripts, mEntries, mRaw);
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
    `\n命令清单 ↔ 注册表：正向 ${pass} / ${forward.length}，反证 ${MUTATIONS.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`,
  );
  process.exit(forwardOk && allRed ? 0 : 1);
}

const pass = forward.filter((r) => r.ok).length;
console.log('\n[RESULT] ' + JSON.stringify({ results: forward, pass, fail: forward.length - pass }));
console.log(`\n命令清单 ↔ 注册表：${pass} / ${forward.length} 通过`);
process.exit(forwardOk ? 0 : 1);
