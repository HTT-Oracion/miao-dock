// `sidecar` 就绪态 + 建单前置门 —— 移植 `server.mjs` 的 `composeSidecar` / `assertSidecarReady`
// =============================================================================
// ## F5.6 起本文件只做「异步取事实 + 拼装」，判定全在 `engine/state.rs`
// `composeSidecar` 的 9 个字段里，`tier` / `model` / `accel` / `state(degraded)` 需要
// 「硬件 ⊕ 用户设置 ⊕ 引擎实况」三者的合成 —— 那段逻辑是 `EngineState::compose_sidecar()`，
// 与 `/engine/options` 共用同一处实现（拆开就会出现"诊断说 mps、设置页说 cuda"）。
//
// 🔴 两条曾经登记为**已知偏离**、F5.6 已补齐的点：
//   ① `accelDegraded`（指定 GPU 后端却实际跑在 CPU 上 ⇒ state 升级为 degraded）—— 见 D-146；
//   ② `real` 协议下再做一次 `modelStatus` 诊断（模型缺失 ⇒ MODEL_DOWNLOAD_FAILED）。
use serde_json::{json, Value};

use crate::boxsvc::engine::client::{probe_engine, EngineCfg};
use crate::boxsvc::engine::model_status::model_status;
use crate::boxsvc::engine::state::{assert_ready_via, EngineState, AVAILABLE_STATES, PREPARING_STATES};
use crate::boxsvc::store::StoreError;
use crate::boxsvc::Shell;

/// 合成 `sidecar` 视图（9 键）。
pub async fn sidecar_state(shell: &Shell) -> Value {
    let cfg = EngineCfg::from_env();
    let probe = probe_engine(&cfg).await;
    let snap = shell.llm_snapshot();
    shell.engine.compose_sidecar(&probe, &snap)
}

/// 建单前置门（`assertSidecarReady`）。
///
/// 🔴 三条分支**必须分开**，因为「用户该做什么」不同（§2.3 的「边界」原文）：
///   · `ENGINE_NOT_READY`      进程在、正在准备 ⇒ **等待**
///   · `UNAVAILABLE`           进程不在         ⇒ **启动 Box**
///   · `MODEL_DOWNLOAD_FAILED` 模型不在盘上     ⇒ **重新下载模型**
/// 把它们合成一句「服务未就绪」= 把人的动作引向重启，而重启恰好修不好后两种。
///
/// ⚠️ 判定顺序是**有意的**（先说"还在准备"、再说"没有引擎"、最后说"模型没了"）：
///    引擎在 `downloading/starting/prewarming` 时模型**本来就还没齐**，此时报
///    `MODEL_DOWNLOAD_FAILED` 会把"正在下"说成"下坏了" —— 让用户去点一个毫无用处的重下按钮。
pub async fn assert_sidecar_ready(shell: &Shell) -> Result<(), StoreError> {
    let sc = sidecar_state(shell).await;
    let state = sc.get("state").and_then(|v| v.as_str()).unwrap_or("stopped").to_string();
    if AVAILABLE_STATES.contains(&state.as_str()) {
        return Ok(());
    }
    let es: &EngineState = &shell.engine;
    if PREPARING_STATES.contains(&state.as_str()) && !es.contract_refutes.not_ready_as_unavailable {
        return Err(StoreError::new(
            "ENGINE_NOT_READY",
            format!("翻译引擎正在准备（state={state}），请稍候 —— 任务未创建，无需重试"),
            json!({ "sidecar": { "state": state, "port": sc.get("port").cloned().unwrap_or(Value::Null) } }),
        ));
    }
    // ⚠️ 只在 real 协议下做这个诊断：模型是**真引擎**的概念，替身没有模型需求。
    //    不加这道门槛的话，任何一台没装过 runtimes/ 的机器跑 mock 档都会得到
    //    `MODEL_DOWNLOAD_FAILED`，而它其实只是"引擎没起来"。
    let models = if es.protocol == "real" {
        Some(model_status(&es.model_manifest, &es.model_root, None))
    } else {
        None
    };
    assert_ready_via(&sc, models.as_ref(), es.contract_refutes.not_ready_as_unavailable)
}
