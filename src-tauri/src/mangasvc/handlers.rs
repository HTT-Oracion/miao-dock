// 已迁移端点的 HTTP 处理层（F5）—— 与 `routes.rs` 的显式表一一对应。
//
// 分工：`routes.rs` 只回答「这条端点是谁、迁没迁」；本模块回答「已迁移的它怎么答」。
// 逐组迁移时，把对应 handler 加到这里，并把 `routes.rs` 里那一行的 tier 改成 `Migrated`。
//
// `dispatch` 的入参已由外壳做过：Origin 白名单、CORS 预检、令牌校验。因此这里**不再**重复鉴权
// —— 鉴权只能有一处，多一处就会漂移出「某个端点忘了校验」。CORS 响应头也由外壳统一附加
// （见 `mangasvc.rs::handler`），本模块只管业务状态码与响应体。
//
// ## 逐条对齐 Node（`service/src/server.mjs`）
// 每个 handler 头顶都标了 Node 侧的原函数名。**状态码、错误码、details 键、字段序**都要一致：
// e2e 的 rust 靶子与 node 靶子跑的是同一套断言（`_service-harness.mjs`），任何一处漂移都会
// 在一半的靶子上变红。
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{header, HeaderMap, HeaderValue, Uri};
use axum::response::Response;
use serde_json::{json, Map, Value};

use crate::platform::child_watch::hide_console;
use super::events;
use super::library;
use super::multipart;
use super::names;
use super::routes::Match;
use super::sidecar::assert_sidecar_ready;
use super::store::exec::{CancelStep, CreatePayload, InputImage};
use super::store::model::{Lang, Task, MAX_SEQ};
use super::store::{Store, StoreError};
use super::translate::errors::TranslateError;
use super::Shell;
use crate::platform::paths;

/// 服务端最大请求体（同 Node `MAX_BODY`：20 张高分辨率原图的宽松上限）。
const MAX_BODY: usize = 256 * 1024 * 1024;

/// 支持的方向 —— 与 `config.mjs` 的 `TRANSLATE_DIRECTIONS` 逐条对应。
const TRANSLATE_DIRECTIONS: &[(&str, &str)] = &[("ja", "zh"), ("en", "zh")];

const MAX_TITLE_CHARS: usize = 200;
const MAX_AUTHOR_CHARS: usize = 100;

// ================================================================ 小工具（JS 语义对齐）

/// 权限拒绝（契约 §2.1：令牌错与 Origin 拒绝共用同一个码，不泄露是哪一项失败）。
fn perm_denied() -> StoreError {
    StoreError::new("PERMISSION_DENIED", "鉴权失败或来源不被允许", json!({}))
}

fn security_log(msg: &str) {
    eprintln!("[manga-service][security] {msg}");
}

/// 服务内部错误（Node 兜底分支的文案与形状：`errorEnvelope` 对非 ApiError 的产出）。
fn internal(reason: impl Into<String>) -> StoreError {
    StoreError::new("INTERNAL", "服务内部错误", json!({ "reason": reason.into() }))
}

fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string)
}

/// JS `String(value)`（用于把 JSON 值拼成文本；`null` 由调用方的 `?? ''` 处理）。
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_num_str(n),
        Value::String(s) => s.clone(),
        Value::Array(a) => {
            a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(",")
        }
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// JS `String(number)`：整数不带 `.0`（Rust 的 `Display` 对 f64 已同语义）。
fn js_num_str(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    match n.as_f64() {
        Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
        Some(f) => format!("{f}"),
        None => n.to_string(),
    }
}

/// JS `Number(value)`（够用即可：只用于 `seqs.map(Number)` 的成员判定）。
fn js_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                Some(0.0)
            } else {
                t.parse::<f64>().ok()
            }
        }
        _ => None,
    }
}

/// JS `Number.parseInt(text, 10)`；认不出 ⇒ `None`（对应 `NaN`）。
fn js_parse_int(s: &str) -> Option<f64> {
    let t = s.trim_start();
    let (sign, rest) = if let Some(r) = t.strip_prefix('-') {
        (-1.0, r)
    } else if let Some(r) = t.strip_prefix('+') {
        (1.0, r)
    } else {
        (1.0, t)
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<f64>().ok().map(|n| sign * n)
}

/// JS 字符串的 `.length` = **UTF-16 码元数**（不是码点数，也不是字节数）。
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// 查询串 → `(key, value)` 列表（保留顺序与首次出现；`+` 视作空格，同 `URLSearchParams`）。
fn query_pairs(uri: &Uri) -> Vec<(String, String)> {
    let Some(q) = uri.query() else { return Vec::new() };
    q.split('&')
        .filter(|s| !s.is_empty())
        .map(|pair| match pair.find('=') {
            Some(i) => (url_decode(&pair[..i]), url_decode(&pair[i + 1..])),
            None => (url_decode(pair), String::new()),
        })
        .collect()
}

fn query_get(uri: &Uri, key: &str) -> Option<String> {
    query_pairs(uri).into_iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// `URLSearchParams` 的解码：`+` → 空格 + 百分号解码（坏序列原样保留）。
fn url_decode(s: &str) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < b.len() => {
                let h = (b[i + 1] as char).to_digit(16);
                let l = (b[i + 2] as char).to_digit(16);
                match (h, l) {
                    (Some(h), Some(l)) => {
                        out.push(((h << 4) | l) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(b[i]);
                        i += 1;
                    }
                }
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// 取第一个**非 null** 的键（复刻 `a ?? b ?? c`：只跳过 null/undefined）。
fn first_non_null<'a>(obj: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    for k in keys {
        if let Some(v) = obj.get(*k) {
            if !v.is_null() {
                return Some(v);
            }
        }
    }
    None
}

/// 复刻 `readJsonBody`：`None` = 坏 JSON；`Some(None)` = 空体；`Some(Some(v))` = 解析成功。
fn read_json_body(body: &[u8]) -> Option<Option<Value>> {
    if body.is_empty() {
        return Some(None);
    }
    serde_json::from_slice::<Value>(body).ok().map(Some)
}

/// 复刻 `try { body.length ? JSON.parse(...) : null } catch { null }` —— 坏 JSON 当"没给"。
fn parse_json_lenient(body: &[u8]) -> Value {
    if body.is_empty() {
        return Value::Null;
    }
    serde_json::from_slice::<Value>(body).unwrap_or(Value::Null)
}

/// 复刻 `sourceOf(req)`：可选头 `X-Box-Client` 做来源归因（契约 §2）。
fn source_of(headers: &HeaderMap) -> String {
    let c = header_str(headers, "x-box-client").unwrap_or_default().to_lowercase();
    if c.starts_with("extension/") {
        "extension".to_string()
    } else if c.starts_with("box-desktop/") {
        "desktop".to_string()
    } else {
        "unknown".to_string()
    }
}

/// 复刻 `normalizeDirection`（只规范化、不校验）。
fn normalize_direction(v: &Value) -> Option<Lang> {
    let obj = v.as_object()?;
    let field = |k: &str| match obj.get(k) {
        None | Some(Value::Null) => String::new(),
        Some(x) => js_string(x),
    };
    let from = field("from").trim().to_lowercase();
    let to = field("to").trim().to_lowercase();
    if from.is_empty() || to.is_empty() {
        return None;
    }
    Some(Lang { from, to })
}

fn is_supported_direction(d: &Lang) -> bool {
    TRANSLATE_DIRECTIONS.iter().any(|(f, t)| *f == d.from && *t == d.to)
}

/// 复刻 `resolveTaskLang(payload)`：没给 ⇒ `None`；给了但不支持 ⇒ 400。
fn resolve_task_lang(payload: &Value) -> Result<Option<Lang>, StoreError> {
    let Some(lang) = payload.get("lang") else { return Ok(None) };
    if lang.is_null() {
        return Ok(None);
    }
    match normalize_direction(lang) {
        Some(d) if is_supported_direction(&d) => Ok(Some(d)),
        _ => Err(StoreError::new(
            "INVALID_TRANSLATE_LANG",
            "不支持的翻译方向",
            json!({
                "lang": lang,
                "supported": TRANSLATE_DIRECTIONS.iter().map(|(f, t)| format!("{f}>{t}")).collect::<Vec<_>>(),
            }),
        )),
    }
}

/// 复刻 `assertRootWritable`（§2.2 `DISK_FULL(507)`）：请求级落盘不可用 ⇒ 507。
fn assert_root_writable(shell: &Shell) -> Result<(), StoreError> {
    let root = shell.store_root();
    let probe = root.join(format!(
        ".write-probe-{}-{}",
        std::process::id(),
        super::store::model::now_ms()
    ));
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&probe);
            let why = e.to_string();
            security_log(&format!("落盘根目录不可写（DISK_FULL）：{}（{why}）", root.display()));
            Err(StoreError::new(
                "DISK_FULL",
                "落盘根目录不可写（磁盘满或权限不足），无法创建任务",
                json!({ "root": root.to_string_lossy(), "reason": why }),
            ))
        }
    }
}

fn lock(shell: &Shell) -> std::sync::MutexGuard<'_, Store> {
    super::lock_store(&shell.store)
}

/// 任务 id → `createView`（用于续做/返工/重试这类"建完要立刻回视图"的端点）。
fn create_view_of(s: &Store, task_id: &str) -> Result<Value, StoreError> {
    let t = s.get_task(task_id).ok_or_else(|| {
        StoreError::new("TASK_NOT_FOUND", format!("任务不存在：{task_id}"), json!({ "taskId": task_id }))
    })?;
    Ok(super::http::to_value(&s.create_view(t)))
}

// ================================================================ 入口

/// 已迁移端点的总入口。`routes::match_route` 命中且 `!should_forward` 时由外壳调用。
pub async fn dispatch(shell: Arc<Shell>, m: Match, uri: Uri, headers: HeaderMap, body: Body) -> Response {
    let bytes = match axum::body::to_bytes(body, MAX_BODY).await {
        Ok(b) => b,
        Err(e) => {
            return super::http::store_err(&StoreError::new(
                "INVALID_IMAGE",
                "请求体过大或读取失败",
                json!({ "limitBytes": MAX_BODY, "reason": e.to_string() }),
            ))
        }
    };
    route(&shell, m, &uri, &headers, &bytes).await
}

