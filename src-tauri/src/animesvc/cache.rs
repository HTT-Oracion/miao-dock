//! 缓存与下载管理（R3）：任务状态机 + HTTP 直链分段下载 + 原子落盘。
//!
//! ## 状态机
//! `downloading → done | paused | failed`；`paused → downloading`（续传）；任何状态可 `delete`。
//! `seeding` 预留给 BT（R5），本层不产生它。
//!
//! ## 为什么 `.part` 而不是临时目录
//! 断点续传要的只是"已经拿到多少字节"，一个同名 `.part` 就够；收尾用 `rename`（同一分区内原子），
//! 半截文件永远不会以正式名字出现。
//!
//! ## 落盘与目录
//! 任务表固定写 `<state>/cache.json`（**原子写**：`.tmp` + `rename`）—— 改缓存目录不该丢任务表。
//! 每个任务的 `file` 是**绝对路径**（添加时就定死）：换目录只影响新任务，老任务仍指向原来的文件。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const CACHE_FILE: &str = "cache.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheTask {
    pub id: String,
    pub subject_id: String,
    pub episode_index: f64,
    pub title: String,
    /// 源地址（HTTP 直链；BT 走 R5 的另一条路）
    pub url: String,
    /// 正式文件的**绝对路径**（完成前不存在，只有同名 `.part`）
    pub file: String,
    /// `downloading` / `paused` / `done` / `failed` / `seeding`
    pub state: String,
    #[serde(default)]
    pub received_bytes: u64,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn state_file() -> PathBuf {
    crate::platform::paths::anime_state_dir().join(CACHE_FILE)
}

/// 默认缓存目录（设置没给 `cacheDir` 时用它）。
fn default_cache_dir() -> PathBuf {
    crate::platform::paths::anime_state_dir().join("cache")
}

/// 任务表 + 停止旗标。`tasks` 是唯一事实源，`stops` 只活在进程内（重启后"下载中"一律变 `paused`）。
pub struct Cache {
    tasks: Mutex<Vec<CacheTask>>,
    stops: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn shared() -> &'static Arc<Cache> {
    static INSTANCE: OnceLock<Arc<Cache>> = OnceLock::new();
    INSTANCE.get_or_init(|| Arc::new(Cache::load()))
}

impl Cache {
    fn load() -> Cache {
        let mut tasks: Vec<CacheTask> = std::fs::read_to_string(state_file())
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        // 重启后没有下载线程：`downloading` 一律回落 `paused`，等用户点继续
        for t in tasks.iter_mut() {
            if t.state == "downloading" {
                t.state = "paused".into();
            }
            t.received_bytes = on_disk(&t.file);
        }
        Cache {
            tasks: Mutex::new(tasks),
            stops: Mutex::new(HashMap::new()),
        }
    }

    fn save(&self, tasks: &[CacheTask]) -> Result<(), String> {
        let text = serde_json::to_string_pretty(tasks).map_err(|e| format!("序列化缓存失败：{e}"))?;
        let path = state_file();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("建状态目录失败：{e}"))?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text).map_err(|e| format!("写缓存失败：{e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("替换缓存失败：{e}"))
    }

    fn snapshot(&self) -> Vec<CacheTask> {
        self.tasks.lock().map(|t| t.clone()).unwrap_or_default()
    }

    fn update<F: FnOnce(&mut CacheTask)>(&self, id: &str, f: F) {
        let Ok(mut tasks) = self.tasks.lock() else { return };
        if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
            f(t);
            t.updated_at = now_ms();
        }
        let snapshot = tasks.clone();
        drop(tasks);
        let _ = self.save(&snapshot);
    }
}

fn part_path(file: &str) -> PathBuf {
    Path::new(file).with_extension("part")
}

/// 盘上已有多少字节：`.part` 优先，已完成则看正式文件。
fn on_disk(file: &str) -> u64 {
    std::fs::metadata(part_path(file))
        .or_else(|_| std::fs::metadata(file))
        .map(|m| m.len())
        .unwrap_or(0)
}

/// 列出全部任务（进度以盘上为准，避免内存值与实际不符）。
pub fn list() -> Result<Value, String> {
    let c = shared();
    let mut tasks = c.snapshot();
    for t in tasks.iter_mut() {
        t.received_bytes = on_disk(&t.file);
    }
    Ok(json!({ "ok": true, "tasks": tasks }))
}

