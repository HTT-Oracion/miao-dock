// 出网 HTTP 原语 —— 在线翻译模块**唯一真正触网**的件（Rust 侧）
// =============================================================================
// 依据：在线翻译服务设计方案 §7.1（五层超时）/ §5.1 注（form-urlencoded）。
// 移植自 `service/src/manga/translate/http.mjs`（Node `http/https` 原生 → `reqwest`）。
// 本文件**不认识任何业务**：不知道有道、不解析 JSON、不解释字段、不判成功。
// 错误一律用 [`HttpFault`]（带层 attribution），归一成 `TRANSLATE_*` 是 `errors.rs` 的事。
//
// 🔴 为什么「多个超时」而不是一个（§7.1）：不可达要**快败**（connect）· 大模型首字慢与
//    整段慢是两件事（ttfb）· 「卡住」与「慢慢吐」只有空闲超时能区分（idle）· 总体兜底（total）。
//    合成一个 30s，上述四种现场全部退化成「等 30s 后失败」。
use std::time::Duration;

use axum::body::Bytes;
use futures_util::TryStreamExt;

use super::errors::HttpFault;

/// 五层超时（方案 §7.1；调用方按接口覆盖）。`probe_ms` 不由本层使用。
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub connect_ms: u64,
    pub ttfb_ms: u64,
    pub idle_ms: u64,
    pub total_ms: u64,
}

/// 整体响应（`postForm`）。
pub struct HttpOk {
    pub status: u16,
    pub body: Vec<u8>,
}

/// 流式响应（`postStream`）：**首字节已到**即交回，由调用方读流。
pub struct HttpStream {
    pub status: u16,
    pub stream: std::pin::Pin<Box<dyn futures_util::Stream<Item = Result<Bytes, HttpFault>> + Send>>,
}

/// 每次请求一个 client、**不用连接池**（复刻 Node 的 `agent: false`）。
///
/// 理由同 Node：翻译是低频请求，复用收益小；而复用会把上一条连接的 socket 超时状态带过来，
/// 让「哪一层超时」归因变浑。`connect_timeout` 覆盖「根本连不上」的快败场景。
fn client(connect_ms: u64) -> Result<reqwest::Client, HttpFault> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(connect_ms.max(1)))
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|e| HttpFault::Other { native: Some(format!("构建出网客户端失败：{e}")) })
}

/// `reqwest::Error` → [`HttpFault`]：先超时、再链路，最后兜底（顺序即优先级）。
fn fault_of(e: reqwest::Error) -> HttpFault {
    let native = Some(format!("{e}"));
    if e.is_timeout() {
        // 具体层由调用方（包在 timeout 里的那一层）给出；这里给兜底 stage。
        return HttpFault::Timeout { stage: "total".to_string(), timeout_ms: 0 };
    }
    if e.is_connect() {
        return HttpFault::Unreachable { native };
    }
    // 上游把连接掐了（响应没走完）：reqwest 归到 body / decode / request 族。
    if e.is_body() || e.is_decode() || e.is_request() {
        return HttpFault::Unreachable { native };
    }
    HttpFault::Other { native }
}

fn urlencode(fields: &[(String, String)]) -> String {
    let mut ser = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in fields {
        ser.append_pair(k, v);
    }
    ser.finish()
}

/// POST form，收**全体**响应（不跟随重定向：3xx 作为普通 status 返回，由调用方决定）。
pub async fn post_form(url: &str, fields: &[(String, String)], t: &Timeouts) -> Result<HttpOk, HttpFault> {
    let client = client(t.connect_ms)?;
    let body = urlencode(fields);
    let send = client
        .post(url)
        .header(reqwest::header::ACCEPT, "*/*")
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body)
        .send();
    // ttfb（首字节）：响应头到达之前
    let resp = tokio::time::timeout(Duration::from_millis(t.ttfb_ms.max(1)), send)
        .await
        .map_err(|_| HttpFault::Timeout { stage: "ttfb".to_string(), timeout_ms: t.ttfb_ms })?
        .map_err(fault_of)?;
    let status = resp.status().as_u16();
    // 整体兜底
    let bytes = tokio::time::timeout(Duration::from_millis(t.total_ms.max(1)), resp.bytes())
        .await
        .map_err(|_| HttpFault::Timeout { stage: "total".to_string(), timeout_ms: t.total_ms })?
        .map_err(fault_of)?;
    Ok(HttpOk { status, body: bytes.to_vec() })
}

/// POST form，收**响应流**（ttfb 即返回）。调用方负责读流并施加 idle/total。
pub async fn post_stream(url: &str, fields: &[(String, String)], t: &Timeouts) -> Result<HttpStream, HttpFault> {
    let client = client(t.connect_ms)?;
    let body = urlencode(fields);
    let send = client
        .post(url)
        .header(reqwest::header::ACCEPT, "*/*")
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body)
        .send();
    let resp = tokio::time::timeout(Duration::from_millis(t.ttfb_ms.max(1)), send)
        .await
        .map_err(|_| HttpFault::Timeout { stage: "ttfb".to_string(), timeout_ms: t.ttfb_ms })?
        .map_err(fault_of)?;
    let status = resp.status().as_u16();
    let stream = resp.bytes_stream().map_err(fault_of);
    Ok(HttpStream { status, stream: Box::pin(stream) })
}
