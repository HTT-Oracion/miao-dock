// 在线翻译自证出口（F5.5 换靶）
// =============================================================================
// 用途：Node 服务实现（`service/src/manga/translate/**`）退役后，`check:translate`
// 不再有「进程内直调 Node 门面」这条通路。本模块补上**同一位面**的 Rust 出口：
//
//   ① `--translate-cases '<json>'` —— **运行时**用例驱动：把一组用例（每次调用的
//      body / env / 类型）喂给 Rust 门面（`translate_text` / `translate_stream` /
//      `options_view` / `save_settings` / `save_credentials`），把结果归一化成
//      `{results:[{name, ok, value?, err?, deltas?}]}` 交回 e2e。
//      e2e 的假上游仍由 Node 侧起（夹具），Rust 侧真发 HTTP 打到它 —— 断言面
//      与旧「直调 Node 门面」逐条对应，且**更像产品**（真门面 + 真出网）。
//
//   ② `--translate-selftest` —— **纯逻辑**报告：统一码表 / 签名 input 截断 /
//      语言码表 / 上游码映射 / 出网错误族归因 / 可重试判定。这些面**不经过路由**
//      （注册表是编译期常量、错误族由 reqwest 抛），只能从这里取证。
//      报告是确定性的 ⇒ 由 `e2e/service/golden/translate-selftest.json` 冻结为金标。
//
// 🔴 每用例独立布置 env（门面的 `base_url()` / `env_ms()` / `state_dir()` 都是**每次调用现读**），
//    于是「切址 / 切超时档 / 切落盘目录」在本进程内可逐用例进行。
//    ⚠️ 例外：`refute.rs` 是 `OnceLock`（复刻 Node 模块顶层求值语义）⇒ 反证开关仍必须
//    **一个开关一个子进程**，由 e2e 在起本进程时布置（见 `check:translate --refute`）。
use std::collections::BTreeMap;

use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

use super::errors::{is_retryable, map_http_fault, map_upstream_code, status_of, HttpFault, TranslateError};
use super::youdao::{lang_code, truncate_input};

/// 错误 → 归一化 JSON（`check:translate` 的断言就是照 `code / status / details` 写的）。
fn err_json(e: &TranslateError) -> Value {
    json!({
        "code": e.code,
        "message": e.message,
        "status": e.status,
        "details": e.details,
    })
}

// ================================================================ 逐用例 env 布置

/// 布置一组 env，返回「原值」表（`None` = 原本不存在）。
fn apply_env(env: &Map<String, Value>) -> Vec<(String, Option<String>)> {
    let mut saved = Vec::new();
    for (k, v) in env {
        let raw = v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string());
        saved.push((k.clone(), std::env::var(k).ok()));
        std::env::set_var(k, raw);
    }
    saved
}

fn restore_env(saved: Vec<(String, Option<String>)>) {
    for (k, old) in saved {
        match old {
            Some(v) => std::env::set_var(&k, v),
            None => std::env::remove_var(&k),
        }
    }
}

// ================================================================ 运行时用例

async fn text_case(body: &Value) -> Value {
    match super::translate_text(body).await {
        Ok(v) => json!({ "ok": true, "value": v }),
        Err(e) => json!({ "ok": false, "err": err_json(&e) }),
    }
}

/// 流式：增量经有界通道交出，这里把**已吐出的增量**一并收集（对应旧脚本的 `onDelta`）。
async fn stream_case(body: &Value) -> Value {
    let (tx, mut rx) = mpsc::channel::<String>(8);
    let collector = tokio::spawn(async move {
        let mut out: Vec<String> = Vec::new();
        while let Some(d) = rx.recv().await {
            out.push(d);
        }
        out
    });
    let r = super::translate_stream(body, tx).await;
    let deltas = collector.await.unwrap_or_default();
    match r {
        Ok(v) => json!({ "ok": true, "value": v, "deltas": deltas }),
        Err(e) => json!({ "ok": false, "err": err_json(&e), "deltas": deltas }),
    }
}

fn options_case() -> Value {
    match super::options_view() {
        Ok(v) => json!({ "ok": true, "value": v, "source": super::current_source() }),
        Err(e) => json!({ "ok": false, "err": err_json(&e) }),
    }
}

fn settings_case(body: &Value) -> Value {
    match super::save_settings(body) {
        Ok(v) => json!({ "ok": true, "value": v }),
        Err(e) => json!({ "ok": false, "err": err_json(&e) }),
    }
}

fn credentials_case(body: &Value) -> Value {
    match super::save_credentials(body) {
        Ok(v) => json!({ "ok": true, "value": v }),
        Err(e) => json!({ "ok": false, "err": err_json(&e) }),
    }
}

