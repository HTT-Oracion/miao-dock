// boxsvc/engine/client.rs —— 「服务 ↔ 引擎」的**运行期**（F 组 F4-b1）
//
// 移植自 `service/src/engine-client.mjs` 的网络侧：单次 HTTP 往返（含**超时携带部分字节**
// 的 U10② 机制）、TCP 探测、real/mock 两套 `translateImage`、`probeEngine` 三重判定、
// 以及阶段日志环。纯函数（`parseResultStream` / `recordFrame` / `resolveEngineLaunch` /
// `buildEngineConfig` …）在 `engine.rs`（F4-a，已由 `engine-parity-check.mjs` 钉住）。
//
// ## 🔴 三条「与 Node 逐字节/逐语义对齐」的要点
//   ① `no_proxy()`：引擎是**本机** 127.0.0.1，绝不能被系统代理劫走（Node 的 `http.request`
//      不读 env 代理；reqwest **默认会读** `HTTP_PROXY` ⇒ 显式关掉，否则真实环境里
//      「本机引擎不可达」而开发机全绿）。
//   ② 超时是**空闲超时**（每收到一块数据就重置），不是总时长 —— 同 Node `http.request({timeout})`
//      的 socket `timeout` 语义。差别见 `request_once` 注释。
//   ③ **超时必须带走已收到的字节**：只报「超时了」回答不了「引擎在推理 / 在排队 / 完全没动静」，
//      而这是 U10②「静默 17 分钟」事后无法归因的根因（Node 的 `err.partialBody`）。
//
// ## 为什么进程组信号不在这里
// 真引擎（Python / llama-server）的**起停**由 app 侧 `service.rs::signal_tree` 负责（含 Windows
// `taskkill /T /F` 与 unix `kill(-pgid)`）—— F4 明确「复用现有实现，不新写」。本文件只管**协议**。
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};

use crate::boxsvc::store::pure::sniff_image_type;

use super::{
    build_engine_config, default_engine_port, engine_protocol, engine_version, env_bool, env_int,
    mime_of_ext, parse_result_stream, record_frame, take_chars, EngineError, STAGE_LOG_MAX,
    STAGE_TEXT_MAX,
};

// ================================================================ 阶段日志环（模块级，同 Node 的 STAGE_LOG）

/// 环形缓冲（新的在后）。🔴 模块级**故意**做成全局：`/engine/status` 的 `recentStageLog`
/// 读的就是「最近这台引擎在处理什么阶段」，它跨请求存活（同 Node 的 `STAGE_LOG`）。
static STAGE_LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// 直接推入**已成行**的日志（`record_frame` 的返回值已是 `seq N: <text>`）。
pub fn push_stage_line(line: String) {
    let mut g = STAGE_LOG.lock().unwrap();
    g.push(line);
    let over = g.len().saturating_sub(STAGE_LOG_MAX);
    if over > 0 {
        g.drain(0..over);
    }
}

/// 记一条阶段（`seq` 是**服务端**的图片序号，不是引擎的）。空文本不产生行。
pub fn push_stage(seq: i64, text: &str) {
    let line = text.trim();
    if line.is_empty() {
        return;
    }
    push_stage_line(format!("seq {}: {}", seq, take_chars(line, STAGE_TEXT_MAX)));
}

/// 取尾部 `n` 条（新的在后）；`n <= 0` 取全部。给 `/engine/status` 用。
pub fn recent_stage_log(n: i64) -> Vec<String> {
    let g = STAGE_LOG.lock().unwrap();
    if n > 0 {
        let n = n as usize;
        let start = g.len().saturating_sub(n);
        g[start..].to_vec()
    } else {
        g.clone()
    }
}

/// 清空。**只给验收夹具用**：让「这段日志确实来自本次请求」可被取证，而不是撞上上一轮的残留。
pub fn clear_stage_log() {
    STAGE_LOG.lock().unwrap().clear();
}

// ================================================================ 引擎连接配置

/// 引擎连接参数（`config.mjs` 里 `engineProtocol/engineHost/enginePort/engineTimeoutMs/
/// engineProbeMs/sidecarDown` 的 Rust 侧投影）。
#[derive(Debug, Clone)]
pub struct EngineCfg {
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub timeout_ms: i64,
    pub probe_ms: i64,
    pub sidecar_down: bool,
}

