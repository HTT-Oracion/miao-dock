// boxsvc —— 服务运行时的 Rust 实现（F 组主线）
//
// ## 形态（F1：反代渐进）
// 本进程在 127.0.0.1:5180–5190 起一个 axum 服务，**保留 Node box-service 的 HTTP 契约不变**
// （同一套路径、同一套错误信封、同一套鉴权），未迁移的端点用 `reqwest` 转发给遗留的
// Node 后端，迁一个摘一个。⇒ 前端与 e2e **都不换靶子**：换的只是「谁在监听这个端口」。
//
// ## 与 Node 版的分工（过渡期）
//   · 本模块自带：端口探测、就绪行、CORS/Origin 白名单、令牌校验、错误信封、`/health`
//   · 转发：其余全部 `/api/v1/**` 原样透传给遗留后端（含 SSE 流式与 multipart）
//
// ## 为什么保留 `MIAO_LEGACY_BACKEND`
// e2e 的 rust 靶子要能**自成一套**跑起来，就必须自己拉遗留后端（见 `backend.rs`）。
// `MIAO_LEGACY_BACKEND=0` 关掉它 ⇒ 未迁移端点返回 502 —— 这是 F1 反证轮的红线：
// 证明"转发分支真的在工作"，而不是 Rust 自己把端点都实现了。
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;

pub mod backend;

use backend::LegacyBackend;

/// 服务名 / 版本 —— 与 `service/src/config.mjs` 的 `SERVICE_NAME` / `SERVICE_VERSION` 对齐
pub const SERVICE_NAME: &str = "box-service";
pub const SERVICE_VERSION: &str = "1.2.0";
pub const API_VERSION: &str = "v1";

const PORT_RANGE_START: u16 = 5180;
const PORT_RANGE_END: u16 = 5190;

/// 共享状态：遗留后端地址 + 令牌（本进程的令牌从遗留后端就绪行**继承**）
#[derive(Clone)]
pub struct Shell {
    backend_base: Option<String>,
    token: Option<String>,
    root_dir: String,
    /// 转发用的异步 HTTP 客户端（长超时：引擎翻译可能分钟级）
    client: reqwest::Client,
}

/// 启动参数（环境变量驱动；独立 bin 与 Tauri 内嵌都走它）
pub struct Options {
    /// 遗留后端入口脚本（Node）。`None` 或 env `MIAO_LEGACY_BACKEND=0` ⇒ 不起遗留后端
    pub legacy_entry: Option<PathBuf>,
    /// 显式端口（`MIAO_PORT`）；`None` 时在 5180–5190 探测
    pub explicit_port: Option<u16>,
}

impl Options {
    pub fn from_env() -> Self {
        let legacy_disabled = std::env::var("MIAO_LEGACY_BACKEND")
            .map(|v| matches!(v.trim(), "0" | "false" | "no" | "off"))
            .unwrap_or(false);
        let legacy_entry = if legacy_disabled {
            None
        } else {
            // 复用「按资源目录 / 向上找」的定位：环境变量优先，其次仓库根
            let env_key = "MIAO_LEGACY_ENTRY";
            let from_env = std::env::var(env_key).ok().filter(|s| !s.is_empty()).map(PathBuf::from);
            match from_env {
                Some(p) if p.is_file() => Some(p),
                _ => {
                    let p = crate::paths::repo_root().join("service").join("src").join("server.mjs");
                    if p.is_file() { Some(p) } else { None }
                }
            }
        };
        let explicit_port = std::env::var("MIAO_PORT")
            .ok()
            .filter(|s| !s.is_empty())
            .and_then(|s| s.parse::<u16>().ok());
        Options { legacy_entry, explicit_port }
    }
}

