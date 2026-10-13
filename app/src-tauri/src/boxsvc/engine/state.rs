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
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::boxsvc::store::{StoreError, model};
use crate::boxsvc::translate;
use crate::paths;

use super::supervisor::LlmSnapshot;
use super::{engine_config_snapshot, engine_version, available_tiers, profile, settings as esettings};
use super::model_status::model_status;
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

// A3d：模型下载 / 校验的**执行体**是 `boxsvc --fetch-models`，不再是
// `node engine/scripts/fetch-models.mjs`（A3「node 随包」作废 ⇒ 产品运行期不许依赖解释器）。
// 默认取**自己**（服务本体就是 boxsvc），`MIAO_MODEL_DOWNLOAD_RUNNER` 是给 e2e 注入
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
}

// ================================================================ 模型下载状态机

/// 「重新下载模型」的任务实况（`/engine/status` 的第 9 键）。
#[derive(Debug, Clone)]
pub struct ModelDownload {
    pub state: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub exit_code: Option<i64>,
    pub timed_out: bool,
    pub tail: Vec<String>,
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
        }
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
    /// 模型下载 / 校验的**执行体**（A3d 起 = `boxsvc`；`--fetch-models` 子命令）。
    pub download_runner: PathBuf,

    // ---- 反证 ----
    pub refutes: Refutes,
    pub contract_refutes: ContractRefutes,

    // ---- 可变状态 ----
    pub download: Arc<Mutex<ModelDownload>>,
    download_child: Arc<Mutex<Option<std::process::Child>>>,
    /// 档位降档控制器（《04》§8）—— 进程级单例 ⇒ 天然是"服务级"作用域。
    pub tier_ctl: Arc<TierDowngrade>,
}

impl EngineState {
    /// 从环境变量装配。与 Node `config.mjs` 一样：**取值非法直接失败**（不静默回退）。
    pub fn from_env() -> Result<Self, String> {
        let protocol = super::engine_protocol();
        let settings_file = paths::state_dir().join("engine-settings.json");

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
        };

        // 「盘上的用户设置」⊕「环境变量」—— 唯一一处合并实现（与 `config.mjs` 同口径）。
        let read = esettings::read_engine_settings(&settings_file);
        if read.corrupt {
            eprintln!(
                "[box-service] ⚠ 引擎设置文件损坏，已退回默认值（文件原地保留）：{} —— {}",
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
            None => std::env::current_exe().unwrap_or_else(|_| PathBuf::from("boxsvc")),
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
            download: Arc::new(Mutex::new(ModelDownload::default())),
            download_child: Arc::new(Mutex::new(None)),
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
            // 执行体（A3d 起是 `boxsvc`，不再是那个 .mjs 脚本）在不在盘上。
            // 界面据此**禁用按钮**（而不是让用户点一下换一条报错）。
            "runner": self.download_runner.to_string_lossy(),
            "runnerExists": self.download_runner.exists(),
        })
    }

    /// 启动「重新下载模型」。**立即返回** —— 下载要十几分钟，HTTP 挂不住。
    pub fn start_model_download(&self) -> Result<Value, StoreError> {
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

        let mut cmd = std::process::Command::new(&self.download_runner);
        cmd.arg("--fetch-models");
        cmd.arg("--root").arg(&self.model_root);
        cmd.arg("--manifest").arg(&self.model_manifest);
        cmd.env("MIAO_MODEL_ROOT", &self.model_root);
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| {
            StoreError::new("INTERNAL", format!("无法启动模型下载进程：{e}"), json!({ "runner": self.download_runner.to_string_lossy() }))
        })?;

        {
            let mut d = self.lock_download();
            d.state = "running".to_string();
            d.started_at = Some(model::now_iso_ms());
            d.finished_at = None;
            d.exit_code = None;
            d.timed_out = false;
            d.tail = Vec::new();
        }
        println!(
            "[box-service] 模型下载已启动：{} --fetch-models → {}",
            self.download_runner.display(),
            self.model_root.display()
        );

        let dl = self.download.clone();
        if let Some(out) = child.stdout.take() {
            spawn_tail_reader(out, dl.clone());
        }
        if let Some(err) = child.stderr.take() {
            spawn_tail_reader(err, dl.clone());
        }

        // 超时看护：到点**真杀**（只改状态不杀的话进程会一直在后台写盘，下次点重下就会和它撞）。
        // 🔴 杀与等待**分工**：本线程只 `kill()`（`&mut self`，不需要等它退出）；终态由下面的
        //    `try_wait` 轮询线程统一落账 —— 两边都去 `wait()` 会有一方拿不到子进程句柄，
        //    于是状态永远停在 `running`（D4/D6 会红）。
        let child_slot = self.download_child.clone();
        let dl2 = self.download.clone();
        let timeout_ms = MODEL_DOWNLOAD_TIMEOUT_MS;
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(timeout_ms as u64));
            let still_running = {
                let d = match dl2.lock() {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
                d.state == "running"
            };
            if !still_running {
                return;
            }
            {
                let mut slot = child_slot.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(c) = slot.as_mut() {
                    let _ = c.kill();
                }
            }
            let mut d = match dl2.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            d.timed_out = true;
            d.tail.push(format!("✗ 下载超时（{} min），已终止", timeout_ms / 60_000));
        });

        *self.download_child.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);

        // 终态轮询线程：`try_wait()` 不阻塞，故超时看护随时能拿到锁去 `kill()`。
        let child_slot2 = self.download_child.clone();
        let dl3 = self.download.clone();
        std::thread::spawn(move || loop {
            let done: Option<i64> = {
                let mut slot = child_slot2.lock().unwrap_or_else(|p| p.into_inner());
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
                    let mut d = match dl3.lock() {
                        Ok(g) => g,
                        Err(p) => p.into_inner(),
                    };
                    if d.state == "running" {
                        d.exit_code = Some(code);
                        d.finished_at = Some(model::now_iso_ms());
                        d.state = if code == 0 && !d.timed_out { "done".to_string() } else { "error".to_string() };
                        println!(
                            "[box-service] 模型下载结束：state={} exitCode={}{}",
                            d.state,
                            code,
                            if d.timed_out { "（超时被杀）" } else { "" }
                        );
                    }
                    return;
                }
                None => std::thread::sleep(std::time::Duration::from_millis(150)),
            }
        });

        Ok(self.model_download_view())
    }

    /// `POST /engine/models/verify` 要跑的**执行体**（A3d 起 = `boxsvc`）。
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
                //    `ServiceManager` spawn，box-service 是它的**兄弟进程**、拿不到它的 pid。
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

/// `Math.round(ms / 60_000)`。
fn round_div(v: i64, d: i64) -> i64 {
    ((v as f64) / (d as f64)).round() as i64
}

/// `path.resolve(config.engineDir, '..')` —— 未配置模型目录时会落到哪（给"恢复默认"用）。
fn default_model_dir() -> PathBuf {
    let d = paths::engine_dir();
    d.parent().map(PathBuf::from).unwrap_or(d)
}

/// 下载子进程输出 → 环形 tail（按行拆；`\r` 覆盖式进度也算分隔符）。
fn spawn_tail_reader<R: std::io::Read + Send + 'static>(mut r: R, dl: Arc<Mutex<ModelDownload>>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut carry = String::new();
        loop {
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
