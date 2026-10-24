// 引擎设置 / 硬件画像 / 诊断视图的**服务级合成**（Rust 侧）
// =============================================================================
// 对应 Node 的 `service/src/config.mjs`（S4/S6 那几段）＋ `service/src/server.mjs`
// 的 `composeSidecar` / `healthStatus` / `engineStatusView` / `engineOptionsView` /
// `guardEngineSettings` / `startModelDownload` / `assertSidecarReady`。
//
// ## 为什么单独成文件（而不是塞进 handlers.rs）
// `handlers.rs` 是**路由搬运层**（读体 → 调门面 → 出信封）。本文件是**判定与合成层**：
// 硬件事实、用户设置、env 覆盖、引擎实况四者的合成只允许有一处实现 —— 一旦拆开，
// 就会出现 `/health` 说 MPS、`/engine/options` 说 CUDA 这种"两边各说一套"。
//
// ## 三条贯穿全文件的纪律
//   ① **绝不摆一个点了不会有作用的控件**：所以「候选」与「能不能选」是两件事，两个都要给
//      （`options` 清单 + 写路径的**拒绝**）。`blockedReason` / `mismatch` 是它的产物。
//   ② **"已配置"与"已生效"必须分开报**：改档位要重启才生效，只给一个字段的话界面只能二选一
//      —— 要么显示旧档（用户以为没保存上），要么显示新档（用户以为已经在跑 7B 了）。
//   ③ **反证开关集中登记**（[`Refutes`] / [`ContractRefutes`]），不散在各自代码旁。
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::platform::child_watch::hide_console;

use crate::mangasvc::store::{StoreError, model};
use crate::mangasvc::translate;
use crate::platform::paths;

use super::supervisor::LlmSnapshot;
use super::{engine_config_snapshot, engine_version, available_tiers, profile, settings as esettings};
use super::model_status::model_status;
use super::model_store::ProgressEvent;
use super::tier_downgrade::TierDowngrade;

// ================================================================ 常量（与 server.mjs 同名同值）

/// 引擎握手缓存的窗口。⚠️ **只**缓存"不必 2 秒内再和引擎握一次手"，**绝不**缓存 ③ 的进程态
/// （缓存进程态会出现「说 ③ 在跑、其实刚停」的假象，而 §9.4 要的恰恰是在这一刻分得清）。
pub const SIDECAR_CACHE_MS: u128 = 2000;
/// 「引擎正在准备」的三个取值 —— 用户只需等待（《03》§2.3 / §10.3）。
pub const PREPARING_STATES: &[&str] = &["starting", "prewarming", "downloading"];
/// 可翻译的状态：`running` 之外，`degraded`（GPU 回退 CPU，§7.4-3）**依然能跑**，只是慢。
pub const AVAILABLE_STATES: &[&str] = &["running", "degraded"];

/// 下载 tail 的行数上限（`MODEL_DOWNLOAD_TAIL_MAX`）。
pub const MODEL_DOWNLOAD_TAIL_MAX: usize = 40;
/// 下载超时（1h）。超时**必须真杀** —— 只改状态不杀的话进程会一直在后台写盘。
pub const MODEL_DOWNLOAD_TIMEOUT_MS: i64 = 60 * 60_000;

// A3d：模型下载 / 校验的**执行体**是 `mangasvc --fetch-models`，不再是
// `node engine/scripts/fetch-models.mjs`（A3「node 随包」作废 ⇒ 产品运行期不许依赖解释器）。
// 默认取**自己**（服务本体就是 mangasvc），`MIAO_MODEL_DOWNLOAD_RUNNER` 是给 e2e 注入
// 假执行体的接缝 —— 它替代了原来的 `MIAO_MODEL_DOWNLOAD_SCRIPT`（那个隐含 node）。

// ================================================================ 反证开关（集中登记）

/// S6 设置面反证开关（`config.settingsRefute`）。
/// 🔴 只被 `e2e/service/engine-settings-check.mjs --refute` 设置；产品路径永不设置。
#[derive(Debug, Clone, Default)]
pub struct Refutes {
    /// 写路径不再校验白名单 ⇒ 未知键被**静默丢弃**（`S1` 应红）
    pub no_whitelist: bool,
    /// 合并优先级倒过来（文件压 env）⇒ 「env 优先」不可见（`R2` 应红）
    pub env_last: bool,
    /// 加速后端候选不再按硬件筛 ⇒ Metal 机上出现 CUDA（`G5`/`S5` 应红）
    pub accel_open: bool,
    /// 档位候选不再按内存可行性筛 ⇒ 16GB Mac 上出现 Medium（`G3`/`S4` 应红）
    pub tier_all: bool,
    /// 模型下载的**单飞守卫**被摘掉 ⇒ 并发第二个请求不再 409（`D3` 应红）
    pub download_open: bool,
}

/// S5 契约面反证开关（`config.contractRefute`）。
#[derive(Debug, Clone, Default)]
pub struct ContractRefutes {
    /// `ENGINE_NOT_READY` 退回 `UNAVAILABLE`（§2.3 边界消失）
    pub not_ready_as_unavailable: bool,
    /// `/health` 的 `sidecar` 退回 ver1.0 的 3 字段（§5.1 扩展面消失）
    pub sidecar_legacy3: bool,
    /// `/engine/status` 免除鉴权（§5.2「不是免鉴权例外」被破坏）
    pub engine_status_open: bool,
    /// `warmed` 恒 true（§9.4「卸载 ≠ 未就绪」在字段层面不可见）
    pub warmed_always: bool,
    /// 🔴 令牌校验恒通过（`MIAO_TOKEN_ALWAYS_OK=1`）—— 反证开关，用来证明
    ///    E10.7「无令牌访问 → 403」咬的确实是鉴权本身，而不是"路由恰好不存在"。
    pub token_always_ok: bool,
}

// ================================================================ 模型下载状态机

/// 「重新下载模型」的任务实况（`/engine/status` 的第 9 键）。
///
/// 🔴 **进度只来自真实事件**：`percent` / `received_bytes` / `total_bytes` / `speed_bps` /
///    `eta_ms` 全部由 `mangasvc --fetch-models --progress-log` 写出的 JSONL 聚合而来，
///    取不到时为 `None` —— 前端**不得**补占位数字（与 NotReadyScreen 的 `lastLogLine`
///    同一纪律）。`stage` / `current_id` 同样来自真实事件。
///
/// 状态机：`idle` | `running` | `interrupted` | `done` | `failed`。
///   · `interrupted` = 可续传的中断（断网 / 磁盘满 / 超时 / 被强制关闭，且盘上有 `.part`
///     或 `.ready` 未覆盖全部选中条目）；`can_resume` 必为 true。
///   · `failed` = 不可续传的失败（`can_resume` 为 false，只能从头重下）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDownload {
    pub state: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub exit_code: Option<i64>,
    pub timed_out: bool,
    pub tail: Vec<String>,
    // ---- G5：结构化进度（全部来自 `--progress-log`，取不到为 None）----
    pub percent: Option<f64>,
    pub received_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub speed_bps: Option<f64>,
    pub eta_ms: Option<i64>,
    /// 当前阶段：`stage1`（准备运行环境）| `stage2`（下载权重，后台继续）| `null`。
    ///
    /// 🔴 这是**下载详情页**那个两步指示器的数据源（`DownloadPanel.tsx` 的 `STAGE_TEXT`
    /// 只有两格），它的取值空间**不可扩**。四段装配时间线走下面的 `step`。
    pub stage: Option<String>,
    /// 装配四段的当前段（D-231④）：`prepare`（环境准备）/ `runtime`（运行环境装配）/
    /// `models`（本地引擎装配）/ `null`（还没有真实事件，或只有真实事件之外的态）。
    ///
    /// 🔴 **为什么与 `stage` 并存而不是把 `stage` 改成四段**：`STAGE_TEXT['prepare']`
    /// 会是 `undefined` ⇒ `stage` 取到 `null` ⇒ 下载详情页的阶段指示器在准备期
    /// **整块消失**。那是明确的功能回退，而用户并没有要求改那个页面。
    #[serde(default)]
    pub step: Option<String>,
    /// 当前正在处理的条目 id（文件名 / 阶段名），没有真实来源时为 `null`。
    pub current_id: Option<String>,
    /// 用户主动点了「暂停下载」（见 `pause_download`）。
    ///
    /// 🔴 为什么需要它：暂停 = 杀掉下载子进程，退出码非零 ⇒ 终态线程按"能不能续"判
    ///    `interrupted` / `error`。刚开下就暂停时盘上还没有 `.part`，会被判成**不可续的失败**
    ///    （界面上「继续下载」会变成「重新下载」）。有这个标记就一律按可续的中断处理。
    #[serde(default)]
    pub paused_by_user: bool,
    // ---- G5：中断 / 续传 ----
    /// 可续传：盘上存在 `.part`，或 `.ready` 未覆盖全部选中条目。
    pub can_resume: bool,
    /// 中断原因（措辞取自服务端事实，不猜）。`null` = 未中断。
    pub interrupted_reason: Option<String>,
}

impl Default for ModelDownload {
    fn default() -> Self {
        ModelDownload {
            state: "idle".to_string(),
            started_at: None,
            finished_at: None,
            exit_code: None,
            timed_out: false,
            tail: Vec::new(),
            percent: None,
            received_bytes: None,
            total_bytes: None,
            speed_bps: None,
            eta_ms: None,
            stage: None,
            step: None,
            current_id: None,
            paused_by_user: false,
            can_resume: false,
            interrupted_reason: None,
        }
    }
}

/// 进度聚合用的内部态（**不进契约**，不入 `ModelDownload` 序列化）。
///
/// 每条 `--progress-log` 行更新这里的 `entries` 表与样本窗；聚合结果再写回
/// `ModelDownload` 的 `percent` / `received_bytes` / `total_bytes` / `speed_bps` /
/// `eta_ms`。`entries` 用 `id` 去重 —— 同一文件的多条进度事件只更新那一行的 received。
pub struct DownloadProgressState {
    /// `id` → (received, total)；`total` 为 None 表示该条目尚无总量（阶段标记事件）。
    entries: std::collections::HashMap<String, (u64, Option<u64>)>,
    /// 采样窗：(ms, received_bytes)；用于算瞬时速度（取最近一段的斜率）。
    samples: Vec<(i64, u64)>,
    /// 最近一条真实进度事件的毫秒时间戳（用于判「卡住」）。
    last_event_ms: i64,
}

