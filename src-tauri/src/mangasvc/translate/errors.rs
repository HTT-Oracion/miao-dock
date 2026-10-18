// 翻译错误归一 —— 统一码表 + 上游错误码 → 统一码映射（**纯函数**，可反证）
// =============================================================================
// 依据：在线翻译服务设计方案 §7.2。移植自 `service/src/manga/translate/errors.mjs`。
//
// 🔴 为什么每条都要独立码、不肯合并：`429` 该让用户"等一会儿再点"，`503` 该让用户
//    "去填密钥"。合并成"翻译失败"，用户只能反复重试 —— 那是把一句假话讲给用户听。
// 本文件**不抛不接 HTTP**：只做「上游怎么说 → 我们怎么归类」的纯映射。
use serde_json::{json, Value};

/// 统一码表 → HTTP 状态（方案 §7.2）。
pub fn status_of(code: &str) -> u16 {
    match code {
        // 无 appKey / appSecret ⇒ 用户要做的是"去填密钥"
        "TRANSLATE_NOT_CONFIGURED" => 503,
        // 密钥或应用配置错（108/110/112/202/203/205/206/207）
        "TRANSLATE_AUTH_FAILED" => 502,
        // 本地校验失败（空文本 / 超长 / 未知方向 / 缺参 / 不支持的语言）
        "TRANSLATE_INVALID_INPUT" => 400,
        // 文本超过上游长度上限（103）
        "TRANSLATE_TEXT_TOO_LONG" => 400,
        // 频率受限（411/412）
        "TRANSLATE_RATE_LIMITED" => 429,
        // 欠费（401）
        "TRANSLATE_QUOTA_EXCEEDED" => 402,
        // 未开通领域（310）/ 能力协商失败
        "TRANSLATE_UNSUPPORTED_FEATURE" => 400,
        // 上游业务错误（1/301/302/303/304/902000）或 5xx
        "TRANSLATE_UPSTREAM_ERROR" => 502,
        // 根本到不了上游（ENOTFOUND/ECONNREFUSED/ECONNRESET/EAI_AGAIN）
        "TRANSLATE_UPSTREAM_UNREACHABLE" => 502,
        // 任一层超时（details.stage 标明是哪一层）
        "TRANSLATE_TIMEOUT" => 504,
        // 请求的能力平台不支持（mode:'llm' 而平台只有 'text'）
        "TRANSLATE_CAPABILITY_UNSUPPORTED" => 400,
        // 设置层（TranslateSettingsError → INVALID_SETTING，与 `/engine/settings` 同款）
        "INVALID_SETTING" => 400,
        _ => 502,
    }
}

/// 翻译错误。`status` 由码表给出（同根 `ApiError` 的姿态），路由层直接可用。
#[derive(Debug, Clone)]
pub struct TranslateError {
    pub code: String,
    pub message: String,
    pub details: Value,
    pub status: u16,
}

impl TranslateError {
    pub fn new(code: &str, message: impl Into<String>, details: Value) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            details,
            status: status_of(code),
        }
    }
    /// 设置层错误 —— 与 `TranslateSettingsError` 同码（`INVALID_SETTING`）。
    pub fn setting(message: impl Into<String>, details: Value) -> Self {
        Self::new("INVALID_SETTING", message, details)
    }
}

impl std::fmt::Display for TranslateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for TranslateError {}

// ------------------------------------------------------------------ 有道两接口错误码表
// 🔴 **按「平台 × 接口」分列**：有道 text 与 llm 两接口的码**不完全重合**。合并成一张表
//    的代价是把小语种/领域错误送到另一张表上查不到 → 全落兜底，归因全丢。

/// 有道文本翻译（`/api`）错误码 → (统一码, 文案)（方案 §5.3）
const YOUDAO_TEXT_CODES: &[(&str, &str, &str)] = &[
    ("101", "TRANSLATE_INVALID_INPUT", "上游报告缺少必填参数"),
    ("102", "TRANSLATE_INVALID_INPUT", "上游不支持该翻译方向"),
    ("103", "TRANSLATE_TEXT_TOO_LONG", "待翻译文本超过上游单次长度上限（5000 字符）"),
    ("108", "TRANSLATE_AUTH_FAILED", "应用 ID（appKey）无效"),
    ("110", "TRANSLATE_AUTH_FAILED", "应用不存在或未生效"),
    ("112", "TRANSLATE_AUTH_FAILED", "所请求的翻译服务不存在"),
    ("116", "TRANSLATE_INVALID_INPUT", "上游报告参数无效"),
    ("202", "TRANSLATE_AUTH_FAILED", "签名校验失败（appSecret 或签名算法有误）"),
    ("203", "TRANSLATE_AUTH_FAILED", "来源 IP 不在应用的白名单内"),
    ("205", "TRANSLATE_AUTH_FAILED", "应用平台类型与请求不一致"),
    ("206", "TRANSLATE_AUTH_FAILED", "时间戳无效（本地时钟偏差过大）"),
    // 重放：本仓的硬约束是「每次请求（含重试）重算 salt + curtime + sign」——
    // 撞 207 先怀疑我们自己复用了签名，而不是上游不稳（方案 §7.3）。
    ("207", "TRANSLATE_AUTH_FAILED", "重复请求被上游拒绝（salt/curtime 必须每次重新生成）"),
    ("301", "TRANSLATE_UPSTREAM_ERROR", "上游词典查询失败"),
    ("302", "TRANSLATE_UPSTREAM_ERROR", "上游翻译查询失败"),
    ("303", "TRANSLATE_UPSTREAM_ERROR", "上游服务端异常"),
    ("304", "TRANSLATE_UPSTREAM_ERROR", "上游翻译失败"),
    ("308", "TRANSLATE_INVALID_INPUT", "上游报告参数无效"),
    ("309", "TRANSLATE_INVALID_INPUT", "领域（domain）参数错误"),
    ("310", "TRANSLATE_UNSUPPORTED_FEATURE", "该翻译领域未开通"),
    ("401", "TRANSLATE_QUOTA_EXCEEDED", "账户欠费，请充值后重试"),
    ("411", "TRANSLATE_RATE_LIMITED", "请求频率超过上游限制，请稍后再试"),
    ("412", "TRANSLATE_RATE_LIMITED", "请求字符数超过上游限额，请稍后再试"),
];

