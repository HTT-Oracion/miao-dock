// 硬件探测 / 档位映射 / 加速后端 —— 《04》§7 在服务层的落地点（Rust 侧）
// =============================================================================
// 移植自 `service/src/settings/engine-profile.mjs`。
//
// 🔴 两条纪律（本文件为断言与反证而设计）：
//   ① **全部纯函数、导入零副作用** —— 硬件事实由 [`HwFacts`] 注入。否则「16GB Mac 落 Tiny」
//      这条断言只能在那台 Mac 上跑，换台机器就变成假绿（恰好也是 Tiny）或假红。
//   ② **映射表逐行照抄《04》§7.2**，不做「顺手优化」。§7.2 的 `else` 分支本身就是
//      把「Medium 在 16GB Mac 上不可行」**升级成了映射逻辑的一部分** —— 改它 = 改契约。
use std::path::{Path, PathBuf};

/// 档位枚举（顺序 = 设置页展示顺序，由低到高）
pub const TIERS: &[&str] = &["tiny", "small", "medium"];
/// 加速后端枚举（《03》§5.1 `sidecar.accel`）
pub const ACCELS: &[&str] = &["cuda", "mps", "cpu"];
/// GPU 种类（《04》§7.1 `GpuKind`）
pub const GPU_KINDS: &[&str] = &["cuda", "metal", "cpu"];

/// 各档峰值内存**估算**（《02》§5 表：Tiny ≈ 9.4 / Small ≈ 12.8 / Medium ≈ 17.6 GB）。
/// 🔴 这三个数是**整机峰值估算**，只用于两件事：设置页展示 + 可行性判定。
pub fn tier_peak_gb(tier: &str) -> Option<f64> {
    match tier {
        "tiny" => Some(9.4),
        "small" => Some(12.8),
        "medium" => Some(17.6),
        _ => None,
    }
}

const BYTES_PER_GB: f64 = 1024.0 * 1024.0 * 1024.0;

/// 字节 → GB（保留 1 位小数；`os.totalmem()` 的尾数无工程意义）
pub fn bytes_to_gb(bytes: u64) -> f64 {
    ((bytes as f64) / BYTES_PER_GB * 10.0).round() / 10.0
}

// ------------------------------------------------------------------ 硬件事实（可注入）

/// 硬件画像的**输入事实**——全部可注入，这是「可断言」的前提。
#[derive(Debug, Clone)]
pub struct HwFacts {
    pub platform: String,
    pub arch: String,
    pub total_ram_gb: f64,
    pub gpu: Gpu,
}

#[derive(Debug, Clone)]
pub struct Gpu {
    pub kind: String,
    pub vram_gb: Option<f64>,
    pub unified_gb: Option<f64>,
    pub name: String,
}

/// 探测整机硬件（真实环境入口）。
pub fn probe_hardware() -> HwFacts {
    let platform = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let total_ram_gb = bytes_to_gb(total_ram_bytes());
    let gpu = detect_gpu(&platform, &arch, total_ram_gb, None);
    HwFacts { platform, arch, total_ram_gb, gpu }
}

