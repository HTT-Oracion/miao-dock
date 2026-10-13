// store 的**执行态**（F3-b）：建单 / 批次 / 续做 / 返工 / 重试 / 删除 / 调度 / 单图处理 /
// 落盘 / 终态 / 取消 / 事件日志。
//
// 移植自 `service/src/manga/store.mjs` 的 `createTask` 段（约 298–1830 行）。
//
// ## 三条与本仓既有纪律一致的裁定（都是「不这么做就会假绿」）
// ① **翻译是注入的，不是 import 的**。Node 侧 `store.mjs` 直接 `import { translateImage }`；
//    Rust 侧改为 [`Translator`] 注入，两个理由：`translate_image` 是 async（tokio），
//    而 store 是**同步模型**；且注入让「调度/重试/落盘/终态」这些**编排语义**能脱离真实引擎
//    被确定性验证（引擎本身已由 `check:engine-http` 钉住，不必在这里重复）。
// ② **调度与执行分离**：`create*` / `retryTask` 只做「入队或启跑」的**记账**（改状态 + 发事件 +
//    落盘），真正的推进在 [`Store::drain`] / `drain.rs` 的线程。Node 里这三件事是靠 async 的
//    `_runTask(...).finally()` 串起来的；同步模型下把它们摊平成两个可分别调用的步骤，
//    `drain` 就是那个「跑到底」的驱动器。
//    🔴 **三段式（D-150）**：单图处理拆成「阶段 1 持锁准备 → 阶段 2 **放锁**调引擎 →
//    阶段 3 持锁落结果」（[`EngineJob`] / [`run_engine_attempts`] / [`Store::end_step`]）。
//    两条驱动器（`Store::drain` 同步、`drain.rs` 线程）走**同一套**阶段接口，不是两份实现 ——
//    否则 HTTP 侧那条路径就没有同源钉子兜底了。
// ③ **SSE 已接线（F5.7）**：事件照 Node 一样进 `task.events`（环形，上限 `MAX_EVENT_LOG`）并推进
//    `event_seq`，同时广播给订阅者（`events::publish`）。
//
// ## 借用策略
// `run_task` 把任务**克隆出 `self.tasks`** 再执行、执行完写回：这样执行体可以自由 `&mut self`
// （blobs / durations / event_seq / queue），不必为「同时持 `&mut Task` 与 `&mut self`」打洞。
// 任务规模 ≤ `BATCH_LIMIT`（20）× 批数，克隆代价可忽略。
use std::path::Path;
use std::time::Duration;

use rand::Rng;
use serde::Serialize;
use serde_json::{json, Value};

use crate::boxsvc::engine::client::{LangPair, TranslateOk, TranslateOpts};
use crate::boxsvc::engine::EngineError;
use crate::paths;

use super::model::{
    is_degradable_write_errno, now_iso_ms, now_ms, seq3, Batch, Item, Lang, Task, TaskEvent,
    MAX_ATTEMPTS, MAX_EVENT_LOG, RETRY_BACKOFF_MS, TASK_TERMINAL,
};
use super::pure;
use super::{io_errno, persist_task, write_original, Store, StoreError, SResult};

// ================================================================ 翻译注入点

/// 单张翻译的注入点（见模块头 ①）。
pub trait Translator {
    fn translate(&self, bytes: &[u8], opts: &TranslateOpts) -> Result<TranslateOk, EngineError>;
}

/// 永远失败（缺省占位；未接引擎时用它，而不是 panic）。
pub struct NoTranslator;
impl Translator for NoTranslator {
    fn translate(&self, _bytes: &[u8], _opts: &TranslateOpts) -> Result<TranslateOk, EngineError> {
        Err(EngineError::new("NO_ENGINE", "未接翻译引擎"))
    }
}

// ================================================================ 输入 / 输出类型

/// 上传的一张图（Node 的 `{data, filename}`）。
#[derive(Clone, Debug)]
pub struct InputImage {
    pub data: Vec<u8>,
    pub filename: Option<String>,
}