impl DownloadProgressState {
    fn new() -> Self {
        DownloadProgressState {
            entries: std::collections::HashMap::new(),
            samples: Vec::new(),
            last_event_ms: 0,
        }
    }

    /// 喂一条进度事件，返回聚合后的快照（直接写进 `ModelDownload`）。
    ///
    /// 🔴 `received` 必须与 `total` 取**同一份集合**（只统计总量已知的条目）：
    ///    源没给 Content-Length 时该条目的 total 是 None，若把它的字节累加进分子、
    ///    却不进分母 ⇒ 分数破 100%（实测界面出现过 111%）。
    fn ingest(&mut self, e: &ProgressEvent, now_ms: i64) -> (u64, u64, Option<u64>) {
        // 阶段标记事件（total=None，phase="stage"）：只更新当前阶段，不动字节账。
        if e.phase == "stage" {
            self.last_event_ms = now_ms;
            let total: u64 = self.entries.values().filter_map(|(_, t)| *t).sum();
            let received: u64 = self.entries.values().filter_map(|(r, t)| t.map(|_| *r)).sum();
            return (received, total, None);
        }
        let total = e.total.unwrap_or_else(|| {
            // 复用该条目已知总量；未知则记 None（聚合时总量缺失 ⇒ percent 为 null）
            self.entries.get(&e.id).and_then(|(_, t)| *t).unwrap_or(0)
        });
        let entry_total = if e.total.is_some() { Some(total) } else { self.entries.get(&e.id).and_then(|(_, t)| *t) };
        self.entries.insert(e.id.clone(), (e.received, entry_total));
        self.last_event_ms = now_ms;
        let total: u64 = self.entries.values().filter_map(|(_, t)| *t).sum();
        let received: u64 = self.entries.values().filter_map(|(r, t)| t.map(|_| *r)).sum();
        (received, total, e.total)
    }
}

// ================================================================ 引擎状态（服务级单例）

/// 服务级引擎状态 —— 进程一份（`Shell` 持有 `Arc`）。
pub struct EngineState {
    // ---- 生效配置（进程启动那一刻定下来的那一批）----
    pub protocol: String,
    pub hardware: profile::HwFacts,
    pub hardware_accel: String,
    pub recommended_tier: String,
    /// `config.engineAccel`（已含 env ⊕ 文件）
    pub engine_accel_choice: String,
    /// `config.engineTier`（`None` = 按硬件推荐）
    pub engine_tier_choice: Option<String>,
    pub engine_use_gpu: bool,
    /// 实际生效档位（`clampTierToAvailable` 之后）
    pub effective_tier: String,
    pub unload_never: bool,
    pub idle_llm_ms: i64,
    pub idle_tick_ms: i64,
    pub idle_activity_scope: String,
    pub engine_models_ttl: i64,
    pub llm_autostart: bool,
    pub no_idle_unload: bool,
    pub no_tier_downgrade: bool,

    // ---- 路径 ----
    pub settings_file: PathBuf,
    pub model_root: PathBuf,
    pub model_manifest: PathBuf,
    /// 模型下载 / 校验的**执行体**（A3d 起 = `mangasvc`；`--fetch-models` 子命令）。
    pub download_runner: PathBuf,

    // ---- 反证 ----
    pub refutes: Refutes,
    pub contract_refutes: ContractRefutes,

    // ---- 可变状态 ----
    pub download: Arc<Mutex<ModelDownload>>,
    /// G5：进度聚合内部态（与 `download` 同生命周期，不进契约）。
    download_progress: Arc<Mutex<DownloadProgressState>>,
    download_child: Arc<Mutex<Option<std::process::Child>>>,
    /// 输出读取线程的停止闸（暂停时合闸，见 `spawn_tail_reader` 的说明）。
    ///
    /// 🔴 为什么必须有：`child.kill()` 只让**后续**输出消失，管道里**已缓冲**的数据仍可读。
    ///    不设闸时读取线程会把缓冲读完并继续 push 进内存 tail，而那些 push 不落盘
    ///    ⇒ 界面日志"暂停了还在刷"，而盘上文件静止（2026-10-25 真机实测）。
    download_stop: Arc<AtomicBool>,
    /// 档位降档控制器（《04》§8）—— 进程级单例 ⇒ 天然是"服务级"作用域。
    pub tier_ctl: Arc<TierDowngrade>,
}

impl EngineState {
    /// 从环境变量装配。与 Node `config.mjs` 一样：**取值非法直接失败**（不静默回退）。
    pub fn from_env() -> Result<Self, String> {
        let protocol = super::engine_protocol();
        let settings_file = paths::manga_state_dir().join("engine-settings.json");

        let refutes = Refutes {
            no_whitelist: esettings::env_bool("MIAO_SETTINGS_NO_WHITELIST", false),
            env_last: esettings::env_bool("MIAO_SETTINGS_ENV_LAST", false),
            accel_open: esettings::env_bool("MIAO_SETTINGS_ACCEL_OPEN", false),
            tier_all: esettings::env_bool("MIAO_SETTINGS_TIER_ALL", false),
            download_open: esettings::env_bool("MIAO_SETTINGS_DOWNLOAD_OPEN", false),
        };
        let contract_refutes = ContractRefutes {
            not_ready_as_unavailable: esettings::env_bool("MIAO_NOT_READY_AS_UNAVAILABLE", false),
            sidecar_legacy3: esettings::env_bool("MIAO_SIDECAR_LEGACY3", false),
            engine_status_open: esettings::env_bool("MIAO_ENGINE_STATUS_OPEN", false),
            warmed_always: esettings::env_bool("MIAO_WARMED_ALWAYS", false),
            token_always_ok: esettings::env_bool("MIAO_TOKEN_ALWAYS_OK", false),
        };

        // 「盘上的用户设置」⊕「环境变量」—— 唯一一处合并实现（与 `config.mjs` 同口径）。
        let read = esettings::read_engine_settings(&settings_file);
        if read.corrupt {
            eprintln!(
                "[manga-service] ⚠ 引擎设置文件损坏，已退回默认值（文件原地保留）：{} —— {}",
                settings_file.display(),
                read.reason.clone().unwrap_or_default()
            );
        }
        let merged = esettings::merge_with_env(&read.settings, refutes.env_last).map_err(|e| e.message)?;

        // 空闲阈值：三级回退（env → 文件 → 出厂）。
        let idle = esettings::read_idle_settings(&settings_file, refutes.env_last).map_err(|e| e.message)?;

        let hardware = profile::probe_hardware();
        let hardware_accel = profile::detect_accel(&hardware.gpu);
        let recommended_tier = profile::map_tier(hardware.total_ram_gb, &hardware.gpu);

        let engine_accel_choice = merged
            .settings
            .get("accel")
            .and_then(|v| v.as_str())
            .unwrap_or("auto")
            .to_string();
        let engine_tier_choice = merged.settings.get("tier").and_then(|v| v.as_str()).map(str::to_string);
        // 🔴 两个来源取**与**，不是二选一：`accel === 'cpu'`（用户在界面上明确选了 CPU）
        //    与 `MIAO_ENGINE_USE_GPU=0`（S4 起就存在的注入开关，验收用它造"GPU 回退 CPU"现场）。
        let engine_use_gpu = if engine_accel_choice == "cpu" {
            false
        } else {
            esettings::env_bool("MIAO_ENGINE_USE_GPU", true)
        };

        let unload_never = idle.llm_ms == 0 || esettings::env_bool("MIAO_UNLOAD_NEVER", false);
        let engine_models_ttl = if unload_never { 0 } else { idle.vision_sec };

        let desired_tier = engine_tier_choice.clone().unwrap_or_else(|| recommended_tier.clone());
        let effective_tier = clamp_tier_to_available(&desired_tier);

        let download_runner = match esettings::env_str("MIAO_MODEL_DOWNLOAD_RUNNER") {
            Some(p) => paths::resolve(PathBuf::from(p)),
            None => std::env::current_exe().unwrap_or_else(|_| PathBuf::from("mangasvc")),
        };

        Ok(EngineState {
            protocol,
            hardware,
            hardware_accel,
            recommended_tier,
            engine_accel_choice,
            engine_tier_choice,
            engine_use_gpu,
            effective_tier: effective_tier.clone(),
            unload_never,
            idle_llm_ms: idle.llm_ms,
            idle_tick_ms: esettings::env_int("MIAO_IDLE_TICK_MS", 5_000),
            idle_activity_scope: if esettings::env_str("MIAO_IDLE_SCOPE").as_deref() == Some("all") {
                "all".to_string()
            } else {
                "runtime".to_string()
            },
            engine_models_ttl,
            llm_autostart: !esettings::env_bool("MIAO_NO_LLM_AUTOSTART", false),
            no_idle_unload: esettings::env_bool("MIAO_NO_IDLE_UNLOAD", false),
            no_tier_downgrade: esettings::env_bool("MIAO_NO_TIER_DOWNGRADE", false),
            settings_file,
            model_root: paths::model_root(),
            model_manifest: paths::model_manifest(),
            download_runner,
            refutes,
            contract_refutes,
            download: Arc::new(Mutex::new(ModelDownload::load_persisted())),
            download_progress: Arc::new(Mutex::new(DownloadProgressState::new())),
            download_child: Arc::new(Mutex::new(None)),
            download_stop: Arc::new(AtomicBool::new(false)),
            tier_ctl: Arc::new(TierDowngrade::new(&effective_tier, esettings::env_bool("MIAO_NO_TIER_DOWNGRADE", false))),
        })
    }

    fn lock_download(&self) -> std::sync::MutexGuard<'_, ModelDownload> {
        match self.download.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    /// 生效设置 + 来源（**现读**，不用启动时那份快照 —— 用户刚保存的值必须立刻可见）。
    pub fn saved(&self) -> (Map<String, Value>, Map<String, Value>) {
        esettings::merge_with_env(
            &esettings::read_engine_settings(&self.settings_file).settings,
            self.refutes.env_last,
        )
        .map(|m| (m.settings, m.sources))
        .unwrap_or_default()
    }