async fn route(shell: &Arc<Shell>, m: Match, uri: &Uri, headers: &HeaderMap, body: &[u8]) -> Response {
    let p = &m.params;
    match m.def.id {
        // ---------------------------------------------------------------- tasks
        "POST /api/v1/tasks" => create_task(shell, headers, body).await,
        "GET /api/v1/tasks" => task_list(shell, uri),
        "POST /api/v1/tasks/delete" => delete_tasks(shell, body),
        "GET /api/v1/tasks/{taskId}" => task_detail(shell, &p[0], uri),
        "POST /api/v1/tasks/{taskId}/batches" => append_batch(shell, headers, &p[0], body).await,
        "GET /api/v1/tasks/{taskId}/events" => sse(shell, &p[0], headers, uri),
        "POST /api/v1/tasks/{taskId}/cancel" => cancel(shell, &p[0]).await,
        "POST /api/v1/tasks/{taskId}/retry" => retry(shell, &p[0]).await,
        // ---------------------------------------------------------------- queue
        "GET /api/v1/queue" => queue(shell),
        // ---------------------------------------------------------------- library
        "GET /api/v1/library" => library_index(shell),
        "POST /api/v1/library/create" => library_create(shell, body),
        "GET /api/v1/library/{name}/files/{seq}" => library_file(shell, &p[0], &p[1], uri),
        "GET /api/v1/library/{book}/chapters/{no}/files/{seq}" => {
            chapter_file(shell, &p[0], &p[1], &p[2], uri)
        }
        "GET /api/v1/library/{book}/chapters/{no}/resume" => chapter_resume_plan(shell, &p[0], &p[1]),
        "POST /api/v1/library/{book}/chapters/{no}/resume" => {
            task_launcher(shell, headers, body, DirOf::Chapter(&p[0], &p[1]), Build::Resume).await
        }
        "GET /api/v1/library/{book}/chapters/{no}/retranslate" => {
            chapter_retranslate_plan(shell, &p[0], &p[1])
        }
        "POST /api/v1/library/{book}/chapters/{no}/retranslate" => {
            task_launcher(shell, headers, body, DirOf::Chapter(&p[0], &p[1]), Build::Retranslate).await
        }
        "POST /api/v1/library/{book}/chapters/{no}/renumber" => {
            chapter_renumber(shell, &p[0], &p[1], body).await
        }
        "GET /api/v1/library/{name}/meta" => library_meta(shell, &p[0]),
        "POST /api/v1/library/{name}/meta" => library_meta_write(shell, &p[0], body),
        "GET /api/v1/library/{name}/cover" => library_cover_file(shell, &p[0]),
        "POST /api/v1/library/{name}/cover" => library_cover(shell, headers, &p[0], body),
        "DELETE /api/v1/library/{name}/cover" => library_cover_delete(shell, &p[0]),
        "POST /api/v1/library/{name}/merge" => library_merge(shell, &p[0], body).await,
        "POST /api/v1/library/{name}/reveal" => library_reveal(shell, &p[0]),
        "POST /api/v1/library/{name}/delete" => library_delete(shell, &p[0], body),
        "POST /api/v1/library/{name}/unhide" => library_unhide(shell, &p[0]),
        "GET /api/v1/library/{name}/retranslate" => retranslate_plan(shell, &p[0]),
        "POST /api/v1/library/{name}/retranslate" => {
            task_launcher(shell, headers, body, DirOf::Comic(&p[0]), Build::Retranslate).await
        }
        "GET /api/v1/library/{name}/resume" => resume_plan(shell, &p[0]),
        "POST /api/v1/library/{name}/resume" => {
            task_launcher(shell, headers, body, DirOf::Comic(&p[0]), Build::Resume).await
        }
        // ---------------------------------------------------------------- translate
        "POST /api/v1/translate/text" => translate_text(body).await,
        "POST /api/v1/translate/stream" => translate_stream(body).await,
        "GET /api/v1/translate/options" => translate_options(),
        "POST /api/v1/translate/settings" => translate_settings(body),
        "POST /api/v1/translate/credentials" => translate_credentials(body),
        // ---------------------------------------------------------------- health / engine（F5.6）
        "GET /health" | "GET /api/v1/health" => health(shell).await,
        "GET /api/v1/engine/status" => engine_status(shell).await,
        "GET /api/v1/engine/runtime" => engine_runtime(),
        "GET /api/v1/engine/options" => engine_options(shell).await,
        "POST /api/v1/engine/settings" => engine_settings(shell, body).await,
        "POST /api/v1/engine/unload" => engine_unload(shell).await,
        "POST /api/v1/engine/models/verify" => models_verify(shell).await,
        "POST /api/v1/engine/models/download" => models_download(shell, uri).await,
        "POST /api/v1/engine/models/download/pause" => models_download_pause(shell).await,
        // 声明为 Migrated 但没有实现 —— 由 `check:routes` 的 `ROUTES.migrated` 断言抓出来。
        other => super::http::store_err(&StoreError::new(
            "INTERNAL",
            &format!("端点 {other} 在路由表里声明为已迁移，但尚无实现（F5 迁移进行中）"),
            json!({ "route": other }),
        )),
    }
}

// ================================================================ translate 组（F5.5）
//
// 逐条对齐 Node（`service/src/server.mjs` 的 `handleTranslate*`）：路由层只做搬运
// —— 读体、调门面、出信封 / SSE。业务全在 `mangasvc/translate/`（门面）。

/// 翻译域错误 → 契约信封（`translateApiError` 的对应物）。
fn translate_err(e: &TranslateError) -> Response {
    let (status, body) = super::translate::error_body(e);
    super::http::json_body(status, &body)
}

/// 读体 → `Value`：空体 = `null`（由 `translate_body_of` 视作 `{}`）；非法 JSON = 信封。
fn translate_parse_body(raw: &[u8], code: &str) -> Result<Value, Response> {
    if raw.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice::<Value>(raw).map_err(|_| {
        translate_err(&TranslateError::new(code, "请求体不是合法 JSON", json!({})))
    })
}

/// `translateBodyOf`：必须是 JSON 对象（`null`/空体按 `{}`）。
fn translate_body_of(v: &Value) -> Result<Value, TranslateError> {
    if v.is_null() {
        return Ok(json!({}));
    }
    if !v.is_object() {
        let shape = match v {
            Value::Array(_) => "array",
            Value::String(_) => "string",
            Value::Number(_) => "number",
            Value::Bool(_) => "boolean",
            _ => "object",
        };
        return Err(TranslateError::new(
            "TRANSLATE_INVALID_INPUT",
            format!("请求体必须是 JSON 对象，收到 {shape}"),
            json!({ "received": shape }),
        ));
    }
    Ok(v.clone())
}

/// `POST /api/v1/translate/text` —— 普通文本翻译（整体）。
async fn translate_text(body: &[u8]) -> Response {
    let v = match translate_parse_body(body, "TRANSLATE_INVALID_INPUT") {
        Ok(v) => v,
        Err(r) => return r,
    };
    let b = match translate_body_of(&v) {
        Ok(b) => b,
        Err(e) => return translate_err(&e),
    };
    match super::translate::translate_text(&b).await {
        Ok(out) => super::http::json_body(200, &out),
        Err(e) => translate_err(&e),
    }
}

/// 单条 SSE 事件序列化 —— 与 `service/src/manga/sse.mjs::formatSseEvent` 逐字节同形。
fn sse_event(id: u64, event: &str, data: &Value) -> String {
    format!("id: {id}\nevent: {event}\ndata: {data}\n\n")
}

/// `POST /api/v1/translate/stream` —— 大模型翻译（流式，SSE 事件 translate.delta/.done/.error）。
///
/// 三条硬顺序 / 硬纪律（同 Node）：
///  ① **先 writeHead 再调门面**：头一旦发出，HTTP 状态就定了 —— 此后一切结果（含校验失败）
///     都以 translate.* 事件表达。坏 JSON / 非对象体在头之前拦（回 400）。
///  ② **背压**：delta 经有界通道传递，下游慢 ⇒ 门面的 `send().await` 挂住 ⇒ 上游读得慢。
///  ③ **顺序不能反**：先 `translate.error` 再结束流。
async fn translate_stream(body: &[u8]) -> Response {
    let v = match translate_parse_body(body, "TRANSLATE_INVALID_INPUT") {
        Ok(v) => v,
        Err(r) => return r,
    };
    let b = match translate_body_of(&v) {
        Ok(b) => b,
        Err(e) => return translate_err(&e),
    };

    // 头先发：此后一切结果都以 translate.* 事件表达
    let (delta_tx, mut delta_rx) = tokio::sync::mpsc::channel::<String>(8);
    let (ev_tx, ev_rx) = tokio::sync::mpsc::channel::<String>(16);
    let consumer_ev = ev_tx.clone();
    let consumer = tokio::spawn(async move {
        let mut ids = 0u64;
        let mut after_chars = 0usize;
        while let Some(d) = delta_rx.recv().await {
            ids += 1;
            after_chars += d.encode_utf16().count();
            let ev = sse_event(ids, "translate.delta", &json!({ "text": d }));
            if consumer_ev.send(ev).await.is_err() {
                break;
            }
        }
        (ids, after_chars)
    });
    let driver = tokio::spawn(async move {
        let result = super::translate::translate_stream(&b, delta_tx).await;
        let (ids, after_chars) = consumer.await.unwrap_or((0, 0));
        match result {
            Ok(out) => {
                let mut data = Map::new();
                data.insert("text".into(), out.get("text").cloned().unwrap_or(json!("")));
                if let Some(lt) = out.get("langType") {
                    data.insert("langType".into(), lt.clone());
                }
                let _ = ev_tx.send(sse_event(ids + 1, "translate.done", &Value::Object(data))).await;
            }
            Err(e) => {
                let data = json!({
                    "code": e.code,
                    "message": e.message,
                    "afterChars": after_chars,
                });
                let _ = ev_tx.send(sse_event(ids + 1, "translate.error", &data)).await;
            }
        }
    });
    // 驱动任务 detach：`ev_tx` 随它结束而释放 ⇒ 事件流自然收尾。
    drop(driver);

    let stream = futures_util::stream::unfold(ev_rx, |mut rx| async move {
        rx.recv().await.map(|s| (Ok::<Bytes, std::io::Error>(Bytes::from(s)), rx))
    });
    let mut resp = Response::new(Body::from_stream(stream));
    let h = resp.headers_mut();
    h.insert("content-type", HeaderValue::from_static("text/event-stream; charset=utf-8"));
    h.insert("cache-control", HeaderValue::from_static("no-cache, no-transform"));
    h.insert("connection", HeaderValue::from_static("keep-alive"));
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    resp
}

/// `GET /api/v1/translate/options` —— 设置页 / 翻译面板的取值来源。
fn translate_options() -> Response {
    match super::translate::options_view() {
        Ok(v) => super::http::json_body(200, &v),
        Err(e) => translate_err(&e),
    }
}

/// `POST /api/v1/translate/settings` —— 非密钥设置补丁（白名单 strict）。
/// 错误信封走 `INVALID_SETTING`（与 `/engine/settings` 同款）。
fn translate_settings(body: &[u8]) -> Response {
    let v = match translate_parse_body(body, "INVALID_SETTING") {
        Ok(v) => v,
        Err(r) => return r,
    };
    match super::translate::save_settings(&v) {
        Ok(out) => super::http::json_body(200, &out),
        Err(e) => translate_err(&e),
    }
}

/// `POST /api/v1/translate/credentials` —— 保存平台密钥（**只写不读**）。
fn translate_credentials(body: &[u8]) -> Response {
    let v = match translate_parse_body(body, "TRANSLATE_INVALID_INPUT") {
        Ok(v) => v,
        Err(r) => return r,
    };
    let b = match translate_body_of(&v) {
        Ok(b) => b,
        Err(e) => return translate_err(&e),
    };
    match super::translate::save_credentials(&b) {
        Ok(out) => super::http::json_body(200, &out),
        Err(e) => translate_err(&e),
    }
}

// ================================================================ engine / health 组（F5.6）
//
// 逐条对齐 Node：`healthView` / `engineStatusView` / `engineOptionsView` /
// `handleEngineSettings` / `handleEngineUnload` / `handleModelsVerify` / `handleModelsDownload`。
// 判定与合成全在 `mangasvc/engine/state.rs`（那里是「硬件 ⊕ 用户设置 ⊕ 引擎实况」的唯一一处），
// 本段只做**读体 → 调门面 → 出信封**。

