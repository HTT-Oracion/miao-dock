// store —— 任务 / 批次 / 单图三层状态 + 落盘的 Rust 实现（F3-a）
//
// 搬自 `service/src/manga/store.mjs`。本轮只搬**非执行**部分（数据模型、纯逻辑、持久化、
// 启动恢复、暂存区、查询 / 计划 / 视图）；**执行与队列**（`createTask` / `appendBatch` /
// `_runTask` / `_processItem` / `_writeItem` / `_finalize` / 取消 / 重试）依赖
// `engine-client`（F4 的 `engine.rs`）与 SSE 接线，留作 F3-b —— 那部分**只在被调用时才产生
// 行为**，没有执行器时搬过来既跑不了也无从验证（假绿的温床）。
//
// 🔴 迁移期的硬纪律：任何本模块产出的 **JSON 必须与 Node 版逐字节相同** ——
//    `state/tasks/<id>.json` 与 `state/idempotency.json` 是两边共读的事实源。
//    F3 的对照钉子（`e2e/service/store-parity-check.mjs`）把这条钉死。
pub mod exec;
pub mod exec_selftest;
pub mod model;
pub mod pure;
pub mod selftest;
pub mod view;

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Serialize, Serializer};

use crate::paths;

use model::{is_item_terminal, is_task_terminal, seq3, Item, Progress, Task};
use pure::{is_valid_file_name, match_original, match_translated};
use view::*;

// ------------------------------------------------------------------ 错误

/// store 的领域错误。`code` 与 `service/src/errors.mjs` 的 `CODES` 同名同义。
#[derive(Debug, Clone)]
pub struct StoreError {
    pub code: String,
    pub message: String,
    pub details: serde_json::Value,
}

impl StoreError {
    pub fn new(code: &str, message: impl Into<String>, details: serde_json::Value) -> Self {
        StoreError { code: code.to_string(), message: message.into(), details }
    }

    /// 契约 §2.2 的错误码 → HTTP 状态。**逐条誊抄 `service/src/errors.mjs` 的 `CODES`**
    /// （少一条 = 那个错误码静默落 500，界面拿到一句假话）。
    pub fn status(&self) -> u16 {
        match self.code.as_str() {
            "IDEMPOTENT_REPLAY" => 200,
            // 400
            "BATCH_LIMIT_EXCEEDED" | "COMIC_NAME_REQUIRED" | "INVALID_COMIC_NAME"
            | "INVALID_IMAGE" | "INVALID_SETTING" | "INVALID_TRANSLATE_LANG" | "INVALID_BOOK_META"
            | "COVER_TOO_LARGE" | "TRANSLATE_INVALID_INPUT" | "TRANSLATE_TEXT_TOO_LONG"
            | "TRANSLATE_UNSUPPORTED_FEATURE" | "TRANSLATE_CAPABILITY_UNSUPPORTED" => 400,
            "TASK_NOT_FOUND" => 404,
            // 402
            "TRANSLATE_QUOTA_EXCEEDED" => 402,
            // 403
            "PERMISSION_DENIED" => 403,
            // 409
            "TASK_NOT_APPENDABLE" | "TASK_NOT_CANCELABLE" | "TASK_NOT_RETRYABLE"
            | "TASK_NOT_DELETABLE" | "SEQUENCE_OVERFLOW" | "DOWNLOAD_IN_PROGRESS"
            | "BOOK_NAME_TAKEN" | "ALREADY_MERGED" | "MERGE_SOURCE_BUSY" | "CHAPTER_NO_TAKEN"
            | "MERGE_CROSS_DEVICE" | "MERGE_SOURCE_LOCKED" | "CHAPTER_SOURCE_BUSY"
            | "CHAPTER_SOURCE_LOCKED" => 409,
            // 429
            "TRANSLATE_RATE_LIMITED" => 429,
            // 502
            "TRANSLATE_AUTH_FAILED" | "TRANSLATE_UPSTREAM_ERROR" | "TRANSLATE_UPSTREAM_UNREACHABLE" => 502,
            // 503
            "UNAVAILABLE" | "ENGINE_NOT_READY" | "MODEL_DOWNLOAD_FAILED" | "TRANSLATE_NOT_CONFIGURED" => 503,
            // 504
            "TRANSLATE_TIMEOUT" => 504,
            "DISK_FULL" => 507,
            _ => 500,
        }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}（{}）", self.message, self.code)
    }
}

impl std::error::Error for StoreError {}

pub type SResult<T> = Result<T, StoreError>;

// ------------------------------------------------------------------ 运行期配置（env 子集）

/// store 消费的 env 子集（与 `config.mjs` 的 `config` 同名同默认）。
#[derive(Clone, Debug)]
pub struct EnvConfig {
    /// 幂等续做默认开启；只有显式 `MIAO_SKIP_EXISTING=0` 才关（§4.2 / §7.4）
    pub skip_existing: bool,
    /// 强制落盘失败（演练 `saved:false` / `DISK_FULL`）
    pub disk_full: bool,
    /// 服务端不确定时 eta 返回 `null`（契约 §5.7）
    pub eta_null: bool,
    /// 单项**总预算**（含所有重试；`config.itemTimeoutMs`）。没有它，一次挂住 = 单次超时 × 重试次数。
    pub item_timeout_ms: i64,
    /// 单次请求的**无响应上限**（`config.engineTimeoutMs`）—— 每次尝试的实际超时取这两者之小。
    pub engine_timeout_ms: i64,
    /// 注入失败的页号（`MIAO_FAIL_SEQ`，逗号分隔）
    pub fail_seqs: Vec<i64>,
    /// 随机失败率（`MIAO_ITEM_FAIL_RATE`，`[0,1]`）
    pub item_fail_rate: f64,
}

