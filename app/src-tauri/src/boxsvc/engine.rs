// boxsvc/engine.rs —— 「服务 ↔ 引擎」耦合点的 Rust 实现（F 组主线 F4）
//
// 移植自 `service/src/engine-client.mjs`（894 行）。该文件是 box-service 与翻译引擎之间的
// **唯一耦合点**（《04》§3.3）——换引擎版本只允许改它 + `engine/VERSIONS.lock`；
// 越过它泄漏引擎细节 = 缺陷。故本模块与之**逐字节对齐**，由 `e2e/service/engine-parity-check.mjs`
// 强制同源（`boxsvc --engine-selftest` ⟷ Node `engine-client.mjs`）。
//
// ## F4 拆两步（同 F3 的纪律）
// 本轮只做 **F4-a：纯协议/配方层**（无网络、无子进程），可调、可对拍、可反证：
//   · `resolve_engine_launch` / `resolve_llm_launch` —— 启动配方（纯函数，S2 的 ServiceManager 消费）
//   · `engine_config_snapshot` —— §5.2 的 `config` 块（发给引擎 snake_case、报给 Box camelCase）
//   · `engine_local_no_proxy` / `engine_hf_offline_env` —— 两条「少一个键真机必挂」的启动 env
//   · `available_tiers` / `tier_model_path` / `TIER_LLM_MODELS` / `LLAMA_VERSION_DIR` / `LLM_OWNER`
//   · `engine_version`（安装事实）/ `translation_snapshot_dir` / `translation_weights_present`
//   · `parse_result_stream`（5 字节帧）+ `record_frame` —— 引擎结果流的解析与阶段日志
// **F4-b（网络 I/O：`translate_image` 的 real/mock 实现 + `probe_engine` 三重判定）留待下轮** ——
// 它依赖本进程真正持有引擎子进程句柄与 reqwest 流式读，属「执行态」；不可调用的代码无法验证。
//
// ## 进程组信号为什么不在本文件
// F4 原述「进程组信号（`kill(-pgid)` / `taskkill /T`）复用 `service.rs` 现有实现，不新写」——
// 见 `app/src-tauri/src/service.rs::signal_tree` / `no_tree_kill`（含反证开关）。本文件只产出**配方**，
// 真正拉起/回收引擎的 supervisor 在 F4-b 接线时复用它。
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use crate::paths;

pub mod selftest;
pub mod client;

// ================================================================ 常量（与 engine-client.mjs 同名同值）

/// 引擎侧 `detection_size` 的默认值（`manga_translator/config.py:276`）。我们**不指定**它 ⇒ 它生效。
pub const ENGINE_DEFAULT_DETECTION_SIZE: i64 = 2048;
/// llama.cpp 解包后的版本目录名 —— 与 `fetch-models.mjs --extract` 落点、manifest 里的版本号三处必须一致。
pub const LLAMA_VERSION_DIR: &str = "llama-b11417";
/// 引擎③ 的归属方（《04》§9.1：Tier1 空闲卸载实现方 = box-service）。跨进程约定，三处必须认同一个值。
pub const LLM_OWNER: &str = "service";
/// 阶段日志环形缓冲上限（≈ 4–5 张图的量）。
pub const STAGE_LOG_MAX: usize = 50;
/// 单条阶段文本上限（引擎原话会被截断至此）。
pub const STAGE_TEXT_MAX: usize = 120;
/// 结果流单帧文本上限（随错误详情进响应体，不设限时话多的引擎能把回包撑到几百 KB）。
pub const FRAME_TEXT_MAX: usize = 200;

/// 档位 → Sakura 权重文件名。**只有 Tiny 被固化进 manifest**；small/medium 显式 `None`，
/// 调用方必须报错，**绝不回落成 tiny**（回落会让用户以为在跑 7B、实际 1.5B，且追溯不到根因）。
pub const TIER_LLM_MODELS: &[(&str, Option<&str>)] = &[
    ("tiny", Some("sakura-1.5b-qwen2.5-v1.0-fp16.gguf")),
    ("small", None),
    ("medium", None),
];

/// 引擎子进程**必须**直连、绝不能过代理的本机三写法（`::1` 是 Node/uvicorn 在本机可能绑到的 IPv6 回环）。
const LOCAL_NO_PROXY_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "::1"];

// ================================================================ 环境读取（复刻 config.mjs 的 envInt/envBool 语义）

/// 非空环境变量（空串按「未设」处理 —— 同 `config.mjs` 的 `raw === '' → def`）。
fn env_str(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|s| !s.is_empty())
}

/// 复刻 JS `Number.parseInt(raw, 10)`：取**前导符号 + 数字**，其余忽略；不可解析返回 `None`。
fn parse_js_int(s: &str) -> Option<i64> {
    let s = s.trim_start();
    let b = s.as_bytes();
    let mut end = 0usize;
    if matches!(b.first(), Some(b'-') | Some(b'+')) {
        end = 1;
    }
    let digits_start = end;
    while end < b.len() && b[end].is_ascii_digit() {
        end += 1;
    }
    if end == digits_start {
        return None;
    }
    s[..end].parse::<i64>().ok()
}

/// `envInt(name, def)`：非空才解析；解析失败或负数 → `def`（同 `config.mjs`）。
fn env_int(name: &str, def: i64) -> i64 {
    match env_str(name) {
        Some(s) => parse_js_int(&s).filter(|n| *n >= 0).unwrap_or(def),
        None => def,
    }
}

