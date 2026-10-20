//! 前端可调用的命令（IPC）—— **桌面端所有对 manga-service 的请求都经这里转发**
//!
//! 为什么不从 WebView 直接 fetch：
//! ① 契约 §2.1 的 Origin 白名单只放行 `chrome-extension://*` 与 `null`；Tauri 的 WebView
//!    发请求会带上自己的 Origin（开发期是 `http://localhost:1420`），会被 403 拒绝；
//!    Rust 侧发起的是原生 HTTP 请求，不带 Origin —— 与「Box 桌面端是原生客户端」的契约定位一致。
//! ② 令牌由 Rust 持有并注入请求头，**不进入 WebView**（减少一个泄露面）。
//! ③ 错误信封（契约 §2.2）在这里统一解析成结构化错误，前端拿到的是 code/message/details。
//!
//! 自带一个子模块：`lyrics_window`（桌面歌词独立窗口的命令）—— 它同样是 IPC 命令集合，
//! 按「依赖什么定归属」属于命令层，不再散在 crate 根。
pub mod lyrics_window;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::str::FromStr;
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

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn target(mgr: &ServiceManager) -> Result<(String, String), ApiErrorView> {
    match (mgr.base_url(), mgr.token()) {
        (Some(base), Some(token)) => Ok((base, token)),
        _ => Err(ApiErrorView::service_down()),
    }
}

async fn finish(res: reqwest::Response) -> Result<Value, ApiErrorView> {
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
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

/// 平台事实的唯一出处（`"windows"` / `"macos"` / `"linux"`）。
///
/// 为什么值得单开一条命令：前端**没有可信的平台判定源** —— UA 会撒谎，
/// `@tauri-apps/api` 又不带 os 模块（那是 plugin-os）。而"桌面歌词窗只在 Windows 提供"
/// 这类能力裁决必须有一个权威答案，否则 mac 上就会留着入口、点开却不符合预期。
/// 取编译期常量，与运行期实际情况不可能脱节。
#[tauri::command]
pub fn desktop_platform() -> &'static str {
    std::env::consts::OS
}

/// 手动启动本地翻译服务。
///
/// 两条调用路径：
///   ① 「设置 → 翻译服务 → 服务与配对 → 自动启动翻译服务」**关掉之后**的手动拉起；
///   ② 未就绪屏（X-C3）上的「启动本地服务」按钮。
///
/// **幂等**：已在启动中/运行中就直接返回当前状态，不重复拉起 —— 判定与置位压在
/// `ServiceManager::start_once` 的同一把锁内完成。这一点有实际约束：前端跑在
/// `React.StrictMode` 下，effect 在开发期**会故意跑两遍**，加上"进入翻译模块自动启动"
/// 与用户连点，同一瞬间进来两三次是常态。若各自都起一条启动线程，两套进程树会去抢
/// 同一批端口（① 5180–5190 / ② 8000+8001 / ③ 8080）。
#[tauri::command]
pub fn service_start(app: AppHandle, mgr: State<'_, ServiceManager>) -> StatusView {
    mgr.start_once(&app);
    mgr.status()
}

/// 手动停止本地翻译服务（回收整棵三进程树）。
///
/// 🔴 **必须是 `#[tauri::command(async)]`**：`ServiceManager::stop()` 是**阻塞**的
///（先礼后兵 `STOP_GRACE` + 有界收尸 `REAP_GRACE`，最坏约 5s）。同步命令跑在**主线程**，
/// 那几秒里窗口的消息泵一起冻住 —— 与 `quit_app` 同一条教训（见本文件 `quit_app` 注释、
/// 台账 D-87）。这里沿用「同步函数 + async 属性」的写法：函数体仍是普通阻塞代码，
/// 但整个调用被丢到异步运行时的线程池上执行，不占主线程。
///
/// ⚠️ 与 `start_blocking` 不同，`ServiceManager::stop()` **自己不发出状态事件**
///（原先唯一的调用者是 `service_restart`，它紧接着 `start()` 会 emit，所以看不出来）。
/// 手动停止是"停到 `stopped` 就结束"，没有后续 emit ⇒ 这里必须补一发，
/// 否则前端订阅的 `miao://service-state` 永远收不到，界面会一直停在「运行中」。
#[tauri::command(async)]
pub fn service_stop(app: AppHandle, mgr: State<'_, ServiceManager>) -> StatusView {
    mgr.stop();
    mgr.emit(&app);
    mgr.status()
}