    /// 「已配置 vs 已生效」里的**已配置**那一半（现读盘上那份）。
    pub fn saved_idle(&self) -> esettings::IdleSettings {
        esettings::read_idle_settings(&self.settings_file, self.refutes.env_last)
            .unwrap_or(esettings::IdleSettings {
                llm_ms: self.idle_llm_ms,
                vision_sec: self.engine_models_ttl,
                settings: Map::new(),
                sources: Map::new(),
            })
    }

    /// 实际生效的加速后端（静态判定；`degraded` 是动态的，见 `sidecar_state`）。
    pub fn accel_effective(&self) -> profile::AccelChoice {
        profile::resolve_accel(&self.engine_accel_choice, &self.hardware_accel, self.engine_use_gpu)
    }

    // ---------------------------------------------------------------- sidecar 合成（9 键）

    /// 合成 `sidecar` 的 9 个契约字段（《03》§5.1 / §5.2）。
    ///
    /// 这是**唯一**一处把「引擎侧事实」与「服务级事实」拼在一起的地方 —— 两侧各自的权威分别在
    /// `probe_engine()` 与 (`llm` / `hardware` / `tier_ctl`)，谁都不去改对方的状态。
    pub fn compose_sidecar(&self, probe: &Value, snap: &LlmSnapshot) -> Value {
        let accel_eff = self.accel_effective();
        let raw_state = probe.get("state").and_then(|v| v.as_str()).unwrap_or("stopped").to_string();
        // §7.4-3：指定了 GPU 后端却**实际跑在 CPU 上** ⇒ 状态升级为 `degraded`（"不静默"）。
        let state = if accel_eff.degraded && raw_state == "running" { "degraded".to_string() } else { raw_state.clone() };
        let up = state != "stopped" && state != "error" && state != "downloading";
        // ⚠️ `tier_ctl.current_tier()` 是**取值函数**：少写这对括号会把一个函数塞进 JSON，
        //    `JSON.stringify` 静默丢掉该键 ⇒ `/health.sidecar` 与 `/engine/status` 都**少一个 `tier` 键**。
        let tier = self.tier_ctl.current_tier();
        let model = if up {
            snap.model.clone().or_else(|| tier_model_name(&tier))
        } else {
            None
        };
        json!({
            "state": state,
            "port": probe.get("port").cloned().unwrap_or(Value::Null),
            "engine": probe.get("engine").cloned().unwrap_or(Value::Null),
            "engineVersion": probe.get("engineVersion").cloned().unwrap_or(Value::Null),
            // 档位 / 模型是**引擎侧才有的概念**：引擎都不在时报一个档位只会误导
            //（用户会以为"跑着的引擎是 tiny"，而事实是"没有引擎在跑"）。
            "tier": if up { json!(tier) } else { Value::Null },
            "model": model.map(|m| json!(m)).unwrap_or(Value::Null),
            // 实际生效的后端（§7.4-3 的"记录实际生效后端"）。GPU 被关掉时报 `cpu`，
            // **不报"本该是什么"** —— `/engine/status` 的用途就是拿界面和事实对账。
            "accel": accel_eff.accel,
            // 🔴 `warmed` = 「现在提交任务能不能全速开工」= 引擎② 三重就绪 **且** ③ 在跑。
            //    它与 `state` **不冗余**，正是 §9.4「卸载 ≠ 未就绪」在字段层面的体现。
            "warmed": if self.contract_refutes.warmed_always {
                true
            } else {
                raw_state == "running" && snap.state == "running"
            },
            "llm": { "state": snap.state, "port": snap.port.map(|p| json!(p)).unwrap_or(Value::Null) },
        })
    }

