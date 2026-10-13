// 漫画名规范化（契约 §6.1）—— 移植 `service/src/manga/names.mjs`。
//
// 服务端是**唯一权威**（客户端只做预校验），所以本模块的每一步都必须与 Node 逐字对齐：
// NFKC → 剥控制符 → 剥路径分隔符 → 剥 Windows 非法字符 → 折叠空白 → 去首尾 → 长度 →
// 保留名 → 空名。任何一步的顺序或集合错了，`resolve*Dir` 就会把"合法名"判成非法（或反之），
// 而两种错都表现为"这个名字用不了" —— 难归因。
//
// 🔴 `is_safe_dir_name` 的**唯一一份**在 `store::pure`（F3-a 已落地）—— 本模块只补规范化，
//    绝不重抄一份（重抄就是 D-147 说的「这里校验、那里没校验」）。
use unicode_normalization::UnicodeNormalization;

use crate::boxsvc::store::StoreError;

/// 漫画名长度上限（Unicode **字符**数，非字节）—— 契约 §6.1 步 7。
pub const MAX_NAME_CHARS: usize = 64;

/// 标题长度上限（显示文字，比目录名宽）。
pub const MAX_TITLE_CHARS: usize = 200;
/// 作者长度上限。
pub const MAX_AUTHOR_CHARS: usize = 100;

/// 保留名清单（含 COM0 / LPT0）—— 比对**不区分大小写**，忽略扩展名。
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
    "COM8", "COM9", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// JS `typeof` 对 JSON 值的取值（错误 details 里要用同一口径）。
pub fn js_typeof(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "object", // JS 的 typeof null === 'object'
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => "object",
    }
}

/// JS `\s`（含 \u00a0 / \u3000 / \ufeff 等）。
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

fn fail(code: &str, message: impl Into<String>, details: serde_json::Value) -> StoreError {
    StoreError::new(code, message, details)
}

/// 复刻 `normalizeComicName`：成功返回规范化后的名字；失败返回带 code/message/details 的错误。
pub fn normalize_comic_name(raw: &serde_json::Value) -> Result<String, StoreError> {
    // 缺失 / 非字符串
    if raw.is_null() {
        return Err(fail("COMIC_NAME_REQUIRED", "comicName 缺失", serde_json::json!({ "field": "comicName" })));
    }
    let Some(input) = raw.as_str() else {
        return Err(fail(
            "INVALID_COMIC_NAME",
            "comicName 必须是字符串",
            serde_json::json!({ "type": js_typeof(raw) }),
        ));
    };

    // 步 0：拒绝 U+0000
    if input.contains('\u{0000}') {
        return Err(fail("INVALID_COMIC_NAME", "漫画名包含非法控制字符 U+0000", serde_json::json!({ "char": "U+0000" })));
    }

    // 步 1：NFKC
    let mapped: String = input.nfkc().collect();
    // 步 2：剥控制字符 `[\u0000-\u001f\u007f]`
    let s: String = mapped
        .chars()
        .filter(|c| !matches!(c, '\u{0000}'..='\u{001f}' | '\u{007f}'))
        .collect();
    // 步 3：剥路径分隔符与父目录语义 `[/\\:]`
    let s: String = s.chars().filter(|c| !matches!(c, '/' | '\\' | ':')).collect();
    // 步 4：剥 Windows 非法字符 `[<>"|?*]`
    let s: String = s.chars().filter(|c| !matches!(c, '<' | '>' | '"' | '|' | '?' | '*')).collect();
    // 步 5：折叠连续空白为单个半角空格
    let mut collapsed = String::with_capacity(s.len());
    let mut prev_space = false;
    for c in s.chars() {
        if is_js_space(c) {
            if !prev_space {
                collapsed.push(' ');
            }
            prev_space = true;
        } else {
            collapsed.push(c);
            prev_space = false;
        }
    }
    // 步 6：去首尾空白（`^ +` 与 `[. ]+$` —— 此时空白已全被折成半角空格）
    let s = collapsed.trim_start_matches(' ').trim_end_matches(|c| c == '.' || c == ' ').to_string();

    // 步 7：长度检查（Unicode 字符数）
    let char_count = s.chars().count();
    if char_count > MAX_NAME_CHARS {
        return Err(fail(
            "INVALID_COMIC_NAME",
            format!("漫画名超过 {MAX_NAME_CHARS} 个字符（当前 {char_count}）"),
            serde_json::json!({ "limit": MAX_NAME_CHARS, "length": char_count }),
        ));
    }
    // 步 8：保留名检查（忽略扩展名，不区分大小写）
    let base = s.split('.').next().unwrap_or("").to_uppercase();
    if RESERVED.contains(&base.as_str()) {
        return Err(fail(
            "INVALID_COMIC_NAME",
            format!("「{s}」是系统保留名，不能用作漫画名"),
            serde_json::json!({ "reserved": base }),
        ));
    }
    // 步 9：空名检查
    if s.is_empty() {
        return Err(fail("COMIC_NAME_REQUIRED", "漫画名规范化后为空", serde_json::json!({ "input": input })));
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_and_strips() {
        assert_eq!(normalize_comic_name(&json!("  a/b:c*  ")).unwrap(), "abc");
        assert_eq!(normalize_comic_name(&json!("全角ＡＢ")).unwrap(), "全角AB");
        assert_eq!(normalize_comic_name(&json!("x   y")).unwrap(), "x y");
        assert_eq!(normalize_comic_name(&json!("trailing...")).unwrap(), "trailing");
    }

    #[test]
    fn rejects_reserved_and_empty_and_long() {
        assert_eq!(normalize_comic_name(&json!("CON")).unwrap_err().code, "INVALID_COMIC_NAME");
        assert_eq!(normalize_comic_name(&json!("con.png")).unwrap_err().code, "INVALID_COMIC_NAME");
        assert_eq!(normalize_comic_name(&json!("   ")).unwrap_err().code, "COMIC_NAME_REQUIRED");
        assert_eq!(normalize_comic_name(&json!(null)).unwrap_err().code, "COMIC_NAME_REQUIRED");
        assert_eq!(normalize_comic_name(&json!(123)).unwrap_err().code, "INVALID_COMIC_NAME");
        assert_eq!(normalize_comic_name(&json!("a".repeat(65))).unwrap_err().code, "INVALID_COMIC_NAME");
        assert_eq!(normalize_comic_name(&json!("a".repeat(64))).unwrap(), "a".repeat(64));
    }

    #[test]
    fn nul_char_is_rejected() {
        assert_eq!(normalize_comic_name(&json!("a\u{0000}b")).unwrap_err().code, "INVALID_COMIC_NAME");
    }
}
