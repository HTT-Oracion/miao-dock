// mangasvc/engine/wheels.rs —— `pydensecrf` 预编译 wheel 的**产品侧选路**（B4 / G3）
// =============================================================================
// 回答一个问题：**目标机上这一颗依赖，走预编译 wheel 还是源码编译**。
//
// ## 为什么产品侧必须自己回答
// `pydensecrf` 在 PyPI **没有任何 Windows wheel**，上游 `requirements.txt` 里那行是
// GitHub `master.zip` 直链（移动靶）⇒ 只能现场用 MSVC 编译。而它是**硬依赖**
// （`mask_refinement/text_mask_utils.py:68`），不装则引擎一启动就 ModuleNotFoundError。
// 随包分发那颗 213 KB 的 wheel（G3）就是为「目标机零编译器」准备的 ——
// 但**随包不等于会被用上**：选路逻辑原先只存在于仓库侧
// `engine/scripts/install-engine-deps.mjs::planCrf()`，而打包用户机上没有 node、没有仓库。
// ⇒ Rust 侧必须有一份等价实现，否则随包的 wheel 一次都用不上，装配会去编译然后失败
// （台账风险 G-A2）。
//
// ## 与 Node 侧的关系
// 判定语义与 `planCrf()` 逐条等价（平台匹配 → 文件在位 → sha256 对得上 → 才走 wheel；
// 文件来源「包内 > 本机通道目录」）。Node 那份**保留**（`check:pydensecrf-wheel`
// 的四态判定与 `--print-plan` 仍在用它），与本模块构成双靶，由该门钉住一致。
//
// ## 回退是前提，不是降级
// 清单读不到 / 没有本平台条目 / 文件不在盘上 / 哈希不符 —— 一律回退源码编译。
// 「清单为空必须仍能装」是这套设计的前提：wheel 只是便利，不能让它变成新硬依赖。
// 反过来，**命中 wheel 却装不上时也回退源码编译**（不让便利件把整体装配拖死）。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;

use crate::child_watch::hide_console;
use crate::paths;

use super::model_store::{platform_key, sha256_file};
use super::runtime_probe::site_packages;

// ------------------------------------------------------------------ 清单结构

/// wheel 清单的一条（`engine/wheels.manifest.json` 的 `wheels[]` 项）。
///
/// 字段与 Node 侧同名同义；`bundled` / `local` / `url` 的**三态恰取其一**由
/// `check:pydensecrf-wheel` 的 WB.W1b 钉住，本模块只消费，不再判一次。
#[derive(Debug, Clone, Deserialize)]
pub struct WheelEntry {
    pub id: String,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default, rename = "pythonTag")]
    pub python_tag: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub bundled: Option<bool>,
    #[serde(default)]
    pub path: Option<String>,
}

/// 选路结果。
#[derive(Debug, Clone, PartialEq)]
pub enum CrfRoute {
    /// 走预编译 wheel（`abs` = 命中的那份，`from` = 来源）
    Wheel,
    /// 走源码编译（`reason` 说明为什么没走 wheel）
    Source,
}

#[derive(Debug, Clone)]
pub struct CrfPlan {
    pub route: CrfRoute,
    /// 人可读原因。**回退时必须说清缺什么**，尤其是「需要编译器」这件事。
    pub reason: String,
    pub abs: Option<PathBuf>,
    /// `"包内"` | `"本机目录"`（仅 `Wheel` 有值）
    pub from: Option<String>,
    /// 本条目的 id / 平台 / ABI tag —— 给取证出口与反证用。
    pub key: String,
    pub tag: String,
}

impl CrfPlan {
    fn source(reason: String, key: String, tag: String) -> Self {
        CrfPlan { route: CrfRoute::Source, reason, abs: None, from: None, key, tag }
    }
}

