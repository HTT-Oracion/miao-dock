//! 本机导入（M3 起点）：把用户选的文件夹复制进番剧库根。
//!
//! ## 为什么是「复制」而不是「移动」
//! 源目录常常是下载器 / BT 客户的完成目录，动它会影响用户另一条链路。
//! 代价是占两份盘 —— 导入后用户可自行删源，界面里说清这件事。
//!
//! ## 为什么只取一层
//! 深目录结构（季度 / 字幕组 / 分辨率嵌套）交给用户自己在库里摆；
//! 我们只保证「选一个文件夹 → 里面的片能出现在集列表里并能播」。
//! 番目录下的扁平文件已由 `manifest::synth` 合成剧集，所以这里复制成扁平结构即可。

use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use super::manifest;

/// 导入时承认的扩展名：视频 + 外挂字幕（字幕要跟着正片走，否则白导）。
const IMPORT_EXTS: &[&str] = &[
    "mp4", "m4v", "webm", "mov", "ogv", "ogg", "m3u8", "mkv", "avi", "flv", "wmv", "rmvb", "rm", "mpg", "mpeg", "m2ts",
    "ts", "ass", "srt", "vtt",
];

/// 把 `src` 目录里的媒体文件复制到 `<root>/<subject>/`。
///
/// `subject` 缺省用源目录名；重名文件跳过（不覆盖用户已导入的版本，也不覆盖正片）。
pub fn import_folder(root: &Path, src: &Path, subject: Option<&str>) -> Result<Value, String> {
    if !src.is_dir() {
        return Err(format!("不是目录：{}", src.display()));
    }
    let raw_name = subject
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            src.file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
    let name = manifest::safe_name(&raw_name).ok_or_else(|| format!("非法的作品名：{raw_name}"))?;
    let dest = root.join(name);
    fs::create_dir_all(&dest).map_err(|e| format!("建作品目录失败：{e}"))?;

    let mut copied: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for e in fs::read_dir(src).map_err(|err| format!("读目录失败：{err}"))?.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !IMPORT_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let file_name = e.file_name().to_string_lossy().into_owned();
        let target = dest.join(&file_name);
        if target.exists() {
            skipped.push(file_name);
            continue;
        }
        fs::copy(&p, &target).map_err(|err| format!("复制 {file_name} 失败：{err}"))?;
        copied.push(file_name);
    }

    Ok(json!({
        "ok": true,
        "subject": name,
        "dir": dest.to_string_lossy(),
        "copied": copied.len(),
        "skipped": skipped,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("anime-import-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn copies_media_and_skips_existing() {
        let root = tmp("root");
        let src = tmp("src");
        fs::write(src.join("01.mp4"), b"a").unwrap();
        fs::write(src.join("02.mkv"), b"b").unwrap();
        fs::write(src.join("01.chs.ass"), b"s").unwrap();
        fs::write(src.join("说明.txt"), b"x").unwrap(); // 非媒体：忽略

        let out = import_folder(&root, &src, None).unwrap();
        let want = src.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(out["subject"].as_str(), Some(want.as_str()));
        assert_eq!(out["copied"], 3);
        assert!(root.join(out["subject"].as_str().unwrap()).join("02.mkv").exists());
        assert!(!root.join(out["subject"].as_str().unwrap()).join("说明.txt").exists());

        // 再来一次：全部跳过，不覆盖
        let again = import_folder(&root, &src, None).unwrap();
        assert_eq!(again["copied"], 0);
        assert_eq!(again["skipped"].as_array().unwrap().len(), 3);

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&src);
    }

    #[test]
    fn honours_explicit_subject_name() {
        let root = tmp("root2");
        let src = tmp("src2");
        fs::write(src.join("01.mp4"), b"a").unwrap();

        let out = import_folder(&root, &src, Some("冰菓")).unwrap();
        assert_eq!(out["subject"], "冰菓");
        assert!(root.join("冰菓").join("01.mp4").exists());

        // 非法名字要拒，不能静默落到别处
        assert!(import_folder(&root, &src, Some("../etc")).is_err());
        // 源不是目录要拒
        assert!(import_folder(&root, &src.join("01.mp4"), None).is_err());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&src);
    }
}