impl EngineCfg {
    pub fn from_env() -> Self {
        let protocol = engine_protocol();
        // 与 `config.mjs` 同口径：真档 600s、mock 档 60s（mock 是替身，超短）。
        let def_timeout = if protocol == "mock" { 60_000 } else { 600_000 };
        EngineCfg {
            port: default_engine_port(),
            host: "127.0.0.1".to_string(),
            timeout_ms: env_int("MIAO_ENGINE_TIMEOUT_MS", def_timeout),
            probe_ms: env_int("MIAO_ENGINE_PROBE_MS", 800),
            sidecar_down: env_bool("MIAO_SIDECAR_DOWN", false),
            protocol,
        }
    }
}

// ================================================================ 单次 HTTP 往返

pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// `request_once` 的失败分类（Node 侧表现为两种 `EngineError`）。
enum HttpError {
    /// 超时：`partial` 是**已经收到**的字节（可能为空）。
    Timeout {
        limit_ms: i64,
        received: usize,
        partial: Vec<u8>,
    },
    /// 不可达（ECONNREFUSED / ECONNRESET / 连接失败）。
    Unavailable { message: String },
}

fn unavailable(cfg: &EngineCfg, e: &reqwest::Error) -> HttpError {
    // 与 Node 同口径：`引擎不可达（host:port）：<原因>`。原因文本随平台（Node 报 err.code、
    // Rust 报 reqwest 描述），**断言只比 code**，不比这句文案。
    let reason = if e.is_connect() {
        "连接被拒"
    } else {
        "网络错误"
    };
    HttpError::Unavailable {
        message: format!("引擎不可达（{}:{}）：{}", cfg.host, cfg.port, reason),
    }
}

/// 单次 HTTP 往返。
///
/// `timeout_ms` 是**空闲超时**（每读到一个块就重置）—— 与 Node `http.request({timeout})` 的
/// socket `timeout` 语义一致：一次翻译可以流式吐进度帧很久，只要**一直在动**就不算超时。
/// ⚠️ 与 Node 的已知偏离：Node 的计时从 `http.request()` 起（含连接/发送阶段的空闲），
///    这里发送阶段用一个初始 deadline 覆盖、读取阶段每块重置 —— 对「卡住不给数据」的场景等价。
async fn request_once(
    cfg: &EngineCfg,
    path: &str,
    method: &str,
    headers: &[(String, String)],
    body: Option<Vec<u8>>,
    timeout_ms: i64,
) -> Result<HttpResponse, HttpError> {
    // 🔴 `no_proxy()`：本机引擎必须直连（见模块头 ①）。
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| HttpError::Unavailable {
            message: format!("引擎不可达（{}:{}）：{}", cfg.host, cfg.port, e),
        })?;
    let url = format!("http://{}:{}{}", cfg.host, cfg.port, path);
    let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| HttpError::Unavailable {
        message: format!("非法方法 {method}：{e}"),
    })?;
    let mut req = client.request(m, &url);
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    let limit = timeout_ms.max(0) as u64;
    let limit_dur = Duration::from_millis(limit);
    let deadline0 = tokio::time::Instant::now() + limit_dur;
    let mut resp = match tokio::time::timeout_at(deadline0, req.send()).await {
        Err(_) => {
            return Err(HttpError::Timeout {
                limit_ms: timeout_ms,
                received: 0,
                partial: Vec::new(),
            })
        }
        Ok(Err(e)) => return Err(unavailable(cfg, &e)),
        Ok(Ok(r)) => r,
    };
    let status = resp.status().as_u16();
    let mut acc: Vec<u8> = Vec::new();
    loop {
        // 每次等待新块前重置 deadline ⇒ 空闲超时语义。
        let dl = tokio::time::Instant::now() + limit_dur;
        match tokio::time::timeout_at(dl, resp.chunk()).await {
            Err(_) => {
                return Err(HttpError::Timeout {
                    limit_ms: timeout_ms,
                    received: acc.len(),
                    partial: acc,
                })
            }
            Ok(Err(e)) => return Err(unavailable(cfg, &e)),
            Ok(Ok(None)) => break,
            Ok(Ok(Some(c))) => acc.extend_from_slice(&c),
        }
    }
    Ok(HttpResponse { status, body: acc })
}