/// 当前 venv 的 ABI tag（`cp311`）—— 与 Node 侧 `pythonTag()` 同口径：
/// 读 `MIAO_PY_VERSION`（缺省 `3.11`）的前两段数字。
///
/// 🔴 写死 `cp311` 会让「换 Python 版本后清单没跟上」表现为**静默回退源码编译**
///    （症状是在没有编译器的机器上装到一半失败），所以它必须从版本号推出来。
pub fn python_tag() -> String {
    let raw = std::env::var("MIAO_PY_VERSION").unwrap_or_else(|_| "3.11".to_string());
    let mut it = raw.trim().split('.');
    let major = it.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(3);
    let minor = it.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(11);
    format!("cp{major}{minor}")
}

/// 定位 wheel 清单：环境变量 > 随包资源 > 仓库内（与 `patches_json_path` 同套推导）。
///
/// 🔴 **包内落点是 `engine/wheel-manifest.json`，不是 `engine/wheels.manifest.json`**：
///    Tauri 的 NSIS 打包会把**文件** `engine/wheels.manifest.json` 与**目录** `engine/wheels/`
///    当成同名项 —— 真机复现过：release 产物里两份都在，静默安装后**只有 wheel、
///    清单不见了**。而清单不见了的表现是 `plan_crf()` 恒回退源码编译
///    （在没装 MSVC 的机器上装到一半失败），离根因极远。
///    仓库内路径仍是 `engine/wheels.manifest.json`（Node 侧脚本与 e2e 都读它），
///    只有**包内**落点避开 `wheels` 这个名字。
pub fn wheels_manifest_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("MIAO_WHEELS_MANIFEST") {
        if !p.trim().is_empty() {
            return Some(PathBuf::from(p.trim()));
        }
    }
    paths::asset("engine/wheel-manifest.json")
        .or_else(|| Some(paths::repo_root().join("engine").join("wheels.manifest.json")))
}

/// 本机通道目录（`--build-wheel` / 镜像下载的落点）—— 与 Node 侧 `wheelDir()` 同源。
pub fn wheel_dir(cache_root: &Path) -> PathBuf {
    if let Ok(d) = std::env::var("MIAO_WHEEL_DIR") {
        if !d.trim().is_empty() {
            return PathBuf::from(d);
        }
    }
    cache_root.join(".download-cache").join("wheels")
}

/// **随包**那一份 wheel 的绝对路径（G3）。
///
/// 🔴 为什么随包优先：打包后的用户机上既没有 `.download-cache`、也没有编译器，
///    包内那一份是**唯一**能命中的来源。顺序反了会表现为「装得上但走的是源码编译」——
///    症状是安装耗时几分钟且在没有 MSVC 的机器上直接失败，离"清单里明明有 wheel"极远。
/// 🔴 资源目录优先于仓库：打包态 `repo_root()` 推不出真仓库根（`e2e/`/`engine/` 不在包里）。
fn bundled_wheel_path(w: &WheelEntry) -> Option<PathBuf> {
    if w.bundled != Some(true) {
        return None;
    }
    let rel = w.path.as_deref().filter(|s| !s.is_empty())?;
    paths::asset(&format!("engine/{rel}")).or_else(|| Some(paths::repo_root().join("engine").join(rel)))
}

/// 判定 pydensecrf 走哪条路（读**生效的**清单路径）。
///
/// `cache_root` = `.download-cache` 的宿主目录（`MIAO_MODEL_ROOT` / 运行时根）。
pub fn plan_crf(cache_root: &Path) -> CrfPlan {
    let Some(p) = wheels_manifest_path() else {
        return CrfPlan::source(
            "定位不到 wheel 清单 ⇒ 走源码编译".to_string(),
            platform_key(),
            python_tag(),
        );
    };
    plan_crf_with_manifest(cache_root, &p)
}