    /// `/health` 顶层 `status`（§5.1：`ok` | `degraded` | `starting`）。
    ///
    /// 🔴 「③ 没在跑」**不等于** `degraded`：§9.4 明说"卸载 ≠ 未就绪"，而空闲卸载是**设计行为**。
    ///    只有两种情况算 degraded：① 引擎回退到 CPU（§7.4-3）；② ③ 真的 `error`。
    pub fn health_status(sc: &Value) -> &'static str {
        let state = sc.get("state").and_then(|v| v.as_str()).unwrap_or("");
        if PREPARING_STATES.contains(&state) {
            return "starting";
        }
        if state == "degraded" {
            return "degraded";
        }
        if state == "running" {
            let llm = sc.get("llm").and_then(|l| l.get("state")).and_then(|v| v.as_str()).unwrap_or("");
            return if llm == "error" { "degraded" } else { "ok" };
        }
        "degraded" // stopped / error / 其它：确实不可用
    }

    // ---------------------------------------------------------------- /engine/options

    /// `GET /engine/options` —— 设置页「推理引擎 / 模型与诊断」两小节的**全部取值来源**。
    pub fn options_view(&self, sc: &Value) -> Value {
        let models = model_status(&self.model_manifest, &self.model_root, None);
        let weights_available = available_tiers();
        let accel_eff = self.accel_effective();
        let hw = &self.hardware;

        // 档位候选：先按**硬件可行性**筛（《02》§5「物理不可行档位不出现」），
        // 再叠加**权重在不在**（硬件吃得住 ≠ 我们手上有那份权重）。两者混为一谈会出现
        // "界面上 Small 可点、点了之后被静默夹回 tiny"——最坏的一种失败。
        let feasible = if self.refutes.tier_all {
            profile::TIERS
                .iter()
                .map(|tier| profile::TierOption {
                    tier: (*tier).to_string(),
                    peak_gb: profile::tier_peak_gb(tier),
                    recommended: *tier == self.recommended_tier,
                    warning: None,
                })
                .collect::<Vec<_>>()
        } else {
            profile::tier_options(hw.total_ram_gb, &hw.gpu, &self.recommended_tier)
        };
        let tier_list: Vec<Value> = feasible
            .iter()
            .map(|o| {
                let ready = weights_available.contains(&o.tier);
                json!({
                    "tier": o.tier,
                    "peakGb": o.peak_gb,
                    "recommended": o.recommended,
                    "warning": o.warning,
                    "weightsReady": ready,
                    "blockedReason": if ready { Value::Null } else { json!(format!(
                        "该档位的权重尚未纳入 models.manifest.json（当前可下载：{}）",
                        if weights_available.is_empty() { "无".to_string() } else { weights_available.join(" / ") }
                    )) },
                })
            })
            .collect();

        // 空闲阈值：**现读盘现算**，而不是用启动时冻住的那两个常量。
        let saved_idle = self.saved_idle();
        let (settings, sources) = (saved_idle.settings.clone(), saved_idle.sources.clone());
        let file_state = esettings::read_engine_settings(&self.settings_file);

        json!({
            "protocol": self.protocol,
            "hardware": {
                "platform": hw.platform,
                "arch": hw.arch,
                "totalRamGb": hw.total_ram_gb,
                "gpuKind": hw.gpu.kind,
                "gpuName": hw.gpu.name,
                "accel": self.hardware_accel,
            },
            "tier": {
                // 当前**实际生效**档位（引擎不在时是 null —— 与 `sidecar.tier` 同口径）
                "effective": sc.get("tier").cloned().unwrap_or(Value::Null),
                // **已配置**的档位（盘上那份，现读）；null = 未指定（按硬件推荐）
                "configured": settings.get("tier").cloned().unwrap_or(Value::Null),
                "source": sources.get("tier").cloned().unwrap_or_else(|| json!("hardware")),
                "hardwareRecommended": self.recommended_tier,
                "weightsAvailable": weights_available,
                "options": tier_list,
            },
            "accel": {
                "effective": accel_eff.accel,
                "choice": settings.get("accel").cloned().unwrap_or_else(|| json!(self.engine_accel_choice)),
                "source": sources.get("accel").cloned().unwrap_or_else(|| json!("default")),
                "hardwareRecommended": self.hardware_accel,
                "mismatch": accel_eff.mismatch,
                "reason": accel_eff.reason,
                // 反证开关 `accelOpen` 让候选不再按硬件筛（`G5` 应红：Metal 机上出现 CUDA）
                "options": profile::accel_options(&self.hardware_accel, self.refutes.accel_open)
                    .into_iter()
                    .map(|o| json!({ "value": o.value, "label": o.label, "detail": o.detail }))
                    .collect::<Vec<_>>(),
            },
            "idle": {
                // Tier1（③ LLM）由本进程自持 ⇒ 保存后重建看护即**立刻生效**（appliesAfterRestart:false）。
                // Tier2（视觉模型）由引擎自带的 `--models-ttl` 执行 ⇒ **必须重启**。
                "llm": {
                    "ms": saved_idle.llm_ms,
                    "min": round_div(saved_idle.llm_ms, 60_000),
                    "minIsExact": saved_idle.llm_ms % 60_000 == 0,
                    "appliesAfterRestart": false,
                    "source": sources.get("idleLlmMin").cloned().unwrap_or_else(|| {
                        json!(if esettings::env_str("MIAO_IDLE_LLM_MS").is_some() { "env" } else { "default" })
                    }),
                },
                "vision": {
                    "ms": saved_idle.vision_sec * 1000,
                    "min": round_div(saved_idle.vision_sec * 1000, 60_000),
                    "minIsExact": (saved_idle.vision_sec * 1000) % 60_000 == 0,
                    "appliesAfterRestart": true,
                    "source": sources.get("idleVisionMin").cloned().unwrap_or_else(|| {
                        json!(if esettings::env_str("MIAO_ENGINE_MODELS_TTL").is_some() { "env" } else { "default" })
                    }),
                },
                "neverUnload": settings.get("idleLlmMin").and_then(|v| v.as_i64()) == Some(0) || self.unload_never,
            },
            "modelDir": {
                "current": self.model_root.to_string_lossy(),
                "configured": settings.get("modelDir").cloned().unwrap_or(Value::Null),
                "defaultDir": default_model_dir().to_string_lossy(),
                "source": sources.get("modelDir").cloned().unwrap_or_else(|| json!("default")),
                "exists": self.model_root.exists(),
            },
            "models": models,
            // 哪些键改完要重启引擎（《09》§4.3）。界面据它决定亮不亮那条提示条。
            "restartRequiredKeys": esettings::RESTART_REQUIRED_KEYS,
            "settingsFile": {
                "path": self.settings_file.to_string_lossy(),
                "keys": esettings::ENGINE_SETTINGS_KEYS,
                "exists": file_state.exists,
                "corrupt": file_state.corrupt,
                "reason": file_state.reason,
                "ignoredKeys": file_state.unknown_keys,
                "invalidValues": file_state.invalid,
            },
        })
    }

    // ---------------------------------------------------------------- 写设置的能力裁决

    /// 写设置前的**能力裁决** —— 这是本端点最有价值的一段。
    ///
    /// 为什么不在 `settings.rs` 里做：那个模块只管"取值合不合法"（纯语法/单位），对硬件与权重
    /// 一无所知。把硬件判据塞进去，一个纯粹为了持久化而存在的模块忽然要认识 GPU。
    /// ⇒ 分工：**格式**归 `settings`，**能力**归这里。
    ///
    /// 🔴 **先格式、后能力**，顺序不能反。反了的话，`{"tier":"large"}` 会先撞上能力裁决，得到一句
    ///    「档位 large 的权重尚未纳入 models.manifest.json」—— 一个把**拼错的值**说成"缺权重"
    ///    的错误提示，用户会跑去点「校验完整性」，而真正该做的是改掉这个值。
    pub fn guard_settings(&self, patch: &Map<String, Value>) -> Result<(), StoreError> {
        let reject = |msg: String, details: Value| Err(StoreError::new("INVALID_SETTING", msg, details));

        if let Some(tier) = patch.get("tier").and_then(|v| v.as_str()) {
            let weights = available_tiers();
            if !weights.iter().any(|w| w == tier) {
                let avail = if weights.is_empty() { "无".to_string() } else { weights.join(" / ") };
                return reject(
                    format!("档位 {tier} 的权重尚未纳入 models.manifest.json（当前可用：{avail}）")
                        + " —— 先在「模型管理」里补齐权重，或改选可用档位",
                    json!({ "key": "tier", "value": tier, "available": weights }),
                );
            }
            // 反证开关 `tierAll` 去掉这条可行性裁决（`S4` 应红：Medium 被接受）
            if !self.refutes.tier_all {
                let opt = profile::tier_options(self.hardware.total_ram_gb, &self.hardware.gpu, &self.recommended_tier);
                if !opt.iter().any(|o| o.tier == tier) {
                    // ⚠️ 峰值取 `tier_peak_gb`（**全表**），**不是**从 `opt` 里找 —— `opt` 只含
                    //    **可行**档位，而被拒的这个按定义不在里面，从它那里取会得到 `?`。
                    let peak = profile::tier_peak_gb(tier).map(|v| v.to_string()).unwrap_or_else(|| "?".to_string());
                    let names = opt.iter().map(|o| o.tier.clone()).collect::<Vec<_>>().join(" / ");
                    return reject(
                        format!(
                            "档位 {tier} 在本机物理不可行（本机内存 {} GB，该档预估峰值 {peak} GB）—— 可选：{names}",
                            self.hardware.total_ram_gb
                        ),
                        json!({ "key": "tier", "value": tier, "totalRamGb": self.hardware.total_ram_gb }),
                    );
                }
            }
        }

        if let Some(accel) = patch.get("accel").and_then(|v| v.as_str()) {
            // 与 `options_view()` 用**同一个** `accel_options()`：两处若各筛一遍，就会出现
            // "界面不列 CUDA、但接口收 CUDA"——一个只能通过手写请求撞见的漏洞。
            let allowed: Vec<String> = profile::accel_options(&self.hardware_accel, self.refutes.accel_open)
                .into_iter()
                .map(|o| o.value)
                .collect();
            if !allowed.iter().any(|a| a == accel) {
                return reject(
                    format!(
                        "加速后端 {accel} 在本机不可用（硬件探测为 {}）—— 可选：{}",
                        profile::accel_label(&self.hardware_accel),
                        allowed.join(" / ")
                    ),
                    json!({ "key": "accel", "value": accel, "allowed": allowed }),
                );
            }
        }

        if let Some(dir) = patch.get("modelDir").and_then(|v| v.as_str()) {
            let p = std::path::Path::new(dir);
            match std::fs::metadata(p) {
                Ok(md) => {
                    if !md.is_dir() {
                        return reject(
                            format!("模型目录 {dir} 是一个文件，不是目录"),
                            json!({ "key": "modelDir", "value": dir }),
                        );
                    }
                }
                Err(_) => {
                    // 允许"新建一个叶子目录"（父目录得在）—— 否则打错一层路径就会静默建出一棵深树，
                    // 而权重会真的下到那里（5–8 GB），等到发现时已经写下去了。
                    let parent = p.parent().map(|x| x.to_path_buf()).unwrap_or_default();
                    if !parent.as_os_str().is_empty() && !parent.exists() {
                        return reject(
                            format!(
                                "模型目录 {dir} 不存在，且其上级 {} 也不存在 —— 请先创建上级目录",
                                parent.display()
                            ),
                            json!({ "key": "modelDir", "value": dir, "parent": parent.to_string_lossy() }),
                        );
                    }
                }
            }
        }
        Ok(())
    }

    // ---------------------------------------------------------------- 模型下载

    /// `modelDownloadView()`。
    ///
    /// 🔴 **只增不改**：前端所有下载态展示都从这里取值；既有字段名与语义一律保留，
    ///    新增的进度/中断字段全部带 `| null`（取不到时为 null，前端不得补占位数字）。
    pub fn model_download_view(&self) -> Value {
        let d = self.lock_download();
        json!({
            "state": d.state,
            "running": d.state == "running",
            "startedAt": d.started_at,
            "finishedAt": d.finished_at,
            "exitCode": d.exit_code,
            "timedOut": d.timed_out,
            "tail": d.tail,
            "rootDir": self.model_root.to_string_lossy(),
            "manifest": self.model_manifest.to_string_lossy(),
            // 执行体（A3d 起是 `mangasvc`，不再是那个 .mjs 脚本）在不在盘上。
            // 界面据此**禁用按钮**（而不是让用户点一下换一条报错）。
            "runner": self.download_runner.to_string_lossy(),
            "runnerExists": self.download_runner.exists(),
            // ---- G5：结构化进度（全部来自 `--progress-log`，null = 无真实来源）----
            "percent": d.percent,
            "receivedBytes": d.received_bytes,
            "totalBytes": d.total_bytes,
            "speedBps": d.speed_bps,
            "etaMs": d.eta_ms,
            "stage": d.stage,
            // D-231④：四段装配时间线的当前段。**加在 `modelDownload` 内部**（不是顶层）
            // ⇒ `/engine/status` 的顶层键数不变，`check:contract` 的 S5.7 精确等值不受影响。
            "step": d.step,
            "currentId": d.current_id,
            // 整体装配进度（段加权）：段内只有"有字节账"的两段才细分，其余停在段首。
            // 🔴 为什么不在前端算：权重是产品判断（哪一段更费时），两处各写一份必然漂移。
            "assemblyPercent": assembly_percent(d.step.as_deref(), d.percent),
            // 当前段**没有可测字节进度**（prepare / runtime 的 venv、pip、补丁）⇒ 界面配旋转弧，
            // 而不是把上一段留下的数字当成本段在走。
            "assemblyIndeterminate": matches!(d.step.as_deref(), Some("prepare") | Some("runtime")),
            // ---- G5：中断 / 续传 ----
            // 🔴 `canResume` 在视图时**现算**（不存）：盘上有 `.part` 或 `.ready` 未覆盖全部选中条目
            //    ⇒ true。这样即使进程重启、内存态清空，也能如实告诉界面「有东西可续」。
            "canResume": self.can_resume_now(),
            "interruptedReason": d.interrupted_reason,
        })
    }

    /// 暂停下载：杀掉子进程（`.part` 留在盘上 ⇒ 可续），状态落 `interrupted`。
    ///
    /// 语义与「中断」一致、只是原因不同：界面据此显示「继续下载」而不是「重新下载」。
    /// 没在下就 409（`DOWNLOAD_NOT_RUNNING`）—— 与启动端点"已在跑就 409"同一条纪律：
    /// 不让用户以为这一下生效了。
    pub fn pause_download(&self) -> Result<Value, StoreError> {
        let taken = self
            .download_child
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        let Some(mut child) = taken else {
            return Err(StoreError::new(
                "DOWNLOAD_NOT_RUNNING",
                "当前没有正在进行的下载",
                json!({}),
            ));
        };

        // 先打标记再杀：终态线程看到 `paused_by_user` 就把非零退出记成**可续的中断**，
        // 不会因为"还没写出 .part"而判成不可续的失败。
        {
            let mut d = self.lock_download();
            d.paused_by_user = true;
            d.state = "interrupted".to_string();
            d.interrupted_reason =
                Some("已暂停（你点了「暂停下载」）；已下的部分不会丢失，可继续".to_string());
            /*
             * 瞬时量一律清零 —— 暂停后继续显示等于编造。
             *
             * 🔴 `current_id` 必须清：它是 progress 事件持续覆写的"当前文件"，
             *    暂停后壳层每 1.5 s 轮询仍拿到同一个旧值 ⇒ 界面上那一行
             *    "看起来还在动"（真机实测：用户会以为下载没停）。
             *    与 `speed_bps` / `eta_ms` 同等对待，不是可选项。
             */
            d.speed_bps = None;
            d.eta_ms = None;
            d.current_id = None;
            d.persist();
        }
        let _ = child.kill();
        let _ = child.wait();
        // 合闸：让输出读取线程把管道里已缓冲的数据**丢掉**而不是读完。
        // 必须在 `kill()` 之后 —— 早合只会让最后几行真实日志消失，晚合则缓冲已被读走。
        self.download_stop
            .store(true, Ordering::Relaxed);
        println!("[manga-service] 模型下载已暂停（用户操作）");
        Ok(self.model_download_view())
    }

    /// 盘上此刻能否续传：模型根或运行时根下存在 `.part`，或存在未覆盖全部的就绪标记。
    fn can_resume_now(&self) -> bool {
        has_part_files(&self.model_root) || has_part_files(&paths::runtimes_dir())
    }

    /// 启动「重新下载模型」。**立即返回** —— 下载要十几分钟，HTTP 挂不住。
    ///
    /// `fresh = true`（屏上「重新下载」）：先清掉 `.part` 续传断点再从头下；
    /// `fresh = false`（屏上「继续下载」/ 首次下载）：沿用 `.part` 续传。
    /// 🔴 续传由 `.part` + HTTP Range 天然完成 —— 前端**不需要**新协议，
    ///    再调一次同一个端点即可（plan 关键决策三）。
    pub fn start_model_download(&self, fresh: bool) -> Result<Value, StoreError> {
        {
            let d = self.lock_download();
            if d.state == "running" && !self.refutes.download_open {
                let tail: Vec<String> = d.tail.iter().rev().take(5).rev().cloned().collect();
                return Err(StoreError::new(
                    "DOWNLOAD_IN_PROGRESS",
                    "模型下载已在进行中 —— 同一时刻只允许一个下载任务（并发会互相截断续传文件）",
                    json!({ "startedAt": d.started_at, "tail": tail }),
                ));
            }
        }
        if !self.download_runner.exists() {
            return Err(StoreError::new(
                "INTERNAL",
                format!("模型下载执行体不存在：{}", self.download_runner.display()),
                json!({ "runner": self.download_runner.to_string_lossy() }),
            ));
        }

        /*
         * 「重新下载」：清掉续传断点、**已解包的目标目录**与已聚合进度，让本次从零开始。
         *
         * 🔴 为什么必须连解包目标一起清：解包是 `tar -xf … -C out` 原地覆盖，
         *    目标目录里已有文件时逐个撞占用 ⇒ `Can't stat existing object: Permission denied`
         *    （真机实测，`python-3.11/` 上一轮已解出一部分时就必现）。
         *    只清 `.part` 会让「重新下载」在同一处**再失败一次** —— 界面说的是
         *    「从头下载全部文件」，用户据此理解成"重来一遍"，不能只兑现有下载那一半。
         *
         * 🔴 只清**有 extractTo 的条目的目标**，不清整个 runtime_root / model_root：
         *    那两棵树下还有 `.download-cache`（48 MB 归档，清了要重走一遍网络）
         *    与用户自己的模型权重，一刀切下去代价完全不对等。
         */
        if fresh {
            clear_part_files(&self.model_root);
            clear_part_files(&paths::runtimes_dir());
            // 🔴 `model_manifest` 存的是**路径**不是 Manifest —— 用前先读盘。
            //    读不到就跳过一次清理：归档/解包阶段自己会报"清单读不到"，
            //    在这里再报一次同样的错只会把两条信息叠在一起。
            for (manifest_path, root) in [
                (self.model_manifest.clone(), self.model_root.clone()),
                (paths::runtime_manifest(), paths::runtimes_dir()),
            ] {
                if let Some(m) = load_manifest_quietly(&manifest_path) {
                    for dir in extract_targets(&m, &root) {
                        remove_dir_quietly(&dir);
                    }
                }
            }
            {
                let mut p = self.download_progress.lock().unwrap_or_else(|p| p.into_inner());
                *p = DownloadProgressState::new();
            }
        }

        spawn_download_round(
            &self.download_runner,
            &self.model_root,
            &self.model_manifest,
            Some(1),
            &self.download,
            &self.download_progress,
            &self.download_child,
            &self.download_stop,
        )?;

        Ok(self.model_download_view())
    }

    /// `POST /engine/models/verify` 要跑的**执行体**（A3d 起 = `mangasvc`）。
    ///
    /// 与 `download_runner` 同一个可执行文件、同一个子命令族 —— 只是这里给 `--check`。
    /// 拆成两个字段没有意义：它们是同一份代码的两种用法。
    pub fn verify_runner(&self) -> PathBuf {
        self.download_runner.clone()
    }

    /// 引擎诊断视图（`/engine/status`）。
    pub fn engine_status_view(&self, sc: &Value, snap: &LlmSnapshot) -> Value {
        let models = model_status(&self.model_manifest, &self.model_root, None);
        json!({
            "engine": {
                "state": sc.get("state").cloned().unwrap_or(Value::Null),
                // 报的是**安装版本**（我们接的是哪一版），与 `state` 无关 —— 引擎没起来时也得答得出来
                "version": engine_version().map(|v| json!(v)).unwrap_or(Value::Null),
                "port": sc.get("port").cloned().unwrap_or(Value::Null),
                // 🔴 `pid` 恒为 `null`，**不是没实现，是归属使然**：引擎② 由 Rust 的
                //    `ServiceManager` spawn，manga-service 是它的**兄弟进程**、拿不到它的 pid。
                //    编一个（报自己的 pid）那是谎；报 null 让 Box 用**自己**持有的进程表填。
                "pid": Value::Null,
            },
            "llm": {
                "state": snap.state,
                "model": sc.get("model").cloned().unwrap_or(Value::Null),
                "port": snap.port.map(|p| json!(p)).unwrap_or(Value::Null),
                // ③ 的归属方就是本进程（《04》§9.1），所以这个 pid 我们**真的有**。
                "pid": snap.pid.map(|p| json!(p)).unwrap_or(Value::Null),
            },
            "tier": sc.get("tier").cloned().unwrap_or(Value::Null),
            "accel": sc.get("accel").cloned().unwrap_or(Value::Null),
            "warmed": sc.get("warmed").cloned().unwrap_or(Value::Null),
            // 🔴 形状与 §5.2 的 JSON 示例**逐字一致**（camelCase）。发给引擎的那份是 snake_case
            //    —— 两个形状由 `engine_config_snapshot()` 一处派生。
            "config": engine_config_snapshot(),
            "models": models,
            // **D1**：运行时就绪检测（五项 + ready + requiredBytes）。与 `GET /engine/runtime`
            // 同一份 `runtime_view()` —— 于是"体检报告"里也能一眼看到"装配态"，不用再开第二个端点。
            "runtime": super::runtime_probe::runtime_view(),
            "recentStageLog": super::client::recent_stage_log(20),
            // 「重新下载模型」的**任务实况**（S6 新增第 9 键）。它与 `models`（几秒前的磁盘就绪态）
            // **不是一回事**：下载跑着的时候 `models.sakuraReady` 仍是 false。
            "modelDownload": self.model_download_view(),
        })
    }
}

