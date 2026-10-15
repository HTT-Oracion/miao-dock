// 路径解析 —— 服务端「路径」这一类事实的**唯一来源**（F2）
//
// 搬自 `service/src/config.mjs` 的目录小节。为什么要搬进 Rust：F 组的目标是服务运行时
// 由 Rust 接管，而「检测到的解释器路径」与「启动时用的解释器路径」必须**同出一源**
// ——两份推导的失效形态是「检测说没装、启动却起了」（R1），且两边**都看起来在工作**。
//
// 🔴 本模块**只**做路径推导，不 import 任何业务概念；默认值与环境变量覆盖的语义与
//    Node 版逐字对齐（`MIAO_*` 覆盖优先，其次平台默认），迁移期靠 e2e 双靶比对。
use std::path::{Path, PathBuf};

/// 仓库根：`engine/` `e2e/` `app/` 都在它下面。
///
/// 🔴 原本的**唯一事实源**是服务侧 `config.mjs` 的 `REPO_ROOT`（锚在永不需要搬动的
/// `config.mjs` 上）；D-209 把那份 Node 实现整目录删除后，锚点改成**两个只在仓库里才存在**
/// 的目录：以「本可执行文件向上找仓库根」的方式推导 —— 找同时含 `e2e/` 与 `engine/` 的目录。
/// 找不到则退回 `MIAO_REPO_ROOT` 或当前工作目录，绝不手写 dots 数（搬文件即静默算错根）。
///
/// ⚠️ 为什么不锚 `service/`（旧判据）：它已被删除（D-209）—— 锚点指向一个不存在的目录时，
/// 推导会**静默回落**成「cwd = 找不到」，于是 dev 态的资源回退路径全部失效，
/// 而失效形态是"包看起来正常、点下载才报清单读不到"（假红把真缺失淹没掉）。
/// ⚠️ 为什么不锚 `app/`：安装后的产品目录里也有 `app` 侧痕迹，锚在它上面会在打包态误命中。
pub fn repo_root() -> PathBuf {
    if let Ok(p) = std::env::var("MIAO_REPO_ROOT") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(found) = walk_up_for_root(exe.parent()) {
            return found;
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(found) = walk_up_for_root(Some(cwd.as_path())) {
            return found;
        }
        return cwd;
    }
    PathBuf::from(".")
}

/// 从 `start` 起向上找**同时含 `e2e/` 与 `engine/`** 的目录（仓库根的判据）。
///
/// 🔴 两个标记目录都必须**只在仓库里存在**：`e2e/` 是验收层（不随包），`engine/` 是接缝层。
/// 少一个都可能让打包态的安装目录被误判成仓库根。
fn walk_up_for_root(start: Option<&Path>) -> Option<PathBuf> {
    let mut cur = start?;
    loop {
        if cur.join("e2e").is_dir() && cur.join("engine").is_dir() {
            return Some(cur.to_path_buf());
        }
        cur = cur.parent()?;
    }
}

// ------------------------------------------------------------------ 资源目录（A1）

/// 产品运行期**必需**的随包资产：相对资源目录的路径（同时也是相对仓库根的路径）。
///
/// 🔴 这是 A2 的**另一半事实**：`tauri.conf.json` 的 `bundle.resources` 必须把这里的每一项
/// 都打进包（`check:bundle` 的 W6 钉住），否则 A1 找到资源目录也是空的 —— 两边分开维护的
/// 失效形态就是「配置看着有、运行时拿不到」，而它在 dev 态**永远测不出来**。
pub const REQUIRED_ASSETS: &[&str] = &[
    "engine/models.manifest.json",
    // G2：运行时清单（Python 运行时 + 引擎源码）。🔴 它与模型清单是**同等必需**的 ——
    // 「零配置」的全部依据就是它；漏配的形态是"包看起来正常、点开始下载才报清单读不到"。
    "engine/runtime.manifest.json",
    // G4：源码补丁应用事实源（零配置下 Rust 亲自重放，产品无 node）。漏配 ⇒ 装出的引擎未打补丁。
    "engine/patches.json",
];

