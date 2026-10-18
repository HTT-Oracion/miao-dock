//! 快捷方式清理 —— 桌面与开始菜单里那几枚 `喵坞.lnk`。
//!
//! 🔴 **两套落点都清**：同一台机器上可能先装成「仅为我」再装成「为所有用户」，
//!    只按当前范围清会留下没人管的一枚。判据只有「文件在不在」，不猜。
//! 🔴 桌面走 `SHGetKnownFolderPath(FOLDERID_Desktop)`：OneDrive 接管桌面后
//!    真实路径在别处，拼 `%USERPROFILE%\Desktop` 会漏。
//! 🔴 只删自己那枚 `.lnk`，**不动**开始菜单里同名目录或其它文件。

use std::fs;
use std::path::PathBuf;

/// 快捷方式文件名（与安装器写出的那一枚同名）
pub const LINK_NAME: &str = "喵坞.lnk";

/// 所有可能有我们的 `.lnk` 的位置（去重后）
pub fn candidates() -> Vec<PathBuf> {
    let mut slots: Vec<PathBuf> = Vec::new();
    for dir in desktop_dirs()
        .into_iter()
        .chain(start_menu_dirs())
        .flatten()
    {
        let lnk = dir.join(LINK_NAME);
        if !slots.contains(&lnk) {
            slots.push(lnk);
        }
    }
    slots
}

/// 删掉所有存在的 `.lnk`；返回删了几枚
pub fn remove_all() -> Result<usize, String> {
    let mut removed = 0usize;
    for lnk in candidates() {
        if !lnk.exists() {
            continue;
        }
        fs::remove_file(&lnk)
            .map_err(|e| format!("删不掉快捷方式（{}）：{e}", lnk.display()))?;
        removed += 1;
    }
    Ok(removed)
}

/// 桌面目录：当前用户的真实桌面 + 公共桌面
#[cfg(windows)]
fn desktop_dirs() -> Vec<Option<PathBuf>> {
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_Desktop};

    let mut slots = Vec::new();

    let mut raw: *mut u16 = std::ptr::null_mut();
    let hr = unsafe { SHGetKnownFolderPath(&FOLDERID_Desktop, 0, std::ptr::null_mut(), &mut raw) };
    if hr == 0 && !raw.is_null() {
        let text = unsafe { read_wide(raw) };
        unsafe { CoTaskMemFree(raw as *const core::ffi::c_void) };
        slots.push(Some(PathBuf::from(text)));
    } else {
        slots.push(env_dir("USERPROFILE").map(|home| home.join("Desktop")));
    }

    slots.push(env_dir("PUBLIC").map(|public| public.join("Desktop")));
    slots
}

#[cfg(not(windows))]
fn desktop_dirs() -> Vec<Option<PathBuf>> {
    vec![env_dir("USERPROFILE").map(|home| home.join("Desktop"))]
}

/// 开始菜单 `Programs`：全机（ProgramData）与当前用户（APPDATA）各一处
fn start_menu_dirs() -> Vec<Option<PathBuf>> {
    ["ProgramData", "APPDATA"]
        .into_iter()
        .map(|name| {
            env_dir(name).map(|base| {
                base.join("Microsoft")
                    .join("Windows")
                    .join("Start Menu")
                    .join("Programs")
            })
        })
        .collect()
}

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

    /// 至少覆盖：当前用户桌面、公共桌面、全机开始菜单、当前用户开始菜单
    #[test]
    fn candidates_cover_both_scopes_of_desktop_and_start_menu() {
        let slots = candidates();
        assert!(slots.len() >= 3, "落点太少：{slots:#?}");
        assert!(slots.iter().all(|p| p.ends_with(LINK_NAME)));
        assert!(
            slots.iter().any(|p| p.to_string_lossy().contains("Public")),
            "公共桌面必须在候选里（换账户装过也要清）"
        );
        assert!(
            slots
                .iter()
                .any(|p| p.to_string_lossy().contains("Start Menu")),
            "开始菜单必须在候选里"
        );
    }

    #[test]
    fn candidates_are_unique() {
        let slots = candidates();
        let mut sorted = slots.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), slots.len(), "同一个路径不该出现两次");
    }
}