/// 档位 → 权重文件名（`TIER_LLM_MODELS` 的查表）。未声明返回 `None`（**绝不回落成 tiny**）。
fn tier_model_name(tier: &str) -> Option<String> {
    super::TIER_LLM_MODELS
        .iter()
        .find(|(t, _)| *t == tier)
        .and_then(|(_, m)| m.map(str::to_string))
}

/// `clampTierToAvailable`：配置的档位若没有权重，往低走找第一个**有权重**的档。
fn clamp_tier_to_available(desired: &str) -> String {
    let avail = available_tiers();
    let idx = super::tier_downgrade::TIER_ORDER.iter().position(|t| *t == desired).unwrap_or(0) as i64;
    let mut i = idx;
    while i >= 0 {
        let t = super::tier_downgrade::TIER_ORDER[i as usize];
        if avail.iter().any(|a| a == t) {
            return t.to_string();
        }
        i -= 1;
    }
    avail.first().cloned().unwrap_or_else(|| "tiny".to_string())
}

/// 起**一轮**下载子进程，并把 tail / 进度 / 超时看护 / 终态落账四个线程接好。
///
/// ## 为什么是"轮"而不是"一次会话"
/// 交付口径是「先让引擎能起来，再在后台补翻译权重」。`--stage 1` 只下运行环境与视觉模型
/// （含 llama.cpp 与 CUDA 运行库，否则 ③ 起不来），`--stage 2` 才是 Sakura / nllb 那 6 GB。
/// 拆成两轮而不是一次全量：用户在第一轮结束就能开始翻译，而 6 GB 的等待发生在后台。
///
/// ## 为什么第 2 轮不带 `--engine-bootstrap`
/// 那个旗标会重跑 python 解包 / venv / 源码 / 补丁 / **依赖安装**（pip 不是幂等廉价的，
/// 每次都解析一轮）。第 1 轮已把这些做完，第 2 轮只需要下权重 ⇒ 只传 `--stage 2`。
///
/// ## 串联规则
/// `stage == Some(1)` 且退出码 0 ⇒ 自动接第 2 轮（`stage` 保持 `running`，不出现假的 `done`）；
/// 任一轮失败 ⇒ 按 `.part` 判可续性并落 `interrupted` / `error`，**不串下一轮**。
#[allow(clippy::too_many_arguments)]
fn spawn_download_round(
    runner: &Path,
    model_root: &Path,
    model_manifest: &Path,
    stage: Option<u8>,
    dl: &Arc<Mutex<ModelDownload>>,
    dp: &Arc<Mutex<DownloadProgressState>>,
    child_slot: &Arc<Mutex<Option<std::process::Child>>>,
    stop: &Arc<AtomicBool>,
) -> Result<(), StoreError> {
    // 终态线程要在第 1 轮成功后**递归起第 2 轮**，而 `spawn` 要求 `'static` ⇒
    // 那两个路径参数必须先拿到 owned 副本（借用会逃逸，E0521）。
    let runner_owned = runner.to_path_buf();
    let manifest_owned = model_manifest.to_path_buf();
    let mut cmd = std::process::Command::new(runner);
    cmd.arg("--fetch-models");
    // G4：零配置装配总入口（裁定④）—— 只第 1 轮带（见函数注释）。
    if stage == Some(1) {
        cmd.arg("--engine-bootstrap");
    }
    // 🔴 `--extract` 必须在：没有它 `bin/llama/llama-b11417/llama-server[.exe]` 永远不会出现。
    cmd.arg("--extract");
    if let Some(n) = stage {
        cmd.arg("--stage").arg(n.to_string());
    }
    cmd.arg("--root").arg(model_root);
    cmd.arg("--manifest").arg(model_manifest);
    // G5：结构化进度（百分比/速度/剩余/阶段）走这里，不靠解析 stdout 文本（违反"不编造进度"纪律）。
    let progress_log = paths::manga_state_dir().join("engine-download-progress.jsonl");
    cmd.arg("--progress-log").arg(&progress_log);
    cmd.env("MIAO_MODEL_ROOT", model_root);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // G4：这次会话里会起 `python -m venv` / `pip` / `tar` —— 全是控制台程序，
    // 而 mangasvc 自己无控制台 ⇒ 不隐藏会让"开始下载"连闪好几个黑框。
    hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| {
        StoreError::new("INTERNAL", format!("无法启动模型下载进程：{e}"), json!({ "runner": runner.to_string_lossy() }))
    })?;

    {
        let mut d = match dl.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        d.state = "running".to_string();
        if stage != Some(2) {
            // 第 1 轮（或未分阶段的旧调用）才算"这一次下载"的起点；
            // 第 2 轮是同一场下载的延续，`started_at` 必须保持第一次的时间。
            d.started_at = Some(model::now_iso_ms());
        }
        d.finished_at = None;
        d.exit_code = None;
        d.timed_out = false;
        d.tail = Vec::new();
        // G5：重置进度快照（不显示上次的残留数字）。
        d.percent = None;
        d.received_bytes = None;
        d.total_bytes = None;
        d.speed_bps = None;
        d.eta_ms = None;
        d.stage = None;
        d.current_id = None;
        d.paused_by_user = false;
        d.interrupted_reason = None;
        // 🔴 `can_resume` 不在这里置 false：视图时现算 `can_resume_now()`，
        //    即使刚点「继续」、`.part` 还在，也应如实显示可续。
        d.persist();
    }
    println!(
        "[manga-service] 模型下载已启动：{} --fetch-models{} → {}",
        runner.display(),
        stage.map(|n| format!(" --stage {n}")).unwrap_or_default(),
        model_root.display()
    );

    // 新一轮先把闸打开：上一轮暂停时合上的闸不能留着，否则新下载一行日志都不出。
    stop.store(false, Ordering::Relaxed);
    if let Some(out) = child.stdout.take() {
        spawn_tail_reader(out, dl.clone(), stop.clone());
    }
    if let Some(err) = child.stderr.take() {
        spawn_tail_reader(err, dl.clone(), stop.clone());
    }
    // G5：进度解析线程（独立线程，与 `spawn_tail_reader` 同一范式）：增量聚合 `.part` 进度
    //    JSONL → `ModelDownload` 的 `percent` / `received_bytes` / `total_bytes` / `speed_bps` / `eta_ms`。
    //    HTTP 侧只读聚合后的结构体，不阻塞；每条事件 O(1) 更新。
    spawn_progress_reader(progress_log, dl.clone(), dp.clone(), stop.clone());

    // 超时看护：到点**真杀**（只改状态不杀的话进程会一直在后台写盘，下次点重下就会和它撞）。
    // 🔴 杀与等待**分工**：本线程只 `kill()`（`&mut self`，不需要等它退出）；终态由下面的
    //    `try_wait` 轮询线程统一落账 —— 两边都去 `wait()` 会有一方拿不到子进程句柄，
    //    于是状态永远停在 `running`（D4/D6 会红）。
    let child_slot_kill = child_slot.clone();
    let dl_kill = dl.clone();
    let model_root_kill = model_root.to_path_buf();
    let runtime_root = paths::runtimes_dir();
    let runtime_root_kill = runtime_root.clone();
    let timeout_ms = MODEL_DOWNLOAD_TIMEOUT_MS;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(timeout_ms as u64));
        let still_running = {
            let d = match dl_kill.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            d.state == "running"
        };
        if !still_running {
            return;
        }
        {
            let mut slot = child_slot_kill.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(c) = slot.as_mut() {
                let _ = c.kill();
            }
        }
        let mut d = match dl_kill.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        d.timed_out = true;
        d.tail.push(format!("✗ 下载超时（{} min），已终止", timeout_ms / 60_000));
        // 超时 ⇒ 可续传的中断（盘上有 `.part`）。
        let resumable = has_part_files(&model_root_kill) || has_part_files(&runtime_root_kill);
        if resumable {
            d.state = "interrupted".to_string();
            d.interrupted_reason = Some("下载超时（超过 1 小时）；可继续下载补齐已下部分".to_string());
        } else {
            d.state = "error".to_string();
        }
        d.persist();
    });

    *child_slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);

    // 终态轮询线程：`try_wait()` 不阻塞，故超时看护随时能拿到锁去 `kill()`。
    let child_slot_wait = child_slot.clone();
    // 第 2 轮要重开闸（新一轮会把 stop 置回 false），故这里把同一个 Arc 传进去。
    let stop_wait = stop.clone();
    let dl_wait = dl.clone();
    let dp_wait = dp.clone();
    let model_root_wait = model_root.to_path_buf();
    let runtime_root_wait = runtime_root.clone();
    std::thread::spawn(move || loop {
        let done: Option<i64> = {
            let mut slot = child_slot_wait.lock().unwrap_or_else(|p| p.into_inner());
            match slot.as_mut() {
                Some(c) => match c.try_wait() {
                    Ok(Some(status)) => {
                        let code = status.code().map(|n| n as i64).unwrap_or(-1);
                        slot.take();
                        Some(code)
                    }
                    Ok(None) => None,
                    Err(_) => {
                        slot.take();
                        Some(-1)
                    }
                },
                None => None,
            }
        };
        match done {
            Some(code) => {
                let mut d = match dl_wait.lock() {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
                if d.state == "running" {
                    d.exit_code = Some(code);
                    if code == 0 && !d.timed_out {
                        if stage == Some(1) {
                            // 第 1 轮成功 ⇒ **直接接第 2 轮**，不落 `done`。
                            // （落一次 `done` 再改回 `running` 会让界面闪一下"已完成"，
                            //  而那 6 GB 其实还没动。）
                            d.finished_at = None;
                            d.persist();
                            drop(d);
                            println!("[manga-service] 第 1 阶段就绪，继续下载翻译权重");
                            match spawn_download_round(
                                &runner_owned,
                                &model_root_wait,
                                &manifest_owned,
                                Some(2),
                                &dl_wait,
                                &dp_wait,
                                &child_slot_wait,
                                &stop_wait,
                            ) {
                                Ok(()) => return,
                                Err(e) => {
                                    let mut d2 = match dl_wait.lock() {
                                        Ok(g) => g,
                                        Err(p) => p.into_inner(),
                                    };
                                    d2.state = "error".to_string();
                                    d2.interrupted_reason = Some(e.message);
                                    d2.persist();
                                    return;
                                }
                            }
                        }
                        d.state = "done".to_string();
                        d.finished_at = Some(model::now_iso_ms());
                    } else {
                        d.finished_at = Some(model::now_iso_ms());
                        // 非零退出：有 `.part` 即视为可续传的中断（断网 / 磁盘满 / 被强关）；
                        // 否则是不可续传的失败（只能从头重下）。
                        let resumable =
                            has_part_files(&model_root_wait) || has_part_files(&runtime_root_wait);
                        // 用户主动暂停：即使盘上还没有 `.part`（刚开下就暂停）也算"可续的中断"，
                        // 否则界面会把「继续下载」变成「重新下载」。
                        if resumable || d.paused_by_user {
                            d.state = "interrupted".to_string();
                            if d.interrupted_reason.is_none() {
                                d.interrupted_reason = Some(
                                    "下载中断；已完成的部分不会丢失，可继续下载补齐".to_string(),
                                );
                            }
                        } else {
                            d.state = "error".to_string();
                        }
                    }
                    println!(
                        "[manga-service] 模型下载结束：state={} exitCode={}{}",
                        d.state,
                        code,
                        if d.timed_out { "（超时被杀）" } else { "" }
                    );
                    d.persist();
                }
                return;
            }
            None => std::thread::sleep(std::time::Duration::from_millis(150)),
        }
    });

    Ok(())
}

