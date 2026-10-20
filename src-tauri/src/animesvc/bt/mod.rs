//! BT 下载（R5）：librqbit 会话 + 磁力/种子任务 + 限速与端口 + peer 过滤。
//!
//! ## 为什么单独一个会话
//! librqbit 的 `Session` 自带 DHT、监听器与磁盘层，进程内只该有一个（两个会话会抢端口、重复做种）。
//! 首次调用时惰性创建，之后全局复用；下载目录 = 缓存目录（与 HTTP 直链缓存同处，删除逻辑一致）。
//!
//! ## 端口
//! `btPort` 来自设置：**会话创建时**读一次（`ListenerOptions.listen_addr`）。改端口需要重启动漫服务，
//! 界面会如实说明 —— 一个"改了没反应"的端口设置比没有更坏。
//!
//! ## peer 过滤
//! librqbit 自带 `blocklist_url`：订阅地址直接交给它拉取与应用，不自己造一套规则解析。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use librqbit::api::TorrentIdOrHash;
use librqbit::{AddTorrent, Session, SessionOptions, TorrentStatsState};
use serde_json::{json, Value};

static SESSION: OnceLock<Arc<Session>> = OnceLock::new();

fn bt_dir() -> PathBuf {
    crate::platform::paths::anime_state_dir().join("bt")
}

fn listen_port() -> u16 {
    std::env::var("MIAO_ANIME_BT_PORT")
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(0)
}

fn peer_filter_url() -> Option<String> {
    std::env::var("MIAO_ANIME_BT_PEER_FILTER")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// 取（或首次创建）BT 会话。
pub async fn session() -> Result<Arc<Session>, String> {
    if let Some(s) = SESSION.get() {
        return Ok(s.clone());
    }
    let dir = bt_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("建 BT 目录失败：{e}"))?;
    let mut opts = SessionOptions::default();
    let port = listen_port();
    if port > 0 {
        opts.listen = Some(librqbit::ListenerOptions {
            listen_addr: SocketAddr::from(([0, 0, 0, 0], port)),
            ..Default::default()
        });
    }
    opts.blocklist_url = peer_filter_url();
    let s = Session::new_with_opts(dir, opts)
        .await
        .map_err(|e| format!("BT 会话起不来：{e}"))?;
    Ok(SESSION.get_or_init(|| s).clone())
}

/// 会话状态（端口 / 速率 / 做种比）。没起会话时返回"未启动"，不假装有数字。
pub fn stats() -> Value {
    let Some(s) = SESSION.get() else {
        return json!({ "running": false, "port": listen_port(), "tasks": 0 });
    };
    let port = s.announce_port().or_else(|| s.listen_addr().map(|a| a.port())).unwrap_or(0);
    // 会话级数字由任务聚合得出（不猜 SessionStatsSnapshot 的字段名）
    let (down, up, tasks) = s.with_torrents(|it| {
        let mut down = 0u64;
        let mut up = 0u64;
        let mut n = 0usize;
        for (_, t) in it {
            let st = t.stats();
            down += st.progress_bytes;
            up += st.uploaded_bytes;
            n += 1;
        }
        (down, up, n)
    });
    let ratio = if down > 0 { up as f64 / down as f64 } else { 0.0 };
    json!({
        "running": true,
        "port": port,
        "downloadedBytes": down,
        "uploadedBytes": up,
        "ratio": (ratio * 100.0).round() / 100.0,
        "tasks": tasks,
    })
}

/// 添加磁力 / 种子地址。
pub async fn add(body: &Value) -> Result<Value, String> {
    let url = body["url"].as_str().unwrap_or("").trim();
    if url.is_empty() {
        return Err("要带磁力链接或种子地址".into());
    }
    if !(url.starts_with("magnet:") || url.starts_with("http")) {
        return Err("只支持 magnet: 或 http(s) 种子地址".into());
    }
    let s = session().await?;
    let resp = s
        .add_torrent(AddTorrent::from_url(url), None)
        .await
        .map_err(|e| format!("添加种子失败：{e}"))?;
    let handle = resp.into_handle().ok_or_else(|| "这个种子没有可下载的文件".to_string())?;
    let id = handle.id();
    Ok(json!({ "ok": true, "id": id, "name": handle.name().unwrap_or_default() }))
}

/// 任务列表（进度 / 速率 / 做种比都来自 librqbit 的 stats，不自己估）。
pub fn list() -> Result<Value, String> {
    let Some(s) = SESSION.get() else {
        return Ok(json!({ "ok": true, "tasks": [] }));
    };
    let tasks = s.with_torrents(|it| {
        it.map(|(id, t)| {
            let st = t.stats();
            let state = match st.state {
                TorrentStatsState::Initializing { paused: true } => "paused",
                TorrentStatsState::Initializing { paused: false } => "initializing",
                // 下完但仍在校验/做种时状态仍是 Live，用 finished 区分
                TorrentStatsState::Live => {
                    if st.finished {
                        "done"
                    } else {
                        "downloading"
                    }
                }
                TorrentStatsState::Paused => "paused",
                TorrentStatsState::Error => "failed",
            };
            json!({
                "id": id,
                "name": t.name().unwrap_or_default(),
                "state": state,
                "progressBytes": st.progress_bytes,
                "totalBytes": st.total_bytes,
                "uploadedBytes": st.uploaded_bytes,
                "finished": st.finished,
                "error": st.error,
                "ratio": if st.progress_bytes > 0 {
                    ((st.uploaded_bytes as f64 / st.progress_bytes as f64) * 100.0).round() / 100.0
                } else { 0.0 },
            })
        })
        .collect::<Vec<Value>>()
    });
    Ok(json!({ "ok": true, "tasks": tasks }))
}

fn handle_of(s: &Arc<Session>, id: usize) -> Result<Arc<librqbit::ManagedTorrent>, String> {
    s.get(TorrentIdOrHash::Id(id)).ok_or_else(|| format!("没有这个 BT 任务：{id}"))
}

pub async fn pause(id: usize) -> Result<Value, String> {
    let s = session().await?;
    let h = handle_of(&s, id)?;
    s.pause(&h).await.map_err(|e| format!("暂停失败：{e}"))?;
    Ok(json!({ "ok": true, "id": id }))
}

pub async fn resume(id: usize) -> Result<Value, String> {
    let s = session().await?;
    let h = handle_of(&s, id)?;
    s.unpause(&h).await.map_err(|e| format!("继续失败：{e}"))?;
    Ok(json!({ "ok": true, "id": id }))
}

pub async fn delete(id: usize, delete_files: bool) -> Result<Value, String> {
    let s = session().await?;
    s.delete(TorrentIdOrHash::Id(id), delete_files)
        .await
        .map_err(|e| format!("删除失败：{e}"))?;
    Ok(json!({ "ok": true, "id": id }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_is_empty_before_session_starts() {
        // 没起会话时必须是空表（不是报错，也不是编造任务）
        let v = list().unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["tasks"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn stats_reports_not_running_before_start() {
        let v = stats();
        assert_eq!(v["running"], false);
    }

    #[tokio::test]
    async fn add_rejects_non_torrent_urls() {
        let err = add(&json!({ "url": "ftp://example.com/a.torrent" })).await.unwrap_err();
        assert!(err.contains("magnet"), "{err}");
        let err = add(&json!({ "url": "" })).await.unwrap_err();
        assert!(err.contains("磁力"), "{err}");
    }
}
