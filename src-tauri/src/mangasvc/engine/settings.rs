// 引擎可调设置的**持久化层**（Rust 侧）—— 设置页「推理引擎 / 模型与诊断」两小节的落盘真相
// =============================================================================
// 移植自 `service/src/settings/engine-settings.mjs`（358 行）。
//
// 契约依据：《09》§4.3 ② 翻译服务 10 项 · §6.2 引擎诊断视图 · §6.3 内存预算 /
// 《02》§5 逐项控件形态 / 《04》§7.2/§7.3 档位映射与加速后端 · §9.1 两级空闲卸载。
//
// ## 两条与本仓其它模块不同的性质
//   ① 会**写盘**（用户点一下就要留下痕迹）；② 输入**不可信**（用户/别的版本写进来的键可能拼错）。
// 所以「读」与「写」对未知键的处置**刻意不对称**：
//   · 补丁（`strict`，来自 HTTP 请求体）—— 未知键/非法值**一律抛错**（它是契约输入）；
//   · 文件（非 strict，盘上那份 JSON）—— **丢弃 + 上报**（它是持久化数据，为多余键让整份失效代价太大）。
// 「丢弃 + 上报」**不是**静默：`unknown_keys` / `invalid` 一路带到 `/engine/options` 与诊断视图。
//
// ## 路径由调用方给（本模块对所有输入都是纯参数）
// 与 Node 同款理由：`config` 层要用本模块做合并，本模块若反过来依赖它即形成环。
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

// ================================================================ 白名单与取值域

/// 允许持久化的键（**白名单**）。
///
/// 🔴 白名单的意义不是"防注入"，而是**防拼错**：`idleLlmMinutes`（多写 utes）、
///    `idle_llm_min`（snake_case）、`tier2` 这类键如果被**静默丢弃**，用户看到的是
///    「设置保存成功」，而实际什么都没变 —— 这正是本项目最反对的那类假绿。
pub const ENGINE_SETTINGS_KEYS: &[&str] = &["tier", "accel", "idleLlmMin", "idleVisionMin", "modelDir"];

/// 档位取值（与 `engine/profile.rs` 的 `TIERS` 同集合；此处重复一遍是为了不让本模块依赖那个文件）
pub const ENGINE_TIER_VALUES: &[&str] = &["tiny", "small", "medium"];
/// 加速后端取值：`auto` = 按《04》§7.4 顺序探测，其余为**用户指定**
pub const ENGINE_ACCEL_VALUES: &[&str] = &["auto", "cuda", "mps", "cpu"];
/// 空闲卸载阈值的上限（分钟）。24h —— 再大就不像"空闲卸载"而像"忘关了"，多半是输错了。
pub const IDLE_MIN_MAX: i64 = 1440;

/// 改完**必须重启引擎**才生效的键（《09》§4.3 末句）。
///
/// 🔴 两个空闲卸载阈值**待遇不同**，这不是随手定的：
///   · `idleLlmMin` —— **不在**这一组。Tier1（③ LLM）的归属方就是 manga-service 自己
///     （《04》§9.1），阈值由空闲看护每 tick 现读 ⇒ 保存后**重建看护即立刻生效**。
///   · `idleVisionMin` —— **在**这一组。Tier2（视觉模型）的执行方是**引擎自己**
///     （它自带的 `--models-ttl`），那个数字在**拉开进程的那一刻**就固化了。
pub const RESTART_REQUIRED_KEYS: &[&str] = &["tier", "accel", "modelDir", "idleVisionMin"];

/// 环境变量 → 设置键的映射（**单位与文件一致**，不加换算）。
///
/// ⚠️ `idleVisionMin` **刻意不在表里**：它的环境变量是 `MIAO_ENGINE_MODELS_TTL`，
///    单位是**秒**（见 [`env_vision_ttl_sec`]）。把两种单位的同名语义塞进一张表，
///    就是给"1800 秒 vs 1800 分钟"这类事故留门。
pub const ENV_KEYS: &[(&str, &str)] = &[
    ("MIAO_ENGINE_TIER", "tier"),
    ("MIAO_ENGINE_ACCEL", "accel"),
    ("MIAO_IDLE_LLM_MIN", "idleLlmMin"),
    ("MIAO_MODEL_ROOT", "modelDir"),
];