/// `GET /health` · `GET /api/v1/health`（`healthView`）—— 心跳：高频、字段少、免鉴权。
async fn health(shell: &Arc<Shell>) -> Response {
    let sc = super::sidecar::sidecar_state(shell).await;
    let (root, started_at) = {
        let s = crate::mangasvc::lock_store(&shell.store);
        (s.root.to_string_lossy().into_owned(), s.started_at.clone())
    };
    // `sidecar` 9 键（§5.1）。**向后兼容**：插件端口探测只认 `service === "manga-service"`，
    // 不依赖任何新增字段（§5.1 明写）。反证开关可把它退回 ver1.0 的 3 键，
    // 用来证明"9 键"这条断言咬的确实是新增的那 6 个字段。
    let sidecar = if shell.engine.contract_refutes.sidecar_legacy3 {
        json!({ "state": sc.get("state"), "port": sc.get("port"), "engine": sc.get("engine") })
    } else {
        sc.clone()
    };
    let body = json!({
        "status": super::engine::state::EngineState::health_status(&sc),
        "service": super::SERVICE_NAME,
        "version": super::SERVICE_VERSION,
        "apiVersion": super::API_VERSION,
        "sidecar": sidecar,
        "rootDir": root,
        "startedAt": started_at,
    });
    super::http::json_body(200, &body)
}

/// `GET /engine/status`（`engineStatusView`）—— 体检报告：低频、字段多、**需令牌**。
async fn engine_status(shell: &Arc<Shell>) -> Response {
    let es = &shell.engine;
    let sc = super::sidecar::sidecar_state(shell).await;
    let snap = shell.llm_snapshot();
    super::http::json_body(200, &es.engine_status_view(&sc, &snap))
}

/// `GET /engine/runtime`（B2）—— 运行时就绪检测：四项逐项独立报真伪，`detail` 带绝对路径、
/// `fix` 给装法。与 `/engine/status` 的分工：那个是「引擎现在怎么样」（进程态），这个是
/// 「引擎凭什么能起来」（装配态）。只读，不起子进程 —— 诊断视图可被反复打开。
fn engine_runtime() -> Response {
    super::http::json_body(200, &super::engine::runtime_probe::runtime_view())
}

/// `GET /engine/options`（`engineOptionsView`）—— 设置页两小节的**全部取值来源**。
///
/// 与 `/engine/status` 的分工：那个是**体检报告**（引擎现在怎么样），这个是**选项清单**
/// （用户能选什么、选完会发生什么）。两者都读同一份 `resolve_accel()` / `tier_options()`，
/// 所以不可能出现"诊断说 mps、设置页说 cuda"。
async fn engine_options(shell: &Arc<Shell>) -> Response {
    let sc = super::sidecar::sidecar_state(shell).await;
    super::http::json_body(200, &shell.engine.options_view(&sc))
}

/// `POST /engine/settings`（`handleEngineSettings`）—— 保存设置（白名单校验 → 写盘 → 报"要不要重启"）。
async fn engine_settings(shell: &Arc<Shell>, body: &[u8]) -> Response {
    let es = &shell.engine;
    let patch: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice::<Value>(body) {
            Ok(v) => v,
            Err(e) => {
                return super::http::json_body(
                    400,
                    &json!({ "error": { "code": "INVALID_SETTING", "message": format!("请求体不是合法 JSON：{e}"), "details": { "bytes": body.len() } } }),
                )
            }
        }
    };

    // 🔴 **先格式、后能力**，顺序不能反（见 `EngineState::guard_settings` 的注释）。
    let clean = match super::engine::settings::assert_patch(&patch, es.refutes.no_whitelist) {
        Ok(m) => m,
        Err(e) => return super::http::json_body(400, &json!({ "error": { "code": e.code, "message": e.message, "details": e.details } })),
    };
    if let Err(e) = es.guard_settings(&clean) {
        return super::http::store_err(&e);
    }

    let clean_val = Value::Object(clean);
    let result = match super::engine::settings::write_engine_settings(&es.settings_file, &clean_val, es.refutes.no_whitelist) {
        Ok(r) => r,
        Err(e) => return super::http::json_body(400, &json!({ "error": { "code": e.code, "message": e.message, "details": e.details } })),
    };

    // 🔴 即时生效的那一档：**重建空闲看护**（`idle_ms` 是构造参数，改不了就换一个）。
    //    不重建的话，界面上「空闲卸载 LLM」改完显示新值、看护仍按旧值走 —— 一个界面上
    //    完全看不出来的偏差。视觉那一档不在此列（`RESTART_REQUIRED_KEYS`）。
    let mut applied_now: Vec<String> = Vec::new();
    if result.changed.iter().any(|k| k == "idleLlmMin") {
        crate::mangasvc::restart_idle_watcher(shell);
        applied_now.push("idleLlmMin".to_string());
        let next = es.saved_idle();
        println!(
            "[manga-service] 空闲卸载 LLM 阈值已更新为 {} min（看护已重建，即时生效）",
            (next.llm_ms as f64 / 60_000.0).round() as i64
        );
    }

    let restart_keys: Vec<String> = result
        .changed
        .iter()
        .filter(|k| super::engine::settings::RESTART_REQUIRED_KEYS.contains(&k.as_str()))
        .cloned()
        .collect();
    super::http::json_body(
        200,
        &json!({
            "ok": true,
            "settings": result.settings,
            "changed": result.changed,
            "restartRequired": result.restart_required,
            "restartRequiredKeys": restart_keys,
            "appliedNow": applied_now,
        }),
    )
}

/// `POST /engine/unload`（`handleEngineUnload`）—— 强制释放 ③ LLM（《09》§6.2 的三个操作之一）。
///
/// ⚠️ 它**不是**"重启"也不是"停止服务"：③ 的归属方是 manga-service（《04》§9.1），所以这件事我们
///    真的做得到、也真的只影响 ③。② 与 ① 一根毫毛都不动。
/// ③ 本来就没在跑 ⇒ **不是错误**（§9.4 空闲卸载是设计行为），如实报 `unloaded:false` + 原因。
async fn engine_unload(shell: &Arc<Shell>) -> Response {
    let Some(llm) = shell.llm_supervisor() else {
        let body = json!({ "ok": true, "unloaded": false, "reason": "③ 当前未在运行（state=stopped），无需释放", "state": "stopped" });
        return super::http::json_body(200, &body);
    };
    let before = llm.snapshot();
    if before.state != "running" {
        let body = json!({
            "ok": true,
            "unloaded": false,
            "reason": format!("③ 当前未在运行（state={}），无需释放", before.state),
            "state": before.state,
        });
        return super::http::json_body(200, &body);
    }
    llm.stop("用户在诊断视图里强制释放", 8000);
    let after = llm.snapshot();
    let body = json!({ "ok": true, "unloaded": after.state != "running", "state": after.state });
    super::http::json_body(200, &body)
}

/// `POST /engine/models/verify`（`handleModelsVerify`）—— 「校验完整性」。
///
/// 🔴 它做的是**真算 sha256**，不是"看一眼文件在不在"：调用
///    `mangasvc --fetch-models --check`（A3d 之前是 `node engine/scripts/fetch-models.mjs --check`），
///    走的是 `verifyModels()` —— `--check` 分支**不联网、不删任何东西**。
///    这是"校验完整性"唯一诚实的实现：一个只判存在的校验会给用户"没问题"的假结论。
///
/// 返回 `{ ok:false, ... }` 而非 HTTP 错误：**"校验完成，发现不符"是一次成功调用**，
/// 用 4xx/5xx 表达会让界面把它显示成"操作失败"，而用户真正需要看到的是那份不符清单。
async fn models_verify(shell: &Arc<Shell>) -> Response {
    let es = &shell.engine;
    let runner = es.verify_runner();
    let model_root = es.model_root.to_string_lossy().into_owned();
    let manifest = es.model_manifest.to_string_lossy().into_owned();
    let started = now_ms();

    let (code, stdout, stderr, timeout) = tokio::task::spawn_blocking(move || {
        run_verify_child(&runner, &manifest, &model_root)
    })
    .await
    .unwrap_or((-1, String::new(), "校验子进程未能启动".to_string(), false));

    let text = format!("{stdout}\n{stderr}");
    let re = regex::Regex::new(r"校验：通过 (\d+) / 不符 (\d+) / 缺失 (\d+)（共 (\d+)）").unwrap();
    let problems: Vec<String> = text
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| l.starts_with('✗'))
        .collect();

    let Some(m) = re.captures(&text) else {
        // 连那句汇总都没打出来 ⇒ 脚本没跑到校验段（解释器错、脚本被改、路径不对……）
        // 这时**绝不能**报"通过 0/不符 0/缺失 0 ⇒ 一切正常"。如实报"没跑起来"。
        let mut all: Vec<&str> = text.lines().collect();
        let tail: Vec<&str> = all.split_off(all.len().saturating_sub(8));
        return super::http::store_err(&StoreError::new(
            "INTERNAL",
            "模型校验脚本未产出结果（可能是脚本缺失或运行环境异常）",
            json!({ "exitCode": code, "timeout": timeout, "tail": tail.join("\n") }),
        ));
    };
    let num = |i: usize| m.get(i).and_then(|x| x.as_str().parse::<i64>().ok()).unwrap_or(0);
    let (pass, bad, missing, total) = (num(1), num(2), num(3), num(4));

    // HF 缓存布局那一节（只在清单含 `hf` 条目时才有）—— 它才是"文件都在、引擎仍加载不了"的
    // 判据，所以必须**一并计入 ok**：只比文件存在/哈希会给一个"绿着但跑不起来"的假结论（D-99）。
    let re_hf = regex::Regex::new(r"HF 缓存布局：可解析 (\d+) / 不可解析 (\d+)（共 (\d+)）").unwrap();
    let (hf_broken, hf_total) = match re_hf.captures(&text) {
        Some(c) => (
            c.get(2).and_then(|x| x.as_str().parse::<i64>().ok()).unwrap_or(0),
            c.get(3).and_then(|x| x.as_str().parse::<i64>().ok()).unwrap_or(0),
        ),
        None => (0, 0),
    };

    let body = json!({
        "ok": bad == 0 && missing == 0 && hf_broken == 0,
        "pass": pass, "bad": bad, "missing": missing, "total": total,
        "hf": { "resolvable": hf_total - hf_broken, "broken": hf_broken, "total": hf_total },
        "problems": problems,
        "rootDir": es.model_root.to_string_lossy(),
        "exitCode": code,
        "timeout": timeout,
        "elapsedMs": now_ms() - started,
        // 校验用的到底是哪份清单 —— 不报这一行的话，"通过"可能是拿一份被裁过的清单比出来的
        "manifest": es.model_manifest.to_string_lossy(),
    });
    super::http::json_body(200, &body)
}

/// `POST /engine/models/download`（`handleModelsDownload`）—— 「重新下载模型」。
///
/// 语义是**启动**而非**等待**：立即返回 `{ ok, download }`，进度看 `/engine/status`。
/// 🔴 已经在跑 ⇒ **409**（`DOWNLOAD_IN_PROGRESS`），不返回 200「已经在下了」：
///    后者让界面以为这次点击生效了，而用户真正需要知道的是"我这次什么都没触发"。
///
/// `?fresh=1` = 屏上「重新下载」（清 `.part` 从头下）；缺省 = 「继续下载」/ 首次（续传）。
async fn models_download(shell: &Arc<Shell>, uri: &Uri) -> Response {
    let fresh = query_get(uri, "fresh").map(|v| v == "1" || v == "true").unwrap_or(false);
    match shell.engine.start_model_download(fresh) {
        Ok(view) => super::http::json_body(200, &json!({ "ok": true, "started": true, "download": view })),
        Err(e) => super::http::store_err(&e),
    }
}

