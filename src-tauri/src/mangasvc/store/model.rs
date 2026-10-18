// 任务 / 批次 / 单图三层数据模型 + 常量 + 时间与 id 生成（F3）
//
// 搬自 `service/src/manga/store.mjs` 的头部与 `serialize()`。**字段序必须与 Node 的
// `JSON.stringify` 输出逐字节一致** —— 落盘的 `state/tasks/<id>.json` 是迁移期两边共读的
// 事实源，字段顺序一变，Node↔Rust 的对照钉子立刻变红（这正是我们要的护栏）。
//
// 🔴 为什么模型与「持久化记录」分成两套（`Task` vs `TaskRecord`）：
//    运行期模型有 `events` / `clients` / `cancelRequested` 这些**不属于磁盘**的字段
//    （Node 的 `serialize()` 刻意不写它们），而磁盘记录多一个派生字段 `finalProgress`。
//    用一套结构 + `skip` 属性也能做到，但那样「哪些进盘」就散落在属性里、看不出全貌；
//    分开后 `serialize()` 的字段序 = `TaskRecord` 的字段序，一眼可核。
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

// ------------------------------------------------------------------ 常量（与 config.mjs / store.mjs 逐字对齐）

/// 单次提交上限（契约 §3）
pub const BATCH_LIMIT: i64 = 20;
/// 序号上限（契约 §7.2）
pub const MAX_SEQ: i64 = 999;
/// eta 采样窗口：近 N 张已完成 item 的耗时
pub const ETA_SAMPLE_WINDOW: usize = 20;
/// 首次 + 1 次重试（契约 §4.2「重试 N 次后失败」）
pub const MAX_ATTEMPTS: i64 = 2;
/// 重试前的退避间隔（毫秒）
pub const RETRY_BACKOFF_MS: u64 = 400;
/// 单任务事件日志上限
pub const MAX_EVENT_LOG: usize = 20_000;
/// taskId 生成用的 Crockford Base32 字母表（无 I/L/O/U）
pub const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub const TASK_TERMINAL: &[&str] = &["done", "partial_failed", "failed", "canceled"];
pub const ITEM_TERMINAL: &[&str] = &["success", "failed", "skipped"];

/// 允许降级为 `saved:false` 的**落盘/资源**错误（契约 §4.2「落盘失败不阻断主路径」）。
pub const DEGRADABLE_WRITE_ERRNOS: &[&str] =
    &["ENOSPC", "EDQUOT", "EROFS", "EMFILE", "ENFILE", "EEXIST"];

pub fn is_task_terminal(status: &str) -> bool {
    TASK_TERMINAL.contains(&status)
}

pub fn is_item_terminal(status: &str) -> bool {
    ITEM_TERMINAL.contains(&status)
}

pub fn is_degradable_write_errno(code: &str) -> bool {
    DEGRADABLE_WRITE_ERRNOS.contains(&code)
}

// ------------------------------------------------------------------ 语言方向

/// 翻译方向（短码，小写）。字段序 `from, to` 与 Node `normalizeDirection` 一致。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lang {
    pub from: String,
    pub to: String,
}

impl Default for Lang {
    fn default() -> Self {
        Lang { from: "ja".into(), to: "zh".into() }
    }
}

// ------------------------------------------------------------------ 三层模型（运行期）

/// 事件（SSE）。不进持久化（`init()` 恢复时一律清空）。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub id: u64,
    pub event: String,
    pub data: serde_json::Value,
}

/// 单图（运行期）。
///
/// `Serialize` 的**非跳过字段序**刻意等于 `serialize()` 里 items 的字段序：
/// seq, ext, byteSize, fromDisk, status, saved, originalFile, outputFile, sha256,
/// durationMs, retryCount, reason —— `mime` / `overwrite` / `errorMessage` 是运行期专属，跳过。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub seq: i64,
    pub ext: String,
    #[serde(skip_serializing, default)]
    pub mime: String,
    pub byte_size: i64,
    #[serde(default)]
    pub from_disk: bool,
    #[serde(skip_serializing, default)]
    pub overwrite: bool,
    pub status: String,
    pub saved: bool,
    pub original_file: Option<String>,
    pub output_file: Option<String>,
    pub sha256: Option<String>,
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub retry_count: i64,
    pub reason: Option<String>,
    #[serde(skip_serializing, default)]
    pub error_message: Option<String>,
}

