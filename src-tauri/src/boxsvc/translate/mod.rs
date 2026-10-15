// 在线翻译门面 —— 本模块**唯一的对外入口**（handlers 只 import 本文件）
// =============================================================================
// 依据：在线翻译服务设计方案 §3（模块职责表）/ §6（调用流程）/ §7（错误与重试）/ §8（配置）。
// 移植自 `service/src/manga/translate/index.mjs`。
//
// 门面只做「编排」，不认平台：
//   入参校验 · 能力协商（registry）· 语言码归一（adapter.langCode）· 限流（limiter）
//   · 密钥现读注入 · 错误归一 · 按 §7.3 重试
// 🔴 纪律：**不碰任何平台字段名** —— 本文件不知道 `llm-trans` / `transIncre` /
//    `errorCode` / `handleOption` 这些词（它们全在 `youdao.rs`）。
//
// ## 落盘路径
// Node 版靠 `configureTranslate()` 注入两个文件路径（防 ESM 环）。Rust 版没有 ESM 环的问题，
// 但保留「唯一事实源」的姿态：路径**只**从 `paths::state_dir()` 现算，不在这里手写拼接规则。
pub mod credentials;
pub mod errors;
pub mod http;
pub mod limiter;
pub mod refute;
pub mod selftest;
pub mod settings;
pub mod sse_parse;
pub mod youdao;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

use crate::paths;
use errors::{is_retryable, TranslateError};
use youdao::{Credentials, TranslateReq, TranslateResult};

/// 文本长度上限（有道两接口一致：`q`/`i` ≤5000 字符，方案 §5.2/§5.3）。
/// 按 **UTF-16 码元数**（`String.length`）—— 与适配器签名用的 `q.length` 同一把尺。
const TEXT_MAX_CHARS: usize = 5000;
/// 提示词上限（有道 llm：≤1200 字符 / ≤400 词）
const PROMPT_MAX_CHARS: usize = 1200;
const PROMPT_MAX_WORDS: usize = 400;
/// text 整体 · 可重试错最多重试 2 次，退避 300ms → 900ms（方案 §7.3）
const TEXT_MAX_RETRIES: usize = 2;
/// llm 流式 · **首块之前**失败才重试，且最多 1 次
const STREAM_MAX_RETRIES: usize = 1;
/// 退避序列（毫秒）
const RETRY_BACKOFF_MS: [u64; 2] = [300, 900];

/// 非密钥设置文件（`state/translate-settings.json`）
pub fn settings_file() -> PathBuf {
    paths::state_dir().join("translate-settings.json")
}
/// 密钥文件（`state/translate-credentials.json`）
pub fn credentials_file() -> PathBuf {
    paths::state_dir().join("translate-credentials.json")
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

// ------------------------------------------------------------------ 平台注册表（Rust 侧只有 youdao）

/// 一个平台的静态描述（复刻 `registry.mjs` 的 `listPlatforms` 形状）。
pub struct AdapterInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub capabilities: &'static [&'static str],
    pub langs: Vec<String>,
}

/// 取一个平台（未知 id 当场抛，details 带 available 供界面提示）。
pub fn get_adapter(id: &str) -> Result<AdapterInfo, TranslateError> {
    if id == "youdao" {
        return Ok(AdapterInfo {
            id: "youdao",
            label: "有道智云",
            capabilities: &["llm", "text"],
            langs: youdao::langs(),
        });
    }
    Err(TranslateError::new(
        "TRANSLATE_INVALID_INPUT",
        format!("未知翻译平台 {id:?}"),
        json!({ "platform": id, "available": ["youdao"] }),
    ))
}

/// 全部平台的能力清单（给 `GET /translate/options` 用）。
pub fn list_platforms() -> Vec<Value> {
    ["youdao"]
        .iter()
        .filter_map(|id| get_adapter(*id).ok())
        .map(|a| {
            json!({
                "id": a.id,
                "label": a.label,
                "capabilities": a.capabilities,
                "langs": a.langs,
            })
        })
        .collect()
}

