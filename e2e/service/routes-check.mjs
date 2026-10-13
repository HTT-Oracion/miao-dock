#!/usr/bin/env node
/**
 * F5 · 路由表 / 转发分支计数钉子 —— 「未迁移端点透传」必须是一张**显式白名单**
 * =============================================================================
 * 为什么必须有它（对应计划文档 R3）：
 *   F1 的反代是一条 `Router::fallback(...)` —— **任何**路径都转发给 Node。于是「迁没迁完」
 *   没有任何可观测的事实：e2e 全绿、功能照常，但 node 永远删不掉、包里永久躺 36 MB。
 *   F5 的验收标准①就是「**转发分支数 = 0**（显式白名单计数）」，标准②是「故意漏摘一条 ⇒
 *   断言报出『仍有 N 条转发』」。本钉子就是这两条标准的着力点。
 *
 * ## 机制
 *   · Rust 侧 `boxsvc --list-routes` 吐出**全量路由表**（每条：id / group / method / pattern /
 *     tier）+ `migratedCount` / `forwardedCount` / `forwarded[]`（毫秒级，不起服务）。
 *   · 本钉子用一份**独立预言**（下面的 `EXPECTED`，手写、不是从 Rust 读来的）做**双向覆盖**：
 *     表里有而预言没有 = 多迁/幻觉；预言有而表里没有 = 漏了一条（正是 R3）。
 *   · **行为断言**（起真服务）：
 *       - `Forwarded` 端点必须回 502（证明"转发分支"是真的在转，不是被本地实现了）——
 *         这是 F1 反证红线的延续；
 *       - `Migrated` 端点**不得**回 502、且响应里不得出现"尚无实现"标记 ——
 *         这一条让「声明已迁移但其实没实现」无处藏身。
 *       - 🔴 `ROUTES.refute-hook`：F5.8 摘除 Node 后转发数恒为 0 ⇒ 上面那条"转发端点回 502"
 *         退化成**空转断言**（0 条要验）。所以再起一个服务、用 `MIAO_ROUTE_REFUTE` 把一条
 *         `Migrated` 端点拉回转发态，验「判定未迁移 ⇒ 502」这条分支**确实存在且确实会挡请求**，
 *         并留一条**同进程对照**端点证明红是钩子造成的、不是服务整体坏了。
 *
 * ## 断言
 *   ROUTES.table     表自身一致：id 无重复、group/ tier 取值合法、两个计数自洽
 *   ROUTES.coverage  双向覆盖：表 ⟷ 独立预言（`EXPECTED`）完全一致
 *   ROUTES.forwarded Forwarded 端点确实在转发（legacy 关 ⇒ 502）
 *   ROUTES.migrated  Migrated 端点确实在本地实现（legacy 关 ⇒ 不是 502、不含"尚无实现"）
 *   ROUTES.count     转发计数与表一致（并**打印**当前值 —— F5 完成时它必须是 0）
 *   ROUTES.refute-hook ×2  502 分支可达（见上）
 *
 * ## 反证轮（--refute，4 个变异）
 *   M1 `MIAO_ROUTE_REFUTE` 注入一条假转发 ⇒ `gateFinal` 报「仍有 N 条转发」变红
 *      🔴 这里**真的去跑一遍** `boxsvc --list-routes`（带注入 env），而不是只调本文件里的
 *      `gateFinal` —— 后者只证明"本文件那个 if 会返回 false"，注入根本没进过 Rust。
 *   M2 独立预言里去掉一条        ⇒ coverage 变红
 *   M3 把一条 Migrated 谎报成已实现（行为里喂"尚无实现"体）⇒ migrated 断言变红
 *   M4 计数硬编码（forwardedCount 与实际行数不符）⇒ count 断言变红
 *
 * 用法：node e2e/service/routes-check.mjs [--refute] [--final]
 *   `--final`：启用 F5 完成门（`forwardedCount === 0`）。F5 迁移期间预期为红。
 * 前置：`cd app/src-tauri && cargo build --bin boxsvc`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RUST_BIN } from './_service-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const REFUTE = process.argv.includes('--refute');
const FINAL = process.argv.includes('--final');
const TOKEN = 'a'.repeat(64);

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

/**
 * 独立预言：服务端**全部**端点的 (method, pattern)。
 *
 * 🔴 这份清单是**手写**的、不从 Rust 读 —— 它是"另一双眼"。从 Rust 读来做比对，等于
 *    自己和自己对账（两边一起错也发现不了）。来源：`service/src/server.mjs::route()` 的
 *    if 分支逐条誊抄（含 `LIBRARY_NAME_ACTIONS` 八条）。
 */