/// `POST /engine/models/download/pause` —— 「暂停下载」。
///
/// 语义：杀掉下载子进程，`.part` 留在盘上 ⇒ 下次「继续下载」接着下（Range 续传）。
/// 🔴 与启动端点对称：没在下就 **409**（`DOWNLOAD_NOT_RUNNING`），不返回 200 假装暂停成功。
async fn models_download_pause(shell: &Arc<Shell>) -> Response {
    match shell.engine.pause_download() {
        Ok(view) => super::http::json_body(200, &json!({ "ok": true, "download": view })),
        Err(e) => super::http::store_err(&e),
    }
}

fn now_ms() -> i64 {
    super::store::model::now_ms()
}

/// 跑 `mangasvc --fetch-models --check` 子进程（**同步**；调用方包在 `spawn_blocking` 里）。
///
/// `maxBuffer` 用**行收集**而不是 `execFile` 的默认 1 MB：模型清单里有几十项，全不符时会打
/// 几十行 —— 撞上 maxBuffer 的失败形态是 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`，一个与"模型坏了"
/// 毫无关系、却同样表现为"校验失败"的错误。手写收集就没有这个上限。
/// `timeout_ms` 给 15 min：真算 5–8 GB 的 sha256 在机械盘上可以很慢，但它**必须有个头**，
/// 否则界面会永远转圈（且没有任何东西会告诉用户它卡住了）。
fn run_verify_child(runner: &Path, manifest: &str, model_root: &str) -> (i64, String, String, bool) {
    let mut cmd = std::process::Command::new(runner);
    cmd.arg("--fetch-models").arg("--check");
    // 🔴 清单路径**显式**给：默认虽是同一份（`<仓库>/engine/models.manifest.json`），
    //    但"校验用的是哪份清单"正是 `models/verify` 要如实回传的字段 —— 靠默认值对齐
    //    等于把两处事实源分开维护，搬一次路径就静默错开。
    cmd.arg("--manifest").arg(manifest);
    cmd.arg("--root").arg(model_root);
    cmd.env("MIAO_MODEL_ROOT", model_root);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // 执行体（`mangasvc`）是控制台程序，父进程（mangasvc 本体）无控制台 ⇒ 不隐藏会闪黑框。
    hide_console(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        // 🔴 消息里必须**带上路径**：执行体不在盘上时，用户（和我们）看到的若只是
        //    「系统找不到指定的文件」这一句，根本不知道它在找谁 —— 而"找的是哪个执行体"
        //    正是 C2 要答的问题。文案与 Node 版（`server.mjs::runVerifyChild`）**逐字一致**。
        Err(e) => {
            return (
                -1,
                String::new(),
                format!("无法启动执行体 {}：{e}", runner.display()),
                false,
            )
        }
    };

    // 读线程**必须**先起：管道满时子进程会写阻塞，而我们在下面等它退出 ⇒ 死锁。
    let collect = |r: Option<Box<dyn std::io::Read + Send>>| -> std::sync::Arc<std::sync::Mutex<String>> {
        let out = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        if let Some(mut r) = r {
            let o = out.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match r.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if let Ok(mut s) = o.lock() {
                                s.push_str(&String::from_utf8_lossy(&buf[..n]));
                            }
                        }
                    }
                }
            });
        }
        out
    };
    let so = collect(child.stdout.take().map(|x| Box::new(x) as Box<dyn std::io::Read + Send>));
    let se = collect(child.stderr.take().map(|x| Box::new(x) as Box<dyn std::io::Read + Send>));

    let deadline = now_ms() + 900_000;
    let mut timeout = false;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().map(|n| n as i64).unwrap_or(-1),
            Ok(None) => {}
            Err(_) => break -1,
        }
        if now_ms() > deadline {
            timeout = true;
            let _ = child.kill();
            let _ = child.wait();
            break -1;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    // 给读线程一拍把管道里的尾巴收完（子进程已退出 ⇒ 读到 EOF 即返回）。
    std::thread::sleep(Duration::from_millis(60));
    let stdout = so.lock().map(|s| s.clone()).unwrap_or_default();
    let stderr = se.lock().map(|s| s.clone()).unwrap_or_default();
    (code, stdout, stderr, timeout)
}

/// `translateBodyOf` 之外的通用 JSON 体（空体 = `{}`）—— engine 组三个 POST 共用。
#[allow(dead_code)]
fn engine_parse_body(raw: &[u8], code: &str) -> Result<Value, Response> {
    if raw.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice::<Value>(raw)
        .map_err(|_| super::http::json_body(400, &json!({ "error": { "code": code, "message": "请求体不是合法 JSON", "details": {} } })))
}

// ================================================================ tasks

/// `POST /tasks`（`handleCreateTask`）—— multipart 建单。
async fn create_task(shell: &Shell, headers: &HeaderMap, body: &[u8]) -> Response {
    if let Err(e) = assert_sidecar_ready(shell).await {
        return super::http::store_err(&e);
    }
    let ct = header_str(headers, "content-type").unwrap_or_default();
    let clen = header_str(headers, "content-length");
    let (payload, images, order) = match multipart::parse_upload_request(&ct, clen.as_deref(), body) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    // comicName 缺失 ⇒ Null ⇒ COMIC_NAME_REQUIRED（与 Node `normalizeComicName(undefined)` 同码）。
    let comic_raw = payload.get("comicName").cloned().unwrap_or(Value::Null);
    let dir_name = match names::normalize_comic_name(&comic_raw) {
        Ok(n) => n,
        Err(e) => return super::http::store_err(&e),
    };
    // §8.2 校验点 2：请求校验期就断言，绝不等到落盘期才失败
    if !super::store::pure::is_safe_dir_name(&dir_name) {
        security_log(&format!("拒绝路径越界的漫画名（§8.2 校验点 2）：{:?}", dir_name));
        return super::http::store_err(&perm_denied());
    }
    if let Err(e) = assert_root_writable(shell) {
        return super::http::store_err(&e);
    }
    let lang = match resolve_task_lang(&payload) {
        Ok(l) => l,
        Err(e) => return super::http::store_err(&e),
    };
    let cp = CreatePayload {
        comic_name: comic_raw.as_str().unwrap_or("").to_string(),
        normalized_name: dir_name,
        lang,
        translator: payload.get("translator").and_then(|v| v.as_str()).map(str::to_string),
        client_task_ref: payload.get("clientTaskRef").and_then(|v| v.as_str()).map(str::to_string),
        idempotency_key: payload.get("idempotencyKey").and_then(|v| v.as_str()).map(str::to_string),
    };
    let imgs: Vec<InputImage> =
        images.iter().map(|i| InputImage { data: i.data.clone(), filename: i.filename.clone() }).collect();

    let (replay, view) = {
        let mut s = lock(shell);
        let outcome = match s.create_task(&cp, &imgs, &order, Some(source_of(headers))) {
            Ok(o) => o,
            Err(e) => return super::http::store_err(&e),
        };
        match create_view_of(&s, &outcome.task_id) {
            Ok(v) => (outcome.replay, v),
            Err(e) => return super::http::store_err(&e),
        }
    };
    shell.notify_drain();
    // IDEMPOTENT_REPLAY：HTTP 200（重放）vs 201（新建），响应体不做任何额外标注
    super::http::json_body(if replay { 200 } else { 201 }, &view)
}

/// `POST /tasks/{taskId}/batches`（`handleAppendBatch`）。
async fn append_batch(shell: &Shell, headers: &HeaderMap, task_id: &str, body: &[u8]) -> Response {
    if let Err(e) = assert_sidecar_ready(shell).await {
        return super::http::store_err(&e);
    }
    let ct = header_str(headers, "content-type").unwrap_or_default();
    let clen = header_str(headers, "content-length");
    let (payload, images, order) = match multipart::parse_upload_request(&ct, clen.as_deref(), body) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    // §8.2 校验点 2：不带 comicName，用任务上已存的归一化名再断言一次
    let existing = match lock(shell).get_task(task_id).map(|t| t.dir_name.clone()) {
        Some(d) => d,
        None => {
            return super::http::store_err(&StoreError::new(
                "TASK_NOT_FOUND",
                format!("任务不存在：{task_id}"),
                json!({ "taskId": task_id }),
            ))
        }
    };
    if !super::store::pure::is_safe_dir_name(&existing) {
        security_log(&format!("拒绝路径越界的漫画名（§8.2 校验点 2）：{:?}", existing));
        return super::http::store_err(&perm_denied());
    }
    // 方向是**任务级**属性 ⇒ 追加批次给了就必须与任务一致（不一致 = 后 20 张换个玩法）。
    let lang = match resolve_task_lang(&payload) {
        Ok(l) => l,
        Err(e) => return super::http::store_err(&e),
    };
    let current = lock(shell).get_task(task_id).map(|t| t.lang.clone());
    if let (Some(incoming), Some(cur)) = (lang.clone(), current.clone()) {
        if incoming.from != cur.from || incoming.to != cur.to {
            return super::http::store_err(&StoreError::new(
                "INVALID_TRANSLATE_LANG",
                "追加批次的翻译方向必须与任务一致",
                json!({ "task": cur, "incoming": incoming }),
            ));
        }
    }
    let imgs: Vec<InputImage> =
        images.iter().map(|i| InputImage { data: i.data.clone(), filename: i.filename.clone() }).collect();
    let view = {
        let mut s = lock(shell);
        let outcome = match s.append_batch(task_id, &payload_cp(&payload), &imgs, &order) {
            Ok(o) => o,
            Err(e) => return super::http::store_err(&e),
        };
        match create_view_of(&s, &outcome.task_id) {
            Ok(v) => v,
            Err(e) => return super::http::store_err(&e),
        }
    };
    shell.notify_drain();
    super::http::json_body(200, &view)
}

/// 追加批次只用到 `payload.idempotencyKey`（其余字段 Node 的 `appendBatch` 会忽略）。
fn payload_cp(payload: &Value) -> CreatePayload {
    CreatePayload {
        idempotency_key: payload.get("idempotencyKey").and_then(|v| v.as_str()).map(str::to_string),
        ..Default::default()
    }
}

/// `GET /tasks/{taskId}`（`handleTaskDetail`）。
fn task_detail(shell: &Shell, task_id: &str, uri: &Uri) -> Response {
    let items_from = query_get(uri, "itemsFrom").and_then(|s| js_parse_int(&s)).map(|n| n as i64);
    let items_to = query_get(uri, "itemsTo").and_then(|s| js_parse_int(&s)).map(|n| n as i64);
    let s = lock(shell);
    let task: &Task = match s.get_task(task_id) {
        Some(t) => t,
        None => {
            return super::http::store_err(&StoreError::new(
                "TASK_NOT_FOUND",
                format!("任务不存在：{task_id}"),
                json!({ "taskId": task_id }),
            ))
        }
    };
    let view = s.detail_view(task, items_from, items_to);
    super::http::json_body(200, &super::http::to_value(&view))
}

