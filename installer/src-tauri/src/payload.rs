//! 内嵌载荷 —— 编译期把 `payload/payload.zip` 嵌进 exe，运行时解包到目标目录。
//!
//! 载荷是**构建期产物**（`scripts/pack-install-payload.mjs` 生成），不入库；
//! `build.rs` 只在缺失时补一个占位文件让编译能过。占位不是合法 zip，
//! 于是 [`Payload::open`] 会明确报「载荷未打包」，而不是静默装出半个程序。
//!
//! 🔴 **落盘顺序**：先解到同级的 `<目标>.miaoinstall`，全部写完才改名成目标目录。
//! 中途失败只留一个可删的临时目录，不会让用户面对「装了一半」的现场。
//! 目标已存在（重装 / 升级）时先把它挪到 `<目标>.miaoold`，改名失败再挪回来。

use crate::manifest::{safe_relative, Manifest};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

/// 编译进 exe 的载荷本体。路径相对本文件（`src/payload.rs`）⇒ `src-tauri/payload/payload.zip`
const PAYLOAD_ZIP: &[u8] = include_bytes!("../payload/payload.zip");

/// 清单在 zip 内的固定名字
const MANIFEST_NAME: &str = "manifest.json";

/// 解包后的临时目录后缀（同级、同卷 ⇒ 改名是原子的）
const STAGE_SUFFIX: &str = ".miaoinstall";
/// 被替换下来的旧目录后缀（改名成功后再删）
const OLD_SUFFIX: &str = ".miaoold";

pub struct Payload {
    manifest: Manifest,
}

impl Payload {
    /// 读内嵌载荷的清单。安装动作之前先过这一步，坏载荷在写任何文件前就被挡住。
    pub fn open() -> Result<Self, String> {
        let mut zip = zip::ZipArchive::new(Cursor::new(PAYLOAD_ZIP)).map_err(|e| {
            format!("内嵌载荷不是合法的 zip（是否忘了 npm run task -- install:pack？）：{e}")
        })?;
        let mut text = String::new();
        zip.by_name(MANIFEST_NAME)
            .map_err(|_| format!("内嵌载荷里没有 {MANIFEST_NAME}"))?
            .read_to_string(&mut text)
            .map_err(|e| format!("读不出载荷清单：{e}"))?;
        Ok(Self {
            manifest: Manifest::parse(&text)?,
        })
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    /// 载荷压缩后的体积 —— 界面「程序体积」的数据源（探测阶段不展开载荷，开销为零）
    pub fn packed_len() -> u64 {
        PAYLOAD_ZIP.len() as u64
    }

    /// 解包到 `target`，返回落盘字节数
    pub fn install(&self, target: &Path) -> Result<u64, String> {
        let stage = sibling(target, STAGE_SUFFIX)?;
        let old = sibling(target, OLD_SUFFIX)?;

        // 上一轮中断可能留下临时目录：清掉再开工（清不掉就让解包自己报错，不静默继续）
        remove_dir_if_exists(&stage)?;
        fs::create_dir_all(&stage).map_err(|e| format!("建不了临时目录（{}）：{e}", stage.display()))?;

        let written = match extract_into(&stage) {
            Ok(bytes) => bytes,
            Err(error) => {
                let _ = remove_dir_if_exists(&stage);
                return Err(error);
            }
        };

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("建不了目标目录的上级（{}）：{e}", parent.display()))?;
        }

        // 目标已存在：先挪开，改名失败要能挪回来 —— 否则用户会同时丢程序和留垃圾
        let replaced = rotate_aside(target, &old)?;
        if let Err(error) = fs::rename(&stage, target) {
            if replaced {
                let _ = fs::rename(&old, target);
            }
            let _ = remove_dir_if_exists(&stage);
            return Err(format!("落盘失败（{}）：{error}", target.display()));
        }
        if replaced {
            // 旧版本目录删不掉不算安装失败（可能被占用），但下一轮装前会再清
            let _ = remove_dir_if_exists(&old);
        }
        Ok(written)
    }
}

/// 把 `target` 挪到 `old`；返回是否真的挪过
fn rotate_aside(target: &Path, old: &Path) -> Result<bool, String> {
    if !target.exists() {
        return Ok(false);
    }
    remove_dir_if_exists(old)?;
    fs::rename(target, old).map_err(|e| {
        format!(
            "旧版本目录挪不开（{}）：{e} —— 请先退出正在运行的喵坞",
            target.display()
        )
    })?;
    Ok(true)
}

fn extract_into(stage: &Path) -> Result<u64, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(PAYLOAD_ZIP))
        .map_err(|e| format!("内嵌载荷不是合法的 zip：{e}"))?;
    let mut written: u64 = 0;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|e| format!("读不出载荷第 {index} 项：{e}"))?;
        // 目录项不落盘：文件写入时按需建上级，空目录也没有要保留的语义
        if entry.is_dir() {
            continue;
        }
        // 清单是给安装器读的，不是要装进用户目录的文件
        if entry.name() == MANIFEST_NAME {
            continue;
        }
        let relative = safe_relative(entry.name())?;
        let dest = stage.join(&relative);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(verbatim(parent))
                .map_err(|e| format!("建不了目录（{}）：{e}", parent.display()))?;
        }
        let mut file = fs::File::create(verbatim(&dest))
            .map_err(|e| format!("写不了文件（{}）：{e}", dest.display()))?;
        written += std::io::copy(&mut entry, &mut file)
            .map_err(|e| format!("解包失败（{}）：{e}", dest.display()))?;
    }
    Ok(written)
}

/// 同级兄弟路径（`C:\a\b` + `.tmp` ⇒ `C:\a\b.tmp`）
fn sibling(target: &Path, suffix: &str) -> Result<PathBuf, String> {
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("安装目录不合法：{}", target.display()))?;
    Ok(target.with_file_name(format!("{name}{suffix}")))
}

fn remove_dir_if_exists(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    fs::remove_dir_all(verbatim(dir)).map_err(|e| format!("清不掉目录（{}）：{e}", dir.display()))
}

/// Windows 长路径：资源树很容易越过 260（引擎 / 模型目录），加 `\\?\` 前缀并统一反斜杠
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

    #[test]
    fn sibling_keeps_the_parent_and_appends_suffix() {
        let stage = sibling(Path::new("C:\\Program Files\\MiaoDock"), STAGE_SUFFIX).unwrap();
        assert_eq!(stage, PathBuf::from("C:\\Program Files\\MiaoDock.miaoinstall"));
        let old = sibling(Path::new("C:\\Program Files\\MiaoDock"), OLD_SUFFIX).unwrap();
        assert_eq!(old, PathBuf::from("C:\\Program Files\\MiaoDock.miaoold"));
    }

    /// 临时目录必须是目标的**同级兄弟**：跨盘改名不是原子操作，落到别处就等于没有回滚
    #[test]
    fn stage_sits_next_to_the_target() {
        let target = Path::new("D:\\Apps\\喵坞");
        let stage = sibling(target, STAGE_SUFFIX).unwrap();
        assert_eq!(stage.parent(), target.parent());
    }

    #[test]
    fn sibling_rejects_root_paths() {
        assert!(sibling(Path::new("C:\\"), STAGE_SUFFIX).is_err());
    }
}
