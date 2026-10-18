//! 喵坞卸载器 · 宿主程序（WebView 小窗）
//!
//! 这一层是卸载页界面（`uninstaller/dist`）的"手"：界面只发意图，
//! **三类数据的实时探测 / 逐项删除 / 清入口与注册表 / 自删**都在这里做。
//! 契约见 `uninstaller/src/host.ts` 的 `UninstallerHost`，字段名逐项对应。
//!
//! 🔴 **本程序住在安装目录里**：`current_exe()` 的父目录就是安装目录 ——
//!    不再需要「安装器写下装在哪」的外部记录文件（那条契约已随单文件安装退役）。
//! 🔴 **目录口径与产品侧同源**：漫画 = `MIAO_MANGA_ROOT_DIR` 或 `~/Pictures/MiaoDock Mangas`；
//!    引擎 = `MIAO_MANGA_RUNTIME_ROOT` 或 `<appData>/MiaoDock/manga/runtimes/manga-translator`；
//!    音乐缓存 = `%LOCALAPPDATA%\com.miaodock.desktop\cache\music-cache`。
//! 🔴 **删除前必须过安全闸**：路径要在允许的根之下、至少三层、不是盘根 —— 这是删用户数据，
//!    宁可拒绝也不猜。junction / 符号链接只摘链接本身，不进去删。
//! 🔴 **静默档（`--silent`）不碰用户数据**：与旧 NSIS `/S` 的语义对齐。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod registry;
mod selfdelete;
mod shortcuts;

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// 卸载动作是否已经跑完 —— 关窗时据此决定要不要再排一次自删
static UNINSTALLED: AtomicBool = AtomicBool::new(false);

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
    /// 程序本体实测体积（"已移除程序文件与注册表项（312 MB）"那一行）
    program_size_bytes: u64,
    /// 产品版本号 —— 取自 `Cargo.toml`；界面**不许**自己写一份（写死会与包名/配置漂移）。
    version: String,
}

#[tauri::command]
fn probe() -> UninstallProbe {
    UninstallProbe {
        version: env!("CARGO_PKG_VERSION").to_string(),
        program_size_bytes: dir_size(&install_dir()),
        data: DataProfiles {
            music: profile(music_cache_dir()),
            manga: profile(root_dir()),
            engine: profile(engine_dir()),
        },
    }
}

/// 执行卸载，每完成一步往 `onProgress` 发一次**已完成步数**（从 1 起）。
///
/// 步骤顺序与界面 `tools/progress.ts` 的 `buildPlan` 同序同数：
/// ① 入口（桌面 + 开始菜单）→ ② 程序文件与注册表项 → ③ 逐项数据 → ④ 安排自删。
#[tauri::command]
async fn run_uninstall(
    targets: Vec<String>,
    on_progress: tauri::ipc::Channel<u32>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || uninstall(&targets, &on_progress))
        .await
        .map_err(|e| format!("卸载线程异常：{e}"))?
        // 失败要把日志路径带上：界面上那句"请查看安装日志"得能落到具体文件
        .map_err(with_log_hint)
}

fn with_log_hint(message: String) -> String {
    format!("{message}（详见日志 {}）", log_path().display())
}

#[tauri::command]
fn close_window(window: tauri::Window) {
    // 卸载已经跑完：关窗这一刻再排一次自删 —— 上一轮那个清理进程可能已经超时退出
    if UNINSTALLED.load(Ordering::SeqCst) {
        let _ = selfdelete::schedule(&install_dir(), &current_exe());
    }
    let _ = window.close();
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--silent") {
        std::process::exit(run_silent());
    }

    // 全机安装（HKLM / Program Files）要管理员才能删干净；仅为我安装不需要
    if needs_elevation() && !registry::can_write_machine() {
        match relaunch_elevated(&args) {
            // 提权成功后本进程立即退出，活儿由新的那一个干
            Ok(()) => return,
            Err(error) => eprintln!("[uninstaller] {error}"),
        }
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![probe, run_uninstall, close_window])
        .run(tauri::generate_context!())
        .expect("卸载器窗口起不来");
}

// ------------------------------------------------------------------ 卸载动作