/// 读整机内存字节数 —— 与 Node `os.totalmem()` 同源（各自平台的同一系统调用）。
pub fn total_ram_bytes() -> u64 {
    #[cfg(windows)]
    {
        if let Some(v) = win_total_memory() {
            return v;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(v) = mac_total_memory() {
            return v;
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(v) = linux_total_memory() {
            return v;
        }
    }
    0
}

#[cfg(windows)]
#[repr(C)]
struct MemoryStatusEx {
    dw_length: u32,
    dw_memory_load: u32,
    ull_total_phys: u64,
    ull_avail_phys: u64,
    ull_total_page_file: u64,
    ull_avail_page_file: u64,
    ull_total_virtual: u64,
    ull_avail_virtual: u64,
    ull_avail_extended_virtual: u64,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GlobalMemoryStatusEx(buf: *mut MemoryStatusEx) -> i32;
}

/// Windows：`GlobalMemoryStatusEx` —— 与 Node `os.totalmem()` 的底层调用一致。
#[cfg(windows)]
fn win_total_memory() -> Option<u64> {
    let mut st = MemoryStatusEx {
        dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
        dw_memory_load: 0,
        ull_total_phys: 0,
        ull_avail_phys: 0,
        ull_total_page_file: 0,
        ull_avail_page_file: 0,
        ull_total_virtual: 0,
        ull_avail_virtual: 0,
        ull_avail_extended_virtual: 0,
    };
    let ok = unsafe { GlobalMemoryStatusEx(&mut st) };
    if ok == 0 {
        None
    } else {
        Some(st.ull_total_phys)
    }
}

/// macOS：`sysctl -n hw.memsize`（Node `os.totalmem()` 同源）。
#[cfg(target_os = "macos")]
fn mac_total_memory() -> Option<u64> {
    let out = std::process::Command::new("sysctl").arg("-n").arg("hw.memsize").output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    s.trim().parse::<u64>().ok()
}

/// Linux：`/proc/meminfo` 的 `MemTotal`（单位 kB）。
#[cfg(target_os = "linux")]
fn linux_total_memory() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            let kb: u64 = rest.trim().trim_end_matches("kB").trim().parse().ok()?;
            return Some(kb * 1024);
        }
    }
    None
}

/// 探测 GPU 种类。
///
/// · macOS ⇒ **Metal**（Apple Silicon 统一内存 = 整机内存；`unifiedGb = totalRamGb`）。
/// · 其他平台 ⇒ 先试 NVIDIA（`nvidia-smi` 读显存），失败即 **CPU**。
pub fn detect_gpu(platform: &str, arch: &str, total_ram_gb: f64, nvidia: Option<Option<f64>>) -> Gpu {
    if platform == "macos" {
        return Gpu {
            kind: "metal".to_string(),
            vram_gb: None,
            unified_gb: Some(total_ram_gb),
            name: if arch.contains("aarch64") || arch.contains("arm") {
                "Apple Silicon（Metal 统一内存）".to_string()
            } else {
                "Apple（Metal 统一内存）".to_string()
            },
        };
    }
    let vram = match nvidia {
        Some(v) => v,
        None => default_nvidia_vram_gb(),
    };
    match vram {
        Some(v) if v.is_finite() && v > 0.0 => Gpu {
            kind: "cuda".to_string(),
            vram_gb: Some(v),
            unified_gb: None,
            name: "NVIDIA（CUDA）".to_string(),
        },
        _ => Gpu { kind: "cpu".to_string(), vram_gb: None, unified_gb: None, name: "CPU（无可用独显）".to_string() },
    }
}

/// 读 NVIDIA 显存总量（GiB）。`nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`
/// 输出单位是 **MiB**。读不到 → `None`（本机无独显；这不是错误）。
fn default_nvidia_vram_gb() -> Option<f64> {
    let out = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().map(|s| s.trim()).find(|s| !s.is_empty())?;
    let mib: f64 = first.parse().ok()?;
    if mib.is_finite() {
        Some(((mib / 1024.0) * 10.0).round() / 10.0)
    } else {
        None
    }
}

// ------------------------------------------------------------------ 档位映射（《04》§7.2 逐行）

