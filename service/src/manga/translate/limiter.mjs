// 每平台令牌桶（QPS + 并发上限）—— 零依赖、纯内存
// =============================================================================
// 依据：在线翻译服务设计方案 §7.4。
//   · 速率桶：容量 = qps、初始满；令牌按时间连续补充（懒更新，不起定时任务）。
//   · 并发上限：默认 3（同一平台的并发请求数）；`acquire` 拿不到就排队等。
//   · `acquire(timeoutMs)` 超时抛**带 code 的普通 Error**（`LIMITER_TIMEOUT`）——
//     门面据此决定回 `TRANSLATE_RATE_LIMITED` 还是 `TRANSLATE_TIMEOUT`。
// 不做队列持久化：进程重启即清零，这是限流不是计账。

/**
 * @param {object}  [opts]
 * @param {number}  [opts.qps=10]         速率（令牌/秒）；桶容量 = 该值
 * @param {number}  [opts.concurrency=3]  并发上限
 */
export function createLimiter({ qps = 10, concurrency = 3 } = {}) {
  if (!Number.isFinite(qps) || qps <= 0) {
    throw new Error(`limiter qps 必须是正数，收到 ${JSON.stringify(qps)}`);
  }
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(`limiter concurrency 必须是正整数，收到 ${JSON.stringify(concurrency)}`);
  }

  /** 桶容量 = 速率（方案 §7.4：突发最多攒一个速率周期的量） */
  const capacity = qps;
  let tokens = capacity;
  let lastRefill = Date.now();
  let active = 0;
  /** 等待队列：FIFO。每项 { resolve, reject, timer } */
  const waiters = [];
  /** 令牌补充到能放行队首之前的唤醒定时器（同一时刻只存在一个） */
  let wakeTimer = null;

  /** 懒补充：按真实经过的时间补令牌，不占定时器 */
  const refill = () => {
    const now = Date.now();
    if (now > lastRefill) {
      tokens = Math.min(capacity, tokens + ((now - lastRefill) / 1000) * qps);
      lastRefill = now;
    }
  };

  const release = () => {
    active = Math.max(0, active - 1);
    pump();
  };

  function pump() {
    while (waiters.length > 0) {
      if (active >= concurrency) return; // 并发已满：等人释放，不空转
      refill();
      if (tokens < 1) {
        scheduleWake();
        return;
      }
      tokens -= 1;
      active += 1;
      const w = waiters.shift();
      if (w.timer) clearTimeout(w.timer);
      // release 幂等：调用方重复释放不该把并发额扣穿
      let released = false;
      w.resolve(() => {
        if (released) return;
        released = true;
        release();
      });
    }
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
  }

  /** 距下一个令牌的毫秒数（+1ms 兜底，避免边界上空转一轮） */
  function scheduleWake() {
    if (wakeTimer || waiters.length === 0) return;
    const needMs = Math.ceil(((1 - tokens) / qps) * 1000) + 1;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      pump();
    }, needMs);
  }

  /**
   * 取一个令牌（速率 + 并发双重闸门）。
   * @param {number} [timeoutMs] 等待上限；不传 = 一直等；0 = 立即可得就要、否则立即超时
   * @returns {Promise<() => void>} resolve 出释放函数；**用完必须调**
   */
  function acquire(timeoutMs) {
    if (timeoutMs !== undefined && timeoutMs !== null
        && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
      return Promise.reject(new Error(`limiter.acquire 的 timeoutMs 必须是非负数字，收到 ${JSON.stringify(timeoutMs)}`));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      if (timeoutMs !== undefined && timeoutMs !== null) {
        waiter.timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i !== -1) waiters.splice(i, 1);
          const err = new Error(`等待翻译平台令牌超时（${timeoutMs}ms 内未获得 QPS/并发额度）`);
          err.code = 'LIMITER_TIMEOUT';
          err.details = { timeoutMs, qps, concurrency };
          reject(err);
        }, timeoutMs);
      }
      waiters.push(waiter);
      pump();
    });
  }

  return { acquire };
}
