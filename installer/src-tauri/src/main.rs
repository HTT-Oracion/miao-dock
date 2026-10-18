//! 喵坞安装器 · 宿主程序（WebView 小窗）
//!
//! 这一层既是安装向导界面（`installer/dist`）的"手"，**也是安装引擎本身**：
//! 主程序 exe + 资源 + 卸载器 exe 打成 `payload.zip` 编译进本程序，
//! 运行时解包落盘、写控制面板卸载项、按勾选建入口。界面只发意图，契约见
//! `installer/src/host.ts` 的 `InstallerHost`（Rust 侧 `camelCase` ⇄ TS 侧同名）。
//!
//! 🔴 **提权在窗口出来之前**：默认「为所有用户安装」要写 HKLM 与 `Program Files`，
//!    双击即弹一次 UAC；点「否」就什么都不做。静默档与 `--per-user` 不自动提权。
//! 🔴 **长路径开关只读**：安装器只探测与提示，不替用户改系统设置。
//! 🔴 **注册表写失败必须回滚落盘的文件**：不留「装了但控制面板里没有」的现场。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod elevate;
mod manifest;
mod payload;
mod registry;
mod shortcuts;

use registry::Scope;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri_plugin_dialog::DialogExt;

/// 传给界面的安装环境 —— 字段名与 `installer/src/host.ts` 的 `InstallEnv` 一一对应
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallEnv {
    /// 为所有用户的默认目录（`C:\Program Files\MiaoDock`）
    machine_dir: String,
    /// 仅为我安装的默认目录（`%LOCALAPPDATA%\Programs\MiaoDock`）
    user_dir: String,
    /// 内嵌载荷压缩后的体积（字节）—— 界面「程序体积」的数据源
    payload_bytes: u64,
    /// 目标盘可用空间（字节）
    free_bytes: u64,
    /// 默认是否「仅为我安装」（当前为否：默认全机）
    per_user_default: bool,
    /// 两种范围的模式说明（宿主给，界面不写死）
    mode_machine: String,
    mode_user: String,
    /// 系统长路径开关：`None` = 读不到（界面按"未开"处理）
    long_path_enabled: Option<bool>,
    /// 安装日志的**绝对路径**（界面拿它显示、点"查看安装日志"时再传回来）
    log_path: String,
}

#[tauri::command]
fn probe_env() -> InstallEnv {
    let machine_dir = machine_install_dir();
    InstallEnv {
        user_dir: user_install_dir().to_string_lossy().into_owned(),
        free_bytes: free_bytes_of(&machine_dir).unwrap_or(0),
        machine_dir: machine_dir.to_string_lossy().into_owned(),
        payload_bytes: payload::Payload::packed_len(),
        per_user_default: false,
        mode_machine: "所有用户（需要管理员授权）".to_string(),
        mode_user: "当前用户（无需管理员）".to_string(),
        long_path_enabled: long_path_enabled(),
        log_path: log_path().to_string_lossy().into_owned(),
    }
}