impl EnvConfig {
    pub fn from_env() -> Self {
        let protocol = crate::boxsvc::engine::engine_protocol();
        // 与 `config.mjs` 同口径：真档 600s、mock 档 60s（mock 是替身，超短）。
        let def_timeout = if protocol == "mock" { 60_000 } else { 600_000 };
        let engine_timeout_ms = env_int("MIAO_ENGINE_TIMEOUT_MS", def_timeout);
        EnvConfig {
            skip_existing: env_bool("MIAO_SKIP_EXISTING", true),
            disk_full: env_bool("MIAO_DISK_FULL", false),
            eta_null: env_bool("MIAO_ETA_NULL", false),
            // 默认 = `engineTimeoutMs` 的实际值（**含 `MIAO_ENGINE_TIMEOUT_MS` 的覆盖**）——
            // 两者各写一份默认值会漂移出一种自相矛盾的配置（见 config.mjs 的同名注释）。
            item_timeout_ms: env_int("MIAO_ITEM_TIMEOUT_MS", engine_timeout_ms),
            engine_timeout_ms,
            fail_seqs: parse_seq_list(std::env::var("MIAO_FAIL_SEQ").ok().as_deref()),
            item_fail_rate: env_f64_clamped("MIAO_ITEM_FAIL_RATE", 0.0),
        }
    }
}

impl Default for EnvConfig {
    fn default() -> Self {
        EnvConfig {
            skip_existing: true,
            disk_full: false,
            eta_null: false,
            item_timeout_ms: 600_000,
            engine_timeout_ms: 600_000,
            fail_seqs: Vec::new(),
            item_fail_rate: 0.0,
        }
    }
}

/// `envBool` 语义：未设/空 ⇒ 默认；`0|false|no|off`（不区分大小写）⇒ false；其余 ⇒ true。
fn env_bool(key: &str, def: bool) -> bool {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => {
            !matches!(v.to_ascii_lowercase().as_str(), "0" | "false" | "no" | "off")
        }
        _ => def,
    }
}

/// `envInt(name, def)`：非空才解析；不可解析或**负数** ⇒ `def`（同 `config.mjs`）。
fn env_int(key: &str, def: i64) -> i64 {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => v.trim().parse::<i64>().ok().filter(|n| *n >= 0).unwrap_or(def),
        _ => def,
    }
}

/// `MIAO_ITEM_FAIL_RATE`：解析失败按 0；截到 `[0,1]`（同 `config.mjs`）。
fn env_f64_clamped(key: &str, def: f64) -> f64 {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => {
            let n = v.trim().parse::<f64>().unwrap_or(0.0);
            if n.is_finite() { n.max(0.0).min(1.0) } else { def }
        }
        _ => def,
    }
}

/// `MIAO_FAIL_SEQ`：逗号分隔的页号（复刻 `parseSeqList`；非法项跳过）。
fn parse_seq_list(raw: Option<&str>) -> Vec<i64> {
    let Some(s) = raw else { return Vec::new() };
    s.split(',')
        .filter_map(|x| x.trim().parse::<i64>().ok())
        .collect()
}

// ------------------------------------------------------------------ 幂等表记录

#[derive(Clone, Debug)]
pub struct IdemEntry {
    pub key: String,
    pub task_id: String,
    pub batch_index: i64,
    pub at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IdemRecordRef<'a> {
    task_id: &'a str,
    batch_index: i64,
    at: i64,
}

/// 幂等表落盘外壳：按**插入序**输出（Node 用 Object 保序）。
struct IdemFile<'a>(&'a [IdemEntry]);

impl Serialize for IdemFile<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(self.0.len()))?;
        for e in self.0 {
            m.serialize_entry(
                &e.key,
                &IdemRecordRef { task_id: &e.task_id, batch_index: e.batch_index, at: e.at },
            )?;
        }
        m.end()
    }
}

/// `init()` 的返回值（`{restored, aborted, swept}`）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitReport {
    pub restored: i64,
    pub aborted: i64,
    pub swept: i64,
}

// ------------------------------------------------------------------ Store

/// 任务库（内存）+ 落盘根。字段与 `store.mjs` 的 `Store` 一一对应。
///
/// `allow(dead_code)`：其中若干字段/方法由 **F3-b（调度与执行）** 消费，本增量尚无调用方 ——
/// 显式标注而不是删掉，免得 F3-b 又要重推一遍「内存暂存 vs 落盘」的语义。
#[allow(dead_code)]
pub struct Store {
    /// 落盘根目录（**已规范化**）
    pub root: PathBuf,
    /// 任务表（**保持插入序** —— 列表分组内顺序依赖它，`Vec` 比 `HashMap` 更忠实）
    pub tasks: Vec<Task>,
    /// 等待执行的 taskId（不含当前运行中的）
    pub queue: Vec<String>,
    /// `taskId:seq` → 上传原图字节（内存暂存，落盘时消费）
    pub blobs: HashMap<String, Vec<u8>>,
    /// 近 N 张已完成 item 的耗时（毫秒），用于 eta
    pub durations: VecDeque<f64>,
    pub event_seq: u64,
    pub current_task_id: Option<String>,
    /// 幂等表（保持插入序）
    pub idempotency: Vec<IdemEntry>,
    /// 已隐藏的漫画名（保持插入序；视图侧排序）
    pub hidden_comics: Vec<String>,
    pub started_at: String,
    /// **本进程**启动时刻（毫秒精度）。见 `model::now_iso_ms` 的注释。
    pub runtime_started_at_ms: i64,
    pub last_event_at: i64,
    pub env: EnvConfig,
}

impl Store {
    /// 构造：`validateAndPrepare(rootDir)` 只做规范化兜底（启动时由 server 层 `validateRoot` 校验黑名单）。
    pub fn new(root_dir: &Path) -> Self {
        Store {
            root: paths::canonicalize(root_dir),
            tasks: Vec::new(),
            queue: Vec::new(),
            blobs: HashMap::new(),
            durations: VecDeque::new(),
            event_seq: 0,
            current_task_id: None,
            idempotency: Vec::new(),
            hidden_comics: Vec::new(),
            started_at: model::now_iso(),
            runtime_started_at_ms: model::now_ms(),
            last_event_at: 0,
            env: EnvConfig::from_env(),
        }
    }

    // ---------------------------------------------------------------- 启动恢复