/// 资源目录（`$RESOURCE`）：`MIAO_RESOURCE_DIR` 覆盖，否则从**本可执行文件**推导。
///
/// ## 为什么不用 Tauri 的 `AppHandle::path().resource_dir()`
/// `boxsvc` 是**独立可执行**（F0 起的第二个 `[[bin]]`），它拿不到 `AppHandle`；而产品默认档
/// 跑的正是 boxsvc。好在 `resolve_boxsvc()` 保证它与 `miao-dock` **同目录**，故从 exe 推导
/// 在两端得到同一个值 —— 这条也是 A1 唯一可行的实现路线。
///
/// 推导规则与 Tauri 的 `$RESOURCE` 一致：
///   · macOS：`…/Box.app/Contents/MacOS/<exe>` ⇒ `…/Box.app/Contents/Resources`
///   · 其他平台：exe 所在目录
///
/// ⚠️ 本函数只负责**找出目录在哪**，不判断里面有什么（判断在 [`asset`] / [`missing_assets`]）。
pub fn resource_dir() -> Option<PathBuf> {
    if let Some(p) = env_path("MIAO_RESOURCE_DIR") {
        return Some(p);
    }
    // 🔴 **只有 release 构建**才从 exe 推导（e2e 例外：上面的 env 覆盖）。
    //    本机实测：`target/debug/engine/models.manifest.json` 曾长期躺着一份**上一版**的资产副本
    //    （Tauri 把 `bundle.resources` 复制到 debug 产物目录里，删了配置副本却留了下来）。
    //    debug 构建若也走这条路 ⇒ 开发态会优先读到**过期清单**，而"清单过期"的表现是
    //    模型校验莫名其妙地不符，离根因极远 —— 比"找不到"更难查。
    //    ⇒ 开发态一律走仓库（`repo_root()`），打包（恒为 release）才走资源目录。
    if cfg!(debug_assertions) {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let res = if dir.file_name().and_then(|n| n.to_str()) == Some("MacOS") {
        dir.parent()?.join("Resources")
    } else {
        dir.to_path_buf()
    };
    if res.is_dir() {
        Some(res)
    } else {
        None
    }
}

/// 资源目录下的资产；资源目录不存在、或这份资产不在里面 ⇒ `None`（调用方回退到仓库路径）。
pub fn asset(rel: &str) -> Option<PathBuf> {
    let p = resource_dir()?.join(rel);
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

/// **缺失**的必需资产（空 = 齐备）。
///
/// 🔴 判据是「**最终拿不拿得到**」而不是「资源目录里有没有」：
/// 开发态资源目录里没有这些资产，但它们就在仓库里（`repo_root()/<rel>`）—— 若只查资源目录，
/// dev 态会**永远报缺失**，而这个报错是假的，会把真缺失淹没掉。
/// ⇒ 只有当「资源目录里没有 **且** 仓库里也没有」时才算缺失，这正是打包后漏配 A2 的形态。
pub fn missing_assets() -> Vec<String> {
    let root = repo_root();
    REQUIRED_ASSETS
        .iter()
        .filter(|rel| asset(rel).is_none() && !root.join(rel).exists())
        .map(|rel| rel.to_string())
        .collect()
}

/// 资产自检报告（给 `boxsvc --check-assets` 与启动前置门用）。
pub fn assets_report() -> serde_json::Value {
    let dir = resource_dir();
    let items: Vec<serde_json::Value> = REQUIRED_ASSETS
        .iter()
        .map(|rel| {
            let from_resource = asset(rel).is_some();
            let from_repo = repo_root().join(rel).exists();
            serde_json::json!({
                "name": rel,
                "ok": from_resource || from_repo,
                "source": if from_resource { "resource" } else if from_repo { "repo" } else { "none" },
            })
        })
        .collect();
    let missing = missing_assets();
    serde_json::json!({
        "resourceDir": dir.as_ref().map(|p| p.to_string_lossy().into_owned()),
        "assets": items,
        "missing": missing,
        "ok": missing.is_empty(),
    })
}

// ------------------------------------------------------------------ 目录（契约 §2.1 / §7.1 / §7.5）

/// 平台的**应用数据目录**（`~/Library/Application Support` / `%LOCALAPPDATA%` / `~/.local/share`）。
///
/// 🔴 B1 起这是「状态目录」与「运行时目录」**共用的平台分叉事实源**：两者都挂在它下面
///    （`<appData>/Box/state`、`<appData>/runtimes/manga-translator`）。写成两份分叉 ⇒
///    将来只改一处 ⇒ 状态在 A 盘、运行时在 B 盘，而两处**都不报错**。
fn app_data_dir() -> PathBuf {
    let home = home_dir();
    if cfg!(target_os = "macos") {
        return home.join("Library").join("Application Support");
    }
    if cfg!(target_os = "windows") {
        let base = std::env::var("LOCALAPPDATA")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        return base;
    }
    home.join(".local").join("share")
}

/// 任务清单等运行期状态的位置：平台应用数据目录下的 `Box/state`。
/// 契约 §7.5：**不放漫画目录内**（否则会被库扫描误读为用户内容）。
pub fn default_state_dir() -> PathBuf {
    app_data_dir().join("Box").join("state")
}

/// 🔴 B1：引擎运行时的**落点**（`<appData>/runtimes`）。
///
/// 为什么从仓库根搬到 appData：打包后 `repo_root()` 向上找不到同时含 `e2e/` 与 `engine/`
/// 的目录（两者都不进包，见 A1/A2）⇒ 退回 cwd ⇒ 引擎路径算错。而 appData **始终可写**
/// 且与安装位置无关 —— 这正是「引擎由用户自装」唯一稳定的锚点。
pub fn default_runtime_root() -> PathBuf {
    app_data_dir().join("runtimes")
}

/// 生效的**运行时根**（`MIAO_RUNTIME_ROOT` 覆盖）。
///
/// 🔴 为什么必须可覆盖：`runtime_probe`（B2）要把 venvRoot / site-packages 判到临时目录上，
///    否则验收会去 `stat` 用户真实 appData —— 而"读用户目录"的验收夹具本身就是缺陷
///    （同 `MIAO_ROOT` / `MIAO_STATE_DIR` 一律指 TMP）。默认值与 `config.mjs` 逐字节对齐。
pub fn runtime_root() -> PathBuf {
    resolve(env_path("MIAO_RUNTIME_ROOT").unwrap_or_else(default_runtime_root))
}

/// 引擎运行时根（`<runtimeRoot>/manga-translator`）。
pub fn runtimes_dir() -> PathBuf {
    runtime_root().join("manga-translator")
}

/// 落盘根目录默认值：契约 §7.1 —— `~/Pictures/Box 漫画`。
pub fn default_root_dir() -> PathBuf {
    home_dir().join("Pictures").join("Box 漫画")
}

fn home_dir() -> PathBuf {
    // 复用 `dirs`（已在 Cargo.toml）：跨平台，含中文 Windows 的 USERPROFILE 处理。
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// 平台的 venv 解释器相对路径：POSIX `bin/python`、Windows `Scripts/python.exe`。
/// 🔴 写死其中一个会让另一平台的引擎起不来，且症状是「python 找不到」这种离根因极远的报错。
///
/// 🔴 返回 `PathBuf` 而非 `&str`：用字面量 `"Scripts/python.exe"` 去 `join` 会在 Windows 上
///    留下**正斜杠**（`...\venv\Scripts/python.exe`），与 Node `path.join`（全反斜杠）**逐字节不同**
///    —— 而 F2 的验收正是「路径逐字节相同」，一个分隔符就够判红。
pub fn venv_python_rel() -> PathBuf {
    if cfg!(target_os = "windows") {
        PathBuf::from("Scripts").join("python.exe")
    } else {
        PathBuf::from("bin").join("python")
    }
}

// ------------------------------------------------------------------ 生效路径（env 覆盖 ⊕ 平台默认）

/// 生效的**状态目录**（`MIAO_STATE_DIR` 覆盖）。
///
/// 🔴 复刻 Node `path.resolve(env || default)`：**总是绝对化**。env 给相对路径时，Node 会相对
///    cwd 展开、Rust 不会 —— 不补这一步，用户设一个相对 `MIAO_STATE_DIR` 就会让两边指向不同目录。
pub fn state_dir() -> PathBuf {
    resolve(env_path("MIAO_STATE_DIR").unwrap_or_else(default_state_dir))
}

/// 生效的**落盘根目录**（`MIAO_ROOT` 覆盖）。契约 §7.1。同 `state_dir`，总是绝对化。
pub fn root_dir() -> PathBuf {
    resolve(env_path("MIAO_ROOT").unwrap_or_else(default_root_dir))
}

/// 近似 `path.resolve`：相对路径按 cwd 展开，再做**词法归一**（统一分隔符、去 `.`、消 `..`）。
///
/// 🔴 为什么必须归一：Node 的 `path.resolve` 会**统一分隔符**（`C:/a/b` ⇒ `C:\a\b`）并消解 `..`，
///    而「原样返回绝对路径」会让 `MIAO_ROOT=C:/x/y` 这类写法在两边指向**不同的字符串**
///    —— 症状是「检测说 A、启动用 B」这类离根因极远的故障（R1）。这一格曾真实漏过：
///    `--print-paths` 传出 `C:/Users/.../root` 而 Node 给 `C:\\Users\\...\\root`。
pub fn resolve(p: PathBuf) -> PathBuf {
    let joined = if p.is_absolute() {
        p
    } else {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(&p),
            Err(_) => p,
        }
    };
    normalize_lexical(&joined)
}

/// 生效的**引擎源码目录**（`MIAO_ENGINE_DIR` 覆盖，默认 `<appData>/runtimes/manga-translator/src`）。
///
/// 🔴 B1 起默认值锚在 **appData 运行时根**（不再锚仓库根）：F5 后 `repo_root()` 在打包态
///    必然算错（A1 已论证），而引擎是用户自装的，落点必须与安装位置无关。
///
/// 🔴 迁移期**逐字节复刻** `config.mjs` 的语义：`MIAO_ENGINE_DIR || <runtimesDir>/src`
///    —— **不做存在性判断**。任何"顺手加个 if is_dir() 回退"都是行为分叉：Node 不判断、
///    Rust 判断，遇到目录缺失时两边给出不同路径，而两边**都看起来在工作**（R1 的典型）。
///    默认值要改（如改回仓库布局）必须**两边同一次改**，不能只改一边。
pub fn engine_dir() -> PathBuf {
    env_path("MIAO_ENGINE_DIR").unwrap_or_else(|| runtimes_dir().join("src"))
}

/// 生效的**引擎解释器**（`MIAO_ENGINE_PYTHON` 覆盖，默认 `<appData>/runtimes/manga-translator/venv/{bin/python|Scripts/python.exe}`）。
///
/// 🔴 默认值锚在**运行时根**而不是 `engine_dir()` —— 复刻 `config.mjs` 的事实：
///    它的 `defaultEnginePython()` 用的是 `runtimesDir/venv`，**不随 `MIAO_ENGINE_DIR` 变**。
///    若这里跟着 `engine_dir()` 走，设了 `MIAO_ENGINE_DIR` 时两边就会给出不同的解释器路径
///    （检测说 A、启动用 B），而这正是 R1 要消灭的那类分叉。
pub fn engine_python() -> PathBuf {
    if let Some(p) = env_path("MIAO_ENGINE_PYTHON") {
        return p;
    }
    runtimes_dir().join("venv").join(venv_python_rel())
}

/// 生效的**模型根目录**（`MIAO_MODEL_ROOT` 覆盖，默认引擎目录上一级）。
///
/// 🔴 Node 的 `engineModelDir` 是 `path.resolve(engineSettings.modelDir || resolve(ENGINE_DIR, '..'))`
///    —— **总是绝对化**，故这里也走 `resolve`。
///
/// 🔴 F5.6 起**三级回退**（与 `config.mjs:480` 逐字对齐）：`MIAO_MODEL_ROOT` → 设置文件 `modelDir`
///    → `resolve(ENGINE_DIR, '..')`。少了中间那一级，「设置页把模型目录改到 D 盘」这件事
///    在 Rust 侧**读不到**，而它在 Node 侧读得到 ⇒ `--print-paths` 与产品行为一起分叉（R1）。
/// ⚠️ 这里**只**做 `modelDir` 的裸读，不复用 `boxsvc::engine::settings`：`paths` 是底座
///    （`lib` 根），底座依赖服务域会把「域能单独理解」这个前提破掉（同 Node 的 layering 纪律）。
pub fn model_root() -> PathBuf {
    if let Some(p) = env_path("MIAO_MODEL_ROOT") {
        return resolve(p);
    }
    if let Some(dir) = settings_model_dir() {
        return resolve(PathBuf::from(dir));
    }
    let parent = engine_dir().parent().map(PathBuf::from).unwrap_or_else(|| {
        state_dir().join("runtimes").join("manga-translator")
    });
    resolve(parent)
}

/// 裸读 `state/engine-settings.json` 的 `modelDir`（字符串且非空才有值）。
///
/// 读不到 / 不是 JSON / 键缺失 一律 `None` —— 坏文件由 `boxsvc::engine::settings` 另行上报，
/// 这里**不重复喊**（同一个坏文件喊两遍只会淹没日志）。
fn settings_model_dir() -> Option<String> {
    let text = std::fs::read_to_string(state_dir().join("engine-settings.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let s = v.get("modelDir")?.as_str()?.trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// 生效的**模型清单**（`MIAO_MODEL_MANIFEST` 是验收夹具接缝；产品路径永远用入库的那一份）。
///
/// 🔴 A1 起**先查资源目录**：打包后 `repo_root()` 算不出真仓库根（`e2e/` 与 `engine/`
/// 原先一个字节都没进包 ⇒ 向上找永远找不到 ⇒ 退回 cwd），清单会静默指向一个不存在的位置。
/// 开发态资源目录里没有它 ⇒ 回退到 `repo_root()`，**行为逐字节不变**。
pub fn model_manifest() -> PathBuf {
    if let Some(p) = env_path("MIAO_MODEL_MANIFEST") {
        return p;
    }
    if let Some(p) = asset("engine/models.manifest.json") {
        return p;
    }
    repo_root().join("engine").join("models.manifest.json")
}

/// 生效的**运行时清单**（G2：`engine/runtime.manifest.json`）—— 与 [`model_manifest`] 同一套推导。
///
/// 🔴 为什么必须**两份清单**而不是把运行时条目并进 `models.manifest.json`：
/// 那份清单的每个字节都要过 C5 的「随包 0 权重」断言，而运行时清单里全是**可执行环境**，
/// 两者的审查口径不同（一份审模型许可，一份审 GPL 源码义务）。混在一起会让两个断言都变钝。
pub fn runtime_manifest() -> PathBuf {
    if let Some(p) = env_path("MIAO_RUNTIME_MANIFEST") {
        return p;
    }
    if let Some(p) = asset("engine/runtime.manifest.json") {
        return p;
    }
    repo_root().join("engine").join("runtime.manifest.json")
}

/// 某条资产的**生效 URL**：`MIAO_ASSET_BASE` 配了合法前缀就换源，否则用清单里的原值。
///
/// 🔴 为什么前缀非法时**不静默回落**：那属于配置错误，而回落的表现是"照公网原样下载" ——
/// 内网用户会以为配好了、实际流量全跑到了公网。宁可下载前就报一条清楚的错。
pub fn asset_base() -> Result<Option<String>, String> {
    let Ok(raw) = std::env::var("MIAO_ASSET_BASE") else {
        return Ok(None);
    };
    let t = raw.trim().trim_end_matches('/');
    if t.is_empty() {
        return Ok(None);
    }
    if !(t.starts_with("http://") || t.starts_with("https://")) {
        return Err(format!(
            "MIAO_ASSET_BASE 必须是 http(s) 前缀（不带 scheme 的值在不同平台上语义不同，拼出来的 URL 验不了），收到「{raw}」"
        ));
    }
    Ok(Some(t.to_string()))
}

/// 生效 URL：有合法前缀 ⇒ `<前缀>/<清单 url 的最后一段>`；否则原值。
pub fn asset_url(manifest_url: &str) -> String {
    match asset_base() {
        Ok(Some(prefix)) => {
            let name = manifest_url.rsplit('/').next().unwrap_or(manifest_url);
            format!("{prefix}/{name}")
        }
        _ => manifest_url.to_string(),
    }
}

/// 引擎启动入口脚本（`MIAO_ENGINE_ENTRY` 覆盖，默认引擎目录下的 `server/main.py`）。
pub fn engine_entry() -> PathBuf {
    if let Some(p) = env_path("MIAO_ENGINE_ENTRY") {
        return p;
    }
    engine_server_dir().join("main.py")
}

// ------------------------------------------------------------------ 派生落盘路径（与 config.mjs 逐一对齐）

/// 服务包目录 `<仓库>/service`（Node `PKG_DIR`）。
pub fn pkg_dir() -> PathBuf {
    repo_root().join("service")
}

/// 任务清单目录 `state/tasks`（Node `TASKS_STATE_DIR`）。
pub fn tasks_state_dir() -> PathBuf {
    state_dir().join("tasks")
}

/// 幂等表 `state/idempotency.json`（Node `IDEMPOTENCY_FILE`）。
pub fn idempotency_file() -> PathBuf {
    state_dir().join("idempotency.json")
}

/// 令牌文件 `state/token`（Node `TOKEN_FILE`）。
pub fn token_file() -> PathBuf {
    state_dir().join("token")
}

/// 上传字节暂存区 `state/pending`（Node `PENDING_DIR`，G-12）。
pub fn pending_dir() -> PathBuf {
    state_dir().join("pending")
}

/// 「已从漫画库隐藏」清单 `state/hidden-comics.json`（Node `HIDDEN_COMICS_FILE`）。
pub fn hidden_comics_file() -> PathBuf {
    state_dir().join("hidden-comics.json")
}

/// 引擎主进程目录（`MIAO_ENGINE_SERVER_DIR` 覆盖，默认 `engineDir/server`）。
pub fn engine_server_dir() -> PathBuf {
    env_path("MIAO_ENGINE_SERVER_DIR").unwrap_or_else(|| engine_dir().join("server"))
}

/// 全部路径的 **JSON 快照** —— 供 e2e「Rust 与 Node 同源」逐字节比对（`boxsvc --print-paths`）。
///
/// 键名与 `config.mjs` 的导出**一一对应**，比对脚本按同名键逐条比 —— 少一个键就是漏一条断言。
pub fn snapshot() -> serde_json::Value {
    let s = |p: PathBuf| p.to_string_lossy().into_owned();
    serde_json::json!({
        "repoRoot": s(repo_root()),
        "pkgDir": s(pkg_dir()),
        "stateDir": s(state_dir()),
        "tasksStateDir": s(tasks_state_dir()),
        "idempotencyFile": s(idempotency_file()),
        "tokenFile": s(token_file()),
        "rootDir": s(root_dir()),
        "runtimeRoot": s(runtime_root()),
        "engineDir": s(engine_dir()),
        "engineServerDir": s(engine_server_dir()),
        "enginePython": s(engine_python()),
        "engineModelDir": s(model_root()),
        // A1/A2 之后清单路径是「资源目录优先、仓库回退」—— 它是**打包后唯一必须进包的资产**，
        // 故必须进快照：不进的话"装完之后清单指向哪"这件事在两边的对拍里是盲区。
        "modelManifest": s(model_manifest()),
    })
}

// ------------------------------------------------------------------ 路径安全工具（契约 §8.2）

/// 近似 `path.resolve`：相对路径按 cwd 展开，再做**词法归一**（去 `.`、消 `..`、统一分隔符）。
///
/// 与 [`resolve`] 同义；保留本名是为了让「路径安全工具」小节读起来自洽（`canonicalize` 的第一步）。
pub fn resolve_abs(p: &Path) -> PathBuf {
    resolve(p.to_path_buf())
}

/// 词法归一：不触碰文件系统，只按 `components()` 消 `.` / `..`。
fn normalize_lexical(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut prefix: Option<std::ffi::OsString> = None;
    let mut is_abs = false;
    let mut parts: Vec<std::ffi::OsString> = Vec::new();
    for c in p.components() {
        match c {
            Component::Prefix(pre) => prefix = Some(pre.as_os_str().to_os_string()),
            Component::RootDir => is_abs = true,
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(s) => parts.push(s.to_os_string()),
        }
    }
    let mut out = PathBuf::new();
    if let Some(pre) = prefix {
        out.push(pre);
    }
    if is_abs {
        out.push(std::path::MAIN_SEPARATOR.to_string());
    }
    for s in parts {
        out.push(s);
    }
    out
}

/// 规范化路径：解析**已存在部分**的符号链接，未存在的部分原样拼接（逐字复刻 `config.mjs` 的 `canonicalize`）。
///
/// 🔴 Windows 上必须剥掉 `\\?\` 前缀：Rust 的 `fs::canonicalize` 会返回 verbatim 路径
///    （`\\?\C:\...`），而 Node 的 `fs.realpathSync` **不会** —— 不剥就会让「同源比对」
///    在 Windows 上恒红，且差异只在开头 4 个字符，极难据此定位。
pub fn canonicalize(p: &Path) -> PathBuf {
    let abs = resolve_abs(p);
    let mut cur = abs.clone();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match std::fs::canonicalize(&cur) {
            Ok(real) => {
                let mut out = strip_verbatim(real);
                for t in tail.iter().rev() {
                    out.push(t);
                }
                return out;
            }
            Err(_) => {
                let parent = cur.parent().map(|x| x.to_path_buf());
                match parent {
                    Some(par) if par != cur => {
                        if let Some(name) = cur.file_name() {
                            tail.push(name.to_os_string());
                        }
                        cur = par;
                    }
                    _ => return abs,
                }
            }
        }
    }
}

#[cfg(windows)]
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_string());
    }
    p
}

#[cfg(not(windows))]
fn strip_verbatim(p: PathBuf) -> PathBuf {
    p
}

/// 路径越界（契约 §8.2 校验点 3）。与 `mount`/落盘无关，只是拒绝。
#[derive(Debug)]
pub struct PathEscapeError(pub PathBuf);

impl std::fmt::Display for PathEscapeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "路径越界：{}", self.0.display())
    }
}