/// `envBool(name, def)`：非空才判定，`0/false/no/off`（小写）为假。
fn env_bool(name: &str, def: bool) -> bool {
    match env_str(name) {
        Some(s) => !matches!(s.to_lowercase().as_str(), "0" | "false" | "no" | "off"),
        None => def,
    }
}

/// 引擎协议（`MIAO_ENGINE_PROTOCOL`，默认 `real`）。取值非法时回落 `real` —— **不静默走替身**。
pub fn engine_protocol() -> String {
    match env_str("MIAO_ENGINE_PROTOCOL").as_deref() {
        Some("mock") => "mock".to_string(),
        _ => "real".to_string(),
    }
}

pub fn is_mock_protocol() -> bool {
    engine_protocol() == "mock"
}

// ================================================================ 错误（复刻 EngineError 的 code 语义）

#[derive(Debug, Clone)]
pub struct EngineError {
    pub code: String,
    pub message: String,
    pub detail: Option<Value>,
}

impl EngineError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        EngineError { code: code.to_string(), message: message.into(), detail: None }
    }
    pub fn with_detail(code: &str, message: impl Into<String>, detail: Value) -> Self {
        EngineError { code: code.to_string(), message: message.into(), detail: Some(detail) }
    }
}

// ================================================================ 纯函数：mime / 方向

/// data URI 里的 mime：`jpg` 的规范写法是 `jpeg`（引擎侧正则只要求 `image/` 前缀，但按规范写）。
pub fn mime_of_ext(ext: &str) -> String {
    if ext == "jpg" {
        "image/jpeg".to_string()
    } else {
        format!("image/{ext}")
    }
}

// ================================================================ 结果流解析（5 字节帧）+ 阶段日志