/// 应用退出（托盘菜单 → 二次确认之后调用）
///
/// 🔴 **必须是 `async` 命令**（命令属性上的 `(async)` = 跑在 tauri 异步运行时的
/// 线程池上，**不是主线程**）。这不是风格问题，而是**功能开关**：
///
/// Tauri 的**同步**命令在主线程上执行，而 `AppHandle::exit` 在**主线程**里调用时
/// **不保证真的退出** —— 官方讨论 tauri#3555 的结论就是这句
/// 「you shouldn't call `AppHandle::exit` on the main thread」，提问者的现象与本机
/// 用户报的一模一样：**点了「退出喵坞」没反应**（窗口照旧、进程照旧）。
///
/// 顺带把第二个「点了像没反应」的成因也一并消掉：`ServiceManager::stop()` 是**阻塞**的
/// （先礼后兵，最多等 `STOP_GRACE`）。同步命令跑在主线程 ⇒ 这段时间窗口的消息泵一起
/// 被冻住 —— 即便最终退得掉，那几秒里界面也是死的，用户只会更用力地点两下。
///
/// ⚠️ 与 `main.rs` 的 `RunEvent::ExitRequested` 是**两道**清理，不是重复：这里走的是
/// 正常路径（先收干净再退，端口立刻释放）；那一道兜底 `Cmd+Q` / 其它退出路径。
/// 子进程表在 `stop()` 里已被 `take_all()` 掏空，所以第二遍是空操作。
#[tauri::command(async)]
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

/// 把主题同步给原生窗口（G-14 / G-18）。
///
/// 前端主题是「换 CSS 变量」实现的，只改 WebView 内容区；macOS 的原生标题栏
/// （含红绿灯按钮所在的那条 bar）不会跟着变，导致暗色时「顶部一条白、下面一片黑」。
///
/// 这里做**两件**事，缺一不可：
/// 1. `set_theme` —— 只把「模式」告诉系统，系统**自选**一个它认为合适的标题栏底色。
///    这解决不了「和 app 主题一致」：系统那份深色是 `#1E1E1E` 一类的中性灰，
///    与设计令牌里的 `#140F29` 天然对不上（G-18 的实测结论）。
/// 2. `set_background_color` —— 把窗口底色**钉死成设计令牌的 `board` 色**
///    （浅 `#FAFAFF` / 深 `#140F29`，与 `body` 背景同一个令牌）。
///    配合 `titleBarStyle: "Transparent"`（tao 的 `setTitlebarAppearsTransparent`），
///    标题栏底色即窗口底色，于是「顶部」与「主体」在像素上是同一个颜色。
///
/// 关键点：**原生标题栏、原生红绿灯、原生拖拽全部保留** —— 不动 `decorations`，
/// 不画任何自绘按钮，所以上一轮丢掉的那一堆系统行为一个都不会丢（G-15/G-16 已否决）。
#[tauri::command]
pub fn set_theme(app: AppHandle, mode: Option<String>) {
    let (theme, board) = match mode.as_deref() {
        Some("dark") => (Some(tauri::Theme::Dark), Some("#140F29")),
        Some("light") => (Some(tauri::Theme::Light), Some("#FAFAFF")),
        // 跟随系统：模式交回系统，颜色仍需给 —— 否则标题栏退回系统中性灰
        _ => (None, None),
    };
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_theme(theme);
        if let Some(hex) = board {
            if let Ok(c) = tauri::utils::config::Color::from_str(hex) {
                let _ = w.set_background_color(Some(c));
            }
        }
    }
}

// ------------------------------------------------------------------ 契约端点代理
//
// 🔴 这四个代理命令是**真正的 async fn**（`#[tauri::command]` + `async`），底层 HTTP 一律走
// **非阻塞** 的 `reqwest::Client`（`.await`）。两条都必须守：
//   ① 命令若是**同步**（不带 async），跑在**主线程**上 —— 一次 HTTP 就把窗口消息泵冻住，
//      漫画库一屏几十张缩略图（`api_bytes`）重拉时界面全死、点击「像没反应」。
//   ② 命令若是 async 但底层用 **`reqwest::blocking`**，会**直接 panic**：blocking 客户端自带
//      一个 Tokio 运行时，在 async 运行时里被 drop 会触发
//      "Cannot drop a runtime in a context where blocking is not allowed"
//      ⇒ 所有加载（队列 / 漫画库 / 漫画）齐崩。
// 所以：async fn + 非阻塞 Client，二者缺一不可。

