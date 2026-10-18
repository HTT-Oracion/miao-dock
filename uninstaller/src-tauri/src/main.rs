//! 喵坞卸载器 · 宿主程序（WebView 小窗）
//!
//! 这一层是卸载页界面（`uninstaller/dist`）的"手"：界面只发意图，
//! **三类数据的实时探测 / 逐项删除 / 静默卸载 / 关窗**都在这里做。
//! 契约见 `uninstaller/src/host.ts` 的 `UninstallerHost`，字段名逐项对应。
//!
//! 🔴 **目录口径与产品侧同源**（`src-tauri/src/platform/paths.rs`）：
//!    漫画 = `MIAO_ROOT` 或 `~/Pictures/Box 漫画`；引擎 = `MIAO_RUNTIME_ROOT` 或
//!    `<appData>/runtimes/manga-translator`；音乐缓存 = `app_cache_dir()/music-cache`
//!    （Tauri 的 `app_cache_dir` 在 Windows 上是 `%LOCALAPPDATA%\<identifier>\cache`，
//!    identifier 取主应用 tauri.conf.json 的 `com.miaodock.desktop`）。
//!
//! 🔴 **删除前必须过安全闸**：路径要在允许的根之下、至少三层、不是盘根 —— 这是删用户数据，
//!    宁可拒绝也不猜。junction / 符号链接只摘链接本身，不进去删。
//!
//! ⚠️ **本程序应当装在安装目录之外**（例如 `%LOCALAPPDATA%\喵坞卸载器\`）：它要驱动
//!    `uninstall.exe /S` 把安装目录整个删掉，自己要是躺在里面，NSIS 会因为文件占用跳过它，
//!    卸载完留下一个孤儿 exe。这一条属于打包落点问题，未在 `hooks.nsh` 里动。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// 一类本地数据的实时画像 —— 字段名与 `uninstaller/src/host.ts` 的 `DataProfile` 对应
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DataProfile {
    path: String,
    size_bytes: u64,
    exists: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DataProfiles {
    music: DataProfile,
    manga: DataProfile,
    engine: DataProfile,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UninstallProbe {
    data: DataProfiles,
    /// 程序本体实测体积（"已移除程序文件（312 MB）"那一行）
    program_size_bytes: u64,
}

#[tauri::command]
fn probe() -> UninstallProbe {
    UninstallProbe {
        program_size_bytes: dir_size(&app_install_dir()),
        data: DataProfiles {
            music: profile(music_cache_dir()),
            manga: profile(root_dir()),
            engine: profile(engine_dir()),
        },
    }
}

/// 执行卸载。步骤顺序与界面给的计划一致：
/// ① 桌面快捷方式 → ② 卸载程序（程序文件 + 注册表）→ ③ 逐项删数据 → ④ 开始菜单入口。
/// 每完成一步往 `onProgress` 发一次**已完成步数**（从 1 起）。
#[tauri::command]
async fn run_uninstall(
    targets: Vec<String>,
    on_progress: tauri::ipc::Channel<u32>,
) -> Result<i32, String> {
    let mut done: u32 = 0;
    let step = |n: &mut u32, channel: &tauri::ipc::Channel<u32>| {
        *n += 1;
        let _ = channel.send(*n);
    };

    // ① 桌面快捷方式：本程序自己先删，这一步才"看得见"（卸载程序也会清一遍）
    for lnk in desktop_shortcuts() {
        if lnk.is_file() {
            let _ = fs::remove_file(&lnk);
        }
    }
    step(&mut done, &on_progress);

    // ② 卸载程序：静默移除程序文件与注册表项。
    //    注意它住在**应用安装目录**里，不在卸载器自己的目录里（后者在安装目录之外）。
    let install_dir = app_install_dir();
    let uninstaller = install_dir.join("uninstall.exe");
    if !uninstaller.is_file() {
        return Err(format!("找不到卸载程序：{}", uninstaller.display()));
    }
    let code = Command::new(&uninstaller)
        .arg("/S")
        .status()
        .map_err(|e| format!("起不来卸载程序：{e}"))?
        .code()
        .unwrap_or(-1);
    if code != 0 {
        return Ok(code);
    }
    // NSIS 的卸载器会把自己复制到 TEMP 再继续跑，原进程先退出 ⇒ 这里要等**主程序**真的消失
    wait_until_gone(&install_dir.join("miao-dock.exe"), Duration::from_secs(120));
    step(&mut done, &on_progress);

    // ③ 逐项删除勾选的数据目录（只删 targets 里有的，其余一律不碰）
    for kind in &targets {
        let dir = data_dir(kind).ok_or_else(|| format!("未知的数据项：{kind}"))?;
        guard(&dir)?;
        if dir.is_dir() {
            remove_dir_safely(&dir)?;
        }
        step(&mut done, &on_progress);
    }

    // ④ 开始菜单入口（注册表已随卸载程序移除，这里只清快捷方式目录）
    let start_menu = start_menu_dir();
    if start_menu.is_dir() {
        guard(&start_menu)?;
        remove_dir_safely(&start_menu)?;
    }
    step(&mut done, &on_progress);

    Ok(0)
}

#[tauri::command]
fn close_window(window: tauri::Window) {
    let _ = window.close();
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![probe, run_uninstall, close_window])
        .run(tauri::generate_context!())
        .expect("卸载器窗口起不来");
}

// ------------------------------------------------------------------ 路径口径

fn local_app_data() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn user_profile() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn app_data_roaming() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| user_profile().join("AppData").join("Roaming"))
}