// ================================================================ 错误

/// `EngineSettingsError` 的对应物（`code` 恒为 `INVALID_SETTING`）。
#[derive(Debug, Clone)]
pub struct EngineSettingsError {
    pub code: String,
    pub message: String,
    pub details: Value,
}

impl EngineSettingsError {
    pub fn invalid(message: impl Into<String>, details: Value) -> Self {
        EngineSettingsError { code: "INVALID_SETTING".to_string(), message: message.into(), details }
    }
}

fn err_object(raw: &Value) -> EngineSettingsError {
    EngineSettingsError::invalid(
        format!("设置必须是一个 JSON 对象，收到 {}", js_typeof(raw)),
        json!({ "received": raw }),
    )
}

/// `typeof` 的等价物（按 JSON 值判；数组成员另有分支）。
fn js_typeof(v: &Value) -> &'static str {
    match v {
        Value::Null => "object",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

// ================================================================ 取值校验

/// 绝对路径、非根、非用户主目录本身 —— 三样都是"往这里放 5 GB 权重"的实际护栏。
fn is_usable_model_dir(v: &Value) -> bool {
    let Some(raw) = v.as_str() else { return false };
    if raw.trim().is_empty() {
        return false;
    }
    if !Path::new(raw).is_absolute() {
        return false;
    }
    let abs = crate::platform::paths::resolve(PathBuf::from(raw));
    // `path.parse(abs).root === abs` 的等价物：根目录没有父。
    if abs.parent().is_none() {
        return false;
    }
    if let Some(home) = dirs::home_dir() {
        if crate::platform::paths::resolve(home) == abs {
            return false;
        }
    }
    true
}

/// 单键的取值规则文案（对应 `VALIDATORS[key].hint`）。
fn hint_of(key: &str) -> String {
    match key {
        "tier" => format!("可选：{}", ENGINE_TIER_VALUES.join(" | ")),
        "accel" => format!("可选：{}（auto = 按硬件探测）", ENGINE_ACCEL_VALUES.join(" | ")),
        "idleLlmMin" | "idleVisionMin" => format!("0–{IDLE_MIN_MAX} 的整数（分钟），0 = 从不卸载"),
        "modelDir" => "绝对路径（不能是文件系统根目录，也不能是用户主目录本身）".to_string(),
        other => other.to_string(),
    }
}

/// JS `Number.isInteger(v)` 的等价物。serde_json 把 `3.0` 解析成 f64，而 JS 里它就是个整数。
fn js_is_integer(v: &Value) -> bool {
    if v.as_i64().is_some() {
        return true;
    }
    v.as_f64().map(|f| f.fract() == 0.0 && f.is_finite()).unwrap_or(false)
}

/// 取整数值（`js_is_integer` 为真时才有意义）。
fn js_int(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))
}

fn check_value(key: &str, v: &Value) -> bool {
    match key {
        "tier" => v.as_str().map(|s| ENGINE_TIER_VALUES.contains(&s)).unwrap_or(false),
        "accel" => v.as_str().map(|s| ENGINE_ACCEL_VALUES.contains(&s)).unwrap_or(false),
        "idleLlmMin" | "idleVisionMin" => match js_int(v) {
            Some(n) => js_is_integer(v) && (0..=IDLE_MIN_MAX).contains(&n),
            None => false,
        },
        "modelDir" => is_usable_model_dir(v),
        _ => false,
    }
}

/// 单个键的规范化（只做取值层面的整形，不做业务加工）。
fn normalize_value(key: &str, v: &Value) -> Value {
    match key {
        "modelDir" => {
            let raw = v.as_str().unwrap_or("").trim().to_string();
            Value::String(crate::platform::paths::resolve(PathBuf::from(raw)).to_string_lossy().into_owned())
        }
        "idleLlmMin" | "idleVisionMin" => Value::Number(serde_json::Number::from(js_int(v).unwrap_or(0))),
        _ => v.clone(),
    }
}

// ================================================================ 解析

/// `parseEngineSettings` 的产出。
#[derive(Debug, Clone, Default)]
pub struct Parsed {
    pub settings: Map<String, Value>,
    pub unknown_keys: Vec<String>,
    pub invalid: Vec<Value>,
}