// ================================================================ TCP 探测（就绪判定的 ①/③ 层）

/// TCP 端口探测。失败一律 `false`，不抛错。
pub async fn probe_tcp(host: &str, port: u16, timeout_ms: i64) -> bool {
    let addr = format!("{host}:{port}");
    let dur = Duration::from_millis(timeout_ms.max(0) as u64);
    matches!(
        tokio::time::timeout(dur, tokio::net::TcpStream::connect(&addr)).await,
        Ok(Ok(_))
    )
}

// ================================================================ 错误归一化

/// 从 FastAPI 错误信封取出人可读的 `detail`；解析不出来就回退原始文本（截 300）。
fn read_fastapi_detail(body: &[u8]) -> String {
    let raw = String::from_utf8_lossy(body);
    if let Ok(v) = serde_json::from_slice::<Value>(body) {
        if let Some(d) = v.get("detail") {
            if !d.is_null() {
                return match d.as_str() {
                    Some(s) => s.to_string(),
                    None => d.to_string(),
                };
            }
        }
    }
    take_chars(&raw, 300)
}

/// 归一化引擎 HTTP 错误 → `EngineError{code}`（`store` 据此生成 `engine_<code>` 失败原因）。
fn normalize_http_error(status: u16, body: &[u8]) -> EngineError {
    let detail = read_fastapi_detail(body);
    let code = match status {
        422 => "ENGINE_BAD_INPUT",
        404 => "ENGINE_NOT_FOUND",
        _ => "ENGINE_ERROR",
    };
    let message = if detail.is_empty() {
        format!("引擎返回 {status}")
    } else {
        format!("引擎返回 {status}：{detail}")
    };
    EngineError::with_detail(code, message, json!({ "status": status, "detail": detail }))
}

// ================================================================ 入参 / 出参

/// 任务方向（新形状 `{from,to}` 短码）。
#[derive(Debug, Clone, Default)]
pub struct LangPair {
    pub from: Option<String>,
    pub to: Option<String>,
}

/// `translateImage(bytes, opts)` 的 `opts`。
#[derive(Debug, Clone, Default)]
pub struct TranslateOpts {
    /// 服务端**图片序号**（进阶段日志，不是引擎的）。
    pub seq: i64,
    /// 新形状方向（优先）。
    pub lang: Option<LangPair>,
    /// ver1.0 老形状（回落）。
    pub from: Option<String>,
    pub to: Option<String>,
    /// mock 档的 `Content-Type`（缺省 `application/octet-stream`）。
    pub mime: Option<String>,
    /// 由 store 的**单项总预算**下发；缺省取 `cfg.timeout_ms`。
    pub timeout_ms: Option<i64>,
}

/// 两个来源都收：`lang` 优先，其次 `from`/`to`（ver1.0 兼容面）。
fn lang_of(o: &TranslateOpts) -> (Option<String>, Option<String>) {
    if let Some(l) = &o.lang {
        return (l.from.clone(), l.to.clone());
    }
    (o.from.clone(), o.to.clone())
}

pub struct TranslateOk {
    pub bytes: Vec<u8>,
    pub ext: String,
    pub mime: String,
}

/// 单张翻译的入口校验：**real 协议下提前拦掉**，省一次网络往返（也把「图坏了」与「引擎坏了」分开）。
fn assert_translatable_image(bytes: &[u8]) -> Result<&'static str, EngineError> {
    if bytes.is_empty() {
        return Err(EngineError::new("BAD_INPUT", "原图字节为空，拒绝送翻译"));
    }
    sniff_image_type(bytes)
        .ok_or_else(|| EngineError::new("BAD_INPUT", "原图字节不是可识别图片（PNG/JPEG/WEBP）"))
}

// ================================================================ real 协议

