// 队列驱动器（F5.7）—— 把 `Store::drain` 放到**独立线程**，并给它一个「真引擎」翻译器。
//
// ## 为什么必须独立线程
// `store.createTask` / `appendBatch` / `retryTask` 只做**记账**（改状态 + 发事件 + 落盘），
// 真正的推进在 `Store::drain`（见 `store/exec.rs` 模块头 ②）。Node 靠
// `_runTask(...).finally()` 在事件循环上继续跑 ⇒ `POST /tasks` **立即返回**；
// Rust 的 `drain` 是同步的 —— 若在请求线程里直接 `drain`，`POST /tasks` 会一直阻塞到整个任务
// 跑完（20 张 × 每张几十秒 = 分钟级），前端连"已排队"都收不到、`waitTask` 的 120ms 轮询
// 也拿不到任何中间状态。
// ⇒ 常驻线程 + 一个通知通道：建单/追加/重试/续做/返工后 `notify()`，线程醒来把队列跑到底。
//
// ## 为什么用「通知」而不是「忙轮询」
// 轮询要么费 CPU、要么加延迟（sleep 多久就多慢多久）。通道 `recv()` 让线程真正睡着，
// 直到有人确实往队列里放了东西。多叫几次只是多跑几轮**空 drain**（立即返回），无害。
//
// ## 三段式驱动（D-150，**已解**）
// 早先本线程 `drain` 期间**一直持有** `store` 互斥锁 ⇒ 真引擎下长翻译会让 `GET /tasks` / SSE
// 订阅一起等（Node 的事件循环不会 —— 它在 `await` 引擎 HTTP 时照常服务别的请求）。现象：
// 「详情页轮询卡住」「取消总是返回 TASK_NOT_CANCELABLE（其实任务早跑完了）」「排队位次读不到」。
// 现在按 `store/exec.rs` 的三段式接口驱动：**只在真的调引擎那一小段放锁**
// （阶段 1 持锁准备 → 阶段 2 放锁调引擎 → 阶段 3 持锁落结果），中间态因此可被 HTTP 读到。
// 🔴 与本文件同步驱动 `Store::drain` 走的是**同一套**阶段接口 —— 若哪天有人给其中一条另写一份，
//    A10/A11/A13/A15/A20 就会在「一条绿、一条红」上暴露出来。
use std::sync::{mpsc, Arc, Mutex};

use crate::boxsvc::engine::client::{translate_image, EngineCfg, TranslateOk, TranslateOpts};
use crate::boxsvc::engine::EngineError;
use crate::boxsvc::store::exec::{run_engine_attempts, Translator};
use crate::boxsvc::store::Store;

/// 队列通知句柄（`Shell` 持有）。`notify()` 幂等。
///
/// `Clone` 是必需的：`Shell` 派生 `Clone`，而 `Shell` 要到处 `Arc` 传递（handler / sidecar）。
/// `Sender<()>` 本身就是可克隆的句柄，克隆只是多一个发送端，语义不变。
#[derive(Clone)]
pub struct DrainHandle {
    tx: mpsc::Sender<()>,
}

impl DrainHandle {
    /// 叫醒驱动线程。多叫几次无害（多余的唤醒跑一轮空 drain）。
    pub fn notify(&self) {
        let _ = self.tx.send(());
    }
}

/// 引擎调用的驱动方式。
enum EngineDriver {
    /// **默认**：自持单线程运行时 —— `block_on` 由本线程驱动自己的 IO/定时器。
    Own(tokio::runtime::Runtime),
    /// **诊断开关**（`MIAO_DRAIN_SHARED_RUNTIME=1`）：复用服务主运行时的 `Handle`。
    ///
    /// 🔴 **更正（登记 D-151）**：曾把「队列偶发永久卡死」归因于这条路径（跨线程
    /// `Handle::block_on` 不被唤醒），并据此把 `Own` 定为默认。后来做四象限隔离实验
    /// （持锁/放锁 × Own/Shared），结论是**变量是「持锁」而不是这个 Handle**：
    /// 放锁形态下 Shared 完全正常（读延迟 1ms、任务照常 done）；持锁形态下两者都会挡中间态。
    /// ⇒ 本开关**不声称**能复现任何缺陷，只保留为「队列线程换个运行时跑」的对照手段。
    /// 自持运行时保留为**防御性**选择：队列推进不依赖主运行时的 driver。
    Shared(tokio::runtime::Handle),
}

impl EngineDriver {
    fn run<F: std::future::Future>(&self, f: F) -> F::Output {
        match self {
            EngineDriver::Own(rt) => rt.block_on(f),
            EngineDriver::Shared(h) => h.block_on(f),
        }
    }
}

/// 真引擎翻译器 —— `store` 的 [`Translator`] 注入点（见 `store/exec.rs` 模块头 ①）。
///
/// 默认自持一个单线程 tokio 运行时（不放进程全局的运行时的 `Handle` 里）：队列推进因此
/// **不依赖主运行时的 driver** —— 主运行时的 worker 线程被 axum 侧的阻塞式锁竞争占住时，
/// 引擎调用照常被驱动。这是**防御性**选择（见 [`EngineDriver`] 的 D-151 更正说明）。
struct HttpTranslator {
    driver: EngineDriver,
    cfg: EngineCfg,
}

