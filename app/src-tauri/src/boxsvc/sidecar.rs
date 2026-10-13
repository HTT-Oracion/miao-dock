// `sidecar` 就绪态 + 建单前置门 —— 移植 `server.mjs` 的 `composeSidecar` / `assertSidecarReady`
// 的**引擎侧**部分。
//
// ## 归属与边界（F5）
// 本增量（F5.2/F5.3/F5.4：tasks+queue+library）只用到**一个**事实：引擎能不能开工（`state`）。
// `composeSidecar` 的 9 字段里，`tier` / `model` / `accel` 需要 `settings/engine-profile` 族
// （F5.6 才迁），故此处 `state` **只**取引擎探测结果。
//
// ⚠️ **已知偏离（登记 D-146）**：未复刻 `accelDegraded`（「指定了 GPU 后端却实际跑在 CPU 上
//    ⇒ state 升级为 degraded」）。在 mock 档与未设 `MIAO_ENGINE_USE_GPU` 的机器上与 Node 一致；
//    真机 GPU 回退档下 Rust 会报 `running` 而非 `degraded`。F5.6 随 `/health` 一并补齐。
// ⚠️ 另一处：`real` 协议下 Node 会再做一次 `modelStatus` 诊断（模型缺失 ⇒ MODEL_DOWNLOAD_FAILED），
//    本增量未迁 `settings/model-status.mjs` ⇒ 落回 `UNAVAILABLE`。F5.6 补齐。
use serde_json::{json, Value};

use crate::boxsvc::engine::client::{probe_engine, EngineCfg};
use crate::boxsvc::store::StoreError;
use crate::boxsvc::Shell;

/// 「引擎正在准备」的三个取值 —— 用户只需等待（《03》§2.3 / §10.3）。
const PREPARING_STATES: &[&str] = &["starting", "prewarming", "downloading"];
/// 可翻译的状态：`running` 之外，`degraded`（GPU 回退 CPU）**依然能跑**，只是慢。
const AVAILABLE_STATES: &[&str] = &["running", "degraded"];

/// 合成 `sidecar` 视图（本增量只保证 `state` / `port` / `engine` / `engineVersion` / `warmed` / `llm` 正确）。
pub async fn sidecar_state(shell: &Shell) -> Value {
    let cfg = EngineCfg::from_env();
    let probe = probe_engine(&cfg).await;
    let snap = shell.llm_snapshot();
    let state = probe
        .get("state")
        .and_then(|x| x.as_str())
        .unwrap_or("stopped")
        .to_string();
    json!({
        "state": state,
        "port": probe.get("port").cloned().unwrap_or(Value::Null),
        "engine": probe.get("engine").cloned().unwrap_or(Value::Null),
        "engineVersion": probe.get("engineVersion").cloned().unwrap_or(Value::Null),
        "tier": Value::Null,
        "model": Value::Null,
        "accel": "cpu",
        // `warmed` = 「现在提交任务能不能全速开工」= 引擎② 三重就绪 **且** ③ 在跑（§9.4）。
        "warmed": state == "running" && snap.state == "running",
        "llm": { "state": snap.state, "port": snap.port },
    })
}

/// 建单前置门（`assertSidecarReady`）。
///
/// 🔴 判定顺序是**有意的**（先说"还在准备"、再说"没有引擎"）：引擎在
/// `downloading/starting/prewarming` 时模型本来就还没齐，此时报 `MODEL_DOWNLOAD_FAILED`
/// 会把"正在下"说成"下坏了" —— 让用户去点一个毫无用处的重下按钮。
pub async fn assert_sidecar_ready(shell: &Shell) -> Result<(), StoreError> {
    let sc = sidecar_state(shell).await;
    let state = sc.get("state").and_then(|x| x.as_str()).unwrap_or("stopped").to_string();
    if AVAILABLE_STATES.contains(&state.as_str()) {
        return Ok(());
    }
    let detail = json!({ "sidecar": { "state": state, "port": sc.get("port").cloned().unwrap_or(Value::Null) } });
    if PREPARING_STATES.contains(&state.as_str()) {
        return Err(StoreError::new(
            "ENGINE_NOT_READY",
            format!("翻译引擎正在准备（state={state}），请稍候 —— 任务未创建，无需重试"),
            detail,
        ));
    }
    Err(StoreError::new(
        "UNAVAILABLE",
        format!("翻译引擎（sidecar）不可用：state={state}"),
        detail,
    ))
}
