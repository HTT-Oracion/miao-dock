// 空闲卸载策略 —— 《04》§9.1/§9.2/§9.3 的**判定**部分（不含实际停进程的动作）
//
// ## 两级卸载，两个实现方
// | 级别 | 释放什么 | 触发 | 实现方 |
// | Tier1 | ③ Sakura LLM | 空闲 5 min | **box-service**（本文件的下游 `LlmSupervisor.stop()`） |
// | Tier2 | 引擎视觉模型 | 空闲 30 min | **引擎自带 `--models-ttl`**（box-service 不动作，只把秒数传下去） |
//
// ## §9.2 前置条件（**安全铁律**，原文）
//   `允许卸载 ⇔ 队列无 running 任务 且 无 queued 任务 且 距最后一次任务完成 ≥ 阈值`
//   且「有任务排队时『空闲 5 分钟』计时器**绝不能**触发」。
//   ⇒ 所以本文件的判据里，**队列非空是一票否决**，与"空闲多久"无关。
//   ⇒ 又因承接串行铁律（同一时刻至多一个 running 任务），该判定**无竞态**：不存在
//     "判定时队列空、判定完立刻来了任务"这种被漏掉的窗口 —— 任务创建是同步改队列的。
//
// ## 为什么判定与动作分开成两个文件
// 判定是纯函数（可注入 `now`、可枚举全部边界），动作是真实进程操作（不可注入、只能实测）。
// 把两者混在一起，边界值就只能靠"真等 5 分钟"去验 —— 那是不可反证的断言（等不到就重跑）。

/**
 * 判定结论的取值（**机器可读**，稳定的 snake_case 令牌）。
 *
 * 🔴 为什么在这里把「令牌」和「中文文案」分开：这个字段会同时被两拨人读 ——
 *   断言要按它判红绿（必须稳定、不能随文案改动而变），日志/将来的诊断视图要给人看。
 *   最初把中文直接当取值用，结果断言里写的是键名、实现返回的是文案，**7 条断言全红**
 *   （而这 7 条红与被测逻辑无关，纯粹是"取值口径"没定）。取值一旦被断言依赖，
 *   它就是一个契约，不该同时兼任文案。
 */
export const UNLOAD_REASONS = {
  ok: 'idle',
  disabled: 'disabled',
  never: 'never',
  busyRunning: 'busy_running',
  busyQueued: 'busy_queued',
  neverRan: 'never_ran',
  notIdleEnough: 'not_idle_enough',
};

const REASON_TEXT = {
  [UNLOAD_REASONS.ok]: '空闲达到阈值',
  [UNLOAD_REASONS.disabled]: '机制被反证开关关掉',
  [UNLOAD_REASONS.never]: '用户选择「从不卸载」',
  [UNLOAD_REASONS.busyRunning]: '有任务正在跑',
  [UNLOAD_REASONS.busyQueued]: '有任务在排队',
  [UNLOAD_REASONS.neverRan]: '本次运行还没有跑过任务（没有热态可卸）',
  [UNLOAD_REASONS.notIdleEnough]: '未达空闲阈值',
};

/** 令牌 → 中文文案（日志用）。未登记的令牌原样返回，不抛错 —— 诊断路径不该成为新的故障点。 */
export function describeUnloadReason(reason) {
  return REASON_TEXT[reason] || String(reason);
}

/**
 * Tier1 判定：**要不要停 ③**。纯函数 —— 时间由调用方给，队列事实由调用方给。
 *
 * @param {object} p
 * @param {number} p.now             当前时刻（ms）
 * @param {number|null} p.lastActivityAt 最后一次"任务活动"的时刻（创建或收尾，ms）
 * @param {number} p.running         正在跑的任务数
 * @param {number} p.queued          排队中的任务数
 * @param {number} p.idleMs          空闲阈值（§9.1：5 min）
 * @param {boolean} [p.neverUnload]  用户配置「从不卸载」
 * @param {boolean} [p.disabled]     反证开关 `MIAO_NO_IDLE_UNLOAD`
 * @returns {{unload:boolean, reason:string, idleForMs:number|null}}
 */
