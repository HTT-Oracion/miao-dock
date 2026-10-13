// 在线翻译**非密钥设置**的持久化层（`state/translate-settings.json`）
// =============================================================================
// 契约依据：在线翻译服务设计方案 §8（三层来源 / 白名单 / 原子写）。
// 移植自 `service/src/manga/translate/settings.mjs`。密钥**不在本文件**（见 `credentials.rs`）。
//
// ## 🔴 落盘路径由调用方传进来（`file` 参数）
// Node 版这样设计是为了防 ESM 循环；Rust 版保留同一姿态：本模块对所有输入都是**纯参数**，
// 唯一的事实源仍是 `paths::state_dir()`（调用方注入，见 `mod.rs`）。
use std::path::Path;

use serde_json::{json, Map, Value};

/// 允许持久化的键（**白名单**）。
///
/// 🔴 白名单的意义不是「防注入」，而是**防拼错**：`youdao.llmmodel`（大小写）这类键如果被
///    静默丢弃，用户看到的是「设置保存成功」而实际什么都没变 —— 正是本项目最反对的假绿。
///    ⇒ 写路径上**拒绝**；读路径（盘上那份）相反：丢弃 + 上报。
pub const KEYS: &[&str] = &[
    "platform",
    "source",
    "youdao.llmModel",
    "youdao.textDomain",
    "youdao.vocabId",
    "timeoutMs",
];

pub const SOURCE_VALUES: &[&str] = &["local", "online"];
pub const LLM_MODEL_VALUES: &[&str] = &["pro", "lite"];
pub const TEXT_DOMAIN_VALUES: &[&str] = &["general", "computers", "medicine", "finance", "game"];
pub const TIMEOUT_MIN: i64 = 1000;
pub const TIMEOUT_MAX: i64 = 600_000;
pub const VOCAB_ID_MAX: usize = 64;

/// 出厂默认（代码常量层，方案 §8.1 的最底层）。
pub fn default_settings() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("platform".into(), json!("youdao"));
    m.insert("source".into(), json!("local"));
    m.insert("youdao.llmModel".into(), json!("pro"));
    m.insert("youdao.textDomain".into(), json!("general"));
    m.insert("youdao.vocabId".into(), json!(""));
    m.insert("timeoutMs".into(), json!(30000));
    m
}

/// 注册表 id 集（`platform` 的合法取值）。Rust 侧产品注册表只有 `youdao`。
pub fn platform_ids() -> Vec<&'static str> {
    vec!["youdao"]
}

fn hint_of(key: &str) -> String {
    match key {
        "platform" => format!("可选：{}", platform_ids().join(" | ")),
        "source" => format!("可选：{}", SOURCE_VALUES.join(" | ")),
        "youdao.llmModel" => format!("可选：{}", LLM_MODEL_VALUES.join(" | ")),
        "youdao.textDomain" => format!("可选：{}", TEXT_DOMAIN_VALUES.join(" | ")),
        "youdao.vocabId" => format!("字符串，≤{VOCAB_ID_MAX} 字符（空串 = 不使用术语表）"),
        "timeoutMs" => format!("{TIMEOUT_MIN}–{TIMEOUT_MAX} 的整数（毫秒）"),
        _ => String::new(),
    }
}

fn check(key: &str, v: &Value) -> bool {
    match key {
        "platform" => v.as_str().map(|s| platform_ids().contains(&s)).unwrap_or(false),
        "source" => v.as_str().map(|s| SOURCE_VALUES.contains(&s)).unwrap_or(false),
        "youdao.llmModel" => v.as_str().map(|s| LLM_MODEL_VALUES.contains(&s)).unwrap_or(false),
        "youdao.textDomain" => v.as_str().map(|s| TEXT_DOMAIN_VALUES.contains(&s)).unwrap_or(false),
        "youdao.vocabId" => v.as_str().map(|s| s.chars().count() <= VOCAB_ID_MAX).unwrap_or(false),
        "timeoutMs" => v.as_i64().map(|n| n >= TIMEOUT_MIN && n <= TIMEOUT_MAX).unwrap_or(false),
        _ => false,
    }
}

/// 单键规范化（只做取值层面的整形：字符串 trim，不做业务加工）。
fn normalize(key: &str, v: &Value) -> Value {
    if key == "timeoutMs" {
        return v.clone();
    }
    match v.as_str() {
        Some(s) => json!(s.trim()),
        None => v.clone(),
    }
}

/// 解析结果（读路径的「丢弃 + 上报」出口）。
#[derive(Debug, Default, Clone)]
pub struct Parsed {
    pub settings: Map<String, Value>,
    pub unknown_keys: Vec<String>,
    /// 非法值：`(key, must)`
    pub invalid: Vec<(String, String)>,
}