/// `POST /tasks/{taskId}/cancel`（`handleCancel`）。
///
/// 🔴 两段式（D-150）：Node 在 running 态 `await this._settled(task, 30000)` —— **等当前张跑完**
/// 再收尾（A10 的「等当前张跑完 / 已落盘保留」就来自这里）。同步模型里不能在持锁状态下干等
/// （drain 正握着同一把锁跑那一张 ⇒ 死锁），故这里**放锁**轮询任务是否转入终态，再取最终结果。
async fn cancel(shell: &Shell, task_id: &str) -> Response {
    let step = {
        let mut s = lock(shell);
        match s.cancel_task_step(task_id) {
            Ok(st) => st,
            Err(e) => return super::http::store_err(&e),
        }
    };
    let res = match step {
        CancelStep::Done(r) => r,
        CancelStep::InFlight => {
            // 放锁等待：drain 跑完当前张后会看到 `cancelRequested` 并收尾为 canceled。
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            loop {
                if lock(shell).is_terminal(task_id) {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            match lock(shell).finish_cancel(task_id) {
                Ok(r) => r,
                Err(e) => return super::http::store_err(&e),
            }
        }
    };
    super::http::json_body(200, &super::http::to_value(&res))
}

/// `POST /tasks/{taskId}/retry`（`handleRetry`）。
async fn retry(shell: &Shell, task_id: &str) -> Response {
    if let Err(e) = assert_sidecar_ready(shell).await {
        return super::http::store_err(&e);
    }
    if let Err(e) = assert_root_writable(shell) {
        return super::http::store_err(&e);
    }
    let view = {
        let mut s = lock(shell);
        let outcome = match s.retry_task(task_id) {
            Ok(o) => o,
            Err(e) => return super::http::store_err(&e),
        };
        match create_view_of(&s, &outcome.task_id) {
            Ok(v) => v,
            Err(e) => return super::http::store_err(&e),
        }
    };
    shell.notify_drain();
    super::http::json_body(200, &view)
}

/// `GET /tasks`（`handleTaskList`）—— 队列页的列表数据源（契约外增量端点，G-04）。
fn task_list(shell: &Shell, uri: &Uri) -> Response {
    let status = query_get(uri, "status").filter(|s| !s.is_empty()).unwrap_or_else(|| "all".to_string());
    let limit = match query_get(uri, "limit") {
        None => None,
        Some(text) => match js_parse_int(&text) {
            Some(n) if n > 0.0 => Some(n as i64),
            _ => {
                return super::http::store_err(&StoreError::new(
                    "INVALID_IMAGE",
                    "limit 必须是正整数",
                    json!({ "limit": text }),
                ))
            }
        },
    };
    let s = lock(shell);
    let view = s.task_list_view(Some(&status), limit);
    super::http::json_body(200, &super::http::to_value(&view))
}

/// `POST /tasks/delete`（`handleDeleteTasks`）—— 队列页多选删除（契约外增量端点）。
fn delete_tasks(shell: &Shell, body: &[u8]) -> Response {
    let parsed = parse_json_lenient(body);
    let task_ids = parsed.get("taskIds").cloned().unwrap_or(Value::Null);
    let ok = task_ids.as_array().map(|a| !a.is_empty() && a.iter().all(|x| x.is_string())).unwrap_or(false);
    if !ok {
        // `{taskIds: undefined}` 在 JS 里会**整键消失** ⇒ details 为空对象。
        let mut d = Map::new();
        if !task_ids.is_null() {
            d.insert("taskIds".into(), task_ids);
        }
        return super::http::store_err(&StoreError::new(
            "INVALID_IMAGE",
            "taskIds 必须是非空字符串数组",
            Value::Object(d),
        ));
    }
    let ids: Vec<String> = task_ids
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let (deleted, skipped) = {
        let mut s = lock(shell);
        let r = s.delete_tasks(&ids);
        for id in &r.deleted {
            events::forget(id);
        }
        (r.deleted, r.skipped)
    };
    for id in &deleted {
        let _ = id;
    }
    let body = json!({
        "deleted": deleted,
        "skipped": skipped,
        "deletedCount": deleted.len(),
        "skippedCount": skipped.len(),
    });
    super::http::json_body(200, &body)
}

/// `GET /tasks/{taskId}/events`（`handleSse`）—— SSE 事件流。
fn sse(shell: &Shell, task_id: &str, headers: &HeaderMap, uri: &Uri) -> Response {
    {
        let s = lock(shell);
        if s.get_task(task_id).is_none() {
            return super::http::store_err(&StoreError::new(
                "TASK_NOT_FOUND",
                format!("任务不存在：{task_id}"),
                json!({ "taskId": task_id }),
            ));
        }
    }
    // Last-Event-ID：头优先，其次查询参数 `lastEventId`；都缺 ⇒ -1
    let raw = header_str(headers, "last-event-id").or_else(|| query_get(uri, "lastEventId"));
    let last: i64 = match raw {
        None => -1,
        Some(r) => js_parse_int(&r).map(|n| n as i64).unwrap_or(-1),
    };

    // 🔴 先订阅、再读历史：反序会漏掉「读历史 → 订阅」这个窗口里产生的事件
    //    （drain 跑在**另一个线程**上，这个窗口是真的存在，不像 Node 是单线程同步完成）。
    let mut rx = events::subscribe(task_id);
    let (history, dedup_below) = {
        let s = lock(shell);
        match s.get_task(task_id) {
            Some(t) => {
                let max = t.events.last().map(|e| e.id).unwrap_or(0);
                let hist: Vec<events::Rec> = t
                    .events
                    .iter()
                    .filter(|e| e.id as i64 > last)
                    .map(|e| (e.id, e.event.clone(), e.data.clone()))
                    .collect();
                (hist, max)
            }
            None => (Vec::new(), 0),
        }
    };

    let (tx, out) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(128);
    tokio::spawn(async move {
        if tx.send(Ok(axum::body::Bytes::from(events::comment("connected")))).await.is_err() {
            return;
        }
        for rec in history {
            if tx.send(Ok(axum::body::Bytes::from(events::format_sse(&rec)))).await.is_err() {
                return;
            }
        }
        loop {
            match rx.recv().await {
                Ok(rec) => {
                    // 与历史重复的那几条（订阅早于读历史的那段窗口）按 id 去重
                    if rec.0 <= dedup_below {
                        continue;
                    }
                    if tx.send(Ok(axum::body::Bytes::from(events::format_sse(&rec)))).await.is_err() {
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            }
        }
    });

    let stream = futures_util::stream::unfold(out, |mut out| async move {
        out.recv().await.map(|item| (item, out))
    });
    let mut resp = Response::new(Body::from_stream(stream));
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-transform"));
    h.insert("connection", HeaderValue::from_static("keep-alive"));
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    resp
}

/// `GET /queue`（`handleQueue`）。
fn queue(shell: &Shell) -> Response {
    let s = lock(shell);
    let view = s.queue_snapshot();
    super::http::json_body(200, &super::http::to_value(&view))
}

// ================================================================ library

/// `GET /library`（`libraryView`）—— 扫落盘根目录。
fn library_index(shell: &Shell) -> Response {
    let (root, hidden_set, hidden_list) = {
        let s = lock(shell);
        (
            s.root.clone(),
            s.hidden_comics.iter().cloned().collect::<HashSet<String>>(),
            s.hidden_comics_view(),
        )
    };
    let view = library::scan_library(&root, &hidden_set, hidden_list);
    super::http::json_body(200, &super::http::to_value(&view))
}

/// `POST /library/create`（`handleLibraryCreate`）—— 手动新建大类。
fn library_create(shell: &Shell, body: &[u8]) -> Response {
    let parsed = match read_json_body(body) {
        None => {
            return super::http::store_err(&StoreError::new(
                "INVALID_BOOK_META",
                "请求体不是合法 JSON",
                json!({ "raw": "unparsable" }),
            ))
        }
        Some(v) => v,
    };
    let value = parsed.unwrap_or(Value::Null);
    let raw_name = value
        .as_object()
        .and_then(|o| first_non_null(o, &["name", "comicName", "title"]))
        .cloned()
        .unwrap_or(Value::Null);
    let norm = match names::normalize_comic_name(&raw_name) {
        Ok(n) => n,
        Err(e) => return super::http::store_err(&e),
    };
    if !super::store::pure::is_safe_dir_name(&norm) {
        security_log(&format!("拒绝路径越界的新建漫画名（§8.2 校验点 2）：{raw_name}"));
        return super::http::store_err(&perm_denied());
    }
    let title = value.get("title").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).unwrap_or_default();
    if utf16_len(&title) > MAX_TITLE_CHARS {
        return super::http::store_err(&StoreError::new(
            "INVALID_BOOK_META",
            format!("标题超过 {MAX_TITLE_CHARS} 个字符"),
            json!({ "limit": MAX_TITLE_CHARS, "length": utf16_len(&title) }),
        ));
    }
    let author = value.get("author").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).unwrap_or_default();
    if utf16_len(&author) > MAX_AUTHOR_CHARS {
        return super::http::store_err(&StoreError::new(
            "INVALID_BOOK_META",
            format!("作者超过 {MAX_AUTHOR_CHARS} 个字符"),
            json!({ "limit": MAX_AUTHOR_CHARS, "length": utf16_len(&author) }),
        ));
    }

    let root = shell.store_root();
    // 🔴 判据是 **`fs.existsSync` 复检**，不是 `err.code === 'EEXIST'` —— 错误码会被包装层改写，
    //    "目录在不在"才是可观测事实（也让 `create_dir` 非递归那条纪律真正咬得住）。
    let (dir, manifest) = match library::create_book_dir(&root, &norm) {
        Ok(v) => v,
        Err(e) => {
            let target = root.join(&norm);
            if target.exists() {
                let hidden = lock(shell).hidden_comics.iter().any(|x| x == &norm);
                return super::http::store_err(&StoreError::new(
                    "BOOK_NAME_TAKEN",
                    format!("已存在同名漫画「{norm}」"),
                    json!({
                        "bookName": norm,
                        "outputDir": target.to_string_lossy(),
                        "hidden": hidden,
                    }),
                ));
            }
            return super::http::store_err(&internal(e.message));
        }
    };
    // 隐藏记录必须清掉，否则新建出来的这本会被扫描跳过
    lock(shell).forget_hidden(&norm);
    if !title.is_empty() || !author.is_empty() {
        let mut m = manifest.clone();
        if !title.is_empty() {
            m.title = title;
        }
        m.author = author;
        if let Err(e) = library::write_manifest_atomic(&dir, &m) {
            return super::http::store_err(&internal(e.to_string()));
        }
    }
    let mv = library::book_meta_view(&norm, &dir);
    super::http::json_body(201, &super::http::to_value(&mv))
}

/// 图片 `seq` 校验（`files/{seq}` 与 `chapters/{no}/files/{seq}` 共用）。
fn parse_seq(seq_text: &str, bad: Value) -> Result<i64, StoreError> {
    match js_parse_int(seq_text) {
        Some(n) if n >= 1.0 && n <= MAX_SEQ as f64 => Ok(n as i64),
        _ => Err(StoreError::new(
            "INVALID_IMAGE",
            format!("seq 必须是 1–{MAX_SEQ} 的整数"),
            bad,
        )),
    }
}

/// `variant` 查询参数（`original` / `translated`，缺省 `translated`）。
fn parse_variant(uri: &Uri) -> Result<String, StoreError> {
    let v = query_get(uri, "variant").filter(|s| !s.is_empty()).unwrap_or_else(|| "translated".to_string());
    if v != "original" && v != "translated" {
        return Err(StoreError::new("INVALID_IMAGE", "variant 只能是 original 或 translated", json!({ "variant": v })));
    }
    Ok(v)
}

/// `GET /library/{comicName}/files/{seq}`（`handleLibraryFile`）。
fn library_file(shell: &Shell, raw_name: &str, seq_text: &str, uri: &Uri) -> Response {
    let root = shell.store_root();
    let (_name, dir) = match library::resolve_comic_dir(&root, raw_name) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    let seq = match parse_seq(seq_text, json!({ "seq": seq_text })) {
        Ok(s) => s,
        Err(e) => return super::http::store_err(&e),
    };
    let variant = match parse_variant(uri) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    match library::find_file(&dir, seq, &variant) {
        Some(name) => super::http::image_response(&root, &dir.join(&name), &name, true),
        None => super::http::store_err(&StoreError::new(
            "TASK_NOT_FOUND",
            "漫画库中找不到该文件",
            json!({
                "comicName": dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                "seq": seq, "variant": variant, "root": root.to_string_lossy(),
            }),
        )),
    }
}

/// `POST /library/{comicName}/reveal`（`handleReveal`）。
fn library_reveal(shell: &Shell, raw_name: &str) -> Response {
    let root = shell.store_root();
    let (name, dir) = match library::resolve_comic_dir(&root, raw_name) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    if !dir.exists() {
        return super::http::store_err(&StoreError::new(
            "TASK_NOT_FOUND",
            "漫画目录不存在",
            json!({ "comicName": name, "outputDir": dir.to_string_lossy() }),
        ));
    }
    // mock 不真的打开系统文件管理器，但必须完成路径校验
    super::http::json_body(200, &json!({ "ok": true, "path": dir.to_string_lossy(), "comicName": name }))
}

/// `POST /library/{comicName}/delete`（`handleLibraryDelete`）—— 真删 或 只隐藏。
fn library_delete(shell: &Shell, raw_name: &str, body: &[u8]) -> Response {
    let root = shell.store_root();
    let (name, dir) = match library::resolve_comic_dir(&root, raw_name) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    let delete_files = parse_json_lenient(body).get("deleteFiles").and_then(|v| v.as_bool()).unwrap_or(false);

    if !delete_files {
        let hidden = lock(shell).hide_comic(&name);
        return super::http::json_body(
            200,
            &json!({
                "comicName": name,
                "deletedFiles": false,
                "hidden": hidden,
                "hiddenCount": hidden.len(),
            }),
        );
    }

    if paths::assert_inside_root(&root, &dir.join("x.png")).is_err() {
        security_log(&format!("拒绝删除越界的漫画目录：{}（root={}）", dir.display(), root.display()));
        return super::http::store_err(&perm_denied());
    }
    if paths::canonicalize(&dir) == paths::canonicalize(&root) {
        security_log(&format!("拒绝删除漫画库根目录本身：{}", dir.display()));
        return super::http::store_err(&perm_denied());
    }
    if !dir.exists() {
        // 目录本就不在：顺手清掉可能残留的隐藏记录，再如实报 404。
        lock(shell).forget_hidden(&name);
        return super::http::store_err(&StoreError::new(
            "TASK_NOT_FOUND",
            "漫画目录不存在",
            json!({ "comicName": name, "outputDir": dir.to_string_lossy() }),
        ));
    }
    if let Err(e) = std::fs::remove_dir_all(&dir) {
        return super::http::store_err(&internal(e.to_string()));
    }
    lock(shell).forget_hidden(&name);
    super::http::json_body(
        200,
        &json!({ "comicName": name, "deletedFiles": true, "outputDir": dir.to_string_lossy() }),
    )
}

/// `POST /library/{comicName}/unhide`（`handleLibraryUnhide`）。
fn library_unhide(shell: &Shell, raw_name: &str) -> Response {
    let root = shell.store_root();
    let (name, _dir) = match library::resolve_comic_dir(&root, raw_name) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    let hidden = lock(shell).unhide_comic(&name);
    super::http::json_body(
        200,
        &json!({ "comicName": name, "hidden": hidden, "hiddenCount": hidden.len() }),
    )
}

// ---------------------------------------------------------------- 大类：元信息 / 封面

/// 复刻 `applyMetaFields`：把 `title` / `author` 合并进 manifest。
fn apply_meta_fields(manifest: &library::Manifest, body: &Value) -> Result<(library::Manifest, bool), StoreError> {
    let mut next = manifest.clone();
    let mut touched = false;
    let Some(obj) = body.as_object() else { return Ok((next, touched)) };
    if obj.contains_key("title") {
        let v = obj.get("title").unwrap();
        let Some(s) = v.as_str() else {
            return Err(StoreError::new(
                "INVALID_BOOK_META",
                "title 必须是字符串",
                json!({ "field": "title", "type": names::js_typeof(v) }),
            ));
        };
        let t = s.trim();
        if t.is_empty() {
            return Err(StoreError::new("INVALID_BOOK_META", "标题不能为空", json!({ "field": "title" })));
        }
        if utf16_len(t) > MAX_TITLE_CHARS {
            return Err(StoreError::new(
                "INVALID_BOOK_META",
                format!("标题超过 {MAX_TITLE_CHARS} 个字符"),
                json!({ "limit": MAX_TITLE_CHARS, "length": utf16_len(t) }),
            ));
        }
        next.title = t.to_string();
        touched = true;
    }
    if obj.contains_key("author") {
        let v = obj.get("author").unwrap();
        let Some(s) = v.as_str() else {
            return Err(StoreError::new(
                "INVALID_BOOK_META",
                "author 必须是字符串",
                json!({ "field": "author", "type": names::js_typeof(v) }),
            ));
        };
        let a = s.trim();
        // 空串是**合法**输入 = 「清掉署名」（与 title 不同）
        if utf16_len(a) > MAX_AUTHOR_CHARS {
            return Err(StoreError::new(
                "INVALID_BOOK_META",
                format!("作者超过 {MAX_AUTHOR_CHARS} 个字符"),
                json!({ "limit": MAX_AUTHOR_CHARS, "length": utf16_len(a) }),
            ));
        }
        next.author = a.to_string();
        touched = true;
    }
    Ok((next, touched))
}

/// 复刻 `coverFromFirstChapter`：用「最小话目录里最小页号的图」落封面（复用 `writeCover` 四道保护）。
fn cover_from_first_chapter(root: &Path, book_dir: &Path) -> Result<String, StoreError> {
    let Some(src) = library::pick_first_chapter_image(book_dir) else {
        return Err(StoreError::new(
            "TASK_NOT_FOUND",
            "这本漫画还没有任何话，取不到首图",
            json!({ "bookDir": book_dir.to_string_lossy() }),
        ));
    };
    let data = match std::fs::read(&src) {
        Ok(d) => d,
        Err(e) => {
            return Err(StoreError::new(
                "INVALID_IMAGE",
                "读取首图失败",
                json!({ "src": src.to_string_lossy(), "reason": e.to_string() }),
            ))
        }
    };
    let limit = library::cover_max_bytes();
    if data.len() > limit {
        return Err(StoreError::new(
            "COVER_TOO_LARGE",
            format!("图片不能超过 {} MB", limit / (1024 * 1024)),
            json!({ "limitBytes": limit, "actualBytes": data.len(), "src": src.to_string_lossy() }),
        ));
    }
    let Some(ext) = library::sniff(&data) else {
        return Err(StoreError::new(
            "INVALID_IMAGE",
            "这个文件不是图片（png / jpg / webp）",
            json!({ "src": src.to_string_lossy() }),
        ));
    };
    library::write_cover(root, book_dir, &data, ext)
}

/// `GET /library/{book}/meta`（`handleLibraryMeta`）。
fn library_meta(shell: &Shell, raw_name: &str) -> Response {
    let root = shell.store_root();
    let (name, dir) = match library::resolve_book_dir(&root, raw_name) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    let mv = library::book_meta_view(&name, &dir);
    super::http::json_body(200, &super::http::to_value(&mv))
}

/// `POST /library/{book}/meta`（`handleLibraryMetaWrite`）。
fn library_meta_write(shell: &Shell, raw_name: &str, body: &[u8]) -> Response {
    let root = shell.store_root();
    let (name, dir) = match library::resolve_book_dir(&root, raw_name) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    let parsed = match read_json_body(body) {
        None => {
            return super::http::store_err(&StoreError::new(
                "INVALID_BOOK_META",
                "请求体不是合法 JSON",
                json!({ "raw": "unparsable" }),
            ))
        }
        Some(v) => v.unwrap_or(Value::Null),
    };
    let value = if parsed.is_object() { parsed } else { json!({}) };
    let (mut manifest, touched) = match apply_meta_fields(&library::read_manifest(&dir, &name), &value) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    let mut changed = touched;
    match value.get("coverFromFirstChapter") {
        Some(Value::Bool(true)) => match cover_from_first_chapter(&root, &dir) {
            Ok(n) => {
                manifest.cover = Some(n);
                changed = true;
            }
            Err(e) => return super::http::store_err(&e),
        },
        None | Some(Value::Bool(false)) => {}
        Some(other) => {
            return super::http::store_err(&StoreError::new(
                "INVALID_BOOK_META",
                "coverFromFirstChapter 只能是布尔 true",
                json!({ "field": "coverFromFirstChapter", "type": names::js_typeof(other) }),
            ))
        }
    }
    if !changed {
        return super::http::store_err(&StoreError::new(
            "INVALID_BOOK_META",
            "没有需要更新的字段（title / author / coverFromFirstChapter 至少要给一个）",
            json!({}),
        ));
    }
    // `episodes[]` 一律按**目录**重建后回写（D-115 §3「目录即索引」）
    manifest.episodes = library::episodes_from_dirs(&dir);
    if let Err(e) = library::write_manifest_atomic(&dir, &manifest) {
        return super::http::store_err(&internal(e.to_string()));
    }
    let mv = library::book_meta_view(&name, &dir);
    super::http::json_body(200, &super::http::to_value(&mv))
}

/// `POST /library/{book}/cover`（`handleLibraryCover`）—— multipart 单文件。
fn library_cover(shell: &Shell, headers: &HeaderMap, raw_name: &str, body: &[u8]) -> Response {
    let root = shell.store_root();
    let (name, dir) = match library::resolve_book_dir(&root, raw_name) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    let ct = header_str(headers, "content-type").unwrap_or_default();
    let clen = header_str(headers, "content-length");
    let grouped = match multipart::group_multipart(&ct, clen.as_deref(), body) {
        Ok(g) => g,
        Err(e) => return super::http::store_err(&e),
    };
    let covers = grouped.files.get("cover").cloned().unwrap_or_default();
    if covers.is_empty() {
        return super::http::store_err(&StoreError::new(
            "INVALID_IMAGE",
            "缺少封面分片（字段名 cover）",
            json!({ "submitted": 0 }),
        ));
    }
    if covers.len() > 1 {
        // 多选一张会造成"用了哪张"不可判定 —— 明确拒绝
        return super::http::store_err(&StoreError::new(
            "INVALID_IMAGE",
            "封面只能一次选一张",
            json!({ "submitted": covers.len() }),
        ));
    }
    let part = &covers[0];
    let limit = library::cover_max_bytes();
    if part.data.len() > limit {
        return super::http::store_err(&StoreError::new(
            "COVER_TOO_LARGE",
            format!("图片不能超过 {} MB", limit / (1024 * 1024)),
            json!({ "limitBytes": limit, "actualBytes": part.data.len() }),
        ));
    }
    // 🔴 扩展名**只由字节决定**（嗅探），不信任 part.filename / part.contentType
    let Some(ext) = library::sniff(&part.data) else {
        return super::http::store_err(&StoreError::new(
            "INVALID_IMAGE",
            "这个文件不是图片（png / jpg / webp）",
            json!({ "filename": part.filename, "contentType": part.content_type }),
        ));
    };
    // 🔴 顺序是「先落文件、后写 json」：中断时 readCoverName 的 readdir 兜底仍能认出封面。
    let cover_name = match library::write_cover(&root, &dir, &part.data, ext) {
        Ok(n) => n,
        Err(e) => return super::http::store_err(&e),
    };
    let payload = multipart::extract_payload_field(&grouped.fields, &grouped.files);
    let (mut manifest, _) = match apply_meta_fields(&library::read_manifest(&dir, &name), &payload) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    manifest.cover = Some(cover_name);
    manifest.episodes = library::episodes_from_dirs(&dir);
    if let Err(e) = library::write_manifest_atomic(&dir, &manifest) {
        return super::http::store_err(&internal(e.to_string()));
    }
    let mv = library::book_meta_view(&name, &dir);
    super::http::json_body(200, &super::http::to_value(&mv))
}

/// `DELETE /library/{book}/cover`（`handleLibraryCoverDelete`）。
/// 📌 **保留 `author`**：移除封面不是"清空元信息"（D-115 §4）。
fn library_cover_delete(shell: &Shell, raw_name: &str) -> Response {
    let root = shell.store_root();
    let (name, dir) = match library::resolve_book_dir(&root, raw_name) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    library::remove_cover(&dir);
    let mut manifest = library::read_manifest(&dir, &name);
    manifest.cover = None;
    manifest.episodes = library::episodes_from_dirs(&dir);
    if let Err(e) = library::write_manifest_atomic(&dir, &manifest) {
        return super::http::store_err(&internal(e.to_string()));
    }
    let mv = library::book_meta_view(&name, &dir);
    super::http::json_body(200, &super::http::to_value(&mv))
}

/// `GET /library/{book}/cover`（`handleLibraryCoverFile`）—— 封面**字节**。
fn library_cover_file(shell: &Shell, raw_name: &str) -> Response {
    let root = shell.store_root();
    let (name, dir) = match library::resolve_book_dir(&root, raw_name) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    let cover = library::read_cover_name(&dir, &library::read_manifest(&dir, &name));
    let Some(cover) = cover else {
        return super::http::store_err(&StoreError::new(
            "TASK_NOT_FOUND",
            "这本漫画还没有封面",
            json!({ "bookName": name, "outputDir": dir.to_string_lossy() }),
        ));
    };
    super::http::image_response(&root, &dir.join(&cover), &cover, false)
}

// ---------------------------------------------------------------- 大类：归并

/// `EXDEV`（跨卷）判定 —— **多信号**（Windows 侧 17 = `ERROR_NOT_SAME_DEVICE`，POSIX 18 = EXDEV）。
fn is_cross_device_error(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(17) | Some(18))
}

/// Windows「句柄占用族」判定（EPERM/EBUSY/EACCES 与 ERROR_SHARING_VIOLATION/LOCK_VIOLATION）。
fn is_busy_fs_error(e: &std::io::Error) -> bool {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        return true;
    }
    matches!(e.raw_os_error(), Some(1) | Some(13) | Some(16) | Some(32) | Some(33))
}