/// 批次（运行期）。`Serialize` 字段序 = `serialize()` 里 batches 的字段序。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub batch_index: i64,
    pub count: i64,
    pub seq_from: i64,
    pub seq_to: i64,
    pub status: String,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    pub items: Vec<Item>,
}

/// 任务（运行期）。只实现 `Deserialize`：**持久化**走 `serialize()`（见 `TaskRecord`），
/// 因为 `serialize()` 会派生 `finalProgress` 并剔除运行期字段。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub task_id: String,
    pub comic_name: String,
    #[serde(default)]
    pub normalized_comic_name: String,
    #[serde(default)]
    pub dir_name: String,
    #[serde(default)]
    pub output_dir: String,
    pub status: String,
    /// 🔴 `Option` 而非 `i64`：Node 的 `serialize()` **不写 queuePosition**，于是从盘上恢复的任务
    ///    在 `JSON.stringify` 里该键是 `undefined`（**整键消失**），而在内存里它是数字。
    ///    用 `Option` + 视图侧 `skip_serializing_if` 才能把这个差异也复刻出来。
    #[serde(default)]
    pub queue_position: Option<i64>,
    #[serde(default)]
    pub lang: Lang,
    #[serde(default = "default_translator")]
    pub translator: String,
    #[serde(default)]
    pub client_task_ref: Option<String>,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub finished_at: Option<String>,
    pub batches: Vec<Batch>,

    // ---- 运行期专属（不参与持久化；`init()` 恢复时重建为空/假）----
    #[serde(skip)]
    pub events: Vec<TaskEvent>,
    /// SSE 订阅者（F3-a 未接线，用不透明 id 占位；F5 迁 SSE 时替换为真实响应句柄）
    #[serde(skip)]
    pub clients: std::collections::BTreeSet<u64>,
    #[serde(skip)]
    pub cancel_requested: bool,
    #[serde(skip)]
    pub last_error: Option<String>,
}

fn default_translator() -> String {
    "sakura".into()
}
fn default_source() -> String {
    "unknown".into()
}

impl Task {
    /// 组装 Task 的三层模型骨架（建单与本地续做共用 —— 复刻 `_newTask`）。
    pub fn new(
        comic_name: String,
        dir_name: String,
        source: Option<String>,
        batches: Vec<Batch>,
        lang: Option<Lang>,
        translator: Option<String>,
        client_task_ref: Option<String>,
        idempotency_key: Option<String>,
        root: &std::path::Path,
    ) -> Task {
        Task {
            task_id: format!("tsk_{}", ulid()),
            comic_name,
            normalized_comic_name: dir_name.clone(),
            output_dir: root.join(&dir_name).to_string_lossy().into_owned(),
            dir_name,
            status: "queued".into(),
            queue_position: Some(0),
            lang: lang.unwrap_or_default(),
            translator: translator.unwrap_or_else(default_translator),
            client_task_ref,
            source: source.unwrap_or_else(default_source),
            idempotency_key,
            created_at: now_iso_ms(),
            finished_at: None,
            batches,
            events: Vec::new(),
            clients: std::collections::BTreeSet::new(),
            cancel_requested: false,
            last_error: None,
        }
    }
}

// ------------------------------------------------------------------ 持久化记录（serialize 的字段序）

/// 进度汇总（`progressOf` 的产物）；既是视图字段，也是 `finalProgress`。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub total: usize,
    pub done: usize,
    pub failed: usize,
    pub current: i64,
}

/// 落盘记录：**字段序 = `serialize()`**。借自 `Task`，避免深拷贝整棵批次树。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord<'a> {
    pub task_id: &'a str,
    pub comic_name: &'a str,
    pub normalized_comic_name: &'a str,
    pub dir_name: &'a str,
    pub output_dir: &'a str,
    pub status: &'a str,
    pub lang: &'a Lang,
    pub translator: &'a str,
    pub client_task_ref: &'a Option<String>,
    pub source: &'a str,
    pub idempotency_key: &'a Option<String>,
    pub created_at: &'a str,
    pub finished_at: &'a Option<String>,
    pub final_progress: Progress,
    pub batches: &'a [Batch],
}

// ------------------------------------------------------------------ 时间与 id