/// 结果流的一帧。`text` 仅 code 1/2/3 有；`truncated` 仅「声明长度超出剩余字节」时有。
/// 🔴 序列化时**省略 `None` 的键** —— Node 的帧对象对 code 0/4 没有 `text` 键（不是 null）。
#[derive(Debug, Clone, Serialize)]
pub struct Frame {
    pub code: u8,
    pub size: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct ParsedStream {
    pub result: Option<Vec<u8>>,
    pub error: Option<String>,
    pub frames: Vec<Frame>,
}

/// 取字符串的前 `n` 个 **Unicode 标量**（≈ JS `slice(0, n)` 的 UTF-16 单位）。
/// ⚠️ 已知偏离：JS 按 UTF-16 码元切、这里按码点切 —— 仅对**星光面**（emoji 等代理对）不同；
///    引擎阶段名/错误文案是 ASCII 或 CJK（BMP），两者一致。与 D-139 的 `localeCompare` 同类。
fn take_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// 解析引擎的**结果流**（`1 字节 code + 4 字节大端长度 + 数据`）。
/// 流在 code 0（结果）/ 2（错误）处逻辑结束，但按字节一律读到尾（与 Node 同）。
pub fn parse_result_stream(body: &[u8]) -> ParsedStream {
    let mut frames: Vec<Frame> = Vec::new();
    let mut result: Option<Vec<u8>> = None;
    let mut error: Option<String> = None;
    let mut off = 0usize;
    while off + 5 <= body.len() {
        let code = body[off];
        let size = u32::from_be_bytes([body[off + 1], body[off + 2], body[off + 3], body[off + 4]]);
        let end = off + 5 + size as usize;
        if end > body.len() {
            frames.push(Frame { code, size, text: None, truncated: Some(true) });
            break;
        }
        let data = &body[off + 5..end];
        let mut frame = Frame { code, size, text: None, truncated: None };
        if code == 0 {
            result = Some(data.to_vec());
        } else if code == 1 || code == 2 || code == 3 {
            let text = take_chars(&String::from_utf8_lossy(data), FRAME_TEXT_MAX);
            if code == 2 {
                error = Some(text.clone());
            }
            frame.text = Some(text);
        }
        frames.push(frame);
        off = end;
    }
    ParsedStream { result, error, frames }
}

/// 把一帧映射成一条阶段日志行（`seq` 是**服务端**的图片序号，不是引擎的）。
///
/// 🔴 code 3/4（**队列位次** / **等待翻译实例**）过去被丢掉 —— 而它们恰恰是「引擎活着、
/// 但拿不到执行器」的**唯一直接证据**；没有它们，诊断视图只剩「卡在某个阶段」，指不到「排队」这一层。
/// 返回 `None` 表示这一帧不产生日志（无文本 / 未知 code）。
pub fn record_frame(seq: i64, frame: &Frame) -> Option<String> {
    if frame.code == 4 {
        return Some(stage_line(seq, "等待翻译实例"));
    }
    let text = frame.text.as_deref()?;
    let line = match frame.code {
        1 => text.to_string(),
        3 => format!("排队位次 {text}"),
        2 => format!("引擎报错：{text}"),
        _ => return None,
    };
    Some(stage_line(seq, &line))
}

/// 单条日志的格式化：`seq N: <text>`，文本截断至 `STAGE_TEXT_MAX`；空文本不产生行。
fn stage_line(seq: i64, text: &str) -> String {
    format!("seq {}: {}", seq, take_chars(text.trim(), STAGE_TEXT_MAX))
}

/// `sidecar` 里恒为 null 的 5 个**服务级**字段（档位 / 硬件 / ③ 的进程只存在于 server.mjs）。
pub fn placeholder_fields() -> Value {
    json!({ "tier": null, "accel": null, "warmed": null, "llm": null, "model": null })
}

// ================================================================ 生效参数快照（§5.2 的 config 块）

/// 按 env 合成 `config.engineConfig`（《04》§4.2 参数基线，发给引擎用 snake_case）。
pub fn engine_config() -> Value {
    let mut translator = serde_json::Map::new();
    translator.insert(
        "translator".into(),
        json!(env_str("MIAO_ENGINE_TRANSLATOR").unwrap_or_else(|| "sakura".into())),
    );
    translator.insert(
        "target_lang".into(),
        json!(env_str("MIAO_ENGINE_TARGET_LANG").unwrap_or_else(|| "CHS".into())),
    );

    let mut detector = serde_json::Map::new();
    detector.insert(
        "detector".into(),
        json!(env_str("MIAO_ENGINE_DETECTOR").unwrap_or_else(|| "default".into())),
    );
    // 🔴「不下发」与「下发 2048」不是一回事：前者用引擎默认值、后者钉死当前默认值。
    if let Some(raw) = env_str("MIAO_ENGINE_DETECTION_SIZE") {
        if let Some(n) = parse_js_int(&raw) {
            detector.insert("detection_size".into(), json!(n));
        }
    }

    let mut inpainter = serde_json::Map::new();
    inpainter.insert(
        "inpainter".into(),
        json!(env_str("MIAO_ENGINE_INPAINTER").unwrap_or_else(|| "lama_large".into())),
    );

    let mut ocr = serde_json::Map::new();
    ocr.insert("ocr".into(), json!(env_str("MIAO_ENGINE_OCR").unwrap_or_else(|| "48px".into())));

    json!({
        "translator": translator,
        "detector": detector,
        "inpainter": inpainter,
        "ocr": ocr,
    })
}

/// **生效参数快照**（《03》§5.2 的 `config` 块）—— 供 Box 做「界面与文档对账」。
///
/// 🔴 跨层字段名漂移的挡板：**发给引擎的是 snake_case**、**报给 Box 的是 camelCase**，
///    两边必须从**同一处**（`engine_config`）派生。重抄一遍字面量 ⇒ 改参数只改了发出去的那边，
///    诊断视图继续展示旧值（界面与事实不一致、且谁也不报错）。
pub fn engine_config_snapshot() -> Value {
    let c = engine_config();
    let get = |part: &str, key: &str| -> Value {
        c.get(part).and_then(|p| p.get(key)).cloned().unwrap_or(Value::Null)
    };
    json!({
        "translator": get("translator", "translator"),
        // 🔴 `fromLang` 报的是**基线**（默认 null = 基线不固定源语言，逐任务下发）。
        "fromLang": get("translator", "from_lang"),
        "targetLang": get("translator", "target_lang"),
        "detector": get("detector", "detector"),
        "detectionSize": get("detector", "detection_size")
            .as_i64()
            .map(|n| json!(n))
            .unwrap_or_else(|| json!(ENGINE_DEFAULT_DETECTION_SIZE)),
        "ocr": get("ocr", "ocr"),
        "inpainter": get("inpainter", "inpainter"),
    })
}

// ================================================================ 方向 → 引擎配置（`buildEngineConfig`）

/// 短码 → 引擎内部语言码（键与引擎 `translators/common.py::VALID_LANGUAGES` 对齐，只取本版用到的）。
pub const LANG_SHORT_TO_ENGINE: &[(&str, &str)] = &[
    ("ja", "JPN"),
    ("jpn", "JPN"),
    ("en", "ENG"),
    ("eng", "ENG"),
    ("zh", "CHS"),
    ("chs", "CHS"),
    ("zh-cn", "CHS"),
];

/// **方向 → 引擎翻译器**：只在基线翻译器**结构上做不到该方向**时才改写（今天只有 `ENG>CHS` ⇒ `nllb`）。
/// 依据：`sakura` 的 system prompt 把源语言硬编码成日文（A 组实测英文 8/8 行原文照抄）。
pub const DIRECTION_TRANSLATOR: &[(&str, &str)] = &[("ENG>CHS", "nllb")];

/// 语言标识 → 引擎内部语言码；**认不出来返回 `None`（不猜）**。
/// 短码（`en`）、引擎码（`ENG`）都收，大小写不敏感；`auto` 原样保留（显式要引擎自动检测）。
pub fn engine_lang_code(value: Option<&str>) -> Option<String> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    let lower = raw.to_lowercase();
    if lower == "auto" {
        return Some("auto".to_string());
    }
    if let Some((_, code)) = LANG_SHORT_TO_ENGINE.iter().find(|(k, _)| *k == lower) {
        return Some((*code).to_string());
    }
    let upper = raw.to_uppercase();
    if LANG_SHORT_TO_ENGINE.iter().any(|(_, c)| *c == upper) {
        return Some(upper);
    }
    None
}

