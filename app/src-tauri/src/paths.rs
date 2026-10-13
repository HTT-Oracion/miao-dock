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

/// 近似 `path.resolve`：相对路径按 cwd 展开为绝对路径（绝对路径原样返回）。
fn resolve(p: PathBuf) -> PathBuf {
    if p.is_absolute() {
        return p;
    }
    std::env::current_dir().map(|c| c.join(&p)).unwrap_or(p)
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
/// 🔴 Node 的 `engineModelDir` 是 `path.resolve(modelDir || resolve(ENGINE_DIR, '..'))` —— **总是绝对化**，
///    故这里也走 `resolve`。
pub fn model_root() -> PathBuf {
    if let Some(p) = env_path("MIAO_MODEL_ROOT") {
        return resolve(p);
    }
    let parent = engine_dir().parent().map(PathBuf::from).unwrap_or_else(|| {
        state_dir().join("runtimes").join("manga-translator")
    });
    resolve(parent)
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
}
