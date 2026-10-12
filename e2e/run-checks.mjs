#!/usr/bin/env node
/**
 * 自测聚合 runner —— 用一条命令跑分层自测，替代逐个 `npm run check:X`。
 *
 * ## 为什么需要它（自测慢的根因，实测数据 2026-10-13）
 * 全量自测约 35 个正跑 + 28 个反证轮，逐个手敲命令有三个问题：
 *   ① 没有「快闸门」——改一行 UI 也要等 7 分钟的全量；
 *   ② 没有「只跑相关的」——只碰 service/src 却要连 music 静态检查一起等；
 *   ③ 反证轮与正跑混在一起——反证轮是「断言自身能否被反证打红」的元验证，
 *      单 music 一条就 21.5s，全部跑是日常开发的纯浪费。
 * 实测耗时（本机，Windows）：静态组合计 27s（并行后 ~12s）；service 组合计 ~405s；
 * 其中 lib-manage 47s / e2e D1-D5 164s / svc-selftest 60s / e5e6 36s / translate 25s。
 *
 * ## 注册表在哪
 * 分层 / watch / 反证派生都在 `_check-registry.mjs`（数据），本文件只做执行与报告。
 * 「npm 有新检查脚本却忘了登记」由 `registry-check.mjs` 双向覆盖断言把守
 * （该红没红的典型：静默消失在分层之外）。
 *
 * ## 分层模型
 *   static   纯文件/正则分析，不起进程、不占端口 → 8 路并行
 *   service  起真实 engine/service 子进程、真实落盘 → **串行**
 *   nightly  接真实引擎/模型（分钟级）→ 串行
 *   refute   反证轮（--refute，元验证）→ 串行，默认不在任何日常闸门里
 *
 * 🔴 service 层为什么必须串行：各脚本用 findFreePort 从**固定且互相重叠的区间**
 * （5300–5800）「先探测再绑定」拿端口。并行时两个脚本可能同时探到同一端口空闲、
 * 随后都去 bind——轻则起不来，重则 A 的请求打到 B 的服务上，**产出交叉污染的
 * 假结果**。这不是性能问题，是正确性问题：宁慢，不串。
 *
 * ## --changed 的语义与假绿防范
 * 按 git 变更文件与每个检查的 watch glob 求交，只跑相关的。
 * 防假绿三条纪律：
 *   ① git 不可用 / 解析失败 / 无变更 → **全跑**（保守默认，绝不静默缩范围）；
 *   ② 每个被跳过的检查都在输出里显式列出（SKIP 行 + 汇总），
 *      「跑了几条」永远可见，不会假装全量过；
 *   ③ 单个检查超时按**失败**计（TIMEOUT），不按跳过计。
 * 🔴 --only 显式点名时**跨层选取**（忽略 --tier）：否则 `--only patches`
 * （service 层）在默认 static 层下会被静默滤掉 → 跑了个空却显示「通过」。
 *
 * ## 用法
 *   node e2e/run-checks.mjs                       # = static 快闸门（默认）
 *   node e2e/run-checks.mjs --tier static,service # 快闸门 + 服务层
 *   node e2e/run-checks.mjs --tier all            # 全量（含 nightly + 全部反证轮）
 *   node e2e/run-checks.mjs --changed             # 只跑与当前 git 变更相关的
 *   node e2e/run-checks.mjs --changed --base origin/v2.2.0  # 按与基线分支的差异过滤
 *   node e2e/run-checks.mjs --only units,music    # 只跑指定 id（跨层）
 *   node e2e/run-checks.mjs --list                # 打印注册表（分层 + watch）
 *   node e2e/run-checks.mjs --jobs 4              # static 层并行度（默认 8）
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import { buildRegistry, TIER_CONCURRENCY, TIER_ORDER, TIER_TIMEOUT_MS } from './_check-registry.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE = process.execPath;
const CHECKS = buildRegistry();

// ------------------------------------------------------------------ glob 匹配
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'; // **/ = 零或多层目录
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function matchAny(file, globs) {
  if (!globs || globs.length === 0) return true; // 无 watch 声明 = 恒跑
  return globs.some((g) => globToRe(g).test(file));
}