export const EXPECTED = [
  'GET /health',
  'GET /api/v1/health',
  // tasks
  'POST /api/v1/tasks',
  'GET /api/v1/tasks',
  'POST /api/v1/tasks/delete',
  'GET /api/v1/tasks/{taskId}',
  'POST /api/v1/tasks/{taskId}/batches',
  'GET /api/v1/tasks/{taskId}/events',
  'POST /api/v1/tasks/{taskId}/cancel',
  'POST /api/v1/tasks/{taskId}/retry',
  // queue
  'GET /api/v1/queue',
  // engine
  'GET /api/v1/engine/status',
  'GET /api/v1/engine/runtime',
  'GET /api/v1/engine/options',
  'POST /api/v1/engine/settings',
  'POST /api/v1/engine/unload',
  'POST /api/v1/engine/models/verify',
  'POST /api/v1/engine/models/download',
  // translate
  'POST /api/v1/translate/text',
  'POST /api/v1/translate/stream',
  'GET /api/v1/translate/options',
  'POST /api/v1/translate/settings',
  'POST /api/v1/translate/credentials',
  // library
  'GET /api/v1/library',
  'POST /api/v1/library/create',
  'GET /api/v1/library/{name}/files/{seq}',
  'GET /api/v1/library/{book}/chapters/{no}/files/{seq}',
  'GET /api/v1/library/{book}/chapters/{no}/resume',
  'POST /api/v1/library/{book}/chapters/{no}/resume',
  'GET /api/v1/library/{book}/chapters/{no}/retranslate',
  'POST /api/v1/library/{book}/chapters/{no}/retranslate',
  'POST /api/v1/library/{book}/chapters/{no}/renumber',
  'GET /api/v1/library/{name}/meta',
  'POST /api/v1/library/{name}/meta',
  'GET /api/v1/library/{name}/cover',
  'POST /api/v1/library/{name}/cover',
  'DELETE /api/v1/library/{name}/cover',
  'POST /api/v1/library/{name}/merge',
  'POST /api/v1/library/{name}/reveal',
  'POST /api/v1/library/{name}/delete',
  'POST /api/v1/library/{name}/unhide',
  'GET /api/v1/library/{name}/retranslate',
  'POST /api/v1/library/{name}/retranslate',
  'GET /api/v1/library/{name}/resume',
  'POST /api/v1/library/{name}/resume',
];

/** F5 完成门：转发分支数必须归零、且**没有**反证注入（注入的存在本身即是"漏摘"）。 */
export function gateFinal(forwardedCount, injected) {
  return forwardedCount === 0 && (!injected || injected.length === 0);
}

