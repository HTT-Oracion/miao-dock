//! 桌面歌词窗口（拍板第 1 项：独立窗口）。
//!
//! ## 为什么是独立窗口
//! 桌面歌词的定义就是"浮在所有应用之上、跟随播放" —— 它必须能在用户切到别的应用时继续显示，
//! 这在同一个 WebView 里做不到（切走就被盖住 / 失去焦点）。参考实现也是独立窗口。
//!
//! ## 四个容易踩的点（都已处理，勿改回去）
//!
//! ① **必须用 `WebviewUrl::App`（同 origin），不能用 `External`** ——
//!    localStorage 按 origin 隔离。用 `External` 的话歌词窗读不到主窗写的偏好，
//!    而且和现有的官方登录窗口（用 External）是完全不同的场景，**不可照抄**。
//!    本地已实测同 origin 两窗共享 localStorage（台账 D-47）。
//!
//! ② **label 必须固定**（`desktop-lyrics`），不能用动态 label ——
//!    `capabilities/default.json` 的 `windows` 是**白名单**，只有写进去的 label
//!    才能调 Tauri 命令。动态 label 每次都调不到权限，而且报错是"权限不足"、
//!    **不是"窗口不存在"**，极易误判成代码写错。
//!
//! ③ **窗口坐标：物理像素与逻辑像素必须显式换算**（本文件最坑的一处，真踩过）——
//!    `Monitor::size()` 报**物理像素**（Retina 2×），`position()` 收**逻辑像素**。
//!    混用不报错，只是窗口被放到可视区外：症状是"点了没反应"而**日志干净**。
//!    统一走 `monitor_logical_size()` 换算，不要在别处再算一次。
//!
//! ④ **点击穿透在 macOS 上可用**（此前注释写"macOS 做不到"是**错的**，已更正）——
//!    Tauri 的 `set_ignore_cursor_events` 在各平台都有实现
//!    （macOS 走 `NSWindow.ignoresMouseEvents`）。参考实现锁定后即用该 API 做穿透。
//!    ⚠️ 但"能用"与"体验好"是两件事：锁定后的**解锁入口**若依赖穿透区判定，
//!    需要平台级鼠标钩子（参考实现用 Rust 钩子 + `get_cursor_position`），成本高；
//!    本项目当前降级为「双击歌词条解锁」，**待真机确认后再决定是否上穿透**。
//!    在文档与 UI 文案里**不承诺未实测的能力**。

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// 桌面歌词窗口的固定 label（见本文件 ②）
pub const LYRICS_WINDOW: &str = "desktop-lyrics";

/// 最后一次推给歌词窗的载荷（**只存不发**，供窗口挂载后补拉）。
///
/// ## 为什么必须有这份缓存（这是"刚打开没歌词"的真正原因）
///
/// 建窗与推送是**两步且异步**的：主窗调用 `open_lyrics_window` 之后**立刻**推送状态，
/// 而此刻歌词窗的 WebView 还在加载 HTML —— React 尚未挂载、`listen` 尚未注册，
/// **这条事件必然丢失**（Tauri 的事件不缓存、不回放）。
///
/// 症状极具误导性：**刚打开时歌词区空着，暂停再播放（触发第二次推送）就正常了** ——
/// 看起来像"歌词加载有问题"，实际是第一条推送发早了一步。
///
/// 有了缓存，歌词窗挂载后主动 `get_lyrics_state` 拉一次即可，
/// **不依赖两个 WebView 的加载时序**（靠睡眠/重试去赌时序是治不好的）。
static LAST_LYRICS: Mutex<Option<serde_json::Value>> = Mutex::new(None);

/// 窗口尺寸（**逻辑像素**，与 `position()` 同一单位体系）。
/// 做成常量是为了让"写死的尺寸"只有一个来源 —— 摆位计算要用它们，
/// 分成两处写迟早会出现"挪了窗口尺寸忘了改贴底偏移"。
const WIN_W: f64 = 520.0;
const WIN_H: f64 = 160.0;
/// 贴底时留出的下边距，避免歌词紧贴屏幕底边（视觉上像被裁掉）
const BOTTOM_MARGIN: f64 = 80.0;