/// 当前毫秒（Unix epoch）。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 给人看的 ISO（**截掉毫秒**）—— 复刻 `nowIso()`。
pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// 任务时间戳专用 ISO（**保留毫秒**）—— 复刻 `nowIsoMs()`。
///
/// 🔴 为什么不能复用 [`now_iso`]：它与 `runtimeStartedAtMs`（毫秒）比大小时会引入最多 1 秒
///    的偏斜 —— 「与 Store 构造同一秒内创建的任务」会被判成上一轮的历史而被过滤，于是
///    **这一轮的空闲卸载完全不生效**。两侧必须同精度。
pub fn now_iso_ms() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// ISO → 毫秒；缺失/非法一律 0（排序时排到最后）。复刻 `tsOf`。
pub fn ts_of(iso: &str) -> i64 {
    if iso.is_empty() {
        return 0;
    }
    chrono::DateTime::parse_from_rfc3339(iso).map(|d| d.timestamp_millis()).unwrap_or(0)
}

/// `seq` → 三位零填充（复刻 `seq3`；超过三位不截断）。
pub fn seq3(seq: i64) -> String {
    format!("{seq:03}")
}

/// 26 位 Crockford ULID（10 位时间 + 16 位随机）。格式复刻 `ulid()`；值本身不可比（随机 + 时钟）。
pub fn ulid() -> String {
    let mut ts = now_ms();
    let mut time = [0u8; 10];
    for i in (0..10).rev() {
        time[i] = CROCKFORD[(ts % 32) as usize];
        ts /= 32;
    }
    let mut rnd = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut rnd);
    let mut out = String::with_capacity(26);
    for b in time {
        out.push(b as char);
    }
    for b in rnd {
        out.push(CROCKFORD[(b % 32) as usize] as char);
    }
    out
}

/// taskId 形状（`^tsk_[0-9A-HJKMNP-TV-Z]{26}$`）。
///
/// 🔴 它会拼进暂存目录名（`state/pending/<taskId>/`），适用与 §8.2 校验点 2 同一套纪律：
///    **凡是拼进路径的东西都要能自证形状**，不能因为「它是我们自己造的」就免检。
pub fn is_valid_task_id(id: &str) -> bool {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"^tsk_[0-9A-HJKMNP-TV-Z]{26}$").unwrap());
    re.is_match(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ulid_shape_and_length() {
        let id = ulid();
        assert_eq!(id.len(), 26, "ULID 长度必须是 26：{id}");
        assert!(id.bytes().all(|b| CROCKFORD.contains(&b)), "含非法字符：{id}");
        assert!(is_valid_task_id(&format!("tsk_{id}")));
    }

    #[test]
    fn task_id_rejects_bad_shapes() {
        assert!(!is_valid_task_id("tsk_short"));
        assert!(!is_valid_task_id("tsk_IIIIIIIIIIIIIIIIIIIIIIIIII")); // I 不在 Crockford 表
        assert!(!is_valid_task_id(""));
    }

    #[test]
    fn seq3_pads_but_never_truncates() {
        assert_eq!(seq3(1), "001");
        assert_eq!(seq3(42), "042");
        assert_eq!(seq3(999), "999");
        assert_eq!(seq3(1000), "1000");
    }

    #[test]
    fn ts_of_invalid_is_zero() {
        assert_eq!(ts_of(""), 0);
        assert_eq!(ts_of("not-a-date"), 0);
        assert!(ts_of("2026-10-13T04:35:29.123Z") > 0);
    }

    #[test]
    fn item_serialize_omits_runtime_only_fields() {
        let it = Item {
            seq: 1,
            ext: "png".into(),
            mime: "image/png".into(),
            byte_size: 3,
            from_disk: false,
            overwrite: true,
            status: "success".into(),
            saved: true,
            original_file: Some("001.png".into()),
            output_file: Some("001_translated.png".into()),
            sha256: None,
            duration_ms: Some(12),
            retry_count: 0,
            reason: None,
            error_message: Some("boom".into()),
        };
        let s = serde_json::to_string(&it).unwrap();
        // 🔴 mime / overwrite / errorMessage 绝不进盘；字段序 = serialize() 的 items 序
        assert_eq!(
            s,
            r#"{"seq":1,"ext":"png","byteSize":3,"fromDisk":false,"status":"success","saved":true,"originalFile":"001.png","outputFile":"001_translated.png","sha256":null,"durationMs":12,"retryCount":0,"reason":null}"#
        );
    }
}
