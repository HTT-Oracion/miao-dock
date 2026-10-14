// =============================================================================
//  零配置装配编排（裁定④：装配由产品代做，用户只点一下）
// =============================================================================
//  把「仓库侧四步手工装配」串成一次会话里的阶段机：
//    python 解包 → 本地建 venv → pip 装依赖 → 源码解包 → 重放补丁
//    → 模型下载 + 解包 llama.cpp + 建链 → 写 .runtime.ready.json
//
//  设计要点（与计划 §关键决策 同）：
//  · 下载 / 校验 / 续传 / 原子解包 / 链接 **全部复用 model_store**（不写第二套下载器）。
//  · 补丁**亲自重放**（patches::apply_engine_patches）—— 产品无 node，补丁变换不能依赖仓库脚本。
//  · venv **本地重建**（python -m venv）：runtimes 整目录含绝对路径、不能分发（install-guide §6）。
//  · 依赖走 pip `--index-url` 公网镜像（A 方案，零自建）：目标机无 MSVC / Xcode ⇒ 必须预编译。
//  · 阶段进度由调用方通过 `on_phase` / `on_progress` 回传（state.rs 聚合后给前端）。
//  · 失败**不回滚**已就绪部分：ensure_models 的 `.ready` 幂等 + extract 先解临时目录，重跑续做。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::json;

use super::model_store::{
    self, Manifest, ModelStoreError, ProgressEvent, ensure_models, link_models,
};

/// 装配的结局。
pub type BootstrapResult = Result<(), BootstrapError>;

/// 装配错误：带阶段名，前端可读「卡在哪一阶段、为什么」。
#[derive(Debug)]
pub struct BootstrapError {
    pub stage: String,
    pub message: String,
}

impl BootstrapError {
    fn new(stage: &str, message: String) -> Self {
        BootstrapError { stage: stage.to_string(), message }
    }
}

impl std::fmt::Display for BootstrapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.stage, self.message)
    }
}

/// 解释器相对路径（python-build-standalone 的 install_only 归档内）。
fn py_exe_rel() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from("python.exe")
    } else {
        PathBuf::from("bin").join("python3")
    }
}

