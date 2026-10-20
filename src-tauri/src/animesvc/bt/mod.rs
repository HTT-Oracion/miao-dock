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
use std::sync::{Arc, Mutex, OnceLock};

pub mod pikpak;
pub mod stream;

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

/// 限速（KiB/s，0/None = 不限）与做种分享率上限。都是**会话级**参数：
/// 限速可在运行期直接改（librqbit 的 `Limits` 支持 set），分享率上限由 `list()` 顺手执行。
static LIMITS: OnceLock<Mutex<(Option<u32>, Option<u32>)>> = OnceLock::new();
static SEED_RATIO: OnceLock<Mutex<Option<f64>>> = OnceLock::new();

fn limits_cell() -> &'static Mutex<(Option<u32>, Option<u32>)> {
    LIMITS.get_or_init(|| Mutex::new((None, None)))
}

fn seed_cell() -> &'static Mutex<Option<f64>> {
    SEED_RATIO.get_or_init(|| Mutex::new(None))
}

fn env_u32(name: &str) -> Option<u32> {
    std::env::var(name).ok().and_then(|v| v.trim().parse::<u32>().ok()).filter(|v| *v > 0)
}

/// 首次建会话时把环境里的值读进来（子进程启动参数 → 进程内状态）。
fn init_from_env() {
    let down = env_u32("MIAO_ANIME_BT_DOWN_KBPS");
    let up = env_u32("MIAO_ANIME_BT_UP_KBPS");
    if down.is_some() || up.is_some() {
        if let Ok(mut g) = limits_cell().lock() {
            if g.0.is_none() && g.1.is_none() {
                *g = (down, up);
            }
        }
    }
    if let Ok(ratio) = std::env::var("MIAO_ANIME_BT_SEED_RATIO") {
        if let Ok(v) = ratio.trim().parse::<f64>() {
            if let Ok(mut g) = seed_cell().lock() {
                if g.is_none() {
                    *g = Some(v);
                }
            }
        }
    }
}

fn apply_limits(s: &Session) {
    let (down, up) = limits_cell().lock().map(|g| *g).unwrap_or((None, None));
    s.ratelimits
        .set_download_bps(down.and_then(std::num::NonZeroU32::new));
    s.ratelimits
        .set_upload_bps(up.and_then(std::num::NonZeroU32::new));
}

/// 当前限速与做种上限（界面显示用）。
pub fn limits() -> Value {
    let (down, up) = limits_cell().lock().map(|g| *g).unwrap_or((None, None));
    let ratio = seed_cell().lock().ok().and_then(|g| *g);
    json!({
        "downKbps": down.unwrap_or(0),
        "upKbps": up.unwrap_or(0),
        "seedRatio": ratio.unwrap_or(0.0),
    })
}

/// 改限速 / 做种上限：**运行期立刻生效**（会话已起就直接改 `Limits`）。
pub fn set_limits(down_kbps: Option<u32>, up_kbps: Option<u32>, seed_ratio: Option<f64>) -> Result<Value, String> {
    // NaN / 无穷先拒：filter 会把它们静默当成「不限制」，那是假接受
    if let Some(r) = seed_ratio {
        if !r.is_finite() {
            return Err("分享率上限要是个有限的数".into());
        }
    }
    let down = down_kbps.filter(|v| *v > 0);
    let up = up_kbps.filter(|v| *v > 0);
    let ratio = seed_ratio.filter(|v| *v > 0.0);
    if let Ok(mut g) = limits_cell().lock() {
        *g = (down, up);
    }
    if let Ok(mut g) = seed_cell().lock() {
        *g = ratio;
    }
    if let Some(s) = SESSION.get() {
        apply_limits(s);
    }
    Ok(json!({ "ok": true, "limits": limits() }))
}

/// 做种分享率上限的执行：已完成的做种任务达到上限就暂停（在 `list()` 里顺手跑，不另起定时器）。
fn enforce_seed_ratio(s: &Arc<Session>) {
    let Some(limit) = seed_cell().lock().ok().and_then(|g| *g) else {
        return;
    };
    if limit <= 0.0 {
        return;
    }
    let ids: Vec<usize> = s.with_torrents(|it| {
        it.filter(|(_, t)| {
            let st = t.stats();
            st.finished && st.progress_bytes > 0 && (st.uploaded_bytes as f64 / st.progress_bytes as f64) >= limit
        })
        .map(|(id, _)| id)
        .collect()
    });
    if ids.is_empty() {
        return;
    }
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let s2 = s.clone();
        handle.spawn(async move {
            for id in ids {
                if let Some(t) = s2.get(TorrentIdOrHash::Id(id)) {
                    let _ = s2.pause(&t).await;
                }
            }
        });
    }
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
    init_from_env();
    let s = Session::new_with_opts(dir, opts)
        .await
        .map_err(|e| format!("BT 会话起不来：{e}"))?;
    let session = SESSION.get_or_init(|| s).clone();
    apply_limits(&session);
    Ok(session)
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
    enforce_seed_ratio(s);
    Ok(json!({ "ok": true, "tasks": tasks }))
}

pub(crate) fn handle_of(s: &Arc<Session>, id: usize) -> Result<Arc<librqbit::ManagedTorrent>, String> {
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

    #[test]
    fn limits_roundtrip_and_validation() {
        let v = set_limits(Some(1024), Some(256), Some(1.5)).unwrap();
        assert_eq!(v["limits"]["downKbps"], 1024);
        assert_eq!(v["limits"]["upKbps"], 256);
        assert_eq!(v["limits"]["seedRatio"], 1.5);
        // 0 = 不限
        let v = set_limits(Some(0), Some(0), Some(0.0)).unwrap();
        assert_eq!(v["limits"]["downKbps"], 0);
        assert_eq!(v["limits"]["seedRatio"], 0.0);
        // NaN 必须被拒（不能静默当成「不限制」）
        assert!(set_limits(None, None, Some(f64::NAN)).is_err());
    }

    #[tokio::test]
    async fn add_rejects_non_torrent_urls() {
        let err = add(&json!({ "url": "ftp://example.com/a.torrent" })).await.unwrap_err();
        assert!(err.contains("magnet"), "{err}");
        let err = add(&json!({ "url": "" })).await.unwrap_err();
        assert!(err.contains("磁力"), "{err}");
    }
}
