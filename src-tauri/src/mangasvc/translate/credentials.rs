// 翻译平台**密钥**层（`state/translate-credentials.json`，权限 0600）
// =============================================================================
// 依据：在线翻译服务设计方案 §8.3（密钥隔离）· §6.3（`POST /translate/credentials` 只写不读）。
// 移植自 `service/src/manga/translate/credentials.mjs`。
//
// 三条硬纪律：
//   ① **独立文件**（不与 translate-settings.json 合并）：密钥没有理由进那个读路径。
//   ② **只写不读回显**：HTTP 面只回 `{ appKey, hasSecret }`，`credentials_view` 永不吐 secret。
//   ③ 诊断脱敏：任何要落日志的 secret 一律 `mask_secret()`。
use std::path::Path;

use serde_json::{json, Map, Value};

use super::errors::TranslateError;
use super::refute;
use super::settings::atomic_write_json;

/// appSecret 长度上限（有道侧限制）
const APP_SECRET_MAX: usize = 128;

/// 读密钥文件：`(platforms, exists, corrupt, reason)`。
///
/// 文件不存在 = **正常的首次启动**（不是错误）。
/// 🔴 本函数**会**带回 appSecret（签名要用它）—— 「只写不读」约束的是**对外回显**面。
pub fn read_credentials(file: &Path) -> (Map<String, Value>, bool, bool, Option<String>) {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                return (Map::new(), false, false, None);
            }
            return (Map::new(), true, true, Some(format!("{}: {}", io_code(&e), e)));
        }
    };
    let raw: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => return (Map::new(), true, true, Some(format!("JSON 解析失败：{e}"))),
    };
    let ok = raw.is_object()
        && raw.get("platforms").map(|p| p.is_object()).unwrap_or(false);
    if !ok {
        return (Map::new(), true, true, Some("顶层应为 { platforms: {...} } 形状".to_string()));
    }
    let platforms = raw.get("platforms").and_then(|p| p.as_object()).cloned().unwrap_or_default();
    (platforms, true, false, None)
}

/// 取某平台的明文密钥（签名用）—— **内部路径**，绝不出现在响应里。
pub fn plain_of(file: &Path, platform: &str) -> (String, String) {
    let (platforms, _, _, _) = read_credentials(file);
    let entry = platforms.get(platform).and_then(|v| v.as_object());
    let app_key = entry
        .and_then(|e| e.get("appKey"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let app_secret = entry
        .and_then(|e| e.get("appSecret"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    (app_key, app_secret)
}

/// 写（合并）一个平台的密钥。原子写 0600。返回 `(platform, 脱敏后的全量视图)`。
pub fn write_credentials(
    file: &Path,
    platform: &Value,
    app_key: &Value,
    app_secret: &Value,
) -> Result<(String, Map<String, Value>), TranslateError> {
    let p = platform.as_str().unwrap_or("").trim().to_string();
    if p.is_empty() {
        return Err(TranslateError::new(
            "TRANSLATE_INVALID_INPUT",
            "platform 不能为空",
            json!({ "field": "platform" }),
        ));
    }
    let key = app_key.as_str().unwrap_or("").trim().to_string();
    if key.is_empty() {
        return Err(TranslateError::new(
            "TRANSLATE_INVALID_INPUT",
            "appKey 不能为空",
            json!({ "field": "appKey" }),
        ));
    }
    let secret = app_secret.as_str().unwrap_or("").trim().to_string();
    if secret.is_empty() {
        return Err(TranslateError::new(
            "TRANSLATE_INVALID_INPUT",
            "appSecret 不能为空",
            json!({ "field": "appSecret" }),
        ));
    }
    if secret.chars().count() > APP_SECRET_MAX {
        return Err(TranslateError::new(
            "TRANSLATE_INVALID_INPUT",
            format!("appSecret 超长（≤{APP_SECRET_MAX} 字符，收到 {}）", secret.chars().count()),
            json!({ "field": "appSecret" }),
        ));
    }

    let (mut platforms, _, _, _) = read_credentials(file);
    let mut entry = Map::new();
    entry.insert("appKey".into(), json!(key));
    entry.insert("appSecret".into(), json!(secret));
    platforms.insert(p.clone(), Value::Object(entry));

    let mut doc = Map::new();
    doc.insert("platforms".into(), Value::Object(platforms.clone()));
    atomic_write_json(file, &Value::Object(doc), 0o600)
        .map_err(|e| TranslateError::new("TRANSLATE_UPSTREAM_ERROR", format!("写入密钥失败：{e}"), json!({})))?;

    Ok((p, view_of(&platforms)))
}

/// 脱敏视图：`{ <id>: { appKey, hasSecret } }`。
/// 🔴 **永不回显 appSecret**（`REFUTE.echoSecret` 是验收用的逃生开关）。
pub fn credentials_view(file: &Path) -> Map<String, Value> {
    let (platforms, _, _, _) = read_credentials(file);
    view_of(&platforms)
}

fn view_of(platforms: &Map<String, Value>) -> Map<String, Value> {
    let echo = refute::get().echo_secret;
    let mut out = Map::new();
    for (id, entry) in platforms {
        let obj = entry.as_object();
        let app_key = obj
            .and_then(|e| e.get("appKey"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let secret = obj
            .and_then(|e| e.get("appSecret"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let has_secret = !secret.is_empty();
        let mut v = Map::new();
        v.insert("appKey".into(), json!(app_key));
        v.insert("hasSecret".into(), json!(has_secret));
        if echo {
            v.insert("appSecret".into(), json!(secret));
        }
        out.insert(id.clone(), Value::Object(v));
    }
    out
}

/// 密钥脱敏：任何非空 secret 一律输出定长 `sk-****`（刻意不保留首尾字符）。
pub fn mask_secret(s: &str) -> &'static str {
    if s.is_empty() {
        ""
    } else {
        "sk-****"
    }
}

fn io_code(e: &std::io::Error) -> &'static str {
    match e.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        _ => "ERROR",
    }
}
