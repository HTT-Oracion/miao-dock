//! 桌面歌词窗口（拍板第 1 项：独立窗口）。
//!
//! ## 为什么是独立窗口
//! 桌面歌词的定义就是"浮在所有应用之上、跟随播放" —— 它必须能在用户切到别的应用时继续显示，
//! 这在同一个 WebView 里做不到（切走就被盖住 / 失去焦点）。参考实现也是独立窗口。
//!
//! ## 三个容易踩的点（都已处理，勿改回去）
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
//! ③ **置顶窗口在 macOS 上要单独处理** —— `always_on_top` 在 Tauri 里跨平台可用，
//!    但点击穿透（锁定）是平台能力：macOS 只能"浮在上面"，不能真正点击穿透。
//!    因此 `locked` 状态只做**视觉**（去掉可交互手势 + 半透明提示），
//!    不承诺"鼠标穿透" —— 承诺做不到的事等于埋一个更坏的坑。

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// 桌面歌词窗口的固定 label（见本文件 ②）
pub const LYRICS_WINDOW: &str = "desktop-lyrics";

/// 位置/锁定等窗口状态。存在 Rust 侧而非 localStorage 的理由：
/// 窗口位置必须**跨进程重启**保留，而 localStorage 是同 origin 的 WebView 存储 ——
/// 虽然实测共享（D-47），但它属于"用户数据"目录、清理缓存会丢；
/// 窗口位置属于"应用设置"，用配置文件更稳（也更符合用户对"设置"的预期）。
///
/// `Deserialize` 不是可选的：它作为 `save_lyrics_window_state` 的命令参数，
/// Tauri 要求入参类型实现 `CommandArg`（内部需要反序列化）。只写 `Serialize` 编译不过。
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct LyricsWindowState {
    /// 窗口顶边的**屏幕 y 坐标**（逻辑像素）。
    ///
    /// ⚠️ 口径必须是「y 坐标」而不是「距底距离」—— 两者差一个屏幕高度，换算只在
    /// 某一处做的话必然有对不上的可能（实现时真的踩了这个坑）。
    /// `-1.0` = 未记录（首次打开走"贴屏幕底部"的默认摆位）。
    pub y: f64,
    /// 用户是否锁定（不可拖动）。
    pub locked: bool,
}

impl Default for LyricsWindowState {
    fn default() -> Self {
        Self { y: -1.0, locked: false }
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
#[tauri::command]
pub fn open_lyrics_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LYRICS_WINDOW) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }

    let st = load_state(&app);

    // 摆位：已拖过就用记录的 y；首次打开贴当前屏幕底部。
    // 「贴底」要拿屏幕高度算一次（窗口高 160，减去一点边距）——
    // 写死 0 会让窗口开在屏幕顶端，用户会以为功能坏了（预期它在底部飘着）。
    let y = if st.y >= 0.0 {
        st.y
    } else {
        let h = app
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| f64::from(m.size().height as i32) as f64)
            .unwrap_or(1080.0);
        (h - 160.0 - 80.0).max(0.0)
    };

    // 窗口本体只做一条极简歌词：宽 520、高 160、无边框、始终置顶、跳过任务栏。
    // 尺寸刻意小 —— 桌面歌词是"一条浮在桌面上的文字"，做成半屏会变成第二个播放器。
    WebviewWindowBuilder::new(&app, LYRICS_WINDOW, WebviewUrl::App("lyrics.html".into()))
        .title("桌面歌词")
        .inner_size(520.0, 160.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .position(y, 0.0)
        .build()
        .map_err(|e| format!("创建桌面歌词窗口失败：{e}"))?;

    Ok(())
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
    let Some(w) = app.get_webview_window(LYRICS_WINDOW) else {
        return Ok(());
    };
    w.emit("lyrics://state", payload)
        .map_err(|e| format!("推送歌词状态失败：{e}"))
}