/// 位置/锁定等窗口状态。存在 Rust 侧而非 localStorage 的理由：
/// 窗口位置必须**跨进程重启**保留，而 localStorage 是同 origin 的 WebView 存储 ——
/// 虽然实测共享（D-47），但它属于"用户数据"目录、清理缓存会丢；
/// 窗口位置属于"应用设置"，用配置文件更稳（也更符合用户对"设置"的预期）。
///
/// `Deserialize` 不是可选的：它作为 `save_lyrics_window_state` 的命令参数，
/// Tauri 要求入参类型实现 `CommandArg`（内部需要反序列化）。只写 `Serialize` 编译不过。
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct LyricsWindowState {
    /// 窗口左上角的**屏幕 x 坐标**（逻辑像素）。`-1.0` = 未记录（首次打开走底部居中）。
    pub x: f64,
    /// 窗口左上角的**屏幕 y 坐标**（逻辑像素）。`-1.0` = 未记录（首次打开走贴底）。
    ///
    /// ⚠️ 口径必须是「坐标」而不是「距底距离」—— 两者差一个屏幕高度，
    /// 换算只在某一处做的话必然有对不上的时候（实现时真的踩了这个坑）。
    ///
    /// ⚠️⚠️ 单位必须是**逻辑像素**：`Monitor::size()` 报的是**物理像素**（Retina 上 2×），
    /// 而 `position()` 收的是逻辑像素。混用会让窗口落到屏幕外 ——
    /// 症状是"点了没反应"、**且没有任何报错**（窗口其实建出来了，只是在可视区外）。
    /// 真踩过：`1964 − 160 − 80 = 1724` 交给逻辑坐标，而屏幕逻辑高只有 982。
    pub y: f64,
    /// 用户是否锁定（不可拖动）。
    pub locked: bool,
}

impl Default for LyricsWindowState {
    fn default() -> Self {
        Self { x: -1.0, y: -1.0, locked: false }
    }
}

fn state_path(app: &AppHandle) -> std::path::PathBuf {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    dir.join("lyrics-window.json")
}

fn load_state(app: &AppHandle) -> LyricsWindowState {
    std::fs::read_to_string(state_path(app))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_state(app: &AppHandle, st: &LyricsWindowState) {
    if let Some(dir) = app.path().app_config_dir().ok() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(json) = serde_json::to_string_pretty(st) {
            let _ = std::fs::write(dir.join("lyrics-window.json"), json);
        }
    }
}

/// 打开（或聚焦）桌面歌词窗口。幂等：已存在就 focus，不重复建。
///
/// ## 🔴 必须是 `async` 命令
///
/// 同步 `#[tauri::command]` 跑在 **IPC 处理线程**上，而 `WebviewWindowBuilder::build()`
/// 需要**主线程的事件循环**来真正创建窗口 —— 两者互等，结果是**死锁**：
/// 窗口建不出来，IPC 也不返回（前端 `await` 永远挂着，表现为"点了没反应"，且日志干净）。
///
/// 实测症状：点「桌面歌词」后 CDP 的窗口列表里始终只有主窗，
/// 直接 `invoke('open_lyrics_window')` 的探针脚本挂到超时都不返回。
///
/// 改成 `async` 后命令跑在异步运行时里，`build()` 能正常等到主线程。
/// 同族的先例：`quit_app` 也是因为"同步命令里做需要事件循环的事"被钉成 `async`
/// （见 `check:quit` 的钉子）。
#[tauri::command]
pub async fn open_lyrics_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LYRICS_WINDOW) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }

    let st = load_state(&app);

    // ── 首次摆位：贴屏幕底部 + 水平居中 ────────────────────────────────────
    //
    // ⚠️⚠️ 这段唯一的坑是**单位**，而且错了不报错（实测踩过，症状是"点了没反应"）：
    //   · `Monitor::size()`     → **物理像素**（Retina 上 2×，如 1964）
    //   · `Monitor::scale_factor()` → 物理/逻辑 的倍率（如 2.0）
    //   · `WebviewWindowBuilder::position()` → **逻辑像素**
    // 直接拿物理像素当逻辑像素用，会算出 `1964−160−80=1724`，而屏幕逻辑高只有 982
    // → 窗口被放到可视区之外，用户看不到任何东西，也没有任何报错。
    //
    // 为什么不干脆「不设 position」（参考实现的做法）：那样窗口会开在系统默认位置，
    // 而桌面歌词的预期位置是**底部居中**。这里自己算，但换算做对。
    let (screen_w, screen_h) = monitor_logical_size(&app);

    let win_w = WIN_W;
    let win_h = WIN_H;
    // `>= 0.0` 判"是否已记录"：-1.0 是"未记录"的哨兵值（见 LyricsWindowState 注释）
    let x = if st.x >= 0.0 { st.x } else { ((screen_w - win_w) / 2.0).max(0.0) };
    let y = if st.y >= 0.0 { st.y } else { (screen_h - win_h - BOTTOM_MARGIN).max(0.0) };

    // 窗口本体只做一条极简歌词：无边框、始终置顶、跳过任务栏。
    // 尺寸刻意小 —— 桌面歌词是"一条浮在桌面上的文字"，做成半屏会变成第二个播放器。
    WebviewWindowBuilder::new(&app, LYRICS_WINDOW, WebviewUrl::App("templates/lyrics.html".into()))
        .title("桌面歌词")
        .inner_size(win_w, win_h)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .position(x, y)
        .build()
        .map_err(|e| format!("创建桌面歌词窗口失败：{e}"))?;

    Ok(())
}

