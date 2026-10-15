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
use std::time::{Duration, Instant};

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
///
/// 🔴 `is_timeout() && is_connect()` 是**建连层**超时（`connect_timeout` 命中，含 DNS / 黑洞地址）——
///    必须归到 `stage: "connect"` 而不是笼统的 `total`：
///    「不可达要快败」是四层超时里的第一档，归错层会让现场只剩一句「等满了才失败」。
///    `connect_ms` 由调用方传入（本层不认识配置）。
fn fault_of(e: reqwest::Error, connect_ms: u64) -> HttpFault {
    let native = Some(format!("{e}"));
    if e.is_timeout() {
        if e.is_connect() {
            return HttpFault::Timeout { stage: "connect".to_string(), timeout_ms: connect_ms };
        }
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

/// 「建连 + 首字节」共用一段 socket 生命期，谁短谁先响 ⇒ 该段的归因由两者的大小关系决定。
/// （Node 侧同款语义：`connectTimer` 独立于 `req.setTimeout(ttfbMs)`，先到先报。）
fn first_phase_budget(t: &Timeouts) -> Duration {
    Duration::from_millis(t.connect_ms.max(1).min(t.ttfb_ms.max(1)))
}

fn first_phase_fault(t: &Timeouts) -> HttpFault {
    if t.connect_ms <= t.ttfb_ms {
        HttpFault::Timeout { stage: "connect".to_string(), timeout_ms: t.connect_ms }
    } else {
        HttpFault::Timeout { stage: "ttfb".to_string(), timeout_ms: t.ttfb_ms }
    }
}

fn urlencode(fields: &[(String, String)]) -> String {
    let mut ser = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in fields {
        ser.append_pair(k, v);
    }
    ser.finish()
}

/// POST form，收**全体**响应（不跟随重定向：3xx 作为普通 status 返回，由调用方决定）。
///
/// 三层在这里各就各位：**建连/首字节**共用第一段（[`first_phase_budget`]）· 读体按**块**施加
/// `idle` · 整体由 `total` 兜底。🔴 读体不能只挂 `total`：「卡住」与「慢慢吐」只有空闲超时
/// 能区分 —— 少这一档，一个永远吐半截的上游与一个慢慢吐完的上游会一起变成「等满总时长」。
pub async fn post_form(url: &str, fields: &[(String, String)], t: &Timeouts) -> Result<HttpOk, HttpFault> {
    let client = client(t.connect_ms)?;
    let body = urlencode(fields);
    let started = Instant::now();
    let total = Duration::from_millis(t.total_ms.max(1));
    let send = client
        .post(url)
        .header(reqwest::header::ACCEPT, "*/*")
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body)
        .send();
    // 建连 / 首字节（响应头到达之前）
    let resp = tokio::time::timeout(first_phase_budget(t), send)
        .await
        .map_err(|_| first_phase_fault(t))?
        .map_err(|e| fault_of(e, t.connect_ms))?;
    let status = resp.status().as_u16();

    let mut stream = resp.bytes_stream().map_err(|e| fault_of(e, t.connect_ms));
    let mut buf: Vec<u8> = Vec::new();
    loop {
        // 整体兜底：预算按**请求起点**起算（与 Node 的 totalTimer 同一条时间轴）
        let left = total.saturating_sub(started.elapsed());
        if left.is_zero() {
            return Err(HttpFault::Timeout { stage: "total".to_string(), timeout_ms: t.total_ms });
        }
        let budget = left.min(Duration::from_millis(t.idle_ms.max(1)));
        match tokio::time::timeout(budget, futures_util::StreamExt::next(&mut stream)).await {
            Err(_) => {
                let stage = if budget < left { "idle" } else { "total" };
                let ms = if stage == "idle" { t.idle_ms } else { t.total_ms };
                return Err(HttpFault::Timeout { stage: stage.to_string(), timeout_ms: ms });
            }
            Ok(None) => break,
            Ok(Some(Err(f))) => return Err(f),
            Ok(Some(Ok(bytes))) => buf.extend_from_slice(&bytes),
        }
    }
    Ok(HttpOk { status, body: buf })
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
    let resp = tokio::time::timeout(first_phase_budget(t), send)
        .await
        .map_err(|_| first_phase_fault(t))?
        .map_err(|e| fault_of(e, t.connect_ms))?;
    let status = resp.status().as_u16();
    let connect_ms = t.connect_ms;
    let stream = resp.bytes_stream().map_err(move |e| fault_of(e, connect_ms));
    Ok(HttpStream { status, stream: Box::pin(stream) })
}