#[tauri::command]
pub async fn api_get(mgr: State<'_, ServiceManager>, path: String) -> Result<Value, ApiErrorView> {
    let (base, token) = target(&mgr)?;
    let res = client()
        .get(format!("{base}{path}"))
        .header("X-Box-Token", token)
        .header("X-Box-Client", "box-desktop/0.1.0")
        .send()
        .await
        .map_err(|e| ApiErrorView::network(e.to_string()))?;
    finish(res).await
}

#[tauri::command]
pub async fn api_post(
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
    let res = req.send().await.map_err(|e| ApiErrorView::network(e.to_string()))?;
    finish(res).await
}

/// `multipart/form-data` 提交（契约 §5.2）：payload + images[]（≤20 张，由前端分批）
///
/// `field` 是**文件分片的字段名**，默认 `images[]`。之所以开这个口子：
/// 漫画库封面（`POST /library/{book}/cover`）走的是同一条 multipart 通道、但服务端
/// 按契约要求字段名必须是 `cover`（且**恰好 1 个**）—— 字段名写死的旧签名会把封面
/// 塞进 `images[]`，服务端于是回「缺少封面分片」，而前端只能看到一个与"选了图"
/// 毫无字面关联的 400。
#[tauri::command]
pub async fn api_post_multipart(
    mgr: State<'_, ServiceManager>,
    path: String,
    payload: Value,
    files: Vec<String>,
    field: Option<String>,
) -> Result<Value, ApiErrorView> {
    let (base, token) = target(&mgr)?;
    let mut form = reqwest::multipart::Form::new();
    let payload_text = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into());
    form = form.part(
        "payload",
        reqwest::multipart::Part::text(payload_text).mime_str("application/json").map_err(|e| ApiErrorView::network(e.to_string()))?,
    );
    let part_name = field.unwrap_or_else(|| "images[]".to_string());
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
            part_name.clone(),
            reqwest::multipart::Part::bytes(bytes)
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
        .await
        .map_err(|e| ApiErrorView::network(e.to_string()))?;
    finish(res).await
}

/// 取库内文件字节（漫画库网格 / 原译对照用）。走 IPC 二进制通道，前端转 blob URL
#[tauri::command]
pub async fn api_bytes(
    mgr: State<'_, ServiceManager>,
    path: String,
) -> Result<tauri::ipc::Response, ApiErrorView> {
    let (base, token) = target(&mgr)?;
    let res = client()
        .get(format!("{base}{path}"))
        .header("X-Box-Token", token)
        .send()
        .await
        .map_err(|e| ApiErrorView::network(e.to_string()))?;
    let status = res.status().as_u16();
    let bytes = res.bytes().await.map_err(|e| ApiErrorView::network(e.to_string()))?;
    if !(200..300).contains(&status) {
        return Err(parse_error(status, &String::from_utf8_lossy(&bytes)));
    }
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

/// `DELETE` 代理（带可选 JSON 体）。
///
/// 为什么需要它：契约里 `DELETE /library/{book}/cover`（移除封面）**只有这一个动词**
/// —— 没有等价的 `POST` 变体。没有本命令时，UI 上的「移除封面」按钮无路可走，
/// 只能退化成"改 manifest 而不删文件"，那会留下一个读不出来的 `cover.*`
/// （`readCoverName` 的 readdir 兜底会把它又认回来）。
///
/// 与 `api_get` 同样守两条硬纪律（见本段文件头）：**真 async fn** + **非阻塞 Client**。
#[tauri::command]
pub async fn api_delete(
    mgr: State<'_, ServiceManager>,
    path: String,
    body: Option<Value>,
) -> Result<Value, ApiErrorView> {
    let (base, token) = target(&mgr)?;
    let mut req = client()
        .delete(format!("{base}{path}"))
        .header("X-Box-Token", token)
        .header("X-Box-Client", "box-desktop/0.1.0");
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await.map_err(|e| ApiErrorView::network(e.to_string()))?;
    finish(res).await
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

/// 把一段文本写到**用户自己选定**的路径（设置页「全部日志」抽屉的「导出 .txt」）。
///
/// 为什么单开一条命令、而不是挂 `plugin-fs`：那个插件要额外加 Cargo 依赖 + 一整套
/// 路径范围的权限项，而这里只需要"写到用户刚在系统保存对话框里选中的那一个文件"。
/// 路径由**用户**在对话框里给出，本命令不拼接、不猜测、不创建目录 —— 能力边界
/// 正好是那一个文件。（`app` 自己的命令不受 Tauri 的 capability ACL 约束，
/// 与既有的 `api_post` / `open_path` 一致。）
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("导出路径为空".to_string());
    }
    std::fs::write(&path, contents).map_err(|e| format!("写入失败：{e}"))
}