/// 能力协商（方案 §4.2）：平台不支持该能力 ⇒ **在这里就挡下**，不发出任何网络请求。
fn adapter_for(platform_id: &str, mode: &str) -> Result<AdapterInfo, TranslateError> {
    let a = get_adapter(platform_id)?;
    if !a.capabilities.contains(&mode) {
        return Err(TranslateError::new(
            "TRANSLATE_CAPABILITY_UNSUPPORTED",
            format!(
                "平台 {}（{}）不支持 {}翻译",
                a.id,
                a.label,
                if mode == "llm" { "大模型流式" } else { "普通文本" }
            ),
            json!({ "platform": a.id, "mode": mode, "capabilities": a.capabilities }),
        ));
    }
    Ok(a)
}

// ------------------------------------------------------------------ 现读（方案 §8.4）

struct Merged {
    settings: Map<String, Value>,
    sources: Map<String, Value>,
    read: settings::Parsed,
    exists: bool,
    corrupt: bool,
    reason: Option<String>,
}

/// 合并生效设置（env > 盘上文件 > 出厂默认）。🔴 **每次调用都现读**。
fn current_merged() -> Result<Merged, TranslateError> {
    let (read, exists, corrupt, reason) = settings::read_settings(&settings_file());
    let (merged, sources) = settings::merge_with_env(&read.settings)?;
    Ok(Merged { settings: merged, sources, read, exists, corrupt, reason })
}

/// 生效的翻译来源（`local` / `online`）—— 复刻 `currentTranslateSource()`。
///
/// 🔴 P-D4（ver2.2 已定稿）：来源 = 在线 ⇒ **引擎不随开机拉起**（在线链路完全不需要 ③ 的显存）。
///    读失败一律回落 `local`（= 接线前的默认行为），不抛错 —— 一个读不出的来源不该让服务起不来。
pub fn current_source() -> String {
    match current_merged() {
        Ok(m) => m.settings.get("source").and_then(|v| v.as_str()).unwrap_or("local").to_string(),
        Err(_) => "local".to_string(),
    }
}

/// 每平台一个令牌桶（进程内懒建）。
fn limiter_of(platform: &str) -> Arc<limiter::Limiter> {
    limiter::limiter_of(platform)
}

// ------------------------------------------------------------------ 入参校验

fn jstr<'a>(v: Option<&'a Value>) -> Option<&'a str> {
    v.and_then(|x| x.as_str())
}

fn assert_text(text: &str) -> Result<(), TranslateError> {
    if text.trim().is_empty() {
        return Err(TranslateError::new(
            "TRANSLATE_INVALID_INPUT",
            "text 必须是非空字符串",
            json!({ "received": "string" }),
        ));
    }
    if utf16_len(text) > TEXT_MAX_CHARS {
        return Err(TranslateError::new(
            "TRANSLATE_TEXT_TOO_LONG",
            format!("待翻译文本超过 {TEXT_MAX_CHARS} 字符上限（收到 {}）", utf16_len(text)),
            json!({ "length": utf16_len(text), "limit": TEXT_MAX_CHARS }),
        ));
    }
    Ok(())
}

fn assert_direction(from: Option<&str>, to: Option<&str>) -> Result<(), TranslateError> {
    for (field, value) in [("from", from), ("to", to)] {
        match value {
            Some(v) if !v.trim().is_empty() => {}
            _ => {
                return Err(TranslateError::new(
                    "TRANSLATE_INVALID_INPUT",
                    format!("{field} 必须是非空字符串（语言短码，如 'ja' | 'en' | 'zh' | 'auto'）"),
                    json!({ "field": field, "received": value.map(|_| "string").unwrap_or("undefined") }),
                ))
            }
        }
    }
    Ok(())
}

/// 提示词（仅 llm）：没给 = 用平台默认，不校验。
fn assert_prompt(prompt: Option<&str>) -> Result<(), TranslateError> {
    let Some(p) = prompt else { return Ok(()) };
    if p.is_empty() {
        return Ok(());
    }
    if utf16_len(p) > PROMPT_MAX_CHARS {
        return Err(TranslateError::new(
            "TRANSLATE_INVALID_INPUT",
            format!("提示词超过 {PROMPT_MAX_CHARS} 字符上限（收到 {}）", utf16_len(p)),
            json!({ "length": utf16_len(p), "limit": PROMPT_MAX_CHARS }),
        ));
    }
    let words = p.split_whitespace().count();
    if words > PROMPT_MAX_WORDS {
        return Err(TranslateError::new(
            "TRANSLATE_INVALID_INPUT",
            format!("提示词超过 {PROMPT_MAX_WORDS} 词上限（收到 {words}）"),
            json!({ "words": words, "limit": PROMPT_MAX_WORDS }),
        ));
    }
    Ok(())
}

