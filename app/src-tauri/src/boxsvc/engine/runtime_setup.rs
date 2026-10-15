// =============================================================================
//  零配置装配编排（裁定④：装配由产品代做，用户只点一下）
// =============================================================================
//  把「仓库侧四步手工装配」串成一次会话里的阶段机：
//    python 解包 → 本地建 venv → 源码解包 → 重放补丁
//    → 依赖两批安装 → 模型下载 + 解包 llama.cpp + 建链 → 写 .runtime.ready.json
//
//  🔴 **为什么源码/补丁在依赖之前**：依赖清单是上游源码树**自带**的 `src/requirements.txt`
//     （见 `requirements_path`）。旧顺序把 pip 放在源码解包之前，那时清单还不存在 ⇒
//     依赖阶段必然报"依赖清单不存在"。
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

use crate::child_watch::hide_console;

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

/// Windows 上给绝对路径加 `\\?\` verbatim 前缀（其他平台原样返回）。
///
/// 为什么只在**解包**这一步做：`tar`（bsdtar）是外部程序，它用 Win32 路径 API，受 260
/// 字符上限约束；而 Rust 自己的 `fs` 调用对长绝对路径本就做了 verbatim 化。能改的只有
/// "我们传给外部程序的那个字符串"。
/// 🔴 UNC 路径（`\\server\share`）**不能**直接加这个前缀（合法形态是 `\\?\UNC\…`），
///    而运行时落点在本地盘 ⇒ 只对盘符路径加，UNC 原样传。
fn verbatim(p: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        let is_drive = s.len() >= 2
            && s.as_bytes()[0].is_ascii_alphabetic()
            && s.as_bytes()[1] == b':'
            && !s.starts_with(r"\\?\");
        if is_drive {
            return PathBuf::from(format!(r"\\?\{s}"));
        }
    }
    p.to_path_buf()
}

/// 遍历 `root`，返回**最长路径的字符数**与那条路径（长路径体检用）。
///
/// 🔴 为什么装配期要量这个、而不是继续凭推测：`nsis/hooks.nsh` 与安装引导都写着
///    "必须开 `LongPathsEnabled`，否则装配会在中途报『文件名或扩展名太长』"，但
///    `engine/VERSIONS.lock` §6.2 记的三个 Windows 必踩坑里**没有长路径** ——
///    这条一直是**预防性推测**。推测的代价是用户为了一个可能不存在的问题去改注册表；
///    实测出的余量才能让"要不要改"变成有依据的事。
/// 只在装配收尾跑一次（一次目录扫描，代价可忽略）。
fn longest_path(root: &Path) -> Option<(usize, PathBuf)> {
    fn walk(dir: &Path, best: &mut Option<(usize, PathBuf)>) {
        let rd = match fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(_) => return,
        };
        for ent in rd.flatten() {
            let p = ent.path();
            let len = p.to_string_lossy().chars().count();
            if best.as_ref().map(|(n, _)| len > *n).unwrap_or(true) {
                *best = Some((len, p.clone()));
            }
            if p.is_dir() {
                walk(&p, best);
            }
        }
    }
    let mut best = None;
    walk(root, &mut best);
    best
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
        // 🔴 长路径：tar 是外部程序，不吃 Rust 的 verbatim 化 ⇒ 这里显式加前缀。
        cmd.arg("-xf").arg(verbatim(&arc)).arg("-C").arg(verbatim(&out));
        if strip > 0 {
            cmd.arg(format!("--strip-components={strip}"));
        }
        hide_console(&mut cmd);
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
        let mut c = Command::new(&py);
        c.arg("-m").arg("venv").arg(rt_dir.join("venv"));
        // `python` 是控制台程序，boxsvc 无控制台 ⇒ 建 venv 期间会闪黑框。
        hide_console(&mut c);
        match c.status() {
            Ok(st) if st.success() => {}
            Ok(st) => {
                return Err(BootstrapError::new("venv", format!("venv 创建失败（{st}）")))
            }
            Err(e) => return Err(BootstrapError::new("venv", format!("起 python -m venv 失败：{e}"))),
        }
    } else {
        on_phase("runtime", "虚拟环境已存在，跳过创建");
    }

    // ---- 阶段 3：引擎源码（解包）—— 必须在依赖之前（依赖清单就是它自带的那个） ----
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

    // ---- 阶段 4：重放源码补丁（零配置下由 Rust 亲自打） ----
    on_phase("runtime", "应用引擎源码补丁");
    let src_dir = rt_dir.join("src");
    super::patches::apply_engine_patches(&src_dir)
        .map_err(|e| BootstrapError::new("patches", e))?;

    // ---- 阶段 5：依赖安装（**拆两批**）----
    install_deps(
        rt_dir,
        &venv_py,
        &src_dir,
        model_root,
        pip_index,
        &|m| println!("{m}"),
    )?;

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

    // ---- 阶段 7：长路径体检（把"会不会撞 260"从推测变成事实） ----
    let longpath = measure_long_path(rt_dir, &log);

    // ---- 阶段 8：写运行时就绪标记 ----
    on_phase("runtime", "写运行时就绪标记");
    write_runtime_ready(rt_dir, runtime_manifest, model_manifest, longpath.as_ref())?;

    Ok(())
}