// ------------------------------------------------------------------ git 变更
/**
 * 捕获子进程输出（git 查询用）。
 * 🔴 必须用异步 spawn 而不是 execFileSync：本环境（Windows + 沙箱）下**同步 spawn
 * 直接 EBUSY**（实测 2026-10-13），而异步 spawn 正常——跑自测的子进程也全是异步起的。
 * 返回 stdout 文本；任何失败（ENOENT / 非零退出 / 超时）返回 null。
 */
function capture(cmd, args, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (b) => {
      out += b.toString('utf8');
    });
    child.stderr.on('data', (b) => {
      err += b.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

/** 取变更文件集合；git 不可用/解析失败返回 null（调用方按「全跑」处理） */
async function changedFiles(base) {
  const out = base
    ? await capture('git', ['diff', '--name-only', base])
    : await capture('git', ['status', '--porcelain']);
  if (out === null) return null;
  const files = new Set();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let p = line.slice(3).trim();
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4); // 重命名取新路径
    files.add(p.replace(/^"(.*)"$/, '$1'));
  }
  return files;
}

// ------------------------------------------------------------------ 执行
function runCheck(check, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let timedOut = false;
    const child = spawn(NODE, [check.script, ...(check.args ?? [])], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (b) => {
      out += b.toString('utf8');
      if (out.length > 4_000_000) out = out.slice(-2_000_000); // 防日志爆内存
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ check, ok: false, code: -1, ms: Date.now() - t0, out: `${out}\n[spawn error] ${err.message}`, timedOut });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ check, ok: code === 0 && !timedOut, code, signal, ms: Date.now() - t0, out, timedOut });
    });
  });
}

async function runPool(items, jobs, timeoutMs, onDone) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(jobs, queue.length)) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      const r = await runCheck(item, timeoutMs);
      onDone(r);
    }
  });
  await Promise.all(workers);
}

// ------------------------------------------------------------------ CLI
function parseArgv(argv) {
  const opt = { tiers: ['static'], changed: false, only: null, jobs: 8, base: null, list: false, timeout: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tier') opt.tiers = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--changed') opt.changed = true;
    else if (a === '--only') opt.only = new Set(argv[++i].split(',').map((s) => s.trim()));
    else if (a === '--jobs') opt.jobs = Math.max(1, Number.parseInt(argv[++i], 10) || 1);
    else if (a === '--base') opt.base = argv[++i];
    else if (a === '--list') opt.list = true;
    else if (a === '--timeout') opt.timeout = Number.parseInt(argv[++i], 10) * 1000;
    else if (a === '--help' || a === '-h') opt.help = true;
    else throw new Error(`未知参数：${a}（--help 看用法）`);
  }
  return opt;
}

const pad = (s, n) => String(s).padEnd(n);
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

function printList(entries) {
  const w = Math.max(...entries.map((c) => c.id.length));
  for (const c of entries) {
    console.log(`${pad(c.id, w)}  ${pad(c.tier, 8)}  ${c.script}${c.args ? ` ${c.args.join(' ')}` : ''}`);
    if (c.watch?.length) console.log(`${' '.repeat(w)}  watch: ${c.watch.join('  ')}`);
  }
  console.log(`\n共 ${entries.length} 项（正跑 ${CHECKS.filter((c) => c.tier !== 'refute').length} + 反证轮 ${CHECKS.filter((c) => c.tier === 'refute').length}）`);
}

// ------------------------------------------------------------------ 主流程
const opt = parseArgv(process.argv.slice(2));
if (opt.help) {
  console.log('用法：node e2e/run-checks.mjs [--tier static,service,nightly,refute,all] [--changed [--base <ref>]] [--only id1,id2] [--jobs N] [--list] [--timeout 秒]');
  process.exit(0);
}

if (opt.tiers.includes('all')) opt.tiers = [...TIER_ORDER];
for (const t of opt.tiers) {
  if (!TIER_ORDER.includes(t)) {
    console.error(`未知层：${t}（可选 ${TIER_ORDER.join(' / ')} / all）`);
    process.exit(2);
  }
}

