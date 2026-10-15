// store 的**纯逻辑**：不碰文件系统、不碰网络，输入相同则输出逐字节相同（F3）
//
// 搬自 `service/src/manga/store.mjs` 的「纯函数」小节与 `manga/names.mjs` / `image.mjs` 的
// 对应部分。这些函数是 F3 对照钉子最容易咬住的部分 —— 没有 IO 与时钟，可以逐条比对。
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;

// ------------------------------------------------------------------ 文件名 / 目录扫描正则（契约 §8.2 / §7.4）

fn re_original() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^(\d{3})\.(png|jpg|jpeg|webp)$").unwrap())
}
fn re_translated() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^(\d{3})_translated\.(png|jpg|jpeg|webp)$").unwrap())
}
fn re_file_name() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^\d{3}(_translated)?\.(png|jpg|jpeg|webp)$").unwrap())
}

/// 目录内用于续编号扫描的正则（契约 §7.4）—— 命中返回 seq。
pub fn match_original(name: &str) -> Option<i64> {
    re_original().captures(name).and_then(|c| c.get(1)).and_then(|m| m.as_str().parse().ok())
}

/// 译文扫描正则 —— 命中返回 seq。
pub fn match_translated(name: &str) -> Option<i64> {
    re_translated().captures(name).and_then(|c| c.get(1)).and_then(|m| m.as_str().parse().ok())
}

/// 服务端生成的文件名是否合法（契约 §8.2 校验点 2）。
pub fn is_valid_file_name(name: &str) -> bool {
    re_file_name().is_match(name)
}

// ------------------------------------------------------------------ 图片嗅探（绝不信任客户端 filename）

/// 只看字节头嗅探图片类型（复刻 `sniffImageType`）：`png` / `jpg` / `webp`。
pub fn sniff_image_type(buf: &[u8]) -> Option<&'static str> {
    if buf.is_empty() {
        return None;
    }
    if buf.len() >= 8
        && buf[0] == 0x89
        && buf[1] == 0x50
        && buf[2] == 0x4e
        && buf[3] == 0x47
        && buf[4] == 0x0d
        && buf[5] == 0x0a
        && buf[6] == 0x1a
        && buf[7] == 0x0a
    {
        return Some("png");
    }
    if buf.len() >= 3 && buf[0] == 0xff && buf[1] == 0xd8 && buf[2] == 0xff {
        return Some("jpg");
    }
    if buf.len() >= 12 && &buf[0..4] == b"RIFF" && &buf[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

/// 二次断言：目录名不得含「路径成分」（契约 §8.2 校验点 2）。
///
/// 语义是**防路径穿越**，按路径成分判定而非子串匹配 —— `a..b` 没有分隔符、无法穿越，必须放行。
pub fn is_safe_dir_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    if name.contains('\u{0}') || name.contains('/') || name.contains('\\') {
        return false;
    }
    name.split(['/', '\\']).all(|c| c != "." && c != "..")
}

// ------------------------------------------------------------------ 纯排序 / 汇总

/// `String(value)` 的语义（JS）：数字/字符串/布尔/null。用于把 `imageOrder` 的键归一成字符串。
fn js_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// `imageOrder[]` 显式顺序兜底（复刻 `orderImages`）：返回**下标顺序**。
/// 支持「原始 filename」或「1 起序号」两种写法；未命中/重复键跳过；剩下的按原序补尾。
pub fn order_images_indices(
    filenames: &[Option<String>],
    image_order: &[serde_json::Value],
) -> Vec<usize> {
    let n = filenames.len();
    if image_order.is_empty() {
        return (0..n).collect();
    }
    let mut by_name: HashMap<String, usize> = HashMap::new();
    for (i, fname) in filenames.iter().enumerate() {
        if let Some(f) = fname {
            by_name.entry(f.clone()).or_insert(i);
        }
        by_name.entry((i + 1).to_string()).or_insert(i);
    }
    let mut picked: HashSet<usize> = HashSet::new();
    let mut out = Vec::new();
    for key in image_order {
        let k = js_string(key).trim().to_string();
        if let Some(&idx) = by_name.get(&k) {
            if picked.insert(idx) {
                out.push(idx);
            }
        }
    }
    for i in 0..n {
        if !picked.contains(&i) {
            out.push(i);
        }
    }
    out
}

/// 终态判定（复刻 `endStatusOf`）：**只看 item 状态**，与任务状态无关。
pub fn end_status_of<'a>(statuses: impl Iterator<Item = &'a str>) -> &'static str {
    let mut success = 0usize;
    let mut failed = 0usize;
    for s in statuses {
        if s == "success" || s == "skipped" {
            success += 1;
        } else if s == "failed" {
            failed += 1;
        }
    }
    if failed == 0 {
        "done"
    } else if success > 0 {
        "partial_failed"
    } else {
        "failed"
    }
}

