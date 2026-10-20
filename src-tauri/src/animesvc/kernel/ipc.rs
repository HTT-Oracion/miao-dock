//! mpv 的 **JSON IPC 协议层**（纯函数，可单测）。
//!
//! ## 为什么用 JSON IPC 而不是 libmpv FFI
//! 计划原文写的是 libmpv FFI。本机没有 libmpv 的头文件 / 导入库，双平台各要一份开发包，
//! 而 **同一个 mpv 二进制**已经自带 `--input-ipc-server`：命令与状态走一条本机 socket，
//! 契约（`PlaybackCore` 的七个动作 + 状态快照）一字不改。代价是状态经进程边界传递，
//! 收益是**不必为两个平台各编一份 FFI 绑定**，也不必把 mpv 的 ABI 钉进我们的构建。
//! 这是对计划的偏离，登记在 D-251。
//!
//! ## 为什么协议层单独一个文件
//! 「行格式 / 请求 id / 事件解包 / 轨道表」都能纯函数验证；真 mpv 起不来的机器上，
//! 这些判据仍然能跑（夹具版见 `e2e/fixtures/fake-mpv.mjs`）。

use serde_json::{json, Value};

/// 一条请求的 id。从 1 开始递增；`0` 留给"无需回执"的写法。
pub type RequestId = u64;

/// 编码一条请求为 mpv 要的一行 JSON（**必须带换行**，mpv 按行读）。
pub fn encode(command: &[Value], id: RequestId) -> String {
    let mut obj = json!({ "command": command });
    if id > 0 {
        obj["request_id"] = json!(id);
    }
    format!("{obj}\n")
}

/// 从一行里解出「回执」还是「事件」。
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// 命令回执：`{request_id, error, data?}`
    Reply { id: RequestId, error: String, data: Option<Value> },
    /// 属性变更：`{event:"property-change", name, data}`
    Property { name: String, data: Value },
    /// 其它事件（`start-file` / `end-file` / `file-loaded` / `shutdown` …）
    Event { name: String },
}

/// 解析一行；不是 JSON / 没有可识别字段时给 `None`（mpv 会打日志行，不能当成错误）。
pub fn decode(line: &str) -> Option<Incoming> {
    let line = line.trim();
    if line.is_empty() || !line.starts_with('{') {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    if let Some(id) = v.get("request_id").and_then(|x| x.as_u64()) {
        return Some(Incoming::Reply {
            id,
            error: v.get("error").and_then(|x| x.as_str()).unwrap_or("success").to_string(),
            data: v.get("data").cloned(),
        });
    }
    let name = v.get("event").and_then(|x| x.as_str())?;
    if name == "property-change" {
        return Some(Incoming::Property {
            name: v.get("name").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
            data: v.get("data").cloned().unwrap_or(Value::Null),
        });
    }
    Some(Incoming::Event { name: name.to_string() })
}

/// 一条轨道（音轨 / 字幕轨）。
#[derive(Debug, Clone, PartialEq)]
pub struct Track {
    pub kind: String,
    pub id: String,
    pub label: String,
    pub lang: String,
    pub selected: bool,
}

/// mpv `track-list` 属性 → 我们的轨道表。
///
/// 只留 audio / sub 两类：video 轨对控制条没用（多机位是极少数），
/// 而 `albumart` 之类混进来会让"第 N 条字幕"的序号对不上。
pub fn tracks_of(v: &Value) -> Vec<Track> {
    let Some(list) = v.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for t in list {
        let kind = t.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if kind != "audio" && kind != "sub" {
            continue;
        }
        // mpv 的 id 是数字；`no` 表示关掉。统一成字符串，前端只做等值比较。
        let id = match t.get("id") {
            Some(Value::Number(n)) => n.to_string(),
            Some(Value::String(s)) if s != "no" => s.clone(),
            _ => continue,
        };
        let label = t
            .get("title")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| default_label(kind, &id));
        out.push(Track {
            kind: kind.to_string(),
            id,
            label,
            lang: t.get("lang").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            selected: t.get("selected").and_then(|x| x.as_bool()).unwrap_or(false),
        });
    }
    out
}

fn default_label(kind: &str, id: &str) -> String {
    let prefix = if kind == "audio" { "音轨" } else { "字幕" };
    format!("{prefix} {id}")
}

