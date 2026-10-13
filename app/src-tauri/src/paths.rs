// 路径解析 —— 服务端「路径」这一类事实的**唯一来源**（F2）
//
// 搬自 `service/src/config.mjs` 的目录小节。为什么要搬进 Rust：F 组的目标是服务运行时
// 由 Rust 接管，而「检测到的解释器路径」与「启动时用的解释器路径」必须**同出一源**
// ——两份推导的失效形态是「检测说没装、启动却起了」（R1），且两边**都看起来在工作**。
//
// 🔴 本模块**只**做路径推导，不 import 任何业务概念；默认值与环境变量覆盖的语义与
//    Node 版逐字对齐（`MIAO_*` 覆盖优先，其次平台默认），迁移期靠 e2e 双靶比对。
use std::path::{Path, PathBuf};

/// 仓库根：`engine/` `service/` `app/` 都在它下面。
///
/// 🔴 **唯一事实源**是 `service/src/config.mjs` 的 `REPO_ROOT`（锚在永不需要搬动的
/// `config.mjs` 上）。Rust 侧是**新增的第二个消费者**，因此这里必须与它算出同一个值：
/// 以「本可执行文件向上找仓库根」的方式推导 —— 找同时含 `service/` 与 `engine/` 的目录。
/// 找不到则退回 `MIAO_REPO_ROOT` 或当前工作目录，绝不手写 dots 数（搬文件即静默算错根）。
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

/// 从 `start` 起向上找**同时含 `service/` 与 `engine/`** 的目录（仓库根的判据）。
fn walk_up_for_root(start: Option<&Path>) -> Option<PathBuf> {
    let mut cur = start?;
    loop {
        if cur.join("service").is_dir() && cur.join("engine").is_dir() {
            return Some(cur.to_path_buf());
        }
        cur = cur.parent()?;
    }
}

// ------------------------------------------------------------------ 目录（契约 §2.1 / §7.1 / §7.5）

/// 任务清单等运行期状态的位置：平台应用数据目录下的 `Box/state`。
/// 契约 §7.5：**不放漫画目录内**（否则会被库扫描误读为用户内容）。
pub fn default_state_dir() -> PathBuf {
    let home = home_dir();
    if cfg!(target_os = "macos") {
        return home.join("Library").join("Application Support").join("Box").join("state");
    }
    if cfg!(target_os = "windows") {
        let base = std::env::var("LOCALAPPDATA")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        return base.join("Box").join("state");
    }
    home.join(".local").join("share").join("Box").join("state")
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

/// 生效的**引擎源码目录**（`MIAO_ENGINE_DIR` 覆盖，默认 `<仓库>/runtimes/manga-translator/src`）。
///
/// 🔴 迁移期**逐字节复刻** `config.mjs` 的语义：`MIAO_ENGINE_DIR || resolve(PKG_DIR, '..', 'runtimes', …, 'src')`
///    —— **不做存在性判断**。任何"顺手加个 if is_dir() 回退"都是行为分叉：Node 不判断、
///    Rust 判断，遇到目录缺失时两边给出不同路径，而两边**都看起来在工作**（R1 的典型）。
///    默认值要改（如改到 appData 用户自装目录）必须**两边同一次改**，不能只改一边。
pub fn engine_dir() -> PathBuf {
    env_path("MIAO_ENGINE_DIR")
        .unwrap_or_else(|| repo_root().join("runtimes").join("manga-translator").join("src"))
}

/// 生效的**引擎解释器**（`MIAO_ENGINE_PYTHON` 覆盖，默认 `<仓库>/runtimes/manga-translator/venv/{bin/python|Scripts/python.exe}`）。
///
/// 🔴 默认值锚在**仓库根**而不是 `engine_dir()` —— 复刻 `config.mjs` 的事实：
///    它的 `defaultEnginePython()` 用的是 `PKG_DIR/..`，**不随 `MIAO_ENGINE_DIR` 变**。
///    若这里跟着 `engine_dir()` 走，设了 `MIAO_ENGINE_DIR` 时两边就会给出不同的解释器路径
///    （检测说 A、启动用 B），而这正是 R1 要消灭的那类分叉。
pub fn engine_python() -> PathBuf {
    if let Some(p) = env_path("MIAO_ENGINE_PYTHON") {
        return p;
    }
    repo_root()
        .join("runtimes")
        .join("manga-translator")
        .join("venv")
        .join(venv_python_rel())
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
pub fn model_manifest() -> PathBuf {
    if let Some(p) = env_path("MIAO_MODEL_MANIFEST") {
        return p;
    }
    repo_root().join("engine").join("models.manifest.json")
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
        "engineDir": s(engine_dir()),
        "engineServerDir": s(engine_server_dir()),
        "enginePython": s(engine_python()),
        "engineModelDir": s(model_root()),
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
    fn repo_root_has_service_and_engine() {
        let r = repo_root();
        assert!(r.join("service").is_dir(), "repo_root 未定位到仓库根：{r:?}");
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
}