/// 判定 pydensecrf 走哪条路。**与 Node 侧 `planCrf()` 逐条等价。**
///
/// `manifest_path` 由调用方给（而不是在这里读 env）—— 这样四态判定是个**纯函数**，
/// 能被单测直接喂夹具清单。原先写成读 `MIAO_WHEELS_MANIFEST`，而 cargo test 默认多线程
/// 跑用例，两个用例一个设一个删会把彼此的结果冲掉 ⇒ 时绿时红，比没有更坏。
///
/// `cache_root` = `.download-cache` 的宿主目录（`MIAO_MODEL_ROOT` / 运行时根）。
pub fn plan_crf_with_manifest(cache_root: &Path, manifest_path: &Path) -> CrfPlan {
    let key = platform_key();
    let tag = python_tag();
    let wheels = match fs::read_to_string(manifest_path)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| {
            v.get("wheels").and_then(|w| serde_json::from_value::<Vec<WheelEntry>>(w.clone()).ok())
        }) {
        Some(w) => w,
        // 清单读不到 ⇒ 空表（回退源码编译）：wheel 是便利件，清单坏了不该让整体装配失败。
        None => {
            return CrfPlan::source(
                format!("wheel 清单读不到或格式不对（{}）⇒ 走源码编译", manifest_path.display()),
                key,
                tag,
            )
        }
    };
    if wheels.is_empty() {
        return CrfPlan::source("wheel 清单里没有任何条目 ⇒ 走源码编译".to_string(), key, tag);
    }
    let mine: Vec<&WheelEntry> =
        wheels.iter().filter(|w| w.platform.as_deref() == Some(key.as_str()) && w.python_tag.as_deref() == Some(tag.as_str())).collect();
    if mine.is_empty() {
        return CrfPlan::source(
            format!("清单里没有本平台（{key} / {tag}）的条目 ⇒ 走源码编译"),
            key,
            tag,
        );
    }
    let w = mine[0];
    let bundled = bundled_wheel_path(w);
    let abs = match &bundled {
        Some(b) if b.exists() => b.clone(),
        _ => wheel_dir(cache_root).join(w.file.clone().unwrap_or_default()),
    };
    let Some(file) = w.file.as_deref().filter(|s| !s.is_empty()) else {
        return CrfPlan::source(
            format!("清单条目 {} 没有 file 字段 ⇒ 走源码编译", w.id),
            key,
            tag,
        );
    };
    if !abs.exists() {
        return CrfPlan::source(
            format!("清单有本平台条目但 wheel 不在盘上（{}）⇒ 走源码编译", abs.display()),
            key,
            tag,
        );
    }
    let want = w.sha256.as_deref().unwrap_or("");
    let hex_only = want.len() == 64 && want.bytes().all(|b| b.is_ascii_hexdigit());
    if !hex_only {
        return CrfPlan::source(
            format!("条目 {} 的 sha256 形态不对（不是 64 位十六进制）⇒ 拒绝使用，走源码编译", w.id),
            key,
            tag,
        );
    }
    let got = match sha256_file(&abs) {
        Ok(g) => g,
        Err(e) => {
            return CrfPlan::source(
                format!("读 wheel 算哈希失败（{}）：{e} ⇒ 走源码编译", abs.display()),
                key,
                tag,
            )
        }
    };
    if got != want {
        return CrfPlan::source(
            format!(
                "wheel 的 sha256 与清单不符（清单 {}… / 实际 {}…）⇒ 拒绝使用，走源码编译",
                &want[..12.min(want.len())],
                &got[..12.min(got.len())]
            ),
            key,
            tag,
        );
    }
    let from = match &bundled {
        Some(b) if *b == abs => "包内",
        _ => "本机目录",
    };
    let _ = file;
    CrfPlan {
        route: CrfRoute::Wheel,
        reason: format!("命中清单条目 {}（平台 {key} / {tag}，来源 {from}，sha256 已核对）", w.id),
        abs: Some(abs),
        from: Some(from.to_string()),
        key,
        tag,
    }
}

// ------------------------------------------------------------------ requirements 里的 pydensecrf 行

