//! 载荷清单 —— `payload.zip` 根部的 `manifest.json`。
//!
//! 这份清单是「装什么、装到哪」的唯一事实源：安装器按它落盘、按它写卸载项，
//! 所以列进清单的每条路径都必须过 [`safe_relative`]。
//!
//! 🔴 **防 zip-slip 的唯一闸门就在这里**：zip 里一条 `..\..\x` 或 `C:\x`
//! 足以把文件写到安装目录之外，而落盘时用的是管理员权限。读取阶段一律拒绝，
//! 不做「先写再纠正」—— 纠正不了。

use serde::Deserialize;
use std::path::{Component, Path, PathBuf};

/// 唯一受支持的清单格式版本
pub const SCHEMA: u32 = 1;

/// 清单结构（字段名与 `scripts/pack-install-payload.mjs` 写出的 JSON 一一对应）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: u32,
    /// 产品版本（写进注册表 `DisplayVersion`，界面上的 `INSTALL.version` 也取它）
    pub version: String,
    /// 主程序在载荷内的相对路径，如 `app/miao-dock.exe`
    pub app_exe: String,
    /// 主程序资源在载荷内的相对路径（目录或文件）
    #[serde(default)]
    pub app_resources: Vec<String>,
    /// 卸载器在载荷内的相对路径，如 `app/MiaoDock-Uninstaller.exe`
    pub uninstaller_exe: String,
    /// 发行方（写进注册表 `Publisher`）
    pub publisher: String,
}

impl Manifest {
    /// 解析并校验；任何一处不合法都整份拒绝（宁可装不了，也不装错）
    pub fn parse(json: &str) -> Result<Self, String> {
        let manifest: Self =
            serde_json::from_str(json).map_err(|e| format!("载荷清单解析失败：{e}"))?;
        manifest.validate()?;
        Ok(manifest)
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema != SCHEMA {
            return Err(format!(
                "载荷清单版本不受支持（schema={}，本程序只认 {SCHEMA}）",
                self.schema
            ));
        }
        if self.version.trim().is_empty() {
            return Err("载荷清单缺少版本号".to_string());
        }
        if self.publisher.trim().is_empty() {
            return Err("载荷清单缺少发行方".to_string());
        }
        for path in [&self.app_exe, &self.uninstaller_exe] {
            let rel = safe_relative(path)?;
            if !has_exe_extension(&rel) {
                return Err(format!("载荷清单里的可执行文件不是 .exe：{path}"));
            }
        }
        for resource in &self.app_resources {
            safe_relative(resource)?;
        }
        Ok(())
    }

    /// 主程序在安装目录里的绝对路径
    pub fn app_exe_path(&self, install_dir: &Path) -> Option<PathBuf> {
        safe_relative(&self.app_exe).ok().map(|rel| install_dir.join(rel))
    }

    /// 卸载器在安装目录里的绝对路径
    pub fn uninstaller_path(&self, install_dir: &Path) -> Option<PathBuf> {
        safe_relative(&self.uninstaller_exe)
            .ok()
            .map(|rel| install_dir.join(rel))
    }
}

/// 把清单 / zip 里的相对路径变成可安全落盘的路径。
///
/// 拒绝：空串、绝对路径、盘符前缀、`..` 上跳、根组件、`.` 这类自指组件。
/// 放行：用 `/` 或 `\` 分隔的普通相对路径（两种分隔符在 Windows 上等价）。
pub fn safe_relative(raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("载荷内路径为空".to_string());
    }
    if raw.contains('\0') {
        return Err(format!("载荷内路径含非法字符：{raw}"));
    }
    let normalized = raw.replace('\\', "/");
    let candidate = Path::new(&normalized);
    if candidate.is_absolute() {
        return Err(format!("载荷内路径不许是绝对路径：{raw}"));
    }
    let mut out = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => out.push(part),
            _ => return Err(format!("载荷内路径不许含上跳 / 盘符 / 根：{raw}")),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(format!("载荷内路径为空：{raw}"));
    }
    Ok(out)
}

fn has_exe_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> String {
        r#"{
            "schema": 1,
            "version": "2.2.1",
            "appExe": "miao-dock.exe",
            "appResources": ["engine/models.manifest.json", "engine/runtime.manifest.json"],
            "uninstallerExe": "MiaoDock-Uninstaller.exe",
            "publisher": "喵坞"
        }"#
        .to_string()
    }

    /// 载荷布局 = 安装目录布局：主程序与资源**同层**，不许再套 `app/`
    #[test]
    fn parses_the_shape_we_ship() {
        let m = Manifest::parse(&sample()).expect("示例清单必须能解析");
        assert_eq!(m.version, "2.2.1");
        assert_eq!(m.app_resources.len(), 2);
        assert_eq!(
            m.app_exe_path(Path::new("C:\\Program Files\\MiaoDock")),
            Some(PathBuf::from("C:\\Program Files\\MiaoDock\\miao-dock.exe"))
        );
        assert_eq!(
            m.uninstaller_path(Path::new("C:\\Program Files\\MiaoDock")),
            Some(PathBuf::from(
                "C:\\Program Files\\MiaoDock\\MiaoDock-Uninstaller.exe"
            ))
        );
        // 卸载器与主程序必须同层：卸载器把自己所在目录当安装目录
        let app = m.app_exe_path(Path::new("D:\\MiaoDock")).unwrap();
        let uninstaller = m.uninstaller_path(Path::new("D:\\MiaoDock")).unwrap();
        assert_eq!(app.parent(), uninstaller.parent());
    }

    /// 缺字段 / 版本不对 / 可执行文件不是 exe —— 三种都得整份拒绝
    #[test]
    fn rejects_incomplete_or_mismatched_manifests() {
        let missing = r#"{ "schema": 1, "version": "2.2.1", "appExe": "app/x.exe" }"#;
        assert!(Manifest::parse(missing).is_err(), "缺字段必须拒绝");

        let wrong_schema = sample().replace("\"schema\": 1", "\"schema\": 99");
        assert!(Manifest::parse(&wrong_schema).is_err(), "未知版本必须拒绝");

        let wrong_ext = sample().replace("MiaoDock-Uninstaller.exe", "uninstaller.dll");
        assert!(Manifest::parse(&wrong_ext).is_err(), "非 .exe 必须拒绝");
    }

    /// zip-slip 的原文攻击面：上跳、绝对路径、盘符。一个都不许过。
    #[test]
    fn rejects_traversal_and_absolute_paths() {
        for bad in [
            "../evil.exe",
            "app/../../evil.exe",
            "..\\..\\evil.exe",
            "C:/Windows/evil.exe",
            "C:\\Windows\\evil.exe",
            "\\\\server\\share\\evil.exe",
            "",
            "   ",
            "./app/../x.exe",
        ] {
            assert!(safe_relative(bad).is_err(), "必须拒绝：{bad:?}");
        }
    }

    /// 反向：正常形态必须放行（只测拒绝会让「永远拒绝」也算通过）
    #[test]
    fn accepts_plain_relative_paths() {
        assert_eq!(
            safe_relative("app\\engine\\a.txt"),
            Ok(PathBuf::from("app/engine/a.txt"))
        );
        assert_eq!(safe_relative("app"), Ok(PathBuf::from("app")));
        assert_eq!(
            safe_relative("app/a/b/c/d/e.dll"),
            Ok(PathBuf::from("app/a/b/c/d/e.dll"))
        );
    }
}