#[tauri::command]
fn pick_dir(app: tauri::AppHandle, current: String) -> Option<String> {
    let mut builder = app.dialog().file();
    let current = current.trim();
    if !current.is_empty() && Path::new(current).is_dir() {
        builder = builder.set_directory(current);
    }
    builder
        .blocking_pick_folder()
        .and_then(|picked| picked.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// 解包安装：落盘 → 写卸载项。放阻塞线程池，界面在大文件释放期间不假死。
#[tauri::command]
async fn run_install(dir: String, per_user: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || install(&dir, scope_of(per_user)))
        .await
        .map_err(|e| format!("安装线程异常：{e}"))?
}

/// 完成页按勾选补建 / 清除入口；返回失败说明（空 = 全部成功）
#[tauri::command]
fn create_shortcuts(
    dir: String,
    per_user: bool,
    desktop: bool,
    start_menu: bool,
) -> Result<Vec<String>, String> {
    let target = PathBuf::from(dir.trim());
    let app_exe = payload::Payload::open()?
        .manifest()
        .app_exe_path(&target)
        .ok_or_else(|| "载荷清单里的主程序路径不合法".to_string())?;
    if !app_exe.is_file() {
        return Err(format!("安装目录里找不到主程序：{}", app_exe.display()));
    }
    Ok(shortcuts::apply(
        scope_of(per_user),
        &target,
        &app_exe,
        desktop,
        start_menu,
    ))
}

/// 「立即打开喵坞」—— 经 `explorer.exe` 起，避免主程序继承安装器的管理员令牌
#[tauri::command]
fn launch_app(dir: String) -> Result<(), String> {
    let target = PathBuf::from(dir.trim());
    let app_exe = payload::Payload::open()?
        .manifest()
        .app_exe_path(&target)
        .ok_or_else(|| "载荷清单里的主程序路径不合法".to_string())?;
    if !app_exe.is_file() {
        return Err(format!("安装目录里找不到主程序：{}", app_exe.display()));
    }
    // explorer 以登录用户身份启动它 ⇒ 主程序不会跟着安装器一起提权
    let via_shell = Command::new("explorer").arg(&app_exe).spawn().map(|_| ());
    if via_shell.is_ok() {
        return Ok(());
    }
    Command::new(&app_exe)
        .current_dir(&target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("起不来主程序（{}）：{e}", app_exe.display()))
}

#[tauri::command]
fn open_log(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        // 还没装过 / 还没写过日志：说清"不存在"，不要让用户面对一个空窗口
        return Err(format!("安装日志还不存在：{path}"));
    }
    Command::new("explorer")
        .arg(p)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打不开日志：{e}"))
}

#[tauri::command]
fn close_window(window: tauri::Window) {
    let _ = window.close();
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cli = elevate::Cli::parse(&args);

    // 静默档：不起窗口，装完即退（e2e 与包管理器用）
    if cli.silent {
        std::process::exit(run_silent(&cli));
    }

    // 提权必须在窗口出来之前 —— 用户在 UAC 点「否」就等于放弃安装。
    // 传回去的是**规范化后的参数**：新进程要能解析出同一份意图，否则会再弹一次 UAC。
    if elevate::should_relaunch(&cli) {
        match elevate::relaunch_elevated(&cli.to_args()) {
            Ok(()) => return,
            Err(error) => {
                log_line(&log_path(), &format!("提权失败：{error}"));
                return;
            }
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            probe_env,
            pick_dir,
            run_install,
            create_shortcuts,
            launch_app,
            open_log,
            close_window
        ])
        .run(tauri::generate_context!())
        .expect("安装器窗口起不来");
}

// ------------------------------------------------------------------ 安装动作

fn scope_of(per_user: bool) -> Scope {
    if per_user {
        Scope::User
    } else {
        Scope::Machine
    }
}

/// 带日志的安装包装：任何一步失败都写进日志，再把同一句话交给界面
fn install(dir: &str, scope: Scope) -> Result<(), String> {
    let log = log_path();
    let target = PathBuf::from(dir.trim());
    if target.as_os_str().is_empty() {
        return Err("安装目录为空".to_string());
    }
    if !target.is_absolute() {
        return Err(format!("安装目录必须是绝对路径：{}", target.display()));
    }

    log_line(
        &log,
        &format!("开始安装 → {}（{}）", target.display(), scope.label()),
    );
    match install_payload(scope, &target) {
        Ok(written) => {
            log_line(&log, &format!("完成：落盘 {written} 字节"));
            Ok(())
        }
        Err(error) => {
            log_line(&log, &format!("失败：{error}"));
            Err(error)
        }
    }
}