/// 新建一个下载任务并立即开跑。
///
/// `cacheDir` 来自设置：**改目录 → 新任务落新目录**；老任务的 `file` 是绝对路径，不受影响。
pub fn add(body: &Value) -> Result<Value, String> {
    let c = shared();
    let subject_id = body["subjectId"].as_str().unwrap_or("").trim().to_string();
    let title = body["title"].as_str().unwrap_or("").trim().to_string();
    let url = body["url"].as_str().unwrap_or("").trim().to_string();
    let index = body["episodeIndex"].as_f64().unwrap_or(0.0);
    if subject_id.is_empty() || url.is_empty() {
        return Err("缓存任务要带 subjectId 与 url".into());
    }
    if !url.starts_with("http") {
        return Err("只支持 HTTP 直链（BT 归 R5）".into());
    }
    let dir = body["cacheDir"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_cache_dir);
    // 先按上限清一轮（超限时从最久没动过的已完成任务开始删）
    let _ = enforce_limit(body["limitGb"].as_f64().unwrap_or(0.0));
    let id = format!("{subject_id}#{index}");
    let file = dir.join(&subject_id).join(format!("{index}.mp4"));
    let mut tasks = c.tasks.lock().map_err(|_| "缓存表锁坏了".to_string())?;
    if tasks.iter().any(|t| t.id == id && t.state == "downloading") {
        return Ok(json!({ "ok": true, "id": id, "reused": true }));
    }
    tasks.retain(|t| t.id != id);
    let task = CacheTask {
        id: id.clone(),
        subject_id,
        episode_index: index,
        title,
        url,
        file: file.to_string_lossy().into_owned(),
        state: "downloading".into(),
        received_bytes: 0,
        size_bytes: body["sizeBytes"].as_u64(),
        error: None,
        created_at: now_ms(),
        updated_at: now_ms(),
    };
    tasks.push(task.clone());
    let snapshot = tasks.clone();
    drop(tasks);
    c.save(&snapshot)?;
    spawn(c, &task);
    Ok(json!({ "ok": true, "id": id }))
}

fn spawn(c: &Arc<Cache>, task: &CacheTask) {
    let stop = Arc::new(AtomicBool::new(false));
    if let Ok(mut stops) = c.stops.lock() {
        stops.insert(task.id.clone(), stop.clone());
    }
    let c = c.clone();
    let t = task.clone();
    tokio::spawn(async move {
        download(c.clone(), t.clone(), stop).await;
        if let Ok(mut stops) = c.stops.lock() {
            stops.remove(&t.id);
        }
    });
}

/// 分段下载：有 `.part` 就带 `Range` 续传；服务器忽略 Range（回 200）时从头写。
async fn download(c: Arc<Cache>, task: CacheTask, stop: Arc<AtomicBool>) {
    let dest = PathBuf::from(&task.file);
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let part = part_path(&task.file);
    let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let client = match reqwest::Client::builder()
        .user_agent(crate::animesvc::metadata::user_agent())
        .build()
    {
        Ok(v) => v,
        Err(e) => {
            c.update(&task.id, |t| {
                t.state = "failed".into();
                t.error = Some(format!("HTTP 客户端创建失败：{e}"));
            });
            return;
        }
    };
    let mut req = client.get(&task.url);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let res = match req.send().await {
        Ok(v) => v,
        Err(e) => {
            c.update(&task.id, |t| {
                t.state = "failed".into();
                t.error = Some(format!("请求源地址失败：{e}"));
            });
            return;
        }
    };
    let status = res.status();
    if !status.is_success() {
        c.update(&task.id, |t| {
            t.state = "failed".into();
            t.error = Some(format!("源地址返回 {status}"));
        });
        return;
    }
    // 服务器不认 Range（回 200）⇒ 从头写，别把整段拼在旧数据后面
    if have > 0 && status != reqwest::StatusCode::PARTIAL_CONTENT {
        have = 0;
        let _ = std::fs::remove_file(&part);
    }
    let total = res.content_length().map(|n| n + have).or(task.size_bytes);
    c.update(&task.id, |t| {
        t.size_bytes = total;
        t.received_bytes = have;
        t.state = "downloading".into();
        t.error = None;
    });

    use tokio::io::AsyncWriteExt;
    let mut file = match tokio::fs::OpenOptions::new()
        .create(true)
        .append(have > 0)
        .write(true)
        .truncate(have == 0)
        .open(&part)
        .await
    {
        Ok(f) => f,
        Err(e) => {
            c.update(&task.id, |t| {
                t.state = "failed".into();
                t.error = Some(format!("打开缓存文件失败：{e}"));
            });
            return;
        }
    };
    let mut res = res;
    let mut last_save = std::time::Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            let _ = file.flush().await;
            c.update(&task.id, |t| {
                t.state = "paused".into();
                t.received_bytes = have;
            });
            return;
        }
        match res.chunk().await {
            Ok(Some(chunk)) => {
                if let Err(e) = file.write_all(&chunk).await {
                    c.update(&task.id, |t| {
                        t.state = "failed".into();
                        t.error = Some(format!("写缓存失败：{e}"));
                    });
                    return;
                }
                have += chunk.len() as u64;
                if last_save.elapsed().as_millis() >= 500 {
                    last_save = std::time::Instant::now();
                    c.update(&task.id, |t| t.received_bytes = have);
                }
            }
            Ok(None) => break,
            Err(e) => {
                c.update(&task.id, |t| {
                    t.state = "failed".into();
                    t.error = Some(format!("读源数据失败：{e}"));
                });
                return;
            }
        }
    }
    let _ = file.flush().await;
    drop(file);
    if let Err(e) = std::fs::rename(&part, &dest) {
        c.update(&task.id, |t| {
            t.state = "failed".into();
            t.error = Some(format!("收尾改名失败：{e}"));
        });
        return;
    }
    c.update(&task.id, |t| {
        t.state = "done".into();
        t.received_bytes = have;
        t.error = None;
    });
}