/// Windows `MAX_PATH` 的传统上限（未开 `LongPathsEnabled` 时的实际约束）。
const MAX_PATH_LIMIT: usize = 260;

/// 量一遍落点下最长路径，把结论写进日志（并返回给就绪标记）。
///
/// 🔴 这一步**不改变任何行为**：不写注册表、不挪目录、不因为余量不足就失败。
///    它只回答"这个落点离 260 还有多远"，让"要不要开长路径"从猜测变成可复算的事实 ——
///    而安装器那段提示（`nsis/hooks.nsh`）继续作为兜底保留不动（D-189：只提示不代改）。
fn measure_long_path(rt_dir: &Path, log: &dyn Fn(&str)) -> Option<(usize, PathBuf)> {
    let (len, path) = longest_path(rt_dir)?;
    let shown = path.display();
    let margin = MAX_PATH_LIMIT as i64 - len as i64;
    if margin < 0 {
        log(&format!(
            "⚠ 长路径体检：落点下最长路径 {len} 字符（{shown}），已超过 Windows 的 {MAX_PATH_LIMIT} 上限 {margin} 字符。\
             若后续安装/解包报『文件名或扩展名太长』，请开启 LongPathsEnabled（安装完成后应该已经提示过）。"
        ));
    } else if margin < 40 {
        log(&format!(
            "⚠ 长路径体检：落点下最长路径 {len} 字符（{shown}），距 {MAX_PATH_LIMIT} 上限仅剩 {margin} 字符 —— \
             再装更大的依赖包可能会撞上。"
        ));
    } else {
        log(&format!(
            "长路径体检：落点下最长路径 {len} 字符（{shown}），距 {MAX_PATH_LIMIT} 上限还有 {margin} 字符（余量充足）。"
        ));
    }
    Some((len, path))
}

