// 有道智云平台适配器 —— 有道**全部细节**的唯一落点
// =============================================================================
// 契约依据：在线翻译服务设计方案 §5（签名 v3 / llm-trans / api 两接口）· §4.3（语言码）。
// 移植自 `service/src/manga/translate/platforms/youdao.mjs`。
//
// 🔴 单一耦合点范式：本文件是**唯一**允许出现 `openapi.youdao.com`、`sign` 算法、
//    `errorCode` 数字的地方。越过这条界泄漏字段名 / 签名 / 错误码 = 缺陷。
//
// 两个接口的判成功方式**不同**：
//   · llm-trans：`code === "0"`（字符串）**且** `successful === true` 双判；
//   · api（text）：`errorCode === "0"` 单判，**没有** `successful` 字段。
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use super::errors::{map_http_fault, map_upstream_code, TranslateError};
use super::http::{self, Timeouts};
use super::refute;
use super::sse_parse::{as_object, LineParser};

/// 文本翻译（整体）端点路径
const TEXT_API_PATH: &str = "/api";
/// 大模型翻译（流式）端点路径
const LLM_API_PATH: &str = "/proxy/http/llm-trans";

/// 出网基址接缝（**验收专用**）：默认生产地址；`MIAO_TRANSLATE_YOUDAO_BASE` 供 e2e 假上游覆盖。
/// 🔴 **每次调用现读**，不缓存：反证轮是「一个开关一个子进程」，且用例之间要能切址。
fn base_url() -> String {
    let raw = std::env::var("MIAO_TRANSLATE_YOUDAO_BASE").unwrap_or_default();
    let v = raw.trim();
    if v.is_empty() {
        "https://openapi.youdao.com".to_string()
    } else {
        v.trim_end_matches('/').to_string()
    }
}

/// 超时层的 env 覆盖（**验收夹具专用**）。非法值**当场抛**，不静默回退。
fn env_ms(name: &str, def: u64) -> Result<u64, TranslateError> {
    let Ok(raw) = std::env::var(name) else { return Ok(def) };
    let t = raw.trim();
    if t.is_empty() {
        return Ok(def);
    }
    match t.parse::<f64>() {
        Ok(n) if n.is_finite() && n > 0.0 => Ok(n as u64),
        _ => Err(TranslateError::new(
            "TRANSLATE_UPSTREAM_ERROR",
            format!("{name} 取值非法：{raw:?}（应为正数，毫秒）"),
            json!({}),
        )),
    }
}

/// 本次调用的四层超时（connect / ttfb / idle / total）。
fn timeouts_of(api: &str, total_ms: u64) -> Result<Timeouts, TranslateError> {
    let ttfb_default: u64 = if api == "llm" { 20_000 } else { 15_000 };
    let idle = if refute::get().idle_as_total {
        total_ms
    } else {
        env_ms("MIAO_TRANSLATE_IDLE_MS", 20_000)?
    };
    Ok(Timeouts {
        connect_ms: env_ms("MIAO_TRANSLATE_CONNECT_MS", 5_000)?,
        ttfb_ms: env_ms("MIAO_TRANSLATE_TTFB_MS", ttfb_default)?,
        idle_ms: idle,
        total_ms,
    })
}

// ------------------------------------------------------------------ 语言码
// 🔴 **按接口分表**（方案 §5.4）：llm 的语种表更短。不为「少写一个参数」合并两表。
const LLM_LANG: &[(&str, &str)] = &[("ja", "ja"), ("en", "en"), ("zh", "zh-CHS"), ("auto", "auto")];
/// text 表 = llm 表 + 一批小语种（值同键）
const TEXT_LANG: &[(&str, &str)] = &[
    ("ja", "ja"), ("en", "en"), ("zh", "zh-CHS"), ("auto", "auto"),
    ("ko", "ko"), ("ru", "ru"), ("fr", "fr"), ("de", "de"), ("es", "es"), ("it", "it"),
    ("pt", "pt"), ("vi", "vi"), ("id", "id"), ("th", "th"),
];

/// 平台支持的短码清单（两接口并集，给 `/translate/options` 展示用）。
pub fn langs() -> Vec<String> {
    TEXT_LANG.iter().map(|(k, _)| (*k).to_string()).collect()
}

/// 短码 → 有道语言码；**认不出返回 None，不猜**（猜错的代价是「把日文当英文送」）。
pub fn lang_code(short: &str, api: &str) -> Option<String> {
    let table = if api == "llm" { LLM_LANG } else { TEXT_LANG };
    table.iter().find(|(k, _)| *k == short).map(|(_, v)| (*v).to_string())
}