const RENAME_TRIES: usize = 5; // 总等待 ≈ 800ms，瞬时句柄足够释放
const RENAME_DELAY_MS: u64 = 200;

/// 目录重命名 + 占用退避重试（D-125：可重试解，不该变成用户可见的报错）。
async fn rename_dir_with_retry(src: &Path, dst: &Path) -> std::io::Result<()> {
    let mut i = 1usize;
    loop {
        match std::fs::rename(src, dst) {
            Ok(()) => return Ok(()),
            Err(e) => {
                if !is_busy_fs_error(&e) || i >= RENAME_TRIES {
                    return Err(e);
                }
                eprintln!(
                    "[manga-service] 目录移动被占用（{:?}，{}/{} 次重试后放弃）：{}",
                    e.kind(),
                    i,
                    RENAME_TRIES - 1,
                    src.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
                );
                tokio::time::sleep(Duration::from_millis(RENAME_DELAY_MS)).await;
                i += 1;
            }
        }
    }
}

/// 复刻 `evictStrayManifest`：移动后大类里若多出一份 `manifest.json`，挪进归档。
fn evict_stray_manifest(book_dir: &Path, moved_dir_name: &str) -> Option<PathBuf> {
    let stray = book_dir.join(moved_dir_name).join("manifest.json");
    if !stray.exists() {
        return None;
    }
    let dest = library::merge_archive_dir()
        .join(format!("{}-{}-stray.json", library::stamp_of(), moved_dir_name));
    match std::fs::rename(&stray, &dest) {
        Ok(()) => {
            eprintln!(
                "[manga-service] ⚠ 归并时发现多出的 manifest.json，已归档到 {}",
                dest.display()
            );
            Some(dest)
        }
        Err(_) => None,
    }
}