pub async fn real_translate_image(
    cfg: &EngineCfg,
    bytes: &[u8],
    opts: &TranslateOpts,
) -> Result<TranslateOk, EngineError> {
    let seq = opts.seq;
    let ext = assert_translatable_image(bytes)?;
    let (from, to) = lang_of(opts);
    // 用**嗅探结果**构造 data URI —— 不信调用方给的 mime。
    let payload = serde_json::to_vec(&json!({
        "image": format!(
            "data:{};base64,{}",
            mime_of_ext(ext),
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ),
        "config": build_engine_config(from.as_deref(), to.as_deref()),
    }))
    .map_err(|e| EngineError::new("ENGINE_ERROR", format!("构造请求体失败：{e}")))?;
    let headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Content-Length".to_string(), payload.len().to_string()),
    ];
    let limit = opts.timeout_ms.unwrap_or(cfg.timeout_ms);
    let res = match request_once(cfg, "/translate/image/stream", "POST", &headers, Some(payload), limit).await {
        Ok(r) => r,
        Err(HttpError::Timeout {
            limit_ms,
            received,
            partial,
        }) => {
            // 超时也留下「它最后在做什么」：把已收到的部分字节解析成阶段，附进错误详情。
            let parsed = parse_result_stream(&partial);
            let frames: Vec<Value> = parsed
                .frames
                .iter()
                .map(|f| serde_json::to_value(f).unwrap_or(Value::Null))
                .collect();
            for f in &parsed.frames {
                if let Some(line) = record_frame(seq, f) {
                    push_stage_line(line);
                }
            }
            return Err(EngineError::with_detail(
                "ENGINE_TIMEOUT",
                format!("引擎响应超时（{limit_ms}ms 内没等到结帧；期间收到 {received} 字节）"),
                json!({ "timeoutMs": limit_ms, "receivedBytes": received, "frames": frames }),
            ));
        }
        Err(HttpError::Unavailable { message }) => {
            return Err(EngineError::new("ENGINE_UNAVAILABLE", message))
        }
    };

    // 流式端点的错误分两层：handler 之前的（422 等）走 HTTP 状态码；之后的走流里的 code 2。
    if res.status != 200 {
        return Err(normalize_http_error(res.status, &res.body));
    }

    let parsed = parse_result_stream(&res.body);
    // 先记阶段、再判成败 —— 失败路径恰恰**最需要**知道「卡在哪个阶段」。
    for f in &parsed.frames {
        if let Some(line) = record_frame(seq, f) {
            push_stage_line(line);
        }
    }
    let frames: Vec<Value> = parsed
        .frames
        .iter()
        .map(|f| serde_json::to_value(f).unwrap_or(Value::Null))
        .collect();

    match parsed.result {
        Some(result) => {
            // 扩展名取**服务端对返回字节的嗅探结果**，不信任引擎自称的 Content-Type。
            let out_ext = sniff_image_type(&result).ok_or_else(|| {
                EngineError::with_detail(
                    "ENGINE_BAD_OUTPUT",
                    "引擎返回的字节不是可识别的图片（PNG/JPEG/WEBP）",
                    json!({ "seq": seq, "bytes": result.len(), "frames": frames }),
                )
            })?;
            Ok(TranslateOk {
                mime: mime_of_ext(out_ext),
                ext: out_ext.to_string(),
                bytes: result,
            })
        }
        None => {
            if let Some(err) = parsed.error {
                Err(EngineError::with_detail(
                    "ENGINE_ERROR",
                    format!("引擎报告：{err}"),
                    json!({ "seq": seq, "frames": frames }),
                ))
            } else {
                Err(EngineError::with_detail(
                    "ENGINE_BAD_OUTPUT",
                    "结果流里没有结果帧（code 0）",
                    json!({ "seq": seq, "frames": frames }),
                ))
            }
        }
    }
}

// ================================================================ mock 协议