fn lang_pair_or_throw(req: &TranslateReq, api: &str) -> Result<(String, String), TranslateError> {
    let from = lang_code(&req.from, api);
    let to = lang_code(&req.to, api);
    match (from, to) {
        (Some(f), Some(t)) => Ok((f, t)),
        _ => Err(TranslateError::new(
            "TRANSLATE_INVALID_INPUT",
            format!("不支持的翻译方向：{:?} → {:?}", req.from, req.to),
            json!({ "platform": "youdao", "api": api, "from": req.from, "to": req.to }),
        )),
    }
}

// ------------------------------------------------------------------ 签名 v3

/// `input` 截断（方案 §5.1）：`len(q) <= 20` → q 原样；否则 q前10 + len(q) + q后10。
/// 🔴 **len 按 UTF-16 码元**（照抄官方 JS demo，与上游实现对齐优先于「更正确」）。
fn truncate_input(q: &str) -> String {
    // 反证开关：去掉截断 ⇒ 长文本签名算错，假上游回 202
    if refute::get().no_truncate {
        return q.to_string();
    }
    let units: Vec<u16> = q.encode_utf16().collect();
    if units.len() <= 20 {
        return q.to_string();
    }
    let head = String::from_utf16_lossy(&units[..10]);
    let tail = String::from_utf16_lossy(&units[units.len() - 10..]);
    format!("{head}{}{tail}", units.len())
}

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())
}

/// 签名五件套。🔴 **每次请求（含重试）都必须重新生成 salt + curtime + sign**（方案 §7.3）：
/// 有道用 `salt + curtime` 防重放，同一签名第二次发出去**必然** 207。
fn sign_fields(app_key: &str, app_secret: &str, q: &str) -> Vec<(String, String)> {
    let salt = if refute::get().reuse_salt {
        sha256_hex(&format!("reused-salt:{q}"))
    } else {
        uuid::Uuid::new_v4().to_string()
    };
    let curtime = format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    );
    let input = truncate_input(q);
    let sign = sha256_hex(&format!("{app_key}{input}{salt}{curtime}{app_secret}"));
    vec![
        ("appKey".to_string(), app_key.to_string()),
        ("salt".to_string(), salt),
        ("curtime".to_string(), curtime),
        ("signType".to_string(), "v3".to_string()),
        ("sign".to_string(), sign),
    ]
}

// ------------------------------------------------------------------ 契约类型

/// 一次翻译请求（门面 → 适配器）。
#[derive(Debug, Clone)]
pub struct TranslateReq {
    pub text: String,
    pub from: String,
    pub to: String,
    pub split_lines: bool,
    pub prompt: Option<String>,
    pub model: Option<String>,
    pub domain: Option<String>,
    pub vocab_id: Option<String>,
    pub timeout_ms: u64,
}

/// 一次翻译的结果。
#[derive(Debug, Clone, Default)]
pub struct TranslateResult {
    pub text: String,
    pub lang_type: Option<String>,
    pub lines: Option<Vec<String>>,
}

/// 平台密钥（门面每次调用现读）。
#[derive(Debug, Clone, Default)]
pub struct Credentials {
    pub app_key: String,
    pub app_secret: String,
}

fn assert_credentials(c: &Credentials) -> Result<(), TranslateError> {
    if c.app_key.is_empty() || c.app_secret.is_empty() {
        return Err(TranslateError::new(
            "TRANSLATE_NOT_CONFIGURED",
            "尚未配置有道翻译密钥（appKey / appSecret），请到「设置 → 翻译来源」填写",
            json!({ "platform": "youdao" }),
        ));
    }
    Ok(())
}

/// 复刻 JS `String(v)`（业务码比较用）。
fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(other) => other.to_string(),
    }
}

/// `handleOption`：pro → 0（子曰 14B）· lite → 3（1.5B）。缺省 pro，非法值当场抛。
fn handle_option_of(model: Option<&String>) -> Result<String, TranslateError> {
    match model.map(|s| s.as_str()) {
        None | Some("") => Ok("0".to_string()),
        Some("pro") => Ok("0".to_string()),
        Some("lite") => Ok("3".to_string()),
        Some(other) => Err(TranslateError::new(
            "TRANSLATE_INVALID_INPUT",
            format!("model 只支持 pro | lite，收到 {other:?}"),
            json!({ "model": other }),
        )),
    }
}

/// 从 text 接口的 `l`（如 `'EN2zh-CHS'`）解析目标语种：取**第一个** `2` 之后的部分。
fn parse_lang_type(l: Option<&Value>) -> Option<String> {
    let s = l.and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if s.is_empty() {
        return None;
    }
    match s.find('2') {
        Some(i) => Some(s[i + 1..].to_string()),
        None => Some(s),
    }
}