/// 依赖安装：**拆两批**（pip 事务性）+ `pydensecrf` 走预编译 wheel + 兼容补丁 + 导入自检。
///
/// ## 为什么必须拆两批
/// pip 是「先全部收集、最后统一装」的**事务**：`pydensecrf` 在 PyPI 没有任何 Windows
/// wheel，只能现场编译；混在一批里，它一失败会让整批 100+ 依赖**一起回滚** ⇒ 全白装
/// （`engine/VERSIONS.lock` §6.3 真机实测）。
///
/// ## 为什么批 B 先问 `plan_crf()`
/// 随包那颗 213 KB 的 wheel（G3）只有在**产品自己会选它**时才兑现"目标机零编译器"。
/// 选不到（哈希不符 / 文件不在盘 / 没有本平台条目）就退回源码编译，并在失败消息里
/// **如实点名需要 MSVC / Xcode CLT** —— 不静默、不假装成功。
///
/// `cache_root` = `.download-cache` 的宿主目录（`model_root`），与 Node 侧 `RT` 同源。
fn install_deps(
    rt_dir: &Path,
    venv_py: &Path,
    src_dir: &Path,
    cache_root: &Path,
    pip_index: &str,
    log: &dyn Fn(&str),
) -> BootstrapResult {
    let req = requirements_path(rt_dir, std::env::var("MIAO_REQUIREMENTS").ok().as_deref()).ok_or_else(|| {
        BootstrapError::new(
            "deps",
            format!(
                "找不到依赖清单 {}（引擎源码解包后它应自带 requirements.txt）",
                rt_dir.join("src").join("requirements.txt").display()
            ),
        )
    })?;
    let req_text = fs::read_to_string(&req)
        .map_err(|e| BootstrapError::new("deps", format!("读依赖清单失败（{}）：{e}", req.display())))?;

    // ---------- 批 A：除 pydensecrf 外的全部依赖（纯 wheel，一把装完） ----------
    let filtered = super::wheels::strip_crf_line(&req_text);
    let batch_a = rt_dir.join(".download-cache").join("miao-engine-req-nocrf.txt");
    if let Some(dir) = batch_a.parent() {
        fs::create_dir_all(dir)
            .map_err(|e| BootstrapError::new("deps", format!("建 .download-cache 失败：{e}")))?;
    }
    // 🔴 落在运行时根而不是系统临时目录：固定文件名的临时文件在多用户机器上会互相踩
    //    （Node 侧用 `os.tmpdir()` 的固定名，这是本模块与它唯一的有意差异）。
    fs::write(&batch_a, filtered)
        .map_err(|e| BootstrapError::new("deps", format!("写批 A 清单失败（{}）：{e}", batch_a.display())))?;
    log("▶ 批 A：安装主依赖（不含 pydensecrf）");
    let mut a = Command::new(venv_py);
    a.arg("-m")
        .arg("pip")
        .arg("install")
        .arg("-r")
        .arg(&batch_a)
        .arg("--index-url")
        .arg(pip_index)
        .arg("--no-input");
    hide_console(&mut a);
    match a.status() {
        Ok(st) if st.success() => {}
        Ok(st) => {
            return Err(BootstrapError::new(
                "deps",
                format!("批 A 安装失败（{st}）—— 检查 PyPI 镜像是否可达，或改用 MIAO_PY_INDEX 指向可用源"),
            ))
        }
        Err(e) => return Err(BootstrapError::new("deps", format!("起 pip 失败：{e}"))),
    }
    log("✓ 批 A 完成");

    // ---------- 批 B：pydensecrf —— 预编译 wheel 优先，否则源码编译 ----------
    let plan = super::wheels::plan_crf(cache_root);
    log(&format!("pydensecrf 路线：{} —— {}", route_zh(&plan.route), plan.reason));
    match plan.route {
        super::wheels::CrfRoute::Wheel => {
            let abs = plan.abs.clone().ok_or_else(|| {
                BootstrapError::new("deps", "选路说走 wheel 却没给出路径（内部不一致）".to_string())
            })?;
            // `--no-index`：wheel 是自足的（依赖已由批 A 装齐），不联网才是真"零配置"。
            // `--no-deps`：它的 numpy/cython 已就位，不让 pip 再解析一遍。
            let mut b = Command::new(venv_py);
            b.arg("-m").arg("pip").arg("install").arg("--no-index").arg("--no-deps").arg(&abs);
            hide_console(&mut b);
            match b.status() {
                Ok(st) if st.success() => log("✓ 批 B 完成（预编译 wheel，未编译）"),
                // 便利件装不上 ⇒ 回退源码编译，不让它把整体装配拖死（与 Node 侧同口径）。
                Ok(st) => {
                    log(&format!("⚠ 预编译 wheel 安装失败（{st}）—— 回退源码编译"));
                    build_crf_from_source(venv_py, &req_text, pip_index, log)?;
                }
                Err(e) => {
                    log(&format!("⚠ 起 pip 装 wheel 失败：{e} —— 回退源码编译"));
                    build_crf_from_source(venv_py, &req_text, pip_index, log)?;
                }
            }
        }
        super::wheels::CrfRoute::Source => build_crf_from_source(venv_py, &req_text, pip_index, log)?,
    }

    // ---------- 装完：pydensecrf 旧常量兼容补丁（幂等） ----------
    match super::wheels::apply_crf_compat_patch(rt_dir.join("venv").as_path()) {
        Ok(true) => log("已写入 pydensecrf 旧常量兼容补丁"),
        Ok(false) => log("pydensecrf 兼容补丁已在（或未装 pydensecrf）"),
        Err(e) => return Err(BootstrapError::new("deps", e)),
    }

    // ---------- 导入自检：装完当时就发现，比第一次翻译时才发现便宜得多 ----------
    super::wheels::crf_import_check(venv_py, src_dir)
        .map_err(|e| BootstrapError::new("deps", e))?;
    log("✓ 依赖安装完成（含导入自检）");
    Ok(())
}