/// 按任务方向合成**这一次请求**的引擎配置（在不可变基线 `engine_config()` 之上叠一层方向）。
///
/// 🔴 `from_lang` 是**逐任务**的 —— 同一台机器上既有日译中又有英译中；把基线改成可变的，
///    就退化成「哪个任务先跑、谁的设置说了算」。映射不出引擎码时**不下发** `from_lang`
///    （保持上游 `None` = auto），而不是发个空串。
pub fn build_engine_config(from: Option<&str>, to: Option<&str>) -> Value {
    let base = engine_config();
    let from_code = engine_lang_code(from);
    let to_code = engine_lang_code(to).unwrap_or_else(|| {
        base.get("translator")
            .and_then(|t| t.get("target_lang"))
            .and_then(|v| v.as_str())
            .unwrap_or("CHS")
            .to_string()
    });
    // 键与 Node 一致：`from` 为 null 时字面串 "null"（`${null}>CHS`）。
    let key = format!("{}>{}", from_code.clone().unwrap_or_else(|| "null".into()), to_code);
    let baseline = base
        .get("translator")
        .and_then(|t| t.get("translator"))
        .and_then(|v| v.as_str())
        .unwrap_or("sakura")
        .to_string();
    let translator_name = DIRECTION_TRANSLATOR
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| (*v).to_string())
        .unwrap_or(baseline);

    // 先铺基线 translator 的键，再覆盖 translator / target_lang / [from_lang]
    // —— 等价于 Node 的 `{...base.translator, translator, target_lang, ...(from?{from_lang}:{})}`。
    let mut tr = serde_json::Map::new();
    if let Some(obj) = base.get("translator").and_then(|t| t.as_object()) {
        for (k, v) in obj {
            tr.insert(k.clone(), v.clone());
        }
    }
    tr.insert("translator".into(), json!(translator_name));
    tr.insert("target_lang".into(), json!(to_code));
    if let Some(f) = from_code {
        tr.insert("from_lang".into(), json!(f));
    }

    let mut out = serde_json::Map::new();
    if let Some(obj) = base.as_object() {
        for (k, v) in obj {
            if k == "translator" {
                out.insert(k.clone(), Value::Object(tr.clone()));
            } else {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Value::Object(out)
}

// ================================================================ 本机代理旁路（D-86）

/// 本地引擎子进程的**代理旁路**环境（`NO_PROXY`）。语义边界：**只加旁路，不删代理** ——
/// 引擎若改用云端翻译器仍需代理，删掉会把那种配置静默打死。
///
/// 两个大小写都产出：httpx/requests/curl 读法不一致，漏一份的成本是一次「偶发」。
pub fn engine_local_no_proxy(no_proxy: Option<&str>, no_proxy_lower: Option<&str>) -> (String, String) {
    // Node: `env.NO_PROXY ?? env.no_proxy ?? ''` —— 取先定义的那个。
    let raw = no_proxy.or(no_proxy_lower).unwrap_or("");
    let mut out: Vec<String> = Vec::new();
    for part in raw.split(',') {
        let t = part.trim();
        if t.is_empty() {
            continue;
        }
        if !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    }
    for h in LOCAL_NO_PROXY_HOSTS {
        if !out.iter().any(|x| x == h) {
            out.push(h.to_string());
        }
    }
    let merged = out.join(",");
    (merged.clone(), merged)
}

/// 用 `process.env` 调 [`engine_local_no_proxy`]（同 Node 的默认入参）。
pub fn engine_local_no_proxy_from_env() -> (String, String) {
    let upper = std::env::var("NO_PROXY").ok();
    let lower = std::env::var("no_proxy").ok();
    engine_local_no_proxy(upper.as_deref(), lower.as_deref())
}

// ================================================================ HF 离线 env（B3 / D-100）

/// 引擎子进程的 **HF 离线** 环境。**只在权重确实已在盘上时才设** —— 否则会把「首次下载」一并堵死。
/// 🔴 与 D-86 的 `NO_PROXY` 是**两套东西、都保留**（一个管本机 8080 不被代理劫、一个管 HF 不去联网）。
pub fn hf_offline_env(present: bool, disabled: bool) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    if disabled || !present {
        return m;
    }
    m.insert("HF_HUB_OFFLINE".to_string(), "1".to_string());
    m.insert("TRANSFORMERS_OFFLINE".to_string(), "1".to_string());
    m
}

/// 用盘上状态 + `MIAO_NO_HF_OFFLINE` 自动判定（同 Node 的 `engineHfOfflineEnv()` 默认入参）。
pub fn engine_hf_offline_env() -> BTreeMap<String, String> {
    let present = translation_weights_present(&paths::engine_dir());
    let disabled = env_bool("MIAO_NO_HF_OFFLINE", false);
    hf_offline_env(present, disabled)
}

// ================================================================ 引擎身份 / 权重（manifest 派生）

fn read_manifest() -> Option<Value> {
    let p = paths::model_manifest();
    let txt = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&txt).ok()
}