/// 秒（mpv 的浮点）→ 毫秒。负数 / NaN 一律 0：`time-pos` 在起播前是 `null`。
pub fn secs_to_ms(v: Option<&Value>) -> u64 {
    let s = v.and_then(|x| x.as_f64()).unwrap_or(0.0);
    if !s.is_finite() || s <= 0.0 {
        return 0;
    }
    (s * 1000.0).round() as u64
}

/// 本机 IPC 端点。Windows 是命名管道，其余是 unix socket 文件。
///
/// 名字带 pid 与序号：同一台机器可能同时开两个番剧服务（验收夹具），
/// 固定名字会让第二个进程接到第一个的管道上 —— 症状是"命令没反应"，不是报错。
pub fn endpoint(tag: &str) -> String {
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\miao-anime-mpv-{}-{tag}", std::process::id())
    }
    #[cfg(not(windows))]
    {
        std::env::temp_dir()
            .join(format!("miao-anime-mpv-{}-{tag}.sock", std::process::id()))
            .to_string_lossy()
            .into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_carries_request_id_and_newline() {
        let line = encode(&[json!("set_property"), json!("pause"), json!(true)], 7);
        assert!(line.ends_with('\n'));
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["request_id"], 7);
        assert_eq!(v["command"][0], "set_property");
        assert_eq!(v["command"][2], true);
    }

    #[test]
    fn decode_tells_reply_from_event() {
        let r = decode(r#"{"request_id":3,"error":"success","data":12.5}"#).unwrap();
        assert_eq!(r, Incoming::Reply { id: 3, error: "success".into(), data: Some(json!(12.5)) });

        let e = decode(r#"{"event":"property-change","name":"time-pos","data":9.5}"#).unwrap();
        assert_eq!(e, Incoming::Property { name: "time-pos".into(), data: json!(9.5) });

        // 没有 data 的属性事件（例如切轨时的空值）不能丢
        let e = decode(r#"{"event":"property-change","name":"track-list"}"#).unwrap();
        assert_eq!(e, Incoming::Property { name: "track-list".into(), data: Value::Null });

        assert_eq!(decode(r#"{"event":"file-loaded"}"#).unwrap(), Incoming::Event { name: "file-loaded".into() });
    }

    #[test]
    fn decode_ignores_non_json_and_log_lines() {
        // mpv 在 --no-terminal 下仍可能往同一管道写日志：不能因此断开
        assert!(decode("").is_none());
        assert!(decode("(+) Video --vid=1 (*) (h264 1920x1080)").is_none());
        assert!(decode("{not json}").is_none());
    }

    #[test]
    fn tracks_keep_only_audio_and_sub() {
        let v = json!([
            {"type":"video","id":1,"selected":true},
            {"type":"audio","id":1,"lang":"jpn","selected":true,"title":"日语"},
            {"type":"audio","id":2,"lang":"chi","selected":false},
            {"type":"sub","id":3,"lang":"chi","selected":false,"title":"简中"},
            {"type":"sub","id":"no","selected":false}
        ]);
        let t = tracks_of(&v);
        assert_eq!(t.len(), 3);
        assert_eq!(t[0].kind, "audio");
        assert_eq!(t[0].label, "日语");
        assert_eq!(t[1].label, "音轨 2");
        assert_eq!(t[2].label, "简中");
        assert_eq!(t[2].lang, "chi");
    }

    #[test]
    fn tracks_of_garbage_is_empty() {
        assert!(tracks_of(&Value::Null).is_empty());
        assert!(tracks_of(&json!({"a":1})).is_empty());
    }

    #[test]
    fn secs_to_ms_clamps_garbage() {
        assert_eq!(secs_to_ms(Some(&json!(1.5))), 1500);
        assert_eq!(secs_to_ms(Some(&json!(-3))), 0);
        assert_eq!(secs_to_ms(Some(&json!(null))), 0);
        assert_eq!(secs_to_ms(None), 0);
    }

    #[test]
    fn endpoint_is_unique_per_process() {
        let a = endpoint("1");
        let b = endpoint("2");
        assert_ne!(a, b);
        assert!(a.contains(&std::process::id().to_string()));
    }
}