    /// 复刻 `init()`：建目录 → 读幂等表 → 读隐藏清单 → 恢复任务清单（非终态一律收尾为 failed）
    /// → 清扫孤儿暂存目录。
    pub fn init(&mut self) -> InitReport {
        let _ = mkdir_p(&self.root, 0o700);
        let _ = mkdir_p(&paths::tasks_state_dir(), 0o700);

        // 幂等表
        if let Some(obj) = read_json(&paths::idempotency_file()).and_then(|v| v.as_object().cloned()) {
            for (k, val) in obj {
                let task_id = val.get("taskId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let batch_index = val.get("batchIndex").and_then(|x| x.as_i64()).unwrap_or(0);
                let at = val.get("at").and_then(|x| x.as_i64()).unwrap_or(0);
                self.idempotency.push(IdemEntry { key: k, task_id, batch_index, at });
            }
        }

        // 隐藏清单（非数组 / 坏文件一律当作「没有隐藏」）
        self.hidden_comics.clear();
        if let Some(arr) = read_json(&paths::hidden_comics_file())
            .and_then(|v| v.get("comics").and_then(|x| x.as_array()).cloned())
        {
            for n in arr {
                if let Some(s) = n.as_str() {
                    if !self.hidden_comics.iter().any(|x| x == s) {
                        self.hidden_comics.push(s.to_string());
                    }
                }
            }
        }

        let mut restored = 0i64;
        let mut aborted = 0i64;

        let mut files: Vec<String> = std::fs::read_dir(paths::tasks_state_dir())
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter_map(|e| e.file_name().into_string().ok())
                    .filter(|f| f.ends_with(".json"))
                    .collect()
            })
            .unwrap_or_default();
        files.sort(); // 稳定遍历顺序；判定不依赖它

        for f in files {
            let path = paths::tasks_state_dir().join(&f);
            let raw = match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(_) => continue,
            };
            let mut task: Task = match serde_json::from_str(&raw) {
                Ok(t) => t,
                Err(_) => continue, // 单个任务文件损坏则跳过
            };
            if task.task_id.is_empty() {
                continue;
            }
            task.events.clear();
            task.clients.clear();
            task.cancel_requested = false;