pub async fn mock_translate_image(
    cfg: &EngineCfg,
    bytes: &[u8],
    opts: &TranslateOpts,
) -> Result<TranslateOk, EngineError> {
    let mime = opts
        .mime
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let (lf, lt) = lang_of(opts);
    let from = lf.unwrap_or_else(|| "ja".to_string());
    let to = lt.unwrap_or_else(|| "zh".to_string());
    if bytes.is_empty() {
        return Err(EngineError::new("BAD_INPUT", "原图字节为空，拒绝送翻译"));
    }
    let headers = vec![
        ("Content-Type".to_string(), mime),
        ("Content-Length".to_string(), bytes.len().to_string()),
        ("X-Miao-Seq".to_string(), opts.seq.to_string()),
        ("X-Miao-From".to_string(), from),
        ("X-Miao-To".to_string(), to),
    ];
    let limit = opts.timeout_ms.unwrap_or(cfg.timeout_ms);
    let res = match request_once(cfg, "/translate", "POST", &headers, Some(bytes.to_vec()), limit).await {
        Ok(r) => r,
        Err(HttpError::Timeout {
            limit_ms,
            received,
            ..
        }) => {
            return Err(EngineError::with_detail(
                "ENGINE_TIMEOUT",
                format!("引擎响应超时（{limit_ms}ms 内没等到结帧；期间收到 {received} 字节）"),
                json!({ "timeoutMs": limit_ms, "receivedBytes": received }),
            ))
        }
        Err(HttpError::Unavailable { message }) => {
            return Err(EngineError::new("ENGINE_UNAVAILABLE", message))
        }
    };
    if res.status != 200 {
        let mut code = "ENGINE_ERROR".to_string();
        let mut message = format!("引擎返回 {}", res.status);
        if let Ok(v) = serde_json::from_slice::<Value>(&res.body) {
            if let Some(err) = v.get("error") {
                if let Some(c) = err.get("code").and_then(|x| x.as_str()) {
                    code = c.to_string();
                }
                if let Some(mm) = err.get("message").and_then(|x| x.as_str()) {
                    message = mm.to_string();
                }
            }
        }
        return Err(EngineError::with_detail(&code, message, json!({ "status": res.status })));
    }
    let ext = sniff_image_type(&res.body).ok_or_else(|| {
        EngineError::new("ENGINE_BAD_OUTPUT", "引擎返回的字节不是可识别的图片（PNG/JPEG/WEBP）")
    })?;
    Ok(TranslateOk {
        bytes: res.body,
        ext: ext.to_string(),
        mime: mime_of_ext(ext),
    })
}

// ================================================================ 对外接口

/// 单张翻译。**签名与 ver1.0 保持一致** —— `store` 不应感知引擎换代。
pub async fn translate_image(
    cfg: &EngineCfg,
    bytes: &[u8],
    opts: &TranslateOpts,
) -> Result<TranslateOk, EngineError> {
    if cfg.protocol == "mock" {
        mock_translate_image(cfg, bytes, opts).await
    } else {
        real_translate_image(cfg, bytes, opts).await
    }
}

/// 组装 `sidecar` 的 9 字段（`state/port/engine/engineVersion` + 恒 null 的 5 个服务级字段）。
fn probe_value(
    state: &str,
    port: Option<u16>,
    engine: Option<&str>,
    engine_version: Option<&str>,
) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("state".into(), json!(state));
    m.insert("port".into(), port.map(|p| json!(p)).unwrap_or(Value::Null));
    m.insert("engine".into(), engine.map(|e| json!(e)).unwrap_or(Value::Null));
    m.insert(
        "engineVersion".into(),
        engine_version.map(|v| json!(v)).unwrap_or(Value::Null),
    );
    for k in ["tier", "accel", "warmed", "llm", "model"] {
        m.insert(k.into(), Value::Null);
    }
    Value::Object(m)
}

