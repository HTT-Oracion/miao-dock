#!/usr/bin/env node
/**
 * F3-b store **执行态** 报告的归一化 —— golden 生成器与对拍脚本**共用的唯一一份**规则。
 * =============================================================================
 * 为什么单独一个文件：F5 摘除 Node 后对拍改「Rust 输出 ⟷ 冻结 golden」。golden 里存的是
 * **归一化后**的报告，冻结（`_gen-golden.mjs store-exec`）与比对（`store-exec-parity-check.mjs`）
 * 必须用同一份规则 —— 两边各写一遍 = 又一处会走散的契约（F3-b 的原始教训：
 * 「归一化只在对拍脚本里做一次」）。
 *
 * ## 规则（只抹「每跑必变」的量，其余一律保真）
 *   · 时间 / 墙钟：`createdAt` / `finishedAt` / `startedAt` / `updatedAt` / `durationMs` → `null`
 *   · 运行目录：`<ROOT>`（MIAO_ROOT）/ `<STATE>`（MIAO_STATE_DIR）/ `<TMP>`（其父临时目录）
 *     —— 含 JSON 转义层级；任意用户 home 兜底 → `<HOME>`
 *   · 本场景 `taskId`（ULID，每跑必变）→ `<TID>`
 *   · 事件 `id` **保留原始值**（不再拉平 —— 拉平会掩盖缺号，见 `normEvents` 的注释）
 *   · 其余（`sha256` / `byteSize` / 状态格 / 文件清单 / 事件序列 / `itemErrors`）**原样保留**
 *     —— 它们由脚本化翻译器的字节与场景定义决定，属契约面。
 *
 * 用法：`import { freshDirs, projectScenario } from './_store-exec-report.mjs'`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 每次运行必然不同的「墙钟量」键 —— 一律抹平（键保留，值置 null）。 */
const TIME_KEYS = new Set(['createdAt', 'finishedAt', 'startedAt', 'updatedAt', 'durationMs']);

/** 建一对干净目录（root = `MIAO_ROOT`、state = `MIAO_STATE_DIR`），realpath 化以对齐 Rust 侧。 */
export function freshDirs(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `miao-se-${tag}-`));
  const root = path.join(base, 'root');
  const state = path.join(base, 'state');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  return { base, root: fs.realpathSync(root), state: fs.realpathSync(state) };
}

/** 字符串归一化：先抹更长的运行目录（root/state），再抹其父临时目录兜底。 */
function normStr(s, ctx) {
  let out = s;
  // 🔴 顺序敏感：root/state 是 base 的子目录，先抹子目录才不会留下 `<TMP>\root` 这种半成品。
  for (const [dir, tag] of [
    [ctx.root, '<ROOT>'],
    [ctx.state, '<STATE>'],
    [ctx.base, '<TMP>'],
  ]) {
    if (!dir) continue;
    out = out.split(dir).join(tag);
    // JSON 转义层级（反斜杠被转义成两倍）也一次抹掉
    out = out.split(dir.replace(/\\/g, '\\\\')).join(tag);
  }
  // 兜底：任意用户的 home 绝对路径（上述都没覆盖到的残留）
  out = out.replace(/[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+/g, '<HOME>');
  if (ctx.tid) out = out.split(ctx.tid).join('<TID>');
  return out;
}

/** 递归归一化：数组保序；对象保键序（比对侧用 canon 排序，键序不参与比较）。 */
export function normValue(v, ctx) {
  if (Array.isArray(v)) return v.map((x) => normValue(x, ctx));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = TIME_KEYS.has(k) ? null : normValue(v[k], ctx);
    return out;
  }
  if (typeof v === 'string') return normStr(v, ctx);
  return v;
}

/**
 * 事件：`{id, event, data}` 三字段投影，`id` **保留原始值**（不拉平）。
 *
 * 🔴 为什么不像 F3-b 原对拍那样拉平到 `1..n`：拉平是**为了跨实现对齐**（Rust 单进程
 * `event_seq` 跨场景连续，Node 每场景新进程从 1 起）。F5 后只剩 Rust 一个实现 ⇒ 拉平既
 * 无必要，还会**掩盖缺号**（原始 `[1,2,4]` 拉平后与 golden `[1,2,3]` 一致 ⇒ 「id 严格 +1」
 * 那条断言恒真变假绿）。保留原始 id，这条纪律才真被钉住。
 */
export function normEvents(events, ctx) {
  return (events || []).map((e) => ({ id: e.id, event: e.event, data: normValue(e.data, ctx) }));
}

/** 本场景的 taskId（ULID 每跑必变 ⇒ 归一化前先取出来当占位符来源）。 */
export function scenarioTid(sc, report) {
  if (report && report.outcome && report.outcome.taskId) return report.outcome.taskId;
  if (sc && sc.kind === 'seed') return sc.opArg || '';
  return '';
}

/** 单场景 `report` → 与 golden 同形的投影。 */
export function projectReport(report, dirs, tid) {
  const ctx = { base: dirs.base, root: dirs.root, state: dirs.state, tid: tid || '' };
  return {
    outcome: normValue(report.outcome, ctx),
    result: normValue(report.result, ctx),
    error: normValue(report.error, ctx),
    task: normValue(report.task, ctx),
    events: normEvents(report.events, ctx),
    itemErrors: normValue(report.itemErrors, ctx),
    disk: normValue(report.disk, ctx),
    // 只留本场景的 taskId（Rust 单进程跨场景累积，残余项对「本场景」无信息量），
    // 并逐个过归一化 —— 它本身就是 ULID，不过一遍就会把每跑必变的 id 冻进 golden。
    remainingTaskIds: (report.remainingTaskIds || [])
      .filter((id) => (tid ? id === tid : true))
      .map((id) => normStr(id, ctx)),
  };
}

/** `--store-exec-selftest` 的一个场景元素 → `{ name, report }`。 */
export function projectScenario(sc, dirs) {
  return { name: sc.name, report: projectReport(sc.report, dirs, scenarioTid(sc, sc.report)) };
}
