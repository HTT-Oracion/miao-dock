//! 桌面 / 开始菜单快捷方式。
//!
//! 🔴 **落点按范围分流**：为所有用户 ⇒ `C:\ProgramData\Microsoft\Windows\Start Menu\Programs`；
//!    仅为我 ⇒ `%APPDATA%\Microsoft\Windows\Start Menu\Programs`。桌面两处都是「当前用户的桌面」。
//! 🔴 桌面走 `SHGetKnownFolderPath(FOLDERID_Desktop)` 而不是拼 `%USERPROFILE%\Desktop`：
//!    OneDrive 接管桌面后真实路径在别处，拼出来的 .lnk 会落在没人看的空目录里。
//! 🔴 「存在才建 / 取消才删」：勾选状态是用户的**当前意愿**，不是「没见过就别动」。

use crate::registry::Scope;
use mslnk::ShellLink;
use std::fs;
use std::path::{Path, PathBuf};

/// 快捷方式文件名 —— 显示名就是文件名（中文保留，路径层只有这一段中文）
pub const LINK_NAME: &str = "喵坞.lnk";

/// 桌面上的那一枚
pub fn desktop_lnk() -> Option<PathBuf> {
    desktop_dir().map(|dir| dir.join(LINK_NAME))
}

/// 开始菜单里的那一枚
pub fn start_menu_lnk(scope: Scope) -> Option<PathBuf> {
    start_menu_programs(scope).map(|dir| dir.join(LINK_NAME))
}

/// 开始菜单的 `Programs` 目录（全机 / 仅为我）
pub fn start_menu_programs(scope: Scope) -> Option<PathBuf> {
    let base = match scope {
        Scope::Machine => env_dir("ProgramData"),
        Scope::User => env_dir("APPDATA"),
    }?;
    Some(
        base.join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs"),
    )
}

/// 写一枚 .lnk；`icon` 指向主程序 exe（图标已内嵌，索引用 0）
pub fn create(lnk: &Path, target: &Path, workdir: &Path, icon: &Path) -> Result<(), String> {
    if let Some(parent) = lnk.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("建不了快捷方式目录（{}）：{e}", parent.display()))?;
    }
    let mut link = ShellLink::new(target)
        .map_err(|e| format!("建不了快捷方式（目标 {}）：{e}", target.display()))?;
    link.set_working_dir(Some(workdir.to_string_lossy().into_owned()));
    // 🔴 只给**路径**，不要自己拼 `,0`：`IconLocation` 里逗号后面那个是**图标索引**，
    //    系统默认就是 0。自己拼一次会得到 `path,0,0`（索引成了 `0,0`）⇒ 快捷方式**没有图标**
    //    （2026-10-18 用户实测：桌面那枚是白纸图标）。
    link.set_icon_location(Some(icon.to_string_lossy().into_owned()));
    link.create_lnk(lnk)
        .map_err(|e| format!("写不了快捷方式（{}）：{e}", lnk.display()))
}

/// 删一枚 .lnk；返回「原先是否存在」
pub fn remove(lnk: &Path) -> Result<bool, String> {
    if !lnk.exists() {
        return Ok(false);
    }
    fs::remove_file(lnk)
        .map(|_| true)
        .map_err(|e| format!("删不掉快捷方式（{}）：{e}", lnk.display()))
}

/// 按勾选状态处理两处入口：勾了就建、取消就删。
/// 返回失败说明（一处失败不影响另一处；空列表 = 全成功）。
pub fn apply(
    scope: Scope,
    install_dir: &Path,
    app_exe: &Path,
    desktop: bool,
    start_menu: bool,
) -> Vec<String> {
    let mut failures = Vec::new();
    let slots = [
        ("桌面", desktop_lnk(), desktop),
        ("开始菜单", start_menu_lnk(scope), start_menu),
    ];
    for (label, slot, wanted) in slots {
        let Some(lnk) = slot else {
            if wanted {
                failures.push(format!("找不到{label}目录，跳过了{label}快捷方式"));
            }
            continue;
        };
        let result = if wanted {
            create(&lnk, app_exe, install_dir, app_exe)
        } else {
            remove(&lnk).map(|_| ())
        };
        if let Err(error) = result {
            failures.push(error);
        }
    }
    failures
}

/// 当前用户桌面（已知文件夹优先，读不到才退回 `%USERPROFILE%\Desktop`）
#[cfg(windows)]
fn desktop_dir() -> Option<PathBuf> {
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_Desktop};

    let mut raw: *mut u16 = std::ptr::null_mut();
    let hr = unsafe {
        SHGetKnownFolderPath(&FOLDERID_Desktop, 0, std::ptr::null_mut(), &mut raw)
    };
    if hr == 0 && !raw.is_null() {
        let text = unsafe { read_wide(raw) };
        unsafe { CoTaskMemFree(raw as *const core::ffi::c_void) };
        return Some(PathBuf::from(text));
    }
    env_dir("USERPROFILE").map(|home| home.join("Desktop"))
}

#[cfg(not(windows))]
fn desktop_dir() -> Option<PathBuf> {
    env_dir("USERPROFILE").map(|home| home.join("Desktop"))
}

/// 读 `\\0` 结尾的宽字符串（调用方保证指针有效）
#[cfg(windows)]
unsafe fn read_wide(ptr: *const u16) -> String {
    let mut len = 0usize;
    while *ptr.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_name_is_the_only_chinese_segment() {
        assert_eq!(LINK_NAME, "喵坞.lnk");
        assert!(LINK_NAME.ends_with(".lnk"));
    }

    /// 开始菜单落点按范围分流：全机用 ProgramData，仅为我用 APPDATA
    #[test]
    fn start_menu_programs_follows_scope() {
        let machine = start_menu_programs(Scope::Machine).expect("ProgramData 必须可读");
        let user = start_menu_programs(Scope::User).expect("APPDATA 必须可读");
        let tail = ["Microsoft", "Windows", "Start Menu", "Programs"];
        assert!(machine.ends_with(Path::new(&tail.join("\\"))));
        assert!(user.ends_with(Path::new(&tail.join("\\"))));
        assert_ne!(machine, user, "两种范围不许落到同一处");
    }

    #[test]
    fn desktop_points_at_the_users_desktop() {
        let desktop = desktop_dir().expect("桌面目录必须可解析");
        assert!(desktop.is_absolute(), "桌面必须是绝对路径：{}", desktop.display());
        let lnk = desktop_lnk().expect("桌面快捷方式路径必须可拼");
        assert_eq!(lnk.file_name().and_then(|n| n.to_str()), Some(LINK_NAME));
    }

    /// 删一个不存在的 .lnk 不算错误（取消勾选时可能本来就没有）
    #[test]
    fn removing_a_missing_link_is_not_an_error() {
        let temp = std::env::temp_dir().join("miaodock-shortcut-none.lnk");
        let _ = fs::remove_file(&temp);
        assert_eq!(remove(&temp), Ok(false));
    }
}
