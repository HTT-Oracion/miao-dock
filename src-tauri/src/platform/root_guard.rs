//! 落盘根目录的安全闸（D-242 从 `mangasvc.rs` 抽出）。
//!
//! ## 为什么单独成一层
//! 漫画与动漫两个服务都要同一套「拒绝系统 / 共享位置」的规则，而
//! `animesvc → mangasvc` 是**错误的横向依赖**（两个域互不认识）。抽到 `platform/`
//! 底座层后两边共用一份实现 —— 规则只有一处，不会因为"改了一边忘了另一边"而分叉。
//!
//! ## 两种匹配语义不能合并成一条前缀判据
//! · **EXACT** —— 只拒「目录本身」。这些是**容器目录**：其下仍可能是合法落点
//!   （`C:\Users` 之下是各用户目录、macOS 的 `/private/var` 之下是 TMPDIR）。
//!   按前缀拒会把合法的 `C:\Users\<me>\Pictures\MiaoDock Mangas` 一并挡掉。
//! · **PREFIX** —— 连子路径一并拒。这些才是真正的系统目录。
//!
//! 🔴 Windows 的系统目录**必须单列**：只写 Unix 名单的话，这道校验在 Windows 上
//!    一条都命中不了，等于形同虚设 —— 用户可以把落盘根指到 `C:\Windows`。
use std::path::{Path, PathBuf};

use crate::platform::paths::{canonicalize, resolve_abs};

/// 落盘根目录校验（契约 §8.2 校验点 1）。
///
/// 顺带把「启动即建目录」也放在这里：校验与建目录是同一件事的两半，
/// 分开放会出现「校验过了但目录没建」的中间态。
pub fn validate_root(root: &str) -> Result<PathBuf, String> {
    // ⚠️ **不**用 `Path::is_absolute()` 做前置判据：Windows 上 `/tmp` 只有根、没有盘符，
    //    Rust 判它「不是绝对路径」而 Node 的 `path.isAbsolute('/tmp')` 判**是**
    //    —— 两边会在同一个输入上给出不同的失败理由（Node 走到黑名单，Rust 走到这里）。
    //    空串按 Node 的口径报「必须是绝对路径」；其余一律交给 `resolve_abs`（等价 `path.resolve`）。
    if root.trim().is_empty() {
        return Err(format!("落盘根目录必须是绝对路径：{root}"));
    }
    let abs = resolve_abs(Path::new(root));
    let canon = canonicalize(&abs);
    if let Some(hit) = blacklist_hit(&canon) {
        return Err(format!("落盘根目录不合法（命中黑名单 {hit}）：{}", abs.display()));
    }
    std::fs::create_dir_all(&abs).map_err(|e| format!("落盘根目录不可用（{}）：{e}", abs.display()))?;
    Ok(canonicalize(&abs))
}

/// 命中返回**名单里那一条原文**（不是规范化后的路径）—— 报给用户的是"撞上了哪一条规则"，
/// 打印一个 `\\?\C:\...` 对他没有任何帮助。
fn blacklist_hit(canon: &Path) -> Option<String> {
    let s = canon.to_string_lossy().into_owned();
    for raw in blacklist_exact() {
        if s == canonicalize(Path::new(&raw)).to_string_lossy() {
            return Some(raw);
        }
    }
    for raw in blacklist_prefix() {
        let cb = canonicalize(Path::new(&raw)).to_string_lossy().into_owned();
        // 与 Node 逐字同构：`canonicalAbs === cb || canonicalAbs.startsWith(cb + sep)`。
        // 🔴 用 `startsWith(cb + sep)` 而**不是** `Path::strip_prefix`：后者按**组件**比，
        //    会把 `C:\` 当成 `C:\Windows` 的前缀而命中；Node 那边 `'C:\\' + '\\'` 永不前缀命中，
        //    根路径只走 EXACT。两者在这一个输入上会分叉。
        let with_sep = format!("{cb}{}", std::path::MAIN_SEPARATOR);
        if s == cb || s.starts_with(&with_sep) {
            return Some(raw);
        }
    }
    None
}

fn blacklist_exact() -> Vec<String> {
    let home = dirs::home_dir().unwrap_or_default();
    let home_s = home.to_string_lossy().into_owned();
    let mut list = vec![
        // `path.parse(path.resolve('/')).root` —— Windows 下即当前盘的 `C:\`
        resolve_abs(Path::new("/")).to_string_lossy().into_owned(),
        "/Users".to_string(),
        home_s.clone(),
        "/private".to_string(),
        "/private/var".to_string(),
        "/var".to_string(),
    ];
    if cfg!(windows) {
        // Windows：home 的父目录（`C:\Users`）本身不可作落盘根 —— 与 macOS 的 `/Users` 同义。
        if let Some(parent) = home.parent() {
            let ps = parent.to_string_lossy().into_owned();
            if !ps.is_empty() && ps != home_s {
                list.push(ps);
            }
        }
    }
    list
}

fn blacklist_prefix() -> Vec<String> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut list = vec![
        "/tmp".to_string(),
        "/private/tmp".to_string(),
        "/private/var/tmp".to_string(),
        "/private/etc".to_string(),
        "/etc".to_string(),
        "/usr".to_string(),
        "/System".to_string(),
        "/Library".to_string(),
        "/Applications".to_string(),
        "/Volumes".to_string(),
        "/cores".to_string(),
        "/opt".to_string(),
        home.join("Library").to_string_lossy().into_owned(),
    ];
    if cfg!(windows) {
        let sys_root = std::env::var("SystemDrive").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "C:".to_string());
        let sys_root = format!("{sys_root}\\");
        let join = |base: &str, leaf: &str| Path::new(base).join(leaf).to_string_lossy().into_owned();
        list.push(join(&sys_root, "Windows"));
        list.push(
            std::env::var("ProgramFiles")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| join(&sys_root, "Program Files")),
        );
        list.push(
            std::env::var("ProgramFiles(x86)")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| join(&sys_root, "Program Files (x86)")),
        );
        list.push(
            std::env::var("ProgramData")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| join(&sys_root, "ProgramData")),
        );
    }
    list
}