            if !is_task_terminal(&task.status) {
                // G-12：先把上传时暂存的原图搬回漫画目录，再按老规矩标失败收尾。
                let moved = self.materialize_staged(&mut task);
                for b in task.batches.iter_mut() {
                    for i in b.items.iter_mut() {
                        if !is_item_terminal(&i.status) {
                            i.status = "failed".into();
                            i.reason = Some("service_restarted".into());
                        }
                    }
                }
                task.status = "failed".into();
                aborted += 1;
                self.persist_now(&task);
                self.sweep_staged(&task.task_id);
                if moved > 0 {
                    eprintln!(
                        "[G-12] 任务 {}：已把 {} 张暂存原图搬回漫画目录，可在「继续翻译」里补译文",
                        task.task_id, moved
                    );
                }
            }
            self.tasks.push(task);
            restored += 1;
        }

        let swept = self.sweep_orphan_staging();
        InitReport { restored, aborted, swept }
    }

    // ---------------------------------------------------------------- 暂存区（G-12）

    fn stage_dir(&self, task_id: &str) -> SResult<PathBuf> {
        if !model::is_valid_task_id(task_id) {
            return Err(StoreError::new(
                "PERMISSION_DENIED",
                "taskId 形状不合法，拒绝用于暂存路径",
                serde_json::json!({ "taskId": task_id }),
            ));
        }
        Ok(paths::pending_dir().join(task_id))
    }

    fn stage_path(&self, task_id: &str, seq: i64) -> SResult<PathBuf> {
        Ok(self.stage_dir(task_id)?.join(format!("{}.bin", seq3(seq))))
    }

    /// 建单 / 追加批次的**唯一**字节落点（F3-b 的 `createTask`/`appendBatch` 消费）。
    #[allow(dead_code)]
    fn stage_bytes(&self, task_id: &str, seq: i64, bytes: &[u8]) -> SResult<()> {
        let dir = self.stage_dir(task_id)?;
        mkdir_p(&dir, 0o700).map_err(io_err)?;
        let p = dir.join(format!("{}.bin", seq3(seq)));
        create_private(&p, 0o600).and_then(|mut f| f.write_all(bytes)).map_err(io_err)
    }

    fn read_staged_bytes(&self, task_id: &str, seq: i64) -> Option<Vec<u8>> {
        let p = self.stage_path(task_id, seq).ok()?;
        std::fs::read(p).ok()
    }

    #[allow(dead_code)]
    fn unstage_bytes(&self, task_id: &str, seq: i64) {
        if let Ok(p) = self.stage_path(task_id, seq) {
            let _ = std::fs::remove_file(p);
        }
    }

    fn drop_staged(&self, task_id: &str) {
        if let Ok(dir) = self.stage_dir(task_id) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// 正常终态收尾：暂存目录**应当已空** —— 空则删，非空则**留着并告警**（那是某页仅存的字节）。
    fn sweep_staged(&self, task_id: &str) {
        let dir = match self.stage_dir(task_id) {
            Ok(d) => d,
            Err(_) => return,
        };
        let left: Vec<String> = std::fs::read_dir(&dir)
            .map(|rd| rd.filter_map(|e| e.ok()).filter_map(|e| e.file_name().into_string().ok()).collect())
            .unwrap_or_default();
        if left.is_empty() {
            self.drop_staged(task_id);
            return;
        }
        eprintln!(
            "[G-12] 任务 {task_id} 收尾时暂存区仍剩 {} 份字节（{}）：对应页的原图不在漫画目录里，保留以免彻底丢失",
            left.len(),
            left.join(", ")
        );
    }

    /// 与暂存区**成对**清理的内存侧（F3-b 消费）。
    #[allow(dead_code)]
    fn forget_blobs(&mut self, task_id: &str) {
        let prefix = format!("{task_id}:");
        self.blobs.retain(|k, _| !k.starts_with(&prefix));
    }

    /// 启动时的暂存区清扫（G-12）：**只删空目录**；非空的一律保留并告警。
    pub fn sweep_orphan_staging(&self) -> i64 {
        let dirs: Vec<String> = std::fs::read_dir(paths::pending_dir())
            .map(|rd| rd.filter_map(|e| e.ok()).filter_map(|e| e.file_name().into_string().ok()).collect())
            .unwrap_or_default();
        let mut removed = 0i64;
        for d in dirs {
            let p = paths::pending_dir().join(&d);
            match std::fs::metadata(&p) {
                Ok(m) if m.is_dir() => {}
                _ => continue,
            }
            let task = self.get_task(&d);
            if let Some(t) = task {
                if !is_task_terminal(&t.status) {
                    continue; // 仍在跑的任务绝不碰
                }
            }
            let entries: Vec<String> = std::fs::read_dir(&p)
                .map(|rd| rd.filter_map(|e| e.ok()).filter_map(|e| e.file_name().into_string().ok()).collect())
                .unwrap_or_default();
            if entries.is_empty() {
                if std::fs::remove_dir(&p).is_ok() {
                    removed += 1;
                }
            } else {
                eprintln!(
                    "[G-12] 暂存目录 {d} 里还有 {} 份字节且没有对应的在跑任务：保留不删（可能是某页原图仅存的一份），请人工确认后清理",
                    entries.len()
                );
            }
        }
        removed
    }

    /// 把**暂存区**里属于该任务的字节搬进漫画目录（G-12 重启恢复）。只搬「非终态」的页。
    fn materialize_staged(&mut self, task: &mut Task) -> i64 {
        let root = self.root.clone();
        let disk_full = self.env.disk_full;
        let task_id = task.task_id.clone();
        let dir_name = task.dir_name.clone();
        let mut moved = 0i64;
        for b in task.batches.iter_mut() {
            for i in b.items.iter_mut() {
                if is_item_terminal(&i.status) {
                    continue;
                }
                let bytes = match self.read_staged_bytes(&task_id, i.seq) {
                    Some(b) => b,
                    None => continue,
                };
                match write_original(&root, &task_id, &dir_name, disk_full, i, &bytes) {
                    Ok(()) => moved += 1,
                    Err(e) => {
                        // 搬不动就把它留在暂存区（`sweep_staged` 会告警），绝不因此让服务起不来。
                        eprintln!("[G-12] seq {} 的暂存原图搬回失败（{}）：保留在暂存区", i.seq, e.code);
                    }
                }
            }
        }
        moved
    }

    // ---------------------------------------------------------------- 查询工具

    pub fn get_task(&self, task_id: &str) -> Option<&Task> {
        self.tasks.iter().find(|t| t.task_id == task_id)
    }

    pub fn must_task(&self, task_id: &str) -> SResult<&Task> {
        self.get_task(task_id).ok_or_else(|| {
            StoreError::new(
                "TASK_NOT_FOUND",
                format!("任务不存在：{task_id}"),
                serde_json::json!({ "taskId": task_id }),
            )
        })
    }

    pub fn current_task(&self) -> Option<&Task> {
        self.current_task_id.as_deref().and_then(|id| self.get_task(id))
    }

    pub fn all_items<'a>(&self, task: &'a Task) -> Vec<&'a Item> {
        task.batches.iter().flat_map(|b| b.items.iter()).collect()
    }

    pub fn pending_count(&self, task: &Task) -> usize {
        self.all_items(task).iter().filter(|i| i.status == "pending").count()
    }

    pub fn task_dir(&self, task: &Task) -> PathBuf {
        self.root.join(&task.dir_name)
    }

    fn list_dir(&self, dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .map(|rd| rd.filter_map(|e| e.ok()).filter_map(|e| e.file_name().into_string().ok()).collect())
            .unwrap_or_default()
    }

    /// `nextSeq = max(目录内原图序号, 未落盘任务占用序号) + 1`
    pub fn next_seq_for(&self, dir_name: &str) -> i64 {
        let dir = self.root.join(dir_name);
        let mut disk_max = 0i64;
        for f in self.list_dir(&dir) {
            if let Some(n) = match_original(&f) {
                disk_max = disk_max.max(n);
            }
        }
        let mut reserved = 0i64;
        for t in &self.tasks {
            if t.dir_name != dir_name || is_task_terminal(&t.status) {
                continue;
            }
            let last = t.batches.last().map(|b| b.seq_to).unwrap_or(0);
            reserved = reserved.max(last);
        }
        disk_max.max(reserved) + 1
    }

    // ---------------------------------------------------------------- 本地续做 / 返工计划

    /// §5.8：扫描目录，找出「有原图、缺译文」的页（**不维护第二份索引**，直接读目录）。
    pub fn resume_plan(&self, dir_name: &str) -> SResult<ResumePlan> {
        let dir = self.root.join(dir_name);
        let entries = match std::fs::read_dir(&dir) {
            Ok(rd) => rd
                .filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .collect::<Vec<_>>(),
            Err(_) => {
                return Err(StoreError::new(
                    "TASK_NOT_FOUND",
                    "漫画目录不存在",
                    serde_json::json!({ "comicName": dir_name, "outputDir": dir.to_string_lossy() }),
                ))
            }
        };
        let mut originals: Vec<(i64, String, i64, String)> = Vec::new();
        let mut translated: Vec<i64> = Vec::new();
        for f in entries {
            if let Some(seq) = match_original(&f) {
                let byte_size = std::fs::metadata(dir.join(&f)).map(|m| m.len() as i64).unwrap_or(0);
                let ext = f.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
                originals.push((seq, ext, byte_size, f));
                continue;
            }
            if let Some(seq) = match_translated(&f) {
                translated.push(seq);
            }
        }
        originals.sort_by_key(|x| x.0);
        translated.sort_unstable();
        translated.dedup();

        let pendings: Vec<ResumePending> = originals
            .iter()
            .filter(|(seq, _, _, _)| !translated.contains(seq))
            .map(|(seq, ext, byte_size, name)| ResumePending {
                seq: *seq,
                ext: ext.clone(),
                byte_size: *byte_size,
                original_file: name.clone(),
            })
            .collect();

        Ok(ResumePlan {
            comic_name: dir_name.to_string(),
            dir_name: dir_name.to_string(),
            output_dir: dir.to_string_lossy().into_owned(),
            image_count: originals.len(),
            translated_count: translated.len(),
            pending_count: pendings.len(),
            pendings,
            translated_seqs: translated,
        })
    }

    /// 返工计划：目录里**所有有原图的页**（不论是否已有译文）。
    pub fn retranslate_plan(&self, dir_name: &str) -> SResult<RetranslatePlan> {
        let plan = self.resume_plan(dir_name)?;
        let dir = self.root.join(dir_name);
        let mut candidates: Vec<RetranslateCandidate> = Vec::new();
        for f in self.list_dir(&dir) {
            let seq = match match_original(&f) {
                Some(s) => s,
                None => continue,
            };
            let byte_size = std::fs::metadata(dir.join(&f)).map(|m| m.len() as i64).unwrap_or(0);
            let ext = f.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            candidates.push(RetranslateCandidate {
                seq,
                ext,
                byte_size,
                original_file: f,
                had_translation: plan.translated_seqs.contains(&seq),
            });
        }
        candidates.sort_by_key(|c| c.seq);
        Ok(RetranslatePlan {
            comic_name: dir_name.to_string(),
            dir_name: dir_name.to_string(),
            output_dir: dir.to_string_lossy().into_owned(),
            image_count: plan.image_count,
            translated_count: plan.translated_count,
            retranslate_count: candidates.len(),
            overwrite_count: candidates.iter().filter(|c| c.had_translation).count(),
            candidates,
        })
    }

    // ---------------------------------------------------------------- 漫画库「隐藏」

    /// 已隐藏的漫画名（排序）。⚠️ Node 用 `localeCompare(..., 'zh-Hans-CN')`（ICU 拼音序），
    /// Rust std 无 locale collation ⇒ 这里按**码位序**。纯英文名两边一致；中文名顺序可能不同，
    /// 属**已知偏离**（影响「管理已隐藏」列表的展示次序，不影响集合成员）。
    pub fn hidden_comics_view(&self) -> Vec<String> {
        let mut v = self.hidden_comics.clone();
        v.sort();
        v
    }

    pub fn hide_comic(&mut self, comic_name: &str) -> Vec<String> {
        if !self.hidden_comics.iter().any(|x| x == comic_name) {
            self.hidden_comics.push(comic_name.to_string());
            self.persist_hidden();
        }
        self.hidden_comics_view()
    }

    pub fn unhide_comic(&mut self, comic_name: &str) -> Vec<String> {
        let before = self.hidden_comics.len();
        self.hidden_comics.retain(|x| x != comic_name);
        if self.hidden_comics.len() != before {
            self.persist_hidden();
        }
        self.hidden_comics_view()
    }

    /// 目录被真删掉时顺手清掉隐藏记录（否则同名漫画日后重建会被无声跳过）。
    pub fn forget_hidden(&mut self, comic_name: &str) {
        let before = self.hidden_comics.len();
        self.hidden_comics.retain(|x| x != comic_name);
        if self.hidden_comics.len() != before {
            self.persist_hidden();
        }
    }

    fn persist_hidden(&self) {
        #[derive(Serialize)]
        struct HiddenFile {
            comics: Vec<String>,
        }
        let file = paths::hidden_comics_file();
        if let Some(dir) = file.parent() {
            let _ = mkdir_p(dir, 0o700);
        }
        if let Ok(body) = serde_json::to_string_pretty(&HiddenFile { comics: self.hidden_comics_view() }) {
            if let Err(e) = std::fs::write(&file, body) {
                // 写不进盘不该让这次隐藏失败（内存已生效），但必须说一声。
                eprintln!("[box-service] ⚠ 隐藏清单写入失败（内存已生效，重启后会丢失）：{e}");
            }
        }
    }

    // ---------------------------------------------------------------- 幂等表

    /// 键命中且未过期（>24h 视为过期并删除）——复刻 `_idempotencyHit`。
    pub fn idempotency_hit(&mut self, key: Option<&str>) -> Option<IdemEntry> {
        let key = key?;
        let idx = self.idempotency.iter().position(|e| e.key == key)?;
        if model::now_ms() - self.idempotency[idx].at > 24 * 3600 * 1000 {
            self.idempotency.remove(idx);
            return None;
        }
        Some(self.idempotency[idx].clone())
    }

    /// 记一笔幂等（F3-b 的建单/追加消费）。
    #[allow(dead_code)]
    fn remember_idempotency(&mut self, key: &str, task_id: &str, batch_index: i64) {
        let rec = IdemEntry {
            key: key.to_string(),
            task_id: task_id.to_string(),
            batch_index,
            at: model::now_ms(),
        };
        if let Some(e) = self.idempotency.iter_mut().find(|e| e.key == key) {
            *e = rec;
        } else {
            self.idempotency.push(rec);
        }
        // 🔴 Node 这里是**裸 writeFileSync**（非原子）——本轮照搬以保一致；原子写那条路径由
        //    `state/tasks/*.json` 单独覆盖（见 F3-a 的对照钉子），不在此扩大范围。
        if let Ok(body) = serde_json::to_string_pretty(&IdemFile(&self.idempotency)) {
            let _ = std::fs::write(paths::idempotency_file(), body);
        }
    }

    // ---------------------------------------------------------------- 持久化

    pub(crate) fn record_of<'a>(&self, task: &'a Task) -> model::TaskRecord<'a> {
        record_of(task)
    }

    /// 复刻 `serialize()`（字段序即 `TaskRecord` 的字段序）。
    pub fn serialize(&self, task: &Task) -> serde_json::Value {
        serde_json::to_value(record_of(task)).unwrap_or(serde_json::Value::Null)
    }

    /// 原子写整份任务清单（失败不影响主路径 —— 与 Node 同）。
    pub fn persist_now(&self, task: &Task) {
        persist_task(task);
    }

    // ---------------------------------------------------------------- 视图

    pub fn progress_of(&self, task: &Task) -> Progress {
        progress_of(task)
    }

    pub fn create_view(&self, task: &Task) -> CreateView {
        let eta = self.eta_for(task);
        create_view(task, eta)
    }

    pub fn detail_view(&self, task: &Task, items_from: Option<i64>, items_to: Option<i64>) -> DetailView {
        let eta = self.eta_for(task);
        detail_view(task, eta, items_from, items_to)
    }

    pub fn list_view(&self, task: &Task) -> ListView {
        list_view(task)
    }

    /// 心跳用：推进**全局**事件序号并返回新值（复刻 Node `++this.eventSeq`）。
    ///
    /// 🔴 心跳**不进** `task.events`（环形日志）—— 它只是"连接还活着"的信号，
    ///    进日志会把 2 万条上限撑爆、并把 Last-Event-ID 续传的可见窗口挤没。
    pub fn bump_event_seq(&mut self) -> u64 {
        self.event_seq += 1;
        self.event_seq
    }

    /// §5.7 队列快照。
    pub fn queue_snapshot(&self) -> QueueSnapshot {
        let running = self.current_task().map(|t| {
            let p = self.progress_of(t);
            QueueRunning {
                task_id: t.task_id.clone(),
                comic_name: t.comic_name.clone(),
                progress: RunningProgress { done: p.done, total: p.total },
            }
        });
        let queued = self
            .queue
            .iter()
            .enumerate()
            .filter_map(|(i, id)| self.get_task(id).map(|t| (i, t)))
            .map(|(i, t)| QueueRow {
                task_id: t.task_id.clone(),
                comic_name: t.comic_name.clone(),
                position: i + 1,
                image_count: self.all_items(t).len(),
                eta_seconds: self.eta_seconds_for(t),
            })
            .collect();
        QueueSnapshot { running, queued, updated_at: model::now_iso() }
    }

    /// 任务列表：运行中 → 排队中 → 终态（终态按 finishedAt 倒序）。
    pub fn task_list_view(&self, status: Option<&str>, limit: Option<i64>) -> TaskListSnapshot {
        let running: Vec<&Task> = self.tasks.iter().filter(|t| t.status == "running").collect();

        let mut queued: Vec<&Task> = self.queue.iter().filter_map(|id| self.get_task(id)).collect();
        let seen: Vec<&str> = queued.iter().map(|t| t.task_id.as_str()).collect();
        for t in &self.tasks {
            if t.status == "queued" && !seen.contains(&t.task_id.as_str()) {
                queued.push(t);
            }
        }

        let mut terminal: Vec<&Task> =
            self.tasks.iter().filter(|t| is_task_terminal(&t.status)).collect();
        terminal.sort_by(|a, b| {
            let ka = model::ts_of(a.finished_at.as_deref().unwrap_or(&a.created_at));
            let kb = model::ts_of(b.finished_at.as_deref().unwrap_or(&b.created_at));
            kb.cmp(&ka)
        });

        let mut rows: Vec<&Task> = Vec::new();
        rows.extend(running.iter().copied());
        rows.extend(queued.iter().copied());
        rows.extend(terminal.iter().copied());

        if let Some(st) = status {
            if st != "all" {
                let want: Vec<&str> =
                    st.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
                rows.retain(|t| want.contains(&t.status.as_str()));
            }
        }

        let total = rows.len();
        let limited: Vec<&Task> = match limit {
            Some(l) if l > 0 => rows.into_iter().take(l as usize).collect(),
            _ => rows,
        };

        TaskListSnapshot {
            count: limited.len(),
            total,
            running: running.len(),
            queued: queued.len(),
            tasks: limited.iter().map(|t| self.list_view(t)).collect(),
            updated_at: model::now_iso(),
        }
    }

    // ---------------------------------------------------------------- eta

    /// 记一笔耗时样本（F3-b 的 `_processItem` 消费）。
    #[allow(dead_code)]
    fn record_duration(&mut self, ms: f64) {
        if !ms.is_finite() {
            return;
        }
        self.durations.push_back(ms);
        if self.durations.len() > model::ETA_SAMPLE_WINDOW {
            self.durations.pop_front();
        }
    }

    fn avg_duration(&self) -> Option<f64> {
        if self.durations.is_empty() {
            return None;
        }
        Some(self.durations.iter().sum::<f64>() / self.durations.len() as f64)
    }

    /// 前方剩余总张数。
    pub fn ahead_count_for(&self, task: &Task) -> usize {
        if task.status == "running" || task.queue_position == Some(0) {
            return self.pending_count(task);
        }
        let mut n = 0usize;
        if let Some(running) = self.current_task() {
            if running.task_id != task.task_id {
                n += self.pending_count(running);
            }
        }
        for id in &self.queue {
            if id == &task.task_id {
                break;
            }
            if let Some(t) = self.get_task(id) {
                n += self.pending_count(t);
            }
        }
        n
    }

    /// §5.2 的 eta 对象；`MIAO_ETA_NULL=1` 时恒为 `null`；**无历史样本时仍是 1–3 分钟区间**。
    pub fn eta_for(&self, task: &Task) -> Option<Eta> {
        if self.env.eta_null {
            return None;
        }
        let avg = match self.avg_duration() {
            Some(a) => a,
            None => return Some(self.eta_fallback()),
        };
        let ahead = self.ahead_count_for(task) as f64;
        let base = avg * ahead / 1000.0;
        let min = std::cmp::max(1, (base * 0.8).round() as i64);
        let max = std::cmp::max(min + 1, (base * 1.5).round() as i64);
        Some(Eta { min_seconds: min, max_seconds: max, text: pure::format_eta_text(min, max) })
    }

    /// 无历史样本（首跑）时的区间 —— 与 `etaFor` 里的常量一致（`formatEtaText(60,180)`）。
    pub fn eta_fallback(&self) -> Eta {
        Eta { min_seconds: 60, max_seconds: 180, text: pure::format_eta_text(60, 180) }
    }

    /// §5.7 的 etaSeconds；无样本时同样返回 1–3 分钟区间。
    pub fn eta_seconds_for(&self, task: &Task) -> Option<EtaSeconds> {
        self.eta_for(task).map(|eta| EtaSeconds {
            min: eta.min_seconds,
            max: eta.max_seconds,
            text: eta.text,
        })
    }
}