export function decideUnloadLlm({
  now, lastActivityAt, running, queued, idleMs, neverUnload = false, disabled = false,
}) {
  const idleForMs = Number.isFinite(lastActivityAt) ? now - lastActivityAt : null;
  if (disabled) return { unload: false, reason: UNLOAD_REASONS.disabled, idleForMs };
  // 《02》§5：阈值 **0 = 从不卸载**（设置页是「数字（分钟）」，不是另一个复选框）。
  // 🔴 这条判据必须放在**这里**而不是只放在 config：`0 分钟`与`立刻卸载`在数学上只差一个
  //    比较符 —— 少写这一句，用户把阈值填 0 得到的正是他想要的**反面**（刚跑完就卸）。
  //    用 `!(idleMs > 0)` 而不是 `idleMs === 0`：NaN/负值同样是"配错了"，一并按最保守处理。
  if (neverUnload || !(idleMs > 0)) return { unload: false, reason: UNLOAD_REASONS.never, idleForMs };
  // ⚠️ 下面两条顺序在语义上无所谓，但必须**先于**空闲判定 —— 「有任务排队时计时器绝不能触发」
  if (running > 0) return { unload: false, reason: UNLOAD_REASONS.busyRunning, idleForMs };
  if (queued > 0) return { unload: false, reason: UNLOAD_REASONS.busyQueued, idleForMs };
  if (idleForMs === null) return { unload: false, reason: UNLOAD_REASONS.neverRan, idleForMs };
  if (idleForMs < idleMs) return { unload: false, reason: UNLOAD_REASONS.notIdleEnough, idleForMs };
  return { unload: true, reason: UNLOAD_REASONS.ok, idleForMs };
}

/**
 * 从 store 取队列事实。
 * ⚠️ 不直接用 `store.queueSnapshot().running`：那个 `running` 是**对象或 null**，
 *    `null > 0` 为 false、`{} > 0` 也为 false —— 用它当计数器会**恒判空闲**（典型的假绿写法）。
 */
export function queueFacts(store) {
  const running = store.currentTaskId ? 1 : 0;
  const queued = Array.isArray(store.queue) ? store.queue.length : 0;
  return { running, queued, busy: running > 0 || queued > 0 };
}

/**
 * 「任务活动时刻」——取最后一次**创建或收尾**的较大者。
 *
 * 用"活动"而不是严格的"完成"：§9.2 写的是「距最后一次任务完成」，而取活动的是一个**更保守**
 * 的上界（任务刚创建、还在排队时它也会把计时推后）。保守方向是对的：
 * 宁可少卸一次，不可在任务等着的时候把 ③ 停掉。
 * 没有任何任务时返回 `null`（⇒ 「本次运行还没跑过任务」，没有热态可卸）。
 */
export function lastActivityAt(store) {
  let latest = null;
  const tasks = store.tasks instanceof Map ? [...store.tasks.values()] : Object.values(store.tasks || {});
  for (const t of tasks) {
    for (const iso of [t.createdAt, t.finishedAt]) {
      if (!iso) continue;
      const ms = Date.parse(iso);
      if (Number.isFinite(ms) && (latest === null || ms > latest)) latest = ms;
    }
  }
  return latest;
}

/**
 * 空闲看护：周期性判定 + 触发卸载。
 *
 * `tick()` 是对外暴露的**手动步进**入口 —— 让断言不必真等 5 分钟
 * （注入 `now` 调 `tick()` 即可枚举全部边界）。定时器只是 tick 的自动触发者。
 */
export function createIdleWatcher({
  store, supervisor, log = () => {},
  idleMs = 300_000, intervalMs = 5_000,
  neverUnload = false, disabled = false,
  now = () => Date.now(),
  onUnload = null,
} = {}) {
  let stopped = false;
  let timer = null;
  let lastDecision = null;

  async function tick() {
    if (stopped) return lastDecision;
    const facts = queueFacts(store);
    const decision = decideUnloadLlm({
      now: now(),
      lastActivityAt: lastActivityAt(store),
      running: facts.running,
      queued: facts.queued,
      idleMs,
      neverUnload,
      disabled,
    });
    lastDecision = decision;
    if (decision.unload) {
      // 🔴 这里**故意没有**"卸载前再判一次队列"的复判 —— 曾经有过，是死代码。
      //    理由：从 `queueFacts()` 到下面这一句之间**没有 await**，Node 单线程下
      //    这段是原子的，队列不可能变；再判一次只会让人以为"这里挡得住竞态"，
      //    而真正需要挡的那个窗口在**卸载本身**（`stop()` 里的 await 期间来了任务）——
      //    它由 `llm-supervisor.mjs` 的 `_serial` 串行化挡住（见该处注释）。
      //    这个项目最怕的就是"看起来在防守、实际没防"，故留此说明而不是留一段假防守。
      log(`[box-service] 空闲 ${Math.round((decision.idleForMs || 0) / 1000)}s ≥ ${Math.round(idleMs / 1000)}s `
        + `⇒ 卸载 ③ LLM（《04》§9.1 Tier1）`);      if (onUnload) await onUnload(decision);
      else await supervisor.stop({ reason: '空闲卸载' });
    }
    return decision;
  }

  return {
    tick,
    lastDecision: () => lastDecision,
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch((e) => log(`[box-service] 空闲看护异常：${e.message}`)); }, intervalMs);
      timer.unref?.();
      return timer;
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