/// 解析一份设置对象（`strict` 的语义见文件头）。
pub fn parse_engine_settings(raw: &Value, strict: bool, allow_unknown: bool) -> Result<Parsed, EngineSettingsError> {
    if raw.is_null() || !raw.is_object() {
        if strict {
            return Err(err_object(raw));
        }
        return Ok(Parsed {
            settings: Map::new(),
            unknown_keys: Vec::new(),
            invalid: vec![json!({ "key": "(root)", "must": "对象" })],
        });
    }

    let mut out = Parsed::default();
    for (key, value) in raw.as_object().unwrap() {
        if !ENGINE_SETTINGS_KEYS.contains(&key.as_str()) {
            if strict && !allow_unknown {
                return Err(EngineSettingsError::invalid(
                    format!(
                        "未知设置项 {} —— 不在白名单内（允许：{}）",
                        json!(key),
                        ENGINE_SETTINGS_KEYS.join(", ")
                    ),
                    json!({ "key": key, "allowed": ENGINE_SETTINGS_KEYS }),
                ));
            }
            out.unknown_keys.push(key.clone());
            continue;
        }
        if !check_value(key, value) {
            if strict {
                return Err(EngineSettingsError::invalid(
                    format!("设置项 {key} 取值非法（须为 {}）", hint_of(key)),
                    json!({ "key": key, "value": value }),
                ));
            }
            out.invalid.push(json!({ "key": key, "must": hint_of(key) }));
            continue;
        }
        out.settings.insert(key.clone(), normalize_value(key, value));
    }
    Ok(out)
}

/// 校验一个**补丁**（HTTP 请求体）。空补丁抛错 ——
/// 一个 `POST {}` 若返回 200「已保存」，那是最典型的假绿：什么都没写，却报"保存成功"。
pub fn assert_patch(patch: &Value, allow_unknown: bool) -> Result<Map<String, Value>, EngineSettingsError> {
    if patch.is_null() || !patch.is_object() {
        return Err(EngineSettingsError::invalid(
            format!("请求体必须是对象，收到 {}", js_typeof(patch)),
            json!({ "received": patch }),
        ));
    }
    if patch.as_object().unwrap().is_empty() {
        return Err(EngineSettingsError::invalid("请求体为空，没有任何设置项", json!({})));
    }
    Ok(parse_engine_settings(patch, true, allow_unknown)?.settings)
}

// ================================================================ 读 / 写

/// `readEngineSettings` 的产出。
#[derive(Debug, Clone)]
pub struct ReadResult {
    pub settings: Map<String, Value>,
    pub exists: bool,
    pub corrupt: bool,
    pub reason: Option<String>,
    pub unknown_keys: Vec<String>,
    pub invalid: Vec<Value>,
}

impl ReadResult {
    fn empty() -> Self {
        ReadResult {
            settings: Map::new(),
            exists: false,
            corrupt: false,
            reason: None,
            unknown_keys: Vec::new(),
            invalid: Vec::new(),
        }
    }
}

/// 读盘上那份设置。
///
/// 文件不存在 = **正常的首次启动**（返回空设置，不是错误）；只有"存在但读不成"才是 `corrupt`。
/// 坏文件**原地保留、不搬走、不重命名**：证据比整洁重要。
pub fn read_engine_settings(file: &Path) -> ReadResult {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                return ReadResult::empty();
            }
            return ReadResult {
                exists: true,
                corrupt: true,
                reason: Some(format!("{}: {}", e.raw_os_error().map(|c| c.to_string()).unwrap_or_else(|| "ERROR".into()), e)),
                ..ReadResult::empty()
            };
        }
    };

    let raw: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            return ReadResult {
                exists: true,
                corrupt: true,
                reason: Some(format!("JSON 解析失败：{e}")),
                ..ReadResult::empty()
            };
        }
    };

    // 顶层形状不对（数组 / 字符串 / null）也算坏文件 —— 但它能被"读懂"，故 reason 说清是哪一种。
    if raw.is_null() || !raw.is_object() {
        return ReadResult {
            exists: true,
            corrupt: true,
            reason: Some(format!("顶层应为 JSON 对象，实为 {}", js_typeof(&raw))),
            ..ReadResult::empty()
        };
    }

    match parse_engine_settings(&raw, false, false) {
        Ok(p) => ReadResult {
            settings: p.settings,
            exists: true,
            corrupt: false,
            reason: None,
            unknown_keys: p.unknown_keys,
            invalid: p.invalid,
        },
        Err(e) => ReadResult { exists: true, corrupt: true, reason: Some(e.message), ..ReadResult::empty() },
    }
}