/// 档位映射 —— 《04》§7.2 表格**逐行照抄**。
///
/// | CUDA `vram >= 16` → Medium · `>= 10` → Small · else → Tiny |
/// | Metal `unified >= 32` → Medium · `>= 24` → Small · else → Tiny |
/// | 纯 CPU → Tiny（速度受限） |
///
/// ⚠️ 原文只给出了 CUDA `>= 4` 的行，**没写 `vram < 4` 落哪** —— 这里取 `tiny`
///   （Tiny 是枚举下界，也是唯一能跑的档）。这是**对原文空白的显式裁定**，已在 Node 侧记账。
pub fn map_tier(total_ram_gb: f64, gpu: &Gpu) -> String {
    let _ = total_ram_gb;
    if gpu.kind == "cuda" {
        let Some(vram) = gpu.vram_gb else { return "tiny".to_string() };
        if !vram.is_finite() {
            return "tiny".to_string();
        }
        if vram >= 16.0 {
            return "medium".to_string();
        }
        if vram >= 10.0 {
            return "small".to_string();
        }
        return "tiny".to_string();
    }
    if gpu.kind == "metal" {
        let Some(unified) = gpu.unified_gb else { return "tiny".to_string() };
        if !unified.is_finite() {
            return "tiny".to_string();
        }
        if unified >= 32.0 {
            return "medium".to_string();
        }
        if unified >= 24.0 {
            return "small".to_string();
        }
        return "tiny".to_string(); // **16GB Mac 落此**（§7.2 修订点）
    }
    "tiny".to_string() // 纯 CPU：速度受限，仅 Tiny（§7.3）
}

/// 加速后端探测 —— 《04》§7.4 的「探测顺序 CUDA → MPS → CPU」。
/// 本函数只做「种类 → 后端名」的映射，**不再重复探测**。
pub fn detect_accel(gpu: &Gpu) -> String {
    if gpu.kind == "cuda" {
        return "cuda".to_string();
    }
    if gpu.kind == "metal" {
        return "mps".to_string();
    }
    "cpu".to_string()
}

/// 加速后端 → 启动参数（《04》§7.3）。返回 `(engine_use_gpu, llm_gpu_layers)`。
pub fn accel_launch_flags(accel: &str) -> (bool, i64) {
    let on_cpu = accel == "cpu";
    (!on_cpu, if on_cpu { 0 } else { -1 })
}

/// 加速后端的中文名（设置页与诊断视图共用一处文案）。
pub fn accel_label(accel: &str) -> &str {
    match accel {
        "auto" => "自动",
        "cuda" => "CUDA",
        "mps" => "MPS（Metal）",
        "cpu" => "CPU",
        _ => accel,
    }
}

/// 解析**实际生效**的加速后端（S6 设置页「加速后端」的落地处）。
///
/// ## 为什么不能「用户选什么就报什么」
/// `sidecar.accel` 的用途是「让界面和事实对账」。若用户在 Metal 机器上选了 `cuda` 而我们如实
/// 报 `cuda`，那就是**用一个假字段配一个假控件**。所以这里把「用户想选的」与「硬件能给的」
/// 合成一个**只能有一个答案**的结论，并且**把不一致显式报出来**（`mismatch`）。
///
/// ⚠️ 与 §7.4-3 的 `degraded` 是**两件事**：`resolveAccel` 管「后端选谁」（静态）；
///    `degraded` 管「选了 GPU 却实际回退到 CPU」（动态，要告警）。
pub fn resolve_accel(choice: &str, hardware_accel: &str, use_gpu: bool) -> AccelChoice {
    if !use_gpu {
        // 🔴 必须分清**两种** `useGpu === false` —— 它们外观相同、含义相反：
        //   · `choice === 'cpu'`：用户在设置页选了「强制 CPU」⇒ **他主动要的**，不报 degraded。
        //   · `choice` 是 auto / 某个 GPU 后端：那就是检测到 GPU 起不来而注入的强制 CPU ⇒ 真回退。
        let by_user_choice = choice == "cpu";
        return AccelChoice {
            accel: "cpu".to_string(),
            degraded: !by_user_choice && hardware_accel != "cpu",
            mismatch: None,
            reason: if by_user_choice {
                "用户指定 CPU（非回退）".to_string()
            } else if hardware_accel == "cpu" {
                "硬件本就无 GPU".to_string()
            } else {
                format!("已回退 CPU（硬件推荐 {hardware_accel}）")
            },
        };
    }
    if choice == "auto" || choice == hardware_accel {
        return AccelChoice {
            accel: hardware_accel.to_string(),
            degraded: false,
            mismatch: None,
            reason: if choice == "auto" { "按硬件探测".to_string() } else { "用户指定".to_string() },
        };
    }
    AccelChoice {
        accel: hardware_accel.to_string(),
        degraded: false,
        mismatch: Some(format!("已请求 {choice}，本机可用后端为 {hardware_accel}")),
        reason: "用户指定的后端在本机不可用，按硬件探测值执行".to_string(),
    }
}