fn install_payload(scope: Scope, target: &Path) -> Result<u64, String> {
    let payload = payload::Payload::open()?;
    let manifest = payload.manifest();
    let app_exe = manifest
        .app_exe_path(target)
        .ok_or_else(|| "载荷清单里的主程序路径不合法".to_string())?;
    let uninstaller = manifest
        .uninstaller_path(target)
        .ok_or_else(|| "载荷清单里的卸载器路径不合法".to_string())?;

    let written = payload.install(target)?;

    let entry = registry::Entry {
        version: &manifest.version,
        publisher: &manifest.publisher,
        install_dir: target,
        app_exe: &app_exe,
        uninstaller: &uninstaller,
        size_bytes: written,
    };
    if let Err(error) = registry::write(scope, &entry) {
        // 注册表没写成 ⇒ 回滚落盘的文件，别留「装了但控制面板里没有」的现场
        let _ = fs::remove_dir_all(target);
        return Err(format!("{error}（已回滚落盘的文件）"));
    }
    Ok(written)
}

/// 静默档：`--silent [--dir <目录>] [--per-user] [--no-shortcuts]`，退出码 0 = 成功
fn run_silent(cli: &elevate::Cli) -> i32 {
    let scope = if cli.per_user {
        Scope::User
    } else {
        Scope::Machine
    };
    let target = cli
        .dir
        .clone()
        .map(PathBuf::from)
        .unwrap_or_else(|| default_install_dir(scope));

    match install(&target.to_string_lossy(), scope) {
        Ok(()) => {}
        Err(error) => {
            eprintln!("安装失败：{error}");
            return 1;
        }
    }

    if !cli.no_shortcuts {
        let app_exe = payload::Payload::open()
            .ok()
            .and_then(|payload| payload.manifest().app_exe_path(&target));
        let Some(app_exe) = app_exe else {
            eprintln!("安装完成，但取不到主程序路径，跳过快捷方式");
            return 0;
        };
        for failure in shortcuts::apply(scope, &target, &app_exe, true, true) {
            eprintln!("快捷方式：{failure}");
        }
    }

    println!("已安装到 {}", target.display());
    0
}

// ------------------------------------------------------------------ 路径口径

/// 为所有用户的默认目录：`%ProgramFiles%\MiaoDock`
fn machine_install_dir() -> PathBuf {
    program_files().join("MiaoDock")
}

/// 仅为我安装的默认目录：`%LOCALAPPDATA%\Programs\MiaoDock`
fn user_install_dir() -> PathBuf {
    local_app_data().join("Programs").join("MiaoDock")
}

fn default_install_dir(scope: Scope) -> PathBuf {
    match scope {
        Scope::Machine => machine_install_dir(),
        Scope::User => user_install_dir(),
    }
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

/// 安装日志落点：系统临时目录下的 `miao-dock-install.log`。
/// 用 `temp_dir()` 而不是手拼 `%TEMP%`：后者在界面里只是文本，传给 `open_log` 时并不会展开。
fn log_path() -> PathBuf {
    std::env::temp_dir().join("miao-dock-install.log")
}

/// 追加一行日志（写不进去不算失败 —— 日志是辅助，不该反过来挡住安装）
fn log_line(path: &Path, text: &str) {
    let line = format!("[{}] {text}\n", stamp(SystemTime::now()));
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = file.write_all(line.as_bytes());
    }
}

/// `YYYY-MM-DD HH:MM:SS`（不引 chrono：只要一个可读时间戳）
fn stamp(now: SystemTime) -> String {
    let secs = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rest = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

/// 自 1970-01-01 起的天数 → 公历年月日（与 `registry` 同一套算法，日志用）
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(windows)]
fn free_bytes_of(p: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    // 目标目录可能还不存在（首次安装）⇒ 逐层回退到存在的那一级再问它所在的盘
    let mut dir = p.to_path_buf();
    while !dir.exists() {
        if !dir.pop() {
            break;
        }
    }
    let mut wide: Vec<u16> = dir.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut free: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut())
    };
    (ok != 0).then_some(free)
}