/// `writeEngineSettings` 的产出。
#[derive(Debug, Clone)]
pub struct WriteResult {
    pub settings: Map<String, Value>,
    pub changed: Vec<String>,
    pub restart_required: bool,
}

/// 原子写：先写同目录下的临时文件、`fsync`、再 `rename` 覆盖。
///
/// 🔴 为什么不能直接写目标文件：`rename` 在 POSIX 上是**原子**的，而直接写不是 ——
///    崩在中间会留下**半截 JSON**，下次启动就读成 `corrupt`，于是用户改了半天的设置被静默回退
///    成默认值（而这条路径在正常退出下**永远测不到**）。
pub fn write_engine_settings(file: &Path, patch: &Value, allow_unknown: bool) -> Result<WriteResult, EngineSettingsError> {
    let clean = assert_patch(patch, allow_unknown)?;

    let current = read_engine_settings(file);
    let mut merged = current.settings.clone();
    let mut changed: Vec<String> = Vec::new();
    for (k, v) in &clean {
        merged.insert(k.clone(), v.clone());
        changed.push(k.clone());
    }
    // Node 的 `Object.keys(clean)` 按请求体的键序 —— 这里按白名单序归一，**不依赖** Map 的排序。
    changed.sort_by_key(|k| ENGINE_SETTINGS_KEYS.iter().position(|x| x == k).unwrap_or(usize::MAX));

    let dir = file.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    std::fs::create_dir_all(&dir).map_err(|e| {
        EngineSettingsError::invalid(format!("无法创建设置目录 {}：{e}", dir.display()), json!({}))
    })?;
    let body = format!("{}\n", serde_json::to_string_pretty(&Value::Object(merged.clone())).unwrap_or_default());
    let tmp = tmp_path(file);
    let write_r = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        set_file_mode(&tmp);
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write_r {
        let _ = std::fs::remove_file(&tmp);
        return Err(EngineSettingsError::invalid(format!("写入设置失败：{e}"), json!({})));
    }
    if let Err(e) = std::fs::rename(&tmp, file) {
        let _ = std::fs::remove_file(&tmp);
        return Err(EngineSettingsError::invalid(format!("落盘设置失败：{e}"), json!({})));
    }

    let restart_required = changed.iter().any(|k| RESTART_REQUIRED_KEYS.contains(&k.as_str()));
    Ok(WriteResult { settings: merged, changed, restart_required })
}

/// 临时文件名带 pid + 时间戳：两个进程同时写（理论上不该发生）也不会互相踩。
fn tmp_path(file: &Path) -> PathBuf {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = format!(
        "{}.tmp-{}-{}",
        file.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        std::process::id(),
        ms
    );
    file.parent().map(|p| p.join(&name)).unwrap_or_else(|| PathBuf::from(name))
}

/// 权限 0600：设置里虽没有密钥，但"用户的本地偏好"也该只有本人可读。
fn set_file_mode(_p: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(_p, std::fs::Permissions::from_mode(0o600));
    }
}

// ================================================================ 合并（文件 ⊕ env）

/// `mergeWithEnv` 的产出。`sources[key]` = `"env"` 或 `"file"`。
#[derive(Debug, Clone, Default)]
pub struct Merged {
    pub settings: Map<String, Value>,
    pub sources: Map<String, Value>,
}