/// 路线名（人读）。
fn route_zh(r: &super::wheels::CrfRoute) -> &'static str {
    match r {
        super::wheels::CrfRoute::Wheel => "预编译 wheel",
        super::wheels::CrfRoute::Source => "源码编译",
    }
}

/// 批 B 的源码编译回退。
///
/// 🔴 失败消息必须**点名需要编译器**：目标机没有 MSVC（Windows）/ Xcode CLT（macOS）时
///    这是预期失败，而"pip 退出 1"这句话离根因极远 —— 用户会去查网络。
/// ⚠️ 与 Node 侧的有意差异：不移植它的 MSVC 环境探测（手工拼 INCLUDE/LIB）与
///    `ghfast.top` 镜像回退 —— 那是仓库侧装机脚本的职责，本路径只是**回退**。
fn build_crf_from_source(
    venv_py: &Path,
    req_text: &str,
    _pip_index: &str,
    log: &dyn Fn(&str),
) -> BootstrapResult {
    let Some(url) = super::wheels::crf_url(req_text) else {
        return Err(BootstrapError::new(
            "deps",
            "requirements.txt 里没有 pydensecrf 直链行，无法源码编译（也无法命中 wheel）".to_string(),
        ));
    };
    log(&format!("▶ 批 B：从源码编译 pydensecrf（{url}）"));
    let mut b = Command::new(venv_py);
    b.arg("-m").arg("pip").arg("install").arg("--no-build-isolation").arg(&url);
    hide_console(&mut b);
    match b.status() {
        Ok(st) if st.success() => {
            log("✓ 批 B 完成（源码编译）");
            Ok(())
        }
        Ok(st) => Err(BootstrapError::new(
            "deps",
            format!(
                "pydensecrf 源码编译失败（{st}）。这一项**需要编译器**：Windows 装「Visual Studio 2022 生成工具」\
                 （MSVC v143 + Windows SDK）、macOS 装 Xcode 命令行工具（xcode-select --install）。\n\
                 正常情况下应命中随包的预编译 wheel（engine/wheels.manifest.json）而走不到这一步 —— \
                 若反复落在这里，请检查该清单是否有本平台（{} / {}）条目且包内 wheel 未被改动。",
                super::model_store::platform_key(),
                super::wheels::python_tag()
            ),
        )),
        Err(e) => Err(BootstrapError::new("deps", format!("起 pip 编译 pydensecrf 失败：{e}"))),
    }
}

/// 依赖清单路径：`MIAO_REQUIREMENTS` 覆盖 > **上游源码树自带**的 `<rt>/src/requirements.txt`。
///
/// 🔴 为什么读上游那一份、而不是在仓库里放一份 `engine/requirements.txt`：
///    依赖清单的权威就是上游的 `requirements.txt`。仓库里再放一份等于引入**第二事实源**，
///    上游一改就会漂移，而漂移的表现是"装出来的依赖与引擎要求不一致、且两边都不报错"。
///    （旧实现假定存在 `engine/requirements.txt`，而它**全仓不存在** ⇒ 依赖阶段必失败。）
fn requirements_path(rt_dir: &Path, override_env: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = override_env.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let p = rt_dir.join("src").join("requirements.txt");
    p.exists().then_some(p)
}