fn is_hex_commit(c: &str) -> bool {
    let n = c.len();
    (7..=40).contains(&n) && c.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 引擎② 的版本标识：真档 = `models.manifest.json:engineCommit` 的**短 sha**（前 7 位），
/// 读不到 / 形状不对 → `None`（= 未知，**不编假版本号**）。上游没有可用版本号（见 engine-client.mjs 注释）。
pub fn read_engine_commit() -> Option<String> {
    let m = read_manifest()?;
    let c = m.get("engineCommit")?.as_str()?.trim().to_string();
    if is_hex_commit(&c) {
        Some(c.chars().take(7).collect())
    } else {
        None
    }
}

/// `ENGINE_VERSION`：mock 档恒 `"mock"`（起的是替身就老实说），真档 = commit 短 sha（可能为 `None`）。
pub fn engine_version() -> Option<String> {
    if is_mock_protocol() {
        Some("mock".to_string())
    } else {
        read_engine_commit()
    }
}

/// 英译中权重（nllb）在引擎树里的 **HF snapshot 目录**。从 manifest **推**出来，不写死路径。
pub fn translation_snapshot_dir(engine_dir: &Path) -> Option<PathBuf> {
    let m = read_manifest()?;
    let files = m.get("files")?.as_array()?;
    let f = files.iter().find(|x| {
        x.get("hf").map(|h| !h.is_null()).unwrap_or(false)
            && x.get("set").and_then(|s| s.as_str()) == Some("translation")
    })?;
    let link_to = f.get("linkTo")?.as_str()?;
    let rev = f.get("hf")?.get("revision")?.as_str()?;
    let segs: Vec<&str> = link_to.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() < 2 {
        return None;
    }
    let mut p = engine_dir.to_path_buf();
    for s in &segs[..segs.len() - 2] {
        p.push(s);
    }
    p.push("snapshots");
    p.push(rev);
    Some(p)
}

/// 权重是否已预置在引擎树里。**只判存在**，不算哈希。
pub fn translation_weights_present(engine_dir: &Path) -> bool {
    translation_snapshot_dir(engine_dir).map(|d| d.exists()).unwrap_or(false)
}

// ================================================================ 档位与 LLM 配方的路径

/// `runtimes/manga-translator/`（`engineDir` 是它下面的 `src/`）。
fn engine_rt() -> PathBuf {
    paths::resolve(paths::engine_dir().join(".."))
}

/// `llama-server` 可执行文件的默认路径（按平台分叉文件名后缀）。
fn default_llm_server_bin() -> PathBuf {
    let name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    engine_rt().join("bin").join("llama").join(LLAMA_VERSION_DIR).join(name)
}

/// **本进程能真跑的档位**（低 → 高）。⚠️ 两协议含义不同：`real` 由「权重在不在」决定；
/// `mock` 替身只认 `--model <tier>` 名字 ⇒ 三档都能「模拟」（否则 S4 的关键回路在 mock 档永远无法触发）。
pub fn available_tiers() -> Vec<String> {
    if is_mock_protocol() {
        return vec!["tiny".into(), "small".into(), "medium".into()];
    }
    TIER_LLM_MODELS
        .iter()
        .filter(|(_, v)| v.is_some())
        .map(|(k, _)| k.to_string())
        .collect()
}

/// 档位对应的权重绝对路径；该档未声明权重时返回 `None`（**不是**回落成 tiny）。
pub fn tier_model_path(tier: &str) -> Option<PathBuf> {
    let name = TIER_LLM_MODELS.iter().find(|(k, _)| *k == tier).and_then(|(_, v)| *v)?;
    Some(engine_rt().join("models").join("sakura").join(name))
}

// ================================================================ 启动配方（纯函数）

/// `resolveEngineLaunch` 的输出形状。`executor_port` 仅引擎配方有（LLM 配方无此键）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchSpec {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub cmd: Vec<String>,
    /// ⚠️ 不 `skip`：Node 的 LLM 配方里 `cwd: null` 是**存在且为 null**的键，不是省略。
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor_port: Option<u16>,
    pub probes: Vec<Value>,
}

/// `resolveEngineLaunch` 的可注入覆盖（缺省时从 env / `paths` 推导）。字段名对齐 Node 的 overrides。
#[derive(Debug, Clone, Default)]
pub struct EngineLaunchOverrides {
    pub python_bin: Option<PathBuf>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub use_gpu: Option<bool>,
    pub models_ttl: Option<i64>,
    pub nonce: Option<String>,
    pub sakura_base: Option<String>,
    /// `None` = 自动判定（`engine_hf_offline_env()`）；`Some(map)` = 注入这一项。
    pub hf_offline: Option<BTreeMap<String, String>>,
}

fn default_engine_port() -> u16 {
    let def = if is_mock_protocol() { 5003 } else { 8000 };
    env_int("MIAO_ENGINE_PORT", def) as u16
}

/// Tier2 空闲卸载阈值（秒）。Node 由设置文件派生；此处从 env 近似（设置面迁移后对齐，见模块头 F4-b 注）。
fn default_models_ttl() -> i64 {
    let unload_never = env_int("MIAO_IDLE_LLM_MS", -1) == 0 || env_bool("MIAO_UNLOAD_NEVER", false);
    if unload_never {
        return 0;
    }
    env_int("MIAO_ENGINE_MODELS_TTL", 1800)
}