/// 按容量上限清理**已完成**的任务：总量超限时从最久没动过的开始删（LRU）。
///
/// 只删 `done`：正在下载的删了会把用户的等待白费；失败的留证据。`limit_gb <= 0` 表示不清理。
pub fn enforce_limit(limit_gb: f64) -> Result<u64, String> {
    if !(limit_gb > 0.0) {
        return Ok(0);
    }
    let limit = (limit_gb * 1024.0 * 1024.0 * 1024.0) as u64;
    let c = shared();
    let mut tasks = c.tasks.lock().map_err(|_| "缓存表锁坏了".to_string())?;
    let removed = lru_trim(&mut tasks, limit);
    if removed == 0 {
        return Ok(0);
    }
    let snapshot = tasks.clone();
    drop(tasks);
    c.save(&snapshot)?;
    Ok(removed)
}

/// 纯清理逻辑（拆出来单测：总量超限 → 从最久没动过的已完成任务删起）。
fn lru_trim(tasks: &mut Vec<CacheTask>, limit: u64) -> u64 {
    let mut total: u64 = tasks.iter().map(|t| on_disk(&t.file)).sum();
    if total <= limit {
        return 0;
    }
    let mut done: Vec<usize> = tasks
        .iter()
        .enumerate()
        .filter(|(_, t)| t.state == "done")
        .map(|(i, _)| i)
        .collect();
    done.sort_by_key(|&i| tasks[i].updated_at);
    let mut drop_idx: Vec<usize> = Vec::new();
    for i in done {
        if total <= limit {
            break;
        }
        let size = on_disk(&tasks[i].file);
        let _ = std::fs::remove_file(&tasks[i].file);
        let _ = std::fs::remove_file(part_path(&tasks[i].file));
        total = total.saturating_sub(size);
        drop_idx.push(i);
    }
    let removed = drop_idx.len() as u64;
    drop_idx.sort_unstable();
    for i in drop_idx.into_iter().rev() {
        tasks.remove(i);
    }
    removed
}

