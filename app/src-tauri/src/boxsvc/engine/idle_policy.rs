// 空闲卸载策略 —— 《04》§9.1/§9.2/§9.3 的**判定**部分（不含实际停进程的动作）
// =============================================================================
// 移植自 `service/src/settings/idle-policy.mjs`（206 行）。
//
// ## 两级卸载，两个实现方
// | 级别 | 释放什么 | 触发 | 实现方 |
// | Tier1 | ③ Sakura LLM | 空闲 5 min | **box-service**（本模块的下游 `llm.stop()`） |
// | Tier2 | 引擎视觉模型 | 空闲 30 min | **引擎自带 `--models-ttl`**（box-service 不动作，只把秒数传下去） |
//
// ## §9.2 前置条件（**安全铁律**，原文）
//   `允许卸载 ⇔ 队列无 running 任务 且 无 queued 任务 且 距最后一次任务完成 ≥ 阈值`
//   且「有任务排队时『空闲 5 分钟』计时器**绝不能**触发」。
//   ⇒ 所以判据里，**队列非空是一票否决**，与"空闲多久"无关。
//   ⇒ 又因承接串行铁律（同一时刻至多一个 running 任务），该判定**无竞态**。
//
// ## 为什么判定与动作分开
// 判定是纯函数（可注入 `now`、可枚举全部边界），动作是真实进程操作（不可注入、只能实测）。
// 把两者混在一起，边界值就只能靠"真等 5 分钟"去验 —— 那是不可反证的断言。
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::boxsvc::store::Store;

/// 判定结论的取值（**机器可读**，稳定的 snake_case 令牌）。
///
/// 🔴 为什么把「令牌」和「中文文案」分开：这个字段会同时被两拨人读 —— 断言要按它判红绿
///    （必须稳定、不能随文案改动而变），日志/诊断视图要给人看。
pub const REASON_IDLE: &str = "idle";
pub const REASON_DISABLED: &str = "disabled";
pub const REASON_NEVER: &str = "never";
pub const REASON_BUSY_RUNNING: &str = "busy_running";
pub const REASON_BUSY_QUEUED: &str = "busy_queued";
pub const REASON_NEVER_RAN: &str = "never_ran";
pub const REASON_NOT_IDLE_ENOUGH: &str = "not_idle_enough";

/// 令牌 → 中文文案（日志用）。未登记的令牌原样返回，不抛错 —— 诊断路径不该成为新的故障点。
pub fn describe_unload_reason(reason: &str) -> String {
    match reason {
        REASON_IDLE => "空闲达到阈值",
        REASON_DISABLED => "机制被反证开关关掉",
        REASON_NEVER => "用户选择「从不卸载」",
        REASON_BUSY_RUNNING => "有任务正在跑",
        REASON_BUSY_QUEUED => "有任务在排队",
        REASON_NEVER_RAN => "本次运行还没有跑过任务（没有热态可卸）",
        REASON_NOT_IDLE_ENOUGH => "未达空闲阈值",
        other => other,
    }
    .to_string()
}

/// 判定结论。
#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub unload: bool,
    pub reason: String,
    pub idle_for_ms: Option<i64>,
}

/// Tier1 判定：**要不要停 ③**。纯函数 —— 时间由调用方给，队列事实由调用方给。
pub fn decide_unload_llm(
    now: i64,
    last_activity_at: Option<i64>,
    running: i64,
    queued: i64,
    idle_ms: i64,
    never_unload: bool,
    disabled: bool,
) -> Decision {
    let idle_for_ms = last_activity_at.map(|t| now - t);
    if disabled {
        return Decision { unload: false, reason: REASON_DISABLED.into(), idle_for_ms };
    }
    // 《02》§5：阈值 **0 = 从不卸载**（设置页是「数字（分钟）」，不是另一个复选框）。
    // 🔴 这条判据必须放在**这里**而不是只放在 config：`0 分钟`与`立刻卸载`在数学上只差一个
    //    比较符 —— 少写这一句，用户把阈值填 0 得到的正是他想要的**反面**（刚跑完就卸）。
    //    用 `!(idle_ms > 0)` 而不是 `idle_ms == 0`：NaN/负值同样是"配错了"，一并按最保守处理。
    if never_unload || idle_ms <= 0 {
        return Decision { unload: false, reason: REASON_NEVER.into(), idle_for_ms };
    }
    // ⚠️ 下面两条顺序在语义上无所谓，但必须**先于**空闲判定 —— 「有任务排队时计时器绝不能触发」
    if running > 0 {
        return Decision { unload: false, reason: REASON_BUSY_RUNNING.into(), idle_for_ms };
    }
    if queued > 0 {
        return Decision { unload: false, reason: REASON_BUSY_QUEUED.into(), idle_for_ms };
    }
    let Some(idle_for) = idle_for_ms else {
        return Decision { unload: false, reason: REASON_NEVER_RAN.into(), idle_for_ms };
    };
    if idle_for < idle_ms {
        return Decision { unload: false, reason: REASON_NOT_IDLE_ENOUGH.into(), idle_for_ms };
    }
    Decision { unload: true, reason: REASON_IDLE.into(), idle_for_ms }
}

