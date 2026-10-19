//! 动漫模块的**应用侧桥接**（D-242 的壳层集成）。
//!
//! ## 职责边界
//! `animesvc` 是独立可执行文件（自己一份 state / 令牌 / 库根）。本模块只做三件事：
//! ① 按需拉起它并记住端口与令牌；② 把请求代理给它；③ 退出时收干净。
//! **业务规则一行都不在这里** —— 扫描、manifest、收藏、进度全在 `animesvc` 侧，
//! 这样 CLI / e2e / 桌面端跑的是同一套实现（避免第二条实现路径）。
//!
//! ## 为什么懒启动而不是随应用启动
//! 用户可能一整天都在漫画翻译里，从不打开番剧。番剧进程带着自己的库扫描与将来的
//! 引擎栈，没必要为空跑买单；第一次进番剧（或第一次调状态）时才拉起。
//!
//! ## 与漫画服务互不干扰
//! 不共用 `ServiceManager`：它管的是"漫画服务 ①②③"的生死与就绪判定，
//! 把动漫塞进去会让漫画的 de­graded/重启逻辑跟着动漫一起抖。两者各持一个子进程槽。

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

/// 子进程 + 它自报的端口与令牌。
struct AnimeProc {
    child: Child,
    port: u16,
    token: String,
    root: String,
}

///
static SLOT: OnceLock<Mutex<Option<AnimeProc>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<AnimeProc>> {
    SLOT.get_or_init(|| Mutex::new(None))
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "animesvc.exe"
    } else {
        "animesvc"
    }
}

/// animesvc 的位置：环境变量 → 与主程序同级（安装态）→ target/debug（开发态）。
fn bin_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("MIAO_ANIMESVC_BIN") {
        if !p.is_empty() {
            let pb = PathBuf::from(p);
            if pb.exists() {
                return Some(pb);
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sib = dir.join(exe_name());
            if sib.exists() {
                return Some(sib);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("debug").join(exe_name());
    if dev.exists() {
        return Some(dev);
    }
    None
}

/// 拉起进程并读就绪行（`[anime-service] ANIME_READY {json}`），最多等 15s。
fn spawn() -> Result<AnimeProc, String> {
    let bin = bin_path().ok_or_else(|| {
        format!(
            "找不到 animesvc（找过 MIAO_ANIMESVC_BIN、程序同级目录、src-tauri/target/debug）—— 先跑 cargo build --bin animesvc"
        )
    })?;
    let mut child = Command::new(&bin)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("拉起 animesvc 失败（{}）：{e}", bin.display()))?;

    let stdout = child.stdout.take().ok_or("animesvc 没有 stdout 管道")?;
    let (tx, rx) = mpsc::channel::<Result<Value, String>>();
    std::thread::spawn(move || {
        let mut sent = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix("[anime-service] ANIME_READY ") {
                match serde_json::from_str::<Value>(rest) {
                    Ok(v) => {
                        let _ = tx.send(Ok(v));
                        sent = true;
                        break;
                    }
                    Err(e) => {
                        let _ = tx.send(Err(format!("就绪行解析失败：{e}")));
                        sent = true;
                        break;
                    }
                }
            }
        }
        if !sent {
            let _ = tx.send(Err("animesvc 未打印就绪行就退出了".into()));
        }
    });

    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(info)) => {
            let port = info.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let token = info.get("token").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let root = info.get("rootDir").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            if port == 0 || token.is_empty() {
                let _ = child.kill();
                return Err("animesvc 就绪行缺少 port/token".into());
            }
            Ok(AnimeProc { child, port, token, root })
        }
        Ok(Err(e)) => {
            let _ = child.kill();
            Err(e)
        }
        Err(_) => {
            let _ = child.kill();
            Err("等 animesvc 就绪超时（15s）".into())
        }
    }
}

/// 确保进程在跑，返回端口与令牌。
fn ensure() -> Result<(u16, String), String> {
    let mut guard = slot().lock().map_err(|e| format!("anime 进程槽被污染：{e}"))?;
    if let Some(p) = guard.as_mut() {
        // 进程自己退了（被外部杀掉 / 崩溃）就地重启 —— 不要返回一个死端口
        match p.child.try_wait() {
            Ok(None) => return Ok((p.port, p.token.clone())),
            _ => {
                *guard = None;
            }
        }
    }
    let proc = spawn()?;
    let out = (proc.port, proc.token.clone());
    *guard = Some(proc);
    Ok(out)
}

