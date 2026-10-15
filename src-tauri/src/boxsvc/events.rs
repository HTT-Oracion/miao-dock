// SSE 事件总线（F5.7）—— 把 store 的**同步** `_emit` 分发给各 SSE 订阅者。
//
// ## 为什么需要一个总线
// Node 里 `store.subscribe(taskId, res, lastEventId)` 直接把响应句柄塞进 `task.clients`，
// `_emit` 遍历它逐条 `writeSseEvent`。Rust 侧 store 是**同步模型**、且 HTTP 响应是 axum 的
// async 流 —— 两者不能直接互持句柄。故用一个**按任务分频道**的广播：
//   · `emit`（同步，在 drain 线程上）→ `publish(taskId, rec)`；
//   · SSE handler（async）→ `subscribe(taskId)` 拿一个 `Receiver`，先重放历史、再跟实时。
//
// ## 语义对齐（对齐 Node）
//   · `rec` = `{id, event, data}` —— `id` 是**全局**递增的 `eventSeq`（不是每任务各自计数）；
//   · 无订阅者时 `publish` 是 **no-op**（Node 的 `clients.size===0` 同义）；
//   · 订阅时按 `lastEventId` 重放 `task.events` 里 `id > last` 的那些。
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;
use tokio::sync::broadcast;

/// 一条事件记录：`(id, event, data)`。
pub type Rec = (u64, String, Value);

/// 每任务频道的缓冲深度。够大即可：订阅者在建立时会**先重放历史**，缓冲只承担"重放与
/// 订阅之间"那一个极短窗口；真丢包时 `RecvError::Lagged` 会让接收端跳过、不影响正确性。
const CAP: usize = 512;

struct Bus {
    tx: HashMap<String, broadcast::Sender<Rec>>,
}

static BUS: OnceLock<Mutex<Bus>> = OnceLock::new();

fn bus() -> &'static Mutex<Bus> {
    BUS.get_or_init(|| Mutex::new(Bus { tx: HashMap::new() }))
}

/// 取锁（**容忍中毒**）：总线只做 `HashMap` 增删与 `send`，没有跨字段不变量 ——
/// 一个 panic  poisoned 之后再 panic 一次毫无意义，只会把 SSE 变成"服务看起来还活着但事件不发"。
fn lock_bus() -> std::sync::MutexGuard<'static, Bus> {
    match bus().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

/// 发布一条事件给某任务的所有订阅者。**无订阅者时是 no-op**（同 Node）。
pub fn publish(task_id: &str, rec: Rec) {
    let g = lock_bus();
    if let Some(tx) = g.tx.get(task_id) {
        let _ = tx.send(rec);
    }
}

/// 订阅某任务的事件流。若该任务尚无频道则建一个。
pub fn subscribe(task_id: &str) -> broadcast::Receiver<Rec> {
    let mut g = lock_bus();
    let tx = g
        .tx
        .entry(task_id.to_string())
        .or_insert_with(|| broadcast::channel(CAP).0);
    tx.subscribe()
}

/// 当前**仍有订阅者**的任务 id。
///
/// 心跳只发给这些任务（复刻 Node `broadcastHeartbeat` 里 `task.clients.size === 0 ⇒ continue`）：
/// 没有订阅者却推进 `eventSeq`，会让**别的**任务的事件 id 凭空跳号 ——
/// 而 id 是客户端的 Last-Event-ID 续传判据，跳号本身不错，但"没人看也在消耗 id"没必要。
pub fn active_channels() -> Vec<String> {
    lock_bus()
        .tx
        .iter()
        .filter(|(_, tx)| tx.receiver_count() > 0)
        .map(|(k, _)| k.clone())
        .collect()
}

/// 任务被删除时忘掉它的频道（否则长跑进程里频道表只增不减）。
pub fn forget(task_id: &str) {
    lock_bus().tx.remove(task_id);
}

/// 单条事件的 SSE 序列化：`id` / `event` / `data` 三行 + 空行（契约 §5.5，同 `formatSseEvent`）。
pub fn format_sse(rec: &Rec) -> String {
    format!(
        "id: {}\nevent: {}\ndata: {}\n\n",
        rec.0,
        rec.1,
        serde_json::to_string(&rec.2).unwrap_or_else(|_| "null".to_string())
    )
}

/// `: <text>\n\n` 注释行（连接建立时先发 `connected`，同 Node `writeComment`）。
pub fn comment(text: &str) -> String {
    format!(": {text}\n\n")
}