/// 主显示器的**逻辑**尺寸（宽, 高）。
///
/// 单独成函数是为了让「物理 → 逻辑」这一步在**全项目只有一处**：
/// 两个窗口都用它，就不会出现"一个算了、一个忘了"的不一致。
fn monitor_logical_size(app: &AppHandle) -> (f64, f64) {
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let scale = m.scale_factor();
            let size = m.size();
            // 兜底 scale=1.0：极小概率下拿不到缩放比时，宁可位置略有偏差也不要除零
            let s = if scale > 0.0 { scale } else { 1.0 };
            (f64::from(size.width) / s, f64::from(size.height) / s)
        })
        .unwrap_or((1440.0, 900.0))
}

/// 桌面歌词窗口随「行数 × 字号」**自适应高度**（用户在设置里调行数/字号后调用）。
///
/// ## 为什么放在 Rust 而不是前端
/// 窗口几何（尺寸、坐标、贴底、换算）**全部集中在本文件**。前端直接 `setSize` 等于
/// 把同一套几何写到第二处 —— 下次改窗口尺寸时必然漏一处。所以前端只报"几行、多大字"，
/// 几何仍由这里算。
///
/// ## 两个必须一起处理的点
/// ① **底边不能动**：窗口变高时若不调整 y，它会往屏幕**下方**长出去 ——
///    那正是 D-53 缺陷 ① 的同类后果（窗口在可视区外，用户看到的是"设置不生效"）。
///    所以高度增加多少，y 就上移多少。
/// ② **必须限高**：无上限的话，5 行 + 最大字号会变成一块大面板，
///    与"桌面歌词是一条浮在桌面上的文字"（520×160 的定位）相悖。
#[tauri::command]
pub fn resize_lyrics_window(app: AppHandle, lines: u32, font_size: f64) -> Result<(), String> {
    let Some(w) = app.get_webview_window(LYRICS_WINDOW) else {
        return Ok(());
    };
    let scale = w.scale_factor().unwrap_or(1.0);
    let scale = if scale > 0.0 { scale } else { 1.0 };

    // 记旧几何（逻辑像素）—— 用于"保持底边不动"
    let old_h = w.outer_size().map(|s| f64::from(s.height) / scale).unwrap_or(WIN_H);
    let old_pos = w
        .outer_position()
        .ok()
        .map(|p| (f64::from(p.x) / scale, f64::from(p.y) / scale));

    let h = window_height_for_lines(lines, font_size);

    w.set_size(tauri::LogicalSize::new(WIN_W, h))
        .map_err(|e| format!("调整桌面歌词窗口尺寸失败：{e}"))?;

    if let Some((x, y)) = old_pos {
        // 变高则 y 减小（上移），保持底边位置不变；夹到 0 避免把窗口顶出屏幕上边
        let new_y = (y - (h - old_h)).max(0.0);
        let _ = w.set_position(tauri::LogicalPosition::new(x, new_y));
    }

    Ok(())
}

