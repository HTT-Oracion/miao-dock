// 档位降档重试 —— 《04》§8 的落地点（Rust 侧）
// =============================================================================
// 移植自 `service/src/settings/tier-downgrade.mjs`（128 行）。
//
// ## 原文规则（逐条落地，不"顺手优化"）
// | §8.1 触发 | `CUDA out of memory` / MPS OOM / 系统内存 OOM / 显存不足以加载权重 |
// | §8.1 次数 | **仅降一次** |
// | §8.2 作用域 | **服务级** —— 降档后**后续所有 item** 都用新档，**不逐图降** |
// | §8.2 叠加 | 与 item 级重试**不叠加**：一次 OOM 只走降档一次，**不再额外计 item 重试** |
// | §8.2 留痕 | 降档是内部行为，但需日志留痕（「引擎已从 7B 降至 1.5B」）+ 诊断视图记录 |
// | §8.2 底线 | **已是最低档仍 OOM ⇒ 任务 `failed`** |
// | §8.3 寿命 | 降档只在**本次运行期**有效；工程关闭后再启动**回到用户配置档位**（不记忆） |
//
// ## 为什么"仅降一次"写成一个**闩**而不是一个计数器
// 计数器（`if (count < 1) count++`）在并发下会漏；而本项目虽是串行队列，仍宁可写成幂等闩
//（`if used return null; used = true;`）—— 让"只降一次"成为**结构性质**，而不是"靠没人并发调用"。
use std::sync::Mutex;

use serde_json::{json, Value};

use super::EngineError;

/// 档位由低到高 —— 降档就是往左移一格。
pub const TIER_ORDER: &[&str] = &["tiny", "small", "medium"];

/// OOM 的识别签名（《04》§8.1 的四类触发，逐类给出可匹配的文本）。
///
/// 🔴 为什么用**多签名正则**而不是只判 `out of memory`：`llama.cpp` 显存不足时打的是
///    `failed to allocate` / `unable to allocate`，而 Python 侧的 `MemoryError` 连 "memory"
///    都不带 `out of`。只认一种写法会出现「真 OOM 了却没降档，任务白失败」——
///    而这恰恰是最难复盘的一类（现场已经过去了）。
/// ⚠️ 反面要求同样重要：**不能把普通失败误判成 OOM**（那会白白降一档，用户看到质量莫名下降）。
const OOM_PATTERNS: &[&str] = &[
    r"(?i)cuda out of memory",
    r"(?i)mps backend out of memory",
    r"(?i)\bout of memory\b",
    r"(?i)cannot allocate memory",
    r"(?i)unable to allocate.*(?:memory|buffer)",
    r"(?i)(?:not enough|insufficient) (?:memory|vram|gpu memory)",
    r"(?i)memoryerror",
    r"(?i)failed to allocate",
];

/// 把任意错误对象拉平成一个可搜的字符串（message + code，detail 可能是对象）。
pub fn flatten_error(e: &EngineError) -> String {
    let mut parts: Vec<String> = vec![e.message.clone(), e.code.clone()];
    if let Some(d) = &e.detail {
        parts.push(match d {
            Value::String(s) => s.clone(),
            other => serde_json::to_string(other).unwrap_or_default(),
        });
    }
    parts.into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" | ")
}

/// 这条错误是不是 OOM。`text` 可注入（断言里枚举全部签名与反例）。
pub fn matches_oom_text(text: &str) -> bool {
    OOM_PATTERNS
        .iter()
        .any(|p| regex::Regex::new(p).map(|re| re.is_match(text)).unwrap_or(false))
}

pub fn is_oom_error(e: &EngineError) -> bool {
    matches_oom_text(&flatten_error(e))
}

/// 下一档（往低走）。**已是最低档返回 `None`** —— 调用方据此走 §8.2 的底线：任务 failed。
/// 注意方向：降档是 **medium → small → tiny**，不是反过来。
pub fn next_lower_tier(tier: &str) -> Option<&'static str> {
    let i = TIER_ORDER.iter().position(|t| *t == tier)?;
    if i == 0 {
        return None; // 未知档位或已是最低档
    }
    Some(TIER_ORDER[i - 1])
}

/// `plan()` 的产出（纯判定，不改状态）。
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub downgrade: bool,
    pub reason: String,
    pub from: Option<String>,
    pub to: Option<String>,
}