/// 语言码归一：认不出当场 400（**不猜** —— 猜错的代价是「把日文当英文送」）。
fn normalize_langs(a: &AdapterInfo, from: &str, to: &str, api: &str) -> Result<(), TranslateError> {
    let f = youdao::lang_code(from, api);
    let t = youdao::lang_code(to, api);
    if f.is_none() || t.is_none() {
        return Err(TranslateError::new(
            "TRANSLATE_INVALID_INPUT",
            format!("不支持的翻译方向：{from:?} → {to:?}（平台 {}）", a.id),
            json!({ "platform": a.id, "api": api, "from": from, "to": to, "langs": &a.langs }),
        ));
    }
    Ok(())
}

/// 平台缺省走**设置里的** platform（平台是服务的设置，不是请求的属性）。
fn resolve_platform(body: &Value, settings: &Map<String, Value>) -> Result<String, TranslateError> {
    match body.get("platform") {
        None | Some(Value::Null) => Ok(jstr(settings.get("platform")).unwrap_or("youdao").to_string()),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                return Err(TranslateError::new(
                    "TRANSLATE_INVALID_INPUT",
                    "platform 必须是非空字符串",
                    json!({ "platform": s }),
                ));
            }
            Ok(t.to_string())
        }
        Some(other) => Err(TranslateError::new(
            "TRANSLATE_INVALID_INPUT",
            format!("platform 必须是非空字符串，收到 {other}"),
            json!({ "platform": other }),
        )),
    }
}

/// 总超时预算：请求可覆盖；没给/不合法时用设置里的 `timeoutMs`。
fn resolve_timeout(body: &Value, settings: &Map<String, Value>) -> Result<u64, TranslateError> {
    let fallback = settings.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(30000);
    match body.get("timeoutMs") {
        None | Some(Value::Null) => Ok(fallback),
        Some(v) => match v.as_f64() {
            // 🔴 非法值**当场抛**而不是静默回落：静默回落的 timeoutMs 是用户改不动的参数。
            Some(n) if n.is_finite() && n > 0.0 => Ok(n as u64),
            _ => Err(TranslateError::new(
                "TRANSLATE_INVALID_INPUT",
                format!("timeoutMs 必须是正数（毫秒），收到 {v}"),
                json!({ "timeoutMs": v }),
            )),
        },
    }
}