/// 就绪**三重判定**（《04》§2.4）：
///   ① TCP 引擎端口在听            —— 否则 `stopped`
///   ② HTTP `POST /queue-size` 200 —— 否则 `starting`（进程在、HTTP 层还没接客）
///   ③ **执行器端口**（`port+1`）在听 —— 否则 `prewarming`（HTTP 在、翻译能力还没接客 = L3 预热）
///
/// 🔴 为什么必须有 ③：上游 spawn 执行器用 `port+1` 且**不等端口就绪即注册实例** ⇒ 只看 ①②
///    会把「执行器还在起」（torch 加载，真机数十秒）误判成 `running`，于是**第一张必挂**。
pub async fn real_probe(cfg: &EngineCfg) -> Value {
    let ev = engine_version();
    let ev = ev.as_deref();
    if !probe_tcp(&cfg.host, cfg.port, cfg.probe_ms).await {
        return probe_value("stopped", None, None, ev);
    }
    // ⚠️ **POST**（上游是 `@app.post("/queue-size")`）。写成 GET 会 405。
    let http_ok = matches!(
        request_once(cfg, "/queue-size", "POST", &[], None, cfg.probe_ms).await,
        Ok(r) if r.status == 200
    );
    if !http_ok {
        return probe_value("starting", Some(cfg.port), Some("manga-image-translator"), ev);
    }
    let executor_up = probe_tcp(&cfg.host, cfg.port.wrapping_add(1), cfg.probe_ms).await;
    probe_value(
        if executor_up { "running" } else { "prewarming" },
        Some(cfg.port),
        Some("manga-image-translator"),
        ev,
    )
}

pub async fn mock_probe(cfg: &EngineCfg) -> Value {
    let ev = engine_version();
    let ev = ev.as_deref();
    match request_once(cfg, "/ready", "GET", &[], None, cfg.probe_ms).await {
        Ok(r) if r.status == 200 => match serde_json::from_slice::<Value>(&r.body) {
            // 200 但 JSON 解析失败 ⇒ 与 Node 同：落到 `stopped`（解析异常被外层 catch 吞掉）。
            Ok(v) => {
                let engine = v
                    .get("engine")
                    .and_then(|x| x.as_str())
                    .filter(|s| !s.is_empty());
                probe_value("running", Some(cfg.port), engine, ev)
            }
            Err(_) => probe_value("stopped", None, None, ev),
        },
        Ok(_) => probe_value("starting", Some(cfg.port), None, ev),
        Err(_) => probe_value("stopped", None, None, ev),
    }
}

/// `sidecar` 就绪探测：**不抛错**，只回答状态。⚠️ 只回答**引擎侧**的问题。
pub async fn probe_engine(cfg: &EngineCfg) -> Value {
    if cfg.sidecar_down {
        return probe_value("stopped", None, None, engine_version().as_deref());
    }
    if cfg.protocol == "mock" {
        mock_probe(cfg).await
    } else {
        real_probe(cfg).await
    }
}

// ================================================================ 自证（`--engine-http-selftest`）

/// 跑一批「对拍用例」，打印结果。用途：e2e 做「Rust 与 Node 的 engine HTTP 运行期同源」比对。
///
/// 用例形状：
///   `{ kind: "translate", protocol, host, port, timeoutMs?, seq?, lang?{from,to}, mime?, inB64? }`
///   `{ kind: "probe", protocol, host, port, probeMs?, sidecarDown? }`
/// 输出：`{ "results": [ { name, ok, code?, message?, bytesB64?, ext?, mime?, stageLines, probe? } ] }`
pub fn http_selftest(arg: &str) -> String {
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
        let mut results = Vec::new();
        for case in &cases {
            results.push(run_case(case).await);
        }
        json!({ "results": results })
    });
    serde_json::to_string_pretty(&out).unwrap_or_else(|e| json!({ "error": e.to_string() }).to_string())
}

fn case_str<'a>(case: &'a Value, key: &str) -> Option<&'a str> {
    case.get(key).and_then(|v| v.as_str())
}

fn case_u64(case: &Value, key: &str) -> Option<u64> {
    case.get(key).and_then(|v| v.as_u64())
}