fn uninstall(targets: &[String], on_progress: &tauri::ipc::Channel<u32>) -> Result<(), String> {
    let install_dir = install_dir();
    let self_exe = current_exe();
    let mut done = 0u32;
    let mut tick = |progress: &tauri::ipc::Channel<u32>| {
        done += 1;
        let _ = progress.send(done);
    };

    log(&format!(
        "开始卸载 v{}，安装目录 {}，勾选数据 {:?}",
        env!("CARGO_PKG_VERSION"),
        install_dir.display(),
        targets
    ));

    // ① 入口：桌面（当前用户 + 公共）与开始菜单（全机 + 当前用户）四处置都清
    shortcuts::remove_all()?;
    log("入口已移除");
    tick(on_progress);

    // ② 先让**正在运行的主程序与服务**退出，再删程序文件与注册表项。
    //    🔴 不先退出会怎样：`miao-dock.exe` / `mangasvc.exe` 被占用 ⇒ 删到一半报错，
    //    进度停在第 2 步（用户看到的就是"进度条卡住"），而且目录里剩下的东西再也不会被清。
    let killed = terminate_running_app();
    log(&format!("已结束运行中的进程：{killed}"));
    remove_program_files(&install_dir, &self_exe)?;
    registry::delete()?;
    log("程序文件与注册表项已移除");
    tick(on_progress);

    // ③ 逐项删除勾选的数据目录（没勾的一律不碰）
    for kind in targets {
        let dir = data_dir(kind).ok_or_else(|| format!("未知的数据项：{kind}"))?;
        guard(&dir)?;
        if dir.is_dir() {
            remove_dir_safely(&dir)?;
        }
        log(&format!("已删除数据目录 {kind}：{}", dir.display()));
        tick(on_progress);
    }

    // ④ 安排自删：本程序与安装目录的空壳由后台 cmd 清掉
    selfdelete::schedule(&install_dir, &self_exe)?;
    UNINSTALLED.store(true, Ordering::SeqCst);
    log("已安排自删（关窗后由后台清理程序与安装目录）");
    tick(on_progress);

    Ok(())
}

/// 结束正在运行的主程序与其服务（`taskkill /T` 连子进程一起）。
///
/// 返回成功结束掉几个镜像 —— 只进日志，**不算失败**：没在运行是常态。
/// 为什么按镜像名而不是按路径：`taskkill` 只认镜像名；本产品一台机器上最多两份安装
/// （全机 + 仅为我），全杀掉是可接受的代价，而留着占用的 exe 会导致"卸载不干净"。
fn terminate_running_app() -> usize {
    let mut killed = 0;
    // 三个镜像：桌面端 + 漫画服务 + 动漫服务（D-242；后者是独立 exe，占着文件就删不干净）
    for image in ["miao-dock.exe", "mangasvc.exe", "animesvc.exe"] {
        let ok = Command::new("taskkill")
            .args(["/F", "/T", "/IM", image])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            killed += 1;
        }
    }
    if killed > 0 {
        // 句柄释放要一点时间：立刻删会撞上"文件仍在使用中"
        std::thread::sleep(Duration::from_millis(800));
    }
    killed
}

/// 卸载日志 —— 失败时界面让人"查看安装日志"，这份就是那个日志。
fn log_path() -> PathBuf {
    std::env::temp_dir().join("miao-dock-uninstall.log")
}

fn log(message: &str) {
    let line = format!("[uninstaller] {message}\n");
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = file.write_all(line.as_bytes());
    }
}

/// 静默档：只删程序、入口、注册表项（**不碰用户数据**），跑完即排自删并退出
fn run_silent() -> i32 {
    let install_dir = install_dir();
    let self_exe = current_exe();
    log(&format!(
        "静默卸载 v{}，安装目录 {}",
        env!("CARGO_PKG_VERSION"),
        install_dir.display()
    ));

    let result = (|| -> Result<(), String> {
        shortcuts::remove_all()?;
        log("入口已移除");
        // 与界面档同一条纪律：先结束占用 exe 的进程，否则删一半就报错
        let killed = terminate_running_app();
        log(&format!("已结束运行中的进程：{killed}"));
        remove_program_files(&install_dir, &self_exe)?;
        registry::delete()?;
        log("程序文件与注册表项已移除");
        selfdelete::schedule(&install_dir, &self_exe)?;
        log("已安排自删");
        Ok(())
    })();

    match result {
        Ok(()) => {
            println!("已卸载 {}", install_dir.display());
            0
        }
        Err(error) => {
            eprintln!("卸载失败：{}", with_log_hint(error));
            1
        }
    }
}

/// 删安装目录里的**所有内容**，只跳过正在运行的自己
fn remove_program_files(dir: &Path, keep: &Path) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("读不了安装目录（{}）：{e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读不了安装目录项：{e}"))?;
        let path = entry.path();
        if same_path(&path, keep) {
            continue;
        }
        let meta = fs::symlink_metadata(&path)
            .map_err(|e| format!("读不了（{}）：{e}", path.display()))?;
        if meta.is_dir() && !meta.file_type().is_symlink() {
            remove_dir_safely(&path)?;
        } else {
            fs::remove_file(&path).map_err(|e| format!("删不掉（{}）：{e}", path.display()))?;
        }
    }
    Ok(())
}

