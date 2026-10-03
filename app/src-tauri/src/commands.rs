//! 前端可调用的命令（IPC）—— **桌面端所有对 box-service 的请求都经这里转发**
//!
//! 为什么不从 WebView 直接 fetch：
//! ① 契约 §2.1 的 Origin 白名单只放行 `chrome-extension://*` 与 `null`；Tauri 的 WebView
//!    发请求会带上自己的 Origin（开发期是 `http://localhost:1420`），会被 403 拒绝；
//!    Rust 侧发起的是原生 HTTP 请求，不带 Origin —— 与「Box 桌面端是原生客户端」的契约定位一致。
//! ② 令牌由 Rust 持有并注入请求头，**不进入 WebView**（减少一个泄露面）。
//! ③ 错误信封（契约 §2.2）在这里统一解析成结构化错误，前端拿到的是 code/message/details。
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::service::{ServiceManager, StatusView};

#[derive(Debug, Serialize)]
pub struct ApiErrorView {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl ApiErrorView {
    fn network(msg: impl Into<String>) -> Self {
        Self { status: 0, code: "NETWORK".into(), message: msg.into(), details: None }
    }
    fn service_down() -> Self {
        Self {
            status: 0,
            code: "SERVICE_UNAVAILABLE".into(),
            message: "本地翻译服务未运行（请确认喵坞的服务已启动）".into(),
            details: None,
        }
    }
}

/// 契约 §2.2：所有错误统一信封 `{ error: { code, message, details } }`
fn parse_error(status: u16, body: &str) -> ApiErrorView {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        if let Some(e) = v.get("error") {
            return ApiErrorView {
                status,
                code: e.get("code").and_then(Value::as_str).unwrap_or("INTERNAL").to_string(),
                message: e.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
                details: e.get("details").cloned(),
            };
        }
    }
    ApiErrorView {
        status,
        code: "INTERNAL".into(),
        message: body.chars().take(240).collect(),
        details: None,
    }
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
}

fn target(mgr: &ServiceManager) -> Result<(String, String), ApiErrorView> {
    match (mgr.base_url(), mgr.token()) {
        (Some(base), Some(token)) => Ok((base, token)),
        _ => Err(ApiErrorView::service_down()),
    }
}

fn finish(res: reqwest::blocking::Response) -> Result<Value, ApiErrorView> {
    let status = res.status().as_u16();
    let text = res.text().unwrap_or_default();
    if (200..300).contains(&status) {
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        return Ok(serde_json::from_str(&text).unwrap_or(Value::Null));
    }
    Err(parse_error(status, &text))
}

// ------------------------------------------------------------------ 服务生命周期

#[tauri::command]
pub fn service_status(mgr: State<'_, ServiceManager>) -> StatusView {
    mgr.status()
}

#[tauri::command]
pub fn service_restart(app: AppHandle, mgr: State<'_, ServiceManager>) -> StatusView {
    mgr.stop();
    mgr.start(&app);
    mgr.status()
}

/// 应用退出（托盘菜单 → 二次确认之后调用）
#[tauri::command]
pub fn quit_app(app: AppHandle, mgr: State<'_, ServiceManager>) {
    mgr.stop();
    app.exit(0);
}

/// 关闭窗口 = 仅隐藏（契约 §2.1：服务照跑）
#[tauri::command]
pub fn hide_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// 前端确认弹层用：把主窗口拉到前台
#[tauri::command]
pub fn show_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 把主题同步给原生窗口（G-14）。
///
/// 前端主题是「换 CSS 变量」实现的，只改 WebView 内容区；macOS 的原生标题栏
/// （含红绿灯按钮所在的那条 bar）不会跟着变，导致暗色时「顶部一条白、下面一片黑」。
/// 这里用 `set_theme` 让窗口本身跟随 —— 标题栏底色与红绿灯按钮的配色随之对齐。
/// 入参用 `Option<Theme>`，`None` 表示跟随系统。
#[tauri::command]
pub fn set_theme(app: AppHandle, mode: Option<String>) {
    let theme = match mode.as_deref() {
        Some("dark") => Some(tauri::Theme::Dark),
        Some("light") => Some(tauri::Theme::Light),
        _ => None,
    };
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_theme(theme);
    }
}

// ------------------------------------------------------------------ 契约端点代理

#[tauri::command]
pub fn api_get(mgr: State<'_, ServiceManager>, path: String) -> Result<Value, ApiErrorView> {
    let (base, token) = target(&mgr)?;
    let res = client()
        .get(format!("{base}{path}"))
        .header("X-Box-Token", token)
        .header("X-Box-Client", "box-desktop/0.1.0")
        .send()
        .map_err(|e| ApiErrorView::network(e.to_string()))?;
    finish(res)
}

#[tauri::command]
pub fn api_post(
    mgr: State<'_, ServiceManager>,
    path: String,
    body: Option<Value>,
) -> Result<Value, ApiErrorView> {
    let (base, token) = target(&mgr)?;
    let mut req = client()
        .post(format!("{base}{path}"))
        .header("X-Box-Token", token)
        .header("X-Box-Client", "box-desktop/0.1.0");
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().map_err(|e| ApiErrorView::network(e.to_string()))?;
    finish(res)
}