/// 把"盘上设置"与"环境变量"合并成**一份生效值**，并**逐个键记下来源**。
///
/// 🔴 优先级：`env` > 文件 > 默认（由调用方给）。环境变量在本项目里的角色是**验收与排障的
///    强制覆盖**；若文件优先，本机跑过一次设置页之后，所有夹具都会被用户偏好悄悄改写。
///
/// `env_last` = **反证开关**（`MIAO_SETTINGS_ENV_LAST`）：把两者倒过来，用来证明「env 优先」
/// 这条断言咬的确实是优先级本身，而不是"恰好两边同值"。
pub fn merge_with_env(file_settings: &Map<String, Value>, env_last: bool) -> Result<Merged, EngineSettingsError> {
    let mut from_env: Map<String, Value> = Map::new();
    for (name, key) in ENV_KEYS {
        let Some(raw) = env_str(name) else { continue };
        let value: Value = if *key == "idleLlmMin" {
            match parse_js_int(&raw) {
                Some(n) => Value::Number(serde_json::Number::from(n)),
                None => Value::String(raw.clone()),
            }
        } else {
            Value::String(raw.clone())
        };
        if !check_value(key, &value) {
            return Err(EngineSettingsError::invalid(
                format!("环境变量 {name} 取值非法（须为 {}）：{}", hint_of(key), json!(raw)),
                json!({ "key": key, "env": name, "value": raw }),
            ));
        }
        from_env.insert((*key).to_string(), normalize_value(key, &value));
    }

    let mut out = Merged::default();
    let apply = |bag: &Map<String, Value>, source: &str, out: &mut Merged| {
        for (k, v) in bag {
            out.settings.insert(k.clone(), v.clone());
            out.sources.insert(k.clone(), Value::String(source.to_string()));
        }
    };
    if env_last {
        apply(&from_env, "env", &mut out);
        apply(file_settings, "file", &mut out);
    } else {
        apply(file_settings, "file", &mut out);
        apply(&from_env, "env", &mut out);
    }
    Ok(out)
}

/// 环境变量里的**秒** → 视觉档空闲卸载阈值（`MIAO_ENGINE_MODELS_TTL`）。
///
/// 🔴 单独一支而不是塞进 [`merge_with_env`]：它的单位是**秒**、且历史上就是秒
///   （`resolveEngineLaunch` 对 `modelsTtl` 的 push 就是秒）。硬把它按分钟解析，
///   会让 `MIAO_ENGINE_MODELS_TTL=1800` 从「30 分钟」变成「1800 分钟 = 30 小时」——
///   一个**看起来还在跑、实际再也不卸载**的静默故障。
pub fn env_vision_ttl_sec() -> Result<Option<i64>, EngineSettingsError> {
    let Some(raw) = env_str("MIAO_ENGINE_MODELS_TTL") else { return Ok(None) };
    let n = parse_js_int(&raw);
    match n {
        Some(v) if v >= 0 => Ok(Some(v)),
        _ => Err(EngineSettingsError::invalid(
            format!("MIAO_ENGINE_MODELS_TTL 取值非法：{}（应为 ≥0 的整数秒）", json!(raw)),
            json!({ "value": raw }),
        )),
    }
}

/// 两级空闲卸载阈值的**唯一**求解处（可反复调用）。
///
/// 回退链（三级，env 优先）：
///   Tier1 `llm_ms` ：`MIAO_IDLE_LLM_MS`（毫秒）→ `MIAO_IDLE_LLM_MIN` → 文件 `idleLlmMin` → 出厂 5 min
///   Tier2 `vision_sec`：`MIAO_ENGINE_MODELS_TTL`（**秒**）→ 文件 `idleVisionMin` → 出厂 1800 s
pub fn read_idle_settings(file: &Path, env_last: bool) -> Result<IdleSettings, EngineSettingsError> {
    let fresh = read_engine_settings(file);
    let merged = merge_with_env(&fresh.settings, env_last)?;

    let llm_ms = match env_int_or_null("MIAO_IDLE_LLM_MS")? {
        Some(ms) => ms,
        None => match merged.settings.get("idleLlmMin").and_then(js_int) {
            Some(min) => min * 60_000,
            None => 5 * 60_000,
        },
    };
    let vision_sec = match env_vision_ttl_sec()? {
        Some(s) => s,
        None => match merged.settings.get("idleVisionMin").and_then(js_int) {
            Some(min) => min * 60,
            None => 1800,
        },
    };
    Ok(IdleSettings { llm_ms, vision_sec, settings: merged.settings, sources: merged.sources })
}