let entries = CHECKS.filter((c) => opt.tiers.includes(c.tier));
if (opt.only) {
  const missing = [...opt.only].filter((id) => !CHECKS.some((c) => c.id === id));
  if (missing.length) {
    console.error(`未知检查 id：${missing.join(', ')}（--list 看全部）`);
    process.exit(2);
  }
  // 🔴 --only 显式点名时**跨层选取**（忽略 --tier 过滤）：否则 `--only patches`
  // （patches 在 service 层）在默认 static 层下会被静默滤掉 → 跑了个空却显示
  // 「通过 1/1」—— 这是本工具自己的假绿，必须堵死。
  entries = CHECKS.filter((c) => opt.only.has(c.id));
}
if (opt.list) {
  printList(entries);
  process.exit(0);
}

// --changed 过滤：git 不可用 → 全跑（保守默认，不静默缩范围）
let skipped = [];
if (opt.changed) {
  const changed = await changedFiles(opt.base);
  if (changed === null) {
    console.log('⚠️ 取 git 变更失败（不在仓库内或 git 不可用）→ 按全量运行（不缩范围）\n');
  } else if (changed.size === 0) {
    console.log('工作区没有变更 → 按全量运行（不缩范围）\n');
  } else {
    console.log(`git 变更 ${changed.size} 个文件${opt.base ? `（对比 ${opt.base}）` : ''}：`);
    for (const f of [...changed].slice(0, 20)) console.log(`  ${f}`);
    if (changed.size > 20) console.log(`  …等 ${changed.size - 20} 个`);
    const keep = [];
    skipped = [];
    for (const c of entries) {
      if ([...changed].some((f) => matchAny(f, c.watch))) keep.push(c);
      else skipped.push(c);
    }
    entries = keep;
    console.log('');
  }
}

if (entries.length === 0) {
  console.log('没有需要运行的检查（--list 看注册表）。');
  process.exit(0);
}

console.log(`计划运行 ${entries.length} 项${skipped.length ? `，跳过 ${skipped.length} 项（--changed）` : ''}：`);
for (const c of entries) console.log(`  ${pad(c.tier, 8)} ${c.id}`);
if (skipped.length) {
  console.log(`\n跳过的检查（未被 --changed 命中，未验证它们）：`);
  for (const c of skipped) console.log(`  ${pad(c.tier, 8)} ${c.id}`);
}
console.log('');

const t0 = Date.now();
const results = [];
for (const tier of TIER_ORDER) {
  const inTier = entries.filter((c) => c.tier === tier);
  if (inTier.length === 0) continue;
  const jobs = tier === 'static' ? opt.jobs : TIER_CONCURRENCY[tier];
  const timeoutMs = opt.timeout ?? TIER_TIMEOUT_MS[tier];
  console.log(`── ${tier} 层：${inTier.length} 项，并行度 ${jobs}${jobs > 1 ? '' : '（串行：端口竞争，见 run-checks.mjs 文件头）'} ──`);
  // eslint-disable-next-line no-await-in-loop
  await runPool(inTier, jobs, timeoutMs, (r) => {
    results.push(r);
    const mark = r.ok ? '✓' : '✗';
    const tail = r.timedOut ? ' TIMEOUT' : '';
    console.log(`  ${mark} ${pad(r.check.id, 22)} ${pad(secs(r.ms), 9)}${tail}`);
  });
}

// ------------------------------------------------------------------ 汇总
const failed = results.filter((r) => !r.ok);
const passed = results.length - failed.length;
console.log('\n════════ 汇总 ════════');
console.log(`通过 ${passed} / ${results.length}，总耗时 ${secs(Date.now() - t0)}${skipped.length ? `，跳过 ${skipped.length}` : ''}`);
if (results.length) {
  const w = Math.max(...results.map((r) => r.check.id.length));
  console.log('\n按耗时降序：');
  for (const r of [...results].sort((a, b) => b.ms - a.ms)) {
    console.log(`  ${pad(r.check.id, w)}  ${pad(secs(r.ms), 9)}  ${r.ok ? 'pass' : `FAIL(${r.timedOut ? 'timeout' : r.code})`}`);
  }
}
for (const r of failed) {
  const lines = r.out.replace(/\s+$/, '').split('\n');
  const TAIL = 40;
  console.log(`\n──── ${r.check.id} 输出尾部（共 ${lines.length} 行）────`);
  console.log(lines.slice(-TAIL).join('\n'));
}
if (skipped.length) {
  console.log('\n⚠️ 本次跳过了上面列出的检查——通过 ≠ 全量通过。合并前请跑 --tier all 或去掉 --changed。');
}
process.exit(failed.length ? 1 : 0);
