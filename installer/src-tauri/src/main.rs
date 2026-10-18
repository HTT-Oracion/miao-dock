//! 喵坞安装器 · 宿主程序（WebView 小窗）
//!
//! 这一层是安装向导界面（`installer/dist`）的"手"：界面只发意图，**环境探测 / 选目录 /
//! 静默安装 / 打开日志 / 关窗**都在这里做。契约见 `installer/src/host.ts` 的 `InstallerHost`，
//! 两侧字段名逐项对应（Rust 侧 `camelCase` ⇄ TS 侧同名）。
//!
//! 🔴 **长路径开关只读**：与 `installer/hooks.nsh` 的既有纪律一致 —— 当前用户安装模式
//!    没资格替系统改 HKLM，这里只读出来交给界面，由用户自己决定。
//! 🔴 **不猜安装包文件名**：与本程序同目录的 `*-setup.exe` 才是要跑的那一个
//!    （版本号会随每次打包变，写死名字下次就找不到）。
//! 🔴 本程序**不在**安装目录里被安装时才有意义：它要驱动安装包，自己不能被装进去。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod elevate;
mod manifest;
mod payload;
mod registry;
mod shortcuts;

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri_plugin_dialog::DialogExt;

/// 传给界面的安装环境 —— 字段名与 `installer/src/host.ts` 的 `InstallEnv` 一一对应
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallEnv {
    /// 默认安装目录（当前用户目录 ⇒ 免管理员）
    default_dir: String,
    /// 安装包体积（字节）—— 与本程序同目录的 `*-setup.exe`
    size_bytes: u64,
    /// 目标盘可用空间（字节）
    free_bytes: u64,
    /// 安装模式说明
    mode: String,
    /// 系统长路径开关：`None` = 读不到（界面按"未开"处理）
    long_path_enabled: Option<bool>,
    /// 安装日志的**绝对路径**（界面拿它显示、点"查看安装日志"时再传回来）
    log_path: String,
}

#[tauri::command]
fn probe_env() -> InstallEnv {
    let default_dir = default_install_dir();
    InstallEnv {
        size_bytes: locate_setup().map(|p| file_len(&p)).unwrap_or(0),
        free_bytes: free_bytes_of(&default_dir).unwrap_or(0),
        mode: "当前用户（无需管理员）".to_string(),
        long_path_enabled: long_path_enabled(),
        default_dir: default_dir.to_string_lossy().into_owned(),
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

#[tauri::command]
async fn run_install(install_dir: String) -> Result<i32, String> {
    let setup = locate_setup().ok_or_else(|| {
        "没找到安装包：请把本程序与 `*-setup.exe` 放在同一个目录".to_string()
    })?;
    let target = install_dir.trim().to_string();
    if target.is_empty() {
        return Err("安装目录为空".to_string());
    }
    // NSIS 的两条硬规矩：`/S` 静默；`/D=` 必须**最后一个**参数且**不加引号**
    // （加了引号 NSIS 会把引号当成路径的一部分，装到一个带引号的怪目录里）
    let status = Command::new(&setup)
        .arg("/S")
        .arg(format!("/D={target}"))
        .status()
        .map_err(|e| format!("起不来安装包（{}）：{e}", setup.display()))?;
    let code = status.code().unwrap_or(-1);
    if code != 0 {
        return Ok(code);
    }

    // 安装成功后的收尾：把卸载器放到**安装目录之外**并写下安装位置。
    // 为什么要"之外"：卸载时 `uninstall.exe` 会删掉整个安装目录，而运行中的程序
    // 会被系统跳过 —— 卸载器躺在里面就会留下一个孤儿 exe。
    // 失败不算安装失败（程序本体已经装好了），但要让日志里看得见。
    if let Err(err) = deploy_uninstaller(Path::new(&target)) {
        eprintln!("[installer] 卸载器部署失败：{err}");
    }
    Ok(code)
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            probe_env,
            pick_dir,
            run_install,
            open_log,
            close_window
        ])
        .run(tauri::generate_context!())
        .expect("安装器窗口起不来");
}

// ------------------------------------------------------------------ 环境探测

/// 默认安装目录：`%LOCALAPPDATA%\Programs\喵坞`
/// （与 Tauri NSIS 的"当前用户"默认落点一致；写成绝对路径，界面直接显示）
fn default_install_dir() -> PathBuf {
    local_app_data().join("Programs").join("喵坞")
}

