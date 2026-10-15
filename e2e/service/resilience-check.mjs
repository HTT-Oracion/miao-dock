#!/usr/bin/env node
/**
 * box-service **健壮性钉子** —— 且必须可反证
 * ================================================================
 * ## A 组 · 任务状态原子写（D-139）
 *   A1 `store.rs::persist_task` 的任务状态落盘走 `atomic_write_json`，**不裸写**。
 *      裸写崩在中间留半截 JSON ⇒ 启动读到损坏文件**静默跳过该任务**（丢历史，正常退出测不到）。
 *   A2 `atomic_write_text` 确实是 tmp → **fsync** → rename（缺 fsync 则断电后 rename 可能指向空内容）。
 *
 * ## R 组（顶层异常兜底）已**退役** —— 随 Node 服务实现一并删除
 *   原 R1–R7 断言的是 `service/src/server.mjs` 的 `process.on('unhandledRejection')` /
 *   `process.on('uncaughtException')` / 信号处理器 / `shutdown()` 重入闸 / `llm.stop()` 等
 *   **Node 进程级**兜底结构。Rust 侧没有这个形态：
 *     · Rust 的 panic 默认**不会**带走整个进程（除非 `panic = "abort"`，本 crate 未设）；
 *     · 「宿主死了别留孤儿」在 Rust 侧由**父死看守**承担，且已有三组专门的门在钉：
 *       `check:child-watch` · `check:child-watch-kill` · `check:drain-runtime`
 *       （外加 `check:lifespan` / `e11` 的孤儿回收用例）。
 *   ⇒ 把 R 组"搬"成 Rust 源码变异等于**新造**一条此前不存在的轨（D-204 第四节的减法纪律：
 *   只在该轨本来就在跑时才谈退役，本来不在跑的搬过去才是加法）。故删除，不搬。
 *
 * ## 判据形态：纯函数 `evaluate(src)`
 *   接收源码文本 → 返回断言结果；反证轮把**内存变异**后的文本喂进来跑同一套判据，
 *   **不碰工作区、不起进程、不需要 cargo build**（范式取自 `engine-patches-check.mjs`）。
 *
 * ⚠️ 边界，别误读：A 组证明的是**"写路径是原子的"**，不是"真断过一次电"。
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
/// 🔴 唯一事实源：Rust 侧的 store（`service/src/manga/store.mjs` 已随 Node 服务实现删除）。
const STORE_RS = path.join(ROOT, 'app', 'src-tauri', 'src', 'boxsvc', 'store.rs');
const REFUTE = process.argv.includes('--refute');

/** 取某函数体的源码段：自 `marker` 起，到下一个 `stopAt`（或文件末） */
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
 * 反证轮把变异后的文本喂进来跑同一套判据 —— 判据与"读盘"解耦，才测得住。
 */
function evaluate({ store }) {
  const out = [];
  const add = (id, label, ok, detail) =>
    out.push({ id, label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

  // ---- A 组：任务状态原子写（Rust）----
  const persist = sliceFrom(store, 'pub(crate) fn persist_task(', '\n// ---');
  add(
    'A1',
    'store 任务状态落盘走 atomic_write_json（不裸写）',
    persist.includes('atomic_write_json(&file, &record_of(task))') && !/fs::write\(/.test(persist),
    persist
      ? `atomic=${persist.includes('atomic_write_json(&file, &record_of(task))')} bare=${/fs::write\(/.test(persist)}`
      : '未找到 persist_task',
  );

  const atomic = sliceFrom(store, 'pub fn atomic_write_text(', 'pub(crate) fn atomic_is_direct');
  add(
    'A2',
    'atomic_write_text 是 tmp → fsync → rename',
    atomic.includes('f.sync_all()?;') && atomic.includes('std::fs::rename(&tmp, file)?;'),
    atomic
      ? `fsync=${atomic.includes('f.sync_all()?;')} rename=${atomic.includes('std::fs::rename(&tmp, file)?;')}`
      : '未找到 atomic_write_text',
  );

  return out;
}

function printResults(rows) {
  console.log('\n【box-service 健壮性钉子】');
  let fail = 0;
  for (const r of rows) {
    if (!r.ok) fail++;
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.id} ${r.label}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log('\n' + '─'.repeat(56));
  console.log(`通过 ${rows.length - fail} / 失败 ${fail}`);
  return fail;
}

const SRC = () => ({ store: fs.readFileSync(STORE_RS, 'utf8') });

/// 每条变异 = 把结构改回缺陷形态（内存变异），并声明哪些断言必须变红。
/// `target` 指明改的是哪份源码。
const MUTATIONS = [
  {
    name: 'M1 persist_task 退回裸写（崩在中间留半截 JSON）',
    target: 'store',
    apply: (s) =>
      s.replace(
        '    let _ = atomic_write_json(&file, &record_of(task));',
        '    let _ = std::fs::write(&file, serde_json::to_vec(&record_of(task)).unwrap_or_default());',
      ),
    expect: ['A1'],
  },
  {
    name: 'M2 atomic_write_text 去掉 fsync（rename 可能指向未落盘内容）',
    target: 'store',
    apply: (s) => s.replace('        f.sync_all()?;', '        // no fsync'),
    expect: ['A2'],
  },
  {
    name: 'M3 atomic_write_text 去掉 rename（退回原地写）',
    target: 'store',
    apply: (s) => s.replace('        std::fs::rename(&tmp, file)?;', '        std::fs::write(file, text)?;'),
    expect: ['A2'],
  },
];

const main = () => {
  console.log(`box-service 健壮性钉子${REFUTE ? ' · 反证轮' : ''}`);
  const src = SRC();

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
    const mutated = { ...src, [mut.target]: mut.apply(src[mut.target]) };
    if (mutated[mut.target] === src[mut.target]) {
      console.log(`⚠ ${mut.name}\n    变异锚点未命中（源码已改？）—— 本条无法反证`);
      skipped += mut.expect.length;
      continue;
    }
    const byId = {};
    for (const r of evaluate(mutated)) byId[r.id] = r;

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