#[cfg(not(windows))]
fn free_bytes_of(_p: &Path) -> Option<u64> {
    None
}

/// 读 `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled`（**只读**）。
/// 64 位进程默认读的就是 64 位视图，不需要 `SetRegView`。
#[cfg(windows)]
fn long_path_enabled() -> Option<bool> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ, REG_DWORD,
    };

    const SUBKEY: &str = "SYSTEM\\CurrentControlSet\\Control\\FileSystem";
    const VALUE: &str = "LongPathsEnabled";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let mut key: HKEY = std::ptr::null_mut();
    let opened = unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, wide(SUBKEY).as_ptr(), 0, KEY_READ, &mut key) };
    if opened != 0 {
        return None;
    }

    let mut value: u32 = 0;
    let mut kind: u32 = 0;
    let mut size: u32 = std::mem::size_of::<u32>() as u32;
    let read = unsafe {
        RegQueryValueExW(
            key,
            wide(VALUE).as_ptr(),
            std::ptr::null(),
            &mut kind,
            &mut value as *mut u32 as *mut u8,
            &mut size,
        )
    };
    unsafe { RegCloseKey(key) };

    if read != 0 || kind != REG_DWORD {
        return None;
    }
    Some(value == 1)
}

#[cfg(not(windows))]
fn long_path_enabled() -> Option<bool> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 两套默认目录都叫 MiaoDock（ASCII，与注册表子键同名），且分居两个不同的根
    #[test]
    fn default_dirs_are_named_miaodock_and_live_apart() {
        let machine = machine_install_dir();
        let user = user_install_dir();
        for dir in [&machine, &user] {
            let name = dir.file_name().and_then(|n| n.to_str());
            assert_eq!(name, Some("MiaoDock"), "目录末段必须是 MiaoDock：{}", dir.display());
        }
        assert!(machine.starts_with(program_files()), "全机目录在 Program Files 下");
        assert!(user.starts_with(local_app_data()), "仅为我目录在 LOCALAPPDATA 下");
        assert_ne!(machine, user, "两种范围不许落到同一处");
    }

    /// 安装日志必须是**绝对路径**：界面把它交给 `open_log`，含 `%TEMP%` 的占位串不会被展开
    #[test]
    fn log_path_is_absolute() {
        let p = log_path();
        assert!(p.is_absolute());
        assert_eq!(
            p.file_name().and_then(|n| n.to_str()),
            Some("miao-dock-install.log")
        );
    }

    #[test]
    fn stamp_is_readable_and_zero_safe() {
        assert_eq!(stamp(UNIX_EPOCH), "1970-01-01 00:00:00");
        assert_eq!(
            stamp(UNIX_EPOCH + std::time::Duration::from_secs(19_723 * 86_400 + 3661)),
            "2024-01-01 01:01:01"
        );
    }

    /// 范围开关只影响 hive 与默认目录，不影响别的口径
    #[test]
    fn scope_switch_maps_to_hives() {
        assert_eq!(scope_of(true), Scope::User);
        assert_eq!(scope_of(false), Scope::Machine);
        assert_eq!(default_install_dir(Scope::Machine), machine_install_dir());
        assert_eq!(default_install_dir(Scope::User), user_install_dir());
    }

    /// 生产环境不该出现只写了一个字符的载荷 —— 那说明打包步骤被跳过了
    #[test]
    fn payload_is_either_packed_or_clearly_a_stub() {
        let len = payload::Payload::packed_len();
        if len <= 1 {
            // 占位：确实没打载荷，报错话术里必须点名怎么打
            let error = payload::Payload::open().err().unwrap_or_default();
            assert!(
                error.contains("install:pack"),
                "占位载荷的报错要点名打包命令：{error}"
            );
        } else {
            let opened = payload::Payload::open();
            assert!(opened.is_ok(), "真载荷必须能读出清单");
        }
    }
}