// ------------------------------------------------------------------ 落盘原图（`_writeOriginal`）

/// 只把**原图**写下去：安全校验 + 惰性 mkdir + 独占写入，**永不覆盖**（契约 §7.2）。
///
/// 它同时是**撤暂存的唯一时机**：只有原图确实落盘后才撤 —— 降级路径（抛错）会跳过它，
/// 于是暂存那份被留下，正是我们要的兜底。
fn write_original(
    root: &Path,
    task_id: &str,
    dir_name: &str,
    disk_full: bool,
    item: &mut Item,
    bytes: &[u8],
) -> SResult<()> {
    if !pure::is_safe_dir_name(dir_name) {
        return Err(StoreError::new(
            "PERMISSION_DENIED",
            "漫画名含路径成分，拒绝落盘",
            serde_json::json!({ "dirName": dir_name }),
        ));
    }
    if disk_full {
        return Err(StoreError::new(
            "DISK_FULL",
            "ENOSPC: no space left on device（MIAO_DISK_FULL 演练）",
            serde_json::json!({}),
        ));
    }
    let dir = root.join(dir_name);
    let original = format!("{}.{}", seq3(item.seq), item.ext);
    if !is_valid_file_name(&original) {
        return Err(StoreError::new(
            "PERMISSION_DENIED",
            "服务端生成的文件名不合法",
            serde_json::json!({ "original": original }),
        ));
    }
    let deny = |e: paths::PathEscapeError| {
        StoreError::new("PERMISSION_DENIED", e.to_string(), serde_json::json!({ "dirName": dir_name }))
    };
    paths::assert_inside_root(root, &dir.join(&original)).map_err(deny)?;
    if !dir.exists() {
        let _ = mkdir_p(&dir, 0o700);
    }
    let original_path = dir.join(&original);
    paths::assert_inside_root(root, &original_path).map_err(deny)?;

    if original_path.exists() {
        // 原图已在磁盘上：**永不覆盖**。但「已存在」必须是**同一份字节**；不同 ⇒ seq 撞号，报 409。
        let on_disk = std::fs::read(&original_path).unwrap_or_default();
        if on_disk != bytes {
            return Err(StoreError::new(
                "SEQUENCE_OVERFLOW",
                format!("序号 {} 已被另一张原图占用（内容不一致），拒绝覆盖", seq3(item.seq)),
                serde_json::json!({
                    "seq": item.seq, "dirName": dir_name,
                    "onDiskBytes": on_disk.len(), "newBytes": bytes.len()
                }),
            ));
        }
    } else {
        create_private(&original_path, 0o600)
            .and_then(|mut f| f.write_all(bytes))
            .map_err(io_err)?;
    }
    item.original_file = Some(original);
    // G-12：到这一行，该页原图已**确认**在漫画目录里 —— 暂存那份的使命结束。
    if let Ok(p) = stage_path_for(task_id, item.seq) {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

fn stage_path_for(task_id: &str, seq: i64) -> SResult<PathBuf> {
    if !model::is_valid_task_id(task_id) {
        return Err(StoreError::new("PERMISSION_DENIED", "taskId 形状不合法", serde_json::json!({})));
    }
    Ok(paths::pending_dir().join(task_id).join(format!("{}.bin", seq3(seq))))
}

// ------------------------------------------------------------------ 落盘记录（自由函数版）
//
// 为什么要有自由版：F3-b 的 `exec.rs` 在「持有 `&mut Task`」的同时要落盘，
// 而方法版需要 `&self` 与那个 `&mut Task` 同存 ⇒ 借用冲突。两者逻辑同一份，方法只是转发。

/// 复刻 `serialize()` 的记录（字段序即 `TaskRecord` 的字段序）。
pub(crate) fn record_of(task: &Task) -> model::TaskRecord<'_> {
    model::TaskRecord {
        task_id: &task.task_id,
        comic_name: &task.comic_name,
        normalized_comic_name: &task.normalized_comic_name,
        dir_name: &task.dir_name,
        output_dir: &task.output_dir,
        status: &task.status,
        lang: &task.lang,
        translator: &task.translator,
        client_task_ref: &task.client_task_ref,
        source: &task.source,
        idempotency_key: &task.idempotency_key,
        created_at: &task.created_at,
        finished_at: &task.finished_at,
        final_progress: progress_of(task),
        batches: &task.batches,
    }
}

/// 原子写整份任务清单（失败不影响主路径 —— 与 Node 同）。
pub(crate) fn persist_task(task: &Task) {
    let file = paths::tasks_state_dir().join(format!("{}.json", task.task_id));
    let _ = atomic_write_json(&file, &record_of(task));
}

// ------------------------------------------------------------------ 原子写（复刻 atomic-file.mjs）

/// 原子写 JSON：同目录 tmp → fsync → rename 覆盖。正文 = `JSON.stringify(value, null, 2) + '\n'`。
pub fn atomic_write_json<T: Serialize>(file: &Path, value: &T) -> std::io::Result<()> {
    let mut body = serde_json::to_string_pretty(value)?;
    body.push('\n');
    atomic_write_text(file, &body, 0o600)
}

/// 原子写任意文本。失败时**尽力清理 tmp 后原样抛出** —— 不掩盖原始错误。
///
/// 🔴 为什么必须有它：`rename` 在 POSIX 与 Windows 上都是**原子**的，而直接覆写不是 ——
///    崩在中间会留下**半截 JSON**，下次启动读成损坏 ⇒「刚存的东西没了」，且正常退出路径下测不到。
pub fn atomic_write_text(file: &Path, text: &str, mode: u32) -> std::io::Result<()> {
    // 🔴 反证开关（只被 `e2e/service/store-parity-check.mjs --refute` 设置，产品路径永不设置）：
    //    把原子写退化成**直接覆写** ⇒ 中断模拟会污染目标文件 ⇒ `atomic.targetIntactAfterAbort`
    //    必须变红。它证明断言测的**确实是 tmp+rename 这条机制**，而不是「碰巧绿」。
    if atomic_is_direct() {
        return direct_write(file, text, mode);
    }
    if let Some(dir) = file.parent() {
        mkdir_p(dir, 0o700)?;
    }
    let tmp = tmp_path(file);
    let res = (|| -> std::io::Result<()> {
        let mut f = create_private(&tmp, mode)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, file)?;
        Ok(())
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

/// 反证开关是否打开（见 `atomic_write_text` 处）。
pub(crate) fn atomic_is_direct() -> bool {
    std::env::var("MIAO_ATOMIC_DIRECT_WRITE")
        .map(|v| !matches!(v.as_str(), "" | "0" | "false"))
        .unwrap_or(false)
}

/// 退化的「直接覆写」——只服务反证轮，绝不在产品路径出现。
pub(crate) fn direct_write(file: &Path, text: &str, mode: u32) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        mkdir_p(dir, 0o700)?;
    }
    let mut f = create_private(file, mode)?;
    f.write_all(text.as_bytes())
}

/// `${file}.tmp-${pid}-${Date.now()}`（与 `atomic-file.mjs` 及 `translate-check` 的残留扫描口径 `.tmp-` 一致）。
fn tmp_path(file: &Path) -> PathBuf {
    PathBuf::from(format!(
        "{}.tmp-{}-{}",
        file.to_string_lossy(),
        std::process::id(),
        model::now_ms()
    ))
}

fn read_json(file: &Path) -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(file).ok()?;
    serde_json::from_str(&raw).ok()
}

