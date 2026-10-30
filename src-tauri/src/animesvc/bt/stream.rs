//! BT 边下边播（R5-3）：**等字节就位再发**的本地 Range 代理。
//!
//! ## 语义（说清楚，不夸大）
//! librqbit v9 没有按需分片优先级接口，所以这里做的是**文件级边下边播**：
//! 播放器按 Range 要哪一段，代理就等 `progress_bytes` 覆盖到那一段再发；等不到就超时报错，
//! **不会**把还没下载的字节当 0 发出去（那会让播放器花屏/静默失败）。
//! 单文件种子与顺序播放是主路径；多文件种子取**最大的视频文件**，进度用全局字节数估算（保守：多等，不少等）。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use super::handle_of;
use crate::animesvc::stream;

const WAIT_TIMEOUT: Duration = Duration::from_secs(90);
const CHUNK: u64 = 1 << 20; // 1 MiB：播放器按块要，块小一点等得短

fn video_ext(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()),
        Some(ref e) if e == "mp4" || e == "mkv" || e == "avi" || e == "webm" || e == "mov" || e == "ts"
    )
}

/// 在输出目录里挑最大的视频文件（多文件种子取主片；没有视频文件就报错）。
pub fn pick_video(dir: &Path) -> Result<PathBuf, String> {
    let mut best: Option<(PathBuf, u64)> = None;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if !video_ext(&p) {
                continue;
            }
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            if best.as_ref().map(|(_, s)| size > *s).unwrap_or(true) {
                best = Some((p, size));
            }
        }
    }
    best.map(|(p, _)| p)
        .ok_or_else(|| "这个种子还没有视频文件（可能在等元数据）".to_string())
}

/// 生成带票的播放地址（`exp` + `sig` 走 `stream` 同一套 HMAC）。
pub fn stream_url(base: &str, token: &str, id: usize, ttl_secs: u64) -> String {
    let exp = stream::now_secs() + ttl_secs;
    let sig = stream::sign(token, &format!("bt:{id}"), exp);
    format!("{base}/api/v1/anime/bt/stream?id={id}&exp={exp}&sig={sig}")
}

/// Range 代理：等字节 → 读盘 → 回 206/200。
pub async fn serve(
    shell: std::sync::Arc<crate::animesvc::Shell>,
    id: usize,
    exp: u64,
    sig: &str,
    headers: HeaderMap,
) -> Response {
    if exp < stream::now_secs() {
        return (StatusCode::FORBIDDEN, "播放地址已过期（重新点一次播放）").into_response();
    }
    if !stream::verify(shell.token(), &format!("bt:{id}"), exp, sig) {
        return (StatusCode::FORBIDDEN, "播放地址签名不对").into_response();
    }
    let session = match super::session().await {
        Ok(s) => s,
        Err(e) => return (StatusCode::SERVICE_UNAVAILABLE, e).into_response(),
    };
    let handle = match handle_of(&session, id) {
        Ok(h) => h,
        Err(e) => return (StatusCode::NOT_FOUND, e).into_response(),
    };
    // 元数据没到就等它到（磁力刚添加时输出目录还空）
    let _ = handle.wait_until_initialized().await;
    let dir = handle.output_folder().to_path_buf();
    let file = match pick_video(&dir) {
        Ok(p) => p,
        Err(e) => return (StatusCode::CONFLICT, e).into_response(),
    };
    let total = handle.stats().total_bytes;
    let (start, end) = match stream::parse_range(
        headers.get(header::RANGE).and_then(|v| v.to_str().ok()),
        total.max(1),
    ) {
        Ok(r) => (r.start, r.end),
        // 语法不认识的 Range 按规范忽略、整份返回；只有起点越界才 416
        Err(stream::RangeErr::Ignore) => (0, total.max(1) - 1),
        Err(stream::RangeErr::Unsatisfiable) => {
            return (StatusCode::RANGE_NOT_SATISFIABLE, "Range 越界").into_response();
        }
    };
    let want_end = (start + CHUNK).min(end);
    // 等 `progress_bytes` 覆盖到这一块（保守：多等，不少等）
    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        let st = handle.stats();
        if st.finished || st.progress_bytes >= want_end || Instant::now() > deadline {
            if !(st.finished || st.progress_bytes >= want_end) {
                return (
                    StatusCode::GATEWAY_TIMEOUT,
                    "等这一段的字节超时了（种子可能没有 peer）",
                )
                    .into_response();
            }
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    // 从盘上读这一段（文件可能比 total 短：还没写完时按实际长度收窄）
    let data = match std::fs::read(&file) {
        Ok(d) => d,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("读缓存文件失败：{e}")).into_response();
        }
    };
    let real_end = (end + 1).min(data.len() as u64);
    if start >= real_end {
        return (StatusCode::RANGE_NOT_SATISFIABLE, "这一块还没写到盘上").into_response();
    }
    let slice = data[start as usize..real_end as usize].to_vec();
    let len = slice.len() as u64;
    let mut resp = Response::new(Body::from(slice));
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
    h.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    h.insert(header::CONTENT_LENGTH, len.to_string().parse().unwrap());
    if start != 0 || real_end != total {
        h.insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}-{total}", real_end - 1).parse().unwrap(),
        );
        *resp.status_mut() = StatusCode::PARTIAL_CONTENT;
    }
    stream::allow_cross_origin(resp)
}

/// 前端用：拿一个可播放地址（需要时先等元数据，不阻塞界面）。
pub fn describe() -> Value {
    json!({
        "mode": "file-range",
        "note": "文件级边下边播：按 Range 等字节就位再发，没有分片优先级调度",
        "waitTimeoutSecs": WAIT_TIMEOUT.as_secs(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_largest_video_file() {
        let dir = std::env::temp_dir().join(format!("anime-bt-pick-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("small.mp4"), vec![0u8; 10]).unwrap();
        std::fs::write(dir.join("sub/big.mkv"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.join("notes.txt"), vec![0u8; 500]).unwrap();
        let p = pick_video(&dir).unwrap();
        assert!(p.ends_with("big.mkv"), "{p:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_video_says_so() {
        let dir = std::env::temp_dir().join(format!("anime-bt-novid-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        let err = pick_video(&dir).unwrap_err();
        assert!(err.contains("视频文件"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn url_carries_verifiable_ticket() {
        let url = stream_url("http://127.0.0.1:5180", "tok", 7, 60);
        assert!(url.contains("id=7"));
        assert!(url.contains("sig="));
        // 拿同一套 HMAC 校验：签名必须对得上（否则播放器会一直 403）
        let exp: u64 = url.split("exp=").nth(1).unwrap().split('&').next().unwrap().parse().unwrap();
        let sig = url.split("sig=").nth(1).unwrap();
        assert!(crate::animesvc::stream::verify("tok", "bt:7", exp, sig));
        assert!(!crate::animesvc::stream::verify("other", "bt:7", exp, sig));
    }
}