/// 从一串时刻里取「任务活动时刻」——最后一次**创建或收尾**的较大者。
///
/// 用"活动"而不是严格的"完成"：§9.2 写的是「距最后一次任务完成」，而取活动的是一个**更保守**
/// 的上界（任务刚创建、还在排队时它也会把计时推后）。保守方向是对的：宁可少卸一次，
/// 不可在任务等着的时候把 ③ 停掉。
///
/// ## 🔴 `since`（范围下界）—— 这里唯一的坑，且踩过一次
/// `store.init()` 会把**上一轮**的终态任务从盘上恢复进 `store.tasks`（任务清单 UI 要显示历史）。
/// 若把这些历史记录也算作"任务活动"，重启 Box 后第一次判定就是
/// 「距上次活动 18 小时 ≥ 5 min ⇒ 卸载 ③」——**③ 刚被拉起就被卸掉**。
/// ⇒ 默认下界取 `runtime_started_at_ms`：**早于本进程启动的活动一律不算**。
pub fn last_activity_at<I: IntoIterator<Item = i64>>(timestamps: I, since: Option<i64>) -> Option<i64> {
    let mut latest: Option<i64> = None;
    for ms in timestamps {
        if ms <= 0 {
            continue; // Node：`Date.parse` 失败 ⇒ NaN ⇒ 跳过
        }
        if let Some(s) = since {
            if ms < s {
                continue; // 上一次运行留下的活动，不算本次运行的热态
            }
        }
        if latest.is_none() || ms > latest.unwrap() {
            latest = Some(ms);
        }
    }
    latest
}

/// 从 store 取队列事实。
///
/// ⚠️ 不直接用 `queue_snapshot().current`：那是个**对象或 null**，拿它当计数器会**恒判空闲**
///    （典型的假绿写法）。
pub fn queue_facts(store: &Store) -> (i64, i64) {
    let running = if store.current_task_id.is_some() { 1 } else { 0 };
    (running, store.queue.len() as i64)
}

/// **本进程**的启动时刻（ms）。取不到（缺字段）返回 `None`，
/// 表示"无法界定本次运行"⇒ 调用方退回**不过滤**的旧行为（保守：宁可少卸一次）。
pub fn runtime_start_ms(store: &Store) -> Option<i64> {
    let v = store.runtime_started_at_ms;
    if v > 0 {
        Some(v)
    } else {
        None
    }
}

/// 收集 `store.tasks` 里每个任务的 `createdAt` / `finishedAt` 时刻（ms）。
pub fn collect_task_timestamps(store: &Store) -> Vec<i64> {
    let mut out = Vec::new();
    for t in &store.tasks {
        for iso in [Some(&t.created_at), t.finished_at.as_ref()] {
            if let Some(s) = iso {
                if !s.is_empty() {
                    out.push(crate::boxsvc::store::model::ts_of(s));
                }
            }
        }
    }
    out
}

