// 档位降档重试 —— 《04》§8 的落地点
//
// ## 原文规则（逐条落地，不"顺手优化"）
// | §8.1 触发 | `CUDA out of memory` / MPS OOM / 系统内存 OOM / 显存不足以加载权重 |
// | §8.1 次数 | **仅降一次** |
// | §8.2 作用域 | **服务级** —— 降档后**后续所有 item** 都用新档，**不逐图降** |
// | §8.2 叠加 | 与 item 级重试**不叠加**：一次 OOM 只走降档一次，**不再额外计 item 重试** |
// | §8.2 留痕 | 降档是内部行为，但需日志留痕（「引擎已从 7B 降至 1.5B」）+ 诊断视图记录 |
// | §8.2 底线 | **已是最低档仍 OOM ⇒ 任务 `failed`** |
// | §8.3 寿命 | 降档只在**本次运行期**有效；工程关闭后再启动**回到用户配置档位**（不记忆） |
//
// ## 为什么"仅降一次"要写成一个**闩**而不是一个计数器
// 计数器（`if (count < 1) count++`）在并发下会漏；而本项目虽是串行队列，仍宁可写成
// 幂等闩（`if (this.used) return null; this.used = true;`）—— 让"只降一次"成为**结构性质**，
// 而不是"靠没人并发调用"。这跟 §9.2 说的"承接串行铁律 ⇒ 该判定无竞态"是同一种思路。

/** 档位由低到高 —— 降档就是往左移一格 */
export const TIER_ORDER = ['tiny', 'small', 'medium'];

/**
 * OOM 的识别签名（《04》§8.1 的四类触发，逐类给出可匹配的文本）。
 *
 * 🔴 为什么用**多签名正则**而不是只判 `out of memory`：
 *   `llama.cpp` 显存不足时打的是 `failed to allocate` / `unable to allocate`，
 *   而 Python 侧的 `MemoryError` 连 "memory" 都不带 `out of`。只认一种写法会出现
 *   「真 OOM 了却没降档，任务白失败」—— 而这恰恰是最难复盘的一类（现场已经过去了）。
 * ⚠️ 反面要求同样重要：**不能把普通失败误判成 OOM**（那会白白降一档，用户看到质量莫名下降）。
 *   ⇒ 断言里必须包含"非 OOM 失败不得命中"的反例（见 `engine-profile-check.mjs`）。
 */
export const OOM_PATTERNS = [
  /cuda out of memory/i,
  /mps backend out of memory/i,
  /\bout of memory\b/i,
  /cannot allocate memory/i,
  /unable to allocate.*(?:memory|buffer)/i,
  /(?:not enough|insufficient) (?:memory|vram|gpu memory)/i,
  /memoryerror/i,
  /failed to allocate/i,
];

/** 把任意错误对象拉平成一个可搜的字符串（message + detail，detail 可能是对象） */
export function flattenError(err) {
  if (!err) return '';
  const parts = [err.message, err.code];
  if (err.detail !== undefined) {
    parts.push(typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail));
  }
  return parts.filter(Boolean).map(String).join(' | ');
}

export function isOomError(err) {
  const text = flattenError(err);
  return OOM_PATTERNS.some((re) => re.test(text));
}

/**
 * 下一档（往低走）。**已是最低档返回 `null`** —— 调用方据此走 §8.2 的底线：任务 failed。
 * 注意方向：降档是 **medium → small → tiny**，不是反过来。
 */
export function nextLowerTier(tier) {
  const i = TIER_ORDER.indexOf(tier);
  if (i <= 0) return null; // 未知档位或已是最低档
  return TIER_ORDER[i - 1];
}

/**
 * 档位控制器（§8.2 的"服务级"就体现在这里：**一个进程一份状态**，不是每个 item 一份）。
 *
 * @param {object} p
 * @param {string} p.tier    本次运行的起始档位（用户配置或硬件推荐）
 * @param {(tier:string)=>Promise<void>} [p.apply] 真正把新档位落实到引擎（默认实现见 server.mjs：
 *        重启 ③ 用新权重）。**注入它是为了让机制可被断言** —— 否则断言只能真等一次分钟级重启。
 * @param {(m:string)=>void} [p.log]
 * @param {boolean} [p.disabled] 反证开关 `MIAO_NO_TIER_DOWNGRADE`
 * @param {(tier:string)=>string|null} [p.modelOf] 档位 → 权重文件名（仅用于日志留痕）
 */
export function createTierDowngrade({ tier, apply, log = () => {}, disabled = false, modelOf } = {}) {
  let current = tier;
  let used = false;
  const history = [];

  const label = (t) => (modelOf ? (modelOf(t) || t) : t);

  return {
    currentTier: () => current,
    isDowngraded: () => used,
    history: () => history.slice(),

    /**
     * 遇到一次疑似 OOM：要不要降档、降成什么。
     * 纯判定（不改状态）—— 便于在断言里枚举"已降过 / 已是最低档 / 被开关关掉"三种情形。
     */
    plan() {
      if (disabled) return { downgrade: false, reason: 'disabled' };
      if (used) return { downgrade: false, reason: 'already-downgraded' };
      const next = nextLowerTier(current);
      if (!next) return { downgrade: false, reason: 'lowest-tier' };
      return { downgrade: true, from: current, to: next };
    },

    /**
     * 执行降档（幂等闩在 `plan()` 之后立即落下，避免 apply 期间被第二次 OOM 重入）。
     * @returns {{downgraded:boolean, to?:string, reason?:string}}
     */
    async tryDowngrade() {
      const p = this.plan();
      if (!p.downgrade) {
        log(`[box-service] 不降档：${p.reason}（当前 ${current}）`);
        return { downgraded: false, reason: p.reason };
      }
      used = true; // 闩：立刻落下，apply 抛错也不退还（§8「仅降一次」）
      current = p.to;
      history.push({ from: p.from, to: p.to, at: new Date().toISOString() });
      // 留痕文案按 §8.2 的原话写「引擎已从 X 降至 Y」—— 验收脚本（与排障的人）都按这句 grep。
      // 带上权重文件名：换档位的**实质**是换权重，只报 tiny/small 会让人以为"降了个档位号"。
      log(`[box-service] ⚠ 引擎 OOM ⇒ 引擎已从 ${p.from} 降至 ${p.to}`
        + `（权重 ${label(p.from)} → ${label(p.to)}；《04》§8.2 —— 仅降一次 / 服务级 / `
        + '本次运行期有效，重启后回到用户配置）');
      try {
        if (apply) await apply(p.to);
      } catch (err) {
        log(`[box-service] 降档落地失败：${err.message}（档位已记为 ${current}，任务将按失败处理）`);
        return { downgraded: false, reason: 'apply-failed', to: p.to };
      }
      return { downgraded: true, from: p.from, to: p.to };
    },
  };
}