/// Windows 路径比较不区分大小写
fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
}

// ------------------------------------------------------------------ 权限与自删

/// 要不要管理员：卸载项在 HKLM，或安装目录在 Program Files 之下
fn needs_elevation() -> bool {
    if registry::find_scope() == Some(registry::Scope::Machine) {
        return true;
    }
    let install = install_dir();
    install.starts_with(program_files())
}

fn current_exe() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("MiaoDock-Uninstaller.exe"))
}

/// 以管理员身份重启自身（`runas`）；成功后调用方应立即退出
#[cfg(windows)]
fn relaunch_elevated(args: &[String]) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let exe = current_exe();
    let exe_w = wide(&exe.to_string_lossy());
    let verb_w = wide("runas");
    let params = args.join(" ");
    let params_w = wide(&params);

    let code = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb_w.as_ptr(),
            exe_w.as_ptr(),
            params_w.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    } as isize;

    if code <= 32 {
        return Err(format!(
            "没拿到管理员权限（ShellExecuteW 返回 {code}）—— 是否在授权弹窗里点了「否」？"
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn relaunch_elevated(_args: &[String]) -> Result<(), String> {
    Err("卸载器只在 Windows 上运行".to_string())
}

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

// ------------------------------------------------------------------ 路径口径

/// 安装目录 = 本程序所在目录（单文件安装下卸载器就住在里面）
fn install_dir() -> PathBuf {
    current_exe()
        .parent()
        .map(Path::to_path_buf)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| local_app_data().join("Programs").join("MiaoDock"))
}

fn program_files() -> PathBuf {
    std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Program Files"))
}

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

/// 音乐缓存：`%LOCALAPPDATA%\com.miaodock.desktop\cache\music-cache`
/// （`com.miaodock.desktop` 是主应用的 bundle identifier，与 `paths::app_cache_dir()` 同源）
fn music_cache_dir() -> PathBuf {
    local_app_data()
        .join("com.miaodock.desktop")
        .join("cache")
        .join("music-cache")
}

/// 漫画作品目录：`MIAO_MANGA_ROOT_DIR` 覆盖，默认 `~/Pictures/MiaoDock Mangas`
fn root_dir() -> PathBuf {
    env_path("MIAO_MANGA_ROOT_DIR").unwrap_or_else(|| user_profile().join("Pictures").join("MiaoDock Mangas"))
}

/// 引擎运行时：`<runtimeRoot>/manga-translator`，runtimeRoot 默认 `<appData>/MiaoDock/manga/runtimes`，
/// 可用 `MIAO_MANGA_RUNTIME_ROOT` 覆盖（与产品侧 `paths::manga_runtime_root()` 同一口径）
fn engine_dir() -> PathBuf {
    let root = env_path("MIAO_MANGA_RUNTIME_ROOT")
        .unwrap_or_else(|| local_app_data().join("MiaoDock").join("manga").join("runtimes"));
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
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| user_profile().join("AppData").join("Roaming")),
    ];
    // 环境变量覆盖出来的落点（测试 / 迁移场景）也放行其父目录
    for name in ["MIAO_MANGA_ROOT_DIR", "MIAO_MANGA_RUNTIME_ROOT"] {
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

    /// 安装目录 = 本程序所在目录（不再读任何外部记录文件）
    #[test]
    fn install_dir_is_the_exe_parent() {
        let dir = install_dir();
        let exe = current_exe();
        assert_eq!(exe.parent(), Some(dir.as_path()), "安装目录必须等于 exe 的父目录");
        assert!(dir.is_absolute(), "安装目录必须是绝对路径：{}", dir.display());
    }

    /// 路径比较不区分大小写（Windows 口径）
    #[test]
    fn same_path_ignores_ascii_case() {
        assert!(same_path(Path::new("C:\\a\\B.exe"), Path::new("c:\\A\\b.EXE")));
        assert!(!same_path(Path::new("C:\\a\\B.exe"), Path::new("C:\\a\\C.exe")));
    }

    #[cfg(windows)]
    #[test]
    fn verbatim_prefixes_once_and_normalizes_separators() {
        let v = verbatim(Path::new("C:/a/b"));
        assert_eq!(v.to_string_lossy(), "\\\\?\\C:\\a\\b");
        assert_eq!(verbatim(&v).to_string_lossy(), "\\\\?\\C:\\a\\b", "已带前缀的不许重复加");
    }
}
