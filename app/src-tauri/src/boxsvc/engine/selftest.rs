// boxsvc/engine/selftest.rs —— F4 引擎耦合点的**单源同源自证**（`boxsvc --engine-selftest`）
//
// ## 为什么单源（同 `store-selftest`，见 D-139）
// `e2e/service/engine-parity-check.mjs` 里 **Node 侧吃 Rust 给的输入**：Rust 先吐 `pureInputs`
// （帧字节、无代理 env、HF 情形、启动 overrides），Node 拿它喂**真的** `engine-client.mjs`，
// 再逐条比。两边各造夹具 ⇒ 输入一漂就**假绿**（比的是两份不同输入的不同输出）。
//
// ## 为什么在这里算而不是在 Node 里算
// 本模块只回答「Rust 侧对同样输入给出什么」；Node 侧对同样输入给出什么由对拍脚本现场跑出来。
// 两边都不缓存"期望值"—— 期望值就是对方的输出，没有第三方"标准答案"可以走散。
use base64::Engine as _;
use serde_json::{json, Value};

use super::*;
use crate::boxsvc::store::pure::sniff_image_type;

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// 最小合法 WEBP（32 字节）：嗅探只认前 12 字节（`RIFF` … `WEBP`），真解码不在本脚本范围。
/// 与对拍脚本的 `minimalWebp()` 必须是同一串字节 —— 但**字节由本函数产出**（单源），脚本只是搬运。
fn minimal_webp() -> Vec<u8> {
    let mut b = vec![0u8; 32];
    b[0..4].copy_from_slice(b"RIFF");
    b[4..8].copy_from_slice(&24u32.to_le_bytes());
    b[8..12].copy_from_slice(b"WEBP");
    b[12..16].copy_from_slice(b"VP8X");
    b[16..20].copy_from_slice(&10u32.to_le_bytes());
    b
}

/// 结果流的一帧：`1 字节 code + 4 字节大端长度 + 数据`。
fn frame(code: u8, data: &[u8]) -> Vec<u8> {
    let mut v = vec![code];
    v.extend_from_slice(&(data.len() as u32).to_be_bytes());
    v.extend_from_slice(data);
    v
}

struct FrameCase {
    name: &'static str,
    seq: i64,
    bytes: Vec<u8>,
}

/// 本机硬件画像的**可序列化视图**（形状对齐 Node `probeHardware()`，键名 camelCase）。
///
/// 之所以在这里现算而不是复用某个服务实例的字段：`EngineState` 的 `hardware_accel` /
/// `recommended_tier` 已经吃进了**配置**（用户选了 CPU 就变 cpu），而 E8.1 要问的是
/// 「这台机器**本身**是什么」—— 拿被配置污染过的值去对，会得到"探测结果随设置变化"的错觉。
fn hardware_view() -> Value {
    let hw = super::profile::probe_hardware();
    let r2 = |v: f64| (v * 100.0).round() / 100.0;
    json!({
        "platform": hw.platform,
        "arch": hw.arch,
        "totalRamGb": r2(hw.total_ram_gb),
        "gpu": {
            "kind": hw.gpu.kind,
            "vramGb": hw.gpu.vram_gb.map(r2),
            "unifiedGb": hw.gpu.unified_gb.map(r2),
            "name": hw.gpu.name,
        },
        "accel": super::profile::detect_accel(&hw.gpu),
        "recommendedTier": super::profile::map_tier(hw.total_ram_gb, &hw.gpu),
    })
}

/// 结果流测试向量（**输入**）。覆盖：纯结果 / 进度帧 / 队列位次 / 等待实例 / 流内错误。
fn frame_cases() -> Vec<FrameCase> {
    let webp = minimal_webp();
    let result_only = frame(0, &webp);

    let mut progress_then_result = frame(1, "检测中…".as_bytes());
    progress_then_result.append(&mut frame(0, &webp));

    let mut queue_position = frame(3, b"42");
    queue_position.append(&mut frame(0, &webp));

    let mut wait_instance = frame(4, b"");
    wait_instance.append(&mut frame(0, &webp));

    let mut stream_error = frame(1, "翻译中…".as_bytes());
    stream_error.append(&mut frame(2, b"inference exploded"));

    vec![
        FrameCase { name: "result_only", seq: 7, bytes: result_only },
        FrameCase { name: "progress_then_result", seq: 8, bytes: progress_then_result },
        FrameCase { name: "queue_position", seq: 9, bytes: queue_position },
        FrameCase { name: "wait_instance", seq: 10, bytes: wait_instance },
        FrameCase { name: "stream_error", seq: 11, bytes: stream_error },
    ]
}

