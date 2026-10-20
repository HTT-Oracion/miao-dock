//! 本地媒体的**带签名 Range 流**（M2 的 WebView 轨底座）。
//!
//! ## 为什么需要它
//! WebView 里的 `<video>` 不能带自定义请求头，而服务端所有端点都要求 `X-Box-Token`。
//! 直接把服务令牌塞进 URL 也不行：URL 会进日志、进历史记录、进崩溃报告。
//! 所以签一个**短时票**：`sig = sha256(token | path | exp)`，只对「这一个文件 + 这段时间」有效，
//! 过期或改路径都验不过；令牌本身永不出现在 URL 里。
//!
//! ## 为什么自己做 Range 而不是用现成中间件
//! 需求只有一条：**边下边播**（拖到哪儿就从哪儿读）。`tower-http` 的 ServeFile 会引入
//! 一整条中间件依赖链，而我们要顺手做「路径必须在库根下」与「票校验」——
//! 这两件事都必须在读文件之前、按顺序做，否则会出现"先读了文件再发现没权限"的时序漏洞。
//!
//! ## 与 libmpv 轨的关系
//! 这条端点只解决「WebView 能解的容器」（mp4/webm/mov/HLS）。mkv + ass 这类走 libmpv，
//! 由随包内核直接读盘，不经过这里 —— 两条轨的选路由 `manifest::episode_media` 决定。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::stream;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use crate::animesvc::{envelope, Shell};

/// 每次从盘上读多大一块交给 Body。太小则 syscall 打满 CPU，太大则首帧变慢。
const CHUNK: u64 = 256 * 1024;

/// 票的有效期：6 小时。够看完一部长片 + 拖几次进度，又不至于变成长期通行证。
pub const TICKET_TTL_SECS: u64 = 6 * 3600;

#[derive(Deserialize)]
pub struct StreamQuery {
    pub path: String,
    pub exp: u64,
    pub sig: String,
}

/// 算票面签名。取 sha256 前 32 个 hex 字符（128 bit）—— 够用且 URL 不至于太长。
pub fn sign(token: &str, path: &str, exp: u64) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    h.update(b"|");
    h.update(path.as_bytes());
    h.update(b"|");
    h.update(exp.to_string().as_bytes());
    let out = hex::encode(h.finalize());
    out[..32].to_string()
}