// ------------------------------------------------------------------ 能力边界

/// 普通文本翻译（**整体**返回）。POST `<base>/api`。
pub async fn translate_text(
    req: &TranslateReq,
    creds: &Credentials,
) -> Result<TranslateResult, TranslateError> {
    assert_credentials(creds)?;
    let (from, to) = lang_pair_or_throw(req, "text")?;

    let q = req.text.clone();
    let domain = req.domain.clone().unwrap_or_default();
    let vocab = req.vocab_id.clone().unwrap_or_default();
    let mut fields: Vec<(String, String)> = vec![
        ("q".into(), q.clone()),
        ("from".into(), from),
        ("to".into(), to),
        ("domain".into(), if domain.is_empty() { "general".to_string() } else { domain }),
        // strict：术语库未开通/未配置时不强制
        ("strict".into(), "false".into()),
    ];
    let vocab_trimmed = vocab.trim();
    if !vocab_trimmed.is_empty() {
        fields.push(("vocabId".into(), vocab_trimmed.to_string()));
    }
    fields.extend(sign_fields(&creds.app_key, &creds.app_secret, &q));

    let url = format!("{}{}", base_url(), TEXT_API_PATH);
    let t = timeouts_of("text", req.timeout_ms)?;
    let res = http::post_form(&url, &fields, &t)
        .await
        .map_err(|f| map_http_fault("youdao", "text", &f))?;

    let json: Value = match serde_json::from_slice(&res.body) {
        Ok(v) => v,
        Err(_) => {
            return Err(TranslateError::new(
                "TRANSLATE_UPSTREAM_ERROR",
                format!("有道文本翻译响应不是合法 JSON（HTTP {}）", res.status),
                json!({ "httpStatus": res.status }),
            ))
        }
    };

    // 反证开关：两接口判成功互换 ⇒ text 改用 llm 的双判
    let swap = refute::get().swap_judge;
    let failed = if swap {
        js_string(json.get("code")) != "0" || json.get("successful") != Some(&Value::Bool(true))
    } else {
        js_string(json.get("errorCode")) != "0"
    };
    if failed {
        let code = if swap { js_string(json.get("code")) } else { js_string(json.get("errorCode")) };
        return Err(map_upstream_code("youdao", "text", &code));
    }

    let translation: Vec<String> = json
        .get("translation")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().map(|x| js_string(Some(x))).collect())
        .unwrap_or_default();

    let mut result = TranslateResult { text: translation.join("\n"), ..Default::default() };
    if let Some(lt) = parse_lang_type(json.get("l")) {
        result.lang_type = Some(lt);
    }
    // 行对齐（方案 §6.2）：**只在**上游逐行数与入参行数一致时给 lines
    if req.split_lines && translation.len() == q.split('\n').count() {
        result.lines = Some(translation);
    }
    Ok(result)
}