/// `Math.round(ms / 60_000)`。
fn round_div(v: i64, d: i64) -> i64 {
    ((v as f64) / (d as f64)).round() as i64
}

/// `path.resolve(config.engineDir, '..')` —— 未配置模型目录时会落到哪（给"恢复默认"用）。
fn default_model_dir() -> PathBuf {
    let d = paths::engine_dir();
    d.parent().map(PathBuf::from).unwrap_or(d)
}

/// `ModelDownload` 的持久化（G5：中断态需跨进程重启存活）。
impl ModelDownload {
    /// 写 `state/engine-download.json`。失败静默（磁盘不可写不应让主流程崩）。
    ///
    /// 🔴 **必须原子写**（先写 `.tmp` 再 `rename` 覆盖），这是 D-231⑤ 那次"下载中弹回引导页"的
    ///    根因修复：`fs::write` 是"截断后逐段写"，而 `persist()` 在**每个进度事件**上都调 ⇒
    ///    前端 1.5 s 轮询有很高概率读到**半截/空**文件 ⇒ `load_persisted()` 的
    ///    `from_str().unwrap_or_else(default)` 把它整个吞掉 ⇒ `state` 回落 `idle` ⇒
    ///    `isDownloadActive` 为假 ⇒ 下载视图被卸载、用户被弹回引导页。
    ///    `rename` 在同目录同卷上是原子的，读者要么看到旧文件要么看到新文件，看不到中间态。
    fn persist(&self) {
        let p = paths::manga_state_dir().join("engine-download.json");
        let Ok(s) = serde_json::to_string(self) else {
            return;
        };
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, &s).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return;
        }
        // 🔴 `rename` 覆盖已有目标：Windows 上 `std::fs::rename` 走 `MoveFileEx` +
        //    `MOVEFILE_REPLACE_EXISTING`，不需要先删旧文件（先删反而会开一个"文件不存在"的窗口）。
        if std::fs::rename(&tmp, &p).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }

    /// 从 `state/engine-download.json` 读回；读不到 / 解析失败 ⇒ 默认态（`idle`）。
    ///
    /// 🔴 重启对账：上次退出时落盘的 `running` 已经没有对应子进程（父进程被回收），
    ///    原样读回会让 `start_model_download` 的 409 单飞守卫把「继续下载」也挡掉。
    ///    这里只把 `running` 校正为 `interrupted`，`done / interrupted / idle` 一律不动。
    fn load_persisted() -> ModelDownload {
        let p = paths::manga_state_dir().join("engine-download.json");
        let d = match std::fs::read_to_string(&p) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| ModelDownload::default()),
            Err(_) => ModelDownload::default(),
        };
        let (d, changed) = normalize_loaded(d);
        if changed {
            d.persist();
        }
        d
    }
}

/// 四段装配的权重（合计 100）。
///
/// 权重是**产品判断**（哪一段更费时），只在这里写一份：前端按 `assemblyPercent` 显示，
/// 自己不重算 —— 两处各写一份权重，必然漂移成"环走到 70% 却说还在装依赖"。
const STEP_WEIGHTS: [(&str, f64); 4] = [
    ("prepare", 10.0),
    ("runtime", 35.0),
    ("visual", 25.0),
    ("llm", 30.0),
];

