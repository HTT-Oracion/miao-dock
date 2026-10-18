//! 卸载项注册表 —— 这里只负责**删**（写是安装器的活）。
//!
//! 🔴 一律显式 `KEY_WOW64_64KEY`：`HKCU\Software` 会被 32 位视图重定向到 `WOW6432Node`，
//!    不加这个标志就会「删了但列表里还在」（安装器写的那份在 64 位视图里）。
//! 🔴 两个 hive 都查：同一台机器上可能先装成「仅为我」、又装成「为所有用户」，
//!    留着哪一份都会让控制面板多出一行幽灵条目。

/// 卸载项子键名（与安装目录末段同名）
pub const SUBKEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MiaoDock";

/// 安装范围 —— 卸载时要据此判断「要不要管理员」
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Machine,
    User,
}

impl Scope {
    pub fn label(self) -> &'static str {
        match self {
            Self::Machine => "为所有用户",
            Self::User => "仅为我",
        }
    }
}

/// 两个 hive 都要看的顺序：全机在前（真要删全机那条时，权限问题要最先暴露）
pub const SCOPES: [Scope; 2] = [Scope::Machine, Scope::User];

pub use platform::{can_write_machine, delete, find_scope};

#[cfg(windows)]
mod platform {
    use super::{Scope, SCOPES, SUBKEY};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteTreeW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
        KEY_READ, KEY_WOW64_64KEY,
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

    /// 该项是否在该 hive 下存在
    pub fn exists(scope: Scope) -> bool {
        let sub = wide(SUBKEY);
        let mut key: HKEY = std::ptr::null_mut();
        let code = unsafe {
            RegOpenKeyExW(
                hive(scope),
                sub.as_ptr(),
                0,
                KEY_READ | KEY_WOW64_64KEY,
                &mut key,
            )
        };
        if code != 0 {
            return false;
        }
        unsafe { RegCloseKey(key) };
        true
    }

    /// 先 HKLM 再 HKCU
    pub fn find_scope() -> Option<Scope> {
        SCOPES.into_iter().find(|scope| exists(*scope))
    }

    /// 删掉两个 hive 下的该项；返回删了几处
    pub fn delete() -> Result<usize, String> {
        let mut removed = 0usize;
        for scope in SCOPES {
            if !exists(scope) {
                continue;
            }
            let sub = wide(SUBKEY);
            let code = unsafe { RegDeleteTreeW(hive(scope), sub.as_ptr()) };
            if code != 0 {
                return Err(format!(
                    "删不掉卸载项注册表键（{}，错误码 {code}）—— 需要管理员权限",
                    scope.label()
                ));
            }
            removed += 1;
        }
        Ok(removed)
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
                windows_sys::Win32::System::Registry::KEY_WRITE | KEY_WOW64_64KEY,
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
    use super::Scope;

    pub fn exists(_scope: Scope) -> bool {
        false
    }

    pub fn find_scope() -> Option<Scope> {
        None
    }

    pub fn delete() -> Result<usize, String> {
        Ok(0)
    }

    pub fn can_write_machine() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 子键名与安装目录末段同名（全仓一个口径）
    #[test]
    fn subkey_matches_the_install_folder_name() {
        assert!(SUBKEY.ends_with("\\Uninstall\\MiaoDock"));
    }

    /// 两个 hive 都要试 —— 少一个就会留幽灵条目
    #[test]
    fn both_hives_are_covered() {
        assert_eq!(SCOPES.len(), 2);
        assert_eq!(SCOPES[0], Scope::Machine);
        assert_eq!(SCOPES[1], Scope::User);
    }
}