fn local_app_data() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 与本程序同目录的 `*-setup.exe`。
/// 按形态找而不是写死名字：打包产物的文件名带版本号（`喵坞_2.2.1_x64-setup.exe`）。
fn locate_setup() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let mut hits: Vec<PathBuf> = fs::read_dir(&dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|p| {
            p.is_file() && p.file_name().and_then(|n| n.to_str()).is_some_and(is_setup_name)
        })
        .collect();
    hits.sort();
    hits.into_iter().next()
}

fn is_setup_name(name: &str) -> bool {
    name.to_lowercase().ends_with("-setup.exe")
}

fn file_len(p: &Path) -> u64 {
    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// 安装日志落点：系统临时目录下的 `miao-dock-install.log`。
/// 用 `temp_dir()` 而不是手拼 `%TEMP%`：后者在界面里只是文本，传给 `open_log` 时并不会展开。
fn log_path() -> PathBuf {
    std::env::temp_dir().join("miao-dock-install.log")
}

/// 卸载器的家：`%LOCALAPPDATA%\喵坞卸载器\`（**安装目录之外**，理由见 `run_install` 里的注释）
fn uninstaller_dir() -> PathBuf {
    local_app_data().join("喵坞卸载器")
}

/// 把与本程序同目录的 `miao-uninstaller.exe` 复制到自己的家，并写下应用装在哪。
///
/// `install-location.txt` 是两程序之间**唯一**的落点契约：卸载器不认识"默认安装目录"以外的
/// 情况，用户把喵坞装到别的盘时，只有这份记录能让它找对地方。
fn deploy_uninstaller(install_dir: &Path) -> Result<PathBuf, String> {
    let source = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|dir| dir.join("miao-uninstaller.exe")))
        .ok_or_else(|| "取不到本程序所在目录".to_string())?;
    if !source.is_file() {
        return Err(format!("安装器旁边没有卸载器：{}", source.display()));
    }
    let dir = uninstaller_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("建不了目录 {}：{e}", dir.display()))?;
    let dest = dir.join("miao-uninstaller.exe");
    fs::copy(&source, &dest).map_err(|e| format!("复制卸载器失败：{e}"))?;
    let record = dir.join("install-location.txt");
    fs::write(&record, install_dir.to_string_lossy().as_bytes())
        .map_err(|e| format!("写不了安装位置记录：{e}"))?;
    Ok(dest)
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

    /// 安装包按形态识别：版本号会变，名字不能写死
    #[test]
    fn setup_name_matches_packaged_form() {
        assert!(is_setup_name("喵坞_2.2.1_x64-setup.exe"));
        assert!(is_setup_name("app-SETUP.EXE"));
        assert!(!is_setup_name("miao-dock.exe"));
        assert!(!is_setup_name("setup.msi"));
    }

    /// 默认安装目录必须是"当前用户目录下"的方案（决定免管理员），且末段是产品名
    #[test]
    fn default_dir_lives_under_local_app_data() {
        let dir = default_install_dir();
        assert!(dir.starts_with(local_app_data()));
        let name = dir.file_name().and_then(|n| n.to_str()).map(str::to_string);
        assert_eq!(name.as_deref(), Some("喵坞"));
    }

    /// 日志路径要是**绝对路径**：界面把它交给 `open_log`，含 `%TEMP%` 的占位串不会被展开
    #[test]
    fn log_path_is_absolute() {
        let p = log_path();
        assert!(p.is_absolute());
        assert_eq!(
            p.file_name().and_then(|n| n.to_str()),
            Some("miao-dock-install.log")
        );
    }

    /// 卸载器必须落在安装目录**之外**（装在里面的那份会被 uninstall.exe 因占用跳过，留成孤儿）
    #[test]
    fn uninstaller_dir_sits_outside_the_install_dir() {
        let host = uninstaller_dir();
        assert!(host.starts_with(local_app_data()));
        assert!(
            !host.starts_with(default_install_dir()),
            "卸载器不许放进安装目录：{}",
            host.display()
        );
        assert_eq!(host.file_name().and_then(|n| n.to_str()), Some("喵坞卸载器"));
    }
}
