// store 的**视图层**：把运行期模型投影成 HTTP 响应体（F3）
//
// 搬自 `service/src/manga/store.mjs` 的「视图」小节。字段序 = Node 的 `JSON.stringify` 输出序，
// 因此这里的结构体一律**不跳过** null（`Option::None` 序列化成 `null`，与 Node 的 `|| null` 同）。
use serde::Serialize;

use super::model::{Batch, Item, Progress, Task};

// ------------------------------------------------------------------ 子结构

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchBrief {
    pub batch_index: i64,
    pub count: i64,
    pub seq_from: i64,
    pub seq_to: i64,
    pub status: String,
}

pub fn batch_brief(b: &Batch) -> BatchBrief {
    BatchBrief {
        batch_index: b.batch_index,
        count: b.count,
        seq_from: b.seq_from,
        seq_to: b.seq_to,
        status: b.status.clone(),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemBrief {
    pub seq: i64,
    pub status: String,
    pub saved: bool,
    pub output_file: Option<String>,
    pub duration_ms: Option<i64>,
    pub retry_count: i64,
    pub reason: Option<String>,
    pub sha256: Option<String>,
}

pub fn item_brief(i: &Item) -> ItemBrief {
    ItemBrief {
        seq: i.seq,
        status: i.status.clone(),
        saved: i.saved,
        output_file: i.output_file.clone(),
        duration_ms: i.duration_ms,
        retry_count: i.retry_count,
        reason: i.reason.clone(),
        sha256: i.sha256.clone(),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Eta {
    pub min_seconds: i64,
    pub max_seconds: i64,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EtaSeconds {
    pub min: i64,
    pub max: i64,
    pub text: String,
}

// ------------------------------------------------------------------ 进度

/// 复刻 `progressOf`。
pub fn progress_of(task: &Task) -> Progress {
    let mut total = 0usize;
    let mut done = 0usize;
    let mut failed = 0usize;
    let mut current = 0i64;
    for b in &task.batches {
        for i in &b.items {
            total += 1;
            if i.status == "success" || i.status == "skipped" {
                done += 1;
            } else if i.status == "failed" {
                failed += 1;
            } else if i.status == "translating" && current == 0 {
                current = i.seq;
            }
        }
    }
    Progress { total, done, failed, current }
}

// ------------------------------------------------------------------ 三档视图

/// §5.2 / §5.3 的创建与追加响应。`queuePosition` 缺省即省略（复刻 Node 的 `undefined` 语义）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateView {
    pub task_id: String,
    pub comic_name: String,
    pub normalized_comic_name: String,
    pub output_dir: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_position: Option<i64>,
    pub batches: Vec<BatchBrief>,
    pub eta: Option<Eta>,
    pub created_at: String,
}

pub fn create_view(task: &Task, eta: Option<Eta>) -> CreateView {
    CreateView {
        task_id: task.task_id.clone(),
        comic_name: task.comic_name.clone(),
        normalized_comic_name: task.normalized_comic_name.clone(),
        output_dir: task.output_dir.clone(),
        status: task.status.clone(),
        queue_position: task.queue_position,
        batches: task.batches.iter().map(batch_brief).collect(),
        eta,
        created_at: task.created_at.clone(),
    }
}

/// §5.4 的任务详情。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailView {
    pub task_id: String,
    pub comic_name: String,
    pub normalized_comic_name: String,
    pub output_dir: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_position: Option<i64>,
    pub progress: Progress,
    pub batches: Vec<BatchBrief>,
    pub items: Vec<ItemBrief>,
    pub eta: Option<Eta>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

pub fn detail_view(
    task: &Task,
    eta: Option<Eta>,
    items_from: Option<i64>,
    items_to: Option<i64>,
) -> DetailView {
    let items = task
        .batches
        .iter()
        .flat_map(|b| b.items.iter())
        .filter(|i| items_from.map(|f| i.seq >= f).unwrap_or(true))
        .filter(|i| items_to.map(|t| i.seq <= t).unwrap_or(true))
        .map(item_brief)
        .collect();
    DetailView {
        task_id: task.task_id.clone(),
        comic_name: task.comic_name.clone(),
        normalized_comic_name: task.normalized_comic_name.clone(),
        output_dir: task.output_dir.clone(),
        status: task.status.clone(),
        queue_position: task.queue_position,
        progress: progress_of(task),
        batches: task.batches.iter().map(batch_brief).collect(),
        items,
        eta,
        created_at: task.created_at.clone(),
        finished_at: task.finished_at.clone(),
    }
}

/// 队列页的一行（列表端点专用，非契约端点）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListView {
    pub task_id: String,
    pub comic_name: String,
    pub normalized_comic_name: String,
    pub source: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_position: Option<i64>,
    pub progress: Progress,
    pub output_dir: String,
    pub created_at: String,
    pub finished_at: Option<String>,
}

pub fn list_view(task: &Task) -> ListView {
    ListView {
        task_id: task.task_id.clone(),
        comic_name: task.comic_name.clone(),
        normalized_comic_name: task.normalized_comic_name.clone(),
        source: if task.source.is_empty() { "unknown".into() } else { task.source.clone() },
        status: task.status.clone(),
        queue_position: task.queue_position,
        progress: progress_of(task),
        output_dir: task.output_dir.clone(),
        created_at: task.created_at.clone(),
        finished_at: task.finished_at.clone(),
    }
}

// ------------------------------------------------------------------ 队列快照 / 任务列表

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueRunning {
    pub task_id: String,
    pub comic_name: String,
    pub progress: RunningProgress,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningProgress {
    pub done: usize,
    pub total: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueRow {
    pub task_id: String,
    pub comic_name: String,
    pub position: usize,
    pub image_count: usize,
    pub eta_seconds: Option<EtaSeconds>,
}

/// §5.7 队列快照。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    pub running: Option<QueueRunning>,
    pub queued: Vec<QueueRow>,
    pub updated_at: String,
}

/// 任务列表（跨重启；终态按 finishedAt 倒序）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListSnapshot {
    pub count: usize,
    pub total: usize,
    pub running: usize,
    pub queued: usize,
    pub tasks: Vec<ListView>,
    pub updated_at: String,
}

// ------------------------------------------------------------------ 计划（续做 / 返工 / 隐藏）

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumePending {
    pub seq: i64,
    pub ext: String,
    pub byte_size: i64,
    pub original_file: String,
}

/// §5.8 的「有原图、缺译文」计划。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumePlan {
    pub comic_name: String,
    pub dir_name: String,
    pub output_dir: String,
    pub image_count: usize,
    pub translated_count: usize,
    pub pending_count: usize,
    pub pendings: Vec<ResumePending>,
    pub translated_seqs: Vec<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetranslateCandidate {
    pub seq: i64,
    pub ext: String,
    pub byte_size: i64,
    pub original_file: String,
    pub had_translation: bool,
}

/// 返工计划：目录里**所有有原图的页**（不论是否已有译文）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetranslatePlan {
    pub comic_name: String,
    pub dir_name: String,
    pub output_dir: String,
    pub image_count: usize,
    pub translated_count: usize,
    pub retranslate_count: usize,
    pub overwrite_count: usize,
    pub candidates: Vec<RetranslateCandidate>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mangasvc::store::model::{Batch, Item, Task};

    fn item(seq: i64, status: &str) -> Item {
        Item {
            seq,
            ext: "png".into(),
            mime: "image/png".into(),
            byte_size: 10,
            from_disk: false,
            overwrite: false,
            status: status.into(),
            saved: status == "success",
            original_file: None,
            output_file: None,
            sha256: None,
            duration_ms: None,
            retry_count: 0,
            reason: None,
            error_message: None,
        }
    }

    fn task_with(items: Vec<Item>) -> Task {
        Task {
            task_id: "tsk_TEST".into(),
            comic_name: "书".into(),
            normalized_comic_name: "书".into(),
            dir_name: "书".into(),
            output_dir: "/root/书".into(),
            status: "running".into(),
            queue_position: Some(0),
            lang: Default::default(),
            translator: "sakura".into(),
            client_task_ref: None,
            source: "unknown".into(),
            idempotency_key: None,
            created_at: "2026-10-13T04:35:29.000Z".into(),
            finished_at: None,
            batches: vec![Batch {
                batch_index: 1,
                count: items.len() as i64,
                seq_from: 1,
                seq_to: items.len() as i64,
                status: "running".into(),
                idempotency_key: None,
                items,
            }],
            events: Vec::new(),
            clients: Default::default(),
            cancel_requested: false,
            last_error: None,
        }
    }

    #[test]
    fn progress_counts_done_failed_current() {
        let t = task_with(vec![item(1, "success"), item(2, "failed"), item(3, "translating"), item(4, "pending")]);
        let p = progress_of(&t);
        assert_eq!((p.total, p.done, p.failed, p.current), (4, 1, 1, 3));
    }

    #[test]
    fn list_view_json_shape_matches_node_key_order() {
        let t = task_with(vec![item(1, "success")]);
        let v = list_view(&t);
        let s = serde_json::to_string(&v).unwrap();
        assert!(
            s.starts_with(r#"{"taskId":"tsk_TEST","comicName":"书","normalizedComicName":"书","source":"unknown","status":"running","queuePosition":0,"progress":"#),
            "字段序漂移：{s}"
        );
    }
}