/// `tryDowngrade()` 的产出。
#[derive(Debug, Clone, PartialEq)]
pub struct DowngradeResult {
    pub downgraded: bool,
    pub reason: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

struct Inner {
    current: String,
    used: bool,
    history: Vec<Value>,
    disabled: bool,
}

/// 档位控制器（§8.2 的"服务级"就体现在这里：**一个进程一份状态**，不是每个 item 一份）。
pub struct TierDowngrade {
    inner: Mutex<Inner>,
}

impl TierDowngrade {
    /// `disabled` = 反证开关 `MIAO_NO_TIER_DOWNGRADE`。
    pub fn new(tier: &str, disabled: bool) -> Self {
        TierDowngrade {
            inner: Mutex::new(Inner { current: tier.to_string(), used: false, history: Vec::new(), disabled }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    pub fn current_tier(&self) -> String {
        self.lock().current.clone()
    }

    pub fn is_downgraded(&self) -> bool {
        self.lock().used
    }

    pub fn history(&self) -> Vec<Value> {
        self.lock().history.clone()
    }

    /// 遇到一次疑似 OOM：要不要降档、降成什么。**纯判定（不改状态）**。
    pub fn plan(&self) -> Plan {
        let inner = self.lock();
        if inner.disabled {
            return Plan { downgrade: false, reason: "disabled".into(), from: None, to: None };
        }
        if inner.used {
            return Plan { downgrade: false, reason: "already-downgraded".into(), from: None, to: None };
        }
        match next_lower_tier(&inner.current) {
            None => Plan { downgrade: false, reason: "lowest-tier".into(), from: None, to: None },
            Some(next) => Plan {
                downgrade: true,
                reason: String::new(),
                from: Some(inner.current.clone()),
                to: Some(next.to_string()),
            },
        }
    }

    /// 执行降档。`apply` 是把新档位**真落到引擎**的注入点（默认实现见 `drain.rs`：
    /// `llm.switch_tier(t)`）。**幂等闩在 `plan()` 之后立即落下**，避免 apply 期间被第二次 OOM 重入。
    ///
    /// 🔴 留痕文案按 §8.2 的原话写「引擎已从 X 降至 Y」—— 验收脚本（与排障的人）都按这句 grep。
    pub fn try_downgrade<F>(&self, mut apply: F) -> DowngradeResult
    where
        F: FnMut(&str) -> Result<(), String>,
    {
        let p = self.plan();
        if !p.downgrade {
            println!("[box-service] 不降档：{}（当前 {}）", p.reason, self.current_tier());
            return DowngradeResult { downgraded: false, reason: Some(p.reason), from: None, to: None };
        }
        let from = p.from.clone().unwrap();
        let to = p.to.clone().unwrap();
        {
            let mut inner = self.lock();
            inner.used = true; // 闩：立刻落下，apply 抛错也不退还（§8「仅降一次」）
            inner.current = to.clone();
            inner.history.push(json!({ "from": from, "to": to, "at": crate::boxsvc::store::model::now_iso() }));
        }
        println!("[box-service] ⚠ 引擎 OOM ⇒ {}（《04》§8.2 —— 仅降一次 / 服务级 / 本次运行期有效，重启后回到用户配置）", downgrade_log_line(&from, &to));
        if let Err(msg) = apply(&to) {
            println!("[box-service] 降档落地失败：{msg}（档位已记为 {to}，任务将按失败处理）");
            return DowngradeResult {
                downgraded: false,
                reason: Some("apply-failed".into()),
                from: Some(from),
                to: Some(to),
            };
        }
        DowngradeResult { downgraded: true, reason: None, from: Some(from), to: Some(to) }
    }
}

/// 降档的留痕文案（§8.2 原话）。
///
/// 🔴 为什么抽成**纯函数**：`println!` 的输出断言抓不到，而"降档留痕"是 §8.2 明确要求的可观测行为
///    （排障的人按这句 grep）。抽出来才能既保留人读的措辞、又让断言钉得住它。
/// 文案里**同时**给档位名与权重文件名：档位名对上设置页，权重名对上 ③ 的实际命令行。
pub fn downgrade_log_line(from: &str, to: &str) -> String {
    format!(
        "引擎已从 {from} 降至 {to}（权重 {} → {}）",
        tier_label(from),
        tier_label(to)
    )
}

/// 档位 → 权重文件名（仅用于日志留痕）；未声明时回落档位名本身（同 Node `modelOf(t) || t`）。
fn tier_label(tier: &str) -> String {
    super::TIER_LLM_MODELS
        .iter()
        .find(|(t, _)| *t == tier)
        .and_then(|(_, m)| m.map(str::to_string))
        .unwrap_or_else(|| tier.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(code: &str, msg: &str) -> EngineError {
        EngineError::new(code, msg)
    }

    #[test]
    fn oom_signatures_hit_and_normal_failures_do_not() {
        assert!(is_oom_error(&err("E", "CUDA out of memory. Tried to allocate 2 GiB")));
        assert!(is_oom_error(&err("E", "MPS backend out of memory")));
        assert!(is_oom_error(&err("E", "failed to allocate buffer of size 1024")));
        assert!(is_oom_error(&err("E", "MemoryError")));
        assert!(is_oom_error(&err("E", "not enough VRAM")));
        // 反例：普通失败**不得**命中（否则会白白降一档）
        assert!(!is_oom_error(&err("ENGINE_TIMEOUT", "引擎未在 600s 内响应")));
        assert!(!is_oom_error(&err("ENGINE_ERROR", "injected_failure")));
        assert!(!is_oom_error(&err("E", "cannot open image file")));
    }

    #[test]
    fn detail_is_flattened() {
        let e = EngineError::with_detail("E", "boom", json!({ "why": "cuda out of memory" }));
        assert!(is_oom_error(&e));
    }

    #[test]
    fn downgrade_walks_down_only_once() {
        let d = TierDowngrade::new("medium", false);
        let mut calls = 0;
        let r = d.try_downgrade(|t| {
            calls += 1;
            assert_eq!(t, "small");
            Ok(())
        });
        assert!(r.downgraded);
        assert_eq!(calls, 1);
        assert_eq!(d.current_tier(), "small");
        let r2 = d.try_downgrade(|_| panic!("不应再降"));
        assert!(!r2.downgraded);
        assert_eq!(r2.reason.as_deref(), Some("already-downgraded"));
        assert_eq!(d.history().len(), 1);
    }

    #[test]
    fn lowest_tier_and_disabled_never_downgrade() {
        let d = TierDowngrade::new("tiny", false);
        assert_eq!(d.plan().reason, "lowest-tier");
        let off = TierDowngrade::new("medium", true);
        assert_eq!(off.plan().reason, "disabled");
        assert!(next_lower_tier("small") == Some("tiny"));
        assert!(next_lower_tier("nope").is_none());
    }

    // ---------------------------------------------------------------- 以下为「删 service/」时补的断言

    #[test]
    fn d1_next_lower_tier_walks_down_and_stops_at_the_bottom() {
        // 方向：往**低**走（medium → small → tiny），不是反过来。
        assert_eq!(next_lower_tier("medium"), Some("small"));
        assert_eq!(next_lower_tier("small"), Some("tiny"));
        // 最低档明确给 None，**不回绕**到最高档。
        assert_eq!(next_lower_tier("tiny"), None);
        assert_eq!(next_lower_tier("某个没听过的档"), None);
    }

    #[test]
    fn d2_d3_all_four_oom_classes_hit_and_normal_failures_do_not() {
        // §8.1 的四类触发在现实里被**不同的层**用**不同的文案**报出来；只认一种写法 ⇒ 真 OOM 了却没降档。
        let oom_samples = [
            "CUDA out of memory. Tried to allocate 1.20 GiB (GPU 0; 16.00 GiB total capacity)",
            "MPS backend out of memory (MPS allocated: 1.51 GiB, other allocations: 128.00 MiB)",
            "RuntimeError: Cannot allocate memory",
            "failed to allocate 6144.00 MB of memory for model weights",
            "llama.cpp: unable to allocate buffer of size 4096",
            "MemoryError",
        ];
        for t in oom_samples {
            assert!(is_oom_error(&err("E", t)), "漏识别：{t}");
        }
        // 反面同样重要：误判 ⇒ 白白降一档，用户看到质量莫名下降且无从追溯。
        let not_oom = [
            "connect ECONNREFUSED 127.0.0.1:5003",
            "引擎返回 500",
            "结果流里没有结果帧（code 0）",
            "request timeout after 30000ms",
            "输入字节不是可识别图片",
            "ENGINE_INFERENCE_FAILED: 推理失败（seq=3，注入）",
        ];
        for t in not_oom {
            assert!(!is_oom_error(&err("E", t)), "误判成 OOM：{t}");
        }
    }

    #[test]
    fn d4_oom_signature_penetrates_detail_and_flatten_keeps_json() {
        // 引擎常把真正的原因放在 detail，message 只剩一句"推理失败" ⇒ 必须能穿透。
        assert!(is_oom_error(&EngineError::with_detail("E", "引擎报告：推理失败", json!({ "cause": "CUDA out of memory" }))));
        assert!(is_oom_error(&EngineError::with_detail("E", "EngineError", json!("failed to allocate 4096 MB"))));
        assert!(flatten_error(&EngineError::with_detail("E", "a", json!({ "b": 1 }))).contains("\"b\":1"));
    }

    #[test]
    fn d7_apply_runs_once_history_has_one_entry_and_log_names_both() {
        // 留痕文案：排障的人按这句 grep，于是它必须是**可断言**的（抽成纯函数）。
        let line = downgrade_log_line("small", "tiny");
        assert!(line.contains("引擎已从 small 降至 tiny"), "文案：{line}");
        assert!(line.contains("sakura-1.5b-qwen2.5-v1.0-fp16.gguf"), "留痕必须带真实权重名：{line}");

        let d = TierDowngrade::new("medium", false);
        let mut applied: Vec<String> = Vec::new();
        let r = d.try_downgrade(|t| {
            applied.push(t.to_string());
            Ok(())
        });
        assert!(r.downgraded);
        assert_eq!(applied, vec!["small".to_string()], "apply 只调一次");
        assert_eq!(d.history().len(), 1);
        assert_eq!(d.current_tier(), "small");
    }

    #[test]
    fn d8_apply_failure_does_not_roll_back_the_latch() {
        // 否则每次 OOM 都再重启一次 ③，越修越忙。
        let d = TierDowngrade::new("small", false);
        let r = d.try_downgrade(|_| Err("拉起失败".into()));
        assert!(!r.downgraded);
        assert_eq!(r.reason.as_deref(), Some("apply-failed"));
        assert_eq!(d.plan().reason, "already-downgraded");
        // §8.2：档位已记为 tiny，不退还
        assert_eq!(d.current_tier(), "tiny");
    }
}