/// 大模型翻译（**流式**）。POST `<base>/proxy/http/llm-trans`。
/// 每次增量经 `tx` 交出（`send().await` 提供背压：下游慢 ⇒ 上游读得慢）；返回累计全文。
pub async fn translate_stream(
    req: &TranslateReq,
    creds: &Credentials,
    tx: &mpsc::Sender<String>,
) -> Result<TranslateResult, TranslateError> {
    assert_credentials(creds)?;
    let (from, to) = lang_pair_or_throw(req, "llm")?;

    let i = req.text.clone();
    let mut fields: Vec<(String, String)> = vec![
        ("i".into(), i.clone()),
        ("prompt".into(), req.prompt.clone().unwrap_or_default()),
        ("from".into(), from),
        ("to".into(), to),
        // increment：只回增量（全量模式带宽随长度二次增长）
        ("streamType".into(), "increment".into()),
        ("handleOption".into(), handle_option_of(req.model.as_ref())?),
    ];
    fields.extend(sign_fields(&creds.app_key, &creds.app_secret, &i));

    let url = format!("{}{}", base_url(), LLM_API_PATH);
    let t = timeouts_of("llm", req.timeout_ms)?;
    let res = http::post_stream(&url, &fields, &t)
        .await
        .map_err(|f| map_http_fault("youdao", "llm", &f))?;

    // 🔴 非 2xx 必须先判死：流式路径的「成功」只由逐帧 JSON 表达，一个 5xx 垃圾体
    //    会被解析器静默跳过 ⇒ 返回空译文 + done —— 用户看到「译了一整遍，结果是空的」。
    if res.status < 200 || res.status >= 300 {
        return Err(TranslateError::new(
            "TRANSLATE_UPSTREAM_ERROR",
            format!("有道大模型翻译上游返回 HTTP {}", res.status),
            json!({ "httpStatus": res.status }),
        ));
    }

    let mut stream = res.stream;
    let mut parser = LineParser::new();
    let mut full = String::new();
    let mut lang_type: Option<String> = None;
    let mut frames = 0usize;
    let deadline = Instant::now() + Duration::from_millis(t.total_ms.max(1));

    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(TranslateError::new(
                "TRANSLATE_TIMEOUT",
                format!("出网请求超时（total 层）：{}ms 内没有进展", t.total_ms),
                json!({ "platform": "youdao", "api": "llm", "native": null, "stage": "total" }),
            ));
        }
        let budget = left.min(Duration::from_millis(t.idle_ms.max(1)));
        let chunk = match tokio::time::timeout(budget, futures_util::StreamExt::next(&mut stream)).await {
            Err(_) => {
                let stage = if budget < left { "idle" } else { "total" };
                let ms = if stage == "idle" { t.idle_ms } else { t.total_ms };
                return Err(TranslateError::new(
                    "TRANSLATE_TIMEOUT",
                    format!("出网请求超时（{stage} 层）：{ms}ms 内没有进展"),
                    json!({ "platform": "youdao", "api": "llm", "native": null, "stage": stage }),
                ));
            }
            Ok(None) => break,
            Ok(Some(Err(fault))) => return Err(map_http_fault("youdao", "llm", &fault)),
            Ok(Some(Ok(bytes))) => bytes,
        };
        let payloads = parser.feed(&chunk);
        handle_payloads(
            payloads, &mut frames, &mut full, &mut lang_type, tx,
        )
        .await?;
    }
    let tail = parser.finish();
    handle_payloads(tail, &mut frames, &mut full, &mut lang_type, tx).await?;

    // 🔴 200 但**零帧**：协议错配或空响应 ⇒ 绝不返回「成功 + 空译文」（D-130）。
    if frames == 0 && !refute::get().no_frame_guard {
        return Err(TranslateError::new(
            "TRANSLATE_UPSTREAM_ERROR",
            "有道大模型翻译上游返回 200 但没有任何可解析的事件帧（协议不匹配或空响应），已阻止「成功但空译文」的假象",
            json!({ "platform": "youdao", "api": "llm", "httpStatus": res.status, "reason": "no_frames" }),
        ));
    }

    let mut result = TranslateResult { text: full, ..Default::default() };
    if lang_type.is_some() {
        result.lang_type = lang_type;
    }
    Ok(result)
}

/// 逐负载帧处理（判成功 / 抽增量 / 记语言码）—— 与 Node 的 `onObj` 一一对应。
async fn handle_payloads(
    payloads: Vec<String>,
    frames: &mut usize,
    full: &mut String,
    lang_type: &mut Option<String>,
    tx: &mpsc::Sender<String>,
) -> Result<(), TranslateError> {
    for payload in payloads {
        let Some(obj) = as_object(&payload) else { continue };
        *frames += 1;
        let swap = refute::get().swap_judge;
        let failed = if swap {
            js_string(obj.get("errorCode")) != "0"
        } else {
            js_string(obj.get("code")) != "0" || obj.get("successful") != Some(&Value::Bool(true))
        };
        if failed {
            // code:"0" 但 successful !== true：双判**第二关**没过 —— 显式给出真正的原因
            if !swap && js_string(obj.get("code")) == "0" {
                return Err(TranslateError::new(
                    "TRANSLATE_UPSTREAM_ERROR",
                    "有道大模型翻译回了成功码但未标记成功（successful≠true），通常意味着该应用未开通「大模型翻译」服务",
                    json!({
                        "platform": "youdao", "api": "llm", "upstreamCode": "0",
                        "successful": obj.get("successful") == Some(&Value::Bool(true))
                    }),
                ));
            }
            let code = if swap { js_string(obj.get("errorCode")) } else { js_string(obj.get("code")) };
            return Err(map_upstream_code("youdao", "llm", &code));
        }
        let data = obj.get("data");
        let incre = data
            .and_then(|d| d.get("transIncre"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !incre.is_empty() {
            full.push_str(incre);
            // 背压：下游慢 ⇒ 这里 await 住 ⇒ 上游读得慢（方案 §6.4）
            let _ = tx.send(incre.to_string()).await;
        }
        let lt = data.and_then(|d| d.get("langType")).and_then(|v| v.as_str()).unwrap_or("");
        if !lt.is_empty() {
            *lang_type = Some(lt.to_string());
        }
    }
    Ok(())
}