/// 把投放的路径（文件或目录）展开为**图片文件绝对路径列表**，按文件名自然序排列
///
/// 「阅读顺序」在浏览器里是坐标排序（契约 §7.3），而本机投放的对象是磁盘上的文件，
/// 没有坐标可言 —— 因此按文件名自然序（`1,2,10` 而非 `1,10,2`）排序，这是本地投放的
/// 等效语义，已在 docs/internal/spec-notes.md G-05 记录。
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

/// 命令注册的**唯一展开点**：清单按域分段住在这里，`main.rs` 只做装配。
///
/// 🔴 两处不能顺手"改好"：① 不能再拆成「各域各出一个 `xxx_commands!()` 宏再汇总」——
/// `generate_handler!` 是 proc macro，它的入参**不做**宏展开（`syn::Path` 解析不了 `!`），拆开必然编不过；
/// ② 运行时**写死 `tauri::Wry`** 而不是 `handler<R: tauri::Runtime>()`——命令参数里的 `AppHandle` /
/// `State<'_, T>` 用的是默认运行时，泛型化后 `R` 不落地，`AppHandle: CommandArg<'_, R>` 当场不成立。
///
/// 路径一律写 `crate::` 全限定：`#[tauri::command]` 会把命令名宏 `use` 到**与命令同路径**的位置，
/// 宏展开出的 `crate::<域>::__tauri_command_name_<命令>!()` 依赖这个路径逐字对上。
pub fn handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        crate::commands::desktop_platform,
        crate::commands::service_status,
        crate::commands::service_start,
        crate::commands::service_stop,
        crate::commands::service_restart,
        crate::commands::quit_app,
        // ── 桌面歌词（独立窗口）──
        crate::commands::lyrics_window::open_lyrics_window,
        crate::commands::lyrics_window::close_lyrics_window,
        crate::commands::lyrics_window::lyrics_window_open,
        crate::commands::lyrics_window::save_lyrics_window_state,
        crate::commands::lyrics_window::lyrics_push,
        crate::commands::lyrics_window::get_lyrics_state,
        crate::commands::lyrics_window::lyrics_control,
        crate::commands::lyrics_window::resize_lyrics_window,
        crate::commands::hide_window,
        crate::commands::show_window,
        crate::commands::set_theme,
        crate::commands::api_get,
        crate::commands::api_post,
        crate::commands::api_post_multipart,
        crate::commands::api_bytes,
        crate::commands::api_delete,
        crate::commands::open_path,
        crate::commands::expand_paths,
        crate::commands::write_text_file,
        // ── 动漫模块（anime：独立 animesvc 进程的桥接）──
        crate::anime::anime_status,
        crate::anime::anime_start,
        crate::anime::anime_stop,
        crate::anime::anime_library,
        crate::anime::anime_entry,
        crate::anime::anime_save_subject,
        crate::anime::anime_set_collection,
        crate::anime::anime_save_episode,
        crate::anime::anime_play_source,
        crate::anime::anime_metadata_search,
        crate::anime::anime_metadata_apply,
        crate::anime::anime_set_library_root,
        crate::anime::anime_set_proxy,
        crate::anime::anime_sources,
        crate::anime::anime_save_source,
        crate::anime::anime_delete_source,
        crate::anime::anime_import_folder,
        crate::anime::anime_test_source,
        crate::anime::anime_play_remote,
        crate::anime::anime_kernel_status,
        crate::anime::anime_kernel_open,
        crate::anime::anime_kernel_ctl,
        crate::anime::anime_kernel_close,
        crate::anime::anime_seed_demo,
        crate::anime::anime_clear_demo,
        crate::anime::anime_paths,
        // ── 音乐模块（网易云）──
        crate::music::music_search,
        crate::music::music_song_url,
        crate::music::music_login_qr_key,
        crate::music::music_login_qr_create,
        crate::music::music_login_qr_check,
        crate::music::music_login_status,
        crate::music::music_login_cookie,
        crate::music::music_logout,
        crate::music::music_user_playlist,
        crate::music::music_playlist_tracks,
        crate::music::music_playlist_tracks_range,
        crate::music::music_playlist_info_with_track_ids,
        crate::music::music_playlist_detail,
        crate::music::music_likelist,
        crate::music::music_like,
        crate::music::music_playlist_subscribe,
        crate::music::music_lyric,
        crate::music::music_song_comments,
        crate::music::music_send_comment,
        crate::music::music_personalized,
        crate::music::music_recommend_songs,
        crate::music::music_recommend_resource,
        crate::music::music_simi_song,
        crate::music::music_intelligence_list,
        crate::music::music_artist_search,
        crate::music::music_playlist_search,
        crate::music::music_artist_songs,
        crate::music::music_artist_detail,
        crate::music::music_artist_albums,
        crate::music::music_artist_mvs,
        crate::music::music_album_detail,
        crate::music::music_mv_url,
        // ── 音乐模块（酷狗）──
        crate::music::kugou_search,
        crate::music::kugou_artist_search,
        crate::music::kugou_playlist_search,
        crate::music::kugou_artist_songs,
        crate::music::kugou_song_url,
        crate::music::kugou_lyric,
        crate::music::kugou_login_status,
        crate::music::kugou_login_cookie,
        crate::music::kugou_logout,
        crate::music::kugou_user_playlists,
        crate::music::kugou_playlist_tracks,
        crate::music::kugou_playlist_tracks_range,
        crate::music::kugou_guess_like,
        crate::music::kugou_rank_list,
        crate::music::kugou_rank_songs,
        crate::music::kugou_like_toggle,
        crate::music::kugou_liked_hashes,
        // ── 音乐模块（QQ）──
        crate::music::qq_search,
        crate::music::qq_song_url,
        crate::music::qq_lyric,
        crate::music::qq_login_status,
        crate::music::qq_login_cookie,
        crate::music::qq_logout,
        crate::music::qq_user_playlists,
        crate::music::qq_playlist_tracks,
        crate::music::qq_playlist_tracks_range,
        crate::music::qq_artist_search,
        crate::music::qq_artist_songs,
        crate::music::qq_playlist_search,
        crate::music::qq_rank_list,
        crate::music::qq_rank_songs,
        crate::music::music_qq_recommend_playlists,
        crate::music::qq_liked_hashes,
        crate::music::qq_like_toggle,
        // ── 音乐模块（咪咕）──
        crate::music::migu_search,
        crate::music::migu_playlist_search,
        crate::music::migu_artist_search,
        crate::music::migu_artist_songs,
        crate::music::migu_song_url,
        crate::music::migu_lyric,
        crate::music::migu_login_status,
        crate::music::migu_logout,
        crate::music::migu_user_playlists,
        crate::music::migu_playlist_tracks,
        crate::music::migu_playlist_tracks_range,
        crate::music::migu_rank_list,
        crate::music::migu_rank_songs,
        crate::music::migu_recommend_playlists,
        // ── 音乐模块（多平台管理）──
        crate::music::music_get_login_statuses,
        crate::music::music_switch_provider,
        crate::music::music_get_playback_source,
        crate::music::music_open_login_window,
        // ── 音乐模块（本地）──
        crate::music::local::get_music_files,
        crate::music::local::import_local_music,
        crate::music::local::import_local_music_folder,
        crate::music::local::get_local_lyric,
        crate::music::local::verify_local_covers,
        crate::music::local::delete_cover_cache_files,
        // ── 音乐模块（音频代理）──
        crate::music::audio_proxy::cmd_get_proxy_port,
        // ── 音乐模块（缓存：歌词/音频共用内核）──
        // 歌词缓存不暴露命令：它在四个聚合歌词命令内部生效，前端零改动。
        crate::music::audio_cache::music_audio_cached,
        crate::music::audio_cache::music_cache_download,
        crate::music::audio_cache::music_cache_stats,
        crate::music::audio_cache::music_cache_clear,
    ]
}