/// `.runtime.ready.json`：runtime_probe 的「运行时是否齐备」判据之一。
///
/// `longpath` = 装配时量到的 `(最长路径字符数, 那条路径)`。写进标记是为了让"要不要开
/// `LongPathsEnabled`这件事在机器上**可复算** —— 否则它永远只是安装引导里的一句提示。
fn write_runtime_ready(
    rt_dir: &Path,
    rt: &Manifest,
    _model: &Manifest,
    longpath: Option<&(usize, PathBuf)>,
) -> Result<(), BootstrapError> {
    let engine_commit = rt.engine_commit.clone();
    let payload = json!({
        "engineCommit": engine_commit,
        "assembledAt": chrono::Utc::now().to_rfc3339(),
        "tool": "boxsvc --engine-bootstrap",
        "longPath": longpath.map(|(len, p)| json!({
            "maxChars": len,
            "path": p.to_string_lossy(),
            "limit": MAX_PATH_LIMIT,
            "margin": MAX_PATH_LIMIT as i64 - *len as i64,
        })),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 覆盖优先，且**空串不算覆盖**（与其余 `MIAO_*` 同口径）。
    #[test]
    fn requirements_path_prefers_env_override() {
        let tmp = std::env::temp_dir().join(format!("miao-req-env-{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);
        let got = requirements_path(&tmp, Some("/tmp/whatever.txt"));
        assert_eq!(got, Some(PathBuf::from("/tmp/whatever.txt")));
        // 空串 / 纯空白不得当成覆盖 —— 否则"设了但值为空"会静默退化成上游那份。
        assert_eq!(requirements_path(&tmp, Some("  ")), None);
        let _ = fs::remove_dir_all(&tmp);
    }

    /// 默认读上游源码树自带那份；**文件不在盘上 ⇒ None**（而不是编一个路径出来）。
    /// 判据是"在盘上"而不是"路径拼得出来"：拼得出来但不存在 = 依赖阶段必失败，
    /// 而那种失败在跑起来之前看不出来。
    #[test]
    fn requirements_path_defaults_to_upstream_and_requires_existence() {
        let tmp = std::env::temp_dir().join(format!("miao-req-src-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let src = tmp.join("src");
        fs::create_dir_all(&src).unwrap();
        assert_eq!(requirements_path(&tmp, None), None, "清单不在盘上必须判 None");
        let req = src.join("requirements.txt");
        fs::write(&req, "torch\n").unwrap();
        assert_eq!(requirements_path(&tmp, None), Some(req));
        let _ = fs::remove_dir_all(&tmp);
    }

    /// 长路径体检：取的是**最长**那条，且字符数按 Unicode 字符算（不是字节）。
    /// 判据是"最长"而不是"第一个"：按第一个算会在深目录晚出现时给出偏小的余量。
    #[test]
    fn longest_path_reports_the_deepest_entry() {
        let tmp = std::env::temp_dir().join(format!("miao-longest-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let shallow = tmp.join("a.txt");
        fs::write(&shallow, "x").unwrap();
        let deep = tmp.join("venv").join("Lib").join("site-packages").join("torch").join("include").join("deep.h");
        fs::create_dir_all(deep.parent().unwrap()).unwrap();
        fs::write(&deep, "x").unwrap();
        let (len, path) = longest_path(&tmp).expect("有文件就必须量到");
        assert_eq!(path, deep, "必须取最长那条，而不是第一个");
        assert_eq!(len, deep.to_string_lossy().chars().count(), "字符数要与路径一致");
        // 目录本身也参与比较（`venv` 这条比 `a.txt` 长）。
        assert!(len > tmp.join("a.txt").to_string_lossy().chars().count());
        let _ = fs::remove_dir_all(&tmp);
    }

    /// 空目录 ⇒ `None`（不是 0）。没有可量的东西却报"最长 0 字符"会让体检显得通过。
    #[test]
    fn longest_path_on_empty_dir_is_none() {
        let tmp = std::env::temp_dir().join(format!("miao-longest-empty-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        assert_eq!(longest_path(&tmp), None);
        let _ = fs::remove_dir_all(&tmp);
    }

    /// verbatim 前缀：盘符路径加 `\\?\`，**已带前缀的不重复加**，UNC 不加。
    /// （重复加会得到 `\\?\\?\C:\…`，UNC 直接加会得到非法路径 —— 两者都让 tar 失败。）
    #[test]
    fn verbatim_prefixes_only_plain_drive_paths() {
        #[cfg(windows)]
        {
            assert_eq!(verbatim(Path::new(r"C:\a\b")), PathBuf::from(r"\\?\C:\a\b"));
            assert_eq!(verbatim(Path::new(r"\\?\C:\a\b")), PathBuf::from(r"\\?\C:\a\b"), "已带前缀不得重复加");
            assert_eq!(verbatim(Path::new(r"\\server\share\x")), PathBuf::from(r"\\server\share\x"), "UNC 原样传");
        }
    }
}