/// 限流用例：N 个调用**同时**发出（同一个进程 ⇒ 同一个令牌桶，L1/L2 量的正是它）。
///
/// 逐条 body 由 `bodies` 给（**每条 text 唯一**）：签名 salt 由 `input` 派生时（`REUSE_SALT`
/// 反证档）也只有同一条 text 才会撞上游防重放 —— 用同一份 body 跑 N 次会让"限流"用例在
/// 那个开关下顺带变红，归因就散了（假绿纪律：一条开关只护一条机制）。
async fn batch_case(spec: &Value) -> Value {
    let count = spec.get("count").and_then(|v| v.as_u64()).unwrap_or(1).min(200) as usize;
    let call = spec.get("call").and_then(|v| v.as_str()).unwrap_or("text").to_string();
    let body = spec.get("body").cloned().unwrap_or_else(|| json!({}));
    let bodies = spec.get("bodies").and_then(|v| v.as_array()).cloned();
    let mut futs = Vec::with_capacity(count);
    for i in 0..count {
        let b = bodies
            .as_ref()
            .and_then(|list| list.get(i).cloned())
            .unwrap_or_else(|| body.clone());
        let c = call.clone();
        futs.push(async move {
            if c == "stream" {
                stream_case(&b).await
            } else {
                text_case(&b).await
            }
        });
    }
    json!({ "ok": true, "items": futures_util::future::join_all(futs).await })
}

async fn run_case(case: &Value) -> Value {
    let name = case.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let kind = case.get("kind").and_then(|v| v.as_str()).unwrap_or("text").to_string();
    let body = case.get("body").cloned().unwrap_or_else(|| json!({}));
    let env = case.get("env").and_then(|v| v.as_object()).cloned().unwrap_or_default();

    // env 必须在**调用之前**布置（门面每次现读）；调用结束立刻还原，避免用例间串味。
    let saved = apply_env(&env);
    let out = match kind.as_str() {
        "text" => text_case(&body).await,
        "stream" => stream_case(&body).await,
        "options" => options_case(),
        "settings" => settings_case(&body),
        "credentials" => credentials_case(&body),
        "batch" => batch_case(&body).await,
        other => json!({
            "ok": false,
            "err": err_json(&TranslateError::new(
                "SELFTEST_UNKNOWN_KIND",
                format!("未知用例类型 {other:?}"),
                json!({}),
            )),
        }),
    };
    restore_env(saved);

    let mut m = match out {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    m.insert("name".into(), json!(name));
    Value::Object(m)
}

/// `--translate-cases '<json>'`：输入 `{cases:[...]}`，输出 `{results:[...]}`。
pub fn cases_report(arg: &str) -> String {
    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => return json!({ "error": format!("tokio runtime: {e}") }).to_string(),
    };
    let input: Value = serde_json::from_str(arg).unwrap_or(Value::Null);
    let cases = input
        .get("cases")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    let out = rt.block_on(async move {
        let mut results = Vec::with_capacity(cases.len());
        for case in &cases {
            results.push(run_case(case).await);
        }
        json!({ "results": results })
    });
    out.to_string()
}

// ================================================================ 纯逻辑报告

/// 统一码表（**逐一列出**，不靠遍历枚举成员 —— 少一个码就等于少一条断言）。
const UNIFIED_CODES: &[&str] = &[
    "TRANSLATE_NOT_CONFIGURED",
    "TRANSLATE_AUTH_FAILED",
    "TRANSLATE_INVALID_INPUT",
    "TRANSLATE_TEXT_TOO_LONG",
    "TRANSLATE_RATE_LIMITED",
    "TRANSLATE_QUOTA_EXCEEDED",
    "TRANSLATE_UNSUPPORTED_FEATURE",
    "TRANSLATE_UPSTREAM_ERROR",
    "TRANSLATE_UPSTREAM_UNREACHABLE",
    "TRANSLATE_TIMEOUT",
    "TRANSLATE_CAPABILITY_UNSUPPORTED",
    "INVALID_SETTING",
];

/// 签名 input 截断的取样（含 20/21 边界与 UTF-16 代理对 —— 截断按**码元**算，不是码点）。
const TRUNCATE_SAMPLES: &[&str] = &[
    "",
    "abc",
    "12345678901234567890",
    "123456789012345678901",
    "L001MMMMMMMMMMMMMMMMMMMMMMMMMM",
    "日本語のテキストを翻訳しますこれは長い文章です",
    "🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂",
];

/// 语言码取样（跨过两张表的差异：`ko` 只在 text 表里，llm 表更短）。
const LANG_SAMPLES: &[&str] = &[
    "ja", "en", "zh", "auto", "ko", "ru", "fr", "de", "es", "it", "pt", "vi", "id", "th", "xx", "ZH-CHS",
];