/// 以 **阻塞** 方式跑起来（供独立 `boxsvc` bin；Tauri 侧可另起线程调用）。
///
/// 返回 `Ok(())` 表示服务已正常关闭。
pub fn run_blocking(opts: Options) -> Result<(), String> {
    // 1) 先起遗留后端（若开），拿到它的端口与令牌
    let shell = if let Some(entry) = &opts.legacy_entry {
        match LegacyBackend::spawn(entry, Duration::from_secs(30)) {
            Ok(b) => {
                let s = Shell {
                    backend_base: Some(b.base.clone()),
                    token: Some(b.token.clone()),
                    root_dir: b.root_dir.clone(),
                    client: make_client(),
                };
                *backend::LEGACY.lock().unwrap() = Some(b);
                s
            }
            Err(e) => return Err(format!("遗留后端起不来：{e}")),
        }
    } else {
        Shell {
            backend_base: None,
            token: std::env::var("MIAO_TOKEN").ok().filter(|s| !s.is_empty()),
            root_dir: crate::paths::root_dir().to_string_lossy().into_owned(),
            client: make_client(),
        }
    };

    // 2) 绑定端口（显式优先，否则在段内探测 —— 与 Node 版 `listenWithProbe` 同语义）
    let (port, listener) = bind_with_probe(opts.explicit_port)?;

    // 3) 打印**本进程**的就绪行（e2e / Rust ServiceManager 都据此拿端口与令牌）
    let ready = serde_json::json!({
        "port": port,
        "token": shell.token.clone().unwrap_or_default(),
        "rootDir": shell.root_dir,
    });
    println!("[box-service] MIAO_READY {ready}");
    println!("[box-service] boxsvc 监听 127.0.0.1:{port}（遗留后端：{}）",
        shell.backend_base.clone().unwrap_or_else(|| "无（纯 Rust，未迁移端点 502）".into()));

    // 4) 跑 axum（阻塞）
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("无法创建 tokio 运行时：{e}"))?;
    let app = router(shell);
    rt.block_on(async move {
        let std_listener = listener;
        std_listener
            .set_nonblocking(true)
            .map_err(|e| format!("set_nonblocking 失败：{e}"))?;
        let l = tokio::net::TcpListener::from_std(std_listener)
            .map_err(|e| format!("转 tokio listener 失败：{e}"))?;
        let server = axum::serve(l, app).with_graceful_shutdown(shutdown_signal());
        server.await.map_err(|e| format!("axum 服务退出异常：{e}"))
    })?;
    // 收尾时必须把遗留后端带走（否则它占着端口成为孤儿）
    backend::shutdown_legacy();
    Ok(())
}

fn make_client() -> reqwest::Client {
    reqwest::Client::builder()
        // 长超时：翻译一张图可能分钟级；SSE 是长连接，用 idle 语义靠底层流控即可。
        .timeout(Duration::from_secs(1800))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// 显式端口优先；否则在 5180–5190 内「先探测再绑定」。
/// 🔴 段内全被占 ⇒ **明确失败**，不静默换到段外（与 Node 版同）。
fn bind_with_probe(explicit: Option<u16>) -> Result<(u16, TcpListener), String> {
    let candidates: Vec<u16> = match explicit {
        Some(p) => vec![p],
        None => (PORT_RANGE_START..=PORT_RANGE_END).collect(),
    };
    let mut last = String::new();
    for port in candidates {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => return Ok((port, l)),
            Err(e) => {
                last = format!("{port}: {e}");
                continue;
            }
        }
    }
    let range = match explicit {
        Some(p) => format!("{p}（MIAO_PORT 指定）"),
        None => format!("{PORT_RANGE_START}–{PORT_RANGE_END}"),
    };
    Err(format!("端口 {range} 全部被占用，boxsvc 启动失败（不静默换到段外）。最后错误：{last}"))
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut s) = signal(SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
}

fn router(shell: Shell) -> Router {
    Router::new().fallback(handler).with_state(Arc::new(shell))
}