fn body_str(body: &Value, key: &str) -> Option<String> {
    body.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// 组装适配器请求（只带本能力用得上的字段；对端适配器还会再裁一遍，方案 §5.4）。
fn build_req(body: &Value, timeout_ms: u64) -> TranslateReq {
    TranslateReq {
        text: body_str(body, "text").unwrap_or_default(),
        from: body_str(body, "from").unwrap_or_default(),
        to: body_str(body, "to").unwrap_or_default(),
        split_lines: body.get("splitLines").and_then(|v| v.as_bool()).unwrap_or(false),
        prompt: body_str(body, "prompt"),
        model: body_str(body, "model"),
        domain: body_str(body, "domain"),
        vocab_id: body_str(body, "vocabId"),
        timeout_ms,
    }
}

fn creds_of(platform: &str) -> Credentials {
    let (app_key, app_secret) = credentials::plain_of(&credentials_file(), platform);
    Credentials { app_key, app_secret }
}

async fn backoff(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

/// 过一遍令牌桶再执行（QPS + 并发双重闸门）。等不到额度 = 我们自己的闸门满了 ⇒ 429。
async fn with_limiter<F, Fut, T>(
    platform: &str,
    total_ms: u64,
    f: F,
) -> Result<T, TranslateError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, TranslateError>>,
{
    let limiter = limiter_of(platform);
    let permit = limiter.acquire(Some(total_ms)).await.map_err(|e| {
        TranslateError::new(
            "TRANSLATE_RATE_LIMITED",
            format!(
                "翻译请求排队超时（{}ms 内未获得平台 {platform} 的额度），请稍后再试",
                e.timeout_ms
            ),
            json!({ "platform": platform, "stage": "limiter", "timeoutMs": e.timeout_ms }),
        )
    })?;
    let out = f().await;
    drop(permit);
    out
}

fn result_to_json(r: &TranslateResult) -> Value {
    let mut m = Map::new();
    m.insert("text".into(), json!(r.text));
    if let Some(lines) = &r.lines {
        m.insert("lines".into(), json!(lines));
    }
    if let Some(lt) = &r.lang_type {
        m.insert("langType".into(), json!(lt));
    }
    Value::Object(m)
}

// ------------------------------------------------------------------ 对外：整体翻译（方案 §6.2）

/// 普通文本翻译（**整体**返回）。返回 `{ text, lines?, langType? }`。
pub async fn translate_text(body: &Value) -> Result<Value, TranslateError> {
    let merged = current_merged()?;
    let platform_id = resolve_platform(body, &merged.settings)?;
    let mode = body.get("mode").and_then(|v| v.as_str()).unwrap_or("text");
    if mode != "text" {
        return Err(TranslateError::new(
            "TRANSLATE_INVALID_INPUT",
            format!("translateText 只接受 mode:'text'，收到 {mode:?}"),
            json!({ "mode": mode }),
        ));
    }
    let text = body_str(body, "text").unwrap_or_default();
    assert_text(&text)?;
    assert_direction(jstr(body.get("from")), jstr(body.get("to")))?;
    let adapter = adapter_for(&platform_id, "text")?;
    let from = jstr(body.get("from")).unwrap_or("").trim().to_string();
    let to = jstr(body.get("to")).unwrap_or("").trim().to_string();
    normalize_langs(&adapter, &from, &to, "text")?;
    let total_ms = resolve_timeout(body, &merged.settings)?;

    let mut req = build_req(body, total_ms);
    req.text = text;
    req.from = from;
    req.to = to;

    let mut attempt = 0usize;
    loop {
        let attempt_result = with_limiter(&platform_id, total_ms, || {
            let req = req.clone();
            let platform_id = platform_id.clone();
            async move {
                let creds = creds_of(&platform_id);
                youdao::translate_text(&req, &creds).await
            }
        })
        .await;
        match attempt_result {
            Ok(r) => return Ok(result_to_json(&r)),
            Err(e) => {
                if attempt >= TEXT_MAX_RETRIES || !is_retryable(&e) {
                    return Err(e);
                }
                backoff(RETRY_BACKOFF_MS[attempt.min(RETRY_BACKOFF_MS.len() - 1)]).await;
                attempt += 1;
            }
        }
    }
}

// ------------------------------------------------------------------ 对外：流式翻译（方案 §6.1）

/// 大模型翻译（**流式**）：每收到增量推进 `tx`；返回累计全文（`{ text, langType? }`）。
/// `tx` 有界 ⇒ `send().await` 提供背压：下游慢 ⇒ 上游读得慢。
pub async fn translate_stream(body: &Value, tx: mpsc::Sender<String>) -> Result<Value, TranslateError> {
    let merged = current_merged()?;
    let platform_id = resolve_platform(body, &merged.settings)?;
    let mode = body.get("mode").and_then(|v| v.as_str()).unwrap_or("llm");
    if mode != "llm" {
        return Err(TranslateError::new(
            "TRANSLATE_INVALID_INPUT",
            format!("translateStream 只接受 mode:'llm'，收到 {mode:?}"),
            json!({ "mode": mode }),
        ));
    }
    let text = body_str(body, "text").unwrap_or_default();
    assert_text(&text)?;
    assert_direction(jstr(body.get("from")), jstr(body.get("to")))?;
    assert_prompt(body_str(body, "prompt").as_deref())?;
    let adapter = adapter_for(&platform_id, "llm")?;
    let from = jstr(body.get("from")).unwrap_or("").trim().to_string();
    let to = jstr(body.get("to")).unwrap_or("").trim().to_string();
    normalize_langs(&adapter, &from, &to, "llm")?;
    let total_ms = resolve_timeout(body, &merged.settings)?;

    let mut req = build_req(body, total_ms);
    req.text = text;
    req.from = from;
    req.to = to;

    // 首块锁定：一旦吐过增量，此后失败**绝不重试**（方案 §7.3 —— 重来会重复/覆盖前面的内容）。
    let mut first_block_out = false;
    let mut attempt = 0usize;
    loop {
        let permit = limiter_of(&platform_id)
            .acquire(Some(total_ms))
            .await
            .map_err(|e| {
                TranslateError::new(
                    "TRANSLATE_RATE_LIMITED",
                    format!(
                        "翻译请求排队超时（{}ms 内未获得平台 {platform_id} 的额度），请稍后再试",
                        e.timeout_ms
                    ),
                    json!({ "platform": platform_id, "stage": "limiter", "timeoutMs": e.timeout_ms }),
                )
            })?;

        // 包装 tx：吐第一个增量即置锁（标志在**交出增量之前**置位 —— 交出去了就没有回头路）。
        let emitted = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (inner_tx, mut inner_rx) = mpsc::channel::<String>(8);
        let outer_tx = tx.clone();
        let emitted_flag = emitted.clone();
        let pump = tokio::spawn(async move {
            while let Some(delta) = inner_rx.recv().await {
                emitted_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                if outer_tx.send(delta).await.is_err() {
                    break;
                }
            }
        });

        let creds = creds_of(&platform_id);
        let attempt_result = youdao::translate_stream(&req, &creds, &inner_tx).await;
        drop(inner_tx);
        let _ = pump.await;
        first_block_out = first_block_out || emitted.load(std::sync::atomic::Ordering::SeqCst);

        // 反证开关：忽略首块锁定 ⇒ 首块之后也重试（已吐给用户的增量被重复/覆盖）
        let locked = if refute::get().stream_retry_after_first { false } else { first_block_out };
        drop(permit);

        match attempt_result {
            Ok(r) => return Ok(result_to_json(&r)),
            Err(e) => {
                if locked || attempt >= STREAM_MAX_RETRIES || !is_retryable(&e) {
                    return Err(e);
                }
                backoff(RETRY_BACKOFF_MS[attempt.min(RETRY_BACKOFF_MS.len() - 1)]).await;
                attempt += 1;
            }
        }
    }
}

// ------------------------------------------------------------------ 对外：设置 / 密钥 / 选项视图

/// `GET /translate/options` 的视图。
/// 🔴 `credentials` 只回 `{ appKey, hasSecret }` —— **secret 永不回显**（方案 §8.3）。
pub fn options_view() -> Result<Value, TranslateError> {
    let platforms = list_platforms();
    let merged = current_merged()?;
    let credentials = credentials::credentials_view(&credentials_file());
    let invalid: Vec<Value> = merged
        .read
        .invalid
        .iter()
        .map(|(k, must)| json!({ "key": k, "must": must }))
        .collect();
    Ok(json!({
        "platforms": platforms,
        "settings": merged.settings,
        "sources": merged.sources,
        "credentials": credentials,
        // 🔴 盘上文件的**问题必须 surfaced，不静默**
        "fileIssues": {
            "exists": merged.exists,
            "corrupt": merged.corrupt,
            "reason": merged.reason,
            "unknownKeys": merged.read.unknown_keys,
            "invalid": invalid,
        },
    }))
}

/// 保存非密钥设置补丁。返回 `{ ok, changed, settings }`。
pub fn save_settings(patch: &Value) -> Result<Value, TranslateError> {
    let (settings, changed) = settings::write_settings(&settings_file(), patch)?;
    Ok(json!({ "ok": true, "changed": changed, "settings": settings }))
}

/// 保存一个平台的密钥（只写不读回显）。返回 `{ ok, saved: { platform, appKey } }`。
pub fn save_credentials(body: &Value) -> Result<Value, TranslateError> {
    let platform = body.get("platform").cloned().unwrap_or(Value::Null);
    let app_key = body.get("appKey").cloned().unwrap_or(Value::Null);
    let app_secret = body.get("appSecret").cloned().unwrap_or(Value::Null);
    let (p, view) = credentials::write_credentials(&credentials_file(), &platform, &app_key, &app_secret)?;
    let key = view
        .get(&p)
        .and_then(|v| v.get("appKey"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(json!({ "ok": true, "saved": { "platform": p, "appKey": key } }))
}

/// 翻译域错误 → HTTP 信封 `{error:{code,message,details}}` + 状态码。
pub fn error_body(e: &TranslateError) -> (u16, Value) {
    (
        e.status,
        json!({ "error": { "code": e.code, "message": e.message, "details": e.details } }),
    )
}