impl Translator for HttpTranslator {
    fn translate(&self, bytes: &[u8], opts: &TranslateOpts) -> Result<TranslateOk, EngineError> {
        self.driver.run(translate_image(&self.cfg, bytes, opts))
    }
}

/// 起驱动线程；返回通知句柄。
///
/// 线程是 **detached** 的：`run_blocking` 返回、`main` 结束时进程退出，它随之终止
/// （不需要 join —— 它唯一的职责就是跑队列，进程都要没了就无所谓了）。
pub fn spawn(
    store: Arc<Mutex<Store>>,
    shared: tokio::runtime::Handle,
    cfg: EngineCfg,
) -> DrainHandle {
    let (tx, rx) = mpsc::channel::<()>();
    std::thread::Builder::new()
        .name("miao-drain".to_string())
        .spawn(move || {
            // 驱动方式：默认自持运行时；`MIAO_DRAIN_SHARED_RUNTIME=1` 走对照路径（见 EngineDriver）。
            let use_shared = std::env::var("MIAO_DRAIN_SHARED_RUNTIME")
                .map(|v| !v.trim().is_empty() && v.trim() != "0")
                .unwrap_or(false);
            let driver = if use_shared {
                eprintln!("[box-service] ℹ drain 走**对照**路径：复用主运行时 Handle（见 D-151 更正说明）");
                EngineDriver::Shared(shared)
            } else {
                match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                    Ok(rt) => EngineDriver::Own(rt),
                    Err(e) => {
                        eprintln!(
                            "[box-service] ⚠ 队列驱动线程的运行时建不起来（{e}）—— 任务将一直停在 running/queued"
                        );
                        return;
                    }
                }
            };
            let tr = HttpTranslator { driver, cfg };
            // 🔴 反证钩子（`MIAO_DRAIN_HOLD_LOCK=1`）：把**整段** drain 压在同一把锁里
            //    —— 那正是 D-150 的旧形态。开着它时中间态在 HTTP 上不可见（`GET /tasks` /
            //    `GET /queue` 都会被挡到任务跑完）；叠加并发读压时还可能把主运行时的 worker
            //    全部压在 `lock()` 上而**硬卡死**（实测）。
            //    与 `drain-runtime-check.mjs` 的反证轮成对：那条断言必须因此变红。
            let hold_lock = std::env::var("MIAO_DRAIN_HOLD_LOCK")
                .map(|v| !v.trim().is_empty() && v.trim() != "0")
                .unwrap_or(false);
            loop {
                match rx.recv() {
                    Ok(()) => {}
                    // 发送端已释放 ⇒ 进程在收尾，线程退出。
                    Err(_) => break,
                }
                // 合并同一批通知：一次 drain 会把队列跑到底，多余的唤醒只是空跑。
                while rx.try_recv().is_ok() {}
                if hold_lock {
                    lock(&store).drain(&tr);
                } else {
                    drive(&store, &tr);
                }
            }
        })
        .map(|_| DrainHandle { tx })
        .unwrap_or_else(|e| {
            eprintln!("[box-service] ⚠ 队列驱动线程起不来（{e}）—— 任务将一直停在 running/queued");
            // 退化成「永远叫不醒」的句柄：功能降级但服务照常起（真正的失败由详情页可见）。
            let (tx, rx) = mpsc::channel::<()>();
            drop(rx);
            DrainHandle { tx }
        })
}

/// 拿到 `store` 锁（容忍中毒：中毒只说明上一次某处 panic 过，数据本身仍是自洽的）。
fn lock(store: &Arc<Mutex<Store>>) -> std::sync::MutexGuard<'_, Store> {
    match store.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

/// 三段式驱动（D-150）：**只在真的调引擎时放锁**，中间态才能被 HTTP 读到。
///
/// 阶段 1（持锁）`begin_step` 推进到「下一次引擎调用」；阶段 2（**放锁**）跑引擎；
/// 阶段 3（持锁）`end_step` 落结果。任一段报错走 `abort_step`（复刻 Node 的 catch）。
fn drive(store: &Arc<Mutex<Store>>, tr: &HttpTranslator) {
    loop {
        // 阶段 1（持锁）：推进到需要引擎的那一页。`None` ⇒ 队列已空。
        let job = {
            let mut s = lock(store);
            match s.begin_step() {
                Ok(Some(j)) => j,
                Ok(None) => return,
                Err(e) => {
                    s.abort_current(&e);
                    continue;
                }
            }
        };
        // 阶段 2（**放锁**）：引擎调用（含重试/预算）。HTTP 请求在这一段能照常读到中间态。
        let out = run_engine_attempts(tr, &job);
        // 阶段 3（持锁）：落结果；失败则走错误兜底。
        let mut s = lock(store);
        if let Err(e) = s.end_step(&job, out) {
            s.abort_step(&job.task_id, &e);
        }
    }
}
