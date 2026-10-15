// 每平台令牌桶（QPS + 并发上限）—— 零依赖、纯内存（Rust 侧）
// =============================================================================
// 依据：在线翻译服务设计方案 §7.4。移植自 `service/src/manga/translate/limiter.mjs`。
//   · 速率桶：容量 = qps、初始满；令牌按时间连续补充（懒更新，不起定时任务）。
//   · 并发上限：默认 3（同一平台的并发请求数）；`acquire` 拿不到就排队等。
//   · `acquire(timeout)` 超时抛 [`LimiterErr::Timeout`] —— 门面据此回
//     `TRANSLATE_RATE_LIMITED`（**不是** 504：用户该做的动作是「等一会儿再点」）。
// 不做队列持久化：进程重启即清零，这是限流不是计账。
//
// ⚠️ 与 Node 的形态差异（登记 D-153）：Node 用一个 `setTimeout` 唤醒 pump；Rust 用
//    `Notify` + 「按需等多久」上限。⚠️ 丢失唤醒（notify 发生在注册之前）在本实现里
//    只会让等待多睡一个 `wait_ms` 再重试 —— 不会永久挂住（Node 的定时器同款兜底）。
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Notify;

/// 等待令牌超时（门面据此回 429）。
#[derive(Debug, Clone)]
pub struct LimiterErr {
    pub timeout_ms: u64,
    pub qps: f64,
    pub concurrency: usize,
}

struct Inner {
    tokens: f64,
    last_refill: Instant,
    active: usize,
}

pub struct Limiter {
    qps: f64,
    concurrency: usize,
    inner: Mutex<Inner>,
    notify: Notify,
}

impl Limiter {
    pub fn new(qps: f64, concurrency: usize) -> Arc<Self> {
        Arc::new(Self {
            qps,
            concurrency,
            inner: Mutex::new(Inner { tokens: qps, last_refill: Instant::now(), active: 0 }),
            notify: Notify::new(),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 懒补充：按真实经过的时间补令牌（不占定时器）。
    fn refill(g: &mut Inner, qps: f64) {
        let now = Instant::now();
        if now > g.last_refill {
            let dt = now.duration_since(g.last_refill).as_secs_f64();
            g.tokens = (g.tokens + dt * qps).min(qps);
            g.last_refill = now;
        }
    }

    fn release(&self) {
        let mut g = self.lock();
        g.active = g.active.saturating_sub(1);
        drop(g);
        self.notify.notify_waiters();
    }

    /// 取一个令牌（速率 + 并发双重闸门）。`None` = 一直等（调用方一律给时限，见门面）。
    pub async fn acquire(self: &Arc<Self>, timeout_ms: Option<u64>) -> Result<Permit, LimiterErr> {
        let deadline = timeout_ms.map(|ms| Instant::now() + Duration::from_millis(ms));
        loop {
            let wait_ms = {
                let mut g = self.lock();
                Self::refill(&mut g, self.qps);
                if g.active < self.concurrency && g.tokens >= 1.0 {
                    g.tokens -= 1.0;
                    g.active += 1;
                    return Ok(Permit { limiter: self.clone() });
                }
                if g.active >= self.concurrency {
                    // 并发已满：等人释放（此处不空转，靠 Notify 唤醒 + 上限兜底）
                    50.0
                } else {
                    // 距下一个令牌的毫秒数（+1ms 兜底，避免边界上空转一轮）
                    ((1.0 - g.tokens) / self.qps * 1000.0).ceil() + 1.0
                }
            };
            let dur = Duration::from_millis(wait_ms.max(1.0) as u64);
            let budget = match deadline {
                Some(d) => {
                    let left = d.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Err(self.timeout_err(timeout_ms.unwrap_or(0)));
                    }
                    left.min(dur)
                }
                None => dur,
            };
            // 丢了唤醒也只多睡一个 budget，随后重试。
            let _ = tokio::time::timeout(budget, self.notify.notified()).await;
        }
    }

    fn timeout_err(&self, timeout_ms: u64) -> LimiterErr {
        LimiterErr { timeout_ms, qps: self.qps, concurrency: self.concurrency }
    }
}

/// 持有即占额度；**Drop 即释放**（幂等：不会把并发额扣穿）。
pub struct Permit {
    limiter: Arc<Limiter>,
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.limiter.release();
    }
}

/// 每平台一个桶（进程内懒建；限流不是计账，重启即清零，方案 §7.4）。
pub fn limiter_of(platform: &str) -> Arc<Limiter> {
    use std::sync::OnceLock;
    static POOL: OnceLock<Mutex<HashMap<String, Arc<Limiter>>>> = OnceLock::new();
    let pool = POOL.get_or_init(|| Mutex::new(HashMap::new()));
    let mut g = pool.lock().unwrap_or_else(|p| p.into_inner());
    g.entry(platform.to_string())
        .or_insert_with(|| Limiter::new(10.0, 3))
        .clone()
}