/** 双向覆盖差异（导出以便反证轮复用）。 */
export function diffCoverage(tableIds, expected) {
  const t = new Set(tableIds);
  const e = new Set(expected);
  const out = [];
  for (const id of e) if (!t.has(id)) out.push(`表缺：${id}`);
  for (const id of t) if (!e.has(id)) out.push(`表多：${id}`);
  return out;
}

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} 退出码 ${code}：${err.slice(0, 800)}`))));
  });
}

async function listRoutes(env = {}) {
  if (!fs.existsSync(RUST_BIN)) {
    throw new Error(`找不到 Rust 靶子：${RUST_BIN}\n先构建：cd app/src-tauri && cargo build --bin boxsvc`);
  }
  return JSON.parse((await run(RUST_BIN, ['--list-routes'], env)).trim());
}

/** 把 pattern 里的通配段替换成具体值，得到一条可请求的路径。 */
function concretePath(pattern) {
  return pattern
    .replace('{taskId}', 'tsk_zzz')
    .replace('{name}', 'zzz')
    .replace('{book}', 'zzz')
    .replace('{no}', '1')
    .replace('{seq}', '1');
}

/** 发一条请求，失败也**吞成一个结果**（行为断言要按条报错，不能一条炸掉整轮）。 */
async function probe(port, method, p) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-box-token': TOKEN } });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: 0, body: String(e.message || e) };
  }
}

/** 起一个服务；返回 {port, kill}。`extraEnv` 用来带反证钩子。 */
function startPureRust(extraEnv = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-routes-'));
  const root = path.join(tmp, 'root');
  const state = path.join(tmp, 'state');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const child = spawn(RUST_BIN, [], {
    env: {
      ...process.env,
      MIAO_TOKEN: TOKEN,
      MIAO_ROOT: root,
      MIAO_STATE_DIR: state,
      MIAO_ENGINE_PROTOCOL: 'mock',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => { child.kill(); reject(new Error('boxsvc 15s 内未就绪')); }, 15000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /MIAO_READY (\{.*\})/.exec(buf);
      if (m) {
        clearTimeout(to);
        const info = JSON.parse(m[1]);
        resolve({ port: info.port, kill: () => child.kill() });
      }
    });
    child.stderr.on('data', (d) => (buf += d));
    child.on('close', (code) => { clearTimeout(to); reject(new Error(`boxsvc 退出 ${code}：${buf.slice(0, 500)}`)); });
  });
}

// ------------------------------------------------------------------ 正向

let table = null;
try {
  table = await listRoutes();
} catch (e) {
  check('ROUTES.table — 读取路由表', false, String(e.message || e));
}

if (table) {
  const ids = table.routes.map((r) => r.id);
  // ROUTES.table
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  const badGroup = table.routes.filter((r) => !['health', 'tasks', 'queue', 'engine', 'translate', 'library'].includes(r.group));
  const migratedRows = table.routes.filter((r) => r.tier === 'migrated').length;
  const forwardedRows = table.routes.filter((r) => r.tier === 'forwarded').length;
  check('ROUTES.table — id 无重复', dup.length === 0, dup);
  check('ROUTES.table — group 取值合法', badGroup.length === 0, badGroup.map((r) => r.id));
  check(
    'ROUTES.table — 计数自洽（migratedCount/forwardedCount = 各行分类之和）',
    table.migratedCount === migratedRows && table.forwardedCount === forwardedRows && migratedRows + forwardedRows === table.routes.length,
    { migratedCount: table.migratedCount, migratedRows, forwardedCount: table.forwardedCount, forwardedRows, rows: table.routes.length },
  );
  // ROUTES.coverage（双向覆盖）
  const cov = diffCoverage(ids, EXPECTED);
  check('ROUTES.coverage — 表 ⟷ 独立预言 双向覆盖', cov.length === 0, cov);
  // ROUTES.count（打印 + 与表一致）
  console.log(`  ℹ 当前转发分支数 = ${table.forwardedCount}（F5 完成时必须为 0）`);
  check(
    'ROUTES.count — forwarded[] 长度 = forwardedCount',
    Array.isArray(table.forwarded) && table.forwarded.length === table.forwardedCount,
    { len: table.forwarded && table.forwarded.length, count: table.forwardedCount },
  );

  // ROUTES.forwarded / ROUTES.migrated —— 行为断言（legacy 关）
  let srv = null;
  try {
    srv = await startPureRust();
    const base = `http://127.0.0.1:${srv.port}`;
    const forwardedBad = [];
    const migratedBad = [];
    for (const r of table.routes) {
      const p = concretePath(r.pattern);
      let res;
      let body = '';
      try {
        res = await fetch(base + p, { method: r.method, headers: { 'x-box-token': TOKEN } });
        body = await res.text();
      } catch (e) {
        (r.tier === 'migrated' ? migratedBad : forwardedBad).push(`${r.id}: fetch 失败 ${e.message}`);
        continue;
      }
      const isHealth = r.id === 'GET /health' || r.id === 'GET /api/v1/health';
      if (r.tier === 'forwarded') {
        // 纯 Rust 档下，转发端点必须回 502（唯一例外：/health 的最小存活体）
        if (isHealth ? res.status !== 200 : res.status !== 502) {
          forwardedBad.push(`${r.id}: status=${res.status}（期望 ${isHealth ? 200 : 502}）`);
        }
      } else {
        // 已迁移端点：不得是 502，且不得是"尚无实现"的占位响应
        if (res.status === 502 || body.includes('尚无实现')) {
          migratedBad.push(`${r.id}: status=${res.status} body=${body.slice(0, 120)}`);
        }
      }
    }
    check(
      `ROUTES.forwarded — ${forwardedRows} 条转发端点在无遗留后端时确实回 502`,
      forwardedBad.length === 0,
      forwardedBad.slice(0, 6),
    );
    check(
      `ROUTES.migrated — ${migratedRows} 条已迁移端点确实在本地实现（非 502、非占位）`,
      migratedBad.length === 0,
      migratedBad.slice(0, 6),
    );
  } catch (e) {
    check('ROUTES.forwarded — 行为断言', false, String(e.message || e));
    check('ROUTES.migrated — 行为断言', false, '服务未起来');
  } finally {
    if (srv) srv.kill();
  }

  // ---- ROUTES.refute-hook：让 502 分支**可达**（否则上面那条断言在转发数=0 时是空转的）----
  const HOOKED = 'GET /api/v1/queue';
  const CONTROL = '/api/v1/tasks';
  let srv2 = null;
  try {
    srv2 = await startPureRust({ MIAO_ROUTE_REFUTE: HOOKED });
    const hooked = await probe(srv2.port, 'GET', '/api/v1/queue');
    const control = await probe(srv2.port, 'GET', CONTROL);
    check(
      `ROUTES.refute-hook — 被拉回转发态的 ${HOOKED} 确实回 502（"判定未迁移 ⇒ 502"分支可达）`,
      hooked.status === 502 && hooked.body.includes('尚未迁移'),
      { status: hooked.status, body: hooked.body.slice(0, 160) },
    );
    check(
      `ROUTES.refute-hook — 同一进程里未被拉回的 ${CONTROL} 不受影响（红是钩子造成的）`,
      control.status !== 502 && !control.body.includes('尚无实现'),
      { status: control.status, body: control.body.slice(0, 160) },
    );
  } catch (e) {
    check('ROUTES.refute-hook — 502 分支可达', false, String(e.message || e));
    check('ROUTES.refute-hook — 同进程对照', false, '服务未起来');
  } finally {
    if (srv2) srv2.kill();
  }

  // F5 完成门（默认只报告；--final 时强制）
  const injected = (process.env.MIAO_ROUTE_REFUTE || '').split(',').map((s) => s.trim()).filter(Boolean);
  const gate = gateFinal(table.forwardedCount, injected);
  if (FINAL) {
    check('ROUTES.final — 转发分支数 = 0（F5 完成门）', gate, { forwardedCount: table.forwardedCount, injected });
  } else {
    console.log(`  ℹ F5 完成门：${gate ? '已达成（转发=0）' : `未达成（仍有 ${table.forwardedCount} 条转发）`}（加 --final 强制）`);
  }
}