/// 全部请求的入口：**自己实现** CORS / 鉴权 / 错误信封 / `/health`，其余转发。
async fn handler(
    State(shell): State<Arc<Shell>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    // 1) Origin 白名单（含 Origin 才校验）—— 契约 §2.1
    if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) {
        if !origin_allowed(origin) {
            eprintln!("[box-service][security] Origin 拒绝：{origin}；{method} {uri}");
            return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "鉴权失败或来源不被允许", serde_json::json!({}));
        }
    }
    // 2) CORS 预检
    if method == Method::OPTIONS {
        let mut resp = StatusCode::NO_CONTENT.into_response();
        apply_cors(resp.headers_mut(), &headers);
        return resp;
    }

    let path = uri.path();

    // 3) 鉴权（/health 豁免）—— 契约 §2.1
    let is_health = path == "/health" || path == format!("/api/{API_VERSION}/health");
    if !is_health {
        let provided = headers.get("x-box-token").and_then(|v| v.to_str().ok());
        if !token_matches(shell.token.as_deref(), provided) {
            eprintln!("[box-service][security] 令牌校验失败：{method} {uri}");
            return envelope(StatusCode::FORBIDDEN, "PERMISSION_DENIED", "鉴权失败或来源不被允许", serde_json::json!({}));
        }
    }

    // 4) `/health`：有遗留后端时**照转**（契约里的 9 字段 sidecar 只有它答得出，F5 才迁）；
    //    没有遗留后端（`MIAO_LEGACY_BACKEND=0` 的自检档）时给一个**本进程**的最小健康体，
    //    否则「纯 Rust 外壳」连存活探针都没有。
    if is_health && shell.backend_base.is_none() {
        return axum::Json(serde_json::json!({
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "apiVersion": API_VERSION,
            "runtime": "rust",
            "legacyBackend": false,
        }))
        .into_response();
    }

    // 5) 未迁移端点 → 转发给遗留后端
    match shell.backend_base.clone() {
        Some(base) => proxy(shell, &base, method, uri, headers, body).await,
        None => envelope(
            StatusCode::BAD_GATEWAY,
            "INTERNAL",
            "端点尚未迁移到 Rust，且遗留后端已关闭（MIAO_LEGACY_BACKEND=0）",
            serde_json::json!({ "path": path }),
        ),
    }
}

/// 反代：原样透传方法与路径，注入令牌，回写状态码 + Content-Type + 流式 body。
async fn proxy(
    shell: Arc<Shell>,
    base: &str,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let target = format!("{base}{}", uri.path_and_query().map(|p| p.as_str()).unwrap_or("/"));
    let req_method = match reqwest::Method::from_bytes(method.as_str().as_bytes()) {
        Ok(m) => m,
        Err(_) => return envelope(StatusCode::METHOD_NOT_ALLOWED, "TASK_NOT_FOUND", &format!("未知方法：{method}"), serde_json::json!({})),
    };

    // body → bytes（服务端最大 256 MiB，同 Node 版；超限由遗留后端与测试各自把关）
    let bytes = match axum::body::to_bytes(body, 256 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            return envelope(StatusCode::BAD_REQUEST, "INVALID_IMAGE", "请求体读取失败", serde_json::json!({ "reason": e.to_string() }));
        }
    };

    let mut rb = shell.client.request(req_method, &target).body(bytes);
    // 透传头（跳过 hop-by-hop、Host、Content-Length 以及**由本进程重新注入/必须剔除**的项）：
    //   · `x-box-token` —— 🔴 绝不能再透传客户端的那个：`reqwest` 的 `.header()` 是**追加**
    //     而不是覆盖，透传 + 注入会让上游收到**两个**同名头，被 Node 的 http 解析器
    //     逗号合并成 `"tok, tok"` ⇒ 令牌校验必然失败（且报的是"令牌无效"，离根因很远）。
    //   · `accept-encoding` —— 本进程不做解压（reqwest 未开 gzip 特性），若上游据此压缩，
    //     我们只回写 `content-type`、丢掉 `content-encoding`，客户端会把压缩字节当明文解析。
    //     直接不发，让上游永远回明文。
    for (k, v) in headers.iter() {
        let name = k.as_str().to_ascii_lowercase();
        if is_hop_by_hop(&name)
            || matches!(name.as_str(), "host" | "content-length" | "x-box-token" | "accept-encoding")
        {
            continue;
        }
        rb = rb.header(k.as_str(), v.as_bytes());
    }
    // 令牌由本进程注入（遗留后端认同一个 —— 它就是从它自己的就绪行继承来的）
    if let Some(t) = &shell.token {
        rb = rb.header("x-box-token", t);
    }

    match rb.send().await {
        Ok(res) => {
            let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            // 收集要回写的头（跳过 hop-by-hop 与 Content-Length —— 长度交给 chunked 流自己算）
            let forwarded: Vec<(String, Vec<u8>)> = res
                .headers()
                .iter()
                .filter(|(k, _)| {
                    let n = k.as_str().to_ascii_lowercase();
                    !is_hop_by_hop(&n) && n != "content-length"
                })
                .map(|(k, v)| (k.as_str().to_string(), v.as_bytes().to_vec()))
                .collect();
            // 流式回写：SSE（`/tasks/{id}/events`）与 multipart 上传都靠它，绝不能整段缓冲
            let stream = res.bytes_stream();
            let mut resp = Response::new(Body::from_stream(stream));
            *resp.status_mut() = status;
            for (k, v) in forwarded {
                if let (Ok(name), Ok(val)) = (
                    axum::http::HeaderName::from_bytes(k.as_bytes()),
                    axum::http::HeaderValue::from_bytes(&v),
                ) {
                    resp.headers_mut().insert(name, val);
                }
            }
            resp
        }
        Err(e) => envelope(
            StatusCode::BAD_GATEWAY,
            "INTERNAL",
            "遗留后端不可达",
            serde_json::json!({ "target": target, "reason": e.to_string() }),
        ),
    }
}

fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name,
        "connection" | "keep-alive" | "proxy-authenticate" | "proxy-authorization"
            | "te" | "trailer" | "transfer-encoding" | "upgrade"
    )
}

/// Origin 白名单：`chrome-extension://*` 或字面量 `null`（Box 桌面端）。
fn origin_allowed(origin: &str) -> bool {
    let o = origin.trim();
    if o.is_empty() || o == "null" {
        return true;
    }
    if let Some(rest) = o.strip_prefix("chrome-extension://") {
        return !rest.is_empty()
            && rest.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    }
    false
}

fn apply_cors(h: &mut HeaderMap, req_headers: &HeaderMap) {
    h.insert("vary", axum::http::HeaderValue::from_static("Origin"));
    h.insert(
        "access-control-allow-headers",
        axum::http::HeaderValue::from_static("X-Box-Token, X-Box-Client"),
    );
    h.insert(
        "access-control-allow-methods",
        axum::http::HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    h.insert("access-control-max-age", axum::http::HeaderValue::from_static("600"));
    // 绝不返回 `*`；仅当请求带 Origin 且被放行时回显它
    if let Some(origin) = req_headers.get("origin").and_then(|v| v.to_str().ok()) {
        if !origin.trim().is_empty() {
            if let Ok(val) = axum::http::HeaderValue::from_bytes(origin.trim().as_bytes()) {
                h.insert("access-control-allow-origin", val);
            }
        }
    }
}

/// 定长比较（避免时序侧信道）—— 与 Node 版 `timingSafeEqual` 同语义。
fn token_matches(expected: Option<&str>, provided: Option<&str>) -> bool {
    let (Some(exp), Some(prov)) = (expected, provided) else {
        return false;
    };
    if prov.is_empty() || exp.len() != prov.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in exp.bytes().zip(prov.bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn envelope(status: StatusCode, code: &str, message: &str, details: serde_json::Value) -> Response {
    let body = serde_json::json!({ "error": { "code": code, "message": message, "details": details } });
    let mut resp = (status, axum::Json(body)).into_response();
    resp.headers_mut().insert(
        "content-type",
        axum::http::HeaderValue::from_static("application/json; charset=utf-8"),
    );
    resp
}