/// 高度公式：以「2 行 = 基准高（`WIN_H`）」为锚，按 `(行数 - 2) × 单行高` 线性扩展。
///
/// 单行高**跟随字号**：字号调大时每一行本身也变高，不跟就会行间重叠。
/// `1.35` 与 `DesktopLyrics.tsx` 里 `.dl-line` 的行高保持一致 —— 两处不一致会累积成可见的重叠/空隙。
fn window_height_for_lines(lines: u32, font_size: f64) -> f64 {
    const LINE_RATIO: f64 = 1.35;
    // 上限：再高就变成"第二个播放器"了，与桌面歌词的定位相悖
    const MAX_H: f64 = 1000.0;
    const MIN_FONT: f64 = 12.0;

    let extra = lines.saturating_sub(2) as f64;
    let line_h = font_size.max(MIN_FONT) * LINE_RATIO;
    (WIN_H + extra * line_h).min(MAX_H)
}

/// 关闭桌面歌词窗口（不存在时静默成功 —— 幂等）。
#[tauri::command]
pub fn close_lyrics_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LYRICS_WINDOW) {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 桌面歌词窗当前是否存在（前端用它来决定"关掉设置开关时要不要 emit 停止事件"）。
#[tauri::command]
pub fn lyrics_window_open(app: AppHandle) -> bool {
    app.get_webview_window(LYRICS_WINDOW).is_some()
}

/// 保存位置/锁定状态。只允许**桌面歌词窗自己**调用（它才知道自己被拖到哪了）。
#[tauri::command]
pub fn save_lyrics_window_state(app: AppHandle, state: LyricsWindowState) -> Result<(), String> {
    save_state(&app, &state);
    Ok(())
}

/// 主窗口 → 歌词窗：推送"现在该显示什么"（换歌 / 歌词就绪 / 播放态变化时发）。
///
/// ⚠️ **进度不走这里**：`timeupdate` 每秒数次，事件扛不住这种频率
/// （每条都要跨进程序列化 + 反序列化）。歌词窗自己按收到的 `startedAtMs` +
/// 本地计时推进进度 —— 前提是歌词窗能自己走表（它能：WebView 的定时器不受主窗影响）。
#[tauri::command]
pub fn lyrics_push(app: AppHandle, payload: serde_json::Value) -> Result<(), String> {
    // ⚠️ **先写缓存、再 emit**，顺序不能反（见 `LAST_LYRICS` 的注释）：
    // 歌词窗挂载后补拉的就是这里存下的这份。反过来的话，窗口在"emit 完、还没写缓存"
    // 之间挂载 → 事件错过了、缓存又是空的 → 表现为"刚打开没歌词"原地复现。
    if let Ok(mut g) = LAST_LYRICS.lock() {
        *g = Some(payload.clone());
    }

    let Some(w) = app.get_webview_window(LYRICS_WINDOW) else {
        return Ok(());
    };
    w.emit("lyrics://state", payload)
        .map_err(|e| format!("推送歌词状态失败：{e}"))
}

/// 歌词窗挂载后**主动补拉**最后一次状态（解决"刚打开没歌词"，见 `LAST_LYRICS`）。
///
/// 返回 `null` 表示主窗还没推过任何东西（例如"先开窗口、后播歌"）——
/// 歌词窗据此保持待播放态，等 `lyrics://state` 事件即可，不需要重试。
#[tauri::command]
pub fn get_lyrics_state() -> Option<serde_json::Value> {
    LAST_LYRICS.lock().ok().and_then(|g| g.clone())
}

/// 歌词窗 → 主窗：控制播放（播放/暂停、上一首、下一首、播放模式、音量、锁定）。
///
/// ## 为什么必须经 Rust 转发
/// 两个窗口是**独立的 WebView**，各自的 JS 堆互不可见 —— 歌词窗里的 zustand store
/// 是另一个实例（只有 localStorage 共享，那是磁盘态不是内存态）。所以"在歌词窗点下一首"
/// 没法直接改主窗的 store，必须走 Rust 的 `emit` 让主窗收到后执行。
///
/// 载荷原样转发（Rust 不解析），与 `lyrics_push` 的方向相反、形状对称 ——
/// 两端各加一个字段都不需要改这里。
#[tauri::command]
pub fn lyrics_control(app: AppHandle, payload: serde_json::Value) -> Result<(), String> {
    app.emit("lyrics://control", payload)
        .map_err(|e| format!("转发歌词窗控制指令失败：{e}"))
}