/// 验票：常量时间比较（长度先比，再按位异或），并检查未过期。
pub fn verify(token: &str, path: &str, exp: u64, sig: &str) -> bool {
    if exp < now_secs() {
        return false;
    }
    constant_time_eq(sign(token, path, exp).as_bytes(), sig.as_bytes())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// 一次 Range 请求的区间（**闭区间**，与 HTTP 语义一致）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RangeSpec {
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RangeErr {
    /// 语法不认识：按 HTTP 规范**忽略** Range、整份返回（比 400 更宽容，播放器不因此崩）
    Ignore,
    /// 起点越界：必须 416 + `Content-Range: bytes */len`
    Unsatisfiable,
}

/// 解析 `Range: bytes=…`。
///
/// 支持三种写法：`start-end` / `start-` / `-suffix`；多段（逗号）只取第一段 ——
/// 视频播放器只会发单段，回多段反而要写 multipart/byteranges，收益为零。
pub fn parse_range(header: Option<&str>, len: u64) -> Result<RangeSpec, RangeErr> {
    let raw = match header {
        Some(v) => v.trim(),
        None => return Err(RangeErr::Ignore),
    };
    let body = match raw.strip_prefix("bytes=") {
        Some(v) => v.split(',').next().unwrap_or("").trim(),
        None => return Err(RangeErr::Ignore),
    };
    if body.is_empty() || len == 0 {
        return Err(RangeErr::Ignore);
    }
    let (a, b) = match body.split_once('-') {
        Some(x) => x,
        None => return Err(RangeErr::Ignore),
    };
    // `-suffix`：要最后 n 字节（播放器 seek 到尾部时会用）
    if a.is_empty() {
        let n: u64 = match b.trim().parse() {
            Ok(v) => v,
            Err(_) => return Err(RangeErr::Ignore),
        };
        if n == 0 {
            return Err(RangeErr::Unsatisfiable);
        }
        let start = len.saturating_sub(n);
        return Ok(RangeSpec { start, end: len - 1 });
    }
    let start: u64 = match a.trim().parse() {
        Ok(v) => v,
        Err(_) => return Err(RangeErr::Ignore),
    };
    if start >= len {
        return Err(RangeErr::Unsatisfiable);
    }
    let end = if b.trim().is_empty() {
        len - 1
    } else {
        match b.trim().parse::<u64>() {
            Ok(v) => v.min(len - 1),
            Err(_) => return Err(RangeErr::Ignore),
        }
    };
    if end < start {
        return Err(RangeErr::Unsatisfiable);
    }
    Ok(RangeSpec { start, end })
}

/// 按扩展名给 Content-Type。认不出时用 `application/octet-stream`
/// （浏览器会拒播，但错误信息比"谎报 video/mp4 然后解码失败"清楚）。
fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" | "ogg" => "video/ogg",
        "m4a" => "audio/mp4",
        "mp3" => "audio/mpeg",
        "m3u8" => "application/vnd.apple.mpegurl",
        "ts" => "video/mp2t",
        "vtt" => "text/vtt",
        "srt" | "ass" | "ssa" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// 把请求路径钉死在库根内。`canonicalize` 之后再比前缀 ——
/// 只比字符串会被 `library/../secret` 这类相对路径绕过。
pub fn under_root(file: &Path, root: &Path) -> Option<PathBuf> {
    let f = file.canonicalize().ok()?;
    let r = root.canonicalize().ok()?;
    if f.starts_with(&r) {
        Some(f)
    } else {
        None
    }
}

/// 给流响应补 CORS 头。
///
/// 为什么需要：WebView 的 `<video crossorigin="anonymous">` 与字幕 / HLS 的 `fetch`
/// 都是跨源请求（页面在 `tauri://localhost`，流在 `127.0.0.1:<port>`）。没有这两个头，
/// 表现为「视频能放但字幕读不到、截图报画布污染」。
/// 这里回 `*` 是安全的：URL 本身就是能力（签名 + 过期），令牌不出 Rust，读不到别的文件。
///
/// `pub(crate)`：媒体服务器中继（`datasource::mediaserver::relay`）复用同一套判据 ——
/// CORS 头漏了不会报错，只会让字幕 / 截图静默失败，两处各写一份必然漏一处。
pub(crate) fn allow_cross_origin(mut resp: Response) -> Response {
    let h = resp.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());
    h.insert("cross-origin-resource-policy", "cross-origin".parse().unwrap());
    resp
}

/// `GET /api/v1/anime/stream?path=…&exp=…&sig=…`
pub async fn handle(
    State(shell): State<Arc<Shell>>,
    headers: HeaderMap,
    Query(q): Query<StreamQuery>,
) -> Response {
    // 成功 / 403 / 404 / 416 一律带 CORS 头：否则浏览器只报「CORS 错误」，真因被盖住
    allow_cross_origin(handle_signed(shell, headers, q).await)
}

async fn handle_signed(shell: Arc<Shell>, headers: HeaderMap, q: StreamQuery) -> Response {
    if !verify(shell.token(), &q.path, q.exp, &q.sig) {
        return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "流票据无效或已过期");
    }
    let file = match under_root(Path::new(&q.path), Path::new(shell.root())) {
        Some(p) => p,
        None => {
            return envelope(
                StatusCode::FORBIDDEN,
                "PERMISSION_DENIED",
                "只能读番剧库根目录内的文件",
            )
        }
    };
    let len = match std::fs::metadata(&file) {
        Ok(m) if m.is_file() => m.len(),
        _ => {
            return envelope(
                StatusCode::NOT_FOUND,
                "NOT_FOUND",
                format!("文件不存在：{}", file.display()),
            )
        }
    };
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    // m3u8 播放列表要**改写分片地址**：分片是相对路径时，直接喂给 hls.js 会被解析到
    // `/api/v1/anime/` 下面（带票查询串还会被丢掉）⇒ 起播就 404。这里把每条分片
    // 换成一条**独立签名**的绝对路径，播放器不需要知道令牌。
    if is_playlist(&file) {
        return match std::fs::read_to_string(&file) {
            Ok(text) => {
                let body = rewrite_playlist(&text, &file, shell.token(), q.exp);
                let mut resp = Response::new(Body::from(body));
                resp.headers_mut().insert(
                    header::CONTENT_TYPE,
                    "application/vnd.apple.mpegurl".parse().unwrap(),
                );
                resp.headers_mut().insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
                resp
            }
            Err(e) => envelope(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", format!("读播放列表失败：{e}")),
        };
    }
    serve(file, len, range)
}