/// 空闲看护：周期性判定 + 触发卸载。
///
/// `tick()` 是对外暴露的**手动步进**入口 —— 让断言不必真等 5 分钟（注入 `now` 调 `tick()`）。
/// 定时器只是 tick 的自动触发者。
pub struct IdleWatcher {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl IdleWatcher {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for IdleWatcher {
    fn drop(&mut self) {
        self.stop();
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// 看护参数。
#[derive(Debug, Clone)]
pub struct IdleCfg {
    pub idle_ms: i64,
    pub interval_ms: i64,
    pub never_unload: bool,
    pub disabled: bool,
    /// `'runtime'`（默认）只算本进程启动之后的活动；`'all'` 是**反证开关**（旧行为）。
    pub activity_scope: String,
}

/// 起一个空闲看护线程。`on_unload` 在判定为「可以卸载」时被调用（真正的 `stop()` 由它做）。
pub fn start_idle_watcher<F>(cfg: IdleCfg, store: Arc<Mutex<Store>>, on_unload: F) -> IdleWatcher
where
    F: Fn() + Send + 'static,
{
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let handle = std::thread::Builder::new()
        .name("miao-idle".to_string())
        .spawn(move || {
            let interval = cfg.interval_ms.max(50) as u64;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(interval));
                if stop2.load(Ordering::SeqCst) {
                    break;
                }
                let decision = {
                    let s = match store.lock() {
                        Ok(g) => g,
                        Err(p) => p.into_inner(),
                    };
                    // 🔴 "任务活动"的**范围**：默认只算本次运行（`runtime`）—— 不加下界，
                    //    进程重启后 ③ 会被"上一轮的活动"判成空闲 18 小时而**拉起即被卸**。
                    let since = if cfg.activity_scope == "all" { None } else { runtime_start_ms(&s) };
                    let last = last_activity_at(collect_task_timestamps(&s), since);
                    let (running, queued) = queue_facts(&s);
                    decide_unload_llm(
                        now_ms(),
                        last,
                        running,
                        queued,
                        cfg.idle_ms,
                        cfg.never_unload,
                        cfg.disabled,
                    )
                };
                if decision.unload {
                    let idle = decision.idle_for_ms.unwrap_or(0);
                    println!(
                        "[box-service] 空闲 {}s ≥ {}s ⇒ 卸载 ③ LLM（《04》§9.1 Tier1）",
                        (idle as f64 / 1000.0).round() as i64,
                        (cfg.idle_ms as f64 / 1000.0).round() as i64
                    );
                    on_unload();
                }
            }
        })
        .ok();
    IdleWatcher { stop, handle }
}

fn now_ms() -> i64 {
    crate::boxsvc::store::model::now_ms()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_busy_is_veto_regardless_of_idle() {
        let now = 10_000_000;
        let last = Some(0);
        let d = decide_unload_llm(now, last, 1, 0, 300_000, false, false);
        assert_eq!(d.reason, REASON_BUSY_RUNNING);
        let d = decide_unload_llm(now, last, 0, 3, 300_000, false, false);
        assert_eq!(d.reason, REASON_BUSY_QUEUED);
    }

    #[test]
    fn zero_threshold_means_never() {
        let d = decide_unload_llm(10_000_000, Some(0), 0, 0, 0, false, false);
        assert_eq!(d.reason, REASON_NEVER);
        assert!(!d.unload);
    }

    #[test]
    fn never_ran_and_not_idle_enough() {
        let d = decide_unload_llm(10_000_000, None, 0, 0, 300_000, false, false);
        assert_eq!(d.reason, REASON_NEVER_RAN);
        let d = decide_unload_llm(10_000_000, Some(9_900_000), 0, 0, 300_000, false, false);
        assert_eq!(d.reason, REASON_NOT_IDLE_ENOUGH);
        let d = decide_unload_llm(10_000_000, Some(9_000_000), 0, 0, 300_000, false, false);
        assert!(d.unload);
        assert_eq!(d.reason, REASON_IDLE);
        assert_eq!(d.idle_for_ms, Some(1_000_000));
    }

    #[test]
    fn runtime_scope_filters_previous_runs() {
        // 上一轮的活动（1000）落在本进程启动（5000）之前 ⇒ 不算本次热态。
        assert_eq!(last_activity_at(vec![1000, 2000], Some(5000)), None);
        assert_eq!(last_activity_at(vec![1000, 6000, 5500], Some(5000)), Some(6000));
        assert_eq!(last_activity_at(vec![1000, 6000], None), Some(6000));
        // 非法时间戳（ts_of 给 0）被跳过
        assert_eq!(last_activity_at(vec![0, 0], None), None);
    }
}