/// 拼装引擎启动命令行（纯函数）。
///
/// ⚠️ 两条都与**直觉相反**（实测 D-62）：① 命令是 `python main.py`、cwd = `src/server`，**不是** `-m server.main`
///    （`from args import` 是平级相对导入，`-m` 必 `ModuleNotFoundError`）；② 参数表按 `server/args.py` 实测，
///    **没有** `--config-file` / `--model-dir`（策略改为按请求注入）。
pub fn resolve_engine_launch(o: &EngineLaunchOverrides) -> LaunchSpec {
    let python_bin = o.python_bin.clone().unwrap_or_else(paths::engine_python);
    let host = o.host.clone().unwrap_or_else(|| "127.0.0.1".to_string());
    let port = o.port.unwrap_or_else(default_engine_port);
    let use_gpu = o.use_gpu.unwrap_or_else(|| env_bool("MIAO_ENGINE_USE_GPU", true));
    let models_ttl = o.models_ttl.unwrap_or_else(default_models_ttl);
    // 🔴 默认必须是**字面串 `"None"`**（= 禁用鉴权），不是"没设"：传空串会生成随机 nonce ⇒ 主进程调执行器必 401。
    let nonce = o
        .nonce
        .clone()
        .unwrap_or_else(|| env_str("MIAO_ENGINE_NONCE").unwrap_or_else(|| "None".to_string()));
    let sakura_base = o.sakura_base.clone().unwrap_or_else(|| {
        env_str("SAKURA_API_BASE").unwrap_or_else(|| "http://127.0.0.1:8080/v1".to_string())
    });

    let mut cmd = vec![
        python_bin.to_string_lossy().into_owned(),
        "main.py".to_string(),
        "--host".to_string(),
        host,
        "--port".to_string(),
        port.to_string(),
    ];
    if use_gpu {
        cmd.push("--use-gpu".to_string());
    }
    if models_ttl > 0 {
        cmd.push("--models-ttl".to_string());
        cmd.push(models_ttl.to_string());
    }
    if !nonce.is_empty() {
        cmd.push("--nonce".to_string());
        cmd.push(nonce.clone());
    }

    // env = {...process.env, ...注入项}。注入项顺序与 Node 一致（后写的覆盖先写的）。
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    let (np, npl) = engine_local_no_proxy_from_env();
    env.insert("NO_PROXY".to_string(), np);
    env.insert("no_proxy".to_string(), npl);
    let hf = o.hf_offline.clone().unwrap_or_else(engine_hf_offline_env);
    for (k, v) in hf {
        env.insert(k, v);
    }
    // 🔴 stdio 必须 UTF-8（D-88）：否则中文 Windows 下 GBK 日文日志会让上层读日志的一端停读、关管道。
    env.insert("PYTHONIOENCODING".to_string(), "utf-8".to_string());
    env.insert("SAKURA_API_BASE".to_string(), sakura_base);
    if !nonce.is_empty() {
        env.insert("MT_WEB_NONCE".to_string(), nonce);
    }

    LaunchSpec {
        label: "engine".to_string(),
        tier: None,
        model: None,
        cmd,
        cwd: Some(paths::engine_server_dir().to_string_lossy().into_owned()),
        env,
        executor_port: Some(port + 1),
        // 与 `realProbe()` 的三重判定**同源**：① uvicorn 在听 ② 存活探针应答（**POST** /queue-size）③ 执行器端口在听。
        probes: vec![
            json!({ "kind": "tcp", "port": port }),
            json!({ "kind": "http", "port": port, "method": "POST", "path": "/queue-size", "expect": 200 }),
            json!({ "kind": "tcp", "port": port + 1 }),
        ],
    }
}

/// `resolveLlmLaunch` 的可注入覆盖。
#[derive(Debug, Clone, Default)]
pub struct LlmLaunchOverrides {
    pub tier: Option<String>,
    pub bin: Option<PathBuf>,
    pub model: Option<PathBuf>,
    pub port: Option<u16>,
    pub ctx: Option<i64>,
    pub ngl: Option<i64>,
    /// mock 档用：替身的解释器（Node 侧是 `process.execPath`；Rust 侧取 `MIAO_NODE_EXEC`）。
    pub node_exec: Option<PathBuf>,
}

/// 引擎③（LLM / llama-server）的启动配方 —— 按协议分两支。**调用方都不自己拼命令。**
pub fn resolve_llm_launch(o: &LlmLaunchOverrides) -> Result<LaunchSpec, EngineError> {
    if is_mock_protocol() {
        Ok(resolve_mock_llm_launch(o))
    } else {
        resolve_real_llm_launch(o)
    }
}

/// 真档：`llama-server`（外部二进制）。
fn resolve_real_llm_launch(o: &LlmLaunchOverrides) -> Result<LaunchSpec, EngineError> {
    let tier = o.tier.clone().unwrap_or_else(|| "tiny".to_string());
    let bin = o
        .bin
        .clone()
        .or_else(|| env_str("MIAO_LLM_BIN").map(PathBuf::from))
        .unwrap_or_else(default_llm_server_bin);
    let port = o.port.unwrap_or_else(|| env_int("MIAO_LLM_PORT", 8080) as u16);
    let ctx = o.ctx.unwrap_or_else(|| env_int("MIAO_LLM_CTX", 4096));
    let ngl = o.ngl.unwrap_or_else(|| env_int("MIAO_LLM_NGL", 99));

    // 档位决定权重。**未声明权重的档位直接报错**，不静默沿用 tiny 的文件（见 TIER_LLM_MODELS）。
    let model = o
        .model
        .clone()
        .or_else(|| env_str("MIAO_LLM_MODEL").map(PathBuf::from))
        .or_else(|| tier_model_path(&tier));
    let Some(model) = model else {
        return Err(EngineError::with_detail(
            "TIER_MODEL_UNDECLARED",
            format!(
                "档位 {tier} 的权重尚未纳入 models.manifest.json（当前仅 {} 可用）",
                available_tiers().join("/")
            ),
            json!({ "tier": tier, "available": available_tiers() }),
        ));
    };
    let model = model.to_string_lossy().into_owned();

    Ok(LaunchSpec {
        label: "llm".to_string(),
        tier: Some(tier),
        model: Some(model.clone()),
        cmd: vec![
            bin.to_string_lossy().into_owned(),
            "-m".to_string(),
            model,
            "--port".to_string(),
            port.to_string(),
            "-c".to_string(),
            ctx.to_string(),
            "-ngl".to_string(),
            ngl.to_string(),
        ],
        cwd: None,
        env: BTreeMap::new(),
        executor_port: None,
        // `llama-server` 的 HTTP 面就是 OpenAI 兼容的 `/v1/models`。
        probes: vec![
            json!({ "kind": "tcp", "port": port }),
            json!({ "kind": "http", "port": port, "method": "GET", "path": "/v1/models", "expect": 200 }),
        ],
    })
}