/// 是不是 HLS 播放列表（按扩展名；`.m3u` 也算，上游两种都发）。
fn is_playlist(file: &Path) -> bool {
    matches!(
        file.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("m3u8") | Some("m3u")
    )
}

/// 把播放列表里的**本地相对地址**换成带票的绝对路径。
///
/// · 注释行原样保留；`#EXT-X-KEY` / `#EXT-X-MAP` 的 `URI="…"` 一起改写（加密分片不换就解不开）
/// · `http(s)://` 开头的一律不动（那是上游 CDN 的绝对地址）
/// · 分片与主播放列表共用同一个 `exp`：票是一次签的，过期时刻一致才好排查
pub fn rewrite_playlist(text: &str, playlist: &Path, token: &str, exp: u64) -> String {
    let dir = playlist.parent().unwrap_or_else(|| Path::new("."));
    let mut out = String::with_capacity(text.len() + 256);
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            out.push('\n');
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("#EXT-X-KEY:") {
            out.push_str(&rewrite_uri_attr("#EXT-X-KEY:", rest, dir, token, exp));
            out.push('\n');
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("#EXT-X-MAP:") {
            out.push_str(&rewrite_uri_attr("#EXT-X-MAP:", rest, dir, token, exp));
            out.push('\n');
            continue;
        }
        if trimmed.starts_with('#') {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        out.push_str(&ticket_url(dir, trimmed, token, exp));
        out.push('\n');
    }
    out
}

/// 改写 `URI="…"` 这一个属性（其它属性保持原样）。
fn rewrite_uri_attr(prefix: &str, rest: &str, dir: &Path, token: &str, exp: u64) -> String {
    let Some(start) = rest.find("URI=\"") else {
        return format!("{prefix}{rest}");
    };
    let after = &rest[start + 5..];
    let Some(end) = after.find('"') else {
        return format!("{prefix}{rest}");
    };
    let uri = &after[..end];
    let head = &rest[..start];
    let tail = &after[end..];
    format!("{prefix}{head}URI=\"{}\"{tail}", ticket_url(dir, uri, token, exp))
}

/// 一条分片 / 密钥地址 → 带票绝对路径（已是 http(s) 的原样返回）。
fn ticket_url(dir: &Path, uri: &str, token: &str, exp: u64) -> String {
    if uri.starts_with("http://") || uri.starts_with("https://") || uri.starts_with("data:") {
        return uri.to_string();
    }
    let target = if uri.starts_with('/') || uri.chars().nth(1) == Some(':') {
        PathBuf::from(uri) // 绝对路径（含 Windows 盘符）直接用
    } else {
        dir.join(uri)
    };
    let path = target.to_string_lossy().into_owned();
    let sig = sign(token, &path, exp);
    format!("/api/v1/anime/stream?path={}&exp={exp}&sig={sig}", percent_encode(&path))
}

/// 极简百分号编码（路径可能带空格 / 中文；与壳层 `urlencode` 同口径）。
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 真正吐字节：有 Range 给 206 分段，无 Range 给 200 全量，越界给 416。
fn serve(file: PathBuf, len: u64, range_header: Option<&str>) -> Response {
    let spec = match parse_range(range_header, len) {
        Ok(s) => Some(s),
        Err(RangeErr::Ignore) => None,
        Err(RangeErr::Unsatisfiable) => {
            let mut r = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            if let Ok(v) = format!("bytes */{len}").parse() {
                r.headers_mut().insert(header::CONTENT_RANGE, v);
            }
            return r;
        }
    };
    let (start, end) = spec.map(|s| (s.start, s.end)).unwrap_or((0, len.saturating_sub(1)));
    let body_len = if len == 0 { 0 } else { end - start + 1 };

    let mut f = match std::fs::File::open(&file) {
        Ok(f) => f,
        Err(e) => {
            return envelope(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", format!("打开文件失败：{e}"))
        }
    };
    if start > 0 {
        if let Err(e) = std::io::Seek::seek(&mut f, std::io::SeekFrom::Start(start)) {
            return envelope(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", format!("定位失败：{e}"));
        }
    }
    let tok = tokio::fs::File::from_std(f);
    let body = Body::from_stream(file_stream(tok, body_len));

    let mut resp = if spec.is_some() {
        let mut r = Response::new(body);
        *r.status_mut() = StatusCode::PARTIAL_CONTENT;
        if let Ok(v) = format!("bytes {start}-{end}/{len}").parse() {
            r.headers_mut().insert(header::CONTENT_RANGE, v);
        }
        r
    } else {
        Response::new(body)
    };
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        content_type(&file)
            .parse()
            .unwrap_or_else(|_| "application/octet-stream".parse().unwrap()),
    );
    h.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    if let Ok(v) = body_len.to_string().parse() {
        h.insert(header::CONTENT_LENGTH, v);
    }
    h.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    resp
}

/// 分块读盘 → 流。`remaining` 归零即结束（不依赖文件 EOF，因为 Range 只读一段）。
fn file_stream(
    file: tokio::fs::File,
    remaining: u64,
) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> {
    stream::unfold((file, remaining), |(mut f, rem)| async move {
        if rem == 0 {
            return None;
        }
        let want = rem.min(CHUNK) as usize;
        let mut buf = vec![0u8; want];
        match f.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok(Bytes::from(buf)), (f, rem - n as u64)))
            }
            Err(e) => Some((Err(e), (f, 0))),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_full_and_suffix() {
        assert_eq!(parse_range(Some("bytes=0-99"), 1000), Ok(RangeSpec { start: 0, end: 99 }));
        assert_eq!(parse_range(Some("bytes=900-"), 1000), Ok(RangeSpec { start: 900, end: 999 }));
        assert_eq!(parse_range(Some("bytes=-100"), 1000), Ok(RangeSpec { start: 900, end: 999 }));
        // 末段越界按文件尾夹住（播放器常发 0- 或超大 end）
        assert_eq!(parse_range(Some("bytes=0-999999"), 1000), Ok(RangeSpec { start: 0, end: 999 }));
    }

    #[test]
    fn range_rejects_out_of_bounds() {
        assert_eq!(parse_range(Some("bytes=1000-"), 1000), Err(RangeErr::Unsatisfiable));
        assert_eq!(parse_range(Some("bytes=50-10"), 1000), Err(RangeErr::Unsatisfiable));
    }

    #[test]
    fn range_ignores_garbage() {
        assert_eq!(parse_range(None, 1000), Err(RangeErr::Ignore));
        assert_eq!(parse_range(Some("items=0-1"), 1000), Err(RangeErr::Ignore));
        assert_eq!(parse_range(Some("bytes=abc-def"), 1000), Err(RangeErr::Ignore));
        assert_eq!(parse_range(Some("bytes=-"), 1000), Err(RangeErr::Ignore));
        // 空文件不能算"越界"，否则空 mp4 会得到 416 而不是 200
        assert_eq!(parse_range(Some("bytes=0-"), 0), Err(RangeErr::Ignore));
    }

    #[test]
    fn ticket_roundtrip() {
        let token = "a".repeat(64);
        let path = "/tmp/x.mp4";
        let exp = now_secs() + 60;
        let sig = sign(&token, path, exp);
        assert_eq!(sig.len(), 32);
        assert!(verify(&token, path, exp, &sig));
        // 改路径 / 改有效期 / 换令牌 / 截断签名 都必须验不过
        assert!(!verify(&token, "/tmp/y.mp4", exp, &sig));
        assert!(!verify(&token, path, exp + 1, &sig));
        assert!(!verify(&"b".repeat(64), path, exp, &sig));
        assert!(!verify(&token, path, exp, &sig[..31]));
    }

    #[test]
    fn ticket_expires() {
        let token = "a".repeat(64);
        let exp = now_secs().saturating_sub(1);
        let sig = sign(&token, "/p", exp);
        assert!(!verify(&token, "/p", exp, &sig));
    }

    #[test]
    fn responses_carry_cors_headers() {
        // WebView 的 crossorigin 请求与字幕 fetch 都靠这两个头；
        // 漏掉的表现不是报错，而是「视频能放、字幕读不到、截图污染画布」
        let resp = allow_cross_origin(StatusCode::OK.into_response());
        assert_eq!(
            resp.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).and_then(|v| v.to_str().ok()),
            Some("*")
        );
        assert_eq!(
            resp.headers().get("cross-origin-resource-policy").and_then(|v| v.to_str().ok()),
            Some("cross-origin")
        );
    }

    #[test]
    fn root_guard_blocks_escape() {
        let tmp = std::env::temp_dir().join(format!("anime-stream-{}", std::process::id()));
        let root = tmp.join("lib");
        std::fs::create_dir_all(&root).unwrap();
        let inside = root.join("a.mp4");
        std::fs::write(&inside, b"x").unwrap();
        let outside = tmp.join("secret.txt");
        std::fs::write(&outside, b"y").unwrap();

        assert!(under_root(&inside, &root).is_some());
        assert!(under_root(&outside, &root).is_none());
        // 相对路径穿越也要挡住
        assert!(under_root(&root.join("..").join("secret.txt"), &root).is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn playlist_rewrites_relative_segments_with_their_own_tickets() {
        let dir = std::env::temp_dir().join(format!("miao-anime-pl-{}", std::process::id()));
        let pl = dir.join("index.m3u8");
        let text = "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:9.0,\nseg0.ts\n#EXTINF:9.0,\nsub/seg1.ts\n";
        let exp = now_secs() + 600;
        let out = rewrite_playlist(text, &pl, "tok", exp);

        // 注释与时长行原样保留（hls.js 靠它们）
        assert!(out.contains("#EXTM3U"));
        assert!(out.contains("#EXTINF:9.0,"));
        // 相对分片换成绝对路径 + 各自签名
        assert!(!out.lines().any(|l| l.trim() == "seg0.ts"));
        let p0 = dir.join("seg0.ts").to_string_lossy().into_owned();
        let sig0 = sign("tok", &p0, exp);
        assert!(out.contains(&format!("sig={sig0}")), "seg0 没带上自己的票：{out}");
        assert!(verify("tok", &p0, exp, &sig0));
        // 子目录分片按播放列表所在目录解析（`join` 保留原文里的 `/`，与实现同口径）
        let p1 = dir.join("sub/seg1.ts").to_string_lossy().into_owned();
        let sig1 = sign("tok", &p1, exp);
        assert!(out.contains(&format!("sig={sig1}")));
        // 每条分片都走同一条带票端点
        assert_eq!(out.matches("/api/v1/anime/stream?path=").count(), 2);
    }

    #[test]
    fn playlist_keeps_absolute_cdn_uris_and_rewrites_key_uri() {
        let dir = std::env::temp_dir().join(format!("miao-anime-pl2-{}", std::process::id()));
        let pl = dir.join("index.m3u8");
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x1\nhttps://cdn.example.com/a/seg0.ts\n";
        let out = rewrite_playlist(text, &pl, "tok", 2000);
        // 上游 CDN 的绝对地址不能动（改成带票地址反而取不到）
        assert!(out.contains("https://cdn.example.com/a/seg0.ts"));
        assert!(!out.contains("path=https"));
        // 密钥 URI 是相对路径：不换就解不开分片
        let key = dir.join("key.bin").to_string_lossy().into_owned();
        assert!(out.contains(&format!("sig={}", sign("tok", &key, 2000))));
        assert!(out.contains("URI=\"/api/v1/anime/stream?path="));
        // IV 这类其它属性保持原样
        assert!(out.contains("IV=0x1"));
    }
}