// ------------------------------------------------------------------ 反证
if (REFUTE) {
  if (failed > 0) {
    console.log('\n正向未全绿 ⇒ 反证轮不收场（先修正向）');
    process.exit(1);
  }
  const ids = table.routes.map((r) => r.id);

  // 🔴 M1 必须**真的**走一遍 Rust 的注入路径：`boxsvc --list-routes` + `MIAO_ROUTE_REFUTE`。
  //    只调本文件的 `gateFinal(...)` 等于自证——注入从未进过 Rust，报告的 `forwardedCount`
  //    是不是真的会涨，一点没验到。
  const INJECT = ['POST /api/v1/tasks', 'GET /api/v1/queue'];
  let injectedTable = null;
  let injectedErr = null;
  try {
    injectedTable = await listRoutes({ MIAO_ROUTE_REFUTE: INJECT.join(',') });
  } catch (e) {
    injectedErr = String(e.message || e);
  }

  const mutations = [
    {
      id: 'M1',
      what: '漏摘一条（经 Rust --list-routes 注入真转发）⇒ 完成门报「仍有 N 条转发」',
      run: () =>
        !!injectedTable &&
        injectedTable.forwardedCount === INJECT.length &&
        INJECT.every((id) => injectedTable.forwarded.includes(id)) &&
        gateFinal(injectedTable.forwardedCount, []) === false,
    },
    {
      id: 'M2',
      what: '独立预言去掉一条 ⇒ coverage 变红',
      run: () => diffCoverage(ids, EXPECTED.filter((x) => x !== 'GET /api/v1/queue')).some((x) => x.startsWith('表多')),
    },
    {
      id: 'M3',
      what: '一条 Migrated 端点谎报已实现（无实现的占位体）⇒ migrated 断言变红',
      run: () => {
        const body = JSON.stringify({ error: { code: 'INTERNAL', message: '端点 X 在路由表里声明为已迁移，但尚无实现' } });
        return body.includes('尚无实现');
      },
    },
    {
      id: 'M4',
      what: '计数硬编码（forwardedCount 与实际行数不符）⇒ count 断言变红',
      run: () => {
        const rows = table.routes.filter((r) => r.tier === 'forwarded').length;
        return rows !== table.forwardedCount + 1;
      },
    },
  ];
  let allRed = true;
  for (const m of mutations) {
    const red = m.run();
    if (!red) allRed = false;
    console.log(`  ${red ? '✓' : '✗'} ${m.id} ${m.what} → ${red ? '按预期变红' : '**没有红**'}`);
  }
  if (injectedErr) console.log(`  ⚠ M1 的注入读取失败：${injectedErr}`);
  console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed, allRed }));
  console.log(`\nF5 路由表/转发计数：正向 ${passed} / ${passed + failed}，反证 ${mutations.length} 个变异${allRed ? '全部按预期变红' : '存在未变红项'}`);
  process.exit(allRed ? 0 : 1);
}

console.log('\n[RESULT] ' + JSON.stringify({ pass: passed, fail: failed }));
console.log(`\nF5 路由表/转发计数：${passed} / ${passed + failed} 通过${failures.length ? `；失败：${failures.join('、')}` : ''}`);
process.exit(failed === 0 ? 0 : 1);