/// 卸载器自己的家：`%LOCALAPPDATA%\喵坞卸载器\`（**安装目录之外**，由安装器部署到这里）
fn host_dir() -> PathBuf {
    local_app_data().join("喵坞卸载器")
}

/// 安装器写下的"应用装在哪" —— 两程序之间唯一的落点契约
fn location_file() -> PathBuf {
    host_dir().join("install-location.txt")
}

/// 应用安装目录：优先用安装器写下的记录，读不到才退回默认落点。
///
/// 为什么不能只看默认落点：用户可以把喵坞装到别的盘，那样默认值会指向一个空目录，
/// 卸载器就会"找不到卸载程序"。记录只写一个路径，读不出就退默认 —— 不猜、不扫盘。
fn app_install_dir() -> PathBuf {
    let recorded = fs::read_to_string(location_file()).ok();
    install_dir_from(recorded.as_deref())
}

/// 把记录内容变成安装目录（纯函数，便于单测；空 / 空白一律视为没记录）
fn install_dir_from(recorded: Option<&str>) -> PathBuf {
    match recorded.map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => PathBuf::from(text),
        None => local_app_data().join("Programs").join("喵坞"),
    }
}

/// 音乐缓存：`%LOCALAPPDATA%\com.miaodock.desktop\cache\music-cache`
/// （`com.miaodock.desktop` 是主应用的 bundle identifier，与 `paths::app_cache_dir()` 同源）
fn music_cache_dir() -> PathBuf {
    local_app_data()
        .join("com.miaodock.desktop")
        .join("cache")
        .join("music-cache")
}

/// 漫画作品目录：`MIAO_ROOT` 覆盖，默认 `~/Pictures/Box 漫画`
fn root_dir() -> PathBuf {
    env_path("MIAO_ROOT").unwrap_or_else(|| user_profile().join("Pictures").join("Box 漫画"))
}

/// 引擎运行时：`<runtimeRoot>/manga-translator`，runtimeRoot 可被 `MIAO_RUNTIME_ROOT` 覆盖
fn engine_dir() -> PathBuf {
    let root = env_path("MIAO_RUNTIME_ROOT").unwrap_or_else(|| local_app_data().join("runtimes"));
    root.join("manga-translator")
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

fn data_dir(kind: &str) -> Option<PathBuf> {
    match kind {
        "music" => Some(music_cache_dir()),
        "manga" => Some(root_dir()),
        "engine" => Some(engine_dir()),
        _ => None,
    }
}

fn desktop_shortcuts() -> Vec<PathBuf> {
    vec![
        user_profile().join("Desktop").join("喵坞.lnk"),
        PathBuf::from("C:\\Users\\Public\\Desktop").join("喵坞.lnk"),
    ]
}

fn start_menu_dir() -> PathBuf {
    app_data_roaming()
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("喵坞")
}

// ------------------------------------------------------------------ 探测与删除

fn profile(dir: PathBuf) -> DataProfile {
    let exists = dir.is_dir();
    DataProfile {
        size_bytes: if exists { dir_size(&dir) } else { 0 },
        path: dir.to_string_lossy().into_owned(),
        exists,
    }
}

/// 目录总字节数。**不跟随符号链接**：链接可能成环，而且它的体积不该算两遍。
fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            total += dir_size(&entry.path());
        } else if file_type.is_file() {
            total += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    total
}

/// 删除前的安全闸：只允许删**确实属于这几类数据**的目录。
/// 盘根、用户主目录、不在白名单根之下的路径一律拒绝 —— 这是删用户数据，宁可拒绝也不猜。
fn guard(p: &Path) -> Result<(), String> {
    if !p.is_absolute() || p.components().count() < 3 {
        return Err(format!("拒绝删除（路径过浅）：{}", p.display()));
    }
    let allowed = allowed_roots();
    if !allowed.iter().any(|root| p.starts_with(root)) {
        return Err(format!("拒绝删除（不在允许范围内）：{}", p.display()));
    }
    Ok(())
}