/// 解析一份设置对象。
///
/// ## 🔴 两个方向的**不对称**是刻意的
/// | 来源 | 未知键 | 非法值 |
/// |---|---|---|
/// | **补丁**（`strict: true`，HTTP 请求体） | **抛错** | **抛错** |
/// | **文件**（`strict: false`，盘上 JSON） | 丢弃 + 上报 | 丢弃 + 上报 |
pub fn parse_settings(raw: &Value, strict: bool) -> Result<Parsed, super::errors::TranslateError> {
    let Some(obj) = raw.as_object() else {
        let shape = if raw.is_array() { "array" } else { json_type_name(raw) };
        let msg = format!("设置必须是一个 JSON 对象，收到 {shape}");
        if strict {
            return Err(super::errors::TranslateError::setting(msg, json!({ "received": raw })));
        }
        let mut p = Parsed::default();
        p.invalid.push(("(root)".to_string(), "对象".to_string()));
        return Ok(p);
    };

    let mut p = Parsed::default();
    for (key, value) in obj {
        if !KEYS.contains(&key.as_str()) {
            if strict {
                return Err(super::errors::TranslateError::setting(
                    format!("未知设置项 {key:?} —— 不在白名单内（允许：{}）", KEYS.join(", ")),
                    json!({ "key": key, "allowed": KEYS }),
                ));
            }
            p.unknown_keys.push(key.clone());
            continue;
        }
        if !check(key, value) {
            if strict {
                return Err(super::errors::TranslateError::setting(
                    format!("设置项 {key} 取值非法（须为 {}）", hint_of(key)),
                    json!({ "key": key, "value": value }),
                ));
            }
            p.invalid.push((key.clone(), hint_of(key)));
            continue;
        }
        p.settings.insert(key.clone(), normalize(key, value));
    }
    Ok(p)
}

/// 校验一个**补丁**（HTTP 请求体）。空补丁抛错 —— 一个 `POST {}` 若返回 200「已保存」，
/// 那是最典型的假绿：什么都没写，却报「保存成功」。
pub fn assert_patch(patch: &Value) -> Result<Map<String, Value>, super::errors::TranslateError> {
    if !patch.is_object() {
        let shape = if patch.is_array() { "array" } else { json_type_name(patch) };
        return Err(super::errors::TranslateError::setting(
            format!("请求体必须是对象，收到 {shape}"),
            json!({ "received": patch }),
        ));
    }
    if patch.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        return Err(super::errors::TranslateError::setting("请求体为空，没有任何设置项", json!({})));
    }
    Ok(parse_settings(patch, true)?.settings)
}

/// 读盘上那份设置（返回 `(Parsed, exists, corrupt, reason)`）。
///
/// 文件不存在 = **正常的首次启动**（不是错误）；只有「存在但读不成」才是 `corrupt`。
/// 坏文件**原地保留、不搬走、不重命名**：证据比整洁重要。
pub fn read_settings(file: &Path) -> (Parsed, bool, bool, Option<String>) {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                return (Parsed::default(), false, false, None);
            }
            return (
                Parsed::default(),
                true,
                true,
                Some(format!("{}: {}", io_code(&e), e)),
            );
        }
    };
    let raw: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            return (Parsed::default(), true, true, Some(format!("JSON 解析失败：{e}")));
        }
    };
    if !raw.is_object() {
        let shape = if raw.is_array() { "array" } else { json_type_name(&raw) };
        return (
            Parsed::default(),
            true,
            true,
            Some(format!("顶层应为 JSON 对象，实为 {shape}")),
        );
    }
    let parsed = parse_settings(&raw, false).unwrap_or_default();
    (parsed, true, false, None)
}

/// 原子写：先写同目录临时文件、`fsync`、再 `rename` 覆盖。
///
/// 🔴 为什么不能直接覆写：`rename` 在 POSIX 上是**原子**的，直接写不是 —— 崩在中间会留下
///    半截 JSON，下次启动读成 `corrupt`，用户改的设置被静默回退成默认值。权限 0600：
///    设置里虽没有密钥，但「用户的本地偏好」也该只有本人可读。
pub fn write_settings(
    file: &Path,
    patch: &Value,
) -> Result<(Map<String, Value>, Vec<String>), super::errors::TranslateError> {
    let clean = assert_patch(patch)?;
    let (current, _, _, _) = read_settings(file);
    let mut merged = current.settings.clone();
    let mut changed: Vec<String> = Vec::new();
    for (k, v) in &clean {
        merged.insert(k.clone(), v.clone());
        changed.push(k.clone());
    }
    atomic_write_json(file, &Value::Object(merged.clone()), 0o600)
        .map_err(|e| super::errors::TranslateError::setting(format!("写入设置失败：{e}"), json!({})))?;
    Ok((merged, changed))
}