#[derive(Debug, Clone)]
pub struct AccelChoice {
    pub accel: String,
    pub degraded: bool,
    pub mismatch: Option<String>,
    pub reason: String,
}

/// 加速后端**候选项**（《02》§5）。「物理不可行的档位不出现」同样适用于后端。
/// `all` = **反证开关**（把四个都列出来）。
pub fn accel_options(hardware_accel: &str, all: bool) -> Vec<AccelOption> {
    let order: Vec<&str> = if all {
        vec!["auto", "cuda", "mps", "cpu"]
    } else {
        let mut v = vec!["auto"];
        if hardware_accel != "cpu" {
            v.push(hardware_accel);
        }
        v.push("cpu");
        v
    };
    order
        .into_iter()
        .map(|value| AccelOption {
            value: value.to_string(),
            label: accel_label(value).to_string(),
            detail: match value {
                "auto" => format!("按硬件探测（本机 → {}）", accel_label(hardware_accel)),
                "cuda" => "NVIDIA 显卡（CUDA）".to_string(),
                "mps" => "Apple Metal（MPS）".to_string(),
                "cpu" => "强制 CPU（最慢，但兼容性最好）".to_string(),
                _ => value.to_string(),
            },
        })
        .collect()
}

#[derive(Debug, Clone)]
pub struct AccelOption {
    pub value: String,
    pub label: String,
    pub detail: String,
}

/// 物理可行的档位集合（《02》§5「物理不可行档位不出现」）。
///
/// 判定池按后端分：
///   · metal（统一内存）/ cpu —— 权重与整机内存**竞争**，按整机峰值估算判；
///   · cuda —— 权重进**显存**，按 vram 阈值判（与整机 RAM 无关）。
///   · Tiny 恒为可行档（枚举下界 / 唯一在任何硬件上都「能跑」的档）。
pub fn feasible_tiers(total_ram_gb: f64, gpu: &Gpu) -> Vec<String> {
    TIERS
        .iter()
        .filter(|tier| {
            if **tier == "tiny" {
                return true;
            }
            if gpu.kind == "cuda" {
                let Some(vram) = gpu.vram_gb else { return false };
                if !vram.is_finite() {
                    return false;
                }
                return if **tier == "small" { vram >= 10.0 } else { vram >= 16.0 };
            }
            let peak = tier_peak_gb(tier).unwrap_or(f64::INFINITY);
            peak <= total_ram_gb
        })
        .map(|t| (*t).to_string())
        .collect()
}

#[derive(Debug, Clone)]
pub struct TierOption {
    pub tier: String,
    pub peak_gb: Option<f64>,
    pub recommended: bool,
    pub warning: Option<String>,
}

/// 设置页档位选项（《02》§5）：可行档位 + 预估内存 + 「推荐」/「不推荐」标注。
/// 规则：可行但不是推荐档 ⇒ `warning` 非空（原文：「Small **保留**但标注「不推荐」」）。
pub fn tier_options(total_ram_gb: f64, gpu: &Gpu, recommended_tier: &str) -> Vec<TierOption> {
    feasible_tiers(total_ram_gb, gpu)
        .into_iter()
        .map(|tier| {
            let recommended = tier == recommended_tier;
            TierOption {
                peak_gb: tier_peak_gb(&tier),
                recommended,
                warning: if recommended { None } else { Some("内存吃紧，翻译可能明显变卡".to_string()) },
                tier,
            }
        })
        .collect()
}

/// 档位权重在不在 —— 交给 `engine::available_tiers()`（那是「手上有没有权重」，
/// 与「硬件吃不吃得住」是两回事，混为一谈会出现「界面可点、点了被静默夹回」）。
pub fn model_dir_default(engine_dir: &Path) -> PathBuf {
    engine_dir.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| engine_dir.to_path_buf())
}