/// `readIdleSettings()` 的产出。
#[derive(Debug, Clone)]
pub struct IdleSettings {
    pub llm_ms: i64,
    pub vision_sec: i64,
    pub settings: Map<String, Value>,
    pub sources: Map<String, Value>,
}

// ================================================================ env 小工具（config.mjs 语义）

/// 非空环境变量（空串按「未设」处理 —— 同 `config.mjs` 的 `raw === '' → def`）。
pub fn env_str(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|s| !s.is_empty())
}

/// `envBool(name, def)`：非空才判定，`0/false/no/off`（小写）为假。
pub fn env_bool(name: &str, def: bool) -> bool {
    match env_str(name) {
        Some(s) => !matches!(s.to_lowercase().as_str(), "0" | "false" | "no" | "off"),
        None => def,
    }
}

/// 复刻 JS `Number.parseInt(raw, 10)`：取前导符号 + 数字，其余忽略。
pub fn parse_js_int(s: &str) -> Option<i64> {
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

/// `envIntOrNull`：未设 ⇒ `None`；设了但非法 ⇒ **抛错**（不静默回退）。
pub fn env_int_or_null(name: &str) -> Result<Option<i64>, EngineSettingsError> {
    let Some(raw) = env_str(name) else { return Ok(None) };
    match parse_js_int(&raw) {
        Some(n) if n >= 0 => Ok(Some(n)),
        _ => Err(EngineSettingsError::invalid(
            format!("{name} 取值非法：{}（应为 ≥0 的整数）", json!(raw)),
            json!({ "value": raw }),
        )),
    }
}

/// `envInt(name, def)`：非空才解析；解析失败或负数 → `def`（同 `config.mjs`）。
///
/// ⚠️ 与 [`env_int_or_null`] **刻意不同**：那个是"夹具要秒级短回路"的开关（配错必须当场炸），
///    这个是"巡检周期"之类的普通旋钮（配错退回默认，不该让服务起不来）。
pub fn env_int(name: &str, def: i64) -> i64 {
    match env_str(name) {
        Some(s) => parse_js_int(&s).filter(|n| *n >= 0).unwrap_or(def),
        None => def,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelist_rejects_typos() {
        let p = json!({ "idleLlmMinutes": 9 });
        assert!(assert_patch(&p, false).is_err());
        let ok = assert_patch(&json!({ "idleLlmMin": 9 }), false).unwrap();
        assert_eq!(ok.get("idleLlmMin").and_then(js_int), Some(9));
    }

    #[test]
    fn empty_patch_is_rejected() {
        assert!(assert_patch(&json!({}), false).is_err());
    }

    #[test]
    fn integer_check_accepts_float_with_zero_fraction() {
        assert!(check_value("idleLlmMin", &json!(3.0)));
        assert!(!check_value("idleLlmMin", &json!(3.5)));
        assert!(!check_value("idleLlmMin", &json!(-1)));
        assert!(!check_value("idleLlmMin", &json!(IDLE_MIN_MAX + 1)));
    }

    #[test]
    fn file_path_is_permissive_but_patch_is_strict() {
        let raw = json!({ "tier": "large", "nope": 1 });
        let loose = parse_engine_settings(&raw, false, false).unwrap();
        assert!(loose.settings.is_empty());
        assert_eq!(loose.unknown_keys, vec!["nope".to_string()]);
        assert_eq!(loose.invalid.len(), 1);
        assert!(parse_engine_settings(&raw, true, false).is_err());
    }

    #[test]
    fn restart_required_keys_are_exactly_four() {
        assert_eq!(RESTART_REQUIRED_KEYS.len(), 4);
        assert!(RESTART_REQUIRED_KEYS.contains(&"idleVisionMin"));
        assert!(!RESTART_REQUIRED_KEYS.contains(&"idleLlmMin"));
    }

    #[test]
    fn parse_js_int_matches_parseint() {
        assert_eq!(parse_js_int("9"), Some(9));
        assert_eq!(parse_js_int("9abc"), Some(9));
        assert_eq!(parse_js_int("abc"), None);
        assert_eq!(parse_js_int("-3"), Some(-3));
    }
}