impl std::error::Error for PathEscapeError {}

/// 拼接后前缀校验（契约 §8.2 校验点 3）。
/// `target` 指向「文件」时，其 parent 即漫画目录，必须位于 root **之内**（且不等于 root 本身）。
///
/// 🔴 `parent == root ⇒ 拒绝`：复刻 Node 那句 `parentCanonical === rootCanonical ? false : startsWith`——
///    落盘文件必须落在 root 的**子目录**里，root 本身只放目录、不放页。
pub fn assert_inside_root(root_canonical: &Path, target: &Path) -> Result<(), PathEscapeError> {
    let parent = match target.parent() {
        Some(p) => p,
        None => return Err(PathEscapeError(target.to_path_buf())),
    };
    let parent_canonical = canonicalize(parent);
    let ok = parent_canonical != root_canonical
        && parent_canonical.starts_with(root_canonical);
    if !ok {
        return Err(PathEscapeError(target.to_path_buf()));
    }
    Ok(())
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var(key).ok().filter(|s| !s.is_empty()).map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn venv_python_rel_matches_platform() {
        let rel = venv_python_rel();
        if cfg!(target_os = "windows") {
            assert_eq!(rel, PathBuf::from("Scripts").join("python.exe"));
            // 🔴 反证：绝不能留正斜杠（否则与 Node path.join 逐字节不同）
            assert!(!rel.to_string_lossy().contains('/'), "venv_python_rel 混入正斜杠：{rel:?}");
        } else {
            assert_eq!(rel, PathBuf::from("bin").join("python"));
        }
    }

    #[test]
    fn env_override_wins() {
        std::env::set_var("MIAO_ROOT", "Z:/tmp/root-probe");
        assert_eq!(root_dir(), PathBuf::from("Z:/tmp/root-probe"));
        std::env::remove_var("MIAO_ROOT");
    }

    #[test]
    fn repo_root_has_e2e_and_engine() {
        let r = repo_root();
        assert!(r.join("e2e").is_dir(), "repo_root 未定位到仓库根：{r:?}");
        assert!(r.join("engine").is_dir(), "repo_root 未定位到仓库根：{r:?}");
    }

    #[test]
    fn normalize_lexical_resolves_dotdot() {
        assert_eq!(normalize_lexical(Path::new("/a/b/../c")), PathBuf::from("/a/c"));
        assert_eq!(normalize_lexical(Path::new("/a/./b/")), PathBuf::from("/a/b"));
    }

    #[test]
    fn resolve_is_lexical_and_native_separator() {
        let sep = std::path::MAIN_SEPARATOR;
        let r = resolve(PathBuf::from(format!("{sep}a{sep}b{sep}..{sep}c")));
        assert!(r.to_string_lossy().ends_with(&format!("a{sep}c")), "未消解 ../：{r:?}");
        // 🔴 反证点：Windows 上绝不能留正斜杠（Node path.resolve 会给反斜杠，差一个字符即判红）
        if sep == '\\' {
            assert!(!r.to_string_lossy().contains('/'), "混入正斜杠：{r:?}");
        }
    }

    #[test]
    fn canonicalize_strips_verbatim_and_keeps_tail() {
        // 一个必然不存在的深路径：canonicalize 应把「存在的父前缀」真实解析、把不存在的尾巴原样拼回
        let probe = std::env::temp_dir().join("miao-canon-probe").join("deeper").join("file.json");
        let c = canonicalize(&probe);
        assert!(c.ends_with(Path::new("deeper").join("file.json")), "尾巴被改动：{c:?}");
        // 🔴 Windows：绝不能带 `\\?\` verbatim 前缀（否则与 Node realpathSync 逐字节不同）
        assert!(!c.to_string_lossy().starts_with(r"\\?\"), "verbatim 前缀未剥离：{c:?}");
    }

    #[test]
    fn assert_inside_root_rejects_root_itself_and_outside() {
        let root = canonicalize(&std::env::temp_dir().join("miao-inside-probe-root"));
        // root 之下的一层子目录里的文件 ⇒ 放行
        assert!(assert_inside_root(&root, &root.join("漫画 A").join("001.png")).is_ok());
        // 直接躺在 root 里 ⇒ 拒绝（复刻 Node 的 parent==root ⇒ false）
        assert!(assert_inside_root(&root, &root.join("001.png")).is_err());
    }

    // ---------------------------------------------------------------- 资源目录（A1）

    #[test]
    fn required_assets_are_reachable_in_dev() {
        // 🔴 反证点：只查资源目录会让 dev 态**永远报缺失**（假红），把真缺失淹没掉。
        //    判据必须是「最终拿不拿得到」，开发态这些资产就在仓库里。
        let missing = missing_assets();
        assert!(missing.is_empty(), "开发态不应报资源缺失：{missing:?}");
    }

    #[test]
    fn assets_report_ok_matches_missing() {
        let r = assets_report();
        let missing = r.get("missing").and_then(|v| v.as_array()).expect("missing 必须是数组");
        assert_eq!(
            r.get("ok").and_then(|v| v.as_bool()),
            Some(missing.is_empty()),
            "ok 与 missing 必须一致（不一致 ⇒ 启动门与自检报告会说两套话）"
        );
        assert_eq!(
            r.get("assets").and_then(|v| v.as_array()).map(|a| a.len()),
            Some(REQUIRED_ASSETS.len()),
            "报告条目数必须等于必需资产数（漏一条 ⇒ 那一条永远不被检查）"
        );
    }

    #[test]
    fn model_manifest_ends_with_expected_name() {
        // A1 改了查找顺序（资源目录优先），但**文件名不许变** —— 变了就是另一份事实源。
        let p = model_manifest();
        assert_eq!(
            p.file_name().and_then(|n| n.to_str()),
            Some("models.manifest.json"),
            "清单文件名被改：{p:?}"
        );
    }

    #[test]
    fn required_assets_path_is_reusable_as_repo_relative() {
        // A2 的落点假设：同一串相对路径既能当「资源目录相对路径」也能当「仓库相对路径」。
        // 若哪天这两边不再同构，`missing_assets()` 的 dev 回退就会静默失效。
        for rel in REQUIRED_ASSETS {
            assert!(
                !Path::new(rel).is_absolute(),
                "必需资产必须是相对路径：{rel}"
            );
            assert!(
                !rel.starts_with(".."),
                "必需资产不得含 ..（会被 Tauri 转义成 _up_）：{rel}"
            );
        }
    }
}