/// 整体装配百分比（段加权）。
///
/// - `prepare` / `runtime`：这段没有字节账（venv / **pip 装依赖** / 打补丁），
///   停在**段首**；界面配一圈旋转弧表示"在跑但不可测"，绝不拿上一段的数字冒充本段。
///   （2026-10-18 用户反馈：pip 全命中 `Using cached` ⇒ 环停在 0% 好几分钟，看着像卡死。）
/// - `visual` / `llm`：这两段共用同一份字节账 ⇒ 合成一个区间 `[45, 100]`，
///   段切换时数字**不跳**（各自映射会让 45→70 之间凭空跳一下）。
fn assembly_percent(step: Option<&str>, byte_percent: Option<f64>) -> Option<f64> {
    let step = step?;
    let idx = STEP_WEIGHTS.iter().position(|(name, _)| *name == step)?;
    let before: f64 = STEP_WEIGHTS[..idx].iter().map(|(_, weight)| *weight).sum();
    if !matches!(step, "visual" | "llm") {
        return Some(before);
    }
    let bytes_start: f64 = STEP_WEIGHTS[..2].iter().map(|(_, weight)| *weight).sum();
    let pct = byte_percent?;
    Some((bytes_start + (100.0 - bytes_start) * (pct / 100.0)).min(100.0))
}

/// 进程重启后的下载态对账：`running` 已无子进程 ⇒ 如实报 `interrupted`。
///
/// 返回 `(校正后的状态, 是否发生变化)`；变化时调用方负责原子落盘。
fn normalize_loaded(mut d: ModelDownload) -> (ModelDownload, bool) {
    if d.state != "running" {
        return (d, false);
    }
    d.state = "interrupted".to_string();
    d.interrupted_reason = Some("应用已退出，下载已暂停".to_string());
    // 速度与剩余时间是上一轮进程的瞬时值，重启后继续显示等于编造。
    d.speed_bps = None;
    d.eta_ms = None;
    (d, true)
}

impl DownloadProgressState {
    /// 推入样本窗并算瞬时速度 / 剩余时间。
    ///
    /// 采样窗保留最近 ~15s 的样本；速度是「窗首尾的字节差 / 时间差」—— 自然抗抖，
    /// 不会因单条事件的一次跳变就把速度刷成天文数字。
    fn recompute(&mut self, now_ms: i64, received: u64, total: u64) -> (Option<f64>, Option<i64>) {
        self.samples.push((now_ms, received));
        while self.samples.len() > 2 && (now_ms - self.samples[0].0) > 15000 {
            self.samples.remove(0);
        }
        if self.samples.len() < 2 {
            return (None, None);
        }
        let (t0, b0) = self.samples[0];
        let (t1, b1) = *self.samples.last().unwrap();
        // 🔴 `received` 会**变小**：某条目重试 / 换源会把它的已收字节清零，而它是聚合和的一项。
        //    直接 `b1 - b0` 在 u64 上会**下溢**成 ~1.8e19，除以几秒 ⇒ 界面出现过
        //    `1129627 TB/s`（2026-10-18 用户实测）。下溢还是一次性的：样本窗里那一对
        //    会一直参与计算，速度要等 15s 后滑出窗口才恢复正常。
        //    处理：发现回退就当"新的一轮"——清空样本窗，这一拍不报速度。
        if b1 < b0 {
            self.samples.clear();
            self.samples.push((now_ms, b1));
            return (None, None);
        }
        let dt = (t1 - t0) as f64 / 1000.0;
        if dt <= 0.0 {
            return (None, None);
        }
        let speed = (b1 - b0) as f64 / dt;
        if speed <= 0.0 {
            return (None, None);
        }
        // 物理上限兜底：某条目"总量后到"时会一次性把它已收的字节并进聚合和，速度会瞬间跳一下。
        // 超过 100 GB/s 一律不报 —— 宁可空着，也不显示 `1129627 TB/s` 这种数字。
        const MAX_PLAUSIBLE_BPS: f64 = 100.0 * 1024.0 * 1024.0 * 1024.0;
        if !speed.is_finite() || speed > MAX_PLAUSIBLE_BPS {
            return (None, None);
        }
        if total == 0 {
            return (Some(speed), None);
        }
        let remain = total.saturating_sub(received) as f64;
        let eta = (remain / speed) * 1000.0;
        (Some(speed), Some(eta as i64))
    }
}

/// 读清单，失败返回 `None`（**不炸**）。
///
/// 🔴 为什么不当错误返回：调用方是「重新下载前的清理」，清单读不到时
///    归档 / 解包那两个阶段自己会报「清单读不到」并带绝对路径。
///    在这里也报一次，只会把两条一样的信息叠在一起，用户反而看不出该看哪条。
fn load_manifest_quietly(p: &Path) -> Option<super::model_store::Manifest> {
    let text = std::fs::read_to_string(p).ok()?;
    serde_json::from_str::<super::model_store::Manifest>(&text).ok()
}

/// 清单里所有**适用于当前平台**且带 `extractTo` 的条目的解包目标目录（绝对路径）。
///
/// 只收"当前平台"：把别的平台的 `extractTo` 也算进来会去删一个本机从来不创建的目录
/// （无害但莫名），且在多平台共库根时可能误删别人那份。
fn extract_targets(manifest: &super::model_store::Manifest, root: &Path) -> Vec<PathBuf> {
    let key = super::model_store::platform_key();
    manifest
        .files
        .iter()
        .filter(|f| f.extract_to.is_some() && super::model_store::matches_platform(f, &key))
        .map(|f| root.join(f.extract_to.as_deref().unwrap_or_default()))
        .collect()
}

/// 删目录，失败**不炸**（留着让 tar 去报，或者下一次 fresh 再试）。
///
/// 🔴 为什么不当致命错误：删不掉往往是"文件正被占用"——而占用它的常常就是
///    我们自己的引擎 / ③（它们刚被停掉，句柄还没松）。此刻失败并终止，
///    用户拿到的是"重新下载失败"，比"接着解包、让 tar 报具体哪个文件"更难动手。
fn remove_dir_quietly(dir: &Path) {
    if !dir.exists() {
        return;
    }
    if let Err(e) = std::fs::remove_dir_all(dir) {
        println!(
            "[manga-service] 重新下载：清理解包目标失败（将接着解包）：{}：{e}",
            dir.display()
        );
    }
}

/// 扫描 `root` 及其**一级子目录**：发现 `.part` 续传断点 ⇒ 返回 true（不清除）。
///
/// 🔴 **不做全树递归**：这个函数在每次 `/engine/status` 都被调用（`canResume` 字段），
///    而模型根 + 运行时根是 15 GB 级、上万文件的树 —— 全树走一遍在冷缓存下实测 **94 秒**，
///    用户打开下载页要等一分半。`.part` 只会落在归档落点与模型落点（清单 `dest` 最多一层），
///    所以扫两层就够；判据仍是"文件名以 `.part` 结尾"，没有放宽。
fn has_part_files(root: &Path) -> bool {
    walk_parts(root, 0, MAX_PART_DEPTH, false)
}

/// `.part` 可能出现的最大目录深度（0 = 只扫 `root` 本身）。
///
/// 依据：模型清单的 `dest` 形如 `visual/detector.safetensors`（一层），
/// 归档缓存在 `.download-cache/`（一层）。留一层余量 ⇒ 2。
const MAX_PART_DEPTH: u32 = 2;

/// 扫描 `root` 及其一级子目录：发现 `.part` 即删除（「重新下载」清断点）。
fn clear_part_files(root: &Path) {
    walk_parts(root, 0, MAX_PART_DEPTH, true);
}

fn walk_parts(root: &Path, depth: u32, max_depth: u32, clear: bool) -> bool {
    let mut found = false;
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return found,
    };
    for ent in entries.flatten() {
        let p = ent.path();
        let is_dir = match p.metadata() {
            Ok(m) => m.is_dir(),
            Err(_) => false,
        };
        if is_dir {
            // 超过深度就不再往下钻（`.part` 不会在更深的层级出现，见 MAX_PART_DEPTH）
            if depth < max_depth && walk_parts(&p, depth + 1, max_depth, clear) {
                found = true;
                if !clear {
                    return true;
                }
            }
        } else if p
            .file_name()
            .map(|n| n.to_string_lossy().ends_with(".part"))
            .unwrap_or(false)
        {
            if clear {
                let _ = std::fs::remove_file(&p);
            } else {
                return true;
            }
        }
    }
    found
}