async fn run_case(case: &Value) -> Value {
    let name = case_str(case, "name").unwrap_or("").to_string();
    let cfg = EngineCfg {
        protocol: case_str(case, "protocol").unwrap_or("real").to_string(),
        host: case_str(case, "host").unwrap_or("127.0.0.1").to_string(),
        port: case_u64(case, "port").unwrap_or(0) as u16,
        timeout_ms: case_u64(case, "timeoutMs").unwrap_or(600_000) as i64,
        probe_ms: case_u64(case, "probeMs").unwrap_or(400) as i64,
        sidecar_down: case.get("sidecarDown").and_then(|v| v.as_bool()).unwrap_or(false),
    };
    let kind = case_str(case, "kind").unwrap_or("translate");

    if kind == "probe" {
        let probe = probe_engine(&cfg).await;
        return json!({ "name": name, "ok": true, "probe": probe });
    }

    let bytes = case
        .get("inB64")
        .and_then(|v| v.as_str())
        .map(|s| base64::engine::general_purpose::STANDARD.decode(s).unwrap_or_default())
        .unwrap_or_default();
    let opts = TranslateOpts {
        seq: case.get("seq").and_then(|v| v.as_i64()).unwrap_or(0),
        lang: case.get("lang").map(|l| LangPair {
            from: l.get("from").and_then(|v| v.as_str()).map(String::from),
            to: l.get("to").and_then(|v| v.as_str()).map(String::from),
        }),
        mime: case_str(case, "mime").map(String::from),
        ..Default::default()
    };
    clear_stage_log();
    match translate_image(&cfg, &bytes, &opts).await {
        Ok(r) => json!({
            "name": name,
            "ok": true,
            "bytesB64": base64::engine::general_purpose::STANDARD.encode(&r.bytes),
            "ext": r.ext,
            "mime": r.mime,
            "stageLines": recent_stage_log(50),
        }),
        Err(e) => json!({
            "name": name,
            "ok": false,
            "code": e.code,
            "message": e.message,
            "stageLines": recent_stage_log(50),
        }),
    }
}

// ================================================================ 单测

#[cfg(test)]
mod tests {
    use super::*;

    // ⚠️ 阶段日志是**模块级全局**（同 Node 的 STAGE_LOG）⇒ 这两段必须写在**同一个测试**里，
    //    否则并行执行时互相污染（`cargo test` 默认多线程）。
    #[test]
    fn stage_log_ring_truncates_and_skips_blank() {
        clear_stage_log();
        // 空白文本不产生行
        push_stage(1, "   ");
        assert!(recent_stage_log(0).is_empty());
        // 超长文本截断到 STAGE_TEXT_MAX；行数刚好 +1
        let long = "字".repeat(200);
        push_stage(2, &long);
        let one = recent_stage_log(0);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].chars().count(), "seq 2: ".chars().count() + STAGE_TEXT_MAX);
        // 环形上限：写满后只留最后 STAGE_LOG_MAX 条、淘汰最旧的
        clear_stage_log();
        for i in 0..(STAGE_LOG_MAX + 10) {
            push_stage(i as i64, &format!("阶段{i}"));
        }
        let all = recent_stage_log(0);
        assert_eq!(all.len(), STAGE_LOG_MAX);
        assert_eq!(all.first().map(String::as_str), Some("seq 10: 阶段10"));
        let last = STAGE_LOG_MAX + 9;
        assert_eq!(all.last().map(String::as_str), Some(format!("seq {last}: 阶段{last}").as_str()));
        // n>0 取尾部 n
        let tail = recent_stage_log(3);
        assert_eq!(tail.len(), 3);
        assert_eq!(tail.last(), all.last());
        clear_stage_log();
    }

    #[test]
    fn read_fastapi_detail_reads_json_string_else_raw_tail() {
        assert_eq!(read_fastapi_detail(br#"{"detail":"bad input"}"#), "bad input");
        assert_eq!(read_fastapi_detail(br#"{"detail":{"a":1}}"#), r#"{"a":1}"#);
        assert_eq!(read_fastapi_detail(b"oops"), "oops");
        assert_eq!(read_fastapi_detail(b""), "");
    }

    #[test]
    fn normalize_http_error_maps_status_to_code() {
        assert_eq!(normalize_http_error(422, b"{}").code, "ENGINE_BAD_INPUT");
        assert_eq!(normalize_http_error(404, b"{}").code, "ENGINE_NOT_FOUND");
        assert_eq!(normalize_http_error(500, b"{}").code, "ENGINE_ERROR");
    }

    #[test]
    fn probe_value_has_exactly_nine_keys_with_null_placeholders() {
        let v = probe_value("stopped", None, None, Some("mock"));
        let o = v.as_object().unwrap();
        assert_eq!(o.len(), 9);
        assert_eq!(o["engineVersion"], "mock");
        assert!(o["tier"].is_null() && o["llm"].is_null() && o["model"].is_null());
        assert!(o["port"].is_null());
    }
}