/// mock 档：仓内替身 `engine/src/mock-llm.mjs`（三进程的**结构性**东西在 mock 档也能验）。
/// ⚠️ 与真档不同：这里**不标** `watch`（替身自带父死看管，再包一层只是多一层进程）。
fn resolve_mock_llm_launch(o: &LlmLaunchOverrides) -> LaunchSpec {
    let port = o.port.unwrap_or_else(|| env_int("MIAO_LLM_PORT", 8080) as u16);
    let tier = o.tier.clone().unwrap_or_else(|| "tiny".to_string());
    let node_exec = o
        .node_exec
        .clone()
        .or_else(|| env_str("MIAO_NODE_EXEC").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("node"));
    let script = paths::repo_root().join("engine").join("src").join("mock-llm.mjs");
    LaunchSpec {
        label: "llm".to_string(),
        tier: Some(tier.clone()),
        model: Some(format!("sakura-mock:{tier}")),
        cmd: vec![
            node_exec.to_string_lossy().into_owned(),
            script.to_string_lossy().into_owned(),
            "--port".to_string(),
            port.to_string(),
            "--model".to_string(),
            tier,
        ],
        cwd: None,
        env: BTreeMap::new(),
        executor_port: None,
        probes: vec![
            json!({ "kind": "tcp", "port": port }),
            json!({ "kind": "http", "port": port, "method": "GET", "path": "/v1/models", "expect": 200 }),
        ],
    }
}

