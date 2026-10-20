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

/// BT 监听端口与 peer 过滤订阅（R5）：由设置页写入，**在下次拉起 animesvc 时生效**。
/// 会话只在首次添加磁力时创建，所以"先设端口再加任务"就是即时生效的那条路。
static DESIRED_BT_PORT: OnceLock<Mutex<Option<u16>>> = OnceLock::new();
static DESIRED_BT_PEER_FILTER: OnceLock<Mutex<Option<String>>> = OnceLock::new();

static DESIRED_BT_LIMITS: OnceLock<Mutex<(Option<u32>, Option<u32>, Option<f64>)>> = OnceLock::new();

fn desired_bt_limits() -> &'static Mutex<(Option<u32>, Option<u32>, Option<f64>)> {
    DESIRED_BT_LIMITS.get_or_init(|| Mutex::new((None, None, None)))
}

fn desired_bt_port() -> &'static Mutex<Option<u16>> {
    DESIRED_BT_PORT.get_or_init(|| Mutex::new(None))
}

fn desired_bt_peer_filter() -> &'static Mutex<Option<String>> {
    DESIRED_BT_PEER_FILTER.get_or_init(|| Mutex::new(None))
}

/// 把设置页的 BT 端口 / peer 过滤订阅记下来（下次拉起子进程时注入环境变量）。
#[tauri::command]
pub fn anime_set_bt_options(port: Option<u16>, peer_filter_url: Option<String>) -> Result<Value, String> {
    if let Ok(mut g) = desired_bt_port().lock() {
        *g = port.filter(|p| *p > 0);
    }
    if let Ok(mut g) = desired_bt_peer_filter().lock() {
        *g = peer_filter_url
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
    }
    Ok(json!({ "ok": true }))
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
    if let Ok(guard) = desired_bt_limits().lock() {
        let (down, up, ratio) = *guard;
        match down {
            Some(v) => {
                cmd.env("MIAO_ANIME_BT_DOWN_KBPS", v.to_string());
            }
            None => {
                cmd.env_remove("MIAO_ANIME_BT_DOWN_KBPS");
            }
        }
        match up {
            Some(v) => {
                cmd.env("MIAO_ANIME_BT_UP_KBPS", v.to_string());
            }
            None => {
                cmd.env_remove("MIAO_ANIME_BT_UP_KBPS");
            }
        }
        match ratio {
            Some(v) => {
                cmd.env("MIAO_ANIME_BT_SEED_RATIO", v.to_string());
            }
            None => {
                cmd.env_remove("MIAO_ANIME_BT_SEED_RATIO");
            }
        }
    }
    if let Ok(guard) = desired_bt_port().lock() {
        match *guard {
            Some(port) => {
                cmd.env("MIAO_ANIME_BT_PORT", port.to_string());
            }
            None => {
                cmd.env_remove("MIAO_ANIME_BT_PORT");
            }
        }
    }
    if let Ok(guard) = desired_bt_peer_filter().lock() {
        match guard.as_ref() {
            Some(url) => {
                cmd.env("MIAO_ANIME_BT_PEER_FILTER", url);
            }
            None => {
                cmd.env_remove("MIAO_ANIME_BT_PEER_FILTER");
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
    // 内核可不可用是**本机事实**（随包二进制在不在），探测是几次 stat，不必过服务
    let kernel = miao_dock::animesvc::kernel::probe();
    play_plan(port, &token, &media, exp, kernel.available, &kernel.reason)
}

/// 把「探测结果 + 票面 + 内核可用性」拼成交给前端的播放计划（纯函数，便于单测）。
///
/// 探测没找到片源时**原样透传**：前端要能区分「没有这一集」与「有但播不了」。
fn play_plan(
    port: u16,
    token: &str,
    media: &Value,
    exp: u64,
    kernel_available: bool,
    kernel_reason: &str,
) -> Result<Value, String> {
    if media.get("found").and_then(|v| v.as_bool()) != Some(true) {
        return Ok(media.clone());
    }
    let track = media["track"].as_str().unwrap_or("libmpv").to_string();
    let container = media["container"].as_str().unwrap_or("").to_string();
    if track != "webview" {
        // 内核轨：画面在 mpv 自己的窗口里，应用只经 IPC 驱动（R1 的形态）。
        // 内核缺失时**不给地址**，只给原因 —— 给一个播不出来的地址等于让人对着黑屏猜。
        let reason = if kernel_available {
            format!("这一集是 {container} 容器，由随包内核在独立窗口播放")
        } else {
            format!("这一集是 {container} 容器，需要随包播放内核；{kernel_reason}")
        };
        let subs: Vec<Value> = media["subtitles"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|s| {
                Some(json!({
                    "name": s["name"],
                    "file": s["file"],
                    "format": s["format"],
                }))
            })
            .collect();
        return Ok(json!({
            "found": true,
            "track": "libmpv",
            "supported": kernel_available,
            "external": true,
            "reason": reason,
            "container": container,
            "title": media["title"],
            "file": media["file"],
            "sizeBytes": media["sizeBytes"],
            "subtitles": subs,
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
///
/// 筛选参数（年份 / 季度 / 标签 / 排序）只在给了的时候拼进查询串 —— 空值不传，
/// 服务侧据此决定走普通检索还是带筛选的检索。
#[tauri::command]
pub async fn anime_metadata_search(
    q: String,
    year: Option<u32>,
    quarter: Option<u32>,
    tag: Option<String>,
    sort: Option<String>,
) -> Result<Value, String> {
    let mut url = format!("/api/v1/anime/metadata/search?q={}", urlencode(&q));
    if let Some(y) = year {
        url.push_str(&format!("&year={y}"));
    }
    if let Some(qt) = quarter {
        url.push_str(&format!("&quarter={qt}"));
    }
    if let Some(t) = tag.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        url.push_str(&format!("&tag={}", urlencode(t)));
    }
    if let Some(s) = sort.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        url.push_str(&format!("&sort={}", urlencode(s)));
    }
    get(&url).await
}

/// 把某个 Bangumi 候选补进这一部的 manifest（封面 / 评分 / 简介 / 标签 / 连载星期）。
///
/// 只增不改用户数据：收藏态、进度、剧集列表不受影响（服务侧按补丁白名单合并）。
#[tauri::command]
pub async fn anime_metadata_apply(dir: String, bgm_id: u64) -> Result<Value, String> {
    post("/api/v1/anime/metadata/apply", json!({ "dir": dir, "bgmId": bgm_id })).await
}

/// 探索页：本周新番时间表（Bangumi `/calendar`，条目是整条 subject）。
#[tauri::command]
pub async fn anime_metadata_calendar() -> Result<Value, String> {
    get("/api/v1/anime/metadata/calendar").await
}

/// 探索页：热度推荐（服务侧在 `heat` 不可用时退回排行，`source` 字段说明来源）。
#[tauri::command]
pub async fn anime_metadata_hot(limit: Option<usize>) -> Result<Value, String> {
    get(&format!("/api/v1/anime/metadata/hot?limit={}", limit.unwrap_or(12))).await
}

/// 把 Bangumi 条目建成一条新番剧（只有元数据、没有片源；同一部幂等）。
#[tauri::command]
pub async fn anime_metadata_import(bgm_id: u64) -> Result<Value, String> {
    post("/api/v1/anime/metadata/import", json!({ "bgmId": bgm_id })).await
}

/// 粘贴 Bangumi 链接 / 手输编号 → 建库（解析在服务侧，前端只做"像不像链接"的粗筛）。
#[tauri::command]
pub async fn anime_metadata_import_ref(input: String) -> Result<Value, String> {
    post("/api/v1/anime/metadata/import-ref", json!({ "input": input })).await
}

/// 详情页补充数据：角色 + 声优（按 Bangumi id 现取，不落盘）。
#[tauri::command]
pub async fn anime_metadata_characters(bgm_id: u64) -> Result<Value, String> {
    get(&format!("/api/v1/anime/metadata/characters?bgmId={bgm_id}")).await
}

/// 详情页补充数据：制作人员。
#[tauri::command]
pub async fn anime_metadata_staff(bgm_id: u64) -> Result<Value, String> {
    get(&format!("/api/v1/anime/metadata/staff?bgmId={bgm_id}")).await
}

/// 详情页补充数据：关联作品。
#[tauri::command]
pub async fn anime_metadata_related(bgm_id: u64) -> Result<Value, String> {
    get(&format!("/api/v1/anime/metadata/related?bgmId={bgm_id}")).await
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
pub async fn anime_test_source(
    url: String,
    kind: Option<String>,
    limit: Option<usize>,
    rules: Option<Value>,
    cookies: Option<Value>,
) -> Result<Value, String> {
    post(
        "/api/v1/anime/sources/test",
        json!({ "url": url, "kind": kind, "limit": limit, "rules": rules, "cookies": cookies }),
    )
    .await
}

/// 通用网页源：详情页 → 视频直链（播放器 / 中继要的是直链，不是详情页地址）。
#[tauri::command]
pub async fn anime_resolve_source(url: String, rules: Value, cookies: Option<Value>) -> Result<Value, String> {
    post(
        "/api/v1/anime/sources/resolve",
        json!({ "url": url, "rules": rules, "cookies": cookies }),
    )
    .await
}

/// 当前 BT 限速与做种上限。
#[tauri::command]
pub async fn anime_bt_limits() -> Result<Value, String> {
    get("/api/v1/anime/bt/limits").await
}

/// 改 BT 限速 / 做种上限（运行期立刻生效）。
#[tauri::command]
pub async fn anime_set_bt_limits(
    down_kbps: Option<u32>,
    up_kbps: Option<u32>,
    seed_ratio: Option<f64>,
) -> Result<Value, String> {
    post(
        "/api/v1/anime/bt/limits",
        json!({ "downKbps": down_kbps, "upKbps": up_kbps, "seedRatio": seed_ratio }),
    )
    .await
}

/// BT 边下边播：拿一个带票的可播放地址（票 2 小时；过期重点一次播放）。
#[tauri::command]
pub async fn anime_bt_stream_url(id: u64) -> Result<Value, String> {
    get(&format!("/api/v1/anime/bt/stream-url?id={id}")).await
}

/// PikPak 接口状态（只留接口：`implemented` 恒 false）。
#[tauri::command]
pub async fn anime_bt_pikpak(account: Option<String>) -> Result<Value, String> {
    let q = account.map(|a| format!("?account={}", urlencode(&a))).unwrap_or_default();
    get(&format!("/api/v1/anime/bt/pikpak{q}")).await
}

/// 最小 URL 编码（只处理 query 里会出事的字符，不引依赖）。
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// BT 任务列表（进度 / 做种比来自 librqbit）。
#[tauri::command]
pub async fn anime_bt_list() -> Result<Value, String> {
    get("/api/v1/anime/bt").await
}

/// BT 会话状态（端口 / 聚合速率 / 任务数）。
#[tauri::command]
pub async fn anime_bt_stats() -> Result<Value, String> {
    get("/api/v1/anime/bt/stats").await
}

/// 添加磁力 / 种子。
#[tauri::command]
pub async fn anime_bt_add(url: String) -> Result<Value, String> {
    post("/api/v1/anime/bt/add", json!({ "url": url })).await
}

/// 暂停 BT 任务。
#[tauri::command]
pub async fn anime_bt_pause(id: u64) -> Result<Value, String> {
    post("/api/v1/anime/bt/pause", json!({ "id": id })).await
}

/// 继续 BT 任务。
#[tauri::command]
pub async fn anime_bt_resume(id: u64) -> Result<Value, String> {
    post("/api/v1/anime/bt/resume", json!({ "id": id })).await
}

/// 删除 BT 任务（可选连文件一起删）。
#[tauri::command]
pub async fn anime_bt_delete(id: u64, delete_files: Option<bool>) -> Result<Value, String> {
    post(
        "/api/v1/anime/bt/delete",
        json!({ "id": id, "deleteFiles": delete_files.unwrap_or(false) }),
    )
    .await
}

/// 账号状态（登录态 / 队列 / 中继地址）。
#[tauri::command]
pub async fn anime_account() -> Result<Value, String> {
    get("/api/v1/anime/account").await
}

/// 邮箱密码登录。
#[tauri::command]
pub async fn anime_account_login(email: String, password: String) -> Result<Value, String> {
    post("/api/v1/anime/account/login", json!({ "email": email, "password": password })).await
}

/// 设备码 / 扫码：开始（返回 deviceCode / userCode / 轮询间隔）。
#[tauri::command]
pub async fn anime_account_device_start(kind: String) -> Result<Value, String> {
    post("/api/v1/anime/account/device/start", json!({ "kind": kind })).await
}

/// 设备码 / 扫码：轮询一次。
#[tauri::command]
pub async fn anime_account_device_poll(device_code: String) -> Result<Value, String> {
    post("/api/v1/anime/account/device/poll", json!({ "deviceCode": device_code })).await
}

/// 桩专用：模拟另一端确认（真中继由手机 / 浏览器完成）。
#[tauri::command]
pub async fn anime_account_device_approve(device_code: String) -> Result<Value, String> {
    post("/api/v1/anime/account/device/approve", json!({ "deviceCode": device_code })).await
}

/// 退出登录。
#[tauri::command]
pub async fn anime_account_logout() -> Result<Value, String> {
    post("/api/v1/anime/account/logout", json!({})).await
}

/// 入队一条待同步条目（收藏 / 进度）。
#[tauri::command]
pub async fn anime_account_enqueue(item: Value) -> Result<Value, String> {
    post("/api/v1/anime/account/enqueue", json!({ "item": item })).await
}

/// 手动挑边：`local` 覆盖云端 / `remote` 采纳云端。
#[tauri::command]
pub async fn anime_resolve_conflict(id: String, side: String) -> Result<Value, String> {
    post(
        "/api/v1/anime/account/conflict/resolve",
        json!({ "id": id, "side": side }),
    )
    .await
}

/// 同步一次（推队列 → 冲突按策略处理 → 拉云端）。
#[tauri::command]
pub async fn anime_account_sync(policy: String) -> Result<Value, String> {
    post("/api/v1/anime/account/sync", json!({ "policy": policy })).await
}

/// 缓存任务列表（进度以盘上为准）。
#[tauri::command]
pub async fn anime_cache() -> Result<Value, String> {
    get("/api/v1/anime/cache").await
}

/// 新建缓存任务（HTTP 直链；cacheDir / limitGb 来自设置）。
#[tauri::command]
pub async fn anime_cache_add(payload: Value) -> Result<Value, String> {
    post("/api/v1/anime/cache", payload).await
}

/// 暂停缓存任务。
#[tauri::command]
pub async fn anime_cache_pause(id: String) -> Result<Value, String> {
    post("/api/v1/anime/cache/pause", json!({ "id": id })).await
}

/// 继续缓存任务（带 Range 续传）。
#[tauri::command]
pub async fn anime_cache_resume(id: String) -> Result<Value, String> {
    post("/api/v1/anime/cache/resume", json!({ "id": id })).await
}

/// 删除缓存任务（连同盘上文件）。
#[tauri::command]
pub async fn anime_cache_delete(id: String) -> Result<Value, String> {
    post("/api/v1/anime/cache/delete", json!({ "id": id })).await
}

/// 从订阅地址拉一份规则草稿（服务侧解析并校验，前端填进编辑器由用户确认保存）。
#[tauri::command]
pub async fn anime_subscribe_source(url: String) -> Result<Value, String> {
    post("/api/v1/anime/sources/subscribe", json!({ "url": url })).await
}

/// 验证码窗口的标签（同一时刻只开一个，重复打开就导航到新地址）。
const CHALLENGE_LABEL: &str = "anime-challenge";

/// 打开「过验证码」窗口：用户在里面手动完成验证，之后用 `anime_challenge_cookies` 取会话。
#[tauri::command]
pub async fn anime_open_challenge(app: tauri::AppHandle, url: String) -> Result<Value, String> {
    if !url.starts_with("http") {
        return Err("要 http:// 或 https:// 地址".into());
    }
    let parsed: tauri::Url = url.parse().map_err(|e| format!("地址不合法：{e}"))?;
    if let Some(w) = app.get_webview_window(CHALLENGE_LABEL) {
        w.navigate(parsed).map_err(|e| format!("验证码窗口导航失败：{e}"))?;
        let _ = w.set_focus();
        return Ok(json!({ "ok": true, "reused": true }));
    }
    tauri::WebviewWindowBuilder::new(&app, CHALLENGE_LABEL, tauri::WebviewUrl::External(parsed))
        .title("过验证码 · 喵坞")
        .inner_size(1040.0, 760.0)
        .build()
        .map_err(|e| format!("验证码窗口打不开：{e}"))?;
    Ok(json!({ "ok": true, "reused": false }))
}

/// 从验证码窗口读出该地址的会话 cookie（抓取层拿它当 `Cookie` 头）。
#[tauri::command]
pub async fn anime_challenge_cookies(app: tauri::AppHandle, url: String) -> Result<Value, String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("地址不合法：{e}"))?;
    let w = app
        .get_webview_window(CHALLENGE_LABEL)
        .ok_or("验证码窗口还没打开")?;
    let cookies = w
        .cookies_for_url(parsed)
        .map_err(|e| format!("读验证码窗口的 cookie 失败：{e}"))?;
    let list: Vec<Value> = cookies
        .iter()
        .map(|c| json!({ "name": c.name(), "value": c.value() }))
        .collect();
    Ok(json!({ "ok": true, "cookies": list }))
}

/// 远程播放事实：媒体服务器（Jellyfin / Emby）的某一集，走服务侧中继的带票直链。
///
/// 与 `anime_play_source` 的分工：那个回答「本机这一集在哪、走哪条轨」；
/// 这个回答「远程库里那一集怎么播」。两者的返回形状对齐（`kind` / `url` / `expiresAt`），
/// 前端播放器因此只需要一套接线。
#[tauri::command]
pub async fn anime_play_remote(source_id: String, item_id: String) -> Result<Value, String> {
    let (port, token) = tokio::task::spawn_blocking(ensure)
        .await
        .map_err(|e| format!("调度失败：{e}"))??;
    // 服务侧再校验一次：源必须存在、是媒体服务器类型、且处于启用状态
    // （前端只负责展示，真正的边界在这里）
    let sources = get("/api/v1/anime/sources").await?;
    let ok = sources["sources"]
        .as_array()
        .map(|list| {
            list.iter().any(|s| {
                s["id"] == source_id
                    && (s["kind"] == "jellyfin" || s["kind"] == "emby")
                    && s["enabled"] == true
            })
        })
        .unwrap_or(false);
    if !ok {
        return Err("这个媒体服务器源不在列表里（或已停用）".into());
    }
    let exp = miao_dock::animesvc::stream::now_secs() + miao_dock::animesvc::stream::TICKET_TTL_SECS;
    let key = miao_dock::animesvc::datasource::mediaserver::ticket_key(&source_id, &item_id);
    let sig = miao_dock::animesvc::stream::sign(&token, &key, exp);
    Ok(json!({
        "ok": true,
        "kind": "progressive",
        "url": format!(
            "http://127.0.0.1:{port}/api/v1/anime/mediaserver/stream?src={}&item={}&exp={exp}&sig={sig}",
            urlencode(&source_id),
            urlencode(&item_id),
        ),
        "expiresAt": exp * 1000,
    }))
}

/// 内核轨状态：可不可用（二进制在不在）+ 当前会话快照（音轨 / 字幕 / 进度 / 缓冲）。
#[tauri::command]
pub async fn anime_kernel_status() -> Result<Value, String> {
    get("/api/v1/anime/kernel").await
}

/// 用内核打开一集：服务侧解析「这一集在盘上的哪个文件」，再交给 mpv（独立窗口）。
#[tauri::command]
pub async fn anime_kernel_open(subject_id: String, index: f64, hwdec: Option<String>) -> Result<Value, String> {
    post(
        "/api/v1/anime/kernel/open",
        json!({ "subject": subject_id, "index": index, "hwdec": hwdec }),
    )
    .await
}

/// 驱动内核：`play` / `pause` / `seek` / `rate` / `track` / `subtitle`。
#[tauri::command]
pub async fn anime_kernel_ctl(action: String, value: Option<Value>) -> Result<Value, String> {
    post(
        "/api/v1/anime/kernel/ctl",
        json!({ "action": action, "value": value.unwrap_or(Value::Null) }),
    )
    .await
}

/// 关掉内核会话（离开播放器 / 换集时调）。
#[tauri::command]
pub async fn anime_kernel_close() -> Result<Value, String> {
    post("/api/v1/anime/kernel/close", json!({})).await
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
        let plan = play_plan(PORT, TOKEN, &media, exp, false, "内核未安装").unwrap();

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
        let plan = play_plan(PORT, TOKEN, &webview_media("m3u8"), 1, false, "内核未安装").unwrap();
        assert_eq!(plan["kind"], "hls");
    }

    #[test]
    fn subtitles_get_their_own_verified_tickets() {
        let media = webview_media("mp4");
        let exp = miao_dock::animesvc::stream::now_secs() + 60;
        let plan = play_plan(PORT, TOKEN, &media, exp, false, "内核未安装").unwrap();
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
    fn kernel_track_reports_unsupported_when_kernel_missing() {
        let media = kernel_media();
        let plan = play_plan(PORT, TOKEN, &media, 1, false, "找不到 mpv").unwrap();
        assert_eq!(plan["track"], "libmpv");
        assert_eq!(plan["supported"], false);
        assert_eq!(plan["external"], true);
        // 原因里要有「为什么」：mkv 容器 + 内核缺失各说一次
        let reason = plan["reason"].as_str().unwrap();
        assert!(reason.contains("mkv"));
        assert!(reason.contains("找不到 mpv"));
        // 不能给一个播不出来的地址：前端只会对着黑屏猜
        assert!(plan.get("url").is_none());
    }

    #[test]
    fn kernel_track_is_playable_when_kernel_ready() {
        let media = kernel_media();
        let plan = play_plan(PORT, TOKEN, &media, 1, true, "").unwrap();
        assert_eq!(plan["track"], "libmpv");
        assert_eq!(plan["supported"], true);
        assert_eq!(plan["external"], true);
        assert_eq!(plan["file"], media["file"]);
        // 内核自己读盘：字幕给的是文件路径，不是带票 URL
        let subs = plan["subtitles"].as_array().unwrap();
        assert_eq!(subs.len(), 1);
        assert!(subs[0].get("url").is_none());
        assert_eq!(subs[0]["file"], media["subtitles"][0]["file"]);
    }

    /// mkv 一集的探测结果（内核轨的输入）
    fn kernel_media() -> Value {
        json!({
            "found": true,
            "title": "第 3 话",
            "file": "F:\\Anime\\冰菓\\03.mkv",
            "container": "mkv",
            "track": "libmpv",
            "sizeBytes": 9u64,
            "subtitles": [{ "file": "F:\\Anime\\冰菓\\03.ass", "name": "03.ass", "format": "ass" }],
        })
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
        let plan = play_plan(PORT, TOKEN, &media, 1, false, "内核未安装").unwrap();
        assert_eq!(plan, media);
    }

    #[test]
    fn webview_media_without_file_is_an_error() {
        let media = json!({ "found": true, "track": "webview", "container": "mp4" });
        assert!(play_plan(PORT, TOKEN, &media, 1, false, "内核未安装").is_err());
    }
}