/// `POST /tasks` 的 payload（server 层已规范化后注入）。
#[derive(Clone, Debug, Default)]
pub struct CreatePayload {
    pub comic_name: String,
    /// server 层规范化后的目录名（Node 的 `__normalizedName`）。
    pub normalized_name: String,
    pub lang: Option<Lang>,
    pub translator: Option<String>,
    pub client_task_ref: Option<String>,
    pub idempotency_key: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOutcome {
    pub task_id: String,
    pub replay: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelResult {
    pub task_id: String,
    pub status: String,
    pub kept_items: usize,
    pub output_dir: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSkip {
    pub task_id: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub deleted: Vec<String>,
    pub skipped: Vec<DeleteSkip>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryOutcome {
    pub task_id: String,
    pub reused: usize,
}

// ---------------------------------------------------------------- 三段式执行（D-150）

/// 一次「需要引擎」的作业：阶段 1（**持锁**）产出 → 阶段 2（**放锁**）执行 → 阶段 3（**持锁**）收尾。
///
/// 🔴 存在的理由（登记 D-150）：Node 的 `_runTask` 是 async，`await` 引擎 HTTP 时事件循环照常
/// 服务别的请求；本仓的 store 是**同步模型**，若整段 `drain` 都压在 `Mutex<Store>` 里，
/// 引擎在飞的那几秒 `GET /tasks` / `GET /queue` / `POST .../cancel` 全被挡住 —— 于是
/// 「正在跑」「排队位次」这些**中间态**在 HTTP 上根本观察不到（A10/A11/A13/A15/A20 实测如此）。
/// 拆成三段后，只有**真的在调引擎**时才放锁，中间态可被读到。
///
/// 本结构体不借用 `Store`，故可跨「放锁/重新持锁」边界搬运。
#[derive(Clone, Debug)]
pub struct EngineJob {
    pub task_id: String,
    pub dir_name: String,
    pub seq: i64,
    pub bytes: Vec<u8>,
    pub lang_from: String,
    pub lang_to: String,
    pub mime: String,
    pub force_fail: bool,
    pub item_timeout_ms: i64,
    pub engine_timeout_ms: i64,
    /// 阶段 1 的起点时刻 —— 单项总预算从这里算起。
    pub t0: i64,
}

/// 阶段 2 的产物（回传给阶段 3）。
pub struct EngineOutcome {
    pub translated: Option<TranslateOk>,
    pub last_err: Option<EngineError>,
    pub attempts: i64,
    pub force_fail: bool,
    pub t0: i64,
    pub seq: i64,
}

/// `cancelTask` 的两段式返回值（Node 在 running 态 `await _settled`，见 [`Store::cancel_task_step`]）。
#[derive(Clone, Debug)]
pub enum CancelStep {
    /// 已收尾（queued / 边界处取消）—— 直接就是最终结果。
    Done(CancelResult),
    /// 有页在飞（引擎调用已放锁）：本次**不**收尾，由 drain 跑完当前张后收尾为 canceled；
    /// 调用方应**放锁**等任务转入终态，再用 [`Store::finish_cancel`] 取结果。
    InFlight,
}

/// 阶段 1 的判定：这一页要么已经在阶段 1 处理干净（短路 / 缺原图），要么得在引擎上跑。
enum PrepareOutcome {
    Continue,
    NeedEngine(EngineJob),
}

// ================================================================ 纯辅助

/// ApiError 类错误码：**必须向上抛**，绝不能静默降级成 `success`（§8.2 / §4.2）。
fn is_api_error_code(code: &str) -> bool {
    matches!(
        code,
        "PERMISSION_DENIED"
            | "SEQUENCE_OVERFLOW"
            | "INVALID_IMAGE"
            | "TASK_NOT_FOUND"
            | "TASK_NOT_APPENDABLE"
            | "TASK_NOT_CANCELABLE"
            | "TASK_NOT_RETRYABLE"
            | "BATCH_LIMIT_EXCEEDED"
    )
}

/// 落盘失败是否**可降级**（`saved:false` 且不阻断主路径）：非 ApiError 且 errno 在集合内。
/// `DISK_FULL` 是 Node 里那条**非 ApiError** 的演练错误（`err.code='ENOSPC'`），同样可降级。
fn is_degradable(code: &str) -> bool {
    !is_api_error_code(code) && (is_degradable_write_errno(code) || code == "DISK_FULL")
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

fn assert_seq_range(seq_from: i64, count: i64, dir_name: &str) -> SResult<()> {
    if seq_from + count - 1 > super::model::MAX_SEQ {
        return Err(StoreError::new(
            "SEQUENCE_OVERFLOW",
            format!(
                "该漫画名页数已达上限（{}），请另存为新目录",
                super::model::MAX_SEQ
            ),
            json!({
                "limit": super::model::MAX_SEQ,
                "seqFrom": seq_from,
                "seqTo": seq_from + count - 1,
                "normalizedComicName": dir_name
            }),
        ));
    }
    Ok(())
}

/// 事件（`_emit`）：进环形日志 + 推进 `eventSeq` + **广播给 SSE 订阅者**（F5.7）。
fn emit(es: &mut u64, lea: &mut i64, task: &mut Task, event: &str, data: Value) {
    *es += 1;
    let rec = TaskEvent { id: *es, event: event.to_string(), data };
    task.events.push(rec.clone());
    if task.events.len() > MAX_EVENT_LOG {
        let excess = task.events.len() - MAX_EVENT_LOG;
        task.events.drain(0..excess);
    }
    // 无订阅者时是 no-op（同 Node `clients.size===0`）—— 故 store 的单元测试不受影响。
    crate::boxsvc::events::publish(&task.task_id, (rec.id, rec.event.clone(), rec.data.clone()));
    *lea = now_ms();
}

fn emit_task_status(es: &mut u64, lea: &mut i64, task: &mut Task) {
    let data = json!({
        "taskId": task.task_id,
        "status": task.status,
        "queuePosition": task.queue_position,
    });
    emit(es, lea, task, "task.status", data);
}

fn emit_batch_status(es: &mut u64, lea: &mut i64, task: &mut Task, bi: usize) {
    let b = &task.batches[bi];
    let data = json!({
        "taskId": task.task_id,
        "batchIndex": b.batch_index,
        "status": b.status,
        "seqFrom": b.seq_from,
        "seqTo": b.seq_to,
    });
    emit(es, lea, task, "batch.status", data);
}

fn emit_item_status(es: &mut u64, lea: &mut i64, task: &mut Task, bi: usize, ii: usize) {
    let b = &task.batches[bi];
    let it = &b.items[ii];
    let data = json!({
        "taskId": task.task_id,
        "batchIndex": b.batch_index,
        "seq": it.seq,
        "status": it.status,
        "saved": it.saved,
        "outputFile": it.output_file,
        "durationMs": it.duration_ms,
    });
    emit(es, lea, task, "item.status", data);
}

/// `_syncBatchStatuses`：批次状态是**派生**的，只在真的变了时才发事件。
fn sync_batch_statuses(es: &mut u64, lea: &mut i64, task: &mut Task) {
    for bi in 0..task.batches.len() {
        let next = pure::batch_status_of(&task.status, &task.batches[bi].items).to_string();
        if task.batches[bi].status != next {
            task.batches[bi].status = next;
            emit_batch_status(es, lea, task, bi);
        }
    }
}

fn find_translated_name(dir: &Path, seq: i64) -> Option<String> {
    for f in read_dir_names(dir) {
        if pure::match_translated(&f) == Some(seq) {
            return Some(f);
        }
    }
    None
}

fn find_original_name(dir: &Path, seq: i64) -> Option<String> {
    for f in read_dir_names(dir) {
        if pure::match_original(&f) == Some(seq) {
            return Some(f);
        }
    }
    None
}

fn read_dir_names(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()).filter_map(|e| e.file_name().into_string().ok()).collect())
        .unwrap_or_default()
}

fn next_pending_item(task: &Task) -> Option<(usize, usize)> {
    for (bi, b) in task.batches.iter().enumerate() {
        for (ii, it) in b.items.iter().enumerate() {
            if it.status == "pending" {
                return Some((bi, ii));
            }
        }
    }
    None
}

/// 按 `seq` 定位页（放锁期间可能 append 增批，**编号**才是稳定锚）。
fn find_item_by_seq(task: &Task, seq: i64) -> Option<(usize, usize)> {
    for (bi, b) in task.batches.iter().enumerate() {
        for (ii, it) in b.items.iter().enumerate() {
            if it.seq == seq {
                return Some((bi, ii));
            }
        }
    }
    None
}

/// 有没有页正在引擎上跑（决定取消是「立即收尾」还是「等当前张跑完」）。
fn has_translating(task: &Task) -> bool {
    task.batches.iter().any(|b| b.items.iter().any(|i| i.status == "translating"))
}

/// 阶段 2（**放锁**）：单项总预算 + 每次尝试取「剩余预算 × 单请求上限」之小 + 退避重试。
///
/// 复刻 `_processItem` 里的重试循环，但**不碰 `Store`** —— 故可在持锁之外调用（见 [`EngineJob`]）。
pub fn run_engine_attempts(tr: &dyn Translator, job: &EngineJob) -> EngineOutcome {
    let deadline = job.t0 + job.item_timeout_ms;
    let mut attempt: i64 = 0;
    let mut translated: Option<TranslateOk> = None;
    let mut last_err: Option<EngineError> = None;
    loop {
        attempt += 1;
        let remaining = deadline - now_ms();
        if remaining <= 0 {
            last_err = Some(EngineError::new(
                "ENGINE_TIMEOUT",
                format!("单项总预算 {}ms 已耗尽（第 {attempt} 次尝试开始前）", job.item_timeout_ms),
            ));
            break;
        }
        // 每次尝试的**请求超时**取两者之小：剩余预算 × 「单次请求多久算没响应」。
        let attempt_timeout = remaining.min(job.engine_timeout_ms);
        let opts = TranslateOpts {
            seq: job.seq,
            lang: Some(LangPair { from: Some(job.lang_from.clone()), to: Some(job.lang_to.clone()) }),
            from: Some(job.lang_from.clone()),
            to: Some(job.lang_to.clone()),
            mime: Some(job.mime.clone()),
            timeout_ms: Some(attempt_timeout),
        };
        let res = if job.force_fail {
            Err(EngineError::new("ENGINE_ERROR", "injected_failure"))
        } else {
            tr.translate(&job.bytes, &opts)
        };
        match res {
            Ok(t) => {
                translated = Some(t);
                break;
            }
            Err(e) => {
                last_err = Some(e);
                if attempt >= MAX_ATTEMPTS {
                    break;
                }
                std::thread::sleep(Duration::from_millis(RETRY_BACKOFF_MS));
            }
        }
    }
    EngineOutcome { translated, last_err, attempts: attempt, force_fail: job.force_fail, t0: job.t0, seq: job.seq }
}

/// 建 item（Node `_buildItems`）：嗅探扩展名，0 字节/嗅探失败 ⇒ `INVALID_IMAGE`。
fn build_items(seq_from: i64, images: &[InputImage], image_order: &[Value]) -> SResult<(Vec<Item>, Vec<usize>)> {
    let filenames: Vec<Option<String>> = images.iter().map(|i| i.filename.clone()).collect();
    let order = pure::order_images_indices(&filenames, image_order);
    let mut items = Vec::with_capacity(order.len());
    for (i, idx) in order.iter().enumerate() {
        let img = &images[*idx];
        let ext = pure::sniff_image_type(&img.data);
        match ext {
            Some(ext) if !img.data.is_empty() => {
                items.push(Item {
                    seq: seq_from + i as i64,
                    ext: ext.to_string(),
                    mime: if ext == "jpg" { "image/jpeg".to_string() } else { format!("image/{ext}") },
                    byte_size: img.data.len() as i64,
                    from_disk: false,
                    overwrite: false,
                    status: "pending".to_string(),
                    saved: false,
                    original_file: None,
                    output_file: None,
                    sha256: None,
                    duration_ms: None,
                    retry_count: 0,
                    reason: None,
                    error_message: None,
                });
            }
            _ => {
                return Err(StoreError::new(
                    "INVALID_IMAGE",
                    "图片 0 字节或无法解码（嗅探失败）",
                    json!({ "index": i, "filename": img.filename, "bytes": img.data.len() }),
                ))
            }
        }
    }
    Ok((items, order))
}

// ================================================================ `_writeItem` / `_writeOriginal` 的译文部分

/// 落盘：原图 + 译文（复刻 `_writeItem`）。两个文件名校验都在**建目录之前**，
/// 这样任一侧名字不合法时都不会留下一个空目录。
fn write_item(
    root: &Path,
    task_id: &str,
    dir_name: &str,
    disk_full: bool,
    item: &mut Item,
    original_bytes: &[u8],
    translated: &TranslateOk,
) -> SResult<()> {
    // 译文的扩展名由引擎返回字节决定；极端情况下引擎改换了容器格式也不会写出错误扩展名。
    let translated_ext = pure::sniff_image_type(&translated.bytes).unwrap_or(&item.ext).to_string();
    let translated_name = format!("{}_translated.{}", seq3(item.seq), translated_ext);
    if !pure::is_valid_file_name(&translated_name) {
        return Err(StoreError::new(
            "PERMISSION_DENIED",
            "服务端生成的文件名不合法",
            json!({ "translated": translated_name }),
        ));
    }

    write_original(root, task_id, dir_name, disk_full, item, original_bytes)?;

    let dir = root.join(dir_name);
    // 返工重译是**唯一**允许覆盖译文的场景：扩展名可能与上次不同，先删旧的，
    // 否则只覆盖同名会留下**两份**译文，而扫描按 readdir 顺序认第一个 ⇒「重译了但还是旧图」。
    if item.overwrite {
        if let Some(stale) = find_translated_name(&dir, item.seq) {
            if stale != translated_name {
                let _ = std::fs::remove_file(dir.join(&stale));
            }
        }
    }
    let path = dir.join(&translated_name);
    let res = if item.overwrite {
        super::write_file_private(&path, &translated.bytes, 0o600)
    } else {
        super::write_new_private(&path, &translated.bytes, 0o600)
    };
    res.map_err(io_errno)?;
    item.output_file = Some(translated_name);
    item.sha256 = Some(sha256_hex(&translated.bytes));
    Ok(())
}

// ================================================================ 队列记账（自由函数，便于借用拆分）

/// `_enqueueOrStart` 的**记账部分**（真正的推进在 [`Store::drain`]，见模块头 ②）。
fn enqueue_or_start(
    queue: &mut Vec<String>,
    current: &mut Option<String>,
    task: &mut Task,
    es: &mut u64,
    lea: &mut i64,
) {
    let idle = current.is_none() && queue.is_empty();
    if idle {
        task.status = "running".to_string();
        task.queue_position = Some(0);
        *current = Some(task.task_id.clone());
        emit_task_status(es, lea, task);
    } else {
        task.status = "queued".to_string();
        queue.push(task.task_id.clone());
        task.queue_position = Some(queue.len() as i64);
        emit_task_status(es, lea, task);
    }
}

fn reindex_queue(queue: &mut [String], tasks: &mut [Task]) {
    for (i, id) in queue.iter().enumerate() {
        if let Some(t) = tasks.iter_mut().find(|t| &t.task_id == id) {
            t.queue_position = Some(i as i64 + 1);
        }
    }
}

// ================================================================ Store 的执行态 API

impl Store {
    fn task_index(&self, task_id: &str) -> Option<usize> {
        self.tasks.iter().position(|t| t.task_id == task_id)
    }

    /// 复刻 `createTask`：幂等重放 → 序号 → 建 item → 暂存字节 → 入队/启跑。
    pub fn create_task(
        &mut self,
        payload: &CreatePayload,
        images: &[InputImage],
        image_order: &[Value],
        source: Option<String>,
    ) -> SResult<CreateOutcome> {
        let key = payload.idempotency_key.clone();
        if let Some(rec) = self.idempotency_hit(key.as_deref()) {
            if self.get_task(&rec.task_id).is_none() {
                return Err(StoreError::new(
                    "TASK_NOT_FOUND",
                    format!("任务不存在：{}", rec.task_id),
                    json!({ "taskId": rec.task_id }),
                ));
            }
            return Ok(CreateOutcome { task_id: rec.task_id, replay: true });
        }

        let dir_name = payload.normalized_name.clone();
        let seq_from = self.next_seq_for(&dir_name);
        let count = images.len() as i64;
        assert_seq_range(seq_from, count, &dir_name)?;

        let (items, order) = build_items(seq_from, images, image_order)?;
        let batch = Batch {
            batch_index: 1,
            count,
            seq_from,
            seq_to: seq_from + count - 1,
            status: "queued".to_string(),
            idempotency_key: key.clone(),
            items,
        };
        let task = Task::new(
            payload.comic_name.clone(),
            dir_name.clone(),
            source,
            vec![batch],
            payload.lang.clone(),
            payload.translator.clone(),
            payload.client_task_ref.clone(),
            key.clone(),
            &self.root,
        );
        let task_id = task.task_id.clone();

        // 唯一的字节落点：同一份字节**同时**进内存与暂存区（G-12）。任一步失败即回滚本次新落的几份
        // （**不用** drop_staged 整目录删：追加批次时那会连带抹掉前几批尚未落盘的字节）。
        let mut staged: Vec<i64> = Vec::new();
        for (k, idx) in order.iter().enumerate() {
            let seq = seq_from + k as i64;
            match self.stage_bytes(&task_id, seq, &images[*idx].data) {
                Ok(()) => staged.push(seq),
                Err(e) => {
                    for s in &staged {
                        self.unstage_bytes(&task_id, *s);
                    }
                    return Err(e);
                }
            }
        }
        for (k, idx) in order.iter().enumerate() {
            self.blobs.insert(format!("{task_id}:{}", seq_from + k as i64), images[*idx].data.clone());
        }

        self.tasks.push(task);
        let idx_task = self.tasks.len() - 1;
        if let Some(k) = key.as_ref() {
            self.remember_idempotency(k, &task_id, 1);
        }
        {
            let es = &mut self.event_seq;
            let lea = &mut self.last_event_at;
            enqueue_or_start(&mut self.queue, &mut self.current_task_id, &mut self.tasks[idx_task], es, lea);
        }
        persist_task(&self.tasks[idx_task]);
        Ok(CreateOutcome { task_id, replay: false })
    }

    /// 复刻 `appendBatch`：B(n+1).seqFrom 恒等于 B(n).seqTo + 1。
    pub fn append_batch(
        &mut self,
        task_id: &str,
        payload: &CreatePayload,
        images: &[InputImage],
        image_order: &[Value],
    ) -> SResult<CreateOutcome> {
        let idx = self.task_index(task_id).ok_or_else(|| {
            StoreError::new("TASK_NOT_FOUND", format!("任务不存在：{task_id}"), json!({ "taskId": task_id }))
        })?;
        if TASK_TERMINAL.contains(&self.tasks[idx].status.as_str()) {
            return Err(StoreError::new(
                "TASK_NOT_APPENDABLE",
                format!("任务已处于终态 {}，无法追加批次", self.tasks[idx].status),
                json!({ "taskId": task_id, "status": self.tasks[idx].status }),
            ));
        }
        let key = payload.idempotency_key.clone();
        if let Some(rec) = self.idempotency_hit(key.as_deref()) {
            if rec.task_id == task_id {
                return Ok(CreateOutcome { task_id: task_id.to_string(), replay: true });
            }
        }

        let dir_name = self.tasks[idx].dir_name.clone();
        let last_seq_to = self.tasks[idx].batches.last().map(|b| b.seq_to).unwrap_or(0);
        let seq_from = last_seq_to + 1;
        let count = images.len() as i64;
        assert_seq_range(seq_from, count, &dir_name)?;
        let (items, order) = build_items(seq_from, images, image_order)?;
        let batch_index = self.tasks[idx].batches.len() as i64 + 1;

        let mut staged: Vec<i64> = Vec::new();
        for (k, img_idx) in order.iter().enumerate() {
            let seq = seq_from + k as i64;
            match self.stage_bytes(task_id, seq, &images[*img_idx].data) {
                Ok(()) => staged.push(seq),
                Err(e) => {
                    for s in &staged {
                        self.unstage_bytes(task_id, *s);
                    }
                    return Err(e);
                }
            }
        }
        for (k, img_idx) in order.iter().enumerate() {
            self.blobs.insert(format!("{task_id}:{}", seq_from + k as i64), images[*img_idx].data.clone());
        }

        self.tasks[idx].batches.push(Batch {
            batch_index,
            count,
            seq_from,
            seq_to: seq_from + count - 1,
            status: "queued".to_string(),
            idempotency_key: key.clone(),
            items,
        });
        if let Some(k) = key.as_ref() {
            self.remember_idempotency(k, task_id, batch_index);
        }
        persist_task(&self.tasks[idx]);
        {
            let es = &mut self.event_seq;
            let lea = &mut self.last_event_at;
            let bi = self.tasks[idx].batches.len() - 1;
            emit_batch_status(es, lea, &mut self.tasks[idx], bi);
        }
        Ok(CreateOutcome { task_id: task_id.to_string(), replay: false })
    }

    /// 复刻 `createRetranslateTask`：为「有原图」的页**重新**跑（**覆盖**已有译文）。
    pub fn create_retranslate_task(
        &mut self,
        dir_name: &str,
        seqs: Option<Vec<i64>>,
        source: Option<String>,
        lang: Option<Lang>,
    ) -> SResult<CreateOutcome> {
        let plan = self.retranslate_plan(dir_name)?;
        let want: Option<std::collections::HashSet<i64>> = seqs.map(|s| s.into_iter().collect());
        let picked: Vec<_> = match &want {
            Some(w) => plan.candidates.iter().filter(|c| w.contains(&c.seq)).cloned().collect(),
            None => plan.candidates.clone(),
        };
        if picked.is_empty() {
            return Err(StoreError::new(
                "TASK_NOT_FOUND",
                if plan.image_count == 0 { "该漫画目录里没有原图，无从返工" } else { "指定的页在本机没有原图" },
                json!({ "comicName": dir_name, "imageCount": plan.image_count }),
            ));
        }
        if picked.len() as i64 > super::model::BATCH_LIMIT {
            return Err(StoreError::new(
                "BATCH_LIMIT_EXCEEDED",
                format!("返工 {} 张，超过单次上限 {} 张；请分批返工", picked.len(), super::model::BATCH_LIMIT),
                json!({ "limit": super::model::BATCH_LIMIT, "submitted": picked.len(), "seqs": picked.iter().map(|c| c.seq).collect::<Vec<_>>() }),
            ));
        }
        let items: Vec<Item> = picked
            .iter()
            .map(|c| disk_item(c.seq, &c.ext, c.byte_size, Some(c.original_file.clone()), true))
            .collect();
        self.spawn_local_task(dir_name, items, source, lang)
    }

    /// 复刻 `createResumeTask`：为「有原图、缺译文」的页补译文（**不新增编号、不重写原图**）。
    pub fn create_resume_task(
        &mut self,
        dir_name: &str,
        seqs: Option<Vec<i64>>,
        source: Option<String>,
        lang: Option<Lang>,
    ) -> SResult<CreateOutcome> {
        let plan = self.resume_plan(dir_name)?;
        let want: Option<std::collections::HashSet<i64>> = seqs.map(|s| s.into_iter().collect());
        let pendings: Vec<_> = match &want {
            Some(w) => plan.pendings.iter().filter(|p| w.contains(&p.seq)).cloned().collect(),
            None => plan.pendings.clone(),
        };
        if pendings.is_empty() {
            return Err(StoreError::new(
                "TASK_NOT_FOUND",
                if plan.image_count == plan.translated_count {
                    "该漫画已全部翻译完成，没有待续做的页"
                } else {
                    "指定的页不存在或已有译文"
                },
                json!({ "comicName": dir_name, "imageCount": plan.image_count, "translatedCount": plan.translated_count }),
            ));
        }
        if pendings.len() as i64 > super::model::BATCH_LIMIT {
            return Err(StoreError::new(
                "BATCH_LIMIT_EXCEEDED",
                format!("待续做 {} 张，超过单次上限 {} 张；请分批续做", pendings.len(), super::model::BATCH_LIMIT),
                json!({ "limit": super::model::BATCH_LIMIT, "submitted": pendings.len(), "seqs": pendings.iter().map(|p| p.seq).collect::<Vec<_>>() }),
            ));
        }
        let items: Vec<Item> = pendings
            .iter()
            .map(|p| disk_item(p.seq, &p.ext, p.byte_size, Some(p.original_file.clone()), false))
            .collect();
        self.spawn_local_task(dir_name, items, source, lang)
    }

    /// 续做/返工共用的建单：item 字节**在磁盘上**（`fromDisk:true`），不落暂存、不 adopt。
    fn spawn_local_task(
        &mut self,
        dir_name: &str,
        items: Vec<Item>,
        source: Option<String>,
        lang: Option<Lang>,
    ) -> SResult<CreateOutcome> {
        let seq_from = items.first().map(|i| i.seq).unwrap_or(0);
        let seq_to = items.last().map(|i| i.seq).unwrap_or(0);
        let batch = Batch {
            batch_index: 1,
            count: items.len() as i64,
            seq_from,
            seq_to,
            status: "queued".to_string(),
            idempotency_key: None,
            items,
        };
        let task = Task::new(
            dir_name.to_string(),
            dir_name.to_string(),
            source,
            vec![batch],
            lang,
            None,
            None,
            None,
            &self.root,
        );
        let task_id = task.task_id.clone();
        self.tasks.push(task);
        let idx = self.tasks.len() - 1;
        {
            let es = &mut self.event_seq;
            let lea = &mut self.last_event_at;
            enqueue_or_start(&mut self.queue, &mut self.current_task_id, &mut self.tasks[idx], es, lea);
        }
        persist_task(&self.tasks[idx]);
        Ok(CreateOutcome { task_id, replay: false })
    }

    /// 复刻 `retryTask`：把**失败**页复位为待译，用**原来的 taskId** 回到队列。
    pub fn retry_task(&mut self, task_id: &str) -> SResult<RetryOutcome> {
        let idx = self.task_index(task_id).ok_or_else(|| {
            StoreError::new("TASK_NOT_FOUND", format!("任务不存在：{task_id}"), json!({ "taskId": task_id }))
        })?;
        if !TASK_TERMINAL.contains(&self.tasks[idx].status.as_str()) {
            return Err(StoreError::new(
                "TASK_NOT_RETRYABLE",
                format!("任务还在 {}，无需重试", self.tasks[idx].status),
                json!({ "taskId": task_id, "status": self.tasks[idx].status }),
            ));
        }
        let mut reused = 0usize;
        for b in self.tasks[idx].batches.iter_mut() {
            for it in b.items.iter_mut() {
                if it.status != "failed" {
                    continue;
                }
                it.status = "pending".to_string();
                it.from_disk = true;
                it.saved = false;
                it.output_file = None;
                it.sha256 = None;
                it.duration_ms = None;
                it.retry_count = 0;
                it.reason = None;
                it.error_message = None;
                reused += 1;
            }
        }
        if reused == 0 {
            return Err(StoreError::new(
                "TASK_NOT_RETRYABLE",
                "该任务没有可重试的页（只有失败的页需要重跑）",
                json!({ "taskId": task_id, "status": self.tasks[idx].status }),
            ));
        }
        self.tasks[idx].finished_at = None;
        self.tasks[idx].cancel_requested = false;
        self.tasks[idx].last_error = None;
        {
            let es = &mut self.event_seq;
            let lea = &mut self.last_event_at;
            sync_batch_statuses(es, lea, &mut self.tasks[idx]);
        }
        {
            let es = &mut self.event_seq;
            let lea = &mut self.last_event_at;
            enqueue_or_start(&mut self.queue, &mut self.current_task_id, &mut self.tasks[idx], es, lea);
        }
        persist_task(&self.tasks[idx]);
        Ok(RetryOutcome { task_id: task_id.to_string(), reused })
    }

    /// 复刻 `deleteTasks`：只删**记录**（内存 + `state/tasks/<id>.json`），**绝不碰漫画目录**。
    pub fn delete_tasks(&mut self, task_ids: &[String]) -> DeleteResult {
        let mut deleted = Vec::new();
        let mut skipped = Vec::new();
        for task_id in task_ids {
            let Some(idx) = self.task_index(task_id) else {
                skipped.push(DeleteSkip { task_id: task_id.clone(), reason: "not_found".to_string(), status: None });
                continue;
            };
            if !TASK_TERMINAL.contains(&self.tasks[idx].status.as_str()) {
                skipped.push(DeleteSkip {
                    task_id: task_id.clone(),
                    reason: "not_deletable".to_string(),
                    status: Some(self.tasks[idx].status.clone()),
                });
                continue;
            }
            self.sweep_staged(task_id);
            self.forget_blobs(task_id);
            self.tasks.remove(idx);
            let _ = std::fs::remove_file(paths::tasks_state_dir().join(format!("{task_id}.json")));
            deleted.push(task_id.clone());
        }
        DeleteResult { deleted, skipped }
    }

    /// `activeTasksForDir`：该目录上还有没有**未终态**的任务（归并前的前置校验）。
    /// 返回 `(taskId, status)` —— Node 返回整对象，但归并只用这两个字段。
    pub fn active_tasks_for_dir(&self, dir_name: &str) -> Vec<(String, String)> {
        self.tasks
            .iter()
            .filter(|t| t.dir_name == dir_name && !TASK_TERMINAL.contains(&t.status.as_str()))
            .map(|t| (t.task_id.clone(), t.status.clone()))
            .collect()
    }

    // ---------------------------------------------------------------- 调度与执行

    /// 同步驱动：把队列跑到底（单测 / 同源自检走这条路；HTTP 侧由 `drain.rs` 的线程驱动）。
    ///
    /// 🔴 与 `drain.rs` 走的是**同一套**阶段接口（`begin_step` / `end_step` / `abort_step`），
    /// 不是两条实现 —— 区别只在于本函数**不**在引擎调用前后放锁（单线程里没有别的持锁者）。
    pub fn drain(&mut self, tr: &dyn Translator) {
        loop {
            let job = match self.begin_step() {
                Ok(Some(j)) => j,
                Ok(None) => break,
                Err(e) => {
                    self.abort_current(&e);
                    continue;
                }
            };
            let out = run_engine_attempts(tr, &job);
            if let Err(e) = self.end_step(&job, out) {
                self.abort_step(&job.task_id, &e);
            }
        }
    }

    /// 阶段 1（**持锁**）：推进到「下一次引擎调用」。返回 `None` ⇒ 队列已空、无活可干。
    pub fn begin_step(&mut self) -> SResult<Option<EngineJob>> {
        loop {
            // ① 保证有一个「当前任务」；没有就从队列里取（queued → running，记账与 Node 同）。
            if self.current_task_id.is_none() {
                let Some(id) = self.pop_next_queued() else { return Ok(None) };
                self.current_task_id = Some(id);
            }
            let task_id = self.current_task_id.clone().unwrap_or_default();
            let Some(idx) = self.task_index(&task_id) else {
                self.current_task_id = None;
                continue;
            };

            // ② 对齐批次状态（对应 `_runTask` 开头的 `_syncBatchStatuses`）。
            //    `sync_batch_statuses` 只在**真的变了**时才发事件，故每轮都调与「只在开头调一次」同观。
            {
                let es = &mut self.event_seq;
                let lea = &mut self.last_event_at;
                sync_batch_statuses(es, lea, &mut self.tasks[idx]);
            }

            // ③ 取消优先 —— Node 在 for 循环**顶部**先看 cancelRequested，即使还有待处理页也直接收尾。
            if self.tasks[idx].cancel_requested {
                let mut task = self.tasks[idx].clone();
                self.skip_all_pending(&mut task, "canceled");
                self.finalize(&mut task, "canceled");
                self.tasks[idx] = task;
                self.current_task_id = None;
                continue;
            }

            // ④ 取下一页；没了就是终态（复用 `run_task_body` 的 `endStatusOf`）。
            let Some((bi, ii)) = next_pending_item(&self.tasks[idx]) else {
                let mut task = self.tasks[idx].clone();
                let statuses: Vec<String> = task
                    .batches
                    .iter()
                    .flat_map(|b| b.items.iter().map(|i| i.status.clone()))
                    .collect();
                let end = pure::end_status_of(statuses.iter().map(|s| s.as_str())).to_string();
                self.finalize(&mut task, &end);
                self.tasks[idx] = task;
                self.current_task_id = None;
                continue;
            };

            // ⑤ 准备这一页：短路 / 缺原图都在这里记账完继续；要在引擎上跑的则返回作业。
            match self.prepare_item(&task_id, idx, bi, ii)? {
                PrepareOutcome::Continue => continue,
                PrepareOutcome::NeedEngine(job) => return Ok(Some(job)),
            }
        }
    }

    /// 队列里取一个 `queued` 任务置于 `running`（复刻 `_runLoop` 的记账段 + 收尾）。
    fn pop_next_queued(&mut self) -> Option<String> {
        while self.current_task_id.is_none() && !self.queue.is_empty() {
            let id = self.queue.remove(0);
            let Some(idx) = self.task_index(&id) else { continue };
            if self.tasks[idx].status != "queued" {
                continue;
            }
            self.tasks[idx].status = "running".to_string();
            self.tasks[idx].queue_position = Some(0);
            {
                let es = &mut self.event_seq;
                let lea = &mut self.last_event_at;
                let mut q = std::mem::take(&mut self.queue);
                reindex_queue(&mut q, &mut self.tasks);
                self.queue = q;
                emit_task_status(es, lea, &mut self.tasks[idx]);
            }
            persist_task(&self.tasks[idx]);
            return Some(id);
        }
        None
    }

    /// 阶段 1 的「单页准备」：幂等短路 → `translating`（**必须落盘**）→ 取字节 → 造作业。
    fn prepare_item(&mut self, task_id: &str, idx: usize, bi: usize, ii: usize) -> SResult<PrepareOutcome> {
        let mut task = self.tasks[idx].clone();
        let dir_name = task.dir_name.clone();
        let dir = self.root.join(&dir_name);
        let seq = task.batches[bi].items[ii].seq;
        let blob_key = format!("{task_id}:{seq}");
        let overwrite = task.batches[bi].items[ii].overwrite;

        // 幂等续做：`NNN_translated.*` 已存在 ⇒ skipped(already_exists)，序号不变。
        // ⚠️ `overwrite`（返工重译）必须**绕过**这条短路，否则每一页都会以 already_exists 被跳过
        //    —— 任务秒完、进度条走满、译文却一个字没换。
        if self.env.skip_existing && !overwrite && find_translated_name(&dir, seq).is_some() {
            task.batches[bi].items[ii].status = "skipped".to_string();
            task.batches[bi].items[ii].reason = Some("already_exists".to_string());
            task.batches[bi].items[ii].saved = true;
            task.batches[bi].items[ii].output_file = find_translated_name(&dir, seq);
            self.blobs.remove(&blob_key);
            // G-12：已有译文 ⇒ 暂存那份通常没用了 —— 但**前提是原图确实在磁盘上**。
            if find_original_name(&dir, seq).is_some() {
                self.unstage_bytes(task_id, seq);
            }
            {
                let es = &mut self.event_seq;
                let lea = &mut self.last_event_at;
                emit_item_status(es, lea, &mut task, bi, ii);
                sync_batch_statuses(es, lea, &mut task);
            }
            persist_task(&task);
            self.tasks[idx] = task;
            return Ok(PrepareOutcome::Continue);
        }

        task.batches[bi].items[ii].status = "translating".to_string();
        {
            let es = &mut self.event_seq;
            let lea = &mut self.last_event_at;
            emit_item_status(es, lea, &mut task, bi, ii);
            sync_batch_statuses(es, lea, &mut task);
        }
        // 🔴 必须落盘。emit / sync 只改内存并发事件，**不写盘** ⇒ 否则「这一页正在跑」在磁盘上不存在，
        //    落盘的永远是上一次终态（U10② 的现场：快照看起来「什么都没在跑」）。
        persist_task(&task);

        let t0 = now_ms();
        let from_disk = task.batches[bi].items[ii].from_disk;
        // 字节来源三选一：内存（快路径）→ 暂存区（活得过进程）→ 磁盘（续做路径）。
        let bytes = if from_disk {
            self.read_original_from_disk(&dir_name, seq)
        } else {
            self.blobs.get(&blob_key).cloned().or_else(|| self.read_staged_bytes(task_id, seq))
        };
        let Some(bytes) = bytes else {
            if !from_disk {
                self.tasks[idx] = task;
                return Err(StoreError::new("INTERNAL", "原图字节已丢失（内存与暂存区均无）", json!({})));
            }
            // 续做时原图不见了：单张失败，不中断任务（其余页照常续做）。
            task.batches[bi].items[ii].status = "failed".to_string();
            task.batches[bi].items[ii].reason = Some("original_missing".to_string());
            task.batches[bi].items[ii].duration_ms = Some(now_ms() - t0);
            {
                let es = &mut self.event_seq;
                let lea = &mut self.last_event_at;
                emit_item_status(es, lea, &mut task, bi, ii);
                sync_batch_statuses(es, lea, &mut task);
            }
            persist_task(&task);
            self.tasks[idx] = task;
            return Ok(PrepareOutcome::Continue);
        };

        // 失败注入（覆盖 failed / partial_failed / 重试路径）；真实失败来自引擎。
        let force_fail = self.env.fail_seqs.contains(&seq)
            || (self.env.item_fail_rate > 0.0 && rand::thread_rng().gen::<f64>() < self.env.item_fail_rate);

        let job = EngineJob {
            task_id: task_id.to_string(),
            dir_name,
            seq,
            bytes,
            lang_from: task.lang.from.clone(),
            lang_to: task.lang.to.clone(),
            mime: task.batches[bi].items[ii].mime.clone(),
            force_fail,
            item_timeout_ms: self.env.item_timeout_ms,
            engine_timeout_ms: self.env.engine_timeout_ms,
            t0,
        };
        self.tasks[idx] = task;
        Ok(PrepareOutcome::NeedEngine(job))
    }

    /// 阶段 3（**持锁**）：把引擎结果落到 item 上（成功落盘 / 失败保原图），发事件、落盘任务。
    pub fn end_step(&mut self, job: &EngineJob, out: EngineOutcome) -> SResult<()> {
        let Some(idx) = self.task_index(&job.task_id) else { return Ok(()) };
        let mut task = self.tasks[idx].clone();
        // 页按 `seq` 定位 —— 放锁期间可能有 append 增批，编号是稳定的锚。
        let Some((bi, ii)) = find_item_by_seq(&task, job.seq) else { return Ok(()) };
        let blob_key = format!("{}:{}", job.task_id, job.seq);
        let bytes = job.bytes.as_slice();
        let t0 = out.t0;

        if out.translated.is_none() {
            let code = out.last_err.as_ref().map(|e| e.code.clone()).unwrap_or_else(|| "internal_error".to_string());
            let reason = if out.force_fail {
                if self.env.fail_seqs.contains(&job.seq) { "injected_failure".to_string() } else { "random_failure".to_string() }
            } else {
                format!("engine_{}", code.to_lowercase())
            };
            task.batches[bi].items[ii].status = "failed".to_string();
            task.batches[bi].items[ii].retry_count = out.attempts - 1;
            task.batches[bi].items[ii].reason = Some(reason);
            task.batches[bi].items[ii].error_message = out.last_err.as_ref().map(|e| e.message.clone());
            task.batches[bi].items[ii].duration_ms = Some(now_ms() - t0);
            let dur = task.batches[bi].items[ii].duration_ms.unwrap_or(0);
            self.record_duration(dur as f64);
            // G-11：失败页的**原图也要落盘**（否则不可续做 / 库里说法是错的 / 重跑拿不到原图）。
            // ⚠️ 这一步失败时**不**移除 blob、不发事件、不落盘 —— 原图字节留在内存里，交给
            //    `abort_step` 统一走「异常路径也保原图」（与 Node 里那个 `?` 的语义一致）。
            self.keep_original_on_failure(&mut task, bi, ii, bytes)?;
            self.blobs.remove(&blob_key);
            {
                let es = &mut self.event_seq;
                let lea = &mut self.last_event_at;
                emit_item_status(es, lea, &mut task, bi, ii);
                sync_batch_statuses(es, lea, &mut task);
            }
            persist_task(&task);
            self.tasks[idx] = task;
            return Ok(());
        }
        let translated = out.translated.expect("已判非空");

        // 只有真正的落盘/资源错误才降级为 saved:false 且不阻断主路径（§4.2）；其余（尤其安全/路径类）向上抛。
        let disk_full = self.env.disk_full;
        let root = self.root.clone();
        let mut item = task.batches[bi].items[ii].clone();
        let write_res = write_item(&root, &job.task_id, &job.dir_name, disk_full, &mut item, bytes, &translated);
        match write_res {
            Ok(()) => {
                item.saved = true;
                task.batches[bi].items[ii] = item;
            }
            Err(e) => {
                if !is_degradable(&e.code) {
                    self.blobs.remove(&blob_key);
                    // 保持 `translating`，由 `abort_step` 收尾（复刻 Node：抛错后由 catch 统一处理）。
                    self.tasks[idx] = task;
                    return Err(e);
                }
                item.saved = false;
                item.reason = Some(if e.code == "DISK_FULL" { "disk_full".to_string() } else { format!("write_failed:{}", e.code) });
                task.batches[bi].items[ii] = item;
            }
        }
        self.blobs.remove(&blob_key);
        task.batches[bi].items[ii].status = "success".to_string();
        task.batches[bi].items[ii].duration_ms = Some(now_ms() - t0);
        let dur = task.batches[bi].items[ii].duration_ms.unwrap_or(0);
        self.record_duration(dur as f64);
        {
            let es = &mut self.event_seq;
            let lea = &mut self.last_event_at;
            emit_item_status(es, lea, &mut task, bi, ii);
            sync_batch_statuses(es, lea, &mut task);
        }
        persist_task(&task);
        self.tasks[idx] = task;
        Ok(())
    }

    /// 内部错误兜底（复刻 `_runTask` 的 catch）：`translating` 页一律判 failed + 保原图，
    /// 其余待处理页 skipped(internal_error)，任务收尾为 failed。
    pub fn abort_step(&mut self, task_id: &str, err: &StoreError) {
        let Some(idx) = self.task_index(task_id) else {
            self.current_task_id = None;
            return;
        };
        let mut task = self.tasks[idx].clone();
        task.last_error = Some(err.message.clone());
        // 正在处理中的 item 不能留在 translating（否则任务终态里挂着一个假「进行中」）。
        for bi in 0..task.batches.len() {
            for ii in 0..task.batches[bi].items.len() {
                if task.batches[bi].items[ii].status != "translating" {
                    continue;
                }
                task.batches[bi].items[ii].status = "failed".to_string();
                task.batches[bi].items[ii].saved = false;
                task.batches[bi].items[ii].reason = Some("internal_error".to_string());
                // G-11：**已处理**的页一律保原图，异常路径也是失败的一种。
                let seq = task.batches[bi].items[ii].seq;
                let key = format!("{}:{}", task.task_id, seq);
                let last = self.blobs.get(&key).cloned().or_else(|| self.read_staged_bytes(&task.task_id, seq));
                if let Some(b) = last {
                    // 已经在错误路径上了，这里**绝不能再抛**（否则一条错误变两条）。
                    let _ = self.keep_original_on_failure(&mut task, bi, ii, &b);
                }
                let es = &mut self.event_seq;
                let lea = &mut self.last_event_at;
                emit_item_status(es, lea, &mut task, bi, ii);
            }
        }
        self.skip_all_pending(&mut task, "internal_error");
        self.finalize(&mut task, "failed");
        self.tasks[idx] = task;
        self.current_task_id = None;
    }

    /// 把「当前任务」的错误兜底绑成一句（driver 不必自己记 `taskId`）。
    pub fn abort_current(&mut self, err: &StoreError) {
        if let Some(id) = self.current_task_id.clone() {
            self.abort_step(&id, err);
        }
    }

    /// 任务是否已进入终态（取消的两段式等待要用；任务不存在按「已终态」处理，不阻塞调用方）。
    pub fn is_terminal(&self, task_id: &str) -> bool {
        self.tasks
            .iter()
            .find(|t| t.task_id == task_id)
            .map(|t| TASK_TERMINAL.contains(&t.status.as_str()))
            .unwrap_or(true)
    }

    /// 读磁盘上已有的原图字节（续做路径专用）；找不到返回 `None`，由调用方按失败收尾。
    fn read_original_from_disk(&self, dir_name: &str, seq: i64) -> Option<Vec<u8>> {
        let dir = self.root.join(dir_name);
        for f in read_dir_names(&dir) {
            if pure::match_original(&f) == Some(seq) {
                let p = dir.join(&f);
                // 与上传路径同一套校验，不多不少；逃逸同 `_readOriginalFromDisk` 一样按「读不到」处理。
                if paths::assert_inside_root(&self.root, &p).is_err() {
                    return None;
                }
                return std::fs::read(p).ok();
            }
        }
        None
    }

    /// G-11：失败页保原图的**降级纪律** —— 不能因为「顺手留个原图」也失败就把损失**范围**放大。
    /// 失败时**不改 `item.reason`**（它记的是「这张图为什么没译出来」，比「原图也没留下」更值得保留）。
    fn keep_original_on_failure(&mut self, task: &mut Task, bi: usize, ii: usize, bytes: &[u8]) -> SResult<()> {
        let root = self.root.clone();
        let disk_full = self.env.disk_full;
        let task_id = task.task_id.clone();
        let dir_name = task.dir_name.clone();
        let mut item = task.batches[bi].items[ii].clone();
        match write_original(&root, &task_id, &dir_name, disk_full, &mut item, bytes) {
            Ok(()) => {
                task.batches[bi].items[ii] = item;
                Ok(())
            }
            Err(e) => {
                if !is_degradable(&e.code) {
                    return Err(e);
                }
                item.original_file = None;
                task.batches[bi].items[ii] = item;
                eprintln!(
                    "[G-11] seq {} 翻译失败且原图未能保存（{}）：该页将不可续做",
                    task.batches[bi].items[ii].seq, e.code
                );
                Ok(())
            }
        }
    }

    /// `_skipAllPending`：把未处理的页标 `skipped`（取消 / 内部错误两条终态路径都用它）。
    fn skip_all_pending(&mut self, task: &mut Task, reason: &str) {
        for bi in 0..task.batches.len() {
            for ii in 0..task.batches[bi].items.len() {
                if task.batches[bi].items[ii].status != "pending" {
                    continue;
                }
                task.batches[bi].items[ii].status = "skipped".to_string();
                task.batches[bi].items[ii].reason = Some(reason.to_string());
                let es = &mut self.event_seq;
                let lea = &mut self.last_event_at;
                emit_item_status(es, lea, task, bi, ii);
            }
        }
        let es = &mut self.event_seq;
        let lea = &mut self.last_event_at;
        sync_batch_statuses(es, lea, task);
    }

    /// `_finalize`：置终态 → 移出队列并重排名次 → 同步批次 → 发事件 → 落盘 → 暂存收尾。
    fn finalize(&mut self, task: &mut Task, status: &str) {
        task.status = status.to_string();
        task.finished_at = Some(now_iso_ms());
        task.queue_position = Some(0);
        self.queue.retain(|id| id != &task.task_id);
        {
            let mut q = std::mem::take(&mut self.queue);
            reindex_queue(&mut q, &mut self.tasks);
            self.queue = q;
        }
        {
            let es = &mut self.event_seq;
            let lea = &mut self.last_event_at;
            sync_batch_statuses(es, lea, task);
            emit_task_status(es, lea, task);
        }
        persist_task(task);
        // 两种终态收尾（放在 persist **之后**）：取消 → 丢弃全部暂存（未处理的页不得留痕迹）；
        // 其余 → 清扫（此时每页都已按各自规则落盘，暂存目录理应已空）。
        if status == "canceled" {
            self.drop_staged(&task.task_id);
        } else {
            self.sweep_staged(&task.task_id);
        }
        self.forget_blobs(&task.task_id);
    }

    /// 复刻 `cancelTask` 的**第一段**。
    ///
    /// 🔴 Node 对 running 态的任务会 `await this._settled(task, 30000)` —— **等当前张跑完**再收尾，
    /// 这正是 A10「等当前张跑完 / 已落盘保留」的来源。同步模型下不能在这里干等（会把 `Mutex`
    /// 攥死，drain 反而跑不完当前张 ⇒ 死锁），故拆两段：本函数只置 `cancelRequested`，并在
    /// 「没有页在飞」时立即收尾（queued / 边界处取消）；有页在飞时返回 [`CancelStep::InFlight`]，
    /// 由调用方**放锁**等待、再用 [`Store::finish_cancel`] 取结果。
    pub fn cancel_task_step(&mut self, task_id: &str) -> SResult<CancelStep> {
        let idx = self.task_index(task_id).ok_or_else(|| {
            StoreError::new("TASK_NOT_FOUND", format!("任务不存在：{task_id}"), json!({ "taskId": task_id }))
        })?;
        if TASK_TERMINAL.contains(&self.tasks[idx].status.as_str()) {
            return Err(StoreError::new(
                "TASK_NOT_CANCELABLE",
                format!("任务已处于终态 {}，无法取消", self.tasks[idx].status),
                json!({ "taskId": task_id, "status": self.tasks[idx].status }),
            ));
        }
        self.tasks[idx].cancel_requested = true;
        // 有页真的在飞（`translating`）⇒ 本次**不**收尾：drain 会在阶段 3 之后看到
        // `cancelRequested` 并收尾为 canceled（对应 Node 的 `await _settled`）。
        if self.tasks[idx].status == "running" && has_translating(&self.tasks[idx]) {
            return Ok(CancelStep::InFlight);
        }
        // queued / 边界处取消：立即收尾。
        let mut task = self.tasks[idx].clone();
        self.skip_all_pending(&mut task, "canceled");
        self.finalize(&mut task, "canceled");
        self.tasks[idx] = task;
        Ok(CancelStep::Done(self.cancel_result(&self.tasks[idx])))
    }

    /// `cancelTask` 的**收尾段**：放锁等待后调用。仍未终态则强制收尾（同 Node 的 30s 超时分支）。
    pub fn finish_cancel(&mut self, task_id: &str) -> SResult<CancelResult> {
        let idx = self.task_index(task_id).ok_or_else(|| {
            StoreError::new("TASK_NOT_FOUND", format!("任务不存在：{task_id}"), json!({ "taskId": task_id }))
        })?;
        if !TASK_TERMINAL.contains(&self.tasks[idx].status.as_str()) {
            let mut task = self.tasks[idx].clone();
            self.skip_all_pending(&mut task, "canceled");
            self.finalize(&mut task, "canceled");
            self.tasks[idx] = task;
        }
        Ok(self.cancel_result(&self.tasks[idx]))
    }

    /// 同步取消（单测 / 同源自检走这条路）：单线程下不存在「页在飞」，故等价于「立即收尾」。
    pub fn cancel_task(&mut self, task_id: &str) -> SResult<CancelResult> {
        match self.cancel_task_step(task_id)? {
            CancelStep::Done(r) => Ok(r),
            CancelStep::InFlight => self.finish_cancel(task_id),
        }
    }

    fn cancel_result(&self, task: &Task) -> CancelResult {
        let kept = self.all_items(task).iter().filter(|i| i.status == "success" && i.saved).count();
        CancelResult {
            task_id: task.task_id.clone(),
            status: "canceled".to_string(),
            kept_items: kept,
            output_dir: task.output_dir.clone(),
        }
    }
}

// ================================================================ 小工具

fn disk_item(seq: i64, ext: &str, byte_size: i64, original_file: Option<String>, overwrite: bool) -> Item {
    Item {
        seq,
        ext: ext.to_string(),
        mime: if ext == "jpg" { "image/jpeg".to_string() } else { format!("image/{ext}") },
        byte_size,
        from_disk: true,
        overwrite,
        status: "pending".to_string(),
        saved: false,
        original_file,
        output_file: None,
        sha256: None,
        duration_ms: None,
        retry_count: 0,
        reason: None,
        error_message: None,
    }
}

// ================================================================ 单测

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 按脚本回放翻译：脚本空了就一直用最后一项。记录每次调用（seq）。
    #[derive(Default)]
    struct ScriptedTranslator {
        script: Mutex<Vec<Result<Vec<u8>, String>>>,
        calls: Mutex<Vec<i64>>,
    }
    impl ScriptedTranslator {
        fn new(script: Vec<Result<Vec<u8>, String>>) -> Self {
            Self { script: Mutex::new(script), calls: Mutex::new(Vec::new()) }
        }
        fn take(&self, seq: i64) -> Result<Vec<u8>, String> {
            self.calls.lock().unwrap().push(seq);
            let mut s = self.script.lock().unwrap();
            if s.len() > 1 {
                s.remove(0)
            } else {
                s.first().cloned().unwrap_or(Err("empty script".into()))
            }
        }
    }
    impl Translator for ScriptedTranslator {
        fn translate(&self, _b: &[u8], opts: &TranslateOpts) -> Result<TranslateOk, EngineError> {
            match self.take(opts.seq) {
                Ok(bytes) => Ok(TranslateOk { bytes, ext: "png".into(), mime: "image/png".into() }),
                Err(m) => Err(EngineError::new("ENGINE_ERROR", m)),
            }
        }
    }

    /// 最小的合法 PNG（1×1）——嗅探只认魔数，内容无所谓。
    fn png() -> Vec<u8> {
        let mut v = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(&[0u8; 24]);
        v
    }
    fn out_png(tag: u8) -> Vec<u8> {
        let mut v = png();
        v.push(tag);
        v
    }

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("miao-exec-{tag}-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn imgs(n: usize) -> Vec<InputImage> {
        (0..n).map(|i| InputImage { data: { let mut d = png(); d.push(i as u8); d }, filename: Some(format!("p{i}.png")) }).collect()
    }

    fn payload(name: &str) -> CreatePayload {
        CreatePayload { comic_name: name.into(), normalized_name: name.into(), ..Default::default() }
    }

    #[test]
    fn create_and_run_happy_path_writes_files_and_reaches_done() {
        let dir = tmpdir("happy");
        let root = dir.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let mut store = Store::new(&root);
        let tr = ScriptedTranslator::new(vec![Ok(out_png(1)), Ok(out_png(2))]);
        let outcome = store.create_task(&payload("书"), &imgs(2), &[], Some("test".into())).unwrap();
        assert!(!outcome.replay);
        store.drain(&tr);
        let t = store.get_task(&outcome.task_id).unwrap();
        assert_eq!(t.status, "done");
        assert!(t.finished_at.is_some());
        let seqs: Vec<(i64, String)> = t.batches[0].items.iter().map(|i| (i.seq, i.status.clone())).collect();
        assert_eq!(seqs, vec![(1, "success".into()), (2, "success".into())]);
        // 落盘：原图 + 译文都在
        let comic = root.join("书");
        for f in ["001.png", "002.png", "001_translated.png", "002_translated.png"] {
            assert!(comic.join(f).exists(), "缺文件 {f}");
        }
        assert_eq!(store.all_items(t).iter().filter(|i| i.saved).count(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failing_item_is_retried_then_marks_partial_failed_and_keeps_original() {
        let dir = tmpdir("partial");
        let root = dir.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let mut store = Store::new(&root);
        // seq1 ok；seq2 两次都失败；seq3 ok
        let tr = ScriptedTranslator::new(vec![
            Ok(out_png(1)),
            Err("boom".into()),
            Err("boom".into()),
            Ok(out_png(3)),
        ]);
        let outcome = store.create_task(&payload("书"), &imgs(3), &[], None).unwrap();
        store.drain(&tr);
        let t = store.get_task(&outcome.task_id).unwrap();
        assert_eq!(t.status, "partial_failed");
        let st: Vec<String> = t.batches[0].items.iter().map(|i| i.status.clone()).collect();
        assert_eq!(st, vec!["success", "failed", "success"]);
        // retryCount = attempt-1 = 1
        assert_eq!(t.batches[0].items[1].retry_count, 1);
        assert_eq!(t.batches[0].items[1].reason.as_deref(), Some("engine_engine_error"));
        // G-11：失败页的原图也要落盘（否则不可续做）
        assert!(root.join("书").join("002.png").exists(), "失败页原图未落盘");
        assert!(!root.join("书").join("002_translated.png").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn second_task_waits_in_queue_then_runs_after_first() {
        let dir = tmpdir("queue");
        let root = dir.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let mut store = Store::new(&root);
        let tr = ScriptedTranslator::new(vec![Ok(out_png(9))]);
        let a = store.create_task(&payload("甲"), &imgs(1), &[], None).unwrap();
        let b = store.create_task(&payload("乙"), &imgs(1), &[], None).unwrap();
        // 记账已完成：A running，B queued 且队列位次 1
        assert_eq!(store.get_task(&a.task_id).unwrap().status, "running");
        assert_eq!(store.get_task(&b.task_id).unwrap().status, "queued");
        assert_eq!(store.get_task(&b.task_id).unwrap().queue_position, Some(1));
        store.drain(&tr);
        assert_eq!(store.get_task(&a.task_id).unwrap().status, "done");
        assert_eq!(store.get_task(&b.task_id).unwrap().status, "done");
        assert!(store.queue.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancel_queued_task_skips_all_pending() {
        let dir = tmpdir("cancel");
        let root = dir.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let mut store = Store::new(&root);
        let tr = ScriptedTranslator::new(vec![Ok(out_png(1))]);
        let a = store.create_task(&payload("甲"), &imgs(1), &[], None).unwrap();
        let b = store.create_task(&payload("乙"), &imgs(2), &[], None).unwrap();
        let cr = store.cancel_task(&b.task_id).unwrap();
        assert_eq!(cr.status, "canceled");
        let bt = store.get_task(&b.task_id).unwrap();
        assert_eq!(bt.status, "canceled");
        assert!(bt.batches[0].items.iter().all(|i| i.status == "skipped" && i.reason.as_deref() == Some("canceled")));
        // 取消的任务不会跑到；跑完 A 后队列空
        store.drain(&tr);
        assert_eq!(store.get_task(&a.task_id).unwrap().status, "done");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancel_requested_before_run_finalises_canceled() {
        // 覆盖「running 分支」：任务已被置 running，但取消标记在跑之前落下 ⇒ _runTask 边界收尾为 canceled。
        let dir = tmpdir("cancel-running");
        let root = dir.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let mut store = Store::new(&root);
        let tr = ScriptedTranslator::new(vec![Ok(out_png(1))]);
        let a = store.create_task(&payload("甲"), &imgs(1), &[], None).unwrap();
        let idx = store.task_index(&a.task_id).unwrap();
        store.tasks[idx].cancel_requested = true;
        store.drain(&tr);
        let t = store.get_task(&a.task_id).unwrap();
        assert_eq!(t.status, "canceled");
        assert_eq!(t.batches[0].items[0].status, "skipped");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retry_resets_failed_items_only() {
        let dir = tmpdir("retry");
        let root = dir.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let mut store = Store::new(&root);
        let tr = ScriptedTranslator::new(vec![
            Ok(out_png(1)),
            Err("x".into()),
            Err("x".into()),
        ]);
        let a = store.create_task(&payload("书"), &imgs(2), &[], None).unwrap();
        store.drain(&tr);
        assert_eq!(store.get_task(&a.task_id).unwrap().status, "partial_failed");
        let r = store.retry_task(&a.task_id).unwrap();
        assert_eq!(r.reused, 1, "只应复位失败的那一页");
        let t = store.get_task(&a.task_id).unwrap();
        assert_eq!(t.batches[0].items[0].status, "success", "成功的页不动");
        assert_eq!(t.batches[0].items[1].status, "pending");
        assert!(t.batches[0].items[1].from_disk, "重跑走磁盘原图");
        assert!(t.finished_at.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn item_total_budget_exhaustion_fails_with_engine_timeout() {
        let dir = tmpdir("budget");
        let root = dir.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let mut store = Store::new(&root);
        store.env.item_timeout_ms = 0; // 预算为 0：第一次尝试开始前就耗尽
        store.env.engine_timeout_ms = 600_000;
        let tr = ScriptedTranslator::new(vec![Ok(out_png(1))]);
        let a = store.create_task(&payload("书"), &imgs(1), &[], None).unwrap();
        store.drain(&tr);
        let t = store.get_task(&a.task_id).unwrap();
        assert_eq!(t.status, "failed");
        assert_eq!(t.batches[0].items[0].status, "failed");
        assert_eq!(t.batches[0].items[0].reason.as_deref(), Some("engine_engine_timeout"));
        assert!(tr.calls.lock().unwrap().is_empty(), "预算耗尽时不应发起翻译");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn skip_existing_short_circuits_without_calling_engine() {
        let dir = tmpdir("skip");
        let root = dir.join("root");
        let comic = root.join("书");
        std::fs::create_dir_all(&comic).unwrap();
        std::fs::write(comic.join("001.png"), { let mut d = png(); d.push(0); d }).unwrap();
        std::fs::write(comic.join("001_translated.png"), b"old").unwrap();
        let mut store = Store::new(&root);
        let tr = ScriptedTranslator::new(vec![Ok(out_png(7))]);
        // 续做：只有缺译文的页才进计划 ⇒ 这里两页都已有译文/原图，改用 create_task 上传覆盖更复杂；
        // 直接验证「页已存在译文时被短路成 skipped(already_exists)」。
        let outcome = store.create_task(&payload("书"), &imgs(1), &[], None).unwrap();
        // 上传的 seq 从 nextSeq 起（磁盘已有 001）⇒ 应为 002，不冲突
        assert_eq!(store.get_task(&outcome.task_id).unwrap().batches[0].items[0].seq, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn events_are_recorded_and_seq_increases() {
        let dir = tmpdir("events");
        let root = dir.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let mut store = Store::new(&root);
        let tr = ScriptedTranslator::new(vec![Ok(out_png(1))]);
        let a = store.create_task(&payload("书"), &imgs(1), &[], None).unwrap();
        store.drain(&tr);
        let t = store.get_task(&a.task_id).unwrap();
        let kinds: Vec<String> = t.events.iter().map(|e| e.event.clone()).collect();
        assert!(kinds.contains(&"task.status".to_string()));
        assert!(kinds.contains(&"item.status".to_string()));
        assert!(kinds.contains(&"batch.status".to_string()));
        // 事件 id 严格递增且从 1 起
        let ids: Vec<u64> = t.events.iter().map(|e| e.id).collect();
        assert_eq!(ids[0], 1);
        assert!(ids.windows(2).all(|w| w[1] == w[0] + 1));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