/// `POST /library/{name}/merge`（`handleLibraryMerge`）—— 把「其它」里的单话**物理搬**进大类。
async fn library_merge(shell: &Shell, raw_name: &str, body: &[u8]) -> Response {
    let root = shell.store_root();
    let (src_name, src_dir) = match library::resolve_comic_dir(&root, raw_name) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    let parsed = match read_json_body(body) {
        None => {
            return super::http::store_err(&StoreError::new(
                "INVALID_BOOK_META",
                "请求体不是合法 JSON",
                json!({ "raw": "unparsable" }),
            ))
        }
        Some(v) => v.unwrap_or(Value::Null),
    };
    let value = if parsed.is_object() { parsed } else { json!({}) };
    let target_raw = value
        .as_object()
        .and_then(|o| first_non_null(o, &["targetBook", "book", "target"]))
        .cloned()
        .unwrap_or(Value::Null);
    let target_text = js_string(&target_raw);
    let (target_name, target_dir) = match library::resolve_book_dir(&root, &target_text) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    // 话号复用 `resolveChapterDir` 的同一套校验（"什么算合法话号"只能有一份定义）
    let no_text = match value.get("no") {
        None | Some(Value::Null) => String::new(),
        Some(v) => js_string(v),
    };
    let chapter = match library::resolve_chapter_dir(&root, &target_name, &no_text) {
        Ok(c) => c,
        Err(e) => return super::http::store_err(&e),
    };

    if !src_dir.exists() {
        return super::http::store_err(&StoreError::new(
            "TASK_NOT_FOUND",
            "未归并单话目录不存在",
            json!({ "comicName": src_name, "outputDir": src_dir.to_string_lossy() }),
        ));
    }
    if library::has_manifest(&src_dir) {
        return super::http::store_err(&StoreError::new(
            "ALREADY_MERGED",
            format!("「{src_name}」已经是一本大类（目录内有 manifest.json），不能再次归并"),
            json!({ "comicName": src_name, "outputDir": src_dir.to_string_lossy() }),
        ));
    }
    let busy = lock(shell).active_tasks_for_dir(&src_name);
    if !busy.is_empty() {
        return super::http::store_err(&StoreError::new(
            "MERGE_SOURCE_BUSY",
            format!(
                "「{src_name}」还有 {} 个任务在跑（{}），请等它跑完或先取消",
                busy.len(),
                busy.iter().map(|(_, s)| s.as_str()).collect::<Vec<_>>().join("、")
            ),
            json!({
                "comicName": src_name,
                "statuses": busy.iter().map(|(_, s)| s.clone()).collect::<Vec<_>>(),
                "taskIds": busy.iter().map(|(t, _)| t.clone()).collect::<Vec<_>>(),
            }),
        ));
    }
    let dst = target_dir.join(&chapter.dir_name);
    // ⑤ 双向查：目录名（位置）与 episodes[].no（说明文字）都要干净
    let taken_nos: Vec<f64> = library::list_chapter_dirs(&target_dir).into_iter().map(|c| c.no).collect();
    let declared_nos: Vec<f64> =
        library::read_manifest(&target_dir, &target_name).episodes.iter().map(|e| e.no).collect();
    if dst.exists() || taken_nos.contains(&chapter.no) || declared_nos.contains(&chapter.no) {
        return super::http::store_err(&StoreError::new(
            "CHAPTER_NO_TAKEN",
            format!("《{target_name}》已经有第 {} 话了", js_num_plain(chapter.no)),
            json!({
                "targetBook": target_name,
                "chapterNo": chapter.no,
                "occupiedBy": if dst.exists() { "dir" } else { "episodes" },
            }),
        ));
    }

    // 移动前清掉源目录里的封面（它属于"单话"，不该升格为整本封面）
    let removed_cover_count = library::remove_cover(&src_dir);
    if let Err(e) = rename_dir_with_retry(&src_dir, &dst).await {
        if is_cross_device_error(&e) {
            return super::http::store_err(&StoreError::new(
                "MERGE_CROSS_DEVICE",
                "漫画库与目标目录不在同一个磁盘卷上，无法自动归并（请手动移动该目录）",
                json!({ "comicName": src_name, "targetBook": target_name, "chapterNo": chapter.no, "reason": e.to_string() }),
            ));
        }
        if is_busy_fs_error(&e) {
            return super::http::store_err(&StoreError::new(
                "MERGE_SOURCE_LOCKED",
                format!("「{src_name}」正被其它程序占用（可能有页面还在预览、或资源管理器/杀毒正在扫描该目录），已自动重试仍失败，请稍候再试"),
                json!({ "comicName": src_name, "targetBook": target_name, "chapterNo": chapter.no, "reason": e.to_string() }),
            ));
        }
        return super::http::store_err(&internal(e.to_string()));
    }
    evict_stray_manifest(&target_dir, &chapter.dir_name);
    let mut m = library::read_manifest(&target_dir, &target_name);
    m.episodes = library::episodes_from_dirs(&target_dir);
    if let Err(e) = library::write_manifest_atomic(&target_dir, &m) {
        return super::http::store_err(&internal(e.to_string()));
    }
    let mv = library::book_meta_view(&target_name, &target_dir);
    let mut body = super::http::to_value(&mv);
    if let Some(o) = body.as_object_mut() {
        o.insert(
            "merged".into(),
            json!({
                "from": src_name,
                "to": format!("{target_name}/{}", chapter.dir_name),
                "no": chapter.no,
                "removedCoverCount": removed_cover_count,
            }),
        );
    }
    super::http::json_body(200, &body)
}

