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

/// 设置里选定的番剧库根；`None` = 用服务端默认落点（`<数据根>/anime/resources`）。
///
/// 为什么在 Rust 侧记一份而不是读前端偏好：库根决定 animesvc 扫哪个目录，
/// 而**扫描发生在子进程里**。前端偏好只是这份设置的界面，真正生效的地方在这里。
static DESIRED_ROOT: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn desired_root() -> &'static Mutex<Option<String>> {
    DESIRED_ROOT.get_or_init(|| Mutex::new(None))
}

/// 代理策略。`System` = 继承桌面进程环境（默认，与现状一致）；
/// `Off` = 显式关掉（子进程不继承桌面进程的代理变量）；`Custom(url)` = 自定义地址。
#[derive(Clone, Debug, PartialEq)]
enum ProxyChoice {
    System,
    Off,
    Custom(String),
}

static DESIRED_PROXY: OnceLock<Mutex<ProxyChoice>> = OnceLock::new();

fn desired_proxy() -> &'static Mutex<ProxyChoice> {
    DESIRED_PROXY.get_or_init(|| Mutex::new(ProxyChoice::System))
}

/// 把设置里的库根 / 代理传给子进程。库根为空表示回退默认落点。
fn apply_anime_env(cmd: &mut Command) {
    if let Ok(guard) = desired_root().lock() {
        match guard.as_ref() {
            Some(root) => {
                cmd.env("MIAO_ANIME_ROOT_DIR", root);
            }
            None => {
                cmd.env_remove("MIAO_ANIME_ROOT_DIR");
            }
        }
    }
    if let Ok(guard) = desired_proxy().lock() {
        match &*guard {
            ProxyChoice::Custom(url) => {
                cmd.env("HTTP_PROXY", url).env("HTTPS_PROXY", url).env("ALL_PROXY", url);
            }
            // 关掉时连进程环境里的也一起去掉：reqwest 读的是环境变量
            ProxyChoice::Off => {
                cmd.env_remove("HTTP_PROXY")
                    .env_remove("HTTPS_PROXY")
                    .env_remove("ALL_PROXY");
            }
            ProxyChoice::System => {}
        }
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
    let mut cmd = Command::new(&bin);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    apply_anime_env(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| {
        format!("拉起 animesvc 失败（{}）：{e}", bin.display())
    })?;

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

/// 一集的播放源：本地探测 + 带签名的流地址。
///
/// 返回值是**前端唯一需要知道的播放事实**：走哪条轨、能不能播、地址是什么。
/// · `track: "webview"` —— 给 `<video>` 的带票 Range 流（WebView 可解容器）；
/// · `track: "libmpv"`  —— 需要随包内核；`supported: false` 时前端显示"内核未就绪"，
///   而不是给一个放不出来的地址让人对着黑屏猜。
#[tauri::command]
pub async fn anime_play_source(subject_id: String, index: f64) -> Result<Value, String> {
    let (port, token) = tokio::task::spawn_blocking(ensure)
        .await
        .map_err(|e| format!("调度失败：{e}"))??;
    let media = get(&format!(
        "/api/v1/anime/episode/{}/{}/media",
        urlencode(&subject_id),
        index
    ))
    .await?;
    let exp = miao_dock::animesvc::stream::now_secs() + miao_dock::animesvc::stream::TICKET_TTL_SECS;
    play_plan(port, &token, &media, exp)
}

/// 把「探测结果 + 票面」拼成交给前端的播放计划（纯函数，便于单测）。
///
/// 探测没找到片源时**原样透传**：前端要能区分「没有这一集」与「有但播不了」。
fn play_plan(port: u16, token: &str, media: &Value, exp: u64) -> Result<Value, String> {
    if media.get("found").and_then(|v| v.as_bool()) != Some(true) {
        return Ok(media.clone());
    }
    let track = media["track"].as_str().unwrap_or("libmpv").to_string();
    let container = media["container"].as_str().unwrap_or("").to_string();
    if track != "webview" {
        return Ok(json!({
            "found": true,
            "track": "libmpv",
            "supported": false,
            "reason": format!("这一集是 {container} 容器，需要随包播放内核；内核尚未就绪"),
            "container": container,
            "title": media["title"],
            "file": media["file"],
        }));
    }
    let file = media["file"].as_str().ok_or("媒体探测缺少 file")?;
    let subtitles: Vec<Value> = media["subtitles"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|s| {
            let f = s["file"].as_str()?;
            Some(json!({
                "url": stream_url(port, token, f, exp),
                "name": s["name"],
                "format": s["format"],
            }))
        })
        .collect();
    Ok(json!({
        "found": true,
        "track": "webview",
        "supported": true,
        "kind": if container == "m3u8" { "hls" } else { "progressive" },
        "url": stream_url(port, token, file, exp),
        "container": container,
        "sizeBytes": media["sizeBytes"],
        "title": media["title"],
        "subtitles": subtitles,
        "expiresAt": exp * 1000,
    }))
}

/// 按关键词检索 Bangumi 候选。请求由 `animesvc` 发出，前端不直连第三方站点。
#[tauri::command]
pub async fn anime_metadata_search(q: String) -> Result<Value, String> {
    get(&format!("/api/v1/anime/metadata/search?q={}", urlencode(&q))).await
}

/// 把某个 Bangumi 候选补进这一部的 manifest（封面 / 评分 / 简介 / 标签 / 连载星期）。
///
/// 只增不改用户数据：收藏态、进度、剧集列表不受影响（服务侧按补丁白名单合并）。
#[tauri::command]
pub async fn anime_metadata_apply(dir: String, bgm_id: u64) -> Result<Value, String> {
    post("/api/v1/anime/metadata/apply", json!({ "dir": dir, "bgmId": bgm_id })).await
}

/// 重启 animesvc：库根与代理都在子进程**启动时**定，改设置必须重启才生效。
async fn restart_service() -> Result<(), String> {
    stop();
    tokio::task::spawn_blocking(ensure)
        .await
        .map_err(|e| format!("调度失败：{e}"))?
        .map(|_| ())
}

/// 切换番剧库根（设置页「番剧根目录」）；留空 = 回服务端默认落点。
///
/// 目录不存在就建：用户常常先填路径再往里放片。
#[tauri::command]
pub async fn anime_set_library_root(dir: String) -> Result<Value, String> {
    let dir = dir.trim().to_string();
    let resolved = if dir.is_empty() {
        None
    } else {
        let p = PathBuf::from(&dir);
        std::fs::create_dir_all(&p).map_err(|e| format!("目录建不出来：{e}"))?;
        let abs = p.canonicalize().map_err(|e| format!("路径读不通：{e}"))?;
        Some(abs.to_string_lossy().into_owned())
    };
    {
        let mut guard = desired_root().lock().map_err(|e| format!("设置槽被污染：{e}"))?;
        *guard = resolved;
    }
    restart_service().await?;
    Ok(anime_status())
}

/// 切换代理（设置页「代理」）：`off` 关闭 / `system` 继承进程环境 / `custom` 自定义地址。
///
/// 只影响番剧模块的网络请求（元数据、将来的数据源与 BT）；漫画与音乐不受影响。
#[tauri::command]
pub async fn anime_set_proxy(mode: String, url: String) -> Result<Value, String> {
    let choice = match mode.trim() {
        "off" => ProxyChoice::Off,
        "custom" => {
            let u = url.trim();
            if u.is_empty() || !u.starts_with("http") {
                return Err("自定义代理要填 http:// 或 https:// 开头的地址".into());
            }
            ProxyChoice::Custom(u.to_string())
        }
        _ => ProxyChoice::System,
    };
    {
        let mut guard = desired_proxy().lock().map_err(|e| format!("设置槽被污染：{e}"))?;
        *guard = choice;
    }
    restart_service().await?;
    Ok(anime_status())
}

/// 媒体源列表（内置本地库 + 用户自建源；M3 契约，适配器随后接入）。
#[tauri::command]
pub async fn anime_sources() -> Result<Value, String> {
    get("/api/v1/anime/sources").await
}

/// 新增 / 更新一个源（按 id 覆盖；内置源不可改）。
#[tauri::command]
pub async fn anime_save_source(source: Value) -> Result<Value, String> {
    post("/api/v1/anime/sources", source).await
}

/// 删除一个源（内置源拒绝）。
#[tauri::command]
pub async fn anime_delete_source(id: String) -> Result<Value, String> {
    post("/api/v1/anime/sources/delete", json!({ "id": id })).await
}

/// 把本机一个文件夹复制进番剧库根（导入后需重新扫描才会出现在列表）。
#[tauri::command]
pub async fn anime_import_folder(path: String, subject: Option<String>) -> Result<Value, String> {
    post("/api/v1/anime/import", json!({ "path": path, "subject": subject })).await
}

/// 测试一个数据源：拉前几条看看里面是什么（RSS 已接；其余明确回未接入）。
#[tauri::command]
pub async fn anime_test_source(url: String, kind: Option<String>, limit: Option<usize>) -> Result<Value, String> {
    post("/api/v1/anime/sources/test", json!({ "url": url, "kind": kind, "limit": limit })).await
}

/// 拼一条带票的流地址。令牌不进 URL —— 只出现它的签名。
fn stream_url(port: u16, token: &str, file: &str, exp: u64) -> String {
    let sig = miao_dock::animesvc::stream::sign(token, file, exp);
    format!(
        "http://127.0.0.1:{port}/api/v1/anime/stream?path={}&exp={exp}&sig={sig}",
        urlencode(file)
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const PORT: u16 = 47_123;

    fn webview_media(container: &str) -> Value {
        json!({
            "found": true,
            "subjectId": "demo-hyouka",
            "index": 1.0,
            "title": "第 1 话",
            "file": "F:\\Anime\\冰菓\\01 深具传统之香的校园生活.mp4",
            "container": container,
            "track": "webview",
            "sizeBytes": 1_234_567u64,
            "subtitles": [
                { "file": "F:\\Anime\\冰菓\\01.cht.ass", "name": "01.cht.ass", "format": "ass" },
                { "file": "F:\\Anime\\冰菓\\01.chs.ass", "name": "01.chs.ass", "format": "ass" },
            ],
        })
    }

    /// 从 URL 里取一个查询参数并做百分号解码（只给测试用，够覆盖我们自己的编码）。
    fn query_param(url: &str, key: &str) -> Option<String> {
        let query = url.split_once('?')?.1;
        let raw = query
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .find(|(k, _)| *k == key)?
            .1;
        let bytes = raw.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            } else {
                out.push(bytes[i]);
                i += 1;
            }
        }
        String::from_utf8(out).ok()
    }

    #[test]
    fn webview_media_gets_signed_progressive_url() {
        let media = webview_media("mp4");
        let exp = miao_dock::animesvc::stream::now_secs() + 60;
        let plan = play_plan(PORT, TOKEN, &media, exp).unwrap();

        assert_eq!(plan["found"], true);
        assert_eq!(plan["track"], "webview");
        assert_eq!(plan["supported"], true);
        assert_eq!(plan["kind"], "progressive");
        assert_eq!(plan["expiresAt"], json!(exp * 1000));
        assert_eq!(plan["sizeBytes"], json!(1_234_567u64));

        let url = plan["url"].as_str().unwrap();
        assert!(url.starts_with(&format!("http://127.0.0.1:{PORT}/api/v1/anime/stream?")));
        // 令牌本身不得出现在 URL 里：URL 会进日志 / 历史
        assert!(!url.contains(TOKEN));
        assert_eq!(query_param(url, "exp").unwrap(), exp.to_string());

        let path = query_param(url, "path").unwrap();
        assert_eq!(path, media["file"].as_str().unwrap());
        let sig = query_param(url, "sig").unwrap();
        // 签名必须能被服务端验票逻辑接受（同一条 path / exp）
        assert!(miao_dock::animesvc::stream::verify(TOKEN, &path, exp, &sig));
        // 但换路径就失效
        assert!(!miao_dock::animesvc::stream::verify(TOKEN, "F:\\Anime\\冰菓\\02.mp4", exp, &sig));
    }

    #[test]
    fn m3u8_is_marked_as_hls() {
        let plan = play_plan(PORT, TOKEN, &webview_media("m3u8"), 1).unwrap();
        assert_eq!(plan["kind"], "hls");
    }

    #[test]
    fn subtitles_get_their_own_verified_tickets() {
        let media = webview_media("mp4");
        let exp = miao_dock::animesvc::stream::now_secs() + 60;
        let plan = play_plan(PORT, TOKEN, &media, exp).unwrap();
        let subs = plan["subtitles"].as_array().unwrap();
        assert_eq!(subs.len(), 2);

        let expected: Vec<&str> = media["subtitles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["file"].as_str().unwrap())
            .collect();
        for (sub, file) in subs.iter().zip(expected) {
            assert!(sub["name"].as_str().unwrap().ends_with(".ass"));
            assert_eq!(sub["format"], "ass");
            let url = sub["url"].as_str().unwrap();
            let path = query_param(url, "path").unwrap();
            assert_eq!(path, file);
            let sig = query_param(url, "sig").unwrap();
            assert!(miao_dock::animesvc::stream::verify(TOKEN, &path, exp, &sig));
        }
        // 字幕与主视频共用同一个过期时刻，前端只需记一个 expiresAt
        assert_eq!(plan["expiresAt"], json!(exp * 1000));
    }

    #[test]
    fn kernel_track_reports_unsupported_instead_of_fake_url() {
        let media = json!({
            "found": true,
            "title": "第 3 话",
            "file": "F:\\Anime\\冰菓\\03.mkv",
            "container": "mkv",
            "track": "libmpv",
            "sizeBytes": 9u64,
            "subtitles": [],
        });
        let plan = play_plan(PORT, TOKEN, &media, 1).unwrap();
        assert_eq!(plan["track"], "libmpv");
        assert_eq!(plan["supported"], false);
        assert!(plan["reason"].as_str().unwrap().contains("mkv"));
        // 不能给一个播不出来的地址：前端只会对着黑屏猜
        assert!(plan.get("url").is_none());
    }

    #[test]
    fn missing_media_is_passed_through() {
        let media = json!({
            "found": false,
            "subjectId": "demo-hyouka",
            "index": 1.0,
            "reason": "这一集还没有落盘的视频文件",
            "skipped": [],
        });
        let plan = play_plan(PORT, TOKEN, &media, 1).unwrap();
        assert_eq!(plan, media);
    }

    #[test]
    fn webview_media_without_file_is_an_error() {
        let media = json!({ "found": true, "track": "webview", "container": "mp4" });
        assert!(play_plan(PORT, TOKEN, &media, 1).is_err());
    }
}