/// 取一行里的 pydensecrf 直链 URL（`pydensecrf@https://…`）。
///
/// 与 Node 侧 `CRF_RE = /^pydensecrf\s*@\s*(\S+)/im` 等价：行首（可含后续空白）字面
/// `pydensecrf`、可选空白、`@`、可选空白、然后一段非空白字符。**不用正则 crate**
/// （本仓库不引入未经确认的新依赖），手写这个极窄的匹配即可。
fn crf_url_of_line(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("pydensecrf").or_else(|| {
        // Node 的 `i` 标志 ⇒ 大小写不敏感。
        let l = line.to_ascii_lowercase();
        l.strip_prefix("pydensecrf").map(|_| &line[10..])
    })?;
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('@')?;
    let url = rest.trim_start();
    let url = url.split_whitespace().next()?;
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

/// 上游 `requirements.txt` 里的 pydensecrf 直链（源码编译回退要用）。
pub fn crf_url(requirements: &str) -> Option<String> {
    requirements.lines().find_map(|l| crf_url_of_line(l.trim_end()).map(|s| s.to_string()))
}

/// 剔掉 pydensecrf 行后的 requirements 文本（批 A 用）。
///
/// 🔴 为什么必须拆批：pip 是**事务性**的（先全部收集、最后统一装），`pydensecrf`
///    编译失败会让整批 100+ 依赖**一起回滚** ⇒ 全白装（`VERSIONS.lock` §6.3）。
pub fn strip_crf_line(requirements: &str) -> String {
    let mut out: Vec<&str> = Vec::with_capacity(requirements.lines().count());
    for l in requirements.lines() {
        if crf_url_of_line(l.trim_end()).is_some() {
            continue;
        }
        out.push(l);
    }
    out.join("\n")
}

// ------------------------------------------------------------------ 兼容补丁 + 导入自检

/// `patchPydensecrfCompat()` 的等价实现（幂等）。
///
/// 上游把旧的**模块级常量**迁进了枚举，而引擎源码仍用旧写法
/// （`mask_refinement/text_mask_utils.py:84-90`）：`dcrf.DIAG_KERNEL` /
/// `dcrf.NO_NORMALIZATION`。真机症状是 `AttributeError` 出现在**掩码细化**一步 ——
/// 检测 / OCR / 翻译都已跑完才炸，极易误判成"翻译坏了"。
///
/// 处置：把枚举成员回填成模块级同名常量，写进 `pydensecrf/__init__.py`（任何
/// `import pydensecrf.densecrf` 都会先跑它）。marker 与 Node 侧**逐字节相同**
/// —— 两侧共用一个判据，任何一侧改写另一侧都能发现。
///
/// 返回 `true` = 本次真的写了补丁；`false` = 已在（幂等跳过）。
pub fn apply_crf_compat_patch(venv: &Path) -> Result<bool, String> {
    const MARK: &str = "# >>> miao-dock: pydensecrf 旧常量兼容补丁";
    let Some(sp) = site_packages(venv) else {
        // 没装成 pydensecrf 时找不到 `__init__.py` —— 与 Node 侧"跳过"同义（不静默当成已打）。
        return Ok(false);
    };
    let init_py = sp.join("pydensecrf").join("__init__.py");
    let cur = match fs::read_to_string(&init_py) {
        Ok(c) => c,
        Err(_) => return Ok(false), // 没装 pydensecrf（源码编译也没成）⇒ 无补丁可打
    };
    if cur.contains(MARK) {
        return Ok(false);
    }
    let shim = [
        "",
        MARK,
        "from . import densecrf as _dcrf",
        "for _n in (\"CONST_KERNEL\", \"DIAG_KERNEL\", \"FULL_KERNEL\"):",
        "    if not hasattr(_dcrf, _n) and hasattr(_dcrf.KernelType, _n):",
        "        setattr(_dcrf, _n, getattr(_dcrf.KernelType, _n))",
        "for _n in (\"NO_NORMALIZATION\", \"NORMALIZE_BEFORE\", \"NORMALIZE_AFTER\", \"NORMALIZE_SYMMETRIC\"):",
        "    if not hasattr(_dcrf, _n) and hasattr(_dcrf.NormalizationType, _n):",
        "        setattr(_dcrf, _n, getattr(_dcrf.NormalizationType, _n))",
        "# <<< miao-dock: pydensecrf 旧常量兼容补丁",
        "",
    ]
    .join("\n");
    fs::write(&init_py, format!("{cur}{shim}"))
        .map_err(|e| format!("写 pydensecrf 兼容补丁失败（{}）：{e}", init_py.display()))?;
    Ok(true)
}

/// 导入自检①：`pydensecrf` 本体可用、且**旧常量已回填**（不依赖 torch）。
///
/// 🔴 为什么把这一条与下面那条拆开（原来是合成一条命令的）：
///   ① **诊断**：合成一条时失败信息是"pydensecrf / 引擎依赖装得不完整"—— 既可能是 wheel 没选对，
///      也可能是 torch 没下全，用户与我们都得从头猜。拆开后每一半各自点名。
///   ② **可被夹具真跑**：这一半只依赖 `pydensecrf` + `numpy`（几十 MB），
///      于是"随包 wheel 装出来真的能 import、兼容补丁真的补上了旧常量"这条能被**真跑**验掉，
///      而不必为了它去下 6 GB 的 torch（见 `e2e/engine/engine-bootstrap-real-check.mjs`）。
pub fn crf_import_check(venv_py: &Path) -> Result<(), String> {
    let mut c = Command::new(venv_py);
    c.arg("-c").arg(
        "import pydensecrf.densecrf as d; assert hasattr(d, \"DIAG_KERNEL\") and hasattr(d, \"NO_NORMALIZATION\"); \
         import pydensecrf.utils; print(\"crf import ok\")",
    );
    super::runtime_setup::python_utf8(&mut c);
    hide_console(&mut c);
    match c.status() {
        Ok(st) if st.success() => Ok(()),
        Ok(st) => Err(format!(
            "自检①未通过（{st}）：pydensecrf 装得不完整或旧常量兼容补丁没生效\
             （对照 engine/wheels.manifest.json 确认本平台条目与包内 wheel 一致）"
        )),
        Err(e) => Err(format!("起解释器做自检①失败：{e}")),
    }
}

/// 导入自检②：**引擎级**依赖整体可加载（torch / torchvision / 掩码细化模块）。
///
/// 与 Node 侧同一条命令（`install-engine-deps.mjs` 的「导入自检」）。放在装配里而不是
/// 只放在验收里：**装完当时就发现**比让用户在第一次翻译时才发现便宜得多。
///
/// `MIAO_SKIP_ENGINE_IMPORT=1` 是**只给夹具/验收**用的旁路（`engine-bootstrap-real-check.mjs`
/// 用它跳过这一步：真 torch 要 4–6 GB，而那个脚本验的是装配链本身）。它**只**能跳过这一半
/// ——自检①（pydensecrf）不认这个开关，否则"零编译器"那条最关键的保证就能被一个环境变量关掉。
pub fn engine_import_check(venv_py: &Path, src_dir: &Path) -> Result<(), String> {
    let mut c = Command::new(venv_py);
    c.arg("-c").arg(
        "import torch, torchvision; from manga_translator.mask_refinement import dispatch; \
         print(\"torch\", torch.__version__, \"cuda\", torch.cuda.is_available()); print(\"engine import ok\")",
    );
    c.current_dir(src_dir);
    // 与装配侧同一套 UTF-8 环境：中文 Windows 的默认 GBK 会让中文路径/输出出乱码。
    super::runtime_setup::python_utf8(&mut c);
    hide_console(&mut c);
    match c.status() {
        Ok(st) if st.success() => Ok(()),
        Ok(st) => Err(format!(
            "自检②未通过（{st}）：引擎依赖装得不完整（torch / torchvision / 掩码细化模块加载失败）"
        )),
        Err(e) => Err(format!("起解释器做自检②失败：{e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ABI tag 从版本号推出来（写死 cp311 会让换版本后静默回退编译）。
    #[test]
    fn python_tag_derives_from_version() {
        // 不设 env ⇒ 缺省 3.11 ⇒ cp311（与今天一致）。
        assert_eq!(python_tag(), "cp311");
    }

    /// 直链行识别：行首字面 + 大小写不敏感 + 空白可变。
    #[test]
    fn crf_url_of_line_matches_node_regex() {
        assert_eq!(crf_url_of_line("pydensecrf@https://x/master.zip"), Some("https://x/master.zip"));
        assert_eq!(crf_url_of_line("pydensecrf @ https://x/master.zip"), Some("https://x/master.zip"));
        assert_eq!(crf_url_of_line("PYDENSECRF@https://x/master.zip"), Some("https://x/master.zip"));
        assert_eq!(crf_url_of_line("  pydensecrf@https://x"), None, "行首空白不算命中（Node 的 ^ 同义）");
        assert_eq!(crf_url_of_line("pydensecrf-utils==1.0"), None);
        assert_eq!(crf_url_of_line("torch==2.14.1"), None);
        assert_eq!(crf_url_of_line("pydensecrf@"), None, "没有 URL 不算命中");
    }

    /// 剔行只剔 pydensecrf 行，其余**逐行原样**保留（顺序与内容都不许变）。
    #[test]
    fn strip_crf_line_keeps_everything_else_verbatim() {
        let req = "torch==2.14.1\npydensecrf@https://x/master.zip\nnumpy==1.26.4\n";
        assert_eq!(strip_crf_line(req), "torch==2.14.1\nnumpy==1.26.4");
        assert_eq!(strip_crf_line("torch\n"), "torch");
    }

    /// 取 URL 时跳过无关行。
    #[test]
    fn crf_url_finds_the_direct_link_line() {
        assert_eq!(crf_url("torch\npydensecrf@https://x/master.zip\n"), Some("https://x/master.zip".to_string()));
        assert_eq!(crf_url("torch\n"), None);
    }

    /// 清单读不到 / 没有本平台条目 ⇒ 一律回退源码编译，且**原因说得出缺什么**。
    /// 判据是"回退"而不是"报错"：wheel 是便利件，清单坏了不该让整体装配失败。
    #[test]
    fn plan_crf_falls_back_when_manifest_unusable() {
        let tmp = std::env::temp_dir().join(format!("miao-crf-plan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let empty = tmp.join("empty.json");
        fs::write(&empty, "{\"wheels\": []}").unwrap();
        let p = plan_crf_with_manifest(&tmp, &empty);
        assert_eq!(p.route, CrfRoute::Source);
        assert!(p.abs.is_none(), "回退时不得给出 wheel 路径");
        assert!(p.reason.contains("源码编译"), "原因必须说清走的是编译：{}", p.reason);

        // 只有别的平台条目 ⇒ 同样回退（本平台无条目）。
        let other = tmp.join("other.json");
        fs::write(
            &other,
            serde_json::json!({ "wheels": [ {
                "id": "x", "platform": "darwin-arm64", "pythonTag": "cp311",
                "file": "x.whl", "sha256": "a".repeat(64), "bundled": false, "path": "" } ] })
            .to_string(),
        )
        .unwrap();
        let p2 = plan_crf_with_manifest(&tmp, &other);
        assert_eq!(p2.route, CrfRoute::Source);
        assert!(p2.reason.contains("没有本平台"), "原因必须点名平台不匹配：{}", p2.reason);

        // 文件不在盘上 ⇒ 回退（不是报错）。
        let ghost = tmp.join("ghost.json");
        fs::write(
            &ghost,
            serde_json::json!({ "wheels": [ {
                "id": "x", "platform": platform_key(), "pythonTag": python_tag(),
                "file": "not-on-disk.whl", "sha256": "a".repeat(64), "bundled": false, "path": "" } ] })
            .to_string(),
        )
        .unwrap();
        let p3 = plan_crf_with_manifest(&tmp, &ghost);
        assert_eq!(p3.route, CrfRoute::Source);
        assert!(p3.reason.contains("不在盘上"), "原因必须点名文件缺失：{}", p3.reason);

        // 清单根本读不到（路径不存在）⇒ 同样回退。
        let p4 = plan_crf_with_manifest(&tmp, &tmp.join("nope.json"));
        assert_eq!(p4.route, CrfRoute::Source);
        let _ = fs::remove_dir_all(&tmp);
    }

    /// 命中 wheel 的两道闸门（哈希真的对得上 / 形态不对即拒）。
    /// 哈希不符必须拒绝 —— 宁可慢，也不要装一个不是我们验过的东西。
    #[test]
    fn plan_crf_rejects_wheel_when_hash_mismatch_or_malformed() {
        let tmp = std::env::temp_dir().join(format!("miao-crf-hit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        // 本机通道目录里的那份（`bundled: false` ⇒ 不走随包，直接看 wheelDir）。
        let chan = tmp.join(".download-cache").join("wheels");
        fs::create_dir_all(&chan).unwrap();
        let whl = chan.join("pydensecrf-1.0-cp311-cp311-win_amd64.whl");
        fs::write(&whl, b"fake-wheel-bytes").unwrap();
        let real = sha256_file(&whl).unwrap();

        let mk = |sha: &str| {
            serde_json::json!({ "wheels": [ {
                "id": "pydensecrf-win32-x64", "platform": platform_key(), "pythonTag": python_tag(),
                "file": "pydensecrf-1.0-cp311-cp311-win_amd64.whl", "sha256": sha,
                "bundled": false, "path": "" } ] })
            .to_string()
        };
        let ok = tmp.join("ok.json");
        fs::write(&ok, mk(&real)).unwrap();
        let bad = tmp.join("bad.json");
        fs::write(&bad, mk(&"0".repeat(64))).unwrap();
        let short = tmp.join("short.json");
        fs::write(&short, mk("abc")).unwrap();

        // 哈希对得上 ⇒ 走 wheel，且来源标注为「本机目录」。
        let p = plan_crf_with_manifest(&tmp, &ok);
        assert_eq!(p.route, CrfRoute::Wheel, "哈希相符必须走 wheel：{}", p.reason);
        assert_eq!(p.abs.as_deref(), Some(whl.as_path()));
        assert_eq!(p.from.as_deref(), Some("本机目录"));

        let p2 = plan_crf_with_manifest(&tmp, &bad);
        assert_eq!(p2.route, CrfRoute::Source);
        assert!(p2.reason.contains("sha256 与清单不符"), "哈希不符必须点名：{}", p2.reason);

        let p3 = plan_crf_with_manifest(&tmp, &short);
        assert_eq!(p3.route, CrfRoute::Source);
        assert!(p3.reason.contains("sha256 形态不对"), "形态不对必须点名：{}", p3.reason);

        let _ = fs::remove_dir_all(&tmp);
    }

    /// 兼容补丁：幂等 + 内容含 marker 与两段回填。
    #[test]
    fn apply_crf_compat_patch_is_idempotent_and_marked() {
        let tmp = std::env::temp_dir().join(format!("miao-crf-patch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let pkg = tmp.join("Lib").join("site-packages").join("pydensecrf");
        fs::create_dir_all(&pkg).unwrap();
        let init = pkg.join("__init__.py");
        fs::write(&init, "# original\n").unwrap();

        assert!(apply_crf_compat_patch(&tmp).unwrap(), "首次应写入");
        let once = fs::read_to_string(&init).unwrap();
        assert!(once.contains("# >>> miao-dock: pydensecrf 旧常量兼容补丁"));
        assert!(once.contains("DIAG_KERNEL"));
        assert!(once.contains("NO_NORMALIZATION"));
        assert!(once.starts_with("# original"), "原内容必须保留在头部");

        assert!(!apply_crf_compat_patch(&tmp).unwrap(), "第二次必须幂等跳过");
        assert_eq!(fs::read_to_string(&init).unwrap(), once, "幂等 ⇒ 一个字节都不改");

        // venv 里没有 pydensecrf（没装成）⇒ 无补丁可打，且**不报错**。
        let bare = std::env::temp_dir().join(format!("miao-crf-bare-{}", std::process::id()));
        let _ = fs::remove_dir_all(&bare);
        fs::create_dir_all(bare.join("Lib").join("site-packages")).unwrap();
        assert!(!apply_crf_compat_patch(&bare).unwrap());
        let _ = fs::remove_dir_all(&bare);
        let _ = fs::remove_dir_all(&tmp);
    }
}