/// JS 数字文本（整数不带 `.0`）。
fn js_num_plain(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

// ---------------------------------------------------------------- 话级：取图 / 计划 / 重建

/// `GET /library/{book}/chapters/{no}/files/{seq}`（`handleChapterFile`）。
fn chapter_file(shell: &Shell, book_raw: &str, no_raw: &str, seq_text: &str, uri: &Uri) -> Response {
    let root = shell.store_root();
    let info = match library::must_chapter_dir(&root, book_raw, no_raw) {
        Ok(i) => i,
        Err(e) => return super::http::store_err(&e),
    };
    let seq = match parse_seq(seq_text, json!({ "seq": seq_text })) {
        Ok(s) => s,
        Err(e) => return super::http::store_err(&e),
    };
    let variant = match parse_variant(uri) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    match library::find_file(&info.dir, seq, &variant) {
        Some(name) => super::http::image_response(&root, &info.dir.join(&name), &name, true),
        None => super::http::store_err(&StoreError::new(
            "TASK_NOT_FOUND",
            "该话中找不到这一页",
            json!({ "bookName": info.book_name, "chapterNo": info.no, "seq": seq, "variant": variant }),
        )),
    }
}

/// `GET /library/{book}/chapters/{no}/resume`（`handleChapterResumePlan`）。
fn chapter_resume_plan(shell: &Shell, book_raw: &str, no_raw: &str) -> Response {
    let root = shell.store_root();
    let info = match library::must_chapter_dir(&root, book_raw, no_raw) {
        Ok(i) => i,
        Err(e) => return super::http::store_err(&e),
    };
    let plan = match lock(shell).resume_plan(&info.rel_dir) {
        Ok(p) => p,
        Err(e) => return super::http::store_err(&e),
    };
    super::http::json_body(200, &super::http::to_value(&plan))
}

/// `GET /library/{book}/chapters/{no}/retranslate`（`handleChapterRetranslatePlan`）。
fn chapter_retranslate_plan(shell: &Shell, book_raw: &str, no_raw: &str) -> Response {
    let root = shell.store_root();
    let info = match library::must_chapter_dir(&root, book_raw, no_raw) {
        Ok(i) => i,
        Err(e) => return super::http::store_err(&e),
    };
    let plan = match lock(shell).retranslate_plan(&info.rel_dir) {
        Ok(p) => p,
        Err(e) => return super::http::store_err(&e),
    };
    super::http::json_body(200, &super::http::to_value(&plan))
}

/// 建任务族「目录怎么来」（复刻 `taskLauncher` 的 `dirOf`）。
enum DirOf<'a> {
    /// 话级：持相对路径 `<book>/NN_第N话`
    Chapter(&'a str, &'a str),
    /// 漫画级：持顶层目录名
    Comic(&'a str),
}

/// 建任务族「建哪类任务」（复刻 `taskLauncher` 的 `build`）。
#[derive(Clone, Copy)]
enum Build {
    Resume,
    Retranslate,
}

/// 复刻 `readResumeOptions`：从请求体读 `{seqs, lang}`（四条路共用）。
fn read_resume_options(body: &[u8]) -> Result<(Option<Vec<i64>>, Option<Lang>), StoreError> {
    if body.is_empty() {
        return Ok((None, None));
    }
    let parsed = match serde_json::from_slice::<Value>(body) {
        Ok(v) => v,
        Err(_) => return Ok((None, None)), // 允许空体 / 坏 JSON（与既有行为一致）
    };
    let mut seqs: Option<Vec<i64>> = None;
    let mut lang: Option<Lang> = None;
    if let Some(sv) = parsed.get("seqs") {
        if !sv.is_null() {
            let Some(arr) = sv.as_array() else {
                return Err(StoreError::new("INVALID_IMAGE", "seqs 必须是数组", json!({ "seqs": sv })));
            };
            // 复刻 `seqs && seqs.length ? new Set(seqs.map(Number)) : null` —— 空数组 = 没指定
            if !arr.is_empty() {
                let ids: Vec<i64> = arr
                    .iter()
                    .filter_map(js_number)
                    .filter(|f| f.is_finite() && f.fract() == 0.0)
                    .map(|f| f as i64)
                    .collect();
                seqs = Some(ids);
            }
        }
    }
    if let Some(lv) = parsed.get("lang") {
        if !lv.is_null() {
            lang = resolve_task_lang(&json!({ "lang": lv }))?;
        }
    }
    Ok((seqs, lang))
}

/// 续做/返工四个 POST 端点的共用骨架（复刻 `taskLauncher`，**顺序是契约的一部分**）。
async fn task_launcher(
    shell: &Arc<Shell>,
    headers: &HeaderMap,
    body: &[u8],
    dir_of: DirOf<'_>,
    build: Build,
) -> Response {
    if let Err(e) = assert_sidecar_ready(shell).await {
        return super::http::store_err(&e);
    }
    let root = shell.store_root();
    let dir = match dir_of {
        DirOf::Chapter(book, no) => match library::must_chapter_dir(&root, book, no) {
            Ok(i) => i.rel_dir,
            Err(e) => return super::http::store_err(&e),
        },
        DirOf::Comic(raw) => match library::resolve_comic_dir(&root, raw) {
            Ok((name, _)) => name,
            Err(e) => return super::http::store_err(&e),
        },
    };
    let (seqs, lang) = match read_resume_options(body) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    if let Err(e) = assert_root_writable(shell) {
        return super::http::store_err(&e);
    }
    let source = source_of(headers);

    let view = {
        let mut s = lock(shell);
        match build {
            Build::Resume => {
                let outcome = match s.create_resume_task(&dir, seqs.clone(), Some(source), lang.clone()) {
                    Ok(o) => o,
                    Err(e) => return super::http::store_err(&e),
                };
                match create_view_of(&s, &outcome.task_id) {
                    Ok(v) => v,
                    Err(e) => return super::http::store_err(&e),
                }
            }
            Build::Retranslate => {
                let outcome = match s.create_retranslate_task(&dir, seqs.clone(), Some(source), lang.clone()) {
                    Ok(o) => o,
                    Err(e) => return super::http::store_err(&e),
                };
                // 覆盖数/返工数：`retranslate_plan` 是**按目录重算**的（建单不落盘任何页文件），
                // 故此刻重算与建单时算出的 plan 等价。
                let plan = match s.retranslate_plan(&dir) {
                    Ok(p) => p,
                    Err(e) => return super::http::store_err(&e),
                };
                let base = match create_view_of(&s, &outcome.task_id) {
                    Ok(v) => v,
                    Err(e) => return super::http::store_err(&e),
                };
                let mut v = base;
                if let Some(o) = v.as_object_mut() {
                    o.insert("overwriteCount".into(), json!(plan.overwrite_count));
                    o.insert("retranslateCount".into(), json!(picked_count(&plan, &seqs)));
                }
                v
            }
        }
    };
    shell.notify_drain();
    super::http::json_body(201, &view)
}

/// 复刻 `pickedCount(plan, seqs)` —— 指定 seqs 时只算被选中的（回执不谎报）。
fn picked_count(plan: &super::store::view::RetranslatePlan, seqs: &Option<Vec<i64>>) -> usize {
    match seqs {
        None => plan.retranslate_count,
        Some(s) if s.is_empty() => plan.retranslate_count,
        Some(s) => {
            let want: HashSet<i64> = s.iter().copied().collect();
            plan.candidates.iter().filter(|c| want.contains(&c.seq)).count()
        }
    }
}

/// `POST /library/{book}/chapters/{no}/renumber`（`handleChapterRenumber`）—— 改话号 = 目录改名。
///
/// 🔴 必须是 `async`：改名走 [`rename_dir_with_retry`]，里面有 `tokio::time::sleep`。
///    用阻塞执行器（`futures::executor::block_on`）在 tokio 工作线程上驱动它会被 runtime
///    查出"在 runtime 内阻塞"而 panic；直接 `.await` 才是对的。
async fn chapter_renumber(shell: &Shell, book_raw: &str, no_raw: &str, body: &[u8]) -> Response {
    let root = shell.store_root();
    let old = match library::must_chapter_dir(&root, book_raw, no_raw) {
        Ok(i) => i,
        Err(e) => return super::http::store_err(&e),
    };
    let parsed = match read_json_body(body) {
        None => {
            return super::http::store_err(&StoreError::new(
                "INVALID_BOOK_META",
                "请求体不是合法 JSON",
                json!({ "raw": "unparsable" }),
            ))
        }
        Some(v) => v.unwrap_or(Value::Null),
    };
    let value = if parsed.is_object() { parsed } else { json!({}) };
    let new_no_text = match value.get("no") {
        None | Some(Value::Null) => String::new(),
        Some(v) => js_string(v),
    };
    let new_info = match library::resolve_chapter_dir(&root, &old.book_name, &new_no_text) {
        Ok(i) => i,
        Err(e) => return super::http::store_err(&e),
    };
    if new_info.dir_name != old.dir_name {
        let busy = lock(shell).active_tasks_for_dir(&old.rel_dir);
        if !busy.is_empty() {
            return super::http::store_err(&StoreError::new(
                "CHAPTER_SOURCE_BUSY",
                format!(
                    "《{}》第 {} 话还有 {} 个任务在跑（{}），请等它跑完或先取消",
                    old.book_name,
                    js_num_plain(old.no),
                    busy.len(),
                    busy.iter().map(|(_, s)| s.as_str()).collect::<Vec<_>>().join("、")
                ),
                json!({
                    "bookName": old.book_name, "from": old.no, "to": new_info.no,
                    "statuses": busy.iter().map(|(_, s)| s.clone()).collect::<Vec<_>>(),
                    "taskIds": busy.iter().map(|(t, _)| t.clone()).collect::<Vec<_>>(),
                }),
            ));
        }
        let dst = old.book_dir.join(&new_info.dir_name);
        let taken_nos: Vec<f64> = library::list_chapter_dirs(&old.book_dir).into_iter().map(|c| c.no).collect();
        let declared_nos: Vec<f64> =
            library::read_manifest(&old.book_dir, &old.book_name).episodes.iter().map(|e| e.no).collect();
        if dst.exists() || taken_nos.contains(&new_info.no) || declared_nos.contains(&new_info.no) {
            return super::http::store_err(&StoreError::new(
                "CHAPTER_NO_TAKEN",
                format!("《{}》已经有第 {} 话了", old.book_name, js_num_plain(new_info.no)),
                json!({
                    "bookName": old.book_name,
                    "chapterNo": new_info.no,
                    "occupiedBy": if dst.exists() { "dir" } else { "episodes" },
                }),
            ));
        }
        // 等待改名（本地 fs 动作；仅在遇 EBUSY 时按 RENAME_DELAY_MS 重试，故通常零延迟）。
        let renamed = rename_dir_with_retry(&old.dir, &dst).await;
        if let Err(e) = renamed {
            if is_busy_fs_error(&e) {
                return super::http::store_err(&StoreError::new(
                    "CHAPTER_SOURCE_LOCKED",
                    format!(
                        "《{}》第 {} 话的目录正被其它程序占用（可能有页面还在预览、或资源管理器/杀毒正在扫描），已自动重试仍失败，请稍候再试",
                        old.book_name,
                        js_num_plain(old.no)
                    ),
                    json!({ "bookName": old.book_name, "from": old.no, "to": new_info.no, "reason": e.to_string() }),
                ));
            }
            return super::http::store_err(&internal(e.to_string()));
        }
        let mut m = library::read_manifest(&old.book_dir, &old.book_name);
        m.episodes = library::episodes_from_dirs(&old.book_dir);
        if let Err(e) = library::write_manifest_atomic(&old.book_dir, &m) {
            return super::http::store_err(&internal(e.to_string()));
        }
    }
    let mv = library::book_meta_view(&old.book_name, &old.book_dir);
    let mut out = super::http::to_value(&mv);
    if let Some(o) = out.as_object_mut() {
        o.insert("renumbered".into(), json!({ "from": old.no, "to": new_info.no }));
    }
    super::http::json_body(200, &out)
}

/// `GET /library/{comicName}/resume`（`handleResumePlan`）—— 「有原图、缺译文」的页清单。
fn resume_plan(shell: &Shell, raw_name: &str) -> Response {
    let root = shell.store_root();
    let (name, _dir) = match library::resolve_comic_dir(&root, raw_name) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    let plan = match lock(shell).resume_plan(&name) {
        Ok(p) => p,
        Err(e) => return super::http::store_err(&e),
    };
    super::http::json_body(200, &super::http::to_value(&plan))
}

/// `GET /library/{comicName}/retranslate`（`handleRetranslatePlan`）—— **所有有原图**的页。
fn retranslate_plan(shell: &Shell, raw_name: &str) -> Response {
    let root = shell.store_root();
    let (name, _dir) = match library::resolve_comic_dir(&root, raw_name) {
        Ok(v) => v,
        Err(e) => return super::http::store_err(&e),
    };
    let plan = match lock(shell).retranslate_plan(&name) {
        Ok(p) => p,
        Err(e) => return super::http::store_err(&e),
    };
    super::http::json_body(200, &super::http::to_value(&plan))
}

/// 保留给将来的调试入口（避免 `HashMap` 导入被优化掉时误删）。
#[allow(dead_code)]
fn _unused(_m: HashMap<String, String>) {}