/// venv 内的解释器。
fn venv_py(rt_dir: &Path) -> PathBuf {
    let venv = rt_dir.join("venv");
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// url 的最后一段（归档文件名）。
fn url_name(url: &str) -> &str {
    url.rsplit('/').next().unwrap_or(url)
}

/// 把带 `extractTo` 且匹配当前平台的条目解包到目标目录（复用 fetch_models 的 tar 调用口径）。
fn extract_entries(manifest: &Manifest, root: &Path) -> Result<(), BootstrapError> {
    let key = model_store::platform_key();
    for e in &manifest.files {
        let Some(dest) = &e.extract_to else { continue };
        if !model_store::matches_platform(e, &key) {
            continue;
        }
        let arc = root.join(".download-cache").join(url_name(&e.url));
        if !arc.exists() {
            return Err(BootstrapError::new(
                "extract",
                format!("待解包归档不存在：{}（请先完成下载阶段）", arc.display()),
            ));
        }
        let out = root.join(dest);
        fs::create_dir_all(&out).map_err(|e| BootstrapError::new("extract", format!("建目录失败：{e}")))?;
        // 归档一般带一个顶层目录 ⇒ 默认 strip 第 1 层，让内容直接落在 out。
        let strip = e.extract_strip.unwrap_or(1);
        let mut cmd = Command::new("tar");
        cmd.arg("-xf").arg(&arc).arg("-C").arg(&out);
        if strip > 0 {
            cmd.arg(format!("--strip-components={strip}"));
        }
        match cmd.status() {
            Ok(st) if st.success() => {}
            Ok(st) => {
                return Err(BootstrapError::new(
                    "extract",
                    format!("解包失败（{st}）：{}", arc.display()),
                ))
            }
            Err(e) => {
                return Err(BootstrapError::new("extract", format!("起 tar 失败：{e}（需系统 tar/bsdtar）")))
            }
        }
    }
    Ok(())
}

/// 主装配：把 runtime 清单 + 模型清单都装到位。
///
/// `runtime_root` = 运行时根（python / 源码归档下载与解包都落这里 = `runtimes_dir`）；
/// `model_root`  = 模型根（权重下载与解包落这里 = `MIAO_MODEL_ROOT`）；两者**不是同一个目录**。
/// `rt_dir`      = `<runtime_root>` 的别名，venv / src / 就绪标记都相对它。
///
/// `max_stage`：`None` = 全量；`Some(1)` = 只装「先可跑」那部分（python + 源码 + 视觉模型）。
pub fn run_bootstrap(
    runtime_manifest: &Manifest,
    model_manifest: &Manifest,
    runtime_root: &Path,
    model_root: &Path,
    rt_dir: &Path,
    max_stage: Option<u8>,
    pip_index: &str,
    on_phase: &mut dyn FnMut(&str, &str),
    on_progress: &mut dyn FnMut(ProgressEvent),
) -> BootstrapResult {
    let log = |m: &str| println!("{m}");

    // ---- 阶段 1：Python 运行时（解包） ----
    on_phase("runtime", "下载并解包 Python 运行时");
    ensure_models(
        runtime_manifest,
        runtime_root,
        None,
        Some("python"),
        "cached",
        Some(&log),
        Some(on_progress),
    )
    .map_err(|e| BootstrapError::new("python", e.message))?;
    extract_entries(runtime_manifest, runtime_root)?;

    let py = rt_dir.join("python-3.11").join(py_exe_rel());
    if !py.exists() {
        return Err(BootstrapError::new(
            "python",
            format!("解包后未找到解释器：{}", py.display()),
        ));
    }

    // ---- 阶段 2：本地建 venv（绝不分发 venv 目录） ----
    let venv_py = venv_py(rt_dir);
    if !venv_py.exists() {
        on_phase("runtime", "创建虚拟环境");
        match Command::new(&py).arg("-m").arg("venv").arg(rt_dir.join("venv")).status() {
            Ok(st) if st.success() => {}
            Ok(st) => {
                return Err(BootstrapError::new("venv", format!("venv 创建失败（{st}）")))
            }
            Err(e) => return Err(BootstrapError::new("venv", format!("起 python -m venv 失败：{e}"))),
        }
    } else {
        on_phase("runtime", "虚拟环境已存在，跳过创建");
    }

    // ---- 阶段 3：pip 装依赖（A 方案：公网镜像） ----
    on_phase("runtime", "安装引擎依赖");
    let req = requirements_path().ok_or_else(|| {
        BootstrapError::new("deps", "找不到 engine/requirements.txt（依赖清单）".to_string())
    })?;
    if !req.exists() {
        return Err(BootstrapError::new("deps", format!("依赖清单不存在：{}", req.display())));
    }
    // 🔴 事务性：pip 默认「先收齐再统一装」，任一处失败整批回滚（VERSIONS.lock §6.3）。
    //     这里一次性装；将来要拆批 A/B 时，把 requirements 拆成两个文件、分两次调用即可。
    match Command::new(&venv_py)
        .arg("-m")
        .arg("pip")
        .arg("install")
        .arg("-r")
        .arg(&req)
        .arg("--index-url")
        .arg(pip_index)
        .arg("--no-input")
        .status()
    {
        Ok(st) if st.success() => {}
        Ok(st) => {
            return Err(BootstrapError::new(
                "deps",
                format!("依赖安装失败（{st}）—— 检查 PyPI 镜像是否可达，或改用 MIAO_PY_INDEX 指向可用源"),
            ))
        }
        Err(e) => return Err(BootstrapError::new("deps", format!("起 pip 失败：{e}"))),
    }

    // ---- 阶段 4：引擎源码（解包） ----
    on_phase("runtime", "下载并解包引擎源码");
    ensure_models(
        runtime_manifest,
        runtime_root,
        None,
        Some("source"),
        "cached",
        Some(&log),
        Some(on_progress),
    )
    .map_err(|e| BootstrapError::new("source", e.message))?;
    extract_entries(runtime_manifest, runtime_root)?;

    // ---- 阶段 5：重放源码补丁（零配置下由 Rust 亲自打） ----
    on_phase("runtime", "应用引擎源码补丁");
    let src_dir = rt_dir.join("src");
    super::patches::apply_engine_patches(&src_dir)
        .map_err(|e| BootstrapError::new("patches", e))?;

    // ---- 阶段 6：模型权重（下载 + 解包 + 建链） ----
    on_phase("models", "下载模型权重");
    let model_ids: Option<Vec<String>> = max_stage.map(|s| {
        model_store::select_files_staged(model_manifest, None, None, Some(s))
            .map(|v| v.into_iter().map(|f| f.id).collect())
            .unwrap_or_else(|_| Vec::new())
    });
    ensure_models(
        model_manifest,
        model_root,
        model_ids.as_deref(),
        None,
        "cached",
        Some(&log),
        Some(on_progress),
    )
    .map_err(|e| BootstrapError::new("models", e.message))?;
    extract_entries(model_manifest, model_root)?;
    link_models(model_manifest, model_root, None, model_ids.as_deref(), None, Some(&log))
        .map_err(|e| BootstrapError::new("link", e.message))?;

    // ---- 阶段 7：写运行时就绪标记 ----
    on_phase("runtime", "写运行时就绪标记");
    write_runtime_ready(rt_dir, runtime_manifest, model_manifest)?;

    Ok(())
}

/// 依赖清单路径：环境变量 > 随包资源 > 仓库内。
fn requirements_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("MIAO_REQUIREMENTS") {
        if !p.trim().is_empty() {
            return Some(PathBuf::from(p.trim()));
        }
    }
    crate::paths::asset("engine/requirements.txt")
        .or_else(|| Some(crate::paths::repo_root().join("engine").join("requirements.txt")))
}

/// `.runtime.ready.json`：runtime_probe 的「运行时是否齐备」判据之一。
fn write_runtime_ready(rt_dir: &Path, rt: &Manifest, _model: &Manifest) -> Result<(), BootstrapError> {
    let engine_commit = rt.engine_commit.clone();
    let payload = json!({
        "engineCommit": engine_commit,
        "assembledAt": chrono::Utc::now().to_rfc3339(),
        "tool": "boxsvc --engine-bootstrap",
        "note": "零配置装配产物；删掉本文件不会损坏已装内容，仅会让 runtime_probe 重新走一遍判定。",
    });
    let p = rt_dir.join(".runtime.ready.json");
    fs::write(&p, serde_json::to_string_pretty(&payload).unwrap())
        .map_err(|e| BootstrapError::new("ready", format!("写就绪标记失败：{e}")))
}

/// 把 BootstrapError 转成既有的 ModelStoreError（让 fetch_models 的 fail() 能统一处理）。
pub fn to_store_error(e: BootstrapError) -> ModelStoreError {
    ModelStoreError::with_detail("ENGINE_BOOTSTRAP_FAILED", e.to_string(), json!({ "stage": e.stage }))
}