/// 暂停：置停止旗标，下载循环在下一块时收尾（状态由循环自己写）。
pub fn pause(id: &str) -> Result<Value, String> {
    let c = shared();
    if let Ok(stops) = c.stops.lock() {
        if let Some(flag) = stops.get(id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
    // 没有在跑的线程（重启后的 paused）也允许点暂停：直接落状态
    c.update(id, |t| {
        if t.state == "downloading" {
            t.state = "paused".into();
        }
    });
    Ok(json!({ "ok": true, "id": id }))
}

/// 继续：把状态拨回 downloading 并重新起下载（带 Range 续传）。
pub fn resume(id: &str) -> Result<Value, String> {
    let c = shared();
    let task = {
        let tasks = c.tasks.lock().map_err(|_| "缓存表锁坏了".to_string())?;
        tasks.iter().find(|t| t.id == id).cloned()
    };
    let Some(mut task) = task else {
        return Err(format!("没有这个缓存任务：{id}"));
    };
    if task.state == "done" {
        return Ok(json!({ "ok": true, "id": id, "already": true }));
    }
    task.state = "downloading".into();
    task.error = None;
    c.update(id, |t| {
        t.state = "downloading".into();
        t.error = None;
    });
    spawn(&c, &task);
    Ok(json!({ "ok": true, "id": id }))
}

/// 删除：停掉线程、删 `.part` 与正式文件、从表里移除。
pub fn delete(id: &str) -> Result<Value, String> {
    let c = shared();
    if let Ok(stops) = c.stops.lock() {
        if let Some(flag) = stops.get(id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
    let mut tasks = c.tasks.lock().map_err(|_| "缓存表锁坏了".to_string())?;
    let Some(pos) = tasks.iter().position(|t| t.id == id) else {
        return Err(format!("没有这个缓存任务：{id}"));
    };
    let task = tasks.remove(pos);
    let snapshot = tasks.clone();
    drop(tasks);
    let _ = std::fs::remove_file(part_path(&task.file));
    let _ = std::fs::remove_file(&task.file);
    c.save(&snapshot)?;
    Ok(json!({ "ok": true, "id": id, "removed": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, file: &str) -> CacheTask {
        CacheTask {
            id: id.into(),
            subject_id: "s".into(),
            episode_index: 1.0,
            title: "第 1 话".into(),
            url: "http://example.invalid/x.mp4".into(),
            file: file.into(),
            state: "downloading".into(),
            received_bytes: 0,
            size_bytes: None,
            error: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn part_path_is_sibling_with_part_extension() {
        let p = part_path("/cache/冰菓/1.mp4");
        assert_eq!(p, Path::new("/cache/冰菓/1.part"));
    }

    #[test]
    fn state_roundtrip_is_camel_case() {
        let raw = serde_json::to_string(&task("a", "/c/a/1.mp4")).unwrap();
        assert!(raw.contains("\"subjectId\""));
        assert!(raw.contains("\"receivedBytes\""));
        assert!(!raw.contains("subject_id"));
        let back: CacheTask = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.id, "a");
    }

    /// 真下载一次：`.part` 里已有前 1000 字节，带 Range 续传后必须与源逐字节相同。
    #[tokio::test]
    async fn download_resumes_with_range_and_finishes() {
        use axum::extract::State as AxState;
        use axum::http::{header, HeaderMap, StatusCode};
        use axum::response::IntoResponse;
        use axum::routing::get;
        use axum::Router;
        use std::sync::Arc as StdArc;

        let body: StdArc<Vec<u8>> = StdArc::new((0..64 * 1024).map(|i| (i % 251) as u8).collect());
        let handler = |AxState(data): AxState<StdArc<Vec<u8>>>, headers: HeaderMap| async move {
            let total = data.len();
            let start = headers
                .get(header::RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("bytes="))
                .and_then(|v| v.split('-').next())
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(0);
            let slice = data[start.min(total)..].to_vec();
            let status = if start > 0 { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK };
            (status, [(header::CONTENT_LENGTH, slice.len().to_string())], slice).into_response()
        };
        let app = Router::new().route("/f.mp4", get(handler)).with_state(body.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let dir = std::env::temp_dir().join(format!("anime-cache-dl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("1.mp4");
        std::fs::write(part_path(&file.to_string_lossy()), &body[..1000]).unwrap();

        let task = CacheTask {
            url: format!("http://{addr}/f.mp4"),
            file: file.to_string_lossy().into_owned(),
            ..task("dl", "unused")
        };
        let c = StdArc::new(Cache {
            tasks: Mutex::new(vec![task.clone()]),
            stops: Mutex::new(HashMap::new()),
        });
        download(c.clone(), task.clone(), StdArc::new(AtomicBool::new(false))).await;

        let got = std::fs::read(&file).unwrap();
        assert_eq!(got, *body, "续传后应与源逐字节相同");
        let tasks = c.snapshot();
        assert_eq!(tasks[0].state, "done");
        assert_eq!(tasks[0].received_bytes, body.len() as u64);
        assert!(!part_path(&file.to_string_lossy()).exists(), "收尾后不该留 .part");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lru_trim_deletes_oldest_done_until_under_limit() {
        let dir = std::env::temp_dir().join(format!("anime-cache-lru-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mk = |id: &str, bytes: usize, at: u64, state: &str| {
            let file = dir.join(format!("{id}.mp4"));
            std::fs::write(&file, vec![0u8; bytes]).unwrap();
            CacheTask {
                file: file.to_string_lossy().into_owned(),
                state: state.into(),
                updated_at: at,
                ..task(id, "x")
            }
        };
        let mut tasks = vec![
            mk("old", 40, 10, "done"),
            mk("new", 40, 20, "done"),
            mk("live", 40, 5, "downloading"),
        ];
        // 上限 50 字节：总量 120 → 删最久没动的 done（old，40）后仍 80 > 50 → 再删 new
        let removed = lru_trim(&mut tasks, 50);
        assert_eq!(removed, 2);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "live", "正在下载的不许被清掉");
        assert!(!dir.join("old.mp4").exists());
        assert!(!dir.join("new.mp4").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn on_disk_prefers_part_then_final() {
        let dir = std::env::temp_dir().join(format!("anime-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let final_file = dir.join("1.mp4");
        std::fs::write(&final_file, vec![0u8; 10]).unwrap();
        assert_eq!(on_disk(&final_file.to_string_lossy()), 10);
        // `.part` 存在时以它为准（正在续传的那份才是真实进度）
        std::fs::write(part_path(&final_file.to_string_lossy()), vec![0u8; 4]).unwrap();
        assert_eq!(on_disk(&final_file.to_string_lossy()), 4);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