fn io_err(e: std::io::Error) -> StoreError {
    StoreError::new(
        "INTERNAL",
        format!("IO 错误：{e}"),
        serde_json::json!({ "kind": format!("{:?}", e.kind()) }),
    )
}

fn create_private(path: &Path, mode: u32) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    opts.open(path)
}

/// **独占**创建（Node `flag:'wx'` 的对应物）：文件已存在即 `AlreadyExists`/EEXIST。
/// 「不覆盖」的硬保证靠它 —— 用 `truncate(true)` 会**静默覆盖**，把一条 409 变成一次数据丢失。
pub(crate) fn create_new_private(path: &Path, mode: u32) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    opts.open(path)
}

/// 覆盖写（Node `flag:'w'` 的对应物）—— 仅返工重译的译文允许。
pub(crate) fn write_file_private(path: &Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    let mut f = create_private(path, mode)?;
    f.write_all(bytes)
}

/// 独占写（Node `flag:'wx'`）—— 已存在即失败。
pub(crate) fn write_new_private(path: &Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    let mut f = create_new_private(path, mode)?;
    f.write_all(bytes)
}

/// `std::io::Error` → Node 风格的 `errno` 串（够 `DEGRADABLE_WRITE_ERRNOS` 判定用）。
pub(crate) fn errno_code(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::AlreadyExists => "EEXIST".to_string(),
        std::io::ErrorKind::PermissionDenied => "EACCES".to_string(),
        std::io::ErrorKind::NotFound => "ENOENT".to_string(),
        _ => e.raw_os_error().map(|c| format!("errno{c}")).unwrap_or_else(|| "INTERNAL".to_string()),
    }
}

