//! 卸载项注册表 —— 控制面板「应用和功能」里的那一行。
//!
//! 🔴 **范围决定 hive**：为所有用户安装 ⇒ HKLM（要管理员）；仅为我安装 ⇒ HKCU（免管理员）。
//! 🔴 **一律显式 `KEY_WOW64_64KEY`**：`HKCU\Software` 在 32 位视图下会被重定向到
//!    `WOW6432Node`，不加这个标志写进去的项，64 位控制面板根本看不到。
//! 🔴 `UninstallString` **不带** `--silent`（点卸载要看得到界面）；
//!    需要静默的自动化走 `QuietUninstallString`。

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// 卸载项子键名 —— HKLM / HKCU 同名，与安装目录末段一致
pub const SUBKEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MiaoDock";

/// 控制面板里显示的名字（中文保留，方便用户在列表里认出来）
pub const DISPLAY_NAME: &str = "喵坞 MiaoDock";

/// 静默卸载参数（`QuietUninstallString` 用）
pub const SILENT_ARG: &str = "--silent";

/// 安装范围
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// 为所有用户（HKLM + `Program Files`）
    Machine,
    /// 仅为我（HKCU + `%LOCALAPPDATA%`）
    User,
}

impl Scope {
    /// 人话口径（错误提示用）
    pub fn label(self) -> &'static str {
        match self {
            Self::Machine => "为所有用户",
            Self::User => "仅为我",
        }
    }
}

/// 要写进卸载项的一组值
pub struct Entry<'a> {
    pub version: &'a str,
    pub publisher: &'a str,
    pub install_dir: &'a Path,
    /// 主程序 exe（`DisplayIcon` 指向它，图标已内嵌在 exe 里）
    pub app_exe: &'a Path,
    /// 安装目录里的卸载器 exe（控制面板点「卸载」就起它）
    pub uninstaller: &'a Path,
    /// 落盘字节数 ⇒ 注册表里按 KB 记
    pub size_bytes: u64,
}

/// 带引号的路径：`UninstallString` 是按命令行解析的，路径含空格时不加引号会被拆开
pub fn quoted(path: &Path) -> String {
    format!("\"{}\"", path.display())
}

pub fn uninstall_string(uninstaller: &Path) -> String {
    quoted(uninstaller)
}

pub fn quiet_uninstall_string(uninstaller: &Path) -> String {
    format!("{} {SILENT_ARG}", quoted(uninstaller))
}

/// `DisplayIcon` 的形态是「路径,索引」
pub fn display_icon(app_exe: &Path) -> String {
    format!("{},0", app_exe.display())
}

/// 注册表的 `EstimatedSize` 是 KB 的 DWORD
pub fn estimated_size_kb(bytes: u64) -> u32 {
    let kb = bytes / 1024;
    u32::try_from(kb).unwrap_or(u32::MAX)
}

/// `InstallDate` 的形态是 `YYYYMMDD`
pub fn install_date(now: SystemTime) -> String {
    let days = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0) as i64;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}{month:02}{day:02}")
}