// ------------------------------------------------------------------ env 合并

/// 环境变量 → 设置键的映射（**单位与文件一致**，不加换算）。
const ENV_KEYS: &[(&str, &str)] = &[
    ("MIAO_TRANSLATE_PLATFORM", "platform"),
    ("MIAO_TRANSLATE_SOURCE", "source"),
    ("MIAO_TRANSLATE_TIMEOUT_MS", "timeoutMs"),
    ("MIAO_YOUDAO_LLM_MODEL", "youdao.llmModel"),
    ("MIAO_YOUDAO_TEXT_DOMAIN", "youdao.textDomain"),
    ("MIAO_YOUDAO_VOCAB_ID", "youdao.vocabId"),
];

/// 合并生效值 + **逐键来源**。
///
/// ## 🔴 优先级：`env` > 文件 > 默认
/// 环境变量在本项目里的角色是**验收与排障的强制覆盖**。若文件优先，本机跑过一次设置页
/// 之后所有夹具都会被用户偏好悄悄改写 —— 那种失败极难归因。
pub fn merge_with_env(
    file_settings: &Map<String, Value>,
) -> Result<(Map<String, Value>, Map<String, Value>), super::errors::TranslateError> {
    let mut from_env: Map<String, Value> = Map::new();
    for (name, key) in ENV_KEYS {
        let Ok(raw) = std::env::var(name) else { continue };
        if raw.is_empty() {
            continue;
        }
        let value = if *key == "timeoutMs" {
            // `Number.parseInt(String(raw), 10)`：取前导整数部分
            match parse_leading_int(&raw) {
                Some(n) => json!(n),
                None => json!(Value::Null),
            }
        } else {
            json!(raw)
        };
        if !check(key, &value) {
            return Err(super::errors::TranslateError::setting(
                format!("环境变量 {name} 取值非法（须为 {}）：{raw:?}", hint_of(key)),
                json!({ "key": key, "env": name, "value": raw }),
            ));
        }
        from_env.insert((*key).to_string(), normalize(key, &value));
    }

    let mut settings: Map<String, Value> = Map::new();
    let mut sources: Map<String, Value> = Map::new();
    apply_bag(&default_settings(), "default", &mut settings, &mut sources);
    apply_bag(file_settings, "file", &mut settings, &mut sources);
    apply_bag(&from_env, "env", &mut settings, &mut sources);
    Ok((settings, sources))
}

fn apply_bag(
    bag: &Map<String, Value>,
    source: &str,
    settings: &mut Map<String, Value>,
    sources: &mut Map<String, Value>,
) {
    for (k, v) in bag {
        settings.insert(k.clone(), v.clone());
        sources.insert(k.clone(), json!(source));
    }
}

fn parse_leading_int(s: &str) -> Option<i64> {
    let t = s.trim();
    let bytes = t.as_bytes();
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'-' || bytes[i] == b'+') {
        i += 1;
    }
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return None;
    }
    t[..i].parse::<i64>().ok()
}

// ------------------------------------------------------------------ 原子写（与 store.rs 同款语义）

/// `.tmp-<pid>-<ts>` → 写入 → fsync → rename。与 `credentials.rs` 共用。
pub fn atomic_write_json(file: &Path, value: &Value, mode: u32) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
        let _ = set_dir_mode(dir, 0o700);
    }
    let tmp = tmp_path(file);
    let body = format!("{}\n", serde_json::to_string_pretty(value).unwrap_or_default());
    let _ = std::fs::remove_file(&tmp);
    {
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(&tmp)?;
        use std::io::Write;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
    }
    let _ = set_file_mode(&tmp, mode);
    if let Err(e) = std::fs::rename(&tmp, file) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

fn tmp_path(file: &Path) -> std::path::PathBuf {
    let pid = std::process::id();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = format!(
        "{}.tmp-{pid}-{ts}",
        file.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    );
    file.with_file_name(name)
}

#[cfg(unix)]
fn set_file_mode(p: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode))
}
#[cfg(not(unix))]
fn set_file_mode(_p: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}
#[cfg(unix)]
fn set_dir_mode(p: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode))
}
#[cfg(not(unix))]
fn set_dir_mode(_p: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}

fn json_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "object",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn io_code(e: &std::io::Error) -> &'static str {
    match e.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        _ => "ERROR",
    }
}