/// 停止进程（幂等）。
pub fn stop() {
    if let Ok(mut guard) = slot().lock() {
        if let Some(mut p) = guard.take() {
            let _ = p.child.kill();
            let _ = p.child.wait();
        }
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败：{e}"))
}

/// GET 代理：自动补 base 与令牌。
async fn get(path: &str) -> Result<Value, String> {
    let (port, token) = tokio::task::spawn_blocking(ensure)
        .await
        .map_err(|e| format!("调度失败：{e}"))??;
    let res = client()?
        .get(format!("http://127.0.0.1:{port}{path}"))
        .header("X-Box-Token", token)
        .header("X-Box-Client", "box-desktop/0.1.0")
        .send()
        .await
        .map_err(|e| format!("动漫服务请求失败：{e}"))?;
    finish(res).await
}

/// POST 代理。
async fn post(path: &str, body: Value) -> Result<Value, String> {
    let (port, token) = tokio::task::spawn_blocking(ensure)
        .await
        .map_err(|e| format!("调度失败：{e}"))??;
    let res = client()?
        .post(format!("http://127.0.0.1:{port}{path}"))
        .header("X-Box-Token", token)
        .header("X-Box-Client", "box-desktop/0.1.0")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("动漫服务请求失败：{e}"))?;
    finish(res).await
}

async fn finish(res: reqwest::Response) -> Result<Value, String> {
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("动漫服务返回 {status}：{text}"));
    }
    serde_json::from_str::<Value>(&text).map_err(|e| format!("响应不是 JSON：{e}（{text}）"))
}

// ============================================================
//  Tauri Commands —— 统一 `anime_` 前缀（模块命名硬约束）
// ============================================================

/// 服务状态：端口与库根可以给前端看，**令牌不出 Rust**（前端拿不到就不存在泄漏面）。
#[tauri::command]
pub fn anime_status() -> Value {
    let running = slot().lock().ok().and_then(|g| g.as_ref().map(|p| (p.port, p.root.clone())));
    // `platform` 住在 lib crate（`miao_dock`）里，bin 的模块树里没有它 —— 与 `mangasvc` 同一理由
    let paths = miao_dock::platform::paths::anime_snapshot();
    match running {
        Some((port, root)) => json!({
            "running": true,
            "port": port,
            "rootDir": root,
            "bin": bin_path().map(|p| p.to_string_lossy().into_owned()),
            "paths": paths,
        }),
        None => json!({
            "running": false,
            "port": null,
            "rootDir": null,
            "bin": bin_path().map(|p| p.to_string_lossy().into_owned()),
            "paths": paths,
        }),
    }
}

/// 手动拉起（首次进番剧时前端会调；也留给设置页「重启服务」用）。
#[tauri::command]
pub async fn anime_start() -> Result<Value, String> {
    tokio::task::spawn_blocking(ensure)
        .await
        .map_err(|e| format!("调度失败：{e}"))??;
    Ok(anime_status())
}

#[tauri::command]
pub async fn anime_stop() -> Result<Value, String> {
    tokio::task::spawn_blocking(stop)
        .await
        .map_err(|e| format!("调度失败：{e}"))?;
    Ok(anime_status())
}

/// 番剧库扫描（唯一数据入口；前端不直接读盘）。
#[tauri::command]
pub async fn anime_library() -> Result<Value, String> {
    get("/api/v1/anime/library").await
}

/// 单部明细（集列表 + 目录）。
#[tauri::command]
pub async fn anime_entry(name: String) -> Result<Value, String> {
    get(&format!("/api/v1/anime/library/{}", urlencode(&name))).await
}

/// 保存条目（新建 / 改元数据）。
#[tauri::command]
pub async fn anime_save_subject(subject: Value) -> Result<Value, String> {
    post("/api/v1/anime/subject", subject).await
}

/// 改收藏态（五状态按钮）。
#[tauri::command]
pub async fn anime_set_collection(id: String, collection: Option<String>) -> Result<Value, String> {
    post("/api/v1/anime/collection", json!({ "id": id, "collection": collection })).await
}

/// 保存一集进度。
#[tauri::command]
pub async fn anime_save_episode(episode: Value) -> Result<Value, String> {
    post("/api/v1/anime/progress", episode).await
}

/// 载入示例数据（显式动作；可整批清掉）。
#[tauri::command]
pub async fn anime_seed_demo() -> Result<Value, String> {
    post("/api/v1/anime/demo", json!({})).await
}

#[tauri::command]
pub async fn anime_clear_demo() -> Result<Value, String> {
    post("/api/v1/anime/demo/clear", json!({})).await
}

/// 路径快照（设置页展示落点用；键集与 `--print-paths` 同源）。
#[tauri::command]
pub fn anime_paths() -> Value {
    miao_dock::platform::paths::anime_snapshot()
}

/// 极简百分号编码：作品名可能带空格 / 中文，直接拼进路径会 400。
fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