/// 进度解析线程（G5）：增量读 `--progress-log` JSONL，聚合进 `ModelDownload`。
///
/// 与 `spawn_tail_reader` 同一范式：独立线程，只写聚合后的结构体，不阻塞下载侧。
/// 文件被 truncate 重写（新一轮下载 / fresh 重下）时 `offset` 自动归零，从新内容起读。
///
/// 🔴 **同样受 `stop` 闸约束**：子进程被杀后 JSONL 停止增长，本线程会因
///    \`len == offset\` 自然空转 —— 但"暂停后读到残留事件"仍会把
///    \`pause_download()\` 刚清掉的 \`current_id\` / \`speed_bps\` 写回去（第 1514/1516 行
///    是无条件覆写）。所以这里跟 tail reader 一样，合闸即退。
fn spawn_progress_reader(
    path: PathBuf,
    dl: Arc<Mutex<ModelDownload>>,
    dp: Arc<Mutex<DownloadProgressState>>,
    stop: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        use std::io::{Read, Seek, SeekFrom};
        let mut offset: u64 = 0;
        loop {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
            let len = match std::fs::metadata(&path) {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            if len < offset {
                offset = 0; // 被 truncate 重写（新一轮下载）
            }
            if len == offset {
                continue;
            }
            let mut f = match std::fs::File::open(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            if f.seek(SeekFrom::Start(offset)).is_err() {
                continue;
            }
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_err() {
                continue;
            }
            offset = len;
            let text = String::from_utf8_lossy(&buf);
            let now = model::now_ms();
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let e: ProgressEvent = match serde_json::from_str(line) {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let (received, total, _opt) = {
                    let mut p = dp.lock().unwrap_or_else(|p| p.into_inner());
                    p.ingest(&e, now)
                };
                let mut d = dl.lock().unwrap_or_else(|p| p.into_inner());
                if e.phase == "stage" {
                    // 阶段标记事件：更新当前阶段与「当前进度」文本（不碰字节账）。
                    //
                    // 🔴 两张表**刻意不是同一张**（D-231④）：
                    //   · `stage` 是下载详情页那个**两步**指示器的数据源，`STAGE_TEXT` 只有两格。
                    //     `prepare` 必须**归到 stage1** —— 落到下面的兜底分支就会变成
                    //     `"prepare"`，`STAGE_TEXT['prepare']` 是 `undefined` ⇒ 指示器整块消失。
                    //   · `step` 是未就绪屏**五段**时间线的数据源，值域是闭集
                    //     （prepare / runtime / visual / llm，外加全量 CLI 的兼容值 models）；
                    //     **未知阶段名不猜**，保持上一段，否则界面会拿到一个它不认识的段号。
                    d.step = match e.id.as_str() {
                        "prepare" => Some("prepare".to_string()),
                        "runtime" => Some("runtime".to_string()),
                        "visual" => Some("visual".to_string()),
                        "llm" => Some("llm".to_string()),
                        "models" => Some("models".to_string()),
                        _ => d.step.take(),
                    };
                    // `visual` 属第 1 轮（视觉模型与 llama.cpp 同轮），不能错标成 stage2；
                    // `llm` 才是第 2 轮（Sakura + nllb）。
                    d.stage = match e.id.as_str() {
                        "prepare" | "runtime" | "visual" => Some("stage1".to_string()),
                        "llm" | "models" => Some("stage2".to_string()),
                        other => Some(other.to_string()),
                    };
                    // 无字节阶段（建 venv / 打补丁 / pip 装依赖…）也要告诉界面「现在在做什么」：
                    // 否则「当前进度」行会一直停在上一份文件（实测停在 engine_source），
                    // 配上静止环就坐实了「卡住了」的误判。
                    d.current_id = e.msg.clone().filter(|m| !m.is_empty()).or(Some(e.id.clone()));
                } else {
                    d.current_id = Some(e.id.clone());
                    let (speed, eta) = {
                        let mut p = dp.lock().unwrap_or_else(|p| p.into_inner());
                        p.recompute(now, received, total)
                    };
                    d.received_bytes = Some(received);
                    d.total_bytes = if total > 0 { Some(total) } else { None };
                    // 🔴 夹到 100：续传 / 换源重下会让单条目的 received 短暂超过 total
                    d.percent = if total > 0 {
                        Some(((received as f64 / total as f64) * 100.0).min(100.0))
                    } else {
                        None
                    };
                    d.speed_bps = speed;
                    d.eta_ms = eta;
                }
            }
        }
    });
}

/// 下载子进程输出 → 环形 tail（按行拆；`\r` 覆盖式进度也算分隔符）。
///
/// 🔴 **暂停后必须停止读**：`pause_download()` 调 `child.kill()` 只会让**后续**输出消失，
///    管道里**已缓冲**的数据仍然可读 —— 不设闸这个线程会把缓冲全读完并 push 进内存 tail，
///    而暂停后那些 push **不落盘**（`persist()` 只在状态跃迁时调）。
///    真机症状：界面日志"暂停了还在刷"（读的是内存 tail），
///    而盘上 `engine-download.json` 的 mtime 与长度都不变（2026-10-25 实测）。
///    所以这里每轮读之前先看闸：闸一合就退，把剩下的缓冲留给下一次下载重头写。
fn spawn_tail_reader<R: std::io::Read + Send + 'static>(
    mut r: R,
    dl: Arc<Mutex<ModelDownload>>,
    stop: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut carry = String::new();
        loop {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            let n = match r.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            carry.push_str(&String::from_utf8_lossy(&buf[..n]));
            let mut lines: Vec<String> = Vec::new();
            let mut rest = carry.as_str();
            loop {
                let cut = rest.char_indices().find(|(_, c)| *c == '\n' || *c == '\r').map(|(i, c)| (i, c.len_utf8()));
                match cut {
                    Some((i, w)) => {
                        lines.push(rest[..i].to_string());
                        // `\r\n` 两字节一起吃掉
                        if w == 1 && rest.as_bytes().get(i) == Some(&b'\r') && rest.as_bytes().get(i + 1) == Some(&b'\n') {
                            rest = &rest[i + 2..];
                        } else {
                            rest = &rest[i + w..];
                        }
                    }
                    None => break,
                }
            }
            carry = rest.to_string();
            if lines.is_empty() {
                continue;
            }
            let mut d = match dl.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            for line in lines {
                let t = line.trim();
                if t.is_empty() {
                    continue;
                }
                d.tail.push(t.to_string());
                if d.tail.len() > MODEL_DOWNLOAD_TAIL_MAX {
                    d.tail.remove(0);
                }
            }
        }
    });
}

/// 建单前置门（`assertSidecarReady`）。`models` 由调用方注入（`real` 协议下才做模型诊断）。
pub fn assert_ready_via(
    sc: &Value,
    models: Option<&super::model_status::ModelStatus>,
    not_ready_as_unavailable: bool,
) -> Result<(), StoreError> {
    let state = sc.get("state").and_then(|v| v.as_str()).unwrap_or("stopped");
    if AVAILABLE_STATES.contains(&state) {
        return Ok(());
    }
    let port = sc.get("port").cloned().unwrap_or(Value::Null);
    if PREPARING_STATES.contains(&state) && !not_ready_as_unavailable {
        return Err(StoreError::new(
            "ENGINE_NOT_READY",
            format!("翻译引擎正在准备（state={state}），请稍候 —— 任务未创建，无需重试"),
            json!({ "sidecar": { "state": state, "port": port } }),
        ));
    }
    if let Some(m) = models {
        if !m.visual_ready || !m.sakura_ready {
            return Err(StoreError::new(
                "MODEL_DOWNLOAD_FAILED",
                format!(
                    "翻译模型不完整（视觉就绪={} / Sakura 就绪={}）——请重新下载模型",
                    m.visual_ready, m.sakura_ready
                ),
                json!({ "models": m, "sidecar": { "state": state } }),
            ));
        }
    }
    Err(StoreError::new(
        "UNAVAILABLE",
        format!("翻译引擎（sidecar）不可用：state={state}"),
        json!({ "sidecar": { "state": state, "port": port } }),
    ))
}

/// 当前翻译来源（`local` / `online`）—— 见 `translate::current_source()`。
pub fn translate_source() -> String {
    translate::current_source()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_loaded_turns_running_into_interrupted() {
        let mut d = ModelDownload::default();
        d.state = "running".to_string();
        d.started_at = Some("2026-10-17T00:00:00Z".to_string());
        d.speed_bps = Some(1024.0);
        d.eta_ms = Some(5000);

        let (d, changed) = normalize_loaded(d);
        assert!(changed, "running 必须被校正，否则续传会被 409 挡住");
        assert_eq!(d.state, "interrupted");
        assert_eq!(d.interrupted_reason.as_deref(), Some("应用已退出，下载已暂停"));
        assert_eq!(d.started_at.as_deref(), Some("2026-10-17T00:00:00Z"), "续传键不能丢");
        assert!(d.speed_bps.is_none() && d.eta_ms.is_none(), "上一轮的瞬时值不能留");
    }

    #[test]
    fn normalize_loaded_keeps_terminal_states() {
        for state in ["idle", "interrupted", "done", "failed"] {
            let mut d = ModelDownload::default();
            d.state = state.to_string();
            let (d, changed) = normalize_loaded(d);
            assert!(!changed, "{state} 不得被改写");
            assert_eq!(d.state, state);
        }
    }

    /// 段加权：非字节段停在段首，字节段映射到 `[45, 100]`。
    #[test]
    fn assembly_percent_weights_the_four_steps() {
        assert_eq!(assembly_percent(Some("prepare"), None), Some(0.0));
        assert_eq!(assembly_percent(Some("runtime"), Some(0.0)), Some(10.0));
        assert_eq!(assembly_percent(Some("visual"), Some(0.0)), Some(45.0));
        assert_eq!(assembly_percent(Some("visual"), Some(50.0)), Some(72.5));
        assert_eq!(assembly_percent(Some("llm"), Some(100.0)), Some(100.0));
        // 字节段没有字节账 ⇒ 不给数（界面走"准备中"），绝不用上一段的数字顶上
        assert_eq!(assembly_percent(Some("llm"), None), None);
        // 没有阶段事件 / 兼容值（`models`）不参与加权
        assert_eq!(assembly_percent(None, Some(50.0)), None);
        assert_eq!(assembly_percent(Some("models"), Some(50.0)), None);
    }

    /// 整体进度**单调不回退** —— 这正是"停在 0% 好几分钟"要消灭的形态
    #[test]
    fn assembly_percent_never_goes_backwards() {
        let seq = [
            assembly_percent(Some("prepare"), None).unwrap(),
            assembly_percent(Some("runtime"), None).unwrap(),
            assembly_percent(Some("visual"), Some(0.0)).unwrap(),
            assembly_percent(Some("visual"), Some(30.0)).unwrap(),
            assembly_percent(Some("llm"), Some(60.0)).unwrap(),
            assembly_percent(Some("llm"), Some(100.0)).unwrap(),
        ];
        assert!(seq.windows(2).all(|w| w[0] <= w[1]), "整体进度不许回退：{seq:?}");
        assert_eq!(seq[0], 0.0);
        assert_eq!(*seq.last().unwrap(), 100.0);
    }

    /// 聚合和回退（某条目重试把它已收字节清零）时**不许报速度** ——
    /// u64 下溢会让界面出现 `1129627 TB/s`（2026-10-18 用户实测）。
    #[test]
    fn speed_is_none_when_bytes_go_backwards() {
        let mut p = DownloadProgressState::new();
        p.samples.push((0, 10_000));
        let (speed, eta) = p.recompute(1_000, 5_000, 0);
        assert!(speed.is_none(), "回退时不许报速度：{speed:?}");
        assert!(eta.is_none());
    }

    /// 荒谬速度一律不报（上限兜底），免得 ETA 也算成天文数字
    #[test]
    fn speed_is_capped_at_a_plausible_rate() {
        let mut p = DownloadProgressState::new();
        p.samples.push((0, 0));
        let (speed, _) = p.recompute(1, 10_000_000_000, 0); // 10 GB / 1 ms
        assert!(speed.is_none(), "超过 100 GB/s 不报：{speed:?}");
    }
}