/// `multipart/form-data` 提交（契约 §5.2）：payload + images[]（≤20 张，由前端分批）
#[tauri::command]
pub fn api_post_multipart(
    mgr: State<'_, ServiceManager>,
    path: String,
    payload: Value,
    files: Vec<String>,
) -> Result<Value, ApiErrorView> {
    let (base, token) = target(&mgr)?;
    let mut form = reqwest::blocking::multipart::Form::new();
    let payload_text = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into());
    form = form.part(
        "payload",
        reqwest::blocking::multipart::Part::text(payload_text).mime_str("application/json").map_err(|e| ApiErrorView::network(e.to_string()))?,
    );
    for (i, f) in files.iter().enumerate() {
        let bytes = std::fs::read(f).map_err(|e| ApiErrorView::network(format!("读取文件失败 {f}：{e}")))?;
        let ext = Path::new(f)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("png")
            .to_ascii_lowercase();
        let mime = match ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            _ => "image/png",
        };
        // filename 由客户端按阅读顺序三位补零（契约 §5.2）；服务端仍会按字节嗅探真实类型
        let name = format!("{:03}.{ext}", i + 1);
        form = form.part(
            "images[]",
            reqwest::blocking::multipart::Part::bytes(bytes)
                .file_name(name)
                .mime_str(mime)
                .map_err(|e| ApiErrorView::network(e.to_string()))?,
        );
    }
    let res = client()
        .post(format!("{base}{path}"))
        .header("X-Box-Token", token)
        .header("X-Box-Client", "box-desktop/0.1.0")
        .multipart(form)
        .send()
        .map_err(|e| ApiErrorView::network(e.to_string()))?;
    finish(res)
}

/// 取库内文件字节（漫画库网格 / 原译对照用）。走 IPC 二进制通道，前端转 blob URL
#[tauri::command]
pub fn api_bytes(
    mgr: State<'_, ServiceManager>,
    path: String,
) -> Result<tauri::ipc::Response, ApiErrorView> {
    let (base, token) = target(&mgr)?;
    let res = client()
        .get(format!("{base}{path}"))
        .header("X-Box-Token", token)
        .send()
        .map_err(|e| ApiErrorView::network(e.to_string()))?;
    let status = res.status().as_u16();
    let bytes = res.bytes().map_err(|e| ApiErrorView::network(e.to_string()))?;
    if !(200..300).contains(&status) {
        return Err(parse_error(status, &String::from_utf8_lossy(&bytes)));
    }
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

// ------------------------------------------------------------------ 本机投放

/// 在系统文件管理器里定位/打开路径（契约 §5.8：reveal 由 **Box** 执行）
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("路径不存在：{path}"));
    }
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&p);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("explorer");
        c.arg(&p);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&p);
        c
    };
    cmd.spawn().map_err(|e| format!("打开失败：{e}"))?;
    Ok(())
}

/// 把投放的路径（文件或目录）展开为**图片文件绝对路径列表**，按文件名自然序排列
///
/// 「阅读顺序」在浏览器里是坐标排序（契约 §7.3），而本机投放的对象是磁盘上的文件，
/// 没有坐标可言 —— 因此按文件名自然序（`1,2,10` 而非 `1,10,2`）排序，这是本地投放的
/// 等效语义，已在 docs/spec-notes.md G-05 记录。
#[tauri::command]
pub fn expand_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    const IMAGE_EXTS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];
    let is_image = |p: &Path| {
        p.extension()
            .and_then(|s| s.to_str())
            .map(|s| IMAGE_EXTS.contains(&s.to_ascii_lowercase().as_str()))
            .unwrap_or(false)
    };

    let mut files: Vec<PathBuf> = Vec::new();
    for raw in &paths {
        let p = PathBuf::from(raw);
        if p.is_dir() {
            let mut entries: Vec<PathBuf> = std::fs::read_dir(&p)
                .map_err(|e| format!("读取目录失败 {raw}：{e}"))?
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.is_file() && is_image(p))
                .collect();
            entries.sort_by(|a, b| natural_cmp(&file_name(a), &file_name(b)));
            files.extend(entries);
        } else if p.is_file() && is_image(&p) {
            files.push(p);
        }
    }
    if files.is_empty() {
        return Err("未找到可投放的图片（支持 png / jpg / jpeg / webp）".into());
    }
    Ok(files.into_iter().map(|p| p.to_string_lossy().to_string()).collect())
}

fn file_name(p: &PathBuf) -> String {
    p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
}

/// 自然序比较：把连续数字段按数值比较（`2.png` < `10.png`）
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (mut ia, mut ib) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ia.peek().copied(), ib.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    let mut na = String::new();
                    while matches!(ia.peek(), Some(c) if c.is_ascii_digit()) {
                        na.push(ia.next().unwrap());
                    }
                    let mut nb = String::new();
                    while matches!(ib.peek(), Some(c) if c.is_ascii_digit()) {
                        nb.push(ib.next().unwrap());
                    }
                    let va: u128 = na.parse().unwrap_or(0);
                    let vb: u128 = nb.parse().unwrap_or(0);
                    if va != vb {
                        return va.cmp(&vb);
                    }
                } else {
                    if ca != cb {
                        return ca.cmp(&cb);
                    }
                    ia.next();
                    ib.next();
                }
            }
        }
    }
}