fn allowed_roots() -> Vec<PathBuf> {
    let mut roots = vec![
        local_app_data(),
        user_profile().join("Pictures"),
        app_data_roaming(),
    ];
    // 环境变量覆盖出来的落点（测试 / 迁移场景）也放行其父目录
    for name in ["MIAO_ROOT", "MIAO_RUNTIME_ROOT"] {
        if let Some(p) = env_path(name) {
            if let Some(parent) = p.parent() {
                roots.push(parent.to_path_buf());
            }
        }
    }
    roots
}

/// 删目录：junction / 符号链接只摘链接本身（进去删会把链接目标的内容一起干掉）。
fn remove_dir_safely(p: &Path) -> Result<(), String> {
    let is_link = fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    let target = verbatim(p);
    let result = if is_link {
        fs::remove_dir(&target)
    } else {
        fs::remove_dir_all(&target)
    };
    result.map_err(|e| format!("删除失败（{}）：{e}", p.display()))
}

/// Windows 长路径：模型 / venv 的目录很容易越过 260 —— 加 `\\?\` 前缀，且分隔符必须是反斜杠。
#[cfg(windows)]
fn verbatim(p: &Path) -> PathBuf {
    let text = p.to_string_lossy().replace('/', "\\");
    if text.starts_with("\\\\?\\") {
        PathBuf::from(text)
    } else {
        PathBuf::from(format!("\\\\?\\{text}"))
    }
}

#[cfg(not(windows))]
fn verbatim(p: &Path) -> PathBuf {
    p.to_path_buf()
}

/// 轮询等待某个文件消失（NSIS 卸载器先退出、副本继续跑，只能看主程序文件何时真的没了）。
fn wait_until_gone(path: &Path, timeout: Duration) {
    let started = Instant::now();
    while path.exists() && started.elapsed() < timeout {
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 删用户数据前的安全闸：盘根、过浅、白名单之外一律拒绝。
    /// 反向（白名单内的默认落点必须放行）也一起断言 —— 只测拒绝会让"永远拒绝"也算通过。
    #[test]
    fn guard_rejects_dangerous_targets_and_allows_known_ones() {
        assert!(guard(Path::new("C:\\")).is_err(), "盘根必须拒绝");
        assert!(guard(Path::new("C:\\Windows")).is_err(), "白名单之外必须拒绝");
        assert!(guard(Path::new("relative\\dir\\x")).is_err(), "相对路径必须拒绝");

        assert!(guard(&music_cache_dir()).is_ok(), "默认音乐缓存应在 LOCALAPPDATA 之下");
        assert!(guard(&root_dir()).is_ok(), "默认漫画目录应在 ~/Pictures 之下");
        assert!(guard(&engine_dir()).is_ok(), "默认引擎目录应在 LOCALAPPDATA 之下");
    }

    /// 引擎目录 == `<runtimeRoot>/manga-translator`（与 `paths::runtimes_dir()` 同形）
    #[test]
    fn engine_dir_is_the_runtime_child() {
        let name = engine_dir().file_name().and_then(|n| n.to_str()).map(str::to_string);
        assert_eq!(name.as_deref(), Some("manga-translator"));
    }

    /// 只认三类：多一个 kind 也不许被当成"可删目录"
    #[test]
    fn data_dir_maps_only_known_kinds() {
        assert!(data_dir("music").is_some());
        assert!(data_dir("manga").is_some());
        assert!(data_dir("engine").is_some());
        assert!(data_dir("state").is_none());
    }

    /// 安装位置记录：有记录就听记录（用户可能装在别的盘），空 / 空白退回默认落点
    #[test]
    fn install_dir_prefers_recorded_location() {
        assert_eq!(
            install_dir_from(Some("D:\\Apps\\喵坞")),
            PathBuf::from("D:\\Apps\\喵坞")
        );
        let fallback = local_app_data().join("Programs").join("喵坞");
        assert_eq!(install_dir_from(Some("   ")), fallback);
        assert_eq!(install_dir_from(None), fallback);
    }

    #[cfg(windows)]
    #[test]
    fn verbatim_prefixes_once_and_normalizes_separators() {
        let v = verbatim(Path::new("C:/a/b"));
        assert_eq!(v.to_string_lossy(), "\\\\?\\C:\\a\\b");
        assert_eq!(verbatim(&v).to_string_lossy(), "\\\\?\\C:\\a\\b", "已带前缀的不许重复加");
    }
}