/// 自 1970-01-01 起的天数 → 公历年月日（Howard Hinnant 的 civil_from_days）
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(windows)]
mod platform {
    use super::{Entry, Scope, DISPLAY_NAME, SUBKEY};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY, KEY_WRITE, REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    fn hive(scope: Scope) -> HKEY {
        match scope {
            Scope::Machine => HKEY_LOCAL_MACHINE,
            Scope::User => HKEY_CURRENT_USER,
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn set_string(key: HKEY, name: &str, value: &str) -> Result<(), String> {
        let name_w = wide(name);
        let data: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes = (data.len() * 2) as u32;
        let code = unsafe {
            RegSetValueExW(key, name_w.as_ptr(), 0, REG_SZ, data.as_ptr() as *const u8, bytes)
        };
        if code != 0 {
            return Err(format!("写注册表值 {name} 失败（错误码 {code}）"));
        }
        Ok(())
    }

    fn set_dword(key: HKEY, name: &str, value: u32) -> Result<(), String> {
        let name_w = wide(name);
        let code = unsafe {
            RegSetValueExW(
                key,
                name_w.as_ptr(),
                0,
                REG_DWORD,
                &value as *const u32 as *const u8,
                4,
            )
        };
        if code != 0 {
            return Err(format!("写注册表值 {name} 失败（错误码 {code}）"));
        }
        Ok(())
    }

    /// 写卸载项。`scope` 决定 hive；调用方负责先确认权限（HKLM 要管理员）。
    pub fn write(scope: Scope, entry: &Entry<'_>) -> Result<(), String> {
        let sub = wide(SUBKEY);
        let mut key: HKEY = std::ptr::null_mut();
        let code = unsafe {
            RegCreateKeyExW(
                hive(scope),
                sub.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE | KEY_WOW64_64KEY,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        };
        if code != 0 {
            return Err(format!(
                "建不了卸载项注册表键（{}，错误码 {code}）—— 为所有用户安装需要管理员权限",
                scope.label()
            ));
        }

        let install_dir = entry.install_dir.to_string_lossy().into_owned();
        let result = (|| -> Result<(), String> {
            set_string(key, "DisplayName", DISPLAY_NAME)?;
            set_string(key, "DisplayVersion", entry.version)?;
            set_string(key, "Publisher", entry.publisher)?;
            set_string(key, "InstallLocation", &install_dir)?;
            set_string(key, "UninstallString", &super::uninstall_string(entry.uninstaller))?;
            set_string(
                key,
                "QuietUninstallString",
                &super::quiet_uninstall_string(entry.uninstaller),
            )?;
            set_string(key, "DisplayIcon", &super::display_icon(entry.app_exe))?;
            set_string(key, "InstallDate", &super::install_date(std::time::SystemTime::now()))?;
            set_dword(key, "EstimatedSize", super::estimated_size_kb(entry.size_bytes))?;
            set_dword(key, "NoModify", 1)?;
            set_dword(key, "NoRepair", 1)?;
            Ok(())
        })();

        unsafe { RegCloseKey(key) };
        result
    }

    /// 能否对 HKLM 的 `Uninstall` 根键申请写权限 —— 等价于「当前进程是否已提权」
    pub fn can_write_machine() -> bool {
        let sub = wide("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall");
        let mut key: HKEY = std::ptr::null_mut();
        let code = unsafe {
            RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                sub.as_ptr(),
                0,
                KEY_WRITE | KEY_WOW64_64KEY,
                &mut key,
            )
        };
        if code != 0 {
            return false;
        }
        unsafe { RegCloseKey(key) };
        true
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{Entry, Scope};

    pub fn write(_scope: Scope, _entry: &Entry<'_>) -> Result<(), String> {
        Err("卸载项注册表只在 Windows 上写".to_string())
    }

    pub fn can_write_machine() -> bool {
        false
    }
}

pub use platform::{can_write_machine, write};

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn quotes_paths_so_spaces_survive_the_command_line() {
        let path = Path::new("C:\\Program Files\\MiaoDock\\MiaoDock-Uninstaller.exe");
        assert_eq!(
            uninstall_string(path),
            "\"C:\\Program Files\\MiaoDock\\MiaoDock-Uninstaller.exe\""
        );
        assert_eq!(
            quiet_uninstall_string(path),
            "\"C:\\Program Files\\MiaoDock\\MiaoDock-Uninstaller.exe\" --silent"
        );
    }

    /// 界面点「卸载」必须进卸载器界面 ⇒ UninstallString 不许带 --silent
    #[test]
    fn interactive_uninstall_stays_interactive() {
        let path = Path::new("C:\\App\\MiaoDock-Uninstaller.exe");
        assert!(!uninstall_string(path).contains("--silent"));
        assert!(quiet_uninstall_string(path).contains("--silent"));
        assert_eq!(display_icon(path), "C:\\App\\MiaoDock-Uninstaller.exe,0");
    }

    #[test]
    fn estimated_size_is_kb_and_saturates_instead_of_wrapping() {
        assert_eq!(estimated_size_kb(0), 0);
        assert_eq!(estimated_size_kb(1023), 0);
        assert_eq!(estimated_size_kb(1024), 1);
        assert_eq!(estimated_size_kb(327_155_712), 319_488);
        assert_eq!(estimated_size_kb(u64::MAX), u32::MAX, "超大不得回绕成小数");
    }

    #[test]
    fn install_date_is_yyyymmdd() {
        assert_eq!(install_date(UNIX_EPOCH), "19700101");
        assert_eq!(
            install_date(UNIX_EPOCH + Duration::from_secs(19_723 * 86_400)),
            "20240101"
        );
        assert_eq!(
            install_date(UNIX_EPOCH + Duration::from_secs(20_660 * 86_400)),
            "20260726"
        );
    }

    /// 子键名与安装目录末段同名（全仓一个口径，改一处就能 grep 到）
    #[test]
    fn subkey_ends_with_the_product_folder_name() {
        assert!(SUBKEY.ends_with("\\Uninstall\\MiaoDock"));
        assert_eq!(DISPLAY_NAME, "喵坞 MiaoDock");
    }
}