fn no_proxy_cases() -> Vec<Value> {
    vec![
        json!({ "NO_PROXY": "example.com, 127.0.0.1 , example.com" }),
        json!({ "NO_PROXY": "" }),
        json!({ "no_proxy": "corp.internal" }),
        json!({}),
    ]
}

fn hf_cases() -> Vec<Value> {
    vec![
        json!({ "present": true, "disabled": false }),
        json!({ "present": false, "disabled": false }),
        json!({ "present": true, "disabled": true }),
    ]
}

/// 产出与 `engine-client.mjs` 对齐的**输入**（给 Node 消费）+ Rust 侧的**输出**（给对拍比对）。
pub fn report() -> String {
    let cases = frame_cases();

    // ---- pureInputs（单源输入）----
    let frame_inputs: Vec<Value> = cases
        .iter()
        .map(|c| json!({ "name": c.name, "seq": c.seq, "b64": b64(&c.bytes) }))
        .collect();

    // 启动 overrides（两个协议共用同一份；字段名对齐 Node 的 overrides）。
    let launch_overrides = json!({
        "pythonBin": "/py/python",
        "host": "127.0.0.1",
        "port": 8000,
        "useGpu": true,
        "modelsTtl": 1800,
        "nonce": "deadbeef",
        "sakuraBase": "http://127.0.0.1:8080/v1",
        // 注入 HF 离线项 ⇒ 证明「算出来了但没接上」不会发生（落点在 env 里）。
        "hfOffline": { "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1" },
    });
    // LLM 配方 overrides：**统一一份**，对两种协议都合法（mock 分支忽略 bin/model/ctx/ngl）。
    let llm_overrides = json!({
        "tier": "tiny",
        "bin": "/bin/llama-server",
        "port": 8080,
        "ctx": 4096,
        "ngl": 99,
    });

    let pure_inputs = json!({
        "frames": frame_inputs,
        "noProxyEnvs": no_proxy_cases(),
        "hfCases": hf_cases(),
        "launchOverrides": launch_overrides,
        "llmOverrides": llm_overrides,
    });

    // ---- pure（Rust 输出）----
    let parsed: Vec<Value> = cases
        .iter()
        .map(|c| {
            let p = parse_result_stream(&c.bytes);
            let stage_lines: Vec<String> =
                p.frames.iter().filter_map(|f| record_frame(c.seq, f)).collect();
            let frames: Vec<Value> = p.frames.iter().map(|f| serde_json::to_value(f).unwrap()).collect();
            // 结果字节的**嗅探**转 ext/mime（与 Node `translateImage` 的返回值同形）——
            // 这一对同时钉住 sniffImageType 与 mimeOfExt 两条。
            let (ext, mime) = match p.result.as_deref().and_then(sniff_image_type) {
                Some(e) => (Some(e.to_string()), Some(mime_of_ext(e))),
                None => (None, None),
            };
            json!({
                "name": c.name,
                "seq": c.seq,
                "resultB64": p.result.as_ref().map(|b| b64(b)),
                "ext": ext,
                "mime": mime,
                "error": p.error,
                "frames": frames,
                "stageLines": stage_lines,
            })
        })
        .collect();

    let no_proxy_out: Vec<Value> = no_proxy_cases()
        .iter()
        .map(|c| {
            let up = c.get("NO_PROXY").and_then(|v| v.as_str());
            let lo = c.get("no_proxy").and_then(|v| v.as_str());
            let (a, b) = engine_local_no_proxy(up, lo);
            json!({ "NO_PROXY": a, "no_proxy": b })
        })
        .collect();

    let hf_out: Vec<Value> = hf_cases()
        .iter()
        .map(|c| {
            let present = c.get("present").and_then(|v| v.as_bool()).unwrap_or(false);
            let disabled = c.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false);
            json!(hf_offline_env(present, disabled))
        })
        .collect();

    let pure = json!({
        "parseResultStream": parsed,
        "engineLocalNoProxy": no_proxy_out,
        "engineHfOfflineEnv": hf_out,
        "availableTiers": available_tiers(),
        "tierModelPath": [
            { "tier": "tiny", "path": tier_model_path("tiny").map(|p| p.to_string_lossy().into_owned()) },
            { "tier": "small", "path": tier_model_path("small").map(|p| p.to_string_lossy().into_owned()) },
            { "tier": "medium", "path": tier_model_path("medium").map(|p| p.to_string_lossy().into_owned()) },
        ],
        "translationSnapshotDir": translation_snapshot_dir(&paths::engine_dir())
            .map(|p| p.to_string_lossy().into_owned()),
        "translationWeightsPresent": translation_weights_present(&paths::engine_dir()),
        // E4：未声明权重的档位必须**显式报错**（`TIER_MODEL_UNDECLARED` + 可用档位清单），
        // 不得静默沿用 tiny 的权重。这条纯函数契约原先只能由 Node 子进程 import 验（《04》§14.2），
        // Node 摘除后改钉这里 —— 出口与 `tierModelPath` 同性质：**按当前协议**各档解析一次。
        "llmLaunchByTier": super::tier_downgrade::TIER_ORDER
            .iter()
            .map(|t| {
                let o = LlmLaunchOverrides { tier: Some((*t).to_string()), ..Default::default() };
                match resolve_llm_launch(&o) {
                    Ok(l) => json!({ "tier": t, "ok": true, "model": l.model }),
                    Err(e) => json!({ "tier": t, "ok": false, "code": e.code, "detail": e.detail }),
                }
            })
            .collect::<Vec<_>>(),
    });

    // ---- 启动配方（用上面的 overrides 现场算）----
    let eo = EngineLaunchOverrides {
        python_bin: Some("/py/python".into()),
        host: Some("127.0.0.1".into()),
        port: Some(8000),
        use_gpu: Some(true),
        models_ttl: Some(1800),
        nonce: Some("deadbeef".into()),
        sakura_base: Some("http://127.0.0.1:8080/v1".into()),
        hf_offline: Some(
            [("HF_HUB_OFFLINE", "1"), ("TRANSFORMERS_OFFLINE", "1")]
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        ),
    };
    let launch = serde_json::to_value(resolve_engine_launch(&eo)).unwrap();

    let lo = LlmLaunchOverrides {
        tier: Some("tiny".into()),
        bin: Some("/bin/llama-server".into()),
        model: None,
        port: Some(8080),
        ctx: Some(4096),
        ngl: Some(99),
        node_exec: None,
    };
    // 按**当前协议**分支（real → llama-server；mock → 仓内替身）；出错则只报 code。
    let llm_launch = match resolve_llm_launch(&lo) {
        Ok(l) => serde_json::to_value(l).unwrap(),
        Err(e) => json!({ "error": e.code }),
    };

    let out = json!({
        "protocol": engine_protocol(),
        "engineVersion": engine_version(),
        // 🔴 硬件画像**放顶层、不进 `pure`**：它随机器而变（显卡 / 内存 / 平台），而
        //    `engine-parity` 的 golden 是**跨机器金标** —— 塞进 `pure` 会让每台机器
        //    跑出来的 golden 都不同，那道对拍钉子当场作废。
        //    E8 的 E8.1（"真机硬件探测与平台一致"）从这里读；形状对齐 Node `probeHardware()`。
        "hardware": hardware_view(),
        "constants": {
            "ENGINE_DEFAULT_DETECTION_SIZE": ENGINE_DEFAULT_DETECTION_SIZE,
            "LLAMA_VERSION_DIR": LLAMA_VERSION_DIR,
            "LLM_OWNER": LLM_OWNER,
            "TIER_LLM_MODELS": TIER_LLM_MODELS
                .iter()
                .map(|(k, v)| (k.to_string(), json!(v)))
                .collect::<serde_json::Map<String, Value>>(),
        },
        "pureInputs": pure_inputs,
        "pure": pure,
        "configSnapshot": engine_config_snapshot(),
        "launch": launch,
        "llmLaunch": llm_launch,
    });
    serde_json::to_string_pretty(&out).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
}