/// 批次状态（复刻 `batchStatusOf`）。取任务状态 + 该批 items（用其 `status` 与 `reason`）。
pub fn batch_status_of(task_status: &str, items: &[crate::mangasvc::store::model::Item]) -> &'static str {
    let canceled_hit = task_status == "canceled"
        && items.iter().any(|i| i.status == "skipped" && i.reason.as_deref() == Some("canceled"));
    if canceled_hit {
        return "canceled";
    }
    if items.iter().all(|i| i.status == "pending") {
        return "queued";
    }
    if items.iter().any(|i| i.status == "pending" || i.status == "translating") {
        return "running";
    }
    let ok = items.iter().filter(|i| i.status == "success" || i.status == "skipped").count();
    let bad = items.iter().filter(|i| i.status == "failed").count();
    if bad == 0 {
        "done"
    } else if ok == 0 {
        "failed"
    } else {
        "partial_failed"
    }
}

/// eta 文案（复刻 `formatEtaText`）。注意是 **en 破折号 U+2013**，不是连字符。
pub fn format_eta_text(min_seconds: i64, max_seconds: i64) -> String {
    if max_seconds < 60 {
        return format!("预计 {min_seconds}\u{2013}{max_seconds} 秒");
    }
    let m1 = std::cmp::max(1, min_seconds.div_euclid(60));
    let m2 = std::cmp::max(m1 + 1, (max_seconds + 59).div_euclid(60));
    format!("预计 {m1}\u{2013}{m2} 分钟")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mangasvc::store::model::Item;

    fn mk_item(seq: i64, status: &str, reason: Option<&str>) -> Item {
        Item {
            seq,
            ext: "png".into(),
            mime: "image/png".into(),
            byte_size: 1,
            from_disk: false,
            overwrite: false,
            status: status.into(),
            saved: false,
            original_file: None,
            output_file: None,
            sha256: None,
            duration_ms: None,
            retry_count: 0,
            reason: reason.map(|r| r.to_string()),
            error_message: None,
        }
    }

    #[test]
    fn sniff_matches_known_magics() {
        assert_eq!(sniff_image_type(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Some("png"));
        assert_eq!(sniff_image_type(&[0xff, 0xd8, 0xff, 0xe0]), Some("jpg"));
        let mut webp = b"RIFF\0\0\0\0WEBP".to_vec();
        webp.resize(12, 0);
        assert_eq!(sniff_image_type(&webp), Some("webp"));
        assert_eq!(sniff_image_type(b"GIF89a"), None);
        assert_eq!(sniff_image_type(&[]), None);
    }

    #[test]
    fn safe_dir_name_rejects_path_components() {
        assert!(is_safe_dir_name("夏日重现"));
        assert!(is_safe_dir_name("a..b")); // 无分隔符 ⇒ 合法
        assert!(!is_safe_dir_name("a/b"));
        assert!(!is_safe_dir_name(".."));
        assert!(!is_safe_dir_name(""));
        assert!(!is_safe_dir_name("a\0b"));
    }

    #[test]
    fn end_status_three_way() {
        assert_eq!(end_status_of(["success"].into_iter()), "done");
        assert_eq!(end_status_of(["success", "skipped"].into_iter()), "done");
        assert_eq!(end_status_of(["success", "failed"].into_iter()), "partial_failed");
        assert_eq!(end_status_of(["failed", "failed"].into_iter()), "failed");
    }

    #[test]
    fn order_images_falls_back_and_dedupes() {
        let names: Vec<Option<String>> =
            vec![Some("a.png".into()), Some("b.png".into()), Some("c.png".into())];
        // 显式顺序：按 filename
        assert_eq!(
            order_images_indices(&names, &[serde_json::json!("c.png"), serde_json::json!("a.png")]),
            vec![2, 0, 1]
        );
        // 按 1 起序号；重复键跳过；未列出的补尾
        assert_eq!(
            order_images_indices(&names, &[serde_json::json!(2), serde_json::json!(2)]),
            vec![1, 0, 2]
        );
        // 空 order ⇒ 原序
        assert_eq!(order_images_indices(&names, &[]), vec![0, 1, 2]);
    }

    #[test]
    fn batch_status_covers_all_branches() {
        assert_eq!(batch_status_of("running", &[mk_item(1, "pending", None)]), "queued");
        assert_eq!(
            batch_status_of("running", &[mk_item(1, "success", None), mk_item(2, "pending", None)]),
            "running"
        );
        assert_eq!(
            batch_status_of("running", &[mk_item(1, "success", None), mk_item(2, "success", None)]),
            "done"
        );
        assert_eq!(
            batch_status_of("running", &[mk_item(1, "failed", None), mk_item(2, "failed", None)]),
            "failed"
        );
        assert_eq!(
            batch_status_of("running", &[mk_item(1, "success", None), mk_item(2, "failed", None)]),
            "partial_failed"
        );
        // 取消：任务 canceled 且批内有 skipped(canceled) ⇒ canceled
        assert_eq!(
            batch_status_of("canceled", &[mk_item(1, "skipped", Some("canceled"))]),
            "canceled"
        );
        // 空批 ⇒ every(pending)=true ⇒ queued
        assert_eq!(batch_status_of("running", &[]), "queued");
    }

    #[test]
    fn eta_text_seconds_and_minutes() {
        assert_eq!(format_eta_text(10, 30), "预计 10\u{2013}30 秒");
        assert_eq!(format_eta_text(60, 180), "预计 1\u{2013}3 分钟");
        assert_eq!(format_eta_text(1, 59), "预计 1\u{2013}59 秒");
    }
}