// ================================================================ 单测

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_of_ext_normalises_jpg() {
        assert_eq!(mime_of_ext("jpg"), "image/jpeg");
        assert_eq!(mime_of_ext("png"), "image/png");
        assert_eq!(mime_of_ext("webp"), "image/webp");
    }

    #[test]
    fn parse_result_stream_walks_frames_by_length() {
        // 帧头 = 1 字节 code + **4** 字节大端长度（不是 usize 的 8 字节）
        let frame = |code: u8, data: &[u8]| {
            let mut v = vec![code];
            v.extend_from_slice(&(data.len() as u32).to_be_bytes());
            v.extend_from_slice(data);
            v
        };
        // 进度帧（code 1，"检测中…"）+ 结果帧（code 0，3 字节）
        let mut body = frame(1, "检测中…".as_bytes());
        body.extend_from_slice(&frame(0, &[0xAA, 0xBB, 0xCC]));

        let p = parse_result_stream(&body);
        assert_eq!(p.frames.len(), 2);
        assert_eq!(p.frames[0].code, 1);
        assert_eq!(p.frames[0].text.as_deref(), Some("检测中…"));
        assert_eq!(p.error, None);
        assert_eq!(p.result.as_deref(), Some(&[0xAA, 0xBB, 0xCC][..]));
    }

    #[test]
    fn parse_result_stream_marks_truncated_frame_and_stops() {
        // 声明 10 字节但只给 2 字节 ⇒ 截断帧、循环终止
        let body = vec![0u8, 0, 0, 0, 10, 1, 2];
        let p = parse_result_stream(&body);
        assert_eq!(p.frames.len(), 1);
        assert_eq!(p.frames[0].truncated, Some(true));
        assert!(p.result.is_none());
    }

    #[test]
    fn parse_result_stream_code2_records_error_text() {
        let mut body = vec![2u8];
        body.extend_from_slice(&4u32.to_be_bytes());
        body.extend_from_slice(b"boom");
        let p = parse_result_stream(&body);
        assert_eq!(p.error.as_deref(), Some("boom"));
    }

    #[test]
    fn record_frame_covers_all_branches() {
        let f = |code: u8, text: Option<&str>| Frame {
            code,
            size: 0,
            text: text.map(|s| s.to_string()),
            truncated: None,
        };
        assert_eq!(record_frame(7, &f(1, Some("检测"))).as_deref(), Some("seq 7: 检测"));
        assert_eq!(record_frame(7, &f(3, Some("42"))).as_deref(), Some("seq 7: 排队位次 42"));
        assert_eq!(record_frame(7, &f(2, Some("x"))).as_deref(), Some("seq 7: 引擎报错：x"));
        // code 4 载荷为空也产出一条（先于 text 判断）
        assert_eq!(record_frame(7, &f(4, None)).as_deref(), Some("seq 7: 等待翻译实例"));
        // code 0 不产生日志
        assert!(record_frame(7, &f(0, None)).is_none());
    }

    #[test]
    fn engine_local_no_proxy_merges_existing_and_local() {
        // 原有项保留（含去重）+ 本机三写法补齐
        let (a, b) = engine_local_no_proxy(Some("example.com, 127.0.0.1 , example.com"), None);
        assert_eq!(a, "example.com,127.0.0.1,localhost,::1");
        assert_eq!(b, a);
        // 空串 / 缺省 ⇒ 只有本机三写法
        let (c, _) = engine_local_no_proxy(Some(""), None);
        assert_eq!(c, "127.0.0.1,localhost,::1");
        let (d, _) = engine_local_no_proxy(None, Some("corp.internal"));
        assert_eq!(d, "corp.internal,127.0.0.1,localhost,::1");
    }

    #[test]
    fn hf_offline_only_when_present_and_enabled() {
        let m = hf_offline_env(true, false);
        assert_eq!(m.get("HF_HUB_OFFLINE").map(String::as_str), Some("1"));
        assert_eq!(m.get("TRANSFORMERS_OFFLINE").map(String::as_str), Some("1"));
        assert!(hf_offline_env(false, false).is_empty());
        assert!(hf_offline_env(true, true).is_empty());
    }

    #[test]
    fn snapshot_is_camel_case_and_seven_keys() {
        let s = engine_config_snapshot();
        let obj = s.as_object().unwrap();
        assert_eq!(obj.len(), 7);
        assert!(obj.contains_key("targetLang") && !obj.contains_key("target_lang"));
        assert!(obj.contains_key("detectionSize"));
    }

    #[test]
    fn resolve_engine_launch_rejects_module_form_and_builds_probes() {
        let o = EngineLaunchOverrides {
            python_bin: Some(PathBuf::from("/py/python")),
            host: Some("127.0.0.1".into()),
            port: Some(8000),
            use_gpu: Some(true),
            models_ttl: Some(1800),
            nonce: Some("deadbeef".into()),
            sakura_base: Some("http://127.0.0.1:8080/v1".into()),
            hf_offline: Some(BTreeMap::new()),
        };
        let l = resolve_engine_launch(&o);
        let joined = l.cmd.join(" ");
        assert!(joined.contains("main.py --host 127.0.0.1 --port 8000"));
        assert!(joined.contains("--use-gpu") && joined.contains("--models-ttl 1800") && joined.contains("--nonce deadbeef"));
        assert_eq!(l.executor_port, Some(8001));
        assert_eq!(l.env.get("PYTHONIOENCODING").map(String::as_str), Some("utf-8"));
        assert_eq!(l.env.get("SAKURA_API_BASE").map(String::as_str), Some("http://127.0.0.1:8080/v1"));
        assert_eq!(l.env.get("MT_WEB_NONCE").map(String::as_str), Some("deadbeef"));
        assert_eq!(l.probes.len(), 3);
        assert_eq!(l.probes[1]["method"], "POST");
        assert_eq!(l.probes[1]["path"], "/queue-size");
    }

    #[test]
    fn real_llm_launch_reports_undeclared_tier() {
        let o = LlmLaunchOverrides { tier: Some("small".into()), ..Default::default() };
        let err = resolve_llm_launch(&o).unwrap_err();
        assert_eq!(err.code, "TIER_MODEL_UNDECLARED");
    }

    #[test]
    fn engine_lang_code_covers_short_engine_and_auto() {
        assert_eq!(engine_lang_code(Some("ja")).as_deref(), Some("JPN"));
        assert_eq!(engine_lang_code(Some("EN")).as_deref(), Some("ENG"));
        assert_eq!(engine_lang_code(Some(" eng ")).as_deref(), Some("ENG"));
        assert_eq!(engine_lang_code(Some("CHS")).as_deref(), Some("CHS"));
        assert_eq!(engine_lang_code(Some("zh-cn")).as_deref(), Some("CHS"));
        assert_eq!(engine_lang_code(Some("auto")).as_deref(), Some("auto"));
        // 认不出来 / 空 / 缺省 ⇒ None（不猜）
        assert_eq!(engine_lang_code(Some("klingon")), None);
        assert_eq!(engine_lang_code(Some("")), None);
        assert_eq!(engine_lang_code(None), None);
    }

    #[test]
    fn build_engine_config_picks_nllb_for_en_zh_and_keeps_sakura_elsewhere() {
        // en>zh ⇒ 换 nllb（sakura 对英文原文照抄），并下发 from_lang=ENG
        let en = build_engine_config(Some("en"), Some("zh"));
        assert_eq!(en["translator"]["translator"], "nllb");
        assert_eq!(en["translator"]["target_lang"], "CHS");
        assert_eq!(en["translator"]["from_lang"], "ENG");
        // ja>zh ⇒ 回落基线（sakura），同样下发 from_lang=JPN
        let ja = build_engine_config(Some("ja"), Some("zh"));
        assert_eq!(ja["translator"]["translator"], "sakura");
        assert_eq!(ja["translator"]["from_lang"], "JPN");
        // 认不出的方向 ⇒ **不下发** from_lang（保持上游 auto），不是发空串
        let unk = build_engine_config(Some("xx"), Some("zh"));
        assert!(unk["translator"].get("from_lang").is_none());
        assert_eq!(unk["translator"]["target_lang"], "CHS");
    }
}