/// 上游业务码取样：`(api, code)` —— 两接口各查自己那张表（未登记码落兜底）。
const UPSTREAM_SAMPLES: &[(&str, &str)] = &[
    ("text", "101"),
    ("text", "103"),
    ("text", "108"),
    ("text", "202"),
    ("text", "301"),
    ("text", "302"),
    ("text", "304"),
    ("text", "310"),
    ("text", "401"),
    ("text", "411"),
    ("text", "412"),
    ("text", "999"),
    ("llm", "1"),
    ("llm", "101"),
    ("llm", "108"),
    ("llm", "202"),
    ("llm", "206"),
    ("llm", "902000"),
    ("llm", "999"),
];

/// 出网错误族取样（顺序即优先级：超时 > 网络族 > 兜底）。
fn fault_samples() -> Vec<(&'static str, HttpFault)> {
    vec![
        ("timeout_connect", HttpFault::Timeout { stage: "connect".to_string(), timeout_ms: 400 }),
        ("timeout_ttfb", HttpFault::Timeout { stage: "ttfb".to_string(), timeout_ms: 400 }),
        ("timeout_idle", HttpFault::Timeout { stage: "idle".to_string(), timeout_ms: 400 }),
        ("timeout_total", HttpFault::Timeout { stage: "total".to_string(), timeout_ms: 800 }),
        ("unreachable", HttpFault::Unreachable { native: Some("ECONNREFUSED".to_string()) }),
        ("aborted", HttpFault::Aborted),
        ("other", HttpFault::Other { native: Some("boom".to_string()) }),
    ]
}

/// 可重试判定取样：链路与超时可重试；`UPSTREAM_ERROR` **仅限** 5xx 与上游 `303`。
fn retryable_samples() -> Vec<(&'static str, TranslateError)> {
    vec![
        ("unreachable", TranslateError::new("TRANSLATE_UPSTREAM_UNREACHABLE", "x", json!({}))),
        ("timeout", TranslateError::new("TRANSLATE_TIMEOUT", "x", json!({}))),
        (
            "upstream_5xx",
            TranslateError::new("TRANSLATE_UPSTREAM_ERROR", "x", json!({ "httpStatus": 500 })),
        ),
        (
            "upstream_4xx",
            TranslateError::new("TRANSLATE_UPSTREAM_ERROR", "x", json!({ "httpStatus": 404 })),
        ),
        (
            "upstream_303",
            TranslateError::new("TRANSLATE_UPSTREAM_ERROR", "x", json!({ "upstreamCode": "303" })),
        ),
        (
            "upstream_302",
            TranslateError::new("TRANSLATE_UPSTREAM_ERROR", "x", json!({ "upstreamCode": "302" })),
        ),
        ("auth", TranslateError::new("TRANSLATE_AUTH_FAILED", "x", json!({}))),
        ("rate_limited", TranslateError::new("TRANSLATE_RATE_LIMITED", "x", json!({}))),
        ("invalid_input", TranslateError::new("TRANSLATE_INVALID_INPUT", "x", json!({}))),
    ]
}

fn pure() -> Value {
    let codes: Vec<Value> = UNIFIED_CODES
        .iter()
        .map(|c| json!({ "code": c, "status": status_of(c) }))
        .collect();

    let truncate: Vec<Value> = TRUNCATE_SAMPLES
        .iter()
        .map(|q| {
            json!({
                "q": q,
                "utf16": q.encode_utf16().count(),
                "input": truncate_input(q),
            })
        })
        .collect();

    let lang_of = |api: &str| -> BTreeMap<String, Option<String>> {
        LANG_SAMPLES.iter().map(|s| ((*s).to_string(), lang_code(s, api))).collect()
    };

    let upstream: Vec<Value> = UPSTREAM_SAMPLES
        .iter()
        .map(|(api, code)| {
            let e = map_upstream_code("youdao", api, code);
            json!({ "api": api, "upstreamCode": code, "code": e.code, "status": e.status })
        })
        .collect();

    let faults: Vec<Value> = fault_samples()
        .iter()
        .map(|(name, f)| {
            let e = map_http_fault("youdao", "text", f);
            json!({
                "name": name,
                "code": e.code,
                "status": e.status,
                "stage": e.details.get("stage").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();

    let retryable: Vec<Value> = retryable_samples()
        .iter()
        .map(|(name, e)| json!({ "name": name, "code": e.code, "retryable": is_retryable(e) }))
        .collect();

    json!({
        "codes": codes,
        "unknownCodeStatus": status_of("NOT_A_UNIFIED_CODE"),
        "truncate": truncate,
        "langCode": { "text": lang_of("text"), "llm": lang_of("llm") },
        "upstream": upstream,
        "faults": faults,
        "retryable": retryable,
    })
}

/// `--translate-selftest`：打印确定性纯逻辑报告（冻结 golden 的金标）。
pub fn pure_report() -> String {
    pure().to_string()
}