/// 有道大模型翻译（`llm-trans`）错误码 → (统一码, 文案)（方案 §5.2；表比 text 短）
const YOUDAO_LLM_CODES: &[(&str, &str, &str)] = &[
    ("1", "TRANSLATE_UPSTREAM_ERROR", "上游未知错误"),
    ("101", "TRANSLATE_INVALID_INPUT", "上游报告缺少必填参数"),
    ("108", "TRANSLATE_AUTH_FAILED", "应用 ID（appKey）无效"),
    ("110", "TRANSLATE_AUTH_FAILED", "应用没有该接口的权限"),
    ("112", "TRANSLATE_AUTH_FAILED", "所请求的翻译服务不存在"),
    ("202", "TRANSLATE_AUTH_FAILED", "签名校验失败（appSecret 或签名算法有误）"),
    ("206", "TRANSLATE_AUTH_FAILED", "时间戳无效（本地时钟偏差过大）"),
    ("207", "TRANSLATE_AUTH_FAILED", "重复请求被上游拒绝（salt/curtime 必须每次重新生成）"),
    ("902000", "TRANSLATE_UPSTREAM_ERROR", "上游大模型翻译调用失败"),
];

/// 出网原语的错误族 —— Rust 侧由 `http::HttpError` 携带（见该类型）。
#[derive(Debug, Clone)]
pub enum HttpFault {
    /// 任一层超时（`stage` = connect / ttfb / idle / total）
    Timeout { stage: String, timeout_ms: u64 },
    /// 根本连不上（DNS / 拒绝 / 断链）
    Unreachable { native: Option<String> },
    /// 请求被取消
    Aborted,
    /// 其余（含上游中断响应体）
    Other { native: Option<String> },
}

/// 归一上游**业务码**（有道 `errorCode` / `code` 都是字符串）。
pub fn map_upstream_code(platform: &str, api: &str, code: &str) -> TranslateError {
    let table: Option<&[(&str, &str, &str)]> = if platform == "youdao" {
        Some(if api == "llm" { YOUDAO_LLM_CODES } else { YOUDAO_TEXT_CODES })
    } else {
        None
    };
    if let Some(t) = table {
        if let Some((_, unified, msg)) = t.iter().find(|(k, _, _)| *k == code) {
            return TranslateError::new(
                unified,
                *msg,
                json!({ "platform": platform, "api": api, "upstreamCode": code }),
            );
        }
        return TranslateError::new(
            "TRANSLATE_UPSTREAM_ERROR",
            format!("上游返回未登记的错误码 {code}（平台 {platform} 接口 {api}）"),
            json!({ "platform": platform, "api": api, "upstreamCode": code }),
        );
    }
    TranslateError::new(
        "TRANSLATE_UPSTREAM_ERROR",
        format!("平台 {platform} 尚未登记错误码表，收到 {code}"),
        json!({ "platform": platform, "api": api, "upstreamCode": code }),
    )
}

/// 归一**出网层**错误（Error 分支：先超时、再网络族、最后兜底 —— 顺序即优先级）。
pub fn map_http_fault(platform: &str, api: &str, fault: &HttpFault) -> TranslateError {
    let base = |native: &Option<String>| json!({ "platform": platform, "api": api, "native": native });
    match fault {
        HttpFault::Timeout { stage, timeout_ms } => TranslateError::new(
            "TRANSLATE_TIMEOUT",
            format!("出网请求超时（{stage} 层）：{timeout_ms}ms 内没有进展"),
            json!({ "platform": platform, "api": api, "native": null, "stage": stage }),
        ),
        HttpFault::Aborted => TranslateError::new(
            "TRANSLATE_UPSTREAM_ERROR",
            "出网请求被取消",
            base(&None),
        ),
        HttpFault::Unreachable { native } => TranslateError::new(
            "TRANSLATE_UPSTREAM_UNREACHABLE",
            format!("无法连接到翻译平台 {platform}（{}）", native.clone().unwrap_or_else(|| "链路错误".into())),
            base(native),
        ),
        HttpFault::Other { native } => TranslateError::new(
            "TRANSLATE_UPSTREAM_ERROR",
            format!("调用翻译平台 {platform} 失败：{}", native.clone().unwrap_or_else(|| "未知".into())),
            base(native),
        ),
    }
}

/// 可重试判定（方案 §7.3）：链路与超时可重试；`UPSTREAM_ERROR` **仅限** 5xx 与上游 `303`。
pub fn is_retryable(e: &TranslateError) -> bool {
    if e.code == "TRANSLATE_UPSTREAM_UNREACHABLE" || e.code == "TRANSLATE_TIMEOUT" {
        return true;
    }
    if e.code == "TRANSLATE_UPSTREAM_ERROR" {
        if let Some(s) = e.details.get("httpStatus").and_then(|v| v.as_u64()) {
            return s >= 500;
        }
        return e.details.get("upstreamCode").and_then(|v| v.as_str()) == Some("303");
    }
    false
}