/// 独占写失败时按 errno 构造 `StoreError`（供 F3-b 的「可降级」判定）。
pub(crate) fn io_errno(e: std::io::Error) -> StoreError {
    let code = errno_code(&e);
    StoreError::new(&code, format!("IO 错误：{e}"), serde_json::json!({ "errno": code }))
}

fn mkdir_p(dir: &Path, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut b = std::fs::DirBuilder::new();
        b.recursive(true).mode(mode);
        return b.create(dir);
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
        std::fs::create_dir_all(dir)
    }
}

// 让 F3-b 会消费的私有项不触发 dead_code（显式标注，便于 review 时一眼看清哪些是「kernel API」）。

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join(format!("miao-store-{tag}-{}-{}", std::process::id(), model::now_ms()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn mk_item(seq: i64) -> Item {
        Item {
            seq,
            ext: "png".into(),
            mime: "image/png".into(),
            byte_size: 3,
            from_disk: false,
            overwrite: false,
            status: "pending".into(),
            saved: false,
            original_file: None,
            output_file: None,
            sha256: None,
            duration_ms: None,
            retry_count: 0,
            reason: None,
            error_message: None,
        }
    }

    #[test]
    fn atomic_write_replaces_completely_and_leaves_no_tmp() {
        let dir = tmpdir("atomic-ok");
        let file = dir.join("a.json");
        atomic_write_json(&file, &serde_json::json!({ "v": 1 })).unwrap();
        atomic_write_json(&file, &serde_json::json!({ "v": 2 })).unwrap();
        let body = std::fs::read_to_string(&file).unwrap();
        assert_eq!(body, "{\n  \"v\": 2\n}\n");
        let residue: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(residue.is_empty(), "原子写留下残留：{residue:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn target_stays_intact_when_rename_never_happens() {
        // 反证的核心：tmp 写入成功但**尚未 rename** 时，目标文件必须**仍是旧内容**（绝不成半截）。
        let dir = tmpdir("atomic-interrupt");
        let file = dir.join("t.json");
        atomic_write_json(&file, &serde_json::json!({ "v": "old" })).unwrap();
        let before = std::fs::read_to_string(&file).unwrap();

        let tmp = tmp_path(&file);
        let mut f = create_private(&tmp, 0o600).unwrap();
        f.write_all(b"{\n  \"v\": \"half").unwrap();
        f.sync_all().unwrap();
        drop(f);

        let after = std::fs::read_to_string(&file).unwrap();
        assert_eq!(before, after, "目标文件被半截写污染");
        assert!(after.contains("\"old\""), "目标文件内容被改动：{after}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resume_plan_separates_missing_and_translated() {
        let dir = tmpdir("resume");
        let root = dir.join("root");
        let comic = root.join("夏日重现");
        std::fs::create_dir_all(&comic).unwrap();
        std::fs::write(comic.join("001.png"), b"aaa").unwrap();
        std::fs::write(comic.join("002.jpg"), b"bbbb").unwrap();
        std::fs::write(comic.join("003_translated.png"), b"zz").unwrap();
        std::fs::write(comic.join("cover.jpg"), b"c").unwrap(); // 非页文件名，必须忽略

        let store = Store::new(&root);
        let plan = store.resume_plan("夏日重现").unwrap();
        assert_eq!(plan.image_count, 2, "原图应只数 001/002");
        assert_eq!(plan.translated_count, 1);
        assert_eq!(plan.pending_count, 2);
        assert_eq!(plan.pendings.iter().map(|p| p.seq).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(plan.pendings[0].byte_size, 3);
        assert_eq!(plan.translated_seqs, vec![3]);

        let rt = store.retranslate_plan("夏日重现").unwrap();
        assert_eq!(rt.retranslate_count, 2);
        assert_eq!(rt.overwrite_count, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn next_seq_counts_disk_and_reserved() {
        let dir = tmpdir("nextseq");
        let root = dir.join("root");
        std::fs::create_dir_all(root.join("书")).unwrap();
        std::fs::write(root.join("书").join("005.png"), b"x").unwrap();
        let store = Store::new(&root);
        assert_eq!(store.next_seq_for("书"), 6);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_original_never_overwrites_but_accepts_identical_bytes() {
        let dir = tmpdir("writeorig");
        let root = dir.join("root");
        std::fs::create_dir_all(root.join("书")).unwrap();
        let tid = "tsk_0123456789ABCDEFGHJKMNPQRS";
        let mut item = mk_item(1);
        write_original(&root, tid, "书", false, &mut item, b"abc").unwrap();
        assert_eq!(item.original_file.as_deref(), Some("001.png"));
        // 同一份字节 ⇒ 放行
        write_original(&root, tid, "书", false, &mut item, b"abc").unwrap();
        // 不同字节 ⇒ 409 SEQUENCE_OVERFLOW
        let e = write_original(&root, tid, "书", false, &mut item, b"xyz").unwrap_err();
        assert_eq!(e.code, "SEQUENCE_OVERFLOW");
        // 危险目录名 ⇒ 403
        let e2 = write_original(&root, tid, "../evil", false, &mut item, b"abc").unwrap_err();
        assert_eq!(e2.code, "PERMISSION_DENIED");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
